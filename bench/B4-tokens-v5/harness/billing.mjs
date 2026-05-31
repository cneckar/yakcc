// SPDX-License-Identifier: MIT
// bench/B4-tokens-v5/harness/billing.mjs
// Forked from v4. v5 adds cache_read + cache_creation price columns (PROTOCOL.md §3.3).

import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export const PRICING = {
  'claude-haiku-4-5-20251001': { input: 0.80, output: 4.00, cache_read: 0.08, cache_creation: 1.00 },
  'claude-sonnet-4-6':         { input: 3.00, output: 15.00, cache_read: 0.30, cache_creation: 3.75 },
  'claude-opus-4-7':           { input: 15.00, output: 75.00, cache_read: 1.50, cache_creation: 18.75 },
};
const FALLBACK_PRICING = PRICING['claude-opus-4-7'];

export function estimateCostUsd({ model_id, input_tokens, output_tokens, cache_read_input_tokens = 0, cache_creation_input_tokens = 0 }) {
  const p = PRICING[model_id] ?? FALLBACK_PRICING;
  return (input_tokens * p.input + output_tokens * p.output + cache_read_input_tokens * p.cache_read + cache_creation_input_tokens * p.cache_creation) / 1_000_000;
}

export class BillingLog {
  constructor({ dir, runId }) {
    this.dir = dir;
    this.runId = runId;
    this.logPath = join(dir, `billing-${runId}.jsonl`);
    this._rowCount = 0;
    mkdirSync(dir, { recursive: true });
  }
  append(entry) {
    appendFileSync(this.logPath, JSON.stringify(entry) + '\n', 'utf8');
    this._rowCount++;
  }
  get rowCount() { return this._rowCount; }
  get path() { return this.logPath; }
}
