// SPDX-License-Identifier: MIT
//
// bench/B4-tokens-v3/harness/budget.mjs
//
// @decision DEC-BENCH-B4-V3-BUDGET-001
// @title B4-v3 cost ceiling enforcement ($75 total, per DEC-V0-B4-SLICE2-COST-CEILING-004)
// @status accepted
// @rationale
//   Mirrors bench/B4-tokens/harness/budget.mjs. The $75 cap is shared with the
//   original B4 Slice 2 cost ceiling (DEC-V0-B4-SLICE2-COST-CEILING-004).
//   BudgetTracker checks before every API call; throws BudgetExceededError if
//   cumulative + estimated >= cap. No env-var bypass — override requires a new DEC.
//
// Exports:
//   SLICE2_CAP_USD       — $75 USD
//   BudgetExceededError  — typed error with cumulative spend snapshot
//   BudgetTracker        — cumulative spend tracker with pre-call guard

export const SLICE2_CAP_USD = 75.0;

export class BudgetExceededError extends Error {
  constructor({ cumulative_usd_at_throw, cap_usd, estimated_next_call_usd = 0 }) {
    super(
      `B4-v3 cost ceiling exceeded: cumulative $${cumulative_usd_at_throw.toFixed(4)} ` +
      `(cap: $${cap_usd.toFixed(2)}, next estimated: $${estimated_next_call_usd.toFixed(4)}). ` +
      `Harness stopping before API call.`
    );
    this.name = 'BudgetExceededError';
    this.cumulative_usd_at_throw = cumulative_usd_at_throw;
    this.cap_usd = cap_usd;
    this.estimated_next_call_usd = estimated_next_call_usd;
  }
}

export class BudgetTracker {
  constructor({ cap_usd } = {}) {
    this.cap_usd = cap_usd ?? SLICE2_CAP_USD;
    this.cumulativeUsd = 0;
    this.callCount = 0;
  }

  checkBeforeCall(estimatedCallCostUsd) {
    const projectedTotal = this.cumulativeUsd + estimatedCallCostUsd;
    if (projectedTotal >= this.cap_usd) {
      throw new BudgetExceededError({
        cumulative_usd_at_throw: projectedTotal,
        cap_usd: this.cap_usd,
        estimated_next_call_usd: estimatedCallCostUsd,
      });
    }
  }

  addSpend(actualCostUsd) {
    this.cumulativeUsd += actualCostUsd;
    this.callCount++;
  }

  logRollingSpend({ phase, taskId, rep, callCost }) {
    const pctCap = ((this.cumulativeUsd / this.cap_usd) * 100).toFixed(1);
    console.log(
      `  [BUDGET] $${this.cumulativeUsd.toFixed(4)} / $${this.cap_usd.toFixed(2)} ` +
      `(${pctCap}%) — call #${this.callCount} +$${callCost.toFixed(4)} ` +
      `[phase${phase} | ${taskId} rep${rep}]`
    );
  }
}
