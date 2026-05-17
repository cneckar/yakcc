// SPDX-License-Identifier: MIT
//
// bench/B4-tokens-v3/harness/classify.mjs
//
// @decision DEC-BENCH-B4-V3-CLASSIFY-001
// @title HC-1..HC-4 verdict classification for the B4-v3 hypothesis matrix
// @status accepted
// @rationale
//   Implements the four hypothesis conditions (HC-1..HC-4) defined in issue #653
//   and MASTER_PLAN.md section 2.6. Given per-task aggregate data from phase1 and
//   phase2 results, emits a per-task verdict object and an aggregate
//   hypothesis_validated boolean.
//
//   HC-1: E fails oracle OR takes ≥5× turns of A  (cheap miss is materially worse)
//   HC-2: F passes oracle                          (cheap hit produces correct output)
//   HC-3: C_F / C_A ≤ 0.2                         (cheap hit ≥5× cheaper)
//   HC-4: Q_F == Q_A                               (cheap hit matches expensive quality)
//
//   All four conditions must hold for a task to be "validated".
//   hypothesis_validated = (validated task count) / (total tasks) ≥ 0.5
//
// Exports:
//   classifyTask(taskData) -> TaskVerdict
//   classifyHypothesis(phase2Results) -> HypothesisVerdict

/**
 * @typedef {Object} TaskVerdict
 * @property {string} task_id
 * @property {boolean} HC1 - E fails oracle OR E takes ≥5× turns of A
 * @property {boolean} HC2 - F passes oracle
 * @property {boolean} HC3 - C_F / C_A ≤ 0.2
 * @property {boolean} HC4 - Q_F == Q_A (oracle pass rate match)
 * @property {boolean} validated - all four HCs hold
 * @property {Record<string, number>} metrics - raw values used in classification
 */

/**
 * @typedef {Object} HypothesisVerdict
 * @property {boolean} hypothesis_validated - ≥50% of tasks validated
 * @property {number} validated_task_count
 * @property {number} total_task_count
 * @property {number} validated_fraction
 * @property {TaskVerdict[]} task_verdicts
 */

/**
 * Aggregate per-cell stats from a list of rep results for one task.
 * Returns oracle_pass_rate and mean_cost_usd for a given cell_id.
 *
 * @param {Array<{ cell_id: string, oracle_passed: boolean, cost_usd: number, tool_cycles?: number }>} reps
 * @param {string} cellId
 * @returns {{ oracle_pass_rate: number, mean_cost_usd: number, mean_tool_cycles: number, any_oracle_pass: boolean }}
 */
function cellStats(reps, cellId) {
  const cellReps = reps.filter((r) => r.cell_id === cellId);
  if (cellReps.length === 0) {
    return { oracle_pass_rate: 0, mean_cost_usd: 0, mean_tool_cycles: 0, any_oracle_pass: false };
  }
  const passCount = cellReps.filter((r) => r.oracle_passed).length;
  const totalCost = cellReps.reduce((s, r) => s + (r.cost_usd ?? 0), 0);
  const totalCycles = cellReps.reduce((s, r) => s + (r.tool_cycles ?? 0), 0);
  return {
    oracle_pass_rate: passCount / cellReps.length,
    mean_cost_usd: totalCost / cellReps.length,
    mean_tool_cycles: totalCycles / cellReps.length,
    any_oracle_pass: passCount > 0,
  };
}

/**
 * Classify HC-1..HC-4 for a single task.
 *
 * @param {{
 *   task_id: string,
 *   reps: Array<{
 *     cell_id: string,
 *     oracle_passed: boolean,
 *     cost_usd: number,
 *     tool_cycles?: number
 *   }>
 * }} taskData
 * @returns {TaskVerdict}
 */
export function classifyTask(taskData) {
  const { task_id, reps } = taskData;

  const A = cellStats(reps, 'A'); // Opus unhooked — quality baseline
  const E = cellStats(reps, 'E'); // Haiku unhooked — expected to fail
  const F = cellStats(reps, 'F'); // Haiku hooked — expected to pass

  // HC-1: E fails oracle OR E takes ≥5× turns of A
  // "fails oracle" = no rep passed (any_oracle_pass = false)
  // "≥5× turns of A" = mean_tool_cycles of E ≥ 5 × mean_tool_cycles of A (if A has cycles)
  const eFailsOracle = !E.any_oracle_pass;
  const eTakesManyTurns = A.mean_tool_cycles > 0 && E.mean_tool_cycles >= 5 * A.mean_tool_cycles;
  const HC1 = eFailsOracle || eTakesManyTurns;

  // HC-2: F passes oracle (any rep)
  const HC2 = F.any_oracle_pass;

  // HC-3: C_F / C_A ≤ 0.2  (Haiku hooked is ≥5× cheaper than Opus unhooked)
  const costRatio = A.mean_cost_usd > 0 ? F.mean_cost_usd / A.mean_cost_usd : null;
  const HC3 = costRatio !== null ? costRatio <= 0.2 : false;

  // HC-4: Q_F == Q_A (oracle pass rates are equal within tolerance)
  // Both rates are fractions 0..1; treat as equal if |Q_F - Q_A| < 0.001 (floating point)
  const HC4 = Math.abs(F.oracle_pass_rate - A.oracle_pass_rate) < 0.001;

  const validated = HC1 && HC2 && HC3 && HC4;

  return {
    task_id,
    HC1,
    HC2,
    HC3,
    HC4,
    validated,
    metrics: {
      A_oracle_pass_rate: A.oracle_pass_rate,
      A_mean_cost_usd: A.mean_cost_usd,
      A_mean_tool_cycles: A.mean_tool_cycles,
      E_oracle_pass_rate: E.oracle_pass_rate,
      E_mean_tool_cycles: E.mean_tool_cycles,
      F_oracle_pass_rate: F.oracle_pass_rate,
      F_mean_cost_usd: F.mean_cost_usd,
      cost_ratio_F_over_A: costRatio ?? 'N/A (A cost=0)',
    },
  };
}

/**
 * Classify the full hypothesis verdict across all tasks.
 *
 * @param {{
 *   tasks: Array<{
 *     task_id: string,
 *     reps: Array<{
 *       cell_id: string,
 *       oracle_passed: boolean,
 *       cost_usd: number,
 *       tool_cycles?: number
 *     }>
 *   }>
 * }} phase2Results
 * @returns {HypothesisVerdict}
 */
export function classifyHypothesis(phase2Results) {
  const task_verdicts = phase2Results.tasks.map(classifyTask);
  const validated_task_count = task_verdicts.filter((v) => v.validated).length;
  const total_task_count = task_verdicts.length;
  const validated_fraction = total_task_count > 0
    ? validated_task_count / total_task_count
    : 0;
  const hypothesis_validated = validated_fraction >= 0.5;

  return {
    hypothesis_validated,
    validated_task_count,
    total_task_count,
    validated_fraction,
    task_verdicts,
  };
}
