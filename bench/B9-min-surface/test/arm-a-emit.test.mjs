// SPDX-License-Identifier: MIT
//
// bench/B9-min-surface/test/arm-a-emit.test.mjs
//
// Unit tests for harness/arm-a-emit.mjs
//
// Tests:
// 1. resolveArmAEmit returns correct path for each (task, strategy) combination
// 2. resolveArmAEmit throws for unknown task or unknown strategy
// 3. listAllArmAEmits returns 18 entries (6 tasks × 3 strategies) with no errors
// 4. All resolved emit paths actually exist on disk
// 5. CLI --list produces output for all 18 emits
// 6. CLI --task + --strategy produces JSON with correct fields

import { strictEqual, ok, deepEqual } from "node:assert";
import { test } from "node:test";
import { existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import {
  resolveArmAEmit,
  listAllArmAEmits,
  ARM_A_STRATEGIES,
  TASK_ENTRY_FUNCTIONS,
} from "../harness/arm-a-emit.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BENCH_B9_ROOT = resolve(__dirname, "..");
const WORKTREE_ROOT = resolve(BENCH_B9_ROOT, "..", "..");

// ---------------------------------------------------------------------------
// Test 1: ARM_A_STRATEGIES constant is correct
// ---------------------------------------------------------------------------

test("arm-a-emit: ARM_A_STRATEGIES constant", () => {
  deepEqual(ARM_A_STRATEGIES, ["A-fine", "A-medium", "A-coarse"]);
});

// ---------------------------------------------------------------------------
// Test 2: TASK_ENTRY_FUNCTIONS has all 6 tasks
// ---------------------------------------------------------------------------

test("arm-a-emit: TASK_ENTRY_FUNCTIONS has all 6 tasks", () => {
  const tasks = Object.keys(TASK_ENTRY_FUNCTIONS);
  strictEqual(tasks.length, 6, `expected 6 tasks, got ${tasks.length}: ${tasks.join(", ")}`);
  ok(tasks.includes("parse-int-list"), "missing parse-int-list");
  ok(tasks.includes("parse-coord-pair"), "missing parse-coord-pair");
  ok(tasks.includes("csv-row-narrow"), "missing csv-row-narrow");
  ok(tasks.includes("kebab-to-camel"), "missing kebab-to-camel");
  ok(tasks.includes("digits-to-sum"), "missing digits-to-sum");
  ok(tasks.includes("even-only-filter"), "missing even-only-filter");
});

// ---------------------------------------------------------------------------
// Test 3: resolveArmAEmit returns valid paths for all tasks/strategies
// ---------------------------------------------------------------------------

test("arm-a-emit: resolveArmAEmit — all (task, strategy) pairs resolve", () => {
  const taskIds = Object.keys(TASK_ENTRY_FUNCTIONS);
  for (const taskId of taskIds) {
    for (const strategy of ARM_A_STRATEGIES) {
      const { emitPath, source } = resolveArmAEmit(WORKTREE_ROOT, taskId, strategy);
      ok(emitPath, `emitPath should be non-empty for ${taskId}/${strategy}`);
      ok(
        existsSync(emitPath),
        `emit file should exist for ${taskId}/${strategy}: ${emitPath}`
      );
      ok(
        source === "bench-reference" || source === "yakcc-compile",
        `source should be bench-reference or yakcc-compile for ${taskId}/${strategy}, got: ${source}`
      );
      console.log(`  [OK] ${taskId}/${strategy} -> ${source}`);
    }
  }
});

// ---------------------------------------------------------------------------
// Test 4: resolveArmAEmit throws for unknown strategy
// ---------------------------------------------------------------------------

test("arm-a-emit: resolveArmAEmit — throws for unknown strategy", () => {
  let threw = false;
  try {
    resolveArmAEmit(WORKTREE_ROOT, "parse-int-list", "A-nonexistent");
  } catch (err) {
    threw = true;
    ok(err.message.includes("Unknown strategy"), `error message should mention 'Unknown strategy', got: ${err.message}`);
  }
  ok(threw, "should have thrown for unknown strategy");
});

// ---------------------------------------------------------------------------
// Test 5: resolveArmAEmit throws for unknown taskId
// ---------------------------------------------------------------------------

test("arm-a-emit: resolveArmAEmit — throws for unknown taskId", () => {
  let threw = false;
  try {
    resolveArmAEmit(WORKTREE_ROOT, "nonexistent-task", "A-fine");
  } catch (err) {
    threw = true;
    ok(err.message.includes("not found") || err.message.includes("Unknown"),
      `error should mention not-found or Unknown, got: ${err.message}`);
  }
  ok(threw, "should have thrown for unknown task");
});

// ---------------------------------------------------------------------------
// Test 6: listAllArmAEmits returns 18 entries, all resolved, no errors
// ---------------------------------------------------------------------------

test("arm-a-emit: listAllArmAEmits — 18 entries, all present", () => {
  const taskIds = Object.keys(TASK_ENTRY_FUNCTIONS);
  const emits = listAllArmAEmits(WORKTREE_ROOT, taskIds);

  strictEqual(emits.length, 18, `expected 18 emits (6 tasks × 3 strategies), got ${emits.length}`);

  const missing = emits.filter(e => e.error);
  if (missing.length > 0) {
    console.error("  MISSING emits:");
    for (const m of missing) console.error(`    ${m.taskId}/${m.strategy}: ${m.error}`);
  }
  strictEqual(missing.length, 0, `all emits should resolve without error; ${missing.length} missing`);

  for (const e of emits) {
    ok(e.emitPath, `emitPath should be non-empty for ${e.taskId}/${e.strategy}`);
    ok(e.entryFunction, `entryFunction should be set for ${e.taskId}/${e.strategy}`);
  }
});

// ---------------------------------------------------------------------------
// Test 7: listAllArmAEmits — each emit file is actually loadable as a module
//         (basic syntax/export check via dynamic import of the .mjs path)
// ---------------------------------------------------------------------------

test("arm-a-emit: all emit files importable and have entry function", async (t) => {
  const taskIds = Object.keys(TASK_ENTRY_FUNCTIONS);
  const emits = listAllArmAEmits(WORKTREE_ROOT, taskIds);

  // Test a sample of emits: fine strategy for each task (not all 18 to keep test fast)
  const fineEmits = emits.filter(e => e.strategy === "A-fine");
  strictEqual(fineEmits.length, 6, `expected 6 A-fine emits, got ${fineEmits.length}`);

  for (const emit of fineEmits) {
    const { pathToFileURL } = await import("node:url");
    let mod;
    try {
      mod = await import(pathToFileURL(emit.emitPath).href);
    } catch (err) {
      throw new Error(`Failed to import ${emit.taskId}/A-fine (${emit.emitPath}): ${err.message}`);
    }

    const entryFn = mod[emit.entryFunction] ?? mod.default?.[emit.entryFunction] ?? mod.default;
    ok(
      typeof entryFn === "function",
      `Entry function '${emit.entryFunction}' should be exported from ${emit.taskId}/A-fine. Exports: ${Object.keys(mod).join(", ")}`
    );
    console.log(`  [OK] ${emit.taskId}/A-fine exports '${emit.entryFunction}'`);
  }
});

// ---------------------------------------------------------------------------
// Test 8: CLI --list produces output for all 18 emits (subprocess test)
// ---------------------------------------------------------------------------

test("arm-a-emit: CLI --list output", () => {
  const result = spawnSync(process.execPath, [
    join(BENCH_B9_ROOT, "harness", "arm-a-emit.mjs"),
    "--list",
  ], {
    encoding: "utf8",
    timeout: 15_000,
    env: process.env,
  });

  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`arm-a-emit --list exited ${result.status}: ${result.stderr?.slice(0, 500)}`);
  }

  const lines = result.stdout.trim().split("\n").filter(l => l.trim());
  const okLines = lines.filter(l => l.includes("[OK]"));
  const missingLines = lines.filter(l => l.includes("[MISSING]"));

  strictEqual(okLines.length, 18, `expected 18 [OK] lines, got ${okLines.length}`);
  strictEqual(missingLines.length, 0, `expected 0 [MISSING] lines, got ${missingLines.length}: ${missingLines.join("; ")}`);

  console.log(`  CLI --list: ${okLines.length} [OK], ${missingLines.length} [MISSING]`);
});

// ---------------------------------------------------------------------------
// Test 9: CLI --task + --strategy --json produces valid JSON
// ---------------------------------------------------------------------------

test("arm-a-emit: CLI --task --strategy --json output", () => {
  const result = spawnSync(process.execPath, [
    join(BENCH_B9_ROOT, "harness", "arm-a-emit.mjs"),
    "--task", "digits-to-sum",
    "--strategy", "A-medium",
    "--json",
  ], {
    encoding: "utf8",
    timeout: 15_000,
    env: process.env,
  });

  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`arm-a-emit CLI exited ${result.status}: ${result.stderr?.slice(0, 500)}`);
  }

  let output;
  try {
    output = JSON.parse(result.stdout.trim());
  } catch (err) {
    throw new Error(`CLI output is not valid JSON: ${result.stdout.slice(0, 200)}`);
  }

  strictEqual(output.task_id, "digits-to-sum");
  strictEqual(output.strategy, "A-medium");
  ok(output.emit_path, "emit_path should be set");
  strictEqual(output.entry_function, "digitsToSum");
  ok(existsSync(output.emit_path), `emit_path should exist: ${output.emit_path}`);

  console.log(`  CLI --task digits-to-sum --strategy A-medium -> emit_path exists, entry_function=${output.entry_function}`);
});
