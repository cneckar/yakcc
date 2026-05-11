// SPDX-License-Identifier: MIT
//
// bench/B1-latency/integer-math/run.mjs — B1 integer-math benchmark orchestrator
//
// @decision DEC-BENCH-B1-INTEGER-001
// @title B1 integer-math benchmark: 3-comparator SHA-256 substrate measurement
// @status accepted
// @rationale
//   Pass/kill bars (per issue #185):
//     PASS:  yakcc-as degradation vs native Rust ≤ 15%
//     WARN:  degradation 15%–40% (concerning but not a kill)
//     KILL:  degradation > 40% (triggers re-plan of #143 AS initiative)
//
//   Three comparators measure SHA-256 throughput on a fixed 100MB corpus:
//     1. rust:      native Rust (sha2 crate, SHA-NI hardware acceleration where available)
//                   Strongest possible baseline — intentionally adversarial.
//     2. ts-node:   Node.js crypto.createHash("sha256") (OpenSSL-backed, also hardware-accelerated)
//                   Provides a second reference point: pure-software WASM vs Node's C binding.
//     3. yakcc-as:  AssemblyScript-compiled WASM SHA-256 (flat-memory, --runtime stub)
//                   The unit under test. Pure-software SHA-256 in WASM linear memory.
//
//   Methodology:
//     - Corpus: 100MB deterministic xorshift32 buffer (content-addressed via SHA-256)
//     - Warm-up: 100 iterations (discarded)
//     - Measurement: 1000 iterations
//     - Metric: wall-clock latency per iteration (performance.now() / Instant::now())
//     - Statistics: p50, p95, p99, mean, throughput_mb_per_sec
//     - Process isolation: each comparator runs as a fresh subprocess
//
//   Degradation is computed as: (yakcc_mean - rust_mean) / rust_mean * 100
//   using mean_ms (arithmetic mean of 1000 measurements) as the primary metric.
//   p50 is the secondary metric for robustness against outlier tails.
//
//   Hardware note: GitHub Actions ubuntu-latest is the reference target.
//   Results on Windows (development machine) are informational — SHA-NI availability
//   and JIT characteristics differ. Cross-platform runs are tagged with environment.
//
//   Result artifact: tmp/B1-latency/integer-math-<ISO-timestamp>.json
//   This file IS committed as the operator decision input for issue #185.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { cpus, totalmem } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Resolve repo root (walk up looking for package.json with name "yakcc")
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
const CORPUS_PATH = join(CORPUS_DIR, "input-100MB.bin");
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
      timeout: 120000,
    });
    if (result.status !== 0) {
      process.stderr.write("ERROR: corpus generation failed.\n");
      process.exit(1);
    }
  }

  // Verify SHA-256 of corpus matches spec
  const buf = readFileSync(CORPUS_PATH);
  const actual = createHash("sha256").update(buf).digest("hex");
  if (actual !== spec.sha256) {
    process.stderr.write(`ERROR: corpus SHA-256 mismatch.\n  expected: ${spec.sha256}\n  actual:   ${actual}\n`);
    process.stderr.write("Delete corpus/input-100MB.bin and re-run to regenerate.\n");
    process.exit(1);
  }
  console.log(`${GREEN}PASS${RESET} corpus verified (SHA-256 matches corpus-spec.json)`);
  return spec;
}

// ---------------------------------------------------------------------------
// Run a comparator subprocess and parse its JSON output
// ---------------------------------------------------------------------------

function runComparator(name, cmd, args, opts = {}) {
  console.log(`\n${BOLD}[${name}]${RESET} running ${MEASURED_NOTE}...`);
  const result = spawnSync(cmd, args, {
    encoding: "utf8",
    timeout: 600000, // 10 min max (1000 iters × SHA-256 × 100MB)
    ...opts,
  });

  if (result.error) {
    console.error(`  ${RED}ERROR${RESET} spawn error: ${result.error.message}`);
    return null;
  }

  if (result.status === 2) {
    // Exit code 2 = SCOPE-BLOCKER from yakcc-as runner
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

const MEASURED_NOTE = "100 warm-up + 1000 measured iterations";

// ---------------------------------------------------------------------------
// Verdict computation
// ---------------------------------------------------------------------------

function computeVerdict(rustResult, yakccResult) {
  if (!rustResult || !yakccResult || yakccResult._blocker) {
    return {
      yakcc_vs_rust_degradation_pct: null,
      vs_pass_bar_15pct: yakccResult?._blocker ? "blocker" : "error",
      note: yakccResult?._blocker
        ? "yakcc-as hit a SCOPE-BLOCKER: asc cannot compile the SHA-256 kernel"
        : "missing result data",
    };
  }

  const degradation = (yakccResult.mean_ms - rustResult.mean_ms) / rustResult.mean_ms * 100;

  let verdict;
  if (degradation <= 15) {
    verdict = "pass";
  } else if (degradation <= 40) {
    verdict = "warn";
  } else {
    verdict = "kill";
  }

  return {
    yakcc_vs_rust_degradation_pct: parseFloat(degradation.toFixed(2)),
    vs_pass_bar_15pct: verdict,
  };
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
console.log(`${BOLD}B1-latency / integer-math benchmark${RESET}`);
console.log(`SHA-256 over 100MB corpus — 3 comparators`);
console.log(`${"=".repeat(60)}\n`);

const spec = await ensureCorpus();

// Build Rust binary (release)
console.log(`\n${BOLD}[build]${RESET} cargo build --release (rust-baseline)...`);
const cargoResult = spawnSync("cargo", ["build", "--release"], {
  cwd: join(__dirname, "rust-baseline"),
  stdio: "inherit",
  encoding: "utf8",
  timeout: 300000,
});
if (cargoResult.status !== 0) {
  process.stderr.write("ERROR: cargo build failed\n");
  process.exit(1);
}
console.log(`${GREEN}PASS${RESET} rust-baseline built`);

// Locate rust binary
const rustBin = process.platform === "win32"
  ? join(__dirname, "rust-baseline", "target", "release", "rust-baseline.exe")
  : join(__dirname, "rust-baseline", "target", "release", "rust-baseline");

// ts-baseline is run via Node's built-in TypeScript stripping (--experimental-strip-types),
// available in Node v22+. This avoids a tsx/ts-node dependency while still running
// the .ts source directly. The experimental warning is suppressed via --no-warnings.
// Node v22 is the project's minimum runtime (see package.json packageManager field).
const tsNodeCmd = process.execPath;
const tsNodeArgs = ["--experimental-strip-types", "--no-warnings"];

// Run comparators
const rustResult   = runComparator("rust",     rustBin,                [CORPUS_PATH]);
const tsNodeResult = runComparator("ts-node",  tsNodeCmd, [...tsNodeArgs, join(__dirname, "ts-baseline", "run.ts"), CORPUS_PATH]);
const yakccResult  = runComparator("yakcc-as", process.execPath,       [join(__dirname, "yakcc-as", "run.mjs"), CORPUS_PATH]);

// Compute verdict
const verdict = computeVerdict(rustResult, yakccResult);

// Build result artifact
const timestamp = new Date().toISOString();
const artifact = {
  slice: "integer-math",
  timestamp,
  corpus: { sha256: spec.sha256, size_bytes: spec.size_bytes },
  environment: captureEnvironment(),
  results: [rustResult, tsNodeResult, yakccResult].filter(Boolean),
  verdict,
};

// Write to tmp/B1-latency/
const outDir = join(REPO_ROOT, "tmp", "B1-latency");
mkdirSync(outDir, { recursive: true });
const safeTs = timestamp.replace(/[:.]/g, "-").replace("T", "_").slice(0, 19);
const artifactPath = join(outDir, `integer-math-${safeTs}.json`);
writeFileSync(artifactPath, JSON.stringify(artifact, null, 2) + "\n", "utf8");

// Human-readable summary
console.log(`\n${"=".repeat(60)}`);
console.log(`${BOLD}RESULTS${RESET}`);
console.log(`${"=".repeat(60)}`);
if (rustResult) {
  console.log(`  rust     p50=${rustResult.p50_ms?.toFixed(2)}ms  mean=${rustResult.mean_ms?.toFixed(2)}ms  tp=${rustResult.throughput_mb_per_sec?.toFixed(0)}MB/s`);
}
if (tsNodeResult) {
  console.log(`  ts-node  p50=${tsNodeResult.p50_ms?.toFixed(2)}ms  mean=${tsNodeResult.mean_ms?.toFixed(2)}ms  tp=${tsNodeResult.throughput_mb_per_sec?.toFixed(0)}MB/s`);
}
if (yakccResult && !yakccResult._blocker) {
  console.log(`  yakcc-as p50=${yakccResult.p50_ms?.toFixed(2)}ms  mean=${yakccResult.mean_ms?.toFixed(2)}ms  tp=${yakccResult.throughput_mb_per_sec?.toFixed(0)}MB/s`);
}

console.log(`\n${"=".repeat(60)}`);
console.log(`${BOLD}VERDICT${RESET}`);
console.log(`${"=".repeat(60)}`);

const deg = verdict.yakcc_vs_rust_degradation_pct;
if (deg !== null) {
  const degStr = deg >= 0 ? `+${deg.toFixed(1)}%` : `${deg.toFixed(1)}%`;
  console.log(`  yakcc-as vs rust degradation: ${degStr}`);
}

const bar = verdict.vs_pass_bar_15pct;
if (bar === "pass") {
  console.log(`  ${GREEN}${BOLD}PASS${RESET} — degradation ≤15% (AS-backend viable for substrate work)`);
} else if (bar === "warn") {
  console.log(`  ${YELLOW}${BOLD}WARN${RESET} — degradation 15%–40% (concerning; review AS initiative)`);
} else if (bar === "kill") {
  console.log(`  ${RED}${BOLD}KILL${RESET} — degradation >40% (triggers re-plan of #143 AS initiative)`);
} else if (bar === "blocker") {
  console.log(`  ${RED}${BOLD}SCOPE-BLOCKER${RESET} — asc cannot compile SHA-256 kernel`);
  console.log(`  See stderr above for the specific gap. Issue #185 needs updating.`);
} else {
  console.log(`  ${RED}ERROR${RESET} — could not compute verdict (missing results)`);
}

console.log(`\nArtifact: ${artifactPath}`);
console.log(`Environment: ${artifact.environment.platform}/${artifact.environment.arch} ${artifact.environment.cpu}`);
console.log(`Node: ${artifact.environment.node}  Rust: ${artifact.environment.rust}`);
console.log(`${"=".repeat(60)}\n`);

process.exit(bar === "kill" || bar === "blocker" || bar === "error" ? 1 : 0);
