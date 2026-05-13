// SPDX-License-Identifier: MIT
//
// bench/B4-tokens/harness/budget.mjs
//
// @decision DEC-V0-B4-BILLING-LOG-001
// @title Cost ceiling enforcement for B4 matrix runs
// @status accepted
// @rationale
//   Per DEC-V0-B4-SLICE2-COST-CEILING-004, the B4 Slice 2 matrix run is capped
//   at $75 USD total spend. The BudgetTracker class enforces this cap before every
//   API call. The cap is a hardcoded constant — no env-var bypass is supported.
//
//   ENFORCEMENT MECHANISM
//   Before each API call the harness calls checkBeforeCall(estimatedCallCostUsd).
//   If cumulative_spend + estimated_call_cost >= cap, BudgetExceededError is thrown.
//   The harness catches this error, writes partial results, and exits cleanly.
//   API calls do NOT proceed after BudgetExceededError — this is enforced by the
//   throw stopping the caller before the actual Anthropic client call.
//
//   WHY NO ENV-VAR BYPASS
//   DEC-V0-B4-SLICE2-COST-CEILING-004 explicitly forbids env-var bypass paths
//   (e.g., B4_NO_BUDGET_CAP=1). Overriding the cap requires a new DEC amendment.
//   This file does not read any budget-related environment variables.
//
//   ROLLING SPEND LOG
//   After each API call, the harness prints rolling cumulative spend to console.
//   This ensures runaway spend is visible within seconds of the first over-budget
//   call (per WI-473 requirement §7: "Print rolling spend on every API call").
//
// Exports:
//   SLICE2_CAP_USD       — $75 USD, locked by DEC-V0-B4-SLICE2-COST-CEILING-004
//   BudgetExceededError  — typed error with cumulative spend snapshot
//   BudgetTracker        — cumulative spend tracker with pre-call guard

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * B4 Slice 2 cost ceiling per DEC-V0-B4-SLICE2-COST-CEILING-004.
 * This value MUST NOT be changed without a DEC amendment.
 * No env-var override path is provided.
 */
export const SLICE2_CAP_USD = 75.0;

// ---------------------------------------------------------------------------
// BudgetExceededError
// ---------------------------------------------------------------------------

/**
 * Typed error thrown when a planned API call would exceed the cost ceiling.
 *
 * @decision DEC-V0-B4-SLICE2-COST-CEILING-004 (see module header)
 */
export class BudgetExceededError extends Error {
  /**
   * @param {{ cumulative_usd_at_throw: number, cap_usd: number, estimated_next_call_usd?: number }} opts
   */
  constructor({ cumulative_usd_at_throw, cap_usd, estimated_next_call_usd = 0 }) {
    super(
      `B4 cost ceiling exceeded: cumulative spend $${cumulative_usd_at_throw.toFixed(4)} ` +
      `(cap: $${cap_usd.toFixed(2)}, next estimated call: $${estimated_next_call_usd.toFixed(4)}). ` +
      `Harness stopping before API call. ` +
      `To run the full matrix, the $75 cap must be amended via a new DEC (no env-var bypass).`
    );
    this.name = "BudgetExceededError";
    this.cumulative_usd_at_throw = cumulative_usd_at_throw;
    this.cap_usd = cap_usd;
    this.estimated_next_call_usd = estimated_next_call_usd;
  }
}

// ---------------------------------------------------------------------------
// BudgetTracker
// ---------------------------------------------------------------------------

/**
 * Tracks cumulative API spend and enforces the cost ceiling.
 *
 * Usage:
 *   const budget = new BudgetTracker();          // default cap: $75
 *   budget.checkBeforeCall(0.003);               // throws if over cap
 *   budget.addSpend(actualCost);                 // record actual spend after call
 *   console.log(budget.cumulativeUsd);           // rolling total
 *
 * @decision DEC-V0-B4-SLICE2-COST-CEILING-004 (see module header)
 */
export class BudgetTracker {
  /**
   * @param {{ cap_usd?: number }} opts
   */
  constructor({ cap_usd } = {}) {
    /** @type {number} Cost ceiling in USD. Default: $75 per DEC-V0-B4-SLICE2-COST-CEILING-004. */
    this.cap_usd = cap_usd ?? SLICE2_CAP_USD;
    /** @type {number} Cumulative spend in USD across all recorded calls. */
    this.cumulativeUsd = 0;
    /** @type {number} Total API calls recorded. */
    this.callCount = 0;
  }

  /**
   * Check whether the next API call can proceed without exceeding the cap.
   * Throws BudgetExceededError if cumulative + estimated >= cap.
   *
   * @param {number} estimatedCallCostUsd - Estimated cost of the next API call
   * @throws {BudgetExceededError}
   */
  checkBeforeCall(estimatedCallCostUsd) {
    const projectedTotal = this.cumulativeUsd + estimatedCallCostUsd;
    if (projectedTotal >= this.cap_usd) {
      throw new BudgetExceededError({
        // cumulative_usd_at_throw is the projected total that crossed the cap,
        // so callers can assert it >= cap_usd (this is the "amount that triggered the guard").
        cumulative_usd_at_throw: projectedTotal,
        cap_usd: this.cap_usd,
        estimated_next_call_usd: estimatedCallCostUsd,
      });
    }
  }

  /**
   * Record actual spend from a completed API call.
   * Does NOT check the cap (cap is checked before the call).
   *
   * @param {number} actualCostUsd
   */
  addSpend(actualCostUsd) {
    this.cumulativeUsd += actualCostUsd;
    this.callCount++;
  }

  /**
   * Print rolling spend to console. Called after every API call.
   * @param {{ cellId: string, taskId: string, rep: number, callCost: number }} context
   */
  logRollingSpend({ cellId, taskId, rep, callCost }) {
    const pctCap = ((this.cumulativeUsd / this.cap_usd) * 100).toFixed(1);
    console.log(
      `  [BUDGET] $${this.cumulativeUsd.toFixed(4)} / $${this.cap_usd.toFixed(2)} ` +
      `(${pctCap}% of cap) — call #${this.callCount} +$${callCost.toFixed(4)} ` +
      `[${cellId} | ${taskId} rep${rep}]`
    );
  }
}
