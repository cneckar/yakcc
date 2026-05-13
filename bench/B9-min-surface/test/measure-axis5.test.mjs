// SPDX-License-Identifier: MIT
//
// bench/B9-min-surface/test/measure-axis5.test.mjs
//
// Unit tests for harness/measure-axis5.mjs
//
// Tests:
// 1. measureEmitPerformance — returns correct LOC, bytes, gzipped_bytes for a known file
// 2. measureEmitPerformance — throws for missing file
// 3. computeArmBCost — correct dollar amounts for claude-sonnet-4-6
// 4. computeArmBCost — falls back to default model for unknown model
// 5. measureAxis5ArmA — returns cost_usd=0 for authored reference
// 6. measureAxis5ArmBReps — median + range across N reps
// 7. measureAxis5ArmBReps — single rep
// 8. aggregateAxis5 — sums total_arm_b_cost correctly
// 9. Production scenario: run all 18 arm-a emits through measureAxis5ArmA

import { strictEqual, ok } from "node:assert";
import { test } from "node:test";
import { existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  measureEmitPerformance,
  measureAxis5ArmA,
  computeArmBCost,
  measureAxis5ArmBReps,
  aggregateAxis5,
} from "../harness/measure-axis5.mjs";

import {
  listAllArmAEmits,
  TASK_ENTRY_FUNCTIONS,
} from "../harness/arm-a-emit.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BENCH_B9_ROOT = resolve(__dirname, "..");
const WORKTREE_ROOT = resolve(BENCH_B9_ROOT, "..", "..");
const SCRATCH_DIR = join(BENCH_B9_ROOT, "..", "..", "tmp", "B9-min-surface", "test-scratch");

// ---------------------------------------------------------------------------
// Test 1: measureEmitPerformance — LOC, bytes, gzipped_bytes
// ---------------------------------------------------------------------------

test("measure-axis5: measureEmitPerformance — known file", () => {
  // Use a real arm-a emit (digits-to-sum/A-fine)
  const emitPath = join(BENCH_B9_ROOT, "tasks", "digits-to-sum", "arm-a", "fine.mjs");
  ok(existsSync(emitPath), `emit file should exist: ${emitPath}`);

  const perf = measureEmitPerformance(emitPath);

  ok(perf.loc > 0, `loc should be > 0, got ${perf.loc}`);
  ok(perf.bytes > 0, `bytes should be > 0, got ${perf.bytes}`);
  ok(perf.gzipped_bytes !== null && perf.gzipped_bytes > 0, `gzipped_bytes should be > 0, got ${perf.gzipped_bytes}`);
  ok(perf.gzipped_bytes <= perf.bytes, `gzipped_bytes (${perf.gzipped_bytes}) should be ≤ raw bytes (${perf.bytes}) for non-trivial content`);
  ok(typeof perf.wall_ms_read === "number", "wall_ms_read should be a number");

  console.log(`  digits-to-sum/A-fine: loc=${perf.loc} bytes=${perf.bytes} gzipped=${perf.gzipped_bytes} wall_ms=${perf.wall_ms_read}`);
});

// ---------------------------------------------------------------------------
// Test 2: measureEmitPerformance — throws for missing file
// ---------------------------------------------------------------------------

test("measure-axis5: measureEmitPerformance — throws for missing file", () => {
  let threw = false;
  try {
    measureEmitPerformance("/nonexistent/path/that/does/not/exist.mjs");
  } catch (err) {
    threw = true;
    ok(err.message.includes("not found"), `error should mention 'not found', got: ${err.message}`);
  }
  ok(threw, "should throw for missing emit file");
});

// ---------------------------------------------------------------------------
// Test 3: computeArmBCost — claude-sonnet-4-6 pricing
// ---------------------------------------------------------------------------

test("measure-axis5: computeArmBCost — correct cost for claude-sonnet-4-6", () => {
  // 1M input tokens @ $3/MTok = $3.00
  // 100k output tokens @ $15/MTok = $1.50
  // Total = $4.50
  const usage = { input_tokens: 1_000_000, output_tokens: 100_000 };
  const { cost_usd, breakdown } = computeArmBCost(usage, "claude-sonnet-4-6");

  // Approximate check (floating point)
  const expected = 3.00 + 1.50;
  ok(Math.abs(cost_usd - expected) < 0.001, `cost_usd should be ≈$${expected}, got $${cost_usd}`);
  strictEqual(breakdown.input_tokens, 1_000_000);
  strictEqual(breakdown.output_tokens, 100_000);
  strictEqual(breakdown.model, "claude-sonnet-4-6");

  console.log(`  computeArmBCost(1M in, 100k out) = $${cost_usd.toFixed(4)} (expected $4.50)`);
});

// ---------------------------------------------------------------------------
// Test 4: computeArmBCost — small token counts (typical prompt)
// ---------------------------------------------------------------------------

test("measure-axis5: computeArmBCost — typical prompt (300 in, 500 out)", () => {
  // 300 input tokens @ $3/MTok = $0.0009
  // 500 output tokens @ $15/MTok = $0.0075
  // Total ≈ $0.0084
  const usage = { input_tokens: 300, output_tokens: 500 };
  const { cost_usd } = computeArmBCost(usage);

  ok(cost_usd < 0.01, `typical prompt cost should be < $0.01, got $${cost_usd}`);
  ok(cost_usd > 0, "cost should be > 0");
  console.log(`  Typical prompt (300 in, 500 out) cost: $${cost_usd.toFixed(6)}`);
});

// ---------------------------------------------------------------------------
// Test 5: computeArmBCost — falls back to default model for unknown model
// ---------------------------------------------------------------------------

test("measure-axis5: computeArmBCost — unknown model uses default pricing", () => {
  const usage = { input_tokens: 1000, output_tokens: 1000 };
  // Should not throw; falls back to claude-sonnet-4-6 pricing
  const result = computeArmBCost(usage, "unknown-model-xyz");
  const withDefault = computeArmBCost(usage, "claude-sonnet-4-6");
  // Results should be the same since unknown falls back to default
  ok(typeof result.cost_usd === "number", "cost_usd should be a number for unknown model");
  ok(Math.abs(result.cost_usd - withDefault.cost_usd) < 0.0001, "unknown model should use default pricing");
});

// ---------------------------------------------------------------------------
// Test 6: measureAxis5ArmA — cost_usd = 0 for authored reference
// ---------------------------------------------------------------------------

test("measure-axis5: measureAxis5ArmA — cost_usd = 0 for authored bench reference", () => {
  const emitPath = join(BENCH_B9_ROOT, "tasks", "even-only-filter", "arm-a", "medium.mjs");
  const result = measureAxis5ArmA(emitPath, "A-medium");

  strictEqual(result.cost_usd, 0, "Arm A authored reference should have cost_usd=0");
  strictEqual(result.strategy, "A-medium");
  ok(result.performance, "should have performance data");
  ok(result.performance.loc > 0, "performance.loc should be > 0");
  ok(typeof result.wall_ms_total === "number", "wall_ms_total should be a number");

  console.log(`  measureAxis5ArmA (even-only-filter/A-medium): cost=$${result.cost_usd} loc=${result.performance.loc}`);
});

// ---------------------------------------------------------------------------
// Test 7: measureAxis5ArmBReps — 3 reps, median + range
// ---------------------------------------------------------------------------

test("measure-axis5: measureAxis5ArmBReps — 3 reps with varying costs", () => {
  const reps = [
    { usage: { input_tokens: 300, output_tokens: 400 }, model: "claude-sonnet-4-6", wall_ms: 1200, emit_path: null },
    { usage: { input_tokens: 350, output_tokens: 450 }, model: "claude-sonnet-4-6", wall_ms: 1100, emit_path: null },
    { usage: { input_tokens: 280, output_tokens: 380 }, model: "claude-sonnet-4-6", wall_ms: 1350, emit_path: null },
  ];

  const result = measureAxis5ArmBReps(reps);

  strictEqual(result.n_reps, 3);
  ok(result.total_cost_usd > 0, "total_cost_usd should be > 0");
  ok(result.median_cost_usd !== null, "median_cost_usd should not be null");
  ok(result.cost_range_usd !== null, "cost_range_usd should not be null");
  ok(result.cost_range_usd[0] <= result.cost_range_usd[1], "cost_range should be [min, max]");
  ok(result.median_wall_ms > 0, "median_wall_ms should be > 0");

  console.log(
    `  measureAxis5ArmBReps: total=$${result.total_cost_usd.toFixed(6)} ` +
    `median=$${result.median_cost_usd.toFixed(6)} ` +
    `range=[$${result.cost_range_usd[0].toFixed(6)}, $${result.cost_range_usd[1].toFixed(6)}]`
  );
});

// ---------------------------------------------------------------------------
// Test 8: measureAxis5ArmBReps — single rep
// ---------------------------------------------------------------------------

test("measure-axis5: measureAxis5ArmBReps — single rep", () => {
  const reps = [
    { usage: { input_tokens: 276, output_tokens: 198 }, model: "claude-sonnet-4-6", wall_ms: 800, emit_path: null },
  ];

  const result = measureAxis5ArmBReps(reps);
  strictEqual(result.n_reps, 1);
  ok(result.total_cost_usd > 0);
  // Range should be [X, X] for single rep
  if (result.cost_range_usd) {
    strictEqual(result.cost_range_usd[0], result.cost_range_usd[1], "range should be [X, X] for single rep");
  }
});

// ---------------------------------------------------------------------------
// Test 9: measureAxis5ArmBReps — throws for empty array
// ---------------------------------------------------------------------------

test("measure-axis5: measureAxis5ArmBReps — throws on empty input", () => {
  let threw = false;
  try {
    measureAxis5ArmBReps([]);
  } catch (err) {
    threw = true;
  }
  ok(threw, "should throw on empty reps array");
});

// ---------------------------------------------------------------------------
// Test 10: aggregateAxis5 — sums total_arm_b_cost
// ---------------------------------------------------------------------------

test("measure-axis5: aggregateAxis5 — totals Arm B cost across tasks", () => {
  const allMeasurements = {
    "parse-int-list": {
      arm_a: {
        "A-fine": { cost_usd: 0, wall_ms_total: 5 },
        "A-medium": { cost_usd: 0, wall_ms_total: 3 },
        "A-coarse": { cost_usd: 0, wall_ms_total: 2 },
      },
      arm_b: { total_cost_usd: 0.025, median_cost_usd: 0.008 },
    },
    "parse-coord-pair": {
      arm_a: {
        "A-fine": { cost_usd: 0, wall_ms_total: 4 },
        "A-medium": { cost_usd: 0, wall_ms_total: 3 },
        "A-coarse": { cost_usd: 0, wall_ms_total: 2 },
      },
      arm_b: { total_cost_usd: 0.030, median_cost_usd: 0.010 },
    },
  };

  const aggregated = aggregateAxis5(allMeasurements);

  ok(Math.abs(aggregated.total_arm_b_cost_usd - 0.055) < 0.001,
    `total_arm_b_cost should be ≈0.055, got ${aggregated.total_arm_b_cost_usd}`);
  ok(aggregated.per_task["parse-int-list"], "should have parse-int-list in per_task");
  ok(aggregated.per_task["parse-coord-pair"], "should have parse-coord-pair in per_task");
  ok(aggregated.cost_note, "should have cost_note");

  console.log(`  aggregateAxis5: total_arm_b_cost=$${aggregated.total_arm_b_cost_usd.toFixed(6)}`);
});

// ---------------------------------------------------------------------------
// Test 11: Production scenario — run all 18 arm-a emits through measureAxis5ArmA
//
// This exercises the actual production path: for each (task, strategy) emit
// in the granularity sweep, measure its Axis 5 performance.
// ---------------------------------------------------------------------------

test("measure-axis5: production scenario — all 18 arm-a emits have valid Axis 5 data", () => {
  const taskIds = Object.keys(TASK_ENTRY_FUNCTIONS);
  const emits = listAllArmAEmits(WORKTREE_ROOT, taskIds);
  const validEmits = emits.filter(e => !e.error && e.emitPath);

  strictEqual(validEmits.length, 18, `expected 18 valid emits, got ${validEmits.length}`);

  let totalCost = 0;
  for (const emit of validEmits) {
    const result = measureAxis5ArmA(emit.emitPath, emit.strategy);

    strictEqual(result.cost_usd, 0, `Arm A should have cost_usd=0 for ${emit.taskId}/${emit.strategy}`);
    ok(result.performance.loc > 0, `loc should be > 0 for ${emit.taskId}/${emit.strategy}`);
    ok(result.performance.bytes > 0, `bytes should be > 0 for ${emit.taskId}/${emit.strategy}`);
    totalCost += result.cost_usd;
  }

  strictEqual(totalCost, 0, "Total Arm A cost should be exactly $0");
  console.log(`  All 18 arm-a emits: cost=$${totalCost} (expected $0 for authored references)`);
});

// ---------------------------------------------------------------------------
// Test 12: Budget math — $50 cap is ≫ expected N=3 × 6 tasks cost
// ---------------------------------------------------------------------------

test("measure-axis5: cost budget math — $50 cap covers expected run", () => {
  // Estimate: 6 tasks × 3 reps × (300 in + 500 out tokens)
  // = $0.0084/rep × 18 reps = $0.15 total
  const repsPerTask = 3;
  const tasks = 6;
  const typicalUsage = { input_tokens: 300, output_tokens: 500 };
  const { cost_usd: costPerRep } = computeArmBCost(typicalUsage, "claude-sonnet-4-6");
  const estimatedTotal = costPerRep * repsPerTask * tasks;
  const CAP = 50;

  ok(estimatedTotal < CAP, `estimated total $${estimatedTotal.toFixed(4)} should be < $${CAP} cap`);
  ok(estimatedTotal < 1.0, `estimated total $${estimatedTotal.toFixed(4)} should be < $1 for this task suite`);

  console.log(
    `  Budget math: $${costPerRep.toFixed(6)}/rep × ${repsPerTask} reps × ${tasks} tasks ` +
    `= $${estimatedTotal.toFixed(4)} total (cap: $${CAP})`
  );
});
