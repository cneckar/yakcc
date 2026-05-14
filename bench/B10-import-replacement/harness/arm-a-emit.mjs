// SPDX-License-Identifier: MIT
//
// bench/B10-import-replacement/harness/arm-a-emit.mjs
//
// @decision DEC-B10-ARM-A-S1-001
// @title Slice 1 Arm A emit resolver — B9 reference fallback; yakcc-compile path TODO for S2
// @status accepted
// @rationale
//   ARM A IN SLICE 1
//   Slice 1 has no import-heavy task corpus (NG1 in the plan). Arm A in Slice 1 therefore
//   falls back to the B9 reference .mjs files, which have ZERO npm imports. This gives a
//   valid, measurable lower bound: "the transitive surface of a yakcc atom composition is 0
//   npm functions." That is precisely the claim B10 is built to prove.
//
//   PLANNED S2 PATH (documented here so Future Implementers wire it without archaeology)
//   When import-heavy tasks exist in tasks/<task>/arm-a/{fine,medium,coarse}.mjs, this
//   resolver will prefer those over the B9 fallback. The `yakcc compile + #508 hook` path
//   (driving the compile pipeline to produce an Arm A emit for an import-heavy task) is
//   a documented TODO branch activated in S2 when #510 atoms are in the registry.
//
//   B9 FALLBACK RATIONALE
//   B9 reference .mjs files are bench measurement artifacts that represent atom-composed
//   implementations of small tasks. Their transitive npm surface is 0 (they import nothing
//   from node_modules). Using them as Slice 1 Arm A is structurally correct:
//   - It keeps Slice 1 shippable without #510 dependency.
//   - It validates the harness measurement path end-to-end on real .mjs files.
//   - It produces a meaningful lower-bound data point (Arm A surface = 0).
//
//   STRATEGY ENUM
//   B10 uses the same A-fine / A-medium / A-coarse granularity sweep as B9 (DEC-V0-MIN-SURFACE-004).
//   In Slice 1, all three strategies resolve to the same B9 reference file since B10 has no
//   task-specific A arm implementations yet. This is documented explicitly, not silently.
//
//   Cross-references:
//   DEC-V0-MIN-SURFACE-004 — bench/B9-min-surface/harness/arm-a-emit.mjs (B9 analog)
//   DEC-B10-S1-LAYOUT-001  — harness/run.mjs (mirror B9 layout)
//   DEC-IRT-B10-METRIC-001 — harness/measure-transitive-surface.mjs (what gets measured)
//   plans/wi-512-b10-import-heavy-bench.md §3b.2 (S1/S2 split rationale)
//
// Usage:
//   node bench/B10-import-replacement/harness/arm-a-emit.mjs \
//     --task <taskId> [--strategy <A-fine|A-medium|A-coarse>] [--json]

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BENCH_B10_ROOT = resolve(__dirname, "..");

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const ARM_A_STRATEGIES = ["A-fine", "A-medium", "A-coarse"];

/** @type {Record<string, string>} taskId -> entry function name */
export const TASK_ENTRY_FUNCTIONS = {
  // B9 tasks (Slice 1 smoke corpus)
  "parse-int-list":    "listOfInts",
  "parse-coord-pair":  "parseCoordPair",
  "csv-row-narrow":    "parseCsvRowNarrow",
  "kebab-to-camel":    "kebabToCamel",
  "digits-to-sum":     "digitsToSum",
  "even-only-filter":  "evenOnlyFilter",
  // B10 import-heavy tasks (Slice 2+, added here when tasks/* gains entries)
};

// ---------------------------------------------------------------------------
// Resolve repo root (walk up to find package.json with name="yakcc")
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
const BENCH_B9_ROOT = join(REPO_ROOT, "bench", "B9-min-surface");

// ---------------------------------------------------------------------------
// Resolve Arm A emit path for a given (task, strategy)
// ---------------------------------------------------------------------------

/**
 * Resolve the .mjs emit path for Arm A at the given (task, strategy).
 *
 * Resolution order:
 * 1. B10 task-specific arm-a/<strategy>.mjs (Slice 2+ — not present in Slice 1)
 * 2. B9 reference .mjs (Slice 1 fallback — zero npm imports, valid lower bound)
 *
 * @param {string} taskId
 * @param {"A-fine"|"A-medium"|"A-coarse"} strategy
 * @returns {{ emitPath: string, entryFunction: string, source: "b10-task"|"b9-reference" }}
 */
export function resolveArmAEmit(taskId, strategy) {
  if (!ARM_A_STRATEGIES.includes(strategy)) {
    throw new Error(`Unknown strategy: ${strategy}. Valid: ${ARM_A_STRATEGIES.join(", ")}`);
  }

  const entryFunction = TASK_ENTRY_FUNCTIONS[taskId];
  if (!entryFunction) {
    throw new Error(
      `Unknown task ID: ${taskId}. Known tasks: ${Object.keys(TASK_ENTRY_FUNCTIONS).join(", ")}`
    );
  }

  const stratDir = strategy.toLowerCase().replace("a-", ""); // "A-fine" -> "fine"

  // --- Path 1: B10 task-specific arm-a (Slice 2+) ---
  const b10Path = join(BENCH_B10_ROOT, "tasks", taskId, "arm-a", `${stratDir}.mjs`);
  if (existsSync(b10Path)) {
    return { emitPath: b10Path, entryFunction, source: "b10-task" };
  }

  // --- Path 2: B9 reference fallback (Slice 1) ---
  const b9Path = join(BENCH_B9_ROOT, "tasks", taskId, "arm-a", `${stratDir}.mjs`);
  if (existsSync(b9Path)) {
    return { emitPath: b9Path, entryFunction, source: "b9-reference" };
  }

  throw new Error(
    `Arm A emit not found for task '${taskId}' strategy '${strategy}'.\n` +
    `  B10 path (S2+): ${b10Path}\n` +
    `  B9 fallback:    ${b9Path}\n` +
    `For Slice 1, only B9 tasks are supported as smoke corpus.`
  );
}

/**
 * Returns all Arm A (task, strategy) descriptors for the given task IDs.
 *
 * @param {string[]} taskIds
 * @returns {Array<{ taskId, strategy, emitPath, entryFunction, source, error? }>}
 */
export function listAllArmAEmits(taskIds) {
  const emits = [];
  for (const taskId of taskIds) {
    for (const strategy of ARM_A_STRATEGIES) {
      try {
        const { emitPath, entryFunction, source } = resolveArmAEmit(taskId, strategy);
        emits.push({ taskId, strategy, emitPath, entryFunction, source });
      } catch (err) {
        emits.push({ taskId, strategy, emitPath: null, entryFunction: null, source: null, error: err.message });
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
    task:     { type: "string" },
    strategy: { type: "string", default: "A-fine" },
    list:     { type: "boolean", default: false },
    json:     { type: "boolean", default: false },
  },
  strict: false,
  allowPositionals: false,
});

const isMain = process.argv[1] &&
  (resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url)) ||
   process.argv[1].endsWith("arm-a-emit.mjs"));

if (isMain) {
  if (cliArgs["list"]) {
    const taskIds = Object.keys(TASK_ENTRY_FUNCTIONS);
    const emits = listAllArmAEmits(taskIds);
    if (cliArgs["json"]) {
      process.stdout.write(JSON.stringify(emits, null, 2) + "\n");
    } else {
      for (const e of emits) {
        const status = e.error ? "MISSING" : "OK";
        console.log(`  [${status}] ${e.taskId}/${e.strategy} -> ${e.emitPath ?? e.error} (${e.source ?? ""})`);
      }
    }
  } else if (cliArgs["task"]) {
    try {
      const result = resolveArmAEmit(cliArgs["task"], cliArgs["strategy"]);
      if (cliArgs["json"]) {
        process.stdout.write(JSON.stringify({ task_id: cliArgs["task"], ...result }, null, 2) + "\n");
      } else {
        console.log(`task:           ${cliArgs["task"]}`);
        console.log(`strategy:       ${cliArgs["strategy"]}`);
        console.log(`emit_path:      ${result.emitPath}`);
        console.log(`entry_function: ${result.entryFunction}`);
        console.log(`source:         ${result.source}`);
      }
    } catch (err) {
      console.error(`[arm-a-emit] Error: ${err.message}`);
      process.exit(1);
    }
  } else {
    console.error("Usage: arm-a-emit.mjs --task <taskId> [--strategy <A-fine|A-medium|A-coarse>] [--json]");
    console.error("   or: arm-a-emit.mjs --list [--json]");
    process.exit(1);
  }
}
