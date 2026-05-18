#!/usr/bin/env node
/**
 * per-f-loop.mjs — Per-fraction loop over the sampled truth table.
 *
 * @decision DEC-BENCH-B8-CURVE-SLICE1-001
 * @title B8-CURVE S1 uses cached-truth-table sampling over a committed B8-SYNTHETIC artifact.
 * @status accepted
 * @rationale
 *   Zero LLM cost is a hard constraint; this worktree does not have a built
 *   packages/registry/dist/ or bootstrap/yakcc.registry.sqlite. The B8-SYNTHETIC
 *   committed results carry per-block `hit` truth from a prior real run with
 *   documented corpus_sha256 and registry_path. Sampling that truth table at
 *   fraction f is mathematically equivalent to re-running the simulator on a
 *   deterministic subset of the corpus (because the simulator is deterministic
 *   given fixed registry state). Provenance is preserved in the output
 *   _meta.source_artifact block.
 *
 * Runs each (fraction, comparator, curve) combination and returns a flat
 * array of CurveRow objects. Zero LLM cost — pure arithmetic over the
 * cached hit truth table.
 *
 * Cross-reference: bench/B8-curve/README.md, DEC-BENCH-B8-CURVE-SLICE1-001,
 *                  DEC-BENCH-B8-CURVE-MONOTONE-SAMPLING-001
 */

import { sampleSubset } from './sampler.mjs';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Token cost charged per block when the hook fires a cache hit.
 * Matches the heuristic used in bench/B8-synthetic/token-savings.mjs
 * (45 tokens ≈ typical hook overhead for a substituted response).
 *
 * S1 uses this flat constant because we are operating purely from the cached
 * hit truth table; there is no task_estimated_hook_tokens field that varies
 * per-task in the same way the live simulator produces. A future --live mode
 * (Slice 1.5) could read task_estimated_hook_tokens directly.
 */
export const HOOK_TOKENS_PER_HIT = 45;

// ---------------------------------------------------------------------------
// Comparators
// ---------------------------------------------------------------------------

/**
 * Naive comparator — treats every block as a miss.
 * hook_tokens == raw_tokens for all blocks (raw passthrough; 0% savings floor).
 *
 * @param {object} block — { hit: boolean, raw_tokens: number, ... }
 * @returns {{ hit: boolean, hook_tokens: number }}
 */
function naiveComparator(block) {
  return { hit: false, hook_tokens: block.raw_tokens };
}

/**
 * Hooked comparator — uses the recorded `hit` from the truth table.
 * If hit → hook_tokens = HOOK_TOKENS_PER_HIT. Else → raw_tokens.
 *
 * @param {object} block — { hit: boolean, raw_tokens: number, ... }
 * @returns {{ hit: boolean, hook_tokens: number }}
 */
function hookedComparator(block) {
  if (block.hit) {
    return { hit: true, hook_tokens: HOOK_TOKENS_PER_HIT };
  }
  return { hit: false, hook_tokens: block.raw_tokens };
}

/**
 * Named comparator registry.
 * Keys are the comparator names written into the output rows.
 */
export const COMPARATORS = {
  naive: naiveComparator,
  hooked: hookedComparator,
};

// ---------------------------------------------------------------------------
// Row computation helpers
// ---------------------------------------------------------------------------

/**
 * Compute aggregate statistics for a set of tasks under a given comparator.
 *
 * @param {Array<object>} tasks — per-task truth-table rows
 * @param {(block: object) => { hit: boolean, hook_tokens: number }} comparatorFn
 * @returns {{
 *   n_tasks: number,
 *   mean_hit_rate: number | null,
 *   mean_savings_pct: number | null,
 *   total_savings_pct: number | null,
 *   total_raw_tokens: number,
 *   total_hook_tokens: number,
 * }}
 */
function computeAggregates(tasks, comparatorFn) {
  if (tasks.length === 0) {
    return {
      n_tasks: 0,
      mean_hit_rate: null,
      mean_savings_pct: null,
      total_savings_pct: null,
      total_raw_tokens: 0,
      total_hook_tokens: 0,
    };
  }

  let totalRaw = 0;
  let totalHook = 0;
  let sumHitRate = 0;
  let sumSavingsPct = 0;

  for (const task of tasks) {
    const blocks = task.blocks ?? [];
    let taskRaw = 0;
    let taskHook = 0;
    let taskHits = 0;

    for (const block of blocks) {
      const { hit, hook_tokens } = comparatorFn(block);
      taskRaw += block.raw_tokens;
      taskHook += hook_tokens;
      if (hit) taskHits++;
    }

    const taskHitRate = blocks.length > 0 ? taskHits / blocks.length : 0;
    // Savings % per task: (raw - hook) / raw. Negative means the hook costs more.
    const taskSavingsPct = taskRaw > 0 ? (taskRaw - taskHook) / taskRaw : 0;

    sumHitRate += taskHitRate;
    sumSavingsPct += taskSavingsPct;
    totalRaw += taskRaw;
    totalHook += taskHook;
  }

  const n = tasks.length;
  return {
    n_tasks: n,
    mean_hit_rate: sumHitRate / n,
    mean_savings_pct: sumSavingsPct / n,
    total_savings_pct: totalRaw > 0 ? (totalRaw - totalHook) / totalRaw : 0,
    total_raw_tokens: totalRaw,
    total_hook_tokens: totalHook,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * CurveRow type (documentation only — JS has no type system).
 *
 * @typedef {{
 *   f: number,
 *   comparator: string,
 *   curve: 'all_tasks' | 'tasks_with_coverage',
 *   n_tasks_sampled: number,
 *   mean_hit_rate: number | null,
 *   mean_savings_pct: number | null,
 *   total_savings_pct: number | null,
 *   total_raw_tokens: number,
 *   total_hook_tokens: number,
 * }} CurveRow
 */

/**
 * Run all (fraction × comparator × curve) combinations.
 *
 * For each fraction f:
 *   1. Sample a subset of `tasks` using `sampleSubset(tasks, f, seed)`.
 *   2. For the `tasks_with_coverage` curve, further filter to tasks where
 *      `task_has_coverage === true`.
 *   3. For each comparator, compute aggregates over the (possibly filtered) subset.
 *   4. Emit one CurveRow per (comparator, curve) pair.
 *
 * When the `tasks_with_coverage` subset is empty (n_tasks_sampled === 0), the row
 * has null aggregates rather than zero so downstream consumers can distinguish
 * "empty sample" from "0% savings" — per plan section 4.2.
 *
 * @param {{
 *   tasks: Array<object>,
 *   fractions?: Array<number>,
 *   seed?: number,
 *   comparators?: Record<string, Function>,
 * }} options
 * @returns {Array<CurveRow>}
 */
export function runPerFLoop({
  tasks,
  fractions = [0.0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0],
  seed = 42,
  comparators = COMPARATORS,
}) {
  if (!Array.isArray(tasks)) {
    throw new TypeError('runPerFLoop: tasks must be an array');
  }
  if (!Array.isArray(fractions) || fractions.length === 0) {
    throw new TypeError('runPerFLoop: fractions must be a non-empty array');
  }

  const rows = [];
  const comparatorEntries = Object.entries(comparators);

  for (const f of fractions) {
    // Monotone-stable sample — sampleSubset handles edge cases (f=0, f=1).
    const sampledTasks = sampleSubset(tasks, f, seed);

    // `tasks_with_coverage` subset: tasks where task_has_coverage is truthy.
    const coveredTasks = sampledTasks.filter(t => t.task_has_coverage === true);

    for (const [comparatorName, comparatorFn] of comparatorEntries) {
      // all_tasks curve
      const allAgg = computeAggregates(sampledTasks, comparatorFn);
      rows.push({
        f,
        comparator: comparatorName,
        curve: 'all_tasks',
        n_tasks_sampled: allAgg.n_tasks,
        mean_hit_rate: allAgg.mean_hit_rate,
        mean_savings_pct: allAgg.mean_savings_pct,
        total_savings_pct: allAgg.total_savings_pct,
        total_raw_tokens: allAgg.total_raw_tokens,
        total_hook_tokens: allAgg.total_hook_tokens,
      });

      // tasks_with_coverage curve
      const covAgg = computeAggregates(coveredTasks, comparatorFn);
      rows.push({
        f,
        comparator: comparatorName,
        curve: 'tasks_with_coverage',
        n_tasks_sampled: covAgg.n_tasks,
        mean_hit_rate: covAgg.mean_hit_rate,
        mean_savings_pct: covAgg.mean_savings_pct,
        total_savings_pct: covAgg.total_savings_pct,
        total_raw_tokens: covAgg.total_raw_tokens,
        total_hook_tokens: covAgg.total_hook_tokens,
      });
    }
  }

  return rows;
}
