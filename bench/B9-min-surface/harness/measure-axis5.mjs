// SPDX-License-Identifier: MIT
//
// bench/B9-min-surface/harness/measure-axis5.mjs
//
// Axis 5 — Emission cost & performance (first-class per #446 Gap 3).
//
// Sub-axes:
//   5a: Atomization cost — tokens consumed + registry lookups + wall time to
//       produce the Arm A emit at each granularity strategy.
//   5b: Emission performance — wall time + LOC + bytes + gzipped bytes of the
//       produced emit.
//   5c: Currency cost — dollars per task per granularity (Anthropic usage for Arm B
//       N=3 reps; Arm A is $0 for the actual emit since it's compile-time).
//
// Cross-references:
//   DEC-V0-MIN-SURFACE-001 (REFUSED-EARLY) — harness/measure-axis2.mjs
//   DEC-V0-MIN-SURFACE-002 (reachability) — harness/measure-axis1.mjs
//   DEC-V0-MIN-SURFACE-003 (Arm B prompt) — harness/llm-baseline.mjs
//   DEC-V0-MIN-SURFACE-004 (Arm A granularity) — harness/arm-a-emit.mjs
//   DEC-BENCH-B9-SLICE1-COST-001 (cost cap) — harness/run.mjs
//
// Usage:
//   import { measureAxis5ArmA, measureAxis5ArmB, aggregateAxis5 } from './measure-axis5.mjs';

import { existsSync, statSync, readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";

// ---------------------------------------------------------------------------
// Anthropic pricing constants (claude-sonnet-4-6 as of 2026-05-13)
// Prices in USD per million tokens (MTok).
// Source: https://www.anthropic.com/pricing (cached at plan time).
// ---------------------------------------------------------------------------

const ANTHROPIC_PRICING = {
  "claude-sonnet-4-6": {
    input_per_mtok: 3.00,   // $3 per MTok input
    output_per_mtok: 15.00, // $15 per MTok output
  },
  "claude-sonnet-4-5": {
    input_per_mtok: 3.00,
    output_per_mtok: 15.00,
  },
};

const DEFAULT_MODEL = "claude-sonnet-4-6";

// ---------------------------------------------------------------------------
// Axis 5b: Emit performance (applies to both arms)
// ---------------------------------------------------------------------------

/**
 * Measure emit performance for a given emit file.
 * @param {string} emitPath - path to the .mjs or .ts file
 * @returns {{ loc: number, bytes: number, gzipped_bytes: number, wall_ms_load: number }}
 */
export function measureEmitPerformance(emitPath) {
  if (!existsSync(emitPath)) throw new Error(`Emit not found: ${emitPath}`);

  const t0 = Date.now();
  const content = readFileSync(emitPath, "utf8");
  const loadMs = Date.now() - t0;

  const loc = content.split("\n").length;
  const rawBytes = Buffer.byteLength(content, "utf8");
  let gzippedBytes = null;

  try {
    gzippedBytes = gzipSync(Buffer.from(content, "utf8")).length;
  } catch (_) {
    // gzip not available — skip
  }

  return {
    loc,
    bytes: rawBytes,
    gzipped_bytes: gzippedBytes,
    wall_ms_read: loadMs,
  };
}

// ---------------------------------------------------------------------------
// Axis 5a: Arm A atomization cost
// Arm A emit (bench reference) is $0 API cost — it's authored source.
// Wall time is measured for the harness to locate and load the emit.
// ---------------------------------------------------------------------------

/**
 * Measure Arm A atomization cost (wall time only; no API cost for authored emits).
 * @param {string} emitPath - resolved arm-a emit path
 * @param {string} strategy - "A-fine" | "A-medium" | "A-coarse"
 * @returns {{ strategy, emit_path, cost_usd: 0, wall_ms_resolve: number, performance: object }}
 */
export function measureAxis5ArmA(emitPath, strategy) {
  const t0 = Date.now();
  const performance = measureEmitPerformance(emitPath);
  const wallMs = Date.now() - t0;

  return {
    strategy,
    emit_path: emitPath,
    source: "bench-reference",
    cost_usd: 0,
    cost_note: "Arm A is authored bench reference — no API cost per emit",
    wall_ms_total: wallMs,
    performance,
  };
}

// ---------------------------------------------------------------------------
// Axis 5c: Arm B currency cost from Anthropic usage
// ---------------------------------------------------------------------------

/**
 * Compute dollar cost from Anthropic API usage response.
 * @param {{ input_tokens: number, output_tokens: number }} usage
 * @param {string} model
 * @returns {{ cost_usd: number, breakdown: object }}
 */
export function computeArmBCost(usage, model = DEFAULT_MODEL) {
  const pricing = ANTHROPIC_PRICING[model] ?? ANTHROPIC_PRICING[DEFAULT_MODEL];
  const inputCost = (usage.input_tokens / 1_000_000) * pricing.input_per_mtok;
  const outputCost = (usage.output_tokens / 1_000_000) * pricing.output_per_mtok;
  const totalCost = inputCost + outputCost;

  return {
    cost_usd: totalCost,
    breakdown: {
      input_tokens: usage.input_tokens,
      output_tokens: usage.output_tokens,
      input_cost_usd: inputCost,
      output_cost_usd: outputCost,
      pricing_per_mtok: pricing,
      model,
    },
  };
}

// ---------------------------------------------------------------------------
// Axis 5 for Arm B: cost from N=3 reps + median/range
// ---------------------------------------------------------------------------

/**
 * Aggregate Axis 5 measurements for N Arm B reps.
 * @param {Array<{ usage: object, model: string, wall_ms: number, emit_path: string }>} reps
 * @returns {{ n_reps, total_cost_usd, cost_per_rep, median_cost_usd, wall_ms_reps, performance }>}
 */
export function measureAxis5ArmBReps(reps) {
  if (!reps || reps.length === 0) throw new Error("No reps provided");

  const costs = reps.map(r => {
    if (!r.usage) return { cost_usd: null, breakdown: null };
    return computeArmBCost(r.usage, r.model ?? DEFAULT_MODEL);
  });

  const validCosts = costs.filter(c => c.cost_usd !== null).map(c => c.cost_usd);
  const sortedCosts = [...validCosts].sort((a, b) => a - b);
  const mid = Math.floor(sortedCosts.length / 2);
  const medianCost = sortedCosts.length > 0
    ? (sortedCosts.length % 2 === 0 ? (sortedCosts[mid - 1] + sortedCosts[mid]) / 2 : sortedCosts[mid])
    : null;

  const totalCost = validCosts.reduce((s, c) => s + c, 0);

  const wallMsList = reps.map(r => r.wall_ms ?? 0);

  // Measure emit performance from the last rep's emit_path (all reps same task/prompt)
  let performance = null;
  const lastRepWithEmit = reps.findLast(r => r.emit_path && existsSync(r.emit_path));
  if (lastRepWithEmit) {
    try {
      performance = measureEmitPerformance(lastRepWithEmit.emit_path);
    } catch (_) {}
  }

  return {
    n_reps: reps.length,
    total_cost_usd: totalCost,
    median_cost_usd: medianCost,
    cost_range_usd: validCosts.length > 0 ? [Math.min(...validCosts), Math.max(...validCosts)] : null,
    cost_per_rep: costs,
    wall_ms_reps: wallMsList,
    median_wall_ms: wallMsList.length > 0 ? [...wallMsList].sort((a, b) => a - b)[Math.floor(wallMsList.length / 2)] : null,
    performance,
  };
}

// ---------------------------------------------------------------------------
// Aggregate Axis 5 across all tasks and strategies
// ---------------------------------------------------------------------------

/**
 * Aggregate all Axis 5 measurements into a per-task, per-strategy table.
 * @param {{ arm_a: object, arm_b: object }} allMeasurements - keyed by taskId
 * @returns {{ total_arm_b_cost_usd, per_task: object }}
 */
export function aggregateAxis5(allMeasurements) {
  let totalArmBCost = 0;
  const perTask = {};

  for (const [taskId, taskData] of Object.entries(allMeasurements)) {
    perTask[taskId] = { arm_a: {}, arm_b: taskData.arm_b ?? null };

    for (const [strategy, data] of Object.entries(taskData.arm_a ?? {})) {
      perTask[taskId].arm_a[strategy] = data;
    }

    if (taskData.arm_b?.total_cost_usd) {
      totalArmBCost += taskData.arm_b.total_cost_usd;
    }
  }

  return {
    total_arm_b_cost_usd: totalArmBCost,
    cost_note: "Arm A cost is $0 (authored bench reference, no API calls). Arm B cost is sum of N=3 reps per task.",
    per_task: perTask,
  };
}

export default { measureAxis5ArmA, measureAxis5ArmBReps, aggregateAxis5, computeArmBCost, measureEmitPerformance };
