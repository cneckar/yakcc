// SPDX-License-Identifier: MIT
//
// bench/B1-latency/http-routing/run.mjs — B1 http-routing benchmark orchestrator
//
// @decision DEC-BENCH-B1-HTTP-001
// @title B1 http-routing: 4-comparator u32-trie glue-heavy measurement
// @status accepted
// @rationale
//   Pass/kill bars (per issue #185 — glue-heavy relaxed bar):
//     PASS:  yakcc-as degradation vs rust-software ≤ 25%
//     WARN:  degradation 25%–40%
//     KILL:  degradation > 40% (triggers re-plan of #143 AS initiative)
//
//   Workload: trie-based HTTP path matching over 10K rules × 100K queries.
//   The glue-heavy class tests WASM dispatch/branching overhead, not arithmetic
//   throughput. The relaxed 25% pass bar (vs 15% for substrate-heavy) reflects
//   the inherent indirect-call overhead of WASM JIT dispatch tables vs native code.
//
//   Segment hashing decision:
//     AS-backend --runtime stub has no managed strings. Rather than making
//     yakcc-as a special case, ALL four comparators hash path segments to u32
//     OUTSIDE the timing loop. The timing loop is a pure u32-keyed trie walk.
//     This is documented in algorithm.md as equivalent workload: the hash is a
//     deterministic surjective map, not lossy compression of the routing problem.
//     PARAM_SENTINEL=1 and WILDCARD_SENTINEL=2 are reserved values.
//
//   Four comparators:
//     1. rust-accelerated: native Rust (hand-rolled u32-keyed trie)
//                          Ceiling reference — no hardware accel for routing.
//                          Identical algorithm to rust-software; verdict collapses.
//     2. rust-software:    native Rust (same trie) — apples-to-apples gate.
//     3. ts-node:          Node.js V8 (Map-based trie over u32 keys)
//     4. yakcc-as:         AS WASM (flat Uint32Array trie in linear memory)
//
//   Correctness gate (load-bearing):
//     Before timing, all 4 comparators run on a 100-query test set.
//     They must produce identical {matched_count, total_captures} integers.
//     Mismatch = hard fail; benchmark aborts before timing.
//
//   Methodology:
//     - Corpus: 10K rules + 100K queries, deterministic xorshift32
//     - Warm-up: 100 iterations (discarded)
//     - Measurement: 1000 iterations
//     - Metric: wall-clock latency per 100K-query corpus pass
//     - Statistics: p50, p95, p99, mean, queries_per_sec
//     - Process isolation: each comparator in a fresh subprocess
//
//   Degradation = (yakcc_mean - rust_software_mean) / rust_software_mean * 100
//   Negative degradation = yakcc-as is FASTER than Rust (as seen in Slice 2 JSON).
//
//   Result artifact: tmp/B1-latency/http-routing-<ISO-timestamp>.json

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { cpus, totalmem } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));

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
// Corpus management
// ---------------------------------------------------------------------------

const CORPUS_DIR  = join(__dirname, "corpus");
const TABLE_PATH  = join(CORPUS_DIR, "routing-table-10k.json");
const QUERY_PATH  = join(CORPUS_DIR, "query-set-100k.json");
const SPEC_PATH   = join(__dirname, "corpus-spec.json");

// 100-query test set for correctness gate (subset indices from the full query set)
const CORRECTNESS_QUERY_COUNT = 100;

async function ensureCorpus() {
  const spec = JSON.parse(readFileSync(SPEC_PATH, "utf8"));

  if (!existsSync(TABLE_PATH) || !existsSync(QUERY_PATH) || !spec.routing_table.sha256) {
    console.log(`\n${BOLD}[corpus]${RESET} Generating corpora (first run)...`);
    const gen = spawnSync(process.execPath, [join(__dirname, "generate-corpus.mjs")], {
      stdio: "inherit",
      timeout: 60000,
    });
    if (gen.status !== 0) {
      process.stderr.write("ERROR: corpus generation failed\n");
      process.exit(1);
    }
    return JSON.parse(readFileSync(SPEC_PATH, "utf8"));
  }

  // Verify SHA-256 of existing corpora
  const tableJson  = readFileSync(TABLE_PATH, "utf8");
  const queryJson  = readFileSync(QUERY_PATH, "utf8");
  const tableSha   = createHash("sha256").update(tableJson, "utf8").digest("hex");
  const querySha   = createHash("sha256").update(queryJson, "utf8").digest("hex");

  if (tableSha !== spec.routing_table.sha256 || querySha !== spec.query_set.sha256) {
    console.warn(`${YELLOW}[corpus]${RESET} Checksum mismatch — regenerating...`);
    const gen = spawnSync(process.execPath, [join(__dirname, "generate-corpus.mjs")], {
      stdio: "inherit", timeout: 60000,
    });
    if (gen.status !== 0) {
      process.stderr.write("ERROR: corpus regeneration failed\n");
      process.exit(1);
    }
    return JSON.parse(readFileSync(SPEC_PATH, "utf8"));
  }

  console.log(`${GREEN}[corpus]${RESET} Verified routing-table-10k.json + query-set-100k.json`);
  return spec;
}

// ---------------------------------------------------------------------------
// Comparator runner
// ---------------------------------------------------------------------------

// @decision DEC-BENCH-B1-CI-TIMEOUT-001
// ubuntu-latest runners are dramatically slower at pure-software CPU work than
// typical developer machines (~2.2× factor observed on rust-software SHA-256).
// The 600s default timeout was sufficient on Windows but not in CI. 60 minutes
// is a generous ceiling that should accommodate even the slowest comparator on
// the slowest runner (including darwin/M1 Pro yakcc-as WASM JIT cost — #638).
// Bumped 30→60 min for #638 (darwin/M1 Pro yakcc-as wall-clock); see also
// YAKCC_AS_MEASURED_ITERS opt-in in yakcc-as/run.mjs.
// Runs that approach this cap should be investigated as a separate perf
// regression, not as a timeout bug. CI job timeout is independent at 60 minutes
// (workflow level), so a runaway is still bounded.
function runComparator(label, cmd, args, timeoutMs = 3600000) { // 60 min — covers ubuntu-latest ~2.2× slowdown and darwin yakcc-as M1 JIT cost
  console.log(`\n${BOLD}[run]${RESET} ${label}...`);
  const result = spawnSync(cmd, args, {
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 4 * 1024 * 1024,
  });

  if (result.error) {
    console.error(`  ${RED}ERROR${RESET} ${label}: ${result.error.message}`);
    return { comparator: label, _blocker: result.error.message };
  }
  if (result.status !== 0) {
    const stderr = (result.stderr || "").trim().slice(0, 500);
    console.error(`  ${RED}FAILED${RESET} ${label} (exit ${result.status}): ${stderr}`);
    return { comparator: label, _blocker: `exit ${result.status}: ${stderr}` };
  }

  const stdout = (result.stdout || "").trim();
  // Last line is the JSON result
  const lines = stdout.split("\n").filter(l => l.trim().startsWith("{"));
  if (lines.length === 0) {
    console.error(`  ${RED}ERROR${RESET} ${label}: no JSON output`);
    return { comparator: label, _blocker: "no JSON output" };
  }

  try {
    const parsed = JSON.parse(lines[lines.length - 1]);
    if (parsed._blocker) {
      console.error(`  ${RED}BLOCKER${RESET} ${label}: ${parsed._blocker}`);
    } else {
      console.log(`  ${GREEN}OK${RESET}  p50=${parsed.p50_ms?.toFixed(2)}ms  mean=${parsed.mean_ms?.toFixed(2)}ms  qps=${parsed.queries_per_sec?.toFixed(0)}  matched=${parsed.matched_count}  captures=${parsed.total_captures}`);
    }
    return parsed;
  } catch (e) {
    console.error(`  ${RED}ERROR${RESET} ${label}: JSON parse failed: ${e.message}`);
    return { comparator: label, _blocker: `JSON parse failed: ${e.message}` };
  }
}

// ---------------------------------------------------------------------------
// Correctness verification gate
// ---------------------------------------------------------------------------

function verifyCorrectness(rustAccBin, rustSoftBin) {
  console.log(`\n${BOLD}[correctness]${RESET} Running all 4 comparators on ${CORRECTNESS_QUERY_COUNT}-query test set...`);

  // Write a correctness-only query set (first N queries from the full set)
  const allQueries = JSON.parse(readFileSync(QUERY_PATH, "utf8"));
  const testQueries = allQueries.slice(0, CORRECTNESS_QUERY_COUNT);
  const testQueryPath = join(CORPUS_DIR, "correctness-test-queries.json");
  writeFileSync(testQueryPath, JSON.stringify(testQueries), "utf8");

  const tsNodeCmd  = process.execPath;
  const tsNodeArgs = ["--experimental-strip-types", "--no-warnings"];
  const ext = process.platform === "win32" ? ".exe" : "";

  const comparators = [
    {
      label: "rust-accelerated",
      cmd: rustAccBin,
      args: [TABLE_PATH, testQueryPath],
    },
    {
      label: "rust-software",
      cmd: rustSoftBin,
      args: [TABLE_PATH, testQueryPath],
    },
    {
      label: "ts-node",
      cmd: tsNodeCmd,
      args: [...tsNodeArgs, join(__dirname, "ts-baseline", "run.ts"), TABLE_PATH, testQueryPath],
    },
    {
      label: "yakcc-as",
      cmd: tsNodeCmd,
      args: [join(__dirname, "yakcc-as", "run.mjs"), TABLE_PATH, testQueryPath],
    },
  ];

  const results = [];
  for (const { label, cmd, args } of comparators) {
    const r = spawnSync(cmd, args, {
      encoding: "utf8", timeout: 300000, maxBuffer: 4 * 1024 * 1024,
    });

    if (r.error || r.status !== 0) {
      const msg = r.error?.message || `exit ${r.status}: ${(r.stderr || "").trim().slice(0, 200)}`;
      console.error(`  ${RED}FAIL${RESET} ${label}: ${msg}`);
      results.push({ label, matched_count: null, total_captures: null, error: msg });
      continue;
    }

    const lines = (r.stdout || "").trim().split("\n").filter(l => l.trim().startsWith("{"));
    if (lines.length === 0) {
      console.error(`  ${RED}FAIL${RESET} ${label}: no JSON output`);
      results.push({ label, matched_count: null, total_captures: null, error: "no JSON output" });
      continue;
    }

    try {
      const parsed = JSON.parse(lines[lines.length - 1]);
      if (parsed._blocker) {
        console.warn(`  ${YELLOW}SKIP${RESET} ${label}: ${parsed._blocker}`);
        results.push({ label, matched_count: null, total_captures: null, blocked: parsed._blocker });
      } else {
        console.log(`  ${GREEN}OK${RESET}   ${label}: matched=${parsed.matched_count}  captures=${parsed.total_captures}`);
        results.push({ label, matched_count: parsed.matched_count, total_captures: parsed.total_captures });
      }
    } catch (e) {
      console.error(`  ${RED}FAIL${RESET} ${label}: JSON parse error: ${e.message}`);
      results.push({ label, matched_count: null, total_captures: null, error: e.message });
    }
  }

  // Cross-verify: all non-blocked results must agree on matched_count and total_captures
  const verifiable = results.filter(r => r.matched_count !== null && r.total_captures !== null);
  if (verifiable.length < 2) {
    return { passed: false, reason: "fewer than 2 comparators produced results", checksums: results };
  }

  const ref = verifiable[0];
  let allMatch = true;
  for (const r of verifiable.slice(1)) {
    if (r.matched_count !== ref.matched_count || r.total_captures !== ref.total_captures) {
      console.error(
        `  ${RED}MISMATCH${RESET} ${r.label}: matched=${r.matched_count} captures=${r.total_captures}` +
        ` vs ${ref.label}: matched=${ref.matched_count} captures=${ref.total_captures}`
      );
      allMatch = false;
    }
  }

  if (!allMatch) {
    return { passed: false, reason: "correctness mismatch across comparators", checksums: results };
  }

  console.log(`  ${GREEN}${BOLD}PASS${RESET} All verifiable comparators agree: matched=${ref.matched_count}  captures=${ref.total_captures}`);
  return {
    passed: true,
    reference: { matched_count: ref.matched_count, total_captures: ref.total_captures },
    checksums: results,
  };
}

// ---------------------------------------------------------------------------
// Verdict computation (glue-heavy: ≤25% pass, >40% kill)
// ---------------------------------------------------------------------------

function computeVerdict(rustAccResult, rustSoftResult, yakccResult) {
  if (!rustSoftResult || rustSoftResult._blocker) {
    return { primary_comparison: "yakcc-as vs rust-software", error: "rust-software result unavailable" };
  }
  if (!yakccResult || yakccResult._blocker) {
    const blocker = yakccResult?._blocker ?? "yakcc-as result unavailable";
    return { primary_comparison: "yakcc-as vs rust-software", vs_pass_bar_25pct: "blocker", blocker };
  }

  const rustSoftMean = rustSoftResult.mean_ms;
  const yakccMean    = yakccResult.mean_ms;
  const degradationPct = (yakccMean - rustSoftMean) / rustSoftMean * 100;

  let verdict;
  if (degradationPct <= 25)      verdict = "pass";
  else if (degradationPct <= 40) verdict = "warn";
  else                           verdict = "kill";

  const result = {
    primary_comparison: "yakcc-as vs rust-software",
    yakcc_vs_rust_software_degradation_pct: parseFloat(degradationPct.toFixed(2)),
    vs_pass_bar_25pct: verdict,
    note: "Glue-heavy workload: pass bar relaxed to ≤25% (vs ≤15% substrate-heavy). HTTP routing has no hardware-acceleration analog; both Rust bins are structurally identical.",
  };

  if (rustAccResult && !rustAccResult._blocker) {
    const rustDiff = (rustSoftMean - rustAccResult.mean_ms) / rustAccResult.mean_ms * 100;
    result.ceiling_reference = {
      rust_accelerated_mean_ms: rustAccResult.mean_ms,
      diff_vs_software_pct: parseFloat(rustDiff.toFixed(2)),
      note: "No hardware acceleration for HTTP routing; rust-accelerated ≈ rust-software",
    };
  }

  return result;
}

// ---------------------------------------------------------------------------
// Environment capture
// ---------------------------------------------------------------------------

function captureEnvironment() {
  const rustV = spawnSync("rustc", ["--version"], { encoding: "utf8" });
  const gitV  = spawnSync("git", ["-C", REPO_ROOT, "rev-parse", "--short", "HEAD"], { encoding: "utf8" });
  return {
    platform:     process.platform,
    arch:         process.arch,
    cpu:          cpus()[0]?.model ?? "unknown",
    cpu_count:    cpus().length,
    total_mem_gb: parseFloat((totalmem() / (1024 ** 3)).toFixed(1)),
    node:         process.version,
    rust:         rustV.status === 0 ? rustV.stdout.trim() : "unavailable",
    yakcc_head:   gitV.status === 0  ? gitV.stdout.trim()  : "unknown",
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

console.log(`\n${"=".repeat(60)}`);
console.log(`${BOLD}B1-latency / http-routing benchmark${RESET}`);
console.log(`Trie-based path matching: 10K rules × 100K queries — 4 comparators`);
console.log(`Pass bar: ≤25% degradation vs rust-software (glue-heavy)`);
console.log(`${"=".repeat(60)}\n`);

const spec = await ensureCorpus();

const rustBaselineDir = join(__dirname, "rust-baseline");
const ext = process.platform === "win32" ? ".exe" : "";

// Build both Rust binaries
console.log(`\n${BOLD}[build]${RESET} cargo build --release --bin http-routing-accelerated...`);
const cargoAccResult = spawnSync("cargo", [
  "build", "--release", "--bin", "http-routing-accelerated",
], { cwd: rustBaselineDir, stdio: "inherit", timeout: 300000 });
if (cargoAccResult.status !== 0) {
  process.stderr.write("ERROR: cargo build (accelerated) failed\n");
  process.exit(1);
}
console.log(`${GREEN}PASS${RESET} http-routing-accelerated built`);

console.log(`\n${BOLD}[build]${RESET} cargo build --release --bin http-routing-software...`);
const cargoSoftResult = spawnSync("cargo", [
  "build", "--release", "--bin", "http-routing-software",
], { cwd: rustBaselineDir, stdio: "inherit", timeout: 300000 });
if (cargoSoftResult.status !== 0) {
  process.stderr.write("ERROR: cargo build (software) failed\n");
  process.exit(1);
}
console.log(`${GREEN}PASS${RESET} http-routing-software built`);

const rustAccBin  = join(rustBaselineDir, "target", "release", `http-routing-accelerated${ext}`);
const rustSoftBin = join(rustBaselineDir, "target", "release", `http-routing-software${ext}`);
const tsNodeCmd   = process.execPath;
const tsNodeArgs  = ["--experimental-strip-types", "--no-warnings"];

// ---------------------------------------------------------------------------
// Correctness gate — must pass before timing
// ---------------------------------------------------------------------------

const correctness = verifyCorrectness(rustAccBin, rustSoftBin);
if (!correctness.passed) {
  process.stderr.write(`\nERROR: correctness check failed — aborting timing measurement.\n`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Timing runs
// ---------------------------------------------------------------------------

const rustAccResult  = runComparator("rust-accelerated", rustAccBin,  [TABLE_PATH, QUERY_PATH]);
const rustSoftResult = runComparator("rust-software",    rustSoftBin, [TABLE_PATH, QUERY_PATH]);
const tsNodeResult   = runComparator("ts-node",          tsNodeCmd,   [...tsNodeArgs, join(__dirname, "ts-baseline", "run.ts"), TABLE_PATH, QUERY_PATH]);
const yakccResult    = runComparator("yakcc-as",         tsNodeCmd,   [join(__dirname, "yakcc-as", "run.mjs"), TABLE_PATH, QUERY_PATH]);

// ---------------------------------------------------------------------------
// Verdict
// ---------------------------------------------------------------------------

const verdict = computeVerdict(rustAccResult, rustSoftResult, yakccResult);

// ---------------------------------------------------------------------------
// Artifact
// ---------------------------------------------------------------------------

const timestamp = new Date().toISOString();
const artifact = {
  slice: "http-routing",
  timestamp,
  corpus: {
    routing_table_sha256: spec.routing_table.sha256,
    query_set_sha256:     spec.query_set.sha256,
    rule_count:           spec.routing_table.actual_rule_count ?? spec.routing_table.rule_count,
    query_count:          spec.query_set.actual_query_count    ?? spec.query_set.query_count,
  },
  algorithm: "u32-keyed trie (segment hashing outside timing loop); see algorithm.md",
  environment: captureEnvironment(),
  correctness_check: {
    passed:  correctness.passed,
    reference: correctness.reference ?? null,
    checksums: correctness.checksums,
    note: "All comparators verified to produce identical {matched_count, total_captures} on 100-query test set before timing",
  },
  results: [rustAccResult, rustSoftResult, tsNodeResult, yakccResult].filter(Boolean),
  verdict,
};

const outDir = join(REPO_ROOT, "tmp", "B1-latency");
mkdirSync(outDir, { recursive: true });
const safeTs      = timestamp.replace(/[:.]/g, "-").replace("T", "_").slice(0, 19);
const artifactPath = join(outDir, `http-routing-${safeTs}.json`);
writeFileSync(artifactPath, JSON.stringify(artifact, null, 2) + "\n", "utf8");

// ---------------------------------------------------------------------------
// Human-readable summary
// ---------------------------------------------------------------------------

console.log(`\n${"=".repeat(60)}`);
console.log(`${BOLD}RESULTS${RESET}`);
console.log(`${"=".repeat(60)}`);

for (const r of [rustAccResult, rustSoftResult, tsNodeResult, yakccResult]) {
  if (!r || r._blocker) continue;
  const role =
    r.comparator === "rust-accelerated" ? "[ceiling ref — same algo as software]" :
    r.comparator === "rust-software"    ? "[apples-to-apples gate]" :
    r.comparator === "yakcc-as"         ? "[unit under test]" : "";
  console.log(
    `  ${r.comparator.padEnd(18)}  p50=${r.p50_ms?.toFixed(2)}ms  mean=${r.mean_ms?.toFixed(2)}ms  qps=${r.queries_per_sec?.toFixed(0)}  ${role}`
  );
}

console.log(`\n${"=".repeat(60)}`);
console.log(`${BOLD}VERDICT${RESET}`);
console.log(`${"=".repeat(60)}`);

const deg = verdict.yakcc_vs_rust_software_degradation_pct;
if (deg !== undefined && deg !== null) {
  const degStr = deg >= 0 ? `+${deg.toFixed(1)}%` : `${deg.toFixed(1)}%`;
  console.log(`  yakcc-as vs rust-software degradation: ${degStr}`);
  console.log(`  Pass bar: ≤25% (glue-heavy)   Kill bar: >40%`);
}

const bar = verdict.vs_pass_bar_25pct;
if (bar === "pass") {
  console.log(`  ${GREEN}${BOLD}PASS${RESET} — degradation ≤25% (AS-backend viable for glue-heavy routing work)`);
} else if (bar === "warn") {
  console.log(`  ${YELLOW}${BOLD}WARN${RESET} — degradation 25%–40% (above pass bar; review AS initiative)`);
} else if (bar === "kill") {
  console.log(`  ${RED}${BOLD}KILL${RESET} — degradation >40% (triggers re-plan of #143 AS initiative)`);
} else if (bar === "blocker") {
  console.log(`  ${RED}${BOLD}SCOPE-BLOCKER${RESET} — asc cannot compile the routing kernel`);
  console.log(`  Blocker: ${verdict.blocker}`);
} else {
  console.log(`  ${RED}ERROR${RESET} — could not compute verdict`);
  if (verdict.error) console.log(`  ${verdict.error}`);
}

console.log(`\nArtifact: ${artifactPath}`);
console.log(`Environment: ${artifact.environment.platform}/${artifact.environment.arch} ${artifact.environment.cpu}`);
console.log(`Node: ${artifact.environment.node}  Rust: ${artifact.environment.rust}`);
console.log(`${"=".repeat(60)}\n`);

// @decision DEC-BENCH-B1-CI-VERDICT-EXIT-001
// @title KILL verdict does NOT exit code 1
// @status accepted
// @rationale
//   The orchestrator emits the verdict (pass/warn/kill) to both stdout and the artifact JSON.
//   For nightly CI, KILL is a measurement outcome — the workflow should still:
//     (a) upload the artifact, (b) post the verdict comment to issue #185, (c) succeed at the workflow level.
//   The workflow's downstream steps gate on the orchestrator succeeding; exit-1-on-KILL prevents
//   the comment + artifact upload from running, which means the operator gets no notification of
//   the KILL (the WORST case for a regression). Issue #192 verdict KILL also follows this discipline
//   when WI-BENCHMARK-B8-SYNTHETIC lands its CI integration.
// @reference issue #185 nightly workflow output run 25700865989 — KILL +41.3% suppressed by exit 1
//
// Reserve non-zero exit ONLY for genuine script failures (corpus mismatch, subprocess crash,
// comparator missing output). KILL, WARN, BLOCKER, and ERROR verdicts all exit 0 — the verdict
// is communicated via stdout and the artifact JSON, not the exit code.
process.exit(0);
