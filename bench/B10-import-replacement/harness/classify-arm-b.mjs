// SPDX-License-Identifier: MIT
//
// bench/B10-import-replacement/harness/classify-arm-b.mjs
//
// @decision DEC-B10-CLASSIFY-ARM-B-001
// @title Arm B emit classifier — aggregate transitive surface across N reps
// @status accepted
// @rationale
//   PURPOSE
//   After N Arm B reps are collected (dry-run: 1 rep from fixture; live: 3 reps),
//   this module aggregates their transitive-surface measurements into a per-task
//   Arm B summary: median reachable_functions, median reachable_bytes, npm_audit
//   CVE counts, and a verdict relative to Arm A.
//
//   AGGREGATION STRATEGY (N=3 live, N=1 dry-run)
//   Median is used throughout (matching B9's DEC-V0-MIN-SURFACE-003 rationale).
//   Range (min/max) is recorded alongside the median so the reviewer can assess
//   LLM non-determinism. Single-point measurements (dry-run N=1) are flagged as
//   "single_rep" in the output — not a statistically valid distribution.
//
//   VERDICT LOGIC (directional only — no KILL pre-data, per DEC-BENCH-B9-SLICE1-001)
//   - PASS-DIRECTIONAL: Arm A reachable_functions <= Arm B median * (1 - THRESHOLD)
//     where THRESHOLD = 0.90 (>=90% reduction is the headline claim).
//   - WARN-DIRECTIONAL: reduction exists but < 90%.
//   - PENDING: dry-run or missing live measurement.
//   - INCONCLUSIVE: Arm B median = 0 (no npm imports — expected for B9 smoke tasks).
//
//   B9 SMOKE CORPUS BEHAVIOR
//   For B9 tasks (Slice 1 smoke), Arm B emits typically have 0 npm imports (the
//   natural solution is a builtin like JSON.parse). The classifier returns
//   INCONCLUSIVE in this case, which is the EXPECTED outcome for the smoke run.
//   INCONCLUSIVE is not a failure — it means "this task is not an import-heavy task
//   and therefore cannot demonstrate the headline reduction." The smoke run proves
//   the harness works; the headline reading waits for Slice 2+ import-heavy tasks.
//
//   Cross-references:
//   DEC-IRT-B10-METRIC-001 — harness/measure-transitive-surface.mjs
//   DEC-B10-LLM-BASELINE-001 — harness/llm-baseline.mjs
//   DEC-B10-S1-LAYOUT-001  — harness/run.mjs
//   DEC-BENCH-B9-SLICE1-001 — bench/B9-min-surface/harness/run.mjs (verdict pattern)
//
// Usage (module):
//   import { classifyArmB } from './classify-arm-b.mjs';
//   const verdict = classifyArmB({ taskId, armAResult, armBReps });

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Directional headline threshold: Arm A must be >= this fraction smaller than Arm B */
const REDUCTION_THRESHOLD = 0.90;

// ---------------------------------------------------------------------------
// Median helper
// ---------------------------------------------------------------------------

function median(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

// ---------------------------------------------------------------------------
// Classify one task's Arm B reps vs Arm A measurement
// ---------------------------------------------------------------------------

/**
 * Aggregate N Arm B transitive-surface measurements and compare to Arm A.
 *
 * @param {object} opts
 * @param {string} opts.taskId
 * @param {object} opts.armAResult  - result from measureTransitiveSurface for Arm A
 * @param {Array<object>} opts.armBReps  - array of measureTransitiveSurface results for each Arm B rep
 * @param {boolean} [opts.dryRun]   - flag dry-run mode
 * @returns {object} classification result
 */
export function classifyArmB({ taskId, armAResult, armBReps, dryRun = false }) {
  const validReps = armBReps.filter((r) => r && !r.error && typeof r.reachable_functions === "number");

  if (validReps.length === 0) {
    return {
      task_id:   taskId,
      verdict:   "PENDING",
      reason:    "no valid Arm B reps",
      arm_a_reachable_functions: armAResult?.reachable_functions ?? null,
      arm_b_median_reachable_functions: null,
      arm_b_reps_count: armBReps.length,
      dry_run:   dryRun,
    };
  }

  const bFnValues    = validReps.map((r) => r.reachable_functions);
  const bBytesValues = validReps.map((r) => r.reachable_bytes ?? 0);
  const bFileValues  = validReps.map((r) => r.reachable_files ?? 0);
  const bCveValues   = validReps.map((r) => r.npm_audit?.cve_pattern_matches ?? 0);

  const bMedianFn    = median(bFnValues);
  const bMedianBytes = median(bBytesValues);
  const bMedianFiles = median(bFileValues);
  const bMedianCve   = median(bCveValues);

  const aFn = armAResult?.reachable_functions ?? 0;

  // Determine verdict
  let verdict;
  let reason;

  if (dryRun) {
    verdict = "PENDING";
    reason  = "dry-run mode — not a statistically valid measurement";
  } else if (bMedianFn === 0 && aFn === 0) {
    verdict = "INCONCLUSIVE";
    reason  = "both arms have 0 transitive npm functions (not an import-heavy task)";
  } else if (bMedianFn === 0) {
    verdict = "INCONCLUSIVE";
    reason  = "Arm B median reachable_functions = 0 (no npm imports — builtin-only task)";
  } else {
    const reductionFraction = (bMedianFn - aFn) / bMedianFn;
    if (reductionFraction >= REDUCTION_THRESHOLD) {
      verdict = "PASS-DIRECTIONAL";
      reason  = `Arm A is ${(reductionFraction * 100).toFixed(1)}% smaller than Arm B median (target >=90%)`;
    } else if (reductionFraction > 0) {
      verdict = "WARN-DIRECTIONAL";
      reason  = `Arm A is ${(reductionFraction * 100).toFixed(1)}% smaller than Arm B median (target >=90%)`;
    } else {
      verdict = "WARN-DIRECTIONAL";
      reason  = `Arm A (${aFn} fns) is not smaller than Arm B median (${bMedianFn} fns)`;
    }
  }

  return {
    task_id:  taskId,
    verdict,
    reason,
    dry_run:  dryRun,
    single_rep: validReps.length === 1,
    arm_a: {
      reachable_functions: aFn,
      reachable_bytes:     armAResult?.reachable_bytes  ?? 0,
      reachable_files:     armAResult?.reachable_files  ?? 0,
      source:              armAResult?.source            ?? null,
    },
    arm_b: {
      median_reachable_functions: bMedianFn,
      median_reachable_bytes:     bMedianBytes,
      median_reachable_files:     bMedianFiles,
      median_cve_matches:         bMedianCve,
      min_reachable_functions:    Math.min(...bFnValues),
      max_reachable_functions:    Math.max(...bFnValues),
      reps_count:                 validReps.length,
      reps_total:                 armBReps.length,
    },
    reduction_threshold: REDUCTION_THRESHOLD,
  };
}

/**
 * Summarize an array of per-task classification results into a suite-level verdict.
 *
 * @param {Array<object>} taskResults - array of classifyArmB results
 * @returns {object} suite summary
 */
export function summarizeSuite(taskResults) {
  const passing       = taskResults.filter((r) => r.verdict === "PASS-DIRECTIONAL");
  const warning       = taskResults.filter((r) => r.verdict === "WARN-DIRECTIONAL");
  const inconclusive  = taskResults.filter((r) => r.verdict === "INCONCLUSIVE");
  const pending       = taskResults.filter((r) => r.verdict === "PENDING");

  const totalCveMatches = taskResults.reduce(
    (sum, r) => sum + (r.arm_b?.median_cve_matches ?? 0), 0
  );

  let suiteVerdict;
  if (pending.length === taskResults.length) {
    suiteVerdict = "PENDING";
  } else if (inconclusive.length === taskResults.length) {
    suiteVerdict = "INCONCLUSIVE";
  } else if (passing.length > 0 && warning.length === 0) {
    suiteVerdict = "PASS-DIRECTIONAL";
  } else {
    suiteVerdict = "WARN-DIRECTIONAL";
  }

  return {
    suite_verdict:      suiteVerdict,
    tasks_total:        taskResults.length,
    tasks_passing:      passing.length,
    tasks_warning:      warning.length,
    tasks_inconclusive: inconclusive.length,
    tasks_pending:      pending.length,
    total_cve_matches:  totalCveMatches,
    reduction_threshold: REDUCTION_THRESHOLD,
    task_verdicts:      taskResults.map((r) => ({ task_id: r.task_id, verdict: r.verdict, reason: r.reason })),
  };
}
