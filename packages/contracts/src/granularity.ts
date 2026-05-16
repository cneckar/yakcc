// SPDX-License-Identifier: MIT
//
// @decision DEC-WI463-GRANULARITY-001
// title: Granularity dial — interface and plumbing (WI-GRANULARITY-DIAL, #463)
// status: accepted
// rationale:
//   The emit pipeline needs a configurable dial between tight-scoped atoms
//   (high hit rate, large registry, more decomposition passes) and broadly-
//   applicable atoms (lower atomization cost, faster emission, lower hit rate).
//   This module owns the type, the valid range, the default, and the parse
//   helper. Per-level semantics (what Granularity=1 vs Granularity=5 actually
//   changes in the pipeline) are TBD from B9 (#446) and B4 (#188) sweep data;
//   this plumbing layer is deliberately decoupled from that calibration so the
//   interface can ship before the data lands.
//   Three implementation decisions (sub-items):
//   (a) Integer 1–5 chosen over a labeled enum: labeled enums require every
//       consumer to import enum members; integer literals let callers write `3`
//       or `{ granularity: 3 }` without additional imports. The union type
//       provides structural safety.
//   (b) DEFAULT_GRANULARITY = 3 (mid-range) pending benchmark data. Will be
//       updated via a @decision amendment once B9/B4 sweep identifies the
//       cost×hit-rate×attack-surface sweet spot.
//   (c) parseGranularity is a pure, total function returning null on invalid
//       input rather than throwing, so CLI argument parsers can compose it
//       without try/catch.

// ---------------------------------------------------------------------------
// Type
// ---------------------------------------------------------------------------

/**
 * Integer dial controlling atom specificity on the emit hot path.
 *
 * 1 = tightest scoping — atoms are highly specific to their declared shape;
 *     maximum decomposition; one block per micro-behaviour.
 * 3 = mid-range default — current baseline behaviour (pending benchmark data).
 * 5 = loosest scoping — atoms are broadly applicable; minimal decomposition.
 *
 * Per-level semantics (decomposition stopping rule, embedding match-threshold,
 * atom-size bucket) are calibrated from B9 (#446) and B4 (#188) sweep data.
 * See @decision DEC-WI463-GRANULARITY-001 for the full rationale.
 */
export type Granularity = 1 | 2 | 3 | 4 | 5;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Lowest valid granularity level. */
export const MIN_GRANULARITY = 1 as const;

/** Highest valid granularity level. */
export const MAX_GRANULARITY = 5 as const;

/**
 * Default granularity level.
 *
 * @decision DEC-WI463-GRANULARITY-001(b): pinned at 3 (mid-range) pending
 * B9 (#446) and B4 (#188) sweep data. Amend this decision when the
 * (cost × hit-rate × attack-surface) sweet spot is determined.
 */
export const DEFAULT_GRANULARITY: Granularity = 3;

// ---------------------------------------------------------------------------
// Parse helper
// ---------------------------------------------------------------------------

/**
 * Parse a raw string argument into a Granularity level.
 *
 * Returns the parsed Granularity (1–5) if the input is a valid integer in
 * range; returns null for any invalid input (non-integer, out-of-range, empty,
 * or non-numeric string). Never throws.
 *
 * @example
 *   parseGranularity("3") // → 3
 *   parseGranularity("0") // → null
 *   parseGranularity("6") // → null
 *   parseGranularity("abc") // → null
 */
export function parseGranularity(raw: string): Granularity | null {
  if (raw === "") return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < MIN_GRANULARITY || n > MAX_GRANULARITY) return null;
  return n as Granularity;
}
