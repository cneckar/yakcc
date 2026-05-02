// SPDX-License-Identifier: MIT
// @decision DEC-CONTINUOUS-SHAVE-022: Source normalization ensures that
// superficial differences (CRLF vs LF, trailing whitespace) do not produce
// distinct cache keys. The rule is intentionally minimal: only line-ending
// normalization and leading/trailing whitespace trimming. More aggressive
// normalization (e.g. removing comments) would alter the semantic content
// and produce incorrect cache hits.
// Status: decided (MASTER_PLAN.md DEC-CONTINUOUS-SHAVE-022)
// Rationale: Minimal normalization maximizes cache hit rate for the most
// common superficial differences (editor line-ending settings, trailing
// newlines) while preserving all semantically meaningful content.

/**
 * Normalize a source string for cache-key computation.
 *
 * Normalization is intentionally minimal:
 *   1. Replace all CRLF sequences with LF.
 *   2. Trim leading and trailing whitespace.
 *
 * This ensures that editor line-ending settings and trailing newlines do not
 * produce spurious cache misses. The normalized form is used only for hashing;
 * the original source text is sent to the model unchanged.
 *
 * @param s - Raw source string from the candidate block.
 * @returns Normalized string suitable for BLAKE3 hashing.
 */
export function normalizeSource(s: string): string {
  return s.replace(/\r\n/g, "\n").trim();
}
