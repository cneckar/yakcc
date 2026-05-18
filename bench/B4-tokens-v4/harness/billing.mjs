// SPDX-License-Identifier: MIT
//
// bench/B4-tokens-v3/harness/billing.mjs
//
// @decision DEC-BENCH-B4-V3-BILLING-001
// @title B4-v3 per-run API billing log: pricing + JSONL append log
// @status accepted
// @rationale
//   Extracted from inline phase1.mjs and phase2.mjs cost tracking for reuse
//   and budget enforcement. Mirrors bench/B4-tokens/harness/billing.mjs structure
//   with the same pricing table and BillingLog class.
//
//   Every Anthropic API call appends one JSON line to a per-run billing log.
//   Cost estimates use model_id_requested for pricing lookup.
//
// Exports:
//   PRICING                — per-model token price table (USD per million tokens)
//   estimateCostUsd()      — compute estimated cost from token counts
//   BillingLog             — append-only JSONL log writer

import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

/** @type {Record<string, { input: number, output: number }>} */
export const PRICING = {
  'claude-haiku-4-5-20251001': { input: 0.80, output: 4.00 },
  'claude-sonnet-4-6':         { input: 3.00, output: 15.00 },
  'claude-opus-4-7':           { input: 15.00, output: 75.00 },
};

const FALLBACK_PRICING = PRICING['claude-opus-4-7'];

/**
 * Estimate the USD cost of one API call from token counts.
 *
 * @param {{ model_id: string, input_tokens: number, output_tokens: number }} entry
 * @returns {number} Estimated cost in USD
 */
export function estimateCostUsd({ model_id, input_tokens, output_tokens }) {
  const prices = PRICING[model_id] ?? FALLBACK_PRICING;
  return (input_tokens * prices.input + output_tokens * prices.output) / 1_000_000;
}

/**
 * Append-only JSONL billing log for one harness run.
 */
export class BillingLog {
  /**
   * @param {{ dir: string, runId: string }} opts
   */
  constructor({ dir, runId }) {
    this.dir = dir;
    this.runId = runId;
    this.logPath = join(dir, `billing-${runId}.jsonl`);
    this._rowCount = 0;
    mkdirSync(dir, { recursive: true });
  }

  /**
   * Append one billing entry to the JSONL log.
   * @param {Record<string, unknown>} entry
   */
  append(entry) {
    appendFileSync(this.logPath, JSON.stringify(entry) + '\n', 'utf8');
    this._rowCount++;
  }

  get rowCount() { return this._rowCount; }
  get path() { return this.logPath; }
}
