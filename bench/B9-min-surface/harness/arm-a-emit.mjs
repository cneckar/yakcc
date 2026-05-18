// SPDX-License-Identifier: MIT
//
// bench/B9-min-surface/harness/arm-a-emit.mjs
//
// @decision DEC-V0-MIN-SURFACE-004
// @title Arm A granularity sweep -- three strategies per task
// @status accepted
// @rationale
//   GRANULARITY SWEEP DEFINITION (per #446 Gap 3 + MASTER_PLAN.md Slice 1)
//   Arm A is not a single point but a sweep over three decomposition strategies:
//
//   A-fine: maximally atomic -- deepest decomposition the registry/bench permits.
//     Each atom handles exactly one structural concern (one ASCII check, one delimiter
//     assertion, one digit parser, etc.). Maximises the number of distinct atoms so
//     the Axis 1 reachable-function count is minimised per-call and Axis 2 shape
//     refusal fires at the shallowest atom.
//     Location: bench/B9-min-surface/tasks/<task>/arm-a/fine.mjs
//
//   A-medium: composite blocks -- atoms grouped at natural task-component boundaries
//     (e.g., "validate prefix" = ASCII check + opening delimiter check). Represents
//     the natural mid-point between maximum atomization and a monolithic function.
//     Location: bench/B9-min-surface/tasks/<task>/arm-a/medium.mjs
//
//   A-coarse: single broad block per task -- minimal decomposition, one function
//     handles the entire spec. Structurally closer to an LLM emit. Used to measure
//     how much of the attack-surface reduction comes from the block boundary rather
//     than from deep atomization.
//     Location: bench/B9-min-surface/tasks/<task>/arm-a/coarse.mjs
//
//   PARETO FRONTIER OUTPUT
//   For each task, the sweep produces three measurement points:
//   (Axis 1 reachable-fn count, Axis 2 refusal rate) vs (Axis 5 cost + wall time).
//   The result is a per-task Pareto frontier over granularity strategies.
//   Fine is expected to dominate on Axis 1+2; coarse on Axis 5.
//
//   TASK 1 (parse-int-list) SPECIAL HANDLING:
//   The A-fine reference is the yakcc compile pipeline output (examples/parse-int-list/dist/module.ts).
//   If that compiled emit is present, it is used as the gold standard A-fine.
//   The bench/B9-min-surface/tasks/parse-int-list/arm-a/fine.mjs is a fallback reference.
//
//   REJECTED ALTERNATIVES:
//   - Single A-fine only: doesn't produce the frontier -- the cost/surface trade-off
//     is the primary research question for B9.
//   - Continuous granularity (N > 3 strategies): diminishing returns; 3 strategies
//     span the design space (fine/medium/coarse) at tractable measurement cost.
//
//   Cross-references:
//   DEC-V0-MIN-SURFACE-001 (REFUSED-EARLY) -- harness/measure-axis2.mjs
//   DEC-V0-MIN-SURFACE-002 (reachability) -- harness/measure-axis1.mjs
//   DEC-V0-MIN-SURFACE-004 (this annotation) -- harness/arm-a-emit.mjs
//   DEC-V0-MIN-SURFACE-005 (Arm B classifier) -- harness/classify-arm-b.mjs
//   DEC-BENCH-B9-SLICE1-COST-001 (cost cap) -- harness/run.mjs
//
// Usage:
//   node bench/B9-min-surface/harness/arm-a-emit.mjs --task <taskId> --strategy <fine|medium|coarse>
//   Output: JSON { task_id, strategy, emit_path, entry_function }
//
// Or import as a module:
//   import { resolveArmAEmit, ARM_A_STRATEGIES } from './arm-a-emit.mjs';

import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BENCH_B9_ROOT = resolve(__dirname, "..");

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const ARM_A_STRATEGIES = ["A-fine", "A-medium", "A-coarse"];

/** @type {Record<string, string>} strategy label -> directory name */
const STRATEGY_DIR = {
  "A-fine": "fine",
  "A-medium": "medium",
  "A-coarse": "coarse",
};

/** @type {Record<string, string>} taskId -> entry function name */
export const TASK_ENTRY_FUNCTIONS = {
  "parse-int-list": "listOfInts",
  "parse-coord-pair": "parseCoordPair",
  "csv-row-narrow": "parseCsvRowNarrow",
  "kebab-to-camel": "kebabToCamel",
  "digits-to-sum": "digitsToSum",
  "even-only-filter": "evenOnlyFilter",
};

// ---------------------------------------------------------------------------
// @decision DEC-B9-EMIT-FRESHNESS-GUARD-001
// @title Compare mtime of compiled gold-standard vs bench fallback; fall back when stale.
// @status accepted
// @rationale
//   PROBLEM: resolveArmAEmit() previously preferred examples/parse-int-list/dist/module.mjs
//   unconditionally whenever it existed. Because the dist file has no freshness contract
//   relative to the bench fallback, a stale dist file (mtime older than bench fallback) can
//   silently route B9 axis2 through the wrong implementation -- producing false-positive or
//   false-negative results. This was the root cause of the 2026-05-18 B9 axis2 false-positive
//   captured in issue #692 (dist mtime Apr 29 2026, bench fallback mtime post-#636 May 17 2026).
//
//   THREE CANDIDATES CONSIDERED:
//   (A) Silent fallback + stderr warning (ACCEPTED): When dist mtime < bench fallback mtime,
//       return bench fallback path and print a greppable WARN to stderr. The source enum
//       value "bench-reference-stale-fallback" signals the fallback in JSON output.
//       Override: --force-gold-standard (CLI) / { forceGoldStandard: true } (module API).
//   (B) Throw StaleEmitError unless --force-gold-standard set: Rejected -- breaks run.mjs
//       sweep iteration (per-task try/catch turns into "skip task" rather than "use bench
//       fallback", producing incomplete sweeps without addressing the root cause).
//   (C) Content-hash allowlist: Rejected -- adds maintenance surface (known-good-shas.json)
//       without a corresponding gain; SHA mismatch is a strict subset of mtime drift.
//
//   ACCEPTED RATIONALE:
//   - Bench runs always produce a working measurement against the freshest reference.
//   - The stderr WARN is loud and greppable for any honest operator.
//   - The "bench-reference-stale-fallback" source enum value in JSON output enables
//     post-hoc detection from results-*.json inspection.
//   - The opt-in { forceGoldStandard: true } preserves deliberate stale-artifact
//     measurement (e.g. pre/post-#636 comparison runs).
//   - Guard is disabled via override, not removed -- dist is still preferred when fresh.
//
//   Cross-reference: DEC-V0-MIN-SURFACE-004 (Arm A granularity sweep -- parent decision)
//   Issue: #698  |  Companion: #697 (regenerate the stale dist artifact)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Resolve Arm A emit path for a given (task, strategy)
// ---------------------------------------------------------------------------

/**
 * Resolve the .mjs path for the Arm A granularity sweep at the given strategy.
 *
 * For parse-int-list A-fine, if the yakcc compile output is present
 * (examples/parse-int-list/dist/module.mjs) AND its mtime is >= the bench
 * fallback mtime, it is used as the gold standard. When the dist file is older
 * than the bench fallback (stale artifact) a stderr warning is emitted and the
 * bench fallback is returned instead. Pass { forceGoldStandard: true } to
 * bypass the freshness guard and always prefer the dist file when present.
 *
 * @param {string} repoRoot
 * @param {string} taskId
 * @param {"A-fine"|"A-medium"|"A-coarse"} strategy
 * @param {{ forceGoldStandard?: boolean }} [options={}]
 * @returns {{ emitPath: string, source: "yakcc-compile"|"bench-reference"|"bench-reference-stale-fallback" }}
 */
export function resolveArmAEmit(repoRoot, taskId, strategy, options = {}) {
  const strategyDir = STRATEGY_DIR[strategy];
  if (!strategyDir) {
    throw new Error(`Unknown strategy: ${strategy}. Valid values: ${ARM_A_STRATEGIES.join(", ")}`);
  }

  // For parse-int-list A-fine: prefer yakcc compile output if it exists and is fresh
  if (taskId === "parse-int-list" && strategy === "A-fine") {
    // Check for pre-transpiled .mjs from the compile pipeline
    const compiledMjs = join(repoRoot, "examples", "parse-int-list", "dist", "module.mjs");
    if (existsSync(compiledMjs)) {
      // DEC-B9-EMIT-FRESHNESS-GUARD-001: Freshness guard
      // When forceGoldStandard is set, bypass the mtime check and prefer dist unconditionally.
      const forceGoldStandard = options.forceGoldStandard === true;
      if (forceGoldStandard) {
        return { emitPath: compiledMjs, source: "yakcc-compile" };
      }

      // Compute bench fallback path for mtime comparison
      const benchPath = join(BENCH_B9_ROOT, "tasks", taskId, "arm-a", `${strategyDir}.mjs`);

      if (existsSync(benchPath)) {
        const compiledStat = statSync(compiledMjs);
        const benchStat = statSync(benchPath);

        if (compiledStat.mtimeMs < benchStat.mtimeMs) {
          // Dist file is older than bench fallback -- staleness guard fires.
          // Emit a greppable stderr warning and fall back to bench reference.
          const compiledMtimeIso = new Date(compiledStat.mtimeMs).toISOString();
          const benchMtimeIso = new Date(benchStat.mtimeMs).toISOString();
          process.stderr.write(
            `[arm-a-emit] WARN: yakcc-compile artifact at ${compiledMjs} mtime=${compiledMtimeIso} ` +
            `is older than bench fallback at ${benchPath} mtime=${benchMtimeIso}; ` +
            `falling back to bench reference. Pass --force-gold-standard or ` +
            `{forceGoldStandard:true} to override.\n`
          );
          return { emitPath: benchPath, source: "bench-reference-stale-fallback" };
        }
      }

      // Dist is fresh (mtime >= bench fallback) or bench fallback does not exist
      return { emitPath: compiledMjs, source: "yakcc-compile" };
    }
    // Note: module.ts would need transpilation; that's handled by the run.mjs orchestrator
    // If neither exists, fall through to bench reference
  }

  // Bench reference implementation
  const benchPath = join(BENCH_B9_ROOT, "tasks", taskId, "arm-a", `${strategyDir}.mjs`);
  if (!existsSync(benchPath)) {
    throw new Error(
      `Arm A reference not found for task '${taskId}' strategy '${strategy}': ${benchPath}\n` +
      `Expected file at: bench/B9-min-surface/tasks/${taskId}/arm-a/${strategyDir}.mjs`
    );
  }

  return { emitPath: benchPath, source: "bench-reference" };
}

// ---------------------------------------------------------------------------
// List all (task, strategy) emit paths
// ---------------------------------------------------------------------------

/**
 * Returns all Arm A (task, strategy) emit descriptors for the full granularity sweep.
 *
 * @param {string} repoRoot
 * @param {string[]} taskIds
 * @param {{ forceGoldStandard?: boolean }} [options={}]
 * @returns {Array<{ taskId, strategy, emitPath, entryFunction, source }>}
 */
export function listAllArmAEmits(repoRoot, taskIds, options = {}) {
  const emits = [];
  for (const taskId of taskIds) {
    const entryFunction = TASK_ENTRY_FUNCTIONS[taskId];
    if (!entryFunction) {
      throw new Error(`Unknown task ID: ${taskId}. Known tasks: ${Object.keys(TASK_ENTRY_FUNCTIONS).join(", ")}`);
    }
    for (const strategy of ARM_A_STRATEGIES) {
      try {
        const { emitPath, source } = resolveArmAEmit(repoRoot, taskId, strategy, options);
        emits.push({ taskId, strategy, emitPath, entryFunction, source });
      } catch (err) {
        // Report missing emits but don't abort listing
        emits.push({ taskId, strategy, emitPath: null, entryFunction, source: null, error: err.message });
      }
    }
  }
  return emits;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const { values: cliArgs } = parseArgs({
  args: process.argv.slice(2),
  options: {
    task: { type: "string" },
    strategy: { type: "string" },
    list: { type: "boolean", default: false },
    "repo-root": { type: "string" },
    json: { type: "boolean", default: false },
    "force-gold-standard": { type: "boolean", default: false },
  },
  strict: false,
  allowPositionals: false,
});

const isMain = process.argv[1] &&
  (resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url)) ||
   process.argv[1].endsWith("arm-a-emit.mjs"));

if (isMain) {
  // Wrap in async IIFE for top-level await support in Node < 22 --input-type=module
  (async () => {
    // Resolve repo root: walk up from bench/B9-min-surface to find yakcc workspace root
    function findRepoRoot(startDir) {
      let dir = startDir;
      while (true) {
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
      return startDir; // fallback
    }

    const REPO_ROOT = cliArgs["repo-root"] ?? findRepoRoot(resolve(BENCH_B9_ROOT, "..", ".."));
    const resolveOptions = { forceGoldStandard: cliArgs["force-gold-standard"] };

    if (cliArgs["list"]) {
      const taskIds = Object.keys(TASK_ENTRY_FUNCTIONS);
      const emits = listAllArmAEmits(REPO_ROOT, taskIds, resolveOptions);
      if (cliArgs["json"]) {
        process.stdout.write(JSON.stringify(emits, null, 2) + "\n");
      } else {
        for (const e of emits) {
          const status = e.error ? "MISSING" : "OK";
          console.log(`  [${status}] ${e.taskId}/${e.strategy} -> ${e.emitPath ?? e.error}`);
        }
      }
    } else if (cliArgs["task"] && cliArgs["strategy"]) {
      try {
        const { emitPath, source } = resolveArmAEmit(REPO_ROOT, cliArgs["task"], cliArgs["strategy"], resolveOptions);
        const entryFunction = TASK_ENTRY_FUNCTIONS[cliArgs["task"]];
        const result = { task_id: cliArgs["task"], strategy: cliArgs["strategy"], emit_path: emitPath, entry_function: entryFunction, source };
        if (cliArgs["json"]) {
          process.stdout.write(JSON.stringify(result, null, 2) + "\n");
        } else {
          console.log(`task: ${result.task_id}`);
          console.log(`strategy: ${result.strategy}`);
          console.log(`emit_path: ${result.emit_path}`);
          console.log(`entry_function: ${result.entry_function}`);
          console.log(`source: ${result.source}`);
        }
      } catch (err) {
        console.error(`[arm-a-emit] Error: ${err.message}`);
        process.exit(1);
      }
    } else {
      console.error("Usage: arm-a-emit.mjs --task <taskId> --strategy <A-fine|A-medium|A-coarse> [--json] [--force-gold-standard]");
      console.error("   or: arm-a-emit.mjs --list [--json] [--force-gold-standard]");
      process.exit(1);
    }
  })();
}