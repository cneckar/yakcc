// SPDX-License-Identifier: MIT
//
// bench/B4-tokens/harness/billing.mjs
//
// @decision DEC-V0-B4-BILLING-LOG-001
// @title Per-run API billing log: format, naming, retention
// @status accepted
// @rationale
//   Every Anthropic API call during a matrix run appends one JSON line to a
//   per-run billing log at tmp/B4-tokens/billing-{run-id}.jsonl.
//
//   FORMAT CHOICES
//   - JSONL (newline-delimited JSON): streaming-appendable, grep-friendly,
//     trivially parsed by any language. Each line is a self-contained JSON object.
//   - All token fields are integers (not strings): enables direct arithmetic.
//   - Both model_id_requested and model_id_actual are recorded: the harness must
//     diff these and fail loudly if the SDK silently substitutes a different model
//     (real_path_checks §3 in eval-wi-b4-matrix-harness-v2.json).
//   - cost_usd_estimated: computed from input/output/cache token counts using the
//     pricing table at the bottom of this file. This is an estimate — Anthropic
//     billing may differ by rounding. Actual cost is tracked on the Anthropic console.
//   - wall_time_ms: elapsed wall-clock milliseconds for the API call (includes
//     model inference + network round-trip). NOT inference-only time.
//
//   FILE NAMING
//   billing-{run-id}.jsonl where run-id is the harness run UUID/timestamp.
//   One file per harness invocation (not per cell or task). All rows for the
//   entire matrix run are in a single file to enable cross-cell spend tracking.
//
//   RETENTION
//   Billing logs are written to tmp/B4-tokens/ which is .gitignore'd for scratch
//   files. Billing logs that correspond to committed results JSON should be
//   committed alongside the results under bench/B4-tokens/results/.
//   Committed billing files are the authoritative cost record for each run.
//
//   SCHEMA
//   All required fields are listed in REQUIRED_BILLING_FIELDS. BillingLog.append()
//   validates presence of every required field and throws TypeError for missing ones.
//   This strict validation prevents partial-data corruption of the cost record.
//
// Exports:
//   PRICING                — per-model token price table (USD per million tokens)
//   estimateCostUsd()      — compute estimated cost from a billing entry
//   BillingLog             — append-only JSONL log writer

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

// ---------------------------------------------------------------------------
// Pricing table (USD per million tokens)
// Source: Anthropic pricing page as of 2026-05. Estimates only.
// Harness uses this for rolling cost display — actual billing via Anthropic console.
// ---------------------------------------------------------------------------

/** @type {Record<string, { input: number, output: number, cache_read: number, cache_write: number }>} */
export const PRICING = {
  // claude-haiku-4-5-20251001
  "claude-haiku-4-5-20251001": {
    input: 0.80,        // $0.80 per million input tokens
    output: 4.00,       // $4.00 per million output tokens
    cache_read: 0.08,   // $0.08 per million cache-read tokens
    cache_write: 1.00,  // $1.00 per million cache-write tokens
  },
  // claude-sonnet-4-6
  "claude-sonnet-4-6": {
    input: 3.00,
    output: 15.00,
    cache_read: 0.30,
    cache_write: 3.75,
  },
  // claude-opus-4-7 (projected — use sonnet pricing as ceiling estimate if unavailable)
  "claude-opus-4-7": {
    input: 15.00,
    output: 75.00,
    cache_read: 1.50,
    cache_write: 18.75,
  },
};

/** Fallback pricing for unknown model IDs (use Opus pricing as conservative ceiling). */
const FALLBACK_PRICING = PRICING["claude-opus-4-7"];

// ---------------------------------------------------------------------------
// Required schema fields for billing log entries
// ---------------------------------------------------------------------------

export const REQUIRED_BILLING_FIELDS = [
  "run_id",
  "cell_id",
  "task_id",
  "task_repetition",
  "input_tokens",
  "output_tokens",
  "cache_read_tokens",
  "cache_write_tokens",
  "model_id_requested",
  "model_id_actual",
  "cost_usd_estimated",
  "wall_time_ms",
  "started_at_iso",
  "finished_at_iso",
];

// ---------------------------------------------------------------------------
// estimateCostUsd
// ---------------------------------------------------------------------------

/**
 * Estimate the USD cost of one API call from token counts.
 * Uses model_id_requested for pricing lookup (we price what we asked for).
 *
 * @param {{
 *   model_id_requested: string,
 *   input_tokens: number,
 *   output_tokens: number,
 *   cache_read_tokens: number,
 *   cache_write_tokens: number
 * }} entry
 * @returns {number} Estimated cost in USD
 */
export function estimateCostUsd(entry) {
  const prices = PRICING[entry.model_id_requested] ?? FALLBACK_PRICING;
  const PER_M = 1_000_000;
  return (
    (entry.input_tokens      * prices.input)       / PER_M +
    (entry.output_tokens     * prices.output)      / PER_M +
    (entry.cache_read_tokens * prices.cache_read)  / PER_M +
    (entry.cache_write_tokens * prices.cache_write) / PER_M
  );
}

// ---------------------------------------------------------------------------
// BillingLog
// ---------------------------------------------------------------------------

/**
 * Append-only JSONL billing log for one harness run.
 *
 * @decision DEC-V0-B4-BILLING-LOG-001 (see module header)
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

    // Ensure the directory exists (does not fail if already exists)
    mkdirSync(dir, { recursive: true });
  }

  /**
   * Append one billing entry to the JSONL log.
   * Validates all required fields are present.
   *
   * @param {Record<string, unknown>} entry
   * @throws {TypeError} if required fields are missing
   */
  append(entry) {
    // Validate required fields
    const missing = REQUIRED_BILLING_FIELDS.filter((f) => !(f in entry));
    if (missing.length > 0) {
      throw new TypeError(
        `BillingLog.append(): missing required fields: ${missing.join(", ")}\n` +
        `Entry: ${JSON.stringify(entry)}`
      );
    }

    // Write one JSON line per entry
    const line = JSON.stringify(entry) + "\n";
    appendFileSync(this.logPath, line, "utf8");
    this._rowCount++;
  }

  /** @returns {number} Number of rows appended in this session */
  get rowCount() {
    return this._rowCount;
  }

  /** @returns {string} Absolute path to the log file */
  get path() {
    return this.logPath;
  }
}
