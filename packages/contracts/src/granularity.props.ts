// SPDX-License-Identifier: MIT
// @decision DEC-WI463-GRANULARITY-PROPTEST-001: hand-authored property-test corpus
// for granularity.ts pure-function atoms. Two-file pattern: this file (.props.ts)
// is vitest-free and holds the corpus; the sibling .props.test.ts is the vitest harness.
// Status: accepted (WI-GRANULARITY-DIAL, #463)
// Rationale: parseGranularity, DEFAULT_GRANULARITY, MIN_GRANULARITY, and
// MAX_GRANULARITY are all pure (no FS, no async, no env). Property tests verify
// the invariants that make the CLI flag safe to wire: totality, null-on-invalid,
// range guards, and default stability.
//
// NOT covered here (no pure surface):
//   Granularity type itself (structural, no runtime test possible)
//
// ---------------------------------------------------------------------------
// Property-test corpus for granularity.ts
//
// Functions/constants covered:
//   DEFAULT_GRANULARITY       — constant invariant
//   MIN_GRANULARITY           — constant invariant
//   MAX_GRANULARITY           — constant invariant
//   parseGranularity          — pure string → Granularity | null
//
// Behaviors exercised:
//   C1 — DEFAULT_GRANULARITY is 3
//   C2 — MIN_GRANULARITY is 1
//   C3 — MAX_GRANULARITY is 5
//   C4 — DEFAULT_GRANULARITY is within [MIN, MAX]
//   P1 — parseGranularity totality: never throws for any string
//   P2 — parseGranularity("1") = 1 (lower bound)
//   P3 — parseGranularity("5") = 5 (upper bound)
//   P4 — parseGranularity("3") = DEFAULT_GRANULARITY
//   P5 — parseGranularity("0") = null (below range)
//   P6 — parseGranularity("6") = null (above range)
//   P7 — parseGranularity("") = null (empty string)
//   P8 — parseGranularity("abc") = null (non-numeric)
//   P9 — parseGranularity("3.5") = null (non-integer float)
//   P10 — parseGranularity("2") = 2 (interior value)
//   P11 — parseGranularity("4") = 4 (interior value)
//   P12 — parseGranularity determinism: same input → same output
//   P13 — parseGranularity("NaN") = null
//   P14 — parseGranularity("-1") = null (negative)
//   P15 — parseGranularity("  3  ") = 3 (Number() trims whitespace; CLI args never have ws)
// ---------------------------------------------------------------------------

import {
  DEFAULT_GRANULARITY,
  MAX_GRANULARITY,
  MIN_GRANULARITY,
  parseGranularity,
} from "./granularity.js";

// --- Constants ---

export function prop_DEFAULT_GRANULARITY_is_3(): boolean {
  return DEFAULT_GRANULARITY === 3;
}

export function prop_MIN_GRANULARITY_is_1(): boolean {
  return MIN_GRANULARITY === 1;
}

export function prop_MAX_GRANULARITY_is_5(): boolean {
  return MAX_GRANULARITY === 5;
}

export function prop_DEFAULT_within_range(): boolean {
  return DEFAULT_GRANULARITY >= MIN_GRANULARITY && DEFAULT_GRANULARITY <= MAX_GRANULARITY;
}

// --- parseGranularity ---

export function prop_parseGranularity_total(): boolean {
  const inputs = ["1", "3", "5", "0", "6", "", "abc", "3.5", "-1", "NaN", "  3  "];
  for (const s of inputs) {
    try {
      parseGranularity(s); // must not throw
    } catch {
      return false;
    }
  }
  return true;
}

export function prop_parseGranularity_lower_bound(): boolean {
  return parseGranularity("1") === 1;
}

export function prop_parseGranularity_upper_bound(): boolean {
  return parseGranularity("5") === 5;
}

export function prop_parseGranularity_default(): boolean {
  return parseGranularity("3") === DEFAULT_GRANULARITY;
}

export function prop_parseGranularity_below_range(): boolean {
  return parseGranularity("0") === null;
}

export function prop_parseGranularity_above_range(): boolean {
  return parseGranularity("6") === null;
}

export function prop_parseGranularity_empty_string(): boolean {
  return parseGranularity("") === null;
}

export function prop_parseGranularity_non_numeric(): boolean {
  return parseGranularity("abc") === null;
}

export function prop_parseGranularity_float(): boolean {
  return parseGranularity("3.5") === null;
}

export function prop_parseGranularity_interior_2(): boolean {
  return parseGranularity("2") === 2;
}

export function prop_parseGranularity_interior_4(): boolean {
  return parseGranularity("4") === 4;
}

export function prop_parseGranularity_determinism(): boolean {
  const inputs = ["1", "3", "5", "0", "6", "", "3.5"];
  for (const s of inputs) {
    const a = parseGranularity(s);
    const b = parseGranularity(s);
    if (a !== b) return false;
  }
  return true;
}

export function prop_parseGranularity_nan_string(): boolean {
  return parseGranularity("NaN") === null;
}

export function prop_parseGranularity_negative(): boolean {
  return parseGranularity("-1") === null;
}

export function prop_parseGranularity_whitespace_padded(): boolean {
  // Number() trims leading/trailing whitespace, so "  3  " → 3 (a valid Granularity).
  // CLI argument parsers never produce whitespace-padded values in practice.
  return parseGranularity("  3  ") === 3;
}
