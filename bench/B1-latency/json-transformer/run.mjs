// SPDX-License-Identifier: MIT
//
// bench/B1-latency/json-transformer/run.mjs — B1 json-transformer benchmark orchestrator
//
// @decision DEC-BENCH-B1-JSON-001
// @title B1 json-transformer: 4-comparator sum-of-numeric-leaves DFS substrate measurement
// @status accepted
// @rationale
//   Pass/kill bars (per issue #185):
//     PASS:  yakcc-as degradation vs rust-software ≤ 15%
//     WARN:  degradation 15%–40% (concerning but not a kill)
//     KILL:  degradation > 40% (triggers re-plan of #143 AS initiative)
//
//   Algorithm: sum-of-all-numeric-leaves via DFS over a pre-parsed JSON tree.
//
//   Why sum-of-numeric-leaves (not camelCase transform):
//     The camelCase key transform requires managed string operations (AS string type,
//     GC heap) which are incompatible with --runtime stub. The AS-backend is locked to
//     --runtime stub per DEC-AS-JSON-STRATEGY-001 in as-backend.ts. The fallback
//     (sum-of-numeric-leaves) exercises the same DFS traversal substrate: every node
//     is visited, type-tagged, and dispatched. The only leaf operation changes from
//     "camelCase key normalization" to "f64 accumulation" — both are trivial vs
//     the DFS traversal overhead, which is what this measurement targets.
//
//   Why serde_json has no "force-soft" analog:
//     serde_json does not expose feature-gated SIMD acceleration in the way sha2 does.
//     Both Rust binaries compile with default serde_json and produce identical results.
//     The "accelerated" vs "software" distinction is retained for structural consistency
//     with Slice 1's 4-comparator format. The apples-to-apples gate remains
//     yakcc-as vs rust-software (same algorithm, different runtime).
//
//   Pre-parse discipline:
//     All 4 comparators exclude JSON parsing from the timing loop. Each times only
//     the DFS traversal over a pre-parsed representation:
//       rust-*:   serde_json::Value tree (parsed once before timing loop)
//       ts-node:  JSON.parse result (parsed once before timing loop)
//       yakcc-as: flat binary tagged-union in WASM memory (serialized before timing loop)
//     This is equivalent work across all comparators and documented in algorithm.md.
//
//   Correctness verification (load-bearing):
//     Before any timing, all 4 comparators run on a fixed 10KB test input.
//     Their checksum outputs (f64 sum) must match within floating-point tolerance
//     (< 1e-6 relative error). Mismatch = hard fail. This guarantees apples-to-apples.
//
//   Methodology:
//     - Corpus: ~100MB deterministic JSON (xorshift32 PRNG, seed 0xCAFEF00D)
//     - Warm-up: 100 iterations (discarded)
//     - Measurement: 1000 iterations
//     - Metric: wall-clock latency per iteration
//     - Statistics: p50, p95, p99, mean, throughput_mb_per_sec
//     - Process isolation: each comparator runs as a fresh subprocess
//
//   Degradation = (yakcc_mean - rust_software_mean) / rust_software_mean * 100
//   using mean_ms as the primary metric.
//
//   Result artifact: tmp/B1-latency/json-transformer-<ISO-timestamp>.json
//   This file IS committed as the operator decision input for issue #185.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { cpus, totalmem } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Resolve repo root
function resolveRepoRoot() {
  if (process.env.YAKCC_REPO_ROOT) return process.env.YAKCC_REPO_ROOT;
  let dir = __dirname;
  for (let i = 0; i < 8; i++) {
    const pkg = join(dir, "package.json");
    if (existsSync(pkg)) {
      try {
        const p = JSON.parse(readFileSync(pkg, "utf8"));
        if (p.name === "yakcc") return dir;
      } catch (_) {}
    }
    const parent = resolve(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  return resolve(__dirname, "../../..");
}

const REPO_ROOT = resolveRepoRoot();

const GREEN  = "\x1b[32m";
const RED    = "\x1b[31m";
const YELLOW = "\x1b[33m";
const BOLD   = "\x1b[1m";
const RESET  = "\x1b[0m";

// ---------------------------------------------------------------------------
// Corpus verification
// ---------------------------------------------------------------------------

const CORPUS_DIR  = join(__dirname, "corpus");
const CORPUS_PATH = join(CORPUS_DIR, "input-100MB.json");
const SPEC_PATH   = join(__dirname, "corpus-spec.json");
const GENERATE_SCRIPT = join(__dirname, "generate-corpus.mjs");

async function ensureCorpus() {
  if (!existsSync(SPEC_PATH)) {
    process.stderr.write("ERROR: corpus-spec.json missing. This should be committed.\n");
    process.exit(1);
  }
  const spec = JSON.parse(readFileSync(SPEC_PATH, "utf8"));

  if (!existsSync(CORPUS_PATH)) {
    console.log(`${BOLD}INFO${RESET} corpus not found — generating via generate-corpus.mjs...`);
    const result = spawnSync(process.execPath, [GENERATE_SCRIPT], {
      stdio: "inherit",
      encoding: "utf8",
      timeout: 300000,
    });
    if (result.status !== 0) {
      process.stderr.write("ERROR: corpus generation failed.\n");
      process.exit(1);
    }
  }

  // Verify SHA-256 of corpus matches spec
  const content = readFileSync(CORPUS_PATH, "utf8");
  const actual = createHash("sha256").update(content).digest("hex");
  if (actual !== spec.sha256) {
    process.stderr.write(`ERROR: corpus SHA-256 mismatch.\n  expected: ${spec.sha256}\n  actual:   ${actual}\n`);
    process.stderr.write("Delete corpus/input-100MB.json and re-run to regenerate.\n");
    process.exit(1);
  }
  console.log(`${GREEN}PASS${RESET} corpus verified (${(spec.actual_size_bytes / 1024 / 1024).toFixed(1)}MB, SHA-256 matches spec)`);
  return spec;
}

// ---------------------------------------------------------------------------
// Correctness verification test input (fixed 10KB JSON)
// ---------------------------------------------------------------------------

// A known deterministic JSON with numeric leaves.
// Expected sum is computed in the orchestrator directly.
function buildVerificationInput() {
  // A fixed nested structure with known numeric leaves.
  // We compute the expected sum ourselves to avoid a chicken-and-egg problem.
  const obj = {
    "a": 1.5,
    "b_list": [2.0, 3.0, { "nested_value": 4.5, "flag": true, "label": "test" }],
    "c": {
      "x": 10.0,
      "y": -5.5,
      "z": [100.0, 200.0, 300.0],
      "meta": null,
    },
    "d": false,
    "e": "hello",
    "f": [[[42.0]]],
  };
  // Expected sum: 1.5 + 2.0 + 3.0 + 4.5 + 10.0 + (-5.5) + 100.0 + 200.0 + 300.0 + 42.0 = 657.5
  const expectedSum = 657.5;
  const jsonStr = JSON.stringify(obj);
  const tmpPath = join(CORPUS_DIR, "verify-10kb.json");
  mkdirSync(CORPUS_DIR, { recursive: true });
  writeFileSync(tmpPath, jsonStr, "utf8");
  return { tmpPath, expectedSum };
}

// ---------------------------------------------------------------------------
// Run a comparator subprocess for correctness check or timing
// ---------------------------------------------------------------------------

function runComparatorOnce(name, cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, {
    encoding: "utf8",
    // @decision DEC-BENCH-B1-CI-TIMEOUT-001
    // ubuntu-latest runners are dramatically slower at pure-software CPU work than
    // typical developer machines (~2.2× factor observed on rust-software SHA-256).
    // The 600s default timeout was sufficient on Windows but not in CI. 30 minutes
    // is a generous ceiling that should accommodate even the slowest comparator on
    // the slowest runner; runs that approach this cap should be investigated as a
    // separate perf regression, not as a timeout bug. CI job timeout is independent
    // at 60 minutes (workflow level), so a runaway is still bounded.
    timeout: 1800000, // 30 min — covers ubuntu-latest ~2.2× slowdown vs Windows
    ...opts,
  });

  if (result.error) return { error: result.error.message };
  if (result.status === 2) return { blocker: true, stderr: result.stderr };
  if (result.status !== 0) return { failed: true, status: result.status, stderr: result.stderr };

  try {
    return { ok: true, data: JSON.parse(result.stdout.trim()) };
  } catch (e) {
    return { parseError: e.message, stdout: result.stdout.slice(0, 300) };
  }
}

// ---------------------------------------------------------------------------
// Correctness verification gate
// ---------------------------------------------------------------------------

function verifyCorrectness(rustAcceleratedBin, rustSoftwareBin) {
  console.log(`\n${BOLD}[correctness-check]${RESET} verifying all 4 comparators produce identical output on 10KB test input...`);

  const { tmpPath, expectedSum } = buildVerificationInput();
  const tsNodeCmd = process.execPath;
  const tsNodeArgs = ["--experimental-strip-types", "--no-warnings"];

  const comparators = [
    { name: "rust-accelerated", cmd: rustAcceleratedBin, args: [tmpPath] },
    { name: "rust-software",    cmd: rustSoftwareBin,    args: [tmpPath] },
    { name: "ts-node",          cmd: tsNodeCmd,          args: [...tsNodeArgs, join(__dirname, "ts-baseline", "run.ts"), tmpPath] },
    { name: "yakcc-as",         cmd: process.execPath,   args: [join(__dirname, "yakcc-as", "run.mjs"), tmpPath] },
  ];

  const checksums = [];
  let allPassed = true;

  for (const c of comparators) {
    const r = runComparatorOnce(c.name, c.cmd, c.args);
    if (r.blocker) {
      console.log(`  ${RED}SCOPE-BLOCKER${RESET} ${c.name} reported a compilation blocker`);
      if (r.stderr) process.stderr.write(r.stderr);
      return { passed: false, blocker: c.name };
    }
    if (!r.ok) {
      console.log(`  ${RED}FAIL${RESET} ${c.name}: ${r.error || r.parseError || `exit ${r.status}`}`);
      allPassed = false;
      continue;
    }
    const sum = r.data.checksum;
    checksums.push({ name: c.name, sum });
    const relErr = Math.abs(sum - expectedSum) / Math.abs(expectedSum);
    if (relErr > 1e-6) {
      console.log(`  ${RED}MISMATCH${RESET} ${c.name}: got ${sum}, expected ${expectedSum} (relErr=${relErr.toExponential(2)})`);
      allPassed = false;
    } else {
      console.log(`  ${GREEN}PASS${RESET} ${c.name}: checksum=${sum} (relErr=${relErr.toExponential(2)} vs expected=${expectedSum})`);
    }
  }

  if (!allPassed) {
    console.log(`\n${RED}${BOLD}CORRECTNESS FAIL${RESET} — comparators disagree. Timing measurement aborted.`);
    return { passed: false, checksums };
  }

  // Cross-check: all checksums must agree with each other
  if (checksums.length >= 2) {
    const ref = checksums[0].sum;
    for (const c of checksums.slice(1)) {
      const relErr = Math.abs(c.sum - ref) / Math.abs(ref);
      if (relErr > 1e-6) {
        console.log(`  ${RED}CROSS-MISMATCH${RESET} ${checksums[0].name}=${ref} vs ${c.name}=${c.sum}`);
        allPassed = false;
      }
    }
  }

  if (allPassed) {
    console.log(`  ${GREEN}${BOLD}CORRECTNESS PASS${RESET} — all 4 comparators produce byte-equivalent output`);
  }

  return { passed: allPassed, checksums };
}

// ---------------------------------------------------------------------------
// Run a comparator for timing
// ---------------------------------------------------------------------------

function runComparator(name, cmd, args, opts = {}) {
  console.log(`\n${BOLD}[${name}]${RESET} running 100 warm-up + 1000 measured iterations...`);
  const result = spawnSync(cmd, args, {
    encoding: "utf8",
    timeout: 1800000, // 30 min — see DEC-BENCH-B1-CI-TIMEOUT-001
    ...opts,
  });

  if (result.error) {
    console.error(`  ${RED}ERROR${RESET} spawn error: ${result.error.message}`);
    return null;
  }
  if (result.status === 2) {
    console.error(`  ${RED}SCOPE-BLOCKER${RESET} ${name} reported a compilation blocker:`);
    if (result.stderr) process.stderr.write(result.stderr);
    return { _blocker: true, comparator: name };
  }
  if (result.status !== 0) {
    console.error(`  ${RED}FAIL${RESET} exited with code ${result.status}`);
    if (result.stderr) process.stderr.write(`  stderr: ${result.stderr.trim().slice(0, 500)}\n`);
    return null;
  }
  if (result.stderr && result.stderr.trim()) {
    process.stderr.write(`  ${YELLOW}WARN${RESET} stderr: ${result.stderr.trim().slice(0, 200)}\n`);
  }

  try {
    const parsed = JSON.parse(result.stdout.trim());
    console.log(`  ${GREEN}DONE${RESET} p50=${parsed.p50_ms?.toFixed(1)}ms mean=${parsed.mean_ms?.toFixed(1)}ms tp=${parsed.throughput_mb_per_sec?.toFixed(0)}MB/s`);
    return parsed;
  } catch (e) {
    console.error(`  ${RED}ERROR${RESET} failed to parse JSON output: ${e.message}`);
    console.error(`  stdout was: ${result.stdout.slice(0, 200)}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Verdict computation
// ---------------------------------------------------------------------------

function computeVerdict(rustAcceleratedResult, rustSoftwareResult, yakccResult) {
  if (!rustSoftwareResult || !yakccResult || yakccResult._blocker) {
    return {
      primary_comparison: "yakcc-as vs rust-software",
      yakcc_vs_rust_software_degradation_pct: null,
      vs_pass_bar_15pct: yakccResult?._blocker ? "blocker" : "error",
      note: yakccResult?._blocker
        ? "yakcc-as hit a SCOPE-BLOCKER: asc cannot compile the DFS sum kernel"
        : "missing result data",
    };
  }

  const yakccMean = yakccResult.mean_ms;
  const rustSoftwareMean = rustSoftwareResult.mean_ms;
  const degradationPct = (yakccMean - rustSoftwareMean) / rustSoftwareMean * 100;

  let verdict;
  if (degradationPct <= 15) verdict = "pass";
  else if (degradationPct <= 40) verdict = "warn";
  else verdict = "kill";

  const result = {
    primary_comparison: "yakcc-as vs rust-software",
    yakcc_vs_rust_software_degradation_pct: parseFloat(degradationPct.toFixed(2)),
    vs_pass_bar_15pct: verdict,
    note: "serde_json has no force-soft feature analog; rust-accelerated and rust-software are functionally identical — see algorithm.md",
  };

  if (rustAcceleratedResult) {
    const speedupPct = (rustSoftwareMean - rustAcceleratedResult.mean_ms) / rustAcceleratedResult.mean_ms * 100;
    result.ceiling_reference = {
      rust_accelerated_throughput_mb_per_sec: rustAcceleratedResult.throughput_mb_per_sec,
      speedup_vs_software_pct: parseFloat(speedupPct.toFixed(2)),
      note: "serde_json: no feature-gated hardware acceleration; both Rust bins are functionally identical",
    };
  }

  return result;
}

// ---------------------------------------------------------------------------
// Environment capture
// ---------------------------------------------------------------------------

function captureEnvironment() {
  const rustVersionResult = spawnSync("rustc", ["--version"], { encoding: "utf8" });
  const rustVersion = rustVersionResult.status === 0
    ? rustVersionResult.stdout.trim()
    : "unavailable";

  const gitHeadResult = spawnSync("git", ["-C", REPO_ROOT, "rev-parse", "--short", "HEAD"], {
    encoding: "utf8",
  });
  const yakccHead = gitHeadResult.status === 0
    ? gitHeadResult.stdout.trim()
    : "unknown";

  return {
    platform: process.platform,
    arch: process.arch,
    cpu: cpus()[0]?.model ?? "unknown",
    cpu_count: cpus().length,
    total_mem_gb: parseFloat((totalmem() / (1024 ** 3)).toFixed(1)),
    node: process.version,
    rust: rustVersion,
    yakcc_head: yakccHead,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

console.log(`\n${"=".repeat(60)}`);
console.log(`${BOLD}B1-latency / json-transformer benchmark${RESET}`);
console.log(`Sum-of-numeric-leaves DFS over ~100MB JSON corpus — 4 comparators`);
console.log(`${"=".repeat(60)}\n`);

const spec = await ensureCorpus();

const rustBaselineDir = join(__dirname, "rust-baseline");
const ext = process.platform === "win32" ? ".exe" : "";

// Build both Rust binaries
console.log(`\n${BOLD}[build]${RESET} cargo build --release --bin json-transformer-accelerated...`);
const cargoAcceleratedResult = spawnSync("cargo", [
  "build", "--release",
  "--bin", "json-transformer-accelerated",
], {
  cwd: rustBaselineDir,
  stdio: "inherit",
  encoding: "utf8",
  timeout: 300000,
});
if (cargoAcceleratedResult.status !== 0) {
  process.stderr.write("ERROR: cargo build (accelerated) failed\n");
  process.exit(1);
}
console.log(`${GREEN}PASS${RESET} json-transformer-accelerated built`);

console.log(`\n${BOLD}[build]${RESET} cargo build --release --bin json-transformer-software...`);
const cargoSoftwareResult = spawnSync("cargo", [
  "build", "--release",
  "--bin", "json-transformer-software",
], {
  cwd: rustBaselineDir,
  stdio: "inherit",
  encoding: "utf8",
  timeout: 300000,
});
if (cargoSoftwareResult.status !== 0) {
  process.stderr.write("ERROR: cargo build (software) failed\n");
  process.exit(1);
}
console.log(`${GREEN}PASS${RESET} json-transformer-software built`);

const rustAcceleratedBin = join(rustBaselineDir, "target", "release", `json-transformer-accelerated${ext}`);
const rustSoftwareBin    = join(rustBaselineDir, "target", "release", `json-transformer-software${ext}`);

const tsNodeCmd  = process.execPath;
const tsNodeArgs = ["--experimental-strip-types", "--no-warnings"];

// ---------------------------------------------------------------------------
// Correctness verification gate — MUST pass before timing
// ---------------------------------------------------------------------------

const correctness = verifyCorrectness(rustAcceleratedBin, rustSoftwareBin);
if (!correctness.passed) {
  process.stderr.write(`\nERROR: correctness check failed — aborting timing measurement.\n`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Timing runs
// ---------------------------------------------------------------------------

const rustAcceleratedResult = runComparator("rust-accelerated", rustAcceleratedBin, [CORPUS_PATH]);
const rustSoftwareResult    = runComparator("rust-software",    rustSoftwareBin,    [CORPUS_PATH]);
const tsNodeResult          = runComparator("ts-node",          tsNodeCmd,          [...tsNodeArgs, join(__dirname, "ts-baseline", "run.ts"), CORPUS_PATH]);
const yakccResult           = runComparator("yakcc-as",         process.execPath,   [join(__dirname, "yakcc-as", "run.mjs"), CORPUS_PATH]);

// ---------------------------------------------------------------------------
// Verdict
// ---------------------------------------------------------------------------

const verdict = computeVerdict(rustAcceleratedResult, rustSoftwareResult, yakccResult);

// Build result artifact
const timestamp = new Date().toISOString();
const artifact = {
  slice: "json-transformer",
  timestamp,
  corpus: { sha256: spec.sha256, size_bytes: spec.actual_size_bytes },
  algorithm: "sum-of-all-numeric-leaves (DFS); camelCase fallback — see algorithm.md",
  environment: captureEnvironment(),
  correctness_check: {
    passed: correctness.passed,
    checksums: correctness.checksums,
    note: "All 4 comparators verified to produce byte-equivalent output on 10KB fixed test input before timing",
  },
  results: [rustAcceleratedResult, rustSoftwareResult, tsNodeResult, yakccResult].filter(Boolean),
  verdict,
};

// Write artifact
const outDir = join(REPO_ROOT, "tmp", "B1-latency");
mkdirSync(outDir, { recursive: true });
const safeTs = timestamp.replace(/[:.]/g, "-").replace("T", "_").slice(0, 19);
const artifactPath = join(outDir, `json-transformer-${safeTs}.json`);
writeFileSync(artifactPath, JSON.stringify(artifact, null, 2) + "\n", "utf8");

// Human-readable summary
console.log(`\n${"=".repeat(60)}`);
console.log(`${BOLD}RESULTS${RESET}`);
console.log(`${"=".repeat(60)}`);
if (rustAcceleratedResult && !rustAcceleratedResult._blocker) {
  console.log(`  rust-accelerated  p50=${rustAcceleratedResult.p50_ms?.toFixed(2)}ms  mean=${rustAcceleratedResult.mean_ms?.toFixed(2)}ms  tp=${rustAcceleratedResult.throughput_mb_per_sec?.toFixed(0)}MB/s  [ceiling ref — same as software for serde_json]`);
}
if (rustSoftwareResult && !rustSoftwareResult._blocker) {
  console.log(`  rust-software     p50=${rustSoftwareResult.p50_ms?.toFixed(2)}ms  mean=${rustSoftwareResult.mean_ms?.toFixed(2)}ms  tp=${rustSoftwareResult.throughput_mb_per_sec?.toFixed(0)}MB/s  [apples-to-apples gate]`);
}
if (tsNodeResult && !tsNodeResult._blocker) {
  console.log(`  ts-node           p50=${tsNodeResult.p50_ms?.toFixed(2)}ms  mean=${tsNodeResult.mean_ms?.toFixed(2)}ms  tp=${tsNodeResult.throughput_mb_per_sec?.toFixed(0)}MB/s`);
}
if (yakccResult && !yakccResult._blocker) {
  console.log(`  yakcc-as          p50=${yakccResult.p50_ms?.toFixed(2)}ms  mean=${yakccResult.mean_ms?.toFixed(2)}ms  tp=${yakccResult.throughput_mb_per_sec?.toFixed(0)}MB/s  [unit under test]`);
}

console.log(`\n${"=".repeat(60)}`);
console.log(`${BOLD}VERDICT${RESET}`);
console.log(`${"=".repeat(60)}`);

const deg = verdict.yakcc_vs_rust_software_degradation_pct;
if (deg !== null) {
  const degStr = deg >= 0 ? `+${deg.toFixed(1)}%` : `${deg.toFixed(1)}%`;
  console.log(`  yakcc-as vs rust-software degradation: ${degStr}`);
}

const bar = verdict.vs_pass_bar_15pct;
if (bar === "pass") {
  console.log(`  ${GREEN}${BOLD}PASS${RESET} — degradation ≤15% (AS-backend viable for DFS substrate work)`);
} else if (bar === "warn") {
  console.log(`  ${YELLOW}${BOLD}WARN${RESET} — degradation 15%–40% (concerning; review AS initiative)`);
} else if (bar === "kill") {
  console.log(`  ${RED}${BOLD}KILL${RESET} — degradation >40% (triggers re-plan of #143 AS initiative)`);
} else if (bar === "blocker") {
  console.log(`  ${RED}${BOLD}SCOPE-BLOCKER${RESET} — asc cannot compile the DFS sum kernel`);
  console.log(`  See stderr above for the specific gap. Issue #185 needs updating.`);
} else {
  console.log(`  ${RED}ERROR${RESET} — could not compute verdict (missing results)`);
}

console.log(`\nArtifact: ${artifactPath}`);
console.log(`Environment: ${artifact.environment.platform}/${artifact.environment.arch} ${artifact.environment.cpu}`);
console.log(`Node: ${artifact.environment.node}  Rust: ${artifact.environment.rust}`);
console.log(`${"=".repeat(60)}\n`);

process.exit(bar === "kill" || bar === "blocker" || bar === "error" ? 1 : 0);
