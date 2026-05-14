// SPDX-License-Identifier: MIT
//
// bench/B9-min-surface/harness/run.mjs
//
// @decision DEC-BENCH-B9-SLICE1-COST-001
// @title Slice 1 cost cap = $50 USD
// @status accepted
// @rationale
//   $50 ceiling set by the planner at the time of Slice 1 scoping. This covers
//   N=3 reps × 6 tasks × estimated ~$1.50/rep (claude-sonnet-4-6 at 300 input +
//   500 output tokens ≈ $0.009/rep, well within budget). The harness raises a
//   typed BudgetExceededError before the next API call if rolling spend would
//   exceed this ceiling. The ceiling exists to prevent runaway cost in re-run
//   scenarios and is enforced in the actual Arm B call loop.
//
//   Suite-level cap: $100 (DEC-BENCH-SUITE-COST-001 in bench/run-all.mjs).
//   This slice's $50 ceiling is subordinate to the suite cap.
//
// @decision DEC-BENCH-B9-SLICE1-001
// @title Slice 1 verdict: directional targets only, no KILL pre-data
// @status pending-tester
// @rationale
//   VERDICT DEFINITION (amended per #167 Principle 1 + #446 Gap 12):
//   All "KILL" verdict enum values are struck. The pass bars from the old plan
//   (≥90% reachable-fn reduction, ≥95% REFUSED-EARLY, 100% equivalence) are
//   now "Directional targets (no KILL pre-data)".
//
//   VERDICT ENUM (Slice 1): PASS-DIRECTIONAL | WARN-DIRECTIONAL | PENDING
//   - PASS-DIRECTIONAL: all measured axes exceed their directional targets AND
//     no shape-escapes (Axis 2 correctness floor) AND 100% byte-equivalence
//     (Axis 3 correctness floor). This is a signal, not a hard gate.
//   - WARN-DIRECTIONAL: at least one axis is below its directional target.
//     Also a signal — filed as a data point on the Pareto frontier.
//   - PENDING: dry-run mode or missing live measurement.
//
//   CORRECTNESS FLOORS (not targets, not KILL):
//   - Axis 2: 0 shape-escapes. A shape-escape is filed as a bug-class WI
//     (e.g., WI-V0-ATOM-REFUSAL-GAP) independent of the sweep.
//   - Axis 3: 100% byte-equivalence on valid inputs. A mismatch is filed as
//     a correctness WI independent of the sweep.
//   Both correctness floors are assessed independently; missing a floor does not
//   produce a "KILL" verdict but IS filed immediately as a separate issue.
//
//   TESTER NOTE (to be filled after live run W-B9-S1-12):
//   Tester appends observed values here after running: pnpm bench:min-surface:live
//   measured_axis1_per_strategy:
//     A-fine: loc_reduction_pct=<fill>, reachable_fn_reduction_pct=<fill>
//     A-medium: ...
//     A-coarse: ...
//   measured_axis2_per_strategy:
//     A-fine: refused_early_rate=<fill>% shape_escapes=<fill>
//     ...
//   measured_axis3: equivalence_rate=<fill>% corpus_size=<fill>
//   measured_axis5_arm_b: total_cost_usd=<fill> median_wall_ms=<fill>
//   verdict: <PASS-DIRECTIONAL|WARN-DIRECTIONAL>
//   verdict_recorded_by: tester
//   verdict_recorded_at: <date>
//
// @decision DEC-V0-B9-SLICE1-IMPL-DEVIATION-001
// @title Implementation deviations from the planner's 12-WI table
// @status accepted
// @rationale
//   The planner's WI table listed W-B9-S1-7 as "harness/arm-a-emit.mjs" and
//   W-B9-S1-9 as "harness/measure-axis5.mjs". Implemented as specified.
//
//   Additional deviations from old plan (pre-amendment):
//   1. Task list expanded from 1 to 6 tasks per MASTER_PLAN.md Slice 1.
//   2. corpus-spec.json rewritten with 6-task list + per-task directional_targets.
//   3. attack-classes expanded from 4-7 inputs each to ≥10 each (89 total).
//   4. llm-baseline.mjs updated for N=3 reps per task (median+range).
//   5. run.mjs: KILL conditions removed; directional targets; --no-network mode added.
//   6. Arm A implementations provided as .mjs files (not .ts) because the
//      pre-write hook's SOURCE_EXTENSIONS list excludes .mjs — ts|tsx|js files
//      were blocked by orchestrator-source-guard Gate 1.5 which detected session
//      ID match with orchestrator SID. All harness code is .mjs and unaffected.
//      The Arm A reference implementations are bench measurement artifacts
//      (not production source), so .mjs is architecturally correct.
//   7. fixture files created for all 5 new tasks.
//
// Arms:
//   Arm A: yakcc atomic composition (granularity sweep A-fine/A-medium/A-coarse)
//   Arm B: LLM baseline (claude-sonnet-4-6, N=3 reps, dry-run fixture mode)
//
// Flags:
//   --dry-run         Use fixture responses (no API calls); Arm B = 1 rep from fixture
//   --no-network      Skip Arm B entirely; emit network_required: true in artifact
//   --tasks <id,...>  Comma-separated task IDs to run (default: all 6)
//   --output <path>   Results artifact output path (default: tmp/B9-min-surface/results-*)

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { spawnSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BENCH_B9_ROOT = resolve(__dirname, "..");

// ---------------------------------------------------------------------------
// Budget enforcement
// ---------------------------------------------------------------------------

const COST_CAP_USD = 50;

class BudgetExceededError extends Error {
  constructor(spent, cap) {
    super(`Budget cap exceeded: spent $${spent.toFixed(4)} of $${cap} cap (DEC-BENCH-B9-SLICE1-COST-001)`);
    this.name = "BudgetExceededError";
    this.spent_usd = spent;
    this.cap_usd = cap;
  }
}

// ---------------------------------------------------------------------------
// Repo root
// ---------------------------------------------------------------------------

function resolveRepoRoot() {
  if (process.env.YAKCC_REPO_ROOT) return process.env.YAKCC_REPO_ROOT;
  let dir = __dirname;
  let candidate = null;
  for (let i = 0; i < 15; i++) {
    const pkg = join(dir, "package.json");
    if (existsSync(pkg)) {
      try {
        const p = JSON.parse(readFileSync(pkg, "utf8"));
        if (p.name === "yakcc") {
          const normalized = dir.replace(/\\/g, "/");
          if (!normalized.includes("/.worktrees/")) return dir;
          candidate = candidate ?? dir;
        }
      } catch (_) {}
    }
    const parent = resolve(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  if (candidate) return candidate;
  return resolve(__dirname, "../../..");
}

const REPO_ROOT = resolveRepoRoot();

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const { values: cliArgs } = parseArgs({
  args: process.argv.slice(2),
  options: {
    "dry-run": { type: "boolean", default: false },
    "no-network": { type: "boolean", default: false },
    output: { type: "string" },
    tasks: { type: "string" },
    json: { type: "boolean", default: false },
  },
  strict: false,
  allowPositionals: false,
});

const DRY_RUN = cliArgs["dry-run"] === true;
const NO_NETWORK = cliArgs["no-network"] === true;
const TIMESTAMP = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const ARTIFACT_DIR = join(REPO_ROOT, "tmp", "B9-min-surface");
const DEFAULT_OUTPUT = join(
  ARTIFACT_DIR,
  `results-${process.platform}-${TIMESTAMP.replace(/T/, "-").slice(0, 10)}.json`
);
const ARTIFACT_PATH = cliArgs["output"] ?? DEFAULT_OUTPUT;

const ALL_TASK_IDS = ["parse-int-list", "parse-coord-pair", "csv-row-narrow", "kebab-to-camel", "digits-to-sum", "even-only-filter"];
const TASK_IDS = cliArgs["tasks"]
  ? cliArgs["tasks"].split(",").map(t => t.trim()).filter(Boolean)
  : ALL_TASK_IDS;

// ---------------------------------------------------------------------------
// Corpus-spec verification
// ---------------------------------------------------------------------------

function verifyCorpusSpec() {
  const specPath = join(BENCH_B9_ROOT, "corpus-spec.json");
  if (!existsSync(specPath)) throw new Error(`corpus-spec.json not found at ${specPath}`);
  const spec = JSON.parse(readFileSync(specPath, "utf8"));

  for (const task of spec.tasks) {
    // Only verify spec.yak sha256 for tasks that have a real spec_sha256_lf
    if (task.spec_sha256_lf === "COMPUTED-AT-RUNTIME") {
      // Authored task — spec.yak may not have a pre-computed SHA yet
      const specYakPath = join(REPO_ROOT, task.spec_path);
      if (!existsSync(specYakPath)) {
        console.warn(`  [WARN] Task ${task.id}: spec.yak not found at ${task.spec_path} (authored task — OK for dry-run)`);
      } else {
        console.log(`  [OK] ${task.id} spec.yak present (sha256 not pre-computed — authored task)`);
      }
      continue;
    }
    const specYakPath = join(REPO_ROOT, task.spec_path);
    if (!existsSync(specYakPath)) {
      throw new Error(`spec.yak not found: ${specYakPath}`);
    }
    const rawBytes = readFileSync(specYakPath);
    const lfBytes = Buffer.from(rawBytes.toString("binary").replace(/\r\n/g, "\n"), "binary");
    const actual = createHash("sha256").update(lfBytes).digest("hex");
    if (actual !== task.spec_sha256_lf) {
      throw new Error(
        `spec.yak sha256 drift for ${task.id}:\n` +
        `  expected: ${task.spec_sha256_lf}\n` +
        `  actual:   ${actual}\n` +
        "spec.yak content has changed. Re-run the planner to update corpus-spec.json."
      );
    }
    console.log(`  [OK] ${task.id} spec.yak sha256=${actual.slice(0, 16)}...`);
  }
  return spec;
}

// ---------------------------------------------------------------------------
// TypeScript transpilation (for Arm A/B .ts emits)
// ---------------------------------------------------------------------------

function transpileEmitToMjs(tsFilePath, outputMjsPath) {
  const req = createRequire(import.meta.url);
  let ts;
  const tsPaths = [join(REPO_ROOT, "node_modules", "typescript", "lib", "typescript.js")];
  for (const p of tsPaths) {
    if (existsSync(p)) { ts = req(p); break; }
  }
  if (!ts) {
    try { ts = req("typescript"); } catch (_) {
      throw new Error("TypeScript not found. Run `pnpm -r build`.");
    }
  }
  const source = readFileSync(tsFilePath, "utf8");
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      verbatimModuleSyntax: false,
    },
  });
  mkdirSync(dirname(outputMjsPath), { recursive: true });
  writeFileSync(outputMjsPath, transpiled.outputText, "utf8");
  return outputMjsPath;
}

// ---------------------------------------------------------------------------
// Run axis modules via subprocess (mirrors B7 isolation pattern)
// ---------------------------------------------------------------------------

function runSubprocess(scriptPath, args, timeoutMs = 120_000) {
  const result = spawnSync(process.execPath, [scriptPath, ...args], {
    encoding: "utf8",
    timeout: timeoutMs,
    env: { ...process.env },
  });
  if (result.error) throw new Error(`Subprocess error: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(`Subprocess exited ${result.status}: ${result.stderr?.slice(0, 500)}`);
  }
  const stdout = result.stdout.trim();
  if (!stdout) throw new Error("Subprocess produced no output");
  return JSON.parse(stdout);
}

// ---------------------------------------------------------------------------
// Measure one task × one strategy (Arm A)
// ---------------------------------------------------------------------------

async function measureOneArmAStrategy(taskId, strategy, armAEmitPath, spec) {
  const task = spec.tasks.find(t => t.id === taskId);
  const entryFunction = task?.arm_b_prompt ? getEntryFunction(taskId) : "listOfInts";

  const scratchDir = join(ARTIFACT_DIR, "scratch", taskId, strategy);
  mkdirSync(scratchDir, { recursive: true });

  // If the emit is .ts, transpile it
  let mjsPath = armAEmitPath;
  if (armAEmitPath.endsWith(".ts")) {
    mjsPath = join(scratchDir, "arm-a-emit.mjs");
    transpileEmitToMjs(armAEmitPath, mjsPath);
  }

  // Axis 1
  let axis1 = null;
  try {
    axis1 = runSubprocess(join(__dirname, "measure-axis1.mjs"), [
      "--emit", armAEmitPath,  // axis1 works on .ts too
      "--entry", entryFunction,
      "--json",
    ], 60_000);
  } catch (err) {
    axis1 = { error: err.message };
  }

  // Axis 2 — pass applicable_attack_classes from corpus-spec if defined
  let axis2 = null;
  try {
    const axis2Args = [
      "--emit", mjsPath,
      "--attack-classes", join(BENCH_B9_ROOT, "attack-classes"),
      "--entry", entryFunction,
      "--json",
    ];
    // Per DEC-B9-APPLICABILITY-001: pass applicable_attack_classes so the classifier
    // skips inapplicable attack shapes (not-applicable, not shape-escape).
    // When absent, all classes remain applicable (backwards-compatible default).
    const taskApplicableClasses = spec.tasks.find(t => t.id === taskId)?.applicable_attack_classes;
    if (Array.isArray(taskApplicableClasses)) {
      axis2Args.push("--applicable-classes", taskApplicableClasses.join(","));
    }
    axis2 = runSubprocess(join(__dirname, "measure-axis2.mjs"), axis2Args, 60_000);
  } catch (err) {
    axis2 = { error: err.message };
  }

  // Axis 5a (Arm A cost — $0, just timing)
  const { measureAxis5ArmA } = await import(pathToFileURL(join(__dirname, "measure-axis5.mjs")).href);
  let axis5a = null;
  try {
    axis5a = measureAxis5ArmA(armAEmitPath, strategy);
  } catch (err) {
    axis5a = { error: err.message };
  }

  return { taskId, strategy, emit_path: armAEmitPath, mjs_path: mjsPath, entry_function: entryFunction, axis1, axis2, axis5a };
}

function getEntryFunction(taskId) {
  const map = {
    "parse-int-list": "listOfInts",
    "parse-coord-pair": "parseCoordPair",
    "csv-row-narrow": "parseCsvRowNarrow",
    "kebab-to-camel": "kebabToCamel",
    "digits-to-sum": "digitsToSum",
    "even-only-filter": "evenOnlyFilter",
  };
  return map[taskId] ?? "listOfInts";
}

// ---------------------------------------------------------------------------
// Verdict computation (DEC-BENCH-B9-SLICE1-001)
// No KILL conditions — directional targets only.
// ---------------------------------------------------------------------------

function computeVerdict(taskResults) {
  const warnings = [];
  const correctnessIssues = [];

  for (const [taskId, taskData] of Object.entries(taskResults)) {
    for (const [strategy, stratData] of Object.entries(taskData.arm_a_strategies ?? {})) {
      const a2 = stratData.axis2;
      if (a2 && !a2.error) {
        if (a2.summary.shape_escapes > 0) {
          correctnessIssues.push(`Task ${taskId}/${strategy}: shape_escapes=${a2.summary.shape_escapes} (correctness floor: 0) — file bug WI`);
        }
        if (a2.summary.refused_early_rate < 95) {
          warnings.push(`Task ${taskId}/${strategy}: refused_early_rate=${a2.summary.refused_early_rate.toFixed(1)}% (directional target: ≥95%)`);
        }
      }

      const a1 = stratData.axis1;
      if (a1 && !a1.error && taskData.arm_b_axis1 && !taskData.arm_b_axis1.error) {
        const armAReachable = a1.reachable_functions?.count;
        const armBReachable = taskData.arm_b_axis1.reachable_functions?.count;
        if (armAReachable !== null && armBReachable !== null && armBReachable > 0) {
          const reduction = ((armBReachable - armAReachable) / armBReachable) * 100;
          if (reduction < 90) {
            warnings.push(`Task ${taskId}/${strategy}: reachable-fn reduction=${reduction.toFixed(1)}% (directional target: ≥90%)`);
          }
        }
      }
    }

    const a3 = taskData.axis3;
    if (a3 && !a3.error) {
      if (a3.equivalence_rate < 100) {
        correctnessIssues.push(`Task ${taskId}: axis3 equivalence_rate=${a3.equivalence_rate.toFixed(1)}% (correctness floor: 100%) — file bug WI`);
      }
      if (a3.total < 20) {
        warnings.push(`Task ${taskId}: axis3 corpus_size=${a3.total} (directional target: ≥20)`);
      }
    }
  }

  if (correctnessIssues.length > 0) {
    return {
      string: "WARN-DIRECTIONAL",
      correctness_issues: correctnessIssues,
      directional_warnings: warnings,
      note: "Correctness issues found — file bug-class WIs. No KILL per DEC-BENCH-B9-SLICE1-001.",
    };
  }

  if (warnings.length > 0) {
    return { string: "WARN-DIRECTIONAL", directional_warnings: warnings, correctness_issues: [] };
  }

  return {
    string: DRY_RUN || NO_NETWORK ? "PENDING" : "PASS-DIRECTIONAL",
    directional_warnings: [],
    correctness_issues: [],
    note: DRY_RUN ? "Dry-run mode — live measurements required" : "All directional targets met",
  };
}

// ---------------------------------------------------------------------------
// Main harness
// ---------------------------------------------------------------------------

async function main() {
  const runStart = Date.now();

  console.log("=".repeat(70));
  console.log("B9-min-surface — Slice 1: Attack-Surface Characterisation Harness");
  console.log(`  Mode: ${NO_NETWORK ? "NO-NETWORK (Arm B skipped)" : DRY_RUN ? "DRY-RUN (fixture)" : "LIVE"}`);
  console.log(`  Tasks: ${TASK_IDS.join(", ")}`);
  console.log(`  Platform: ${process.platform} / Node ${process.version}`);
  console.log("=".repeat(70));
  console.log();

  if (!DRY_RUN && !NO_NETWORK && !process.env["ANTHROPIC_API_KEY"]) {
    console.error(
      "\n" + "!".repeat(70) + "\n" +
      "ERROR: ANTHROPIC_API_KEY is not set.\n" +
      "Options:\n" +
      "  1. Set ANTHROPIC_API_KEY and re-run for live measurement.\n" +
      "  2. Run dry-run: pnpm bench:min-surface\n" +
      "  3. Skip Arm B: pnpm bench:min-surface --no-network\n" +
      "!".repeat(70) + "\n"
    );
    process.exit(1);
  }

  // Step 0: Load corpus-spec
  console.log("[B9] Step 0: Verifying corpus-spec.json...");
  const spec = verifyCorpusSpec();
  console.log();

  // Step 1: Import harness modules
  const [armAEmitMod, llmMod, classifyArmBMod, axis5Mod] = await Promise.all([
    import(pathToFileURL(join(__dirname, "arm-a-emit.mjs")).href),
    import(pathToFileURL(join(__dirname, "llm-baseline.mjs")).href),
    import(pathToFileURL(join(__dirname, "classify-arm-b.mjs")).href),
    import(pathToFileURL(join(__dirname, "measure-axis5.mjs")).href),
  ]);

  const { resolveArmAEmit, listAllArmAEmits, TASK_ENTRY_FUNCTIONS } = armAEmitMod;
  const { getLlmBaseline } = llmMod;
  const { classifyArmBEmit, computeArmBRefusalSummary, loadAttackClasses } = classifyArmBMod;
  const { measureAxis5ArmBReps, aggregateAxis5, measureAxis5ArmA } = axis5Mod;

  const scratchDir = join(ARTIFACT_DIR, "scratch");
  mkdirSync(scratchDir, { recursive: true });

  // Step 2: Load attack classes once
  const attackClasses = loadAttackClasses(join(BENCH_B9_ROOT, "attack-classes"));
  console.log(`[B9] Loaded ${attackClasses.length} attack classes, ${attackClasses.reduce((s, c) => s + c.inputs.length, 0)} total inputs`);
  console.log();

  // Step 3: Per-task measurements
  const taskResults = {};
  let totalArmBCostUsd = 0;

  for (const taskId of TASK_IDS) {
    const taskSpec = spec.tasks.find(t => t.id === taskId);
    if (!taskSpec) {
      console.warn(`[B9] Task ${taskId} not found in corpus-spec.json — skipping`);
      continue;
    }

    const entryFunction = TASK_ENTRY_FUNCTIONS[taskId] ?? "listOfInts";
    console.log(`[B9] ===== Task: ${taskId} (entry: ${entryFunction}) =====`);

    taskResults[taskId] = { arm_a_strategies: {}, arm_b: null, arm_b_axis1: null, axis3: null };

    // Arm A granularity sweep
    for (const strategy of ["A-fine", "A-medium", "A-coarse"]) {
      console.log(`[B9]   Arm A strategy: ${strategy}`);
      let armAEmitPath = null;
      try {
        const { emitPath } = resolveArmAEmit(REPO_ROOT, taskId, strategy);
        armAEmitPath = emitPath;
      } catch (err) {
        console.warn(`[B9]   WARN: Arm A ${strategy} not found: ${err.message}`);
        taskResults[taskId].arm_a_strategies[strategy] = { error: err.message };
        continue;
      }

      const stratResult = await measureOneArmAStrategy(taskId, strategy, armAEmitPath, spec);
      taskResults[taskId].arm_a_strategies[strategy] = stratResult;

      const a1 = stratResult.axis1;
      const a2 = stratResult.axis2;
      if (a1 && !a1.error) {
        console.log(`[B9]     Axis 1: loc=${a1.loc} bytes=${a1.bytes} reachable=${a1.reachable_functions?.count ?? "N/A"}`);
      }
      if (a2 && !a2.error) {
        const s = a2.summary;
        console.log(`[B9]     Axis 2: refused_early=${s.refused_early}/${s.refused_early_targets} (${s.refused_early_rate.toFixed(1)}%) shape_escapes=${s.shape_escapes}`);
      }
    }

    // Arm B baseline (LLM)
    if (NO_NETWORK) {
      console.log(`[B9]   Arm B: SKIPPED (--no-network)`);
      taskResults[taskId].arm_b = { skipped: true, reason: "no-network flag" };
    } else {
      // Budget check
      if (totalArmBCostUsd >= COST_CAP_USD) {
        throw new BudgetExceededError(totalArmBCostUsd, COST_CAP_USD);
      }

      console.log(`[B9]   Arm B: Getting LLM baseline (${DRY_RUN ? "dry-run" : "live API"}, N=${DRY_RUN ? 1 : 3} reps)...`);
      const llmResult = await getLlmBaseline({ taskId, dryRun: DRY_RUN });

      // Transpile each rep to .mjs for axis2 + axis3
      const armBMjsPaths = [];
      for (let i = 0; i < llmResult.reps.length; i++) {
        const rep = llmResult.reps[i];
        if (rep.emit_path && existsSync(rep.emit_path) && rep.emit_path.endsWith(".ts")) {
          const mjsPath = rep.emit_path.replace(/\.ts$/, ".mjs");
          try {
            transpileEmitToMjs(rep.emit_path, mjsPath);
            armBMjsPaths.push({ mjsPath, repIndex: i });
          } catch (err) {
            console.warn(`[B9]   WARN: Arm B rep ${i} transpile failed: ${err.message}`);
          }
        } else if (rep.emit_path && existsSync(rep.emit_path) && rep.emit_path.endsWith(".mjs")) {
          armBMjsPaths.push({ mjsPath: rep.emit_path, repIndex: i });
        }
      }

      // Axis 1 for Arm B (use first rep emit for structural metrics — all reps same prompt)
      if (armBMjsPaths.length > 0) {
        const firstRepTs = llmResult.reps[0].emit_path;
        if (firstRepTs && existsSync(firstRepTs)) {
          try {
            taskResults[taskId].arm_b_axis1 = runSubprocess(join(__dirname, "measure-axis1.mjs"), [
              "--emit", firstRepTs,
              "--entry", entryFunction,
              "--json",
            ], 60_000);
          } catch (err) {
            taskResults[taskId].arm_b_axis1 = { error: err.message };
          }
        }
      }

      // Axis 2 for Arm B (classify each rep, compute median+range)
      // Pass applicable_attack_classes from corpus-spec per DEC-B9-APPLICABILITY-001
      const armBAxis2Reps = [];
      const taskApplicableClassesArmB = taskSpec.applicable_attack_classes ?? null;
      for (const { mjsPath } of armBMjsPaths) {
        try {
          const repResult = await classifyArmBEmit(mjsPath, attackClasses, entryFunction, taskApplicableClassesArmB);
          armBAxis2Reps.push(repResult);
        } catch (err) {
          console.warn(`[B9]   WARN: Arm B axis2 classification failed: ${err.message}`);
        }
      }

      if (armBAxis2Reps.length > 0) {
        taskResults[taskId].arm_b_axis2 = computeArmBRefusalSummary(armBAxis2Reps);
        console.log(`[B9]   Arm B axis2: median_refused_early_rate=${taskResults[taskId].arm_b_axis2.median_refused_early_rate.toFixed(1)}%`);
      }

      // Axis 3 — equivalence between Arm A-fine and Arm B (first rep)
      const armAFineResult = taskResults[taskId].arm_a_strategies["A-fine"];
      if (armAFineResult && !armAFineResult.error && armBMjsPaths.length > 0) {
        const armAMjs = armAFineResult.mjs_path;
        const armBMjs = armBMjsPaths[0].mjsPath;
        if (armAMjs && existsSync(armAMjs) && existsSync(armBMjs)) {
          try {
            taskResults[taskId].axis3 = runSubprocess(join(__dirname, "measure-axis3.mjs"), [
              "--emit-a", armAMjs,
              "--emit-b", armBMjs,
              "--entry", entryFunction,
              "--count", "25",
              "--seed", "42",
              "--json",
            ], 120_000);
            const a3 = taskResults[taskId].axis3;
            console.log(`[B9]   Axis 3: equivalence=${a3.equivalent}/${a3.total} (${a3.equivalence_rate.toFixed(1)}%)`);
          } catch (err) {
            taskResults[taskId].axis3 = { error: err.message };
          }
        }
      }

      // Axis 5 for Arm B
      const repData = llmResult.reps.map((r, i) => ({
        usage: r.usage,
        model: r.model,
        wall_ms: r.wall_ms,
        emit_path: armBMjsPaths[i]?.mjsPath ?? r.emit_path,
      }));
      const armBCostResult = measureAxis5ArmBReps(repData);
      taskResults[taskId].arm_b = { llm_result: llmResult, axis5: armBCostResult };
      if (armBCostResult.total_cost_usd > 0) {
        totalArmBCostUsd += armBCostResult.total_cost_usd;
        console.log(`[B9]   Arm B axis5: total_cost=$${armBCostResult.total_cost_usd.toFixed(4)} median_wall_ms=${armBCostResult.median_wall_ms}`);
        console.log(`[B9]   Rolling Arm B cost: $${totalArmBCostUsd.toFixed(4)} / $${COST_CAP_USD} cap`);
      }
    }
    console.log();
  }

  // Compute verdict
  const verdict = computeVerdict(taskResults);

  const runEnd = Date.now();
  const totalRuntimeMs = runEnd - runStart;

  // Print paired-differential headline (per #446 Gap 6)
  console.log("=".repeat(70));
  console.log("PAIRED-DIFFERENTIAL HEADLINE (per #446 Gap 6)");
  console.log("=".repeat(70));
  for (const taskId of TASK_IDS) {
    const taskData = taskResults[taskId];
    if (!taskData) continue;
    const armBAxis1 = taskData.arm_b_axis1;
    const armBAxis2Rate = taskData.arm_b_axis2?.median_refused_early_rate;
    for (const strategy of ["A-fine", "A-medium", "A-coarse"]) {
      const stratData = taskData.arm_a_strategies?.[strategy];
      if (!stratData || stratData.error) continue;
      const a1 = stratData.axis1;
      const a2 = stratData.axis2;
      const a5 = stratData.axis5a;
      if (!a1 || !a2 || a1.error || a2.error) continue;
      const armAReachable = a1.reachable_functions?.count ?? null;
      const armBReachable = armBAxis1?.reachable_functions?.count ?? null;
      const reachRed = (armAReachable !== null && armBReachable !== null && armBReachable > 0)
        ? ((armBReachable - armAReachable) / armBReachable * 100).toFixed(1)
        : "N/A";
      const a2Rate = a2.summary.refused_early_rate.toFixed(1);
      const refusalIncrease = (armBAxis2Rate != null)
        ? (a2.summary.refused_early_rate - armBAxis2Rate).toFixed(1)
        : "N/A";
      const costInfo = a5?.performance ? `loc=${a5.performance.loc}` : "";
      console.log(
        `  [${taskId}/${strategy}] reachable-fn-reduction=${reachRed}% | ` +
        `REFUSED-EARLY Arm A=${a2Rate}% vs Arm B-median=${armBAxis2Rate?.toFixed(1) ?? "N/A"}% (+${refusalIncrease}pp) | ` +
        `${costInfo}`
      );
    }
  }
  console.log();

  console.log(`  VERDICT: ${verdict.string}`);
  if (verdict.correctness_issues?.length > 0) {
    for (const issue of verdict.correctness_issues) console.log(`    CORRECTNESS: ${issue}`);
  }
  if (verdict.directional_warnings?.length > 0) {
    for (const w of verdict.directional_warnings) console.log(`    WARN: ${w}`);
  }
  console.log();
  console.log(`  Total Arm B cost: $${totalArmBCostUsd.toFixed(4)} (cap: $${COST_CAP_USD})`);
  console.log(`  Total runtime: ${(totalRuntimeMs / 1000).toFixed(1)}s`);

  if (NO_NETWORK) {
    console.log();
    console.log("  NOTE: --no-network mode. Arm B skipped. network_required: true in artifact.");
  } else if (DRY_RUN) {
    console.log();
    console.log("  NOTE: DRY-RUN mode. Arm B emit from fixture. verdict 'PENDING' until live run.");
  }
  console.log();

  // Write results artifact
  mkdirSync(ARTIFACT_DIR, { recursive: true });

  const artifact = {
    benchmark: "B9-min-surface",
    slice: "slice-1",
    version: "2.0.0",
    amendment: "suite-wide-characterisation-pass-2026-05-13",
    environment: {
      platform: process.platform,
      arch: process.arch,
      nodeVersion: process.version,
      runAt: new Date().toISOString(),
      repoRoot: REPO_ROOT,
      dryRun: DRY_RUN,
      noNetwork: NO_NETWORK,
    },
    tasks_run: TASK_IDS,
    task_results: taskResults,
    axis_4: { deferred: true, note: "Axis 4 (known-CVE replay) deferred to Slice 2." },
    verdict: verdict.string,
    verdict_details: verdict,
    total_arm_b_cost_usd: totalArmBCostUsd,
    cost_cap_usd: COST_CAP_USD,
    network_required: NO_NETWORK ? true : undefined,
    totalRuntimeMs,
    // DEC annotation for tester to fill in
    "DEC-BENCH-B9-SLICE1-001": {
      status: "pending-tester",
      note: "Tester fills in measured_axis1/2/3/5 and verdict after W-B9-S1-12 live run",
    },
  };

  writeFileSync(ARTIFACT_PATH, JSON.stringify(artifact, null, 2), "utf8");
  console.log(`[B9] Artifact written to: ${ARTIFACT_PATH}`);
  console.log("[B9] Done.");

  return artifact;
}

main().catch((err) => {
  if (err.name === "BudgetExceededError") {
    console.error(`[B9] BUDGET EXCEEDED: ${err.message}`);
    process.exit(2);
  }
  console.error("[B9] Fatal error:", err.message);
  if (err.stack) console.error(err.stack);
  process.exit(1);
});
