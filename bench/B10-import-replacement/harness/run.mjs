// SPDX-License-Identifier: MIT
//
// bench/B10-import-replacement/harness/run.mjs
//
// @decision DEC-B10-S1-LAYOUT-001
// @title Mirror B9 layout; no shared harness code between B9 and B10
// @status accepted
// @rationale
//   LAYOUT PARITY
//   B10 mirrors B9-min-surface/ exactly: run.mjs / measure-transitive-surface.mjs /
//   measure-axis1.mjs / arm-a-emit.mjs / llm-baseline.mjs / classify-arm-b.mjs.
//   Future maintainers carry one mental model across both benches.
//
//   NO SHARED CODE
//   B10 does NOT import from bench/B9-min-surface/. Each bench is a self-contained
//   measurement package. B10 READS B9 fixture files (arm-b-response.json, reference
//   arm-a .mjs files) but never imports B9 harness modules. This decouples landing:
//   B10 changes cannot regress B9's test suite. (triad plan P1 forbidden touch point)
//
//   SLICE 1 CORPUS
//   corpus-spec.json ships with tasks: []. The smoke run drives the B9 task corpus
//   directly (hard-coded B9 task IDs in SMOKE_TASK_IDS below) to validate the
//   harness end-to-end before any import-heavy tasks exist.
//
//   RESULT ARTIFACT SHAPE (mirrors B9 results-<platform>-<date>.json)
//   Written to tmp/B10-import-replacement/results-<platform>-<date>.json (live)
//   or  bench/B10-import-replacement/test/smoke-fixture-<sha>.json (dry-run smoke).
//   The smoke fixture file is committed so future runs can compare against a known baseline.
//
//   VERDICT POLICY (directional only — per DEC-BENCH-B9-SLICE1-001 pattern)
//   PASS-DIRECTIONAL | WARN-DIRECTIONAL | INCONCLUSIVE | PENDING
//   No KILL conditions in Slice 1 (no pre-data). See classify-arm-b.mjs for logic.
//
// @decision DEC-BENCH-B10-SLICE1-COST-001
// @title Slice 1 cost cap = $25 USD (dry-run default; live only on explicit flag)
// @status accepted
// @rationale
//   Slice 1 uses the B9 corpus as smoke (zero npm surface expected). Live Arm B cost
//   is tiny (6 tasks × N=3 × ~$0.01/rep ≈ $0.18). The $25 cap is a safety rail for
//   re-run scenarios. Enforced via BudgetExceededError before each API call.
//   Dry-run (--dry-run) is the CI default and costs $0.
//   triad plan OD-4 defers a larger cost cap to Slice 2 (DEC-BENCH-B10-SLICE2-COST-001).
//
// Flags:
//   --dry-run           Use B9 fixture responses (no API calls)
//   --no-network        Skip Arm B entirely
//   --tasks <id,...>    Comma-separated task IDs (default: B9 smoke corpus)
//   --output <path>     Override results artifact output path
//   --smoke             Alias for --dry-run (produces smoke-fixture-<sha>.json)
//   --json              Emit final artifact JSON to stdout as well

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BENCH_B10_ROOT = resolve(__dirname, "..");

// ---------------------------------------------------------------------------
// Budget guard
// ---------------------------------------------------------------------------

const COST_CAP_USD = 25;

class BudgetExceededError extends Error {
  constructor(spent, cap) {
    super(`Budget cap exceeded: spent $${spent.toFixed(4)} of $${cap} cap (DEC-BENCH-B10-SLICE1-COST-001)`);
    this.name = "BudgetExceededError";
    this.spent_usd = spent;
    this.cap_usd   = cap;
  }
}

// ---------------------------------------------------------------------------
// Repo root
// ---------------------------------------------------------------------------

function findRepoRoot(startDir) {
  let dir = startDir;
  for (let i = 0; i < 20; i++) {
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
  return resolve(BENCH_B10_ROOT, "..", "..");
}

const REPO_ROOT = process.env.YAKCC_REPO_ROOT ?? findRepoRoot(resolve(BENCH_B10_ROOT, "..", ".."));

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const { values: cliArgs } = parseArgs({
  args: process.argv.slice(2),
  options: {
    "dry-run":    { type: "boolean", default: false },
    "no-network": { type: "boolean", default: false },
    smoke:        { type: "boolean", default: false },
    tasks:        { type: "string" },
    output:       { type: "string" },
    json:         { type: "boolean", default: false },
    audit:        { type: "boolean", default: true },
  },
  strict: false,
  allowPositionals: false,
});

const DRY_RUN    = cliArgs["dry-run"] || cliArgs["smoke"] || false;
const NO_NETWORK = cliArgs["no-network"] || false;
const DO_AUDIT   = cliArgs["audit"] !== false;

// Slice 1 smoke corpus — B9 task IDs
const B9_SMOKE_TASK_IDS = [
  "parse-int-list",
  "parse-coord-pair",
  "csv-row-narrow",
  "kebab-to-camel",
  "digits-to-sum",
  "even-only-filter",
];

// B10 import-heavy corpus (Slice 2+) from corpus-spec.json
function loadB10CorpusTasks() {
  const specPath = join(BENCH_B10_ROOT, "corpus-spec.json");
  if (!existsSync(specPath)) return [];
  try {
    const spec = JSON.parse(readFileSync(specPath, "utf8"));
    return (spec.tasks ?? []).map((t) => t.id ?? t).filter(Boolean);
  } catch (_) {
    return [];
  }
}

const B10_CORPUS_TASK_IDS = loadB10CorpusTasks();

// Effective task list: CLI override > B10 corpus (if non-empty) > B9 smoke
const TASK_IDS = cliArgs["tasks"]
  ? cliArgs["tasks"].split(",").map((t) => t.trim()).filter(Boolean)
  : B10_CORPUS_TASK_IDS.length > 0
    ? B10_CORPUS_TASK_IDS
    : B9_SMOKE_TASK_IDS;

const IS_SMOKE = TASK_IDS.every((t) => B9_SMOKE_TASK_IDS.includes(t));

// ---------------------------------------------------------------------------
// Output path
// ---------------------------------------------------------------------------

const TIMESTAMP   = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const ARTIFACT_DIR = join(REPO_ROOT, "tmp", "B10-import-replacement");

function defaultOutputPath(artifactSha) {
  if (DRY_RUN && IS_SMOKE) {
    // Committed smoke fixture
    return join(BENCH_B10_ROOT, "test", `smoke-fixture-${artifactSha.slice(0, 12)}.json`);
  }
  return join(
    ARTIFACT_DIR,
    `results-${process.platform}-${TIMESTAMP.replace(/T/, "-").slice(0, 10)}.json`
  );
}

// ---------------------------------------------------------------------------
// Lazy-load harness modules (file:// URLs for Windows compat)
// ---------------------------------------------------------------------------

async function loadHarnessModules() {
  const base = pathToFileURL(__dirname).href;
  const [
    { measureTransitiveSurface },
    { measureAxis1 },
    { resolveArmAEmit, TASK_ENTRY_FUNCTIONS },
    { runArmBRep },
    { classifyArmB, summarizeSuite },
  ] = await Promise.all([
    import(new URL("measure-transitive-surface.mjs", base + "/").href),
    import(new URL("measure-axis1.mjs",              base + "/").href),
    import(new URL("arm-a-emit.mjs",                 base + "/").href),
    import(new URL("llm-baseline.mjs",               base + "/").href),
    import(new URL("classify-arm-b.mjs",             base + "/").href),
  ]);
  return { measureTransitiveSurface, measureAxis1, resolveArmAEmit, TASK_ENTRY_FUNCTIONS, runArmBRep, classifyArmB, summarizeSuite };
}

// ---------------------------------------------------------------------------
// Per-task measurement
// ---------------------------------------------------------------------------

async function measureTask(taskId, harness, rollingCostUsd) {
  const { measureTransitiveSurface, measureAxis1, resolveArmAEmit, TASK_ENTRY_FUNCTIONS, runArmBRep, classifyArmB } = harness;

  console.log(`\n[${taskId}] measuring...`);

  // --- Arm A ---
  let armATransitive = null;
  let armAAxis1      = null;
  let armAError      = null;

  try {
    const { emitPath, entryFunction, source } = resolveArmAEmit(taskId, "A-fine");
    console.log(`  Arm A: ${emitPath} (${source})`);

    [armATransitive, armAAxis1] = await Promise.all([
      measureTransitiveSurface({ emitPath, entryName: entryFunction, audit: DO_AUDIT })
        .catch((err) => ({ error: err.message })),
      measureAxis1({ emitPath, entryName: entryFunction })
        .catch((err) => ({ error: err.message })),
    ]);
    if (armATransitive) armATransitive.source = source;
  } catch (err) {
    armAError = err.message;
    console.warn(`  [WARN] Arm A error for ${taskId}: ${err.message}`);
  }

  // --- Arm B (N=3 live, N=1 dry-run) ---
  const nReps     = DRY_RUN ? 1 : 3;
  const armBReps  = [];
  let   armBError = null;

  // Minimal task spec (Slice 1: B9 tasks; Slice 2+ will load from corpus-spec.json)
  const INLINE_SPECS = {
    "parse-int-list":   { signature: "function listOfInts(input: string): readonly number[]",
                          behavior:  "Parse a comma-separated list of integers." },
    "parse-coord-pair": { signature: "function parseCoordPair(input: string): [number, number]",
                          behavior:  "Parse a coordinate pair like '1.5,2.3'." },
    "csv-row-narrow":   { signature: "function parseCsvRowNarrow(input: string): readonly string[]",
                          behavior:  "Parse a single CSV row." },
    "kebab-to-camel":   { signature: "function kebabToCamel(input: string): string",
                          behavior:  "Convert kebab-case to camelCase." },
    "digits-to-sum":    { signature: "function digitsToSum(input: string): number",
                          behavior:  "Sum the digits of a non-negative integer string." },
    "even-only-filter": { signature: "function evenOnlyFilter(input: readonly number[]): readonly number[]",
                          behavior:  "Return only even integers from the array." },
  };
  const taskSpec = INLINE_SPECS[taskId] ?? { signature: `function ${taskId}(input: unknown): unknown`, behavior: taskId };

  if (!NO_NETWORK) {
    const scratchDir = join(ARTIFACT_DIR, "scratch", taskId);
    for (let rep = 0; rep < nReps; rep++) {
      if (rollingCostUsd.value >= COST_CAP_USD) {
        throw new BudgetExceededError(rollingCostUsd.value, COST_CAP_USD);
      }
      try {
        const repResult = await runArmBRep({
          taskId,
          taskSpec,
          dryRun:    DRY_RUN,
          noNetwork: NO_NETWORK,
          outputDir: join(scratchDir, `rep${rep}`),
          rep,
        });
        rollingCostUsd.value += repResult.cost_usd ?? 0;

        // Measure the Arm B emit's transitive surface
        let bTransitive = null;
        if (repResult.emit_path && !repResult.error) {
          bTransitive = await measureTransitiveSurface({
            emitPath:  repResult.emit_path,
            audit:     DO_AUDIT,
          }).catch((err) => ({ error: err.message }));
        } else if (repResult.emit_text) {
          // Write inline text to a temp file and measure it
          mkdirSync(join(scratchDir, `rep${rep}`), { recursive: true });
          const tmpPath = join(scratchDir, `rep${rep}`, "arm-b-inline.mjs");
          writeFileSync(tmpPath, repResult.emit_text, "utf8");
          bTransitive = await measureTransitiveSurface({
            emitPath: tmpPath,
            audit:    DO_AUDIT,
          }).catch((err) => ({ error: err.message }));
        }

        armBReps.push({
          rep,
          source:      repResult.source,
          emit_path:   repResult.emit_path,
          cost_usd:    repResult.cost_usd ?? 0,
          transitive:  bTransitive,
          // Flatten key transitive fields for easier comparison
          reachable_functions: bTransitive?.reachable_functions ?? null,
          reachable_bytes:     bTransitive?.reachable_bytes     ?? null,
          reachable_files:     bTransitive?.reachable_files     ?? null,
          npm_audit:           bTransitive?.npm_audit           ?? null,
          error:               repResult.error ?? bTransitive?.error ?? null,
        });
      } catch (err) {
        if (err instanceof BudgetExceededError) throw err;
        armBError = err.message;
        console.warn(`  [WARN] Arm B rep ${rep} error: ${err.message}`);
        armBReps.push({ rep, error: err.message });
      }
    }
  }

  // --- Classification ---
  const classification = classifyArmB({
    taskId,
    armAResult: armATransitive,
    armBReps,
    dryRun: DRY_RUN,
  });

  const reductionPct = (() => {
    const aFn = armATransitive?.reachable_functions ?? 0;
    const medBFn = classification.arm_b?.median_reachable_functions ?? null;
    if (medBFn === null || medBFn === 0) return null;
    return ((medBFn - aFn) / medBFn * 100).toFixed(1);
  })();

  console.log(
    `  verdict: ${classification.verdict} | ` +
    `A=${armATransitive?.reachable_functions ?? "err"} fns | ` +
    `B=${classification.arm_b?.median_reachable_functions ?? "N/A"} fns | ` +
    (reductionPct !== null ? `reduction=${reductionPct}%` : "inconclusive")
  );

  return {
    task_id: taskId,
    classification,
    arm_a: {
      transitive: armATransitive,
      axis1:      armAAxis1,
      error:      armAError,
    },
    arm_b: {
      reps:  armBReps,
      error: armBError,
    },
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log("=== B10 import-replacement bench (Slice 1) ===");
  console.log(`  tasks:       ${TASK_IDS.join(", ")}`);
  console.log(`  mode:        ${DRY_RUN ? "dry-run" : NO_NETWORK ? "no-network" : "live"}`);
  console.log(`  smoke:       ${IS_SMOKE}`);
  console.log(`  audit:       ${DO_AUDIT}`);
  console.log(`  cost_cap:    $${COST_CAP_USD}`);
  console.log();

  const harness = await loadHarnessModules();
  const rollingCostUsd = { value: 0 };

  const taskResults = [];
  for (const taskId of TASK_IDS) {
    try {
      const result = await measureTask(taskId, harness, rollingCostUsd);
      taskResults.push(result);
    } catch (err) {
      if (err instanceof BudgetExceededError) {
        console.error(`\n[BUDGET] ${err.message}`);
        break;
      }
      console.error(`\n[ERROR] Task ${taskId}: ${err.message}`);
      taskResults.push({ task_id: taskId, error: err.message });
    }
  }

  const suite = harness.summarizeSuite(
    taskResults.map((r) => r.classification ?? { task_id: r.task_id, verdict: "PENDING", reason: r.error ?? "unknown" })
  );

  // Build the artifact
  const artifactBody = {
    schema_version:  "b10-s1-v1",
    measured_at:     new Date().toISOString(),
    platform:        process.platform,
    node_version:    process.version,
    mode:            DRY_RUN ? "dry-run" : NO_NETWORK ? "no-network" : "live",
    smoke_corpus:    IS_SMOKE,
    tasks:           TASK_IDS,
    suite,
    task_results:    taskResults,
    total_cost_usd:  rollingCostUsd.value,
  };

  // Compute sha for smoke output path
  const artifactJson = JSON.stringify(artifactBody, null, 2);
  const artifactSha  = createHash("sha256").update(artifactJson, "utf8").digest("hex");
  artifactBody.artifact_sha256 = artifactSha;

  const finalJson    = JSON.stringify(artifactBody, null, 2);
  const outputPath   = cliArgs["output"] ?? defaultOutputPath(artifactSha);

  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, finalJson, "utf8");

  console.log(`\n=== Suite verdict: ${suite.suite_verdict} ===`);
  console.log(`  tasks: ${suite.tasks_total} | pass: ${suite.tasks_passing} | warn: ${suite.tasks_warning} | inconclusive: ${suite.tasks_inconclusive} | pending: ${suite.tasks_pending}`);
  console.log(`  total_cost_usd: $${rollingCostUsd.value.toFixed(4)}`);
  console.log(`  artifact: ${outputPath}`);
  console.log(`  artifact_sha256: ${artifactSha.slice(0, 16)}...`);

  if (cliArgs["json"]) {
    process.stdout.write(finalJson + "\n");
  }

  // Exit 0 always — unresolvable imports and INCONCLUSIVE verdicts are data, not errors
  process.exit(0);
}

main().catch((err) => {
  console.error("[run.mjs] Fatal:", err.message);
  if (process.env.DEBUG) console.error(err.stack);
  process.exit(1);
});
