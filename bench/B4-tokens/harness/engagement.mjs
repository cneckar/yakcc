// SPDX-License-Identifier: MIT
//
// bench/B4-tokens/harness/engagement.mjs
//
// @decision DEC-V0-B4-ENGAGEMENT-001
// @title Hook engagement instrumentation: per-cell tool-use cycle analysis
// @status accepted
// @rationale
//   WI-479 revealed that models invoke the yakcc atom-lookup tool (~1x per hooked
//   cell), but ALL invocations return { atoms: [] } because the offline BLAKE3
//   embedding provider produces confidence scores <0.4 for all 8 tasks, while the
//   "default" threshold is 0.7. This module adds instrumentation to:
//
//   1. Compute per-cell tool-use cycle statistics from raw measurements
//   2. Classify each substitution event outcome: usable / empty / looped
//   3. Compute engagement rate: fraction of hooked cells with >=1 non-empty result
//   4. Detect stop_reason distribution: end_turn vs tool_use vs max_tokens
//   5. Aggregate by (driver, arm, task) so hypothesis test comparisons can be
//      computed without re-running the full matrix
//
//   INTEGRATION
//   This module operates on the `measurements` array that run.mjs produces.
//   It has zero API spend — it's pure analysis over already-collected data.
//   run.mjs's `callAnthropicForCell` already records `tool_cycle_count`,
//   `hook_non_engaged`, and `substitution_events` per cell; this module
//   aggregates those into a richer engagement report.
//
//   SCHEMA ADDITIONS (for new runs)
//   The engagement fields below are added to each hooked measurement row:
//   - tool_cycle_count: number (already exists)
//   - hook_non_engaged: boolean (already exists)
//   - substitution_events: Array<SubstitutionEvent> (already exists)
//   - engagement_classification: "active" | "non-engaged" | "empty-results" | "looped"
//   - stop_reason_first: string (stop_reason of the initial API response)
//   - atoms_returned_total: number (sum of atoms_proposed across all cycles)
//   - distinct_intents: number (distinct intent strings queried)
//
//   HYPOTHESIS TEST SUPPORT
//   aggregateEngagement() produces a EngagementReport used to compare:
//   - H1: prompt variant → engagement_rate comparison
//   - H2: force-tool-call → engagement_rate comparison
//   - H3: task LOC → engagement_rate by task_size_bucket
//   - H4: registry coverage → engagement_rate correlation with has_candidate_above_threshold
//
// Exports:
//   classifyEngagement(measurement)  → EngagementClassification
//   aggregateEngagement(measurements) → EngagementReport
//   computeEngagementDelta(baseline, variant) → EngagementDelta
//   ENGAGEMENT_CLASSIFICATIONS — canonical classification strings
//
// Cross-reference:
//   harness/run.mjs DEC-V0-B4-HOOK-WIRING-001 (tool_cycle_count, substitution_events)
//   harness/matrix.mjs (DRIVERS, SWEEP_POSITIONS)
//   WI-479 engagement investigation findings
//   GitHub issues #188 (dossier), #479 (investigation WI)

// ---------------------------------------------------------------------------
// Classification constants
// ---------------------------------------------------------------------------

/**
 * Canonical engagement classification values.
 *
 * - "non-engaged":  tool_cycle_count === 0; model never called the tool.
 * - "empty-results": model called the tool but all cycles returned 0 atoms.
 * - "active":        model called the tool and at least 1 cycle returned >= 1 atom.
 * - "looped":        tool_cycle_count >= MAX_TOOL_CYCLES (hit cycle ceiling).
 * - "unhooked":      measurement is from the unhooked arm; tool not available.
 */
export const ENGAGEMENT_CLASSIFICATIONS = Object.freeze({
  NON_ENGAGED:  "non-engaged",
  EMPTY_RESULTS: "empty-results",
  ACTIVE:       "active",
  LOOPED:       "looped",
  UNHOOKED:     "unhooked",
});

/** Maximum tool cycles per cell (matches run.mjs MAX_TOOL_CYCLES). */
export const MAX_TOOL_CYCLES = 5;

// ---------------------------------------------------------------------------
// classifyEngagement
// ---------------------------------------------------------------------------

/**
 * Classify a single measurement's hook engagement level.
 *
 * For unhooked arm measurements, classification is always "unhooked".
 * For hooked arm measurements:
 *   - 0 cycles → "non-engaged"
 *   - cycles < MAX_TOOL_CYCLES AND all atoms_proposed === 0 → "empty-results"
 *   - cycles >= MAX_TOOL_CYCLES → "looped"
 *   - at least 1 cycle with atoms_proposed > 0 → "active"
 *
 * @param {object} measurement - One row from measurements array in results JSON
 * @param {string} measurement.arm - "hooked" | "unhooked"
 * @param {number} [measurement.tool_cycle_count] - Number of tool_use cycles
 * @param {boolean} [measurement.hook_non_engaged] - True if 0 cycles
 * @param {Array<{atoms_proposed: number}>} [measurement.substitution_events]
 * @returns {{ classification: string, atoms_returned_total: number, distinct_intents: number }}
 */
export function classifyEngagement(measurement) {
  if (measurement.arm !== "hooked") {
    return {
      classification: ENGAGEMENT_CLASSIFICATIONS.UNHOOKED,
      atoms_returned_total: 0,
      distinct_intents: 0,
    };
  }

  const cycles = measurement.tool_cycle_count ?? 0;
  const subEvents = measurement.substitution_events ?? [];

  const atomsReturnedTotal = subEvents.reduce(
    (sum, ev) => sum + (ev.atoms_proposed ?? 0),
    0
  );

  const distinctIntents = new Set(
    subEvents
      .map((ev) => (ev.intent ?? "").trim().toLowerCase())
      .filter(Boolean)
  ).size;

  if (cycles === 0) {
    return {
      classification: ENGAGEMENT_CLASSIFICATIONS.NON_ENGAGED,
      atoms_returned_total: 0,
      distinct_intents: 0,
    };
  }

  if (cycles >= MAX_TOOL_CYCLES) {
    return {
      classification: ENGAGEMENT_CLASSIFICATIONS.LOOPED,
      atoms_returned_total: atomsReturnedTotal,
      distinct_intents: distinctIntents,
    };
  }

  if (atomsReturnedTotal > 0) {
    return {
      classification: ENGAGEMENT_CLASSIFICATIONS.ACTIVE,
      atoms_returned_total: atomsReturnedTotal,
      distinct_intents: distinctIntents,
    };
  }

  return {
    classification: ENGAGEMENT_CLASSIFICATIONS.EMPTY_RESULTS,
    atoms_returned_total: 0,
    distinct_intents: distinctIntents,
  };
}

// ---------------------------------------------------------------------------
// aggregateEngagement
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} EngagementCellStats
 * @property {number} n - Total measurements in this group
 * @property {number} total_tool_cycles - Sum of tool_cycle_count across all cells
 * @property {number} mean_tool_cycles - Mean cycles per cell
 * @property {number} cells_non_engaged - Count where classification === "non-engaged"
 * @property {number} cells_empty_results - Count where classification === "empty-results"
 * @property {number} cells_active - Count where classification === "active"
 * @property {number} cells_looped - Count where classification === "looped"
 * @property {number} engagement_rate - fraction with "active" classification
 * @property {number} tool_invocation_rate - fraction with >=1 tool cycle (non-engaged excluded)
 * @property {number} atoms_returned_total - sum across all cells
 * @property {number} mean_atoms_per_cycle - atoms_returned_total / total_tool_cycles
 * @property {Record<string, number>} cycle_distribution - cycle_count → frequency map
 */

/**
 * @typedef {Object} EngagementReport
 * @property {EngagementCellStats} overall - Stats across all measurements
 * @property {Record<string, EngagementCellStats>} by_driver - Stats per driver
 * @property {Record<string, EngagementCellStats>} by_task - Stats per task_id
 * @property {Record<string, EngagementCellStats>} by_arm - Stats per arm ("hooked"|"unhooked")
 * @property {number} hooked_measurement_count - Count of hooked arm measurements only
 * @property {string} root_cause_hypothesis - Derived from data patterns
 * @property {string[]} findings - Human-readable bullet points
 */

/**
 * Aggregate engagement statistics from a measurements array.
 *
 * @param {object[]} measurements - measurements array from results JSON
 * @returns {EngagementReport}
 */
export function aggregateEngagement(measurements) {
  if (!Array.isArray(measurements) || measurements.length === 0) {
    return _emptyReport();
  }

  const allStats = _computeGroupStats(measurements);
  const byDriver = _groupBy(measurements, (m) => m.driver ?? "unknown");
  const byTask   = _groupBy(measurements, (m) => m.task_id ?? "unknown");
  const byArm    = _groupBy(measurements, (m) => m.arm ?? "unknown");

  const hookedOnly = measurements.filter((m) => m.arm === "hooked");

  // Derive root cause hypothesis from data patterns
  const rootCause = _deriveRootCause(allStats, measurements);
  const findings  = _deriveFindings(allStats, hookedOnly);

  return {
    overall:                 allStats,
    by_driver:               Object.fromEntries(
      Object.entries(byDriver).map(([k, v]) => [k, _computeGroupStats(v)])
    ),
    by_task:                 Object.fromEntries(
      Object.entries(byTask).map(([k, v]) => [k, _computeGroupStats(v)])
    ),
    by_arm:                  Object.fromEntries(
      Object.entries(byArm).map(([k, v]) => [k, _computeGroupStats(v)])
    ),
    hooked_measurement_count: hookedOnly.length,
    root_cause_hypothesis:   rootCause,
    findings,
  };
}

// ---------------------------------------------------------------------------
// computeEngagementDelta
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} EngagementDelta
 * @property {number} engagement_rate_delta - variant.engagement_rate - baseline.engagement_rate
 * @property {number} tool_invocation_rate_delta
 * @property {number} mean_tool_cycles_delta
 * @property {number} atoms_returned_total_delta
 * @property {string} verdict - "improved" | "degraded" | "neutral"
 */

/**
 * Compute the engagement change between a baseline and variant EngagementCellStats.
 *
 * Used to compare hypothesis test arms (e.g., H2 forced vs unforced, H1 prompt variants).
 *
 * @param {EngagementCellStats} baseline
 * @param {EngagementCellStats} variant
 * @returns {EngagementDelta}
 */
export function computeEngagementDelta(baseline, variant) {
  const erDelta  = variant.engagement_rate - baseline.engagement_rate;
  const tirDelta = variant.tool_invocation_rate - baseline.tool_invocation_rate;
  const cycleDelta = variant.mean_tool_cycles - baseline.mean_tool_cycles;
  const atomsDelta = variant.atoms_returned_total - baseline.atoms_returned_total;

  let verdict;
  if (erDelta > 0.05) verdict = "improved";
  else if (erDelta < -0.05) verdict = "degraded";
  else verdict = "neutral";

  return {
    engagement_rate_delta:       erDelta,
    tool_invocation_rate_delta:  tirDelta,
    mean_tool_cycles_delta:      cycleDelta,
    atoms_returned_total_delta:  atomsDelta,
    verdict,
  };
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/**
 * Compute aggregated stats for a group of measurements.
 * @param {object[]} group
 * @returns {EngagementCellStats}
 */
function _computeGroupStats(group) {
  let totalCycles      = 0;
  let cellsNonEngaged  = 0;
  let cellsEmptyRes    = 0;
  let cellsActive      = 0;
  let cellsLooped      = 0;
  let atomsTotal       = 0;
  const cycleDist      = {};

  for (const m of group) {
    const { classification, atoms_returned_total } = classifyEngagement(m);
    const cycles = m.tool_cycle_count ?? 0;

    totalCycles += cycles;
    atomsTotal  += atoms_returned_total;

    // Cycle distribution (exclude unhooked)
    if (m.arm === "hooked") {
      const key = String(cycles);
      cycleDist[key] = (cycleDist[key] ?? 0) + 1;
    }

    switch (classification) {
      case ENGAGEMENT_CLASSIFICATIONS.NON_ENGAGED:   cellsNonEngaged++; break;
      case ENGAGEMENT_CLASSIFICATIONS.EMPTY_RESULTS: cellsEmptyRes++;   break;
      case ENGAGEMENT_CLASSIFICATIONS.ACTIVE:        cellsActive++;      break;
      case ENGAGEMENT_CLASSIFICATIONS.LOOPED:        cellsLooped++;      break;
      // "unhooked" — no classification bucket
    }
  }

  const n             = group.length;
  const hookedCount   = group.filter((m) => m.arm === "hooked").length;
  const engagementRate    = hookedCount > 0 ? cellsActive / hookedCount : 0;
  const toolInvocRate     = hookedCount > 0
    ? (cellsEmptyRes + cellsActive + cellsLooped) / hookedCount
    : 0;
  const meanCycles        = n > 0 ? totalCycles / n : 0;
  const meanAtomsPerCycle = totalCycles > 0 ? atomsTotal / totalCycles : 0;

  return {
    n,
    total_tool_cycles:    totalCycles,
    mean_tool_cycles:     meanCycles,
    cells_non_engaged:    cellsNonEngaged,
    cells_empty_results:  cellsEmptyRes,
    cells_active:         cellsActive,
    cells_looped:         cellsLooped,
    engagement_rate:      engagementRate,
    tool_invocation_rate: toolInvocRate,
    atoms_returned_total: atomsTotal,
    mean_atoms_per_cycle: meanAtomsPerCycle,
    cycle_distribution:   cycleDist,
  };
}

/**
 * Group an array of objects by a key function.
 * @param {object[]} arr
 * @param {(item: object) => string} keyFn
 * @returns {Record<string, object[]>}
 */
function _groupBy(arr, keyFn) {
  const result = {};
  for (const item of arr) {
    const key = keyFn(item);
    if (!result[key]) result[key] = [];
    result[key].push(item);
  }
  return result;
}

/**
 * Derive a root cause hypothesis from engagement statistics.
 * @param {EngagementCellStats} stats
 * @param {object[]} measurements
 * @returns {string}
 */
function _deriveRootCause(stats, measurements) {
  const hookedOnly = measurements.filter((m) => m.arm === "hooked");
  if (hookedOnly.length === 0) return "no-hooked-measurements";

  if (stats.cells_non_engaged === hookedOnly.length) {
    return "H1-or-H2: models never invoked tool; prompt motivation insufficient or tool declarations not compelling";
  }

  if (stats.cells_empty_results === hookedOnly.length) {
    return "H4: registry coverage gap — models invoke tool but receive empty results due to low confidence scores or missing atoms";
  }

  const emptyPct = hookedOnly.length > 0
    ? stats.cells_empty_results / hookedOnly.length
    : 0;

  if (emptyPct > 0.8) {
    return "H4-dominant: >80% of tool invocations return empty results; registry coverage is the primary bottleneck";
  }

  if (stats.engagement_rate > 0.5) {
    return "mostly-engaged: majority of cells receive useful atoms; investigate token cost model for negative-token-delta";
  }

  return "mixed: partial engagement; H1+H4 may both apply";
}

/**
 * Derive human-readable findings bullets from engagement stats.
 * @param {EngagementCellStats} stats
 * @param {object[]} hookedOnly
 * @returns {string[]}
 */
function _deriveFindings(stats, hookedOnly) {
  const findings = [];

  findings.push(
    `Tool invocation rate: ${(stats.tool_invocation_rate * 100).toFixed(1)}% ` +
    `(${stats.cells_empty_results + stats.cells_active + stats.cells_looped}/${hookedOnly.length} hooked cells called the tool at least once)`
  );

  findings.push(
    `Engagement rate (active): ${(stats.engagement_rate * 100).toFixed(1)}% ` +
    `(cells where tool returned >=1 atom)`
  );

  findings.push(
    `Non-engaged cells: ${stats.cells_non_engaged} ` +
    `(model did not call tool despite it being available)`
  );

  findings.push(
    `Empty-result cells: ${stats.cells_empty_results} ` +
    `(model called tool but received { atoms: [] } every time)`
  );

  findings.push(
    `Total tool cycles: ${stats.total_tool_cycles} | ` +
    `Mean: ${stats.mean_tool_cycles.toFixed(2)} cycles/cell | ` +
    `Atoms returned: ${stats.atoms_returned_total}`
  );

  if (stats.atoms_returned_total === 0 && stats.total_tool_cycles > 0) {
    findings.push(
      "CRITICAL: All tool invocations returned empty atom lists. " +
      "The token overhead (+input from tool conversation turns) provides zero benefit. " +
      "This explains why hooked arm uses MORE tokens than unhooked arm."
    );
  }

  return findings;
}

/**
 * Return a structurally valid empty report.
 * @returns {EngagementReport}
 */
function _emptyReport() {
  const emptyStats = {
    n: 0,
    total_tool_cycles: 0,
    mean_tool_cycles: 0,
    cells_non_engaged: 0,
    cells_empty_results: 0,
    cells_active: 0,
    cells_looped: 0,
    engagement_rate: 0,
    tool_invocation_rate: 0,
    atoms_returned_total: 0,
    mean_atoms_per_cycle: 0,
    cycle_distribution: {},
  };
  return {
    overall: emptyStats,
    by_driver: {},
    by_task: {},
    by_arm: {},
    hooked_measurement_count: 0,
    root_cause_hypothesis: "no-data",
    findings: ["No measurements provided"],
  };
}
