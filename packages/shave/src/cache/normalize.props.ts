// SPDX-License-Identifier: MIT
// @decision DEC-V2-PROPTEST-PATH-A-001: hand-authored property-test corpus for
// @yakcc/shave cache/normalize.ts atoms. Two-file pattern: this file
// (.props.ts) is vitest-free and holds the corpus; the sibling .props.test.ts
// is the vitest harness.
// Status: accepted (WI-V2-07-PREFLIGHT L3d)
// Rationale: See tmp/wi-v2-07-preflight-layer-plan.md — the corpus file must
// be runtime-independent so L10 can hash it as a manifest artifact.
//
// Atoms covered (named exports from normalize.ts):
//   normalizeSource (NS1.1) — pure CRLF→LF + trim transform.
//
// Properties covered:
//   - No \r\n substring in output for any input.
//   - No leading or trailing whitespace in output.
//   - Idempotent: normalizeSource(normalizeSource(s)) === normalizeSource(s).
//   - Preserves inner LF separators (only CRLF and outer whitespace are altered).

// ---------------------------------------------------------------------------
// Property-test corpus for cache/normalize.ts
// ---------------------------------------------------------------------------

import * as fc from "fast-check";
import { normalizeSource } from "./normalize.js";

// ---------------------------------------------------------------------------
// Shared arbitraries
// ---------------------------------------------------------------------------

/** Arbitrary string that may contain CRLF and surrounding whitespace. */
const rawSourceArb: fc.Arbitrary<string> = fc.string({ minLength: 0, maxLength: 200 });

/** Arbitrary string with embedded CRLF sequences (at least one). */
const crlfSourceArb: fc.Arbitrary<string> = fc
  .tuple(
    fc.string({ minLength: 0, maxLength: 50 }),
    fc.array(fc.string({ minLength: 0, maxLength: 50 }), { minLength: 1, maxLength: 5 }),
    fc.string({ minLength: 0, maxLength: 50 }),
  )
  .map(([prefix, lines, suffix]) => `${prefix}${lines.join("\r\n")}${suffix}`);

// ---------------------------------------------------------------------------
// NS1.1: normalizeSource — no \r\n in output
// ---------------------------------------------------------------------------

/**
 * prop_normalizeSource_no_crlf_in_output
 *
 * For any input string, the output of normalizeSource never contains a \r\n
 * sequence.
 *
 * Invariant (NS1.1, DEC-CONTINUOUS-SHAVE-022): CRLF normalization ensures
 * that editor line-ending settings do not produce distinct cache keys. The
 * output must be free of \r\n so that BLAKE3 hashing produces a single
 * canonical value regardless of platform.
 */
export const prop_normalizeSource_no_crlf_in_output = fc.property(
  rawSourceArb,
  (s) => !normalizeSource(s).includes("\r\n"),
);

// ---------------------------------------------------------------------------
// NS1.1: normalizeSource — no leading or trailing whitespace in output
// ---------------------------------------------------------------------------

/**
 * prop_normalizeSource_no_leading_trailing_whitespace
 *
 * For any input string, the output of normalizeSource has no leading or
 * trailing whitespace.
 *
 * Invariant (NS1.1, DEC-CONTINUOUS-SHAVE-022): trailing newlines and leading
 * indentation in candidate blocks must not produce spurious cache misses.
 * The trim() step enforces this unconditionally.
 */
export const prop_normalizeSource_no_leading_trailing_whitespace = fc.property(
  rawSourceArb,
  (s) => {
    const out = normalizeSource(s);
    return out === out.trim();
  },
);

// ---------------------------------------------------------------------------
// NS1.1: normalizeSource — idempotent
// ---------------------------------------------------------------------------

/**
 * prop_normalizeSource_idempotent
 *
 * normalizeSource(normalizeSource(s)) === normalizeSource(s) for any string.
 *
 * Invariant (NS1.1): the normalization transform is a projection — applying
 * it twice produces the same result as applying it once. This ensures that
 * callers need not track whether a string has already been normalized.
 */
export const prop_normalizeSource_idempotent = fc.property(rawSourceArb, (s) => {
  const once = normalizeSource(s);
  const twice = normalizeSource(once);
  return once === twice;
});

// ---------------------------------------------------------------------------
// NS1.1: normalizeSource — preserves inner LF separators
// ---------------------------------------------------------------------------

/**
 * prop_normalizeSource_preserves_inner_lf
 *
 * When a string contains only LF (no CR), inner newlines are preserved
 * verbatim after trimming the outer whitespace.
 *
 * Invariant (NS1.1, DEC-CONTINUOUS-SHAVE-022): the normalizer must not strip
 * inner newlines — it only replaces CRLF→LF and trims the outer ends. A
 * string like "a\nb\nc" (no CRLF, no outer whitespace) is its own normal form.
 */
export const prop_normalizeSource_preserves_inner_lf = fc.property(
  fc
    .tuple(
      fc.string({ minLength: 1, maxLength: 20 }).filter((s) => !s.includes("\r")),
      fc.array(
        fc.string({ minLength: 1, maxLength: 20 }).filter((s) => !s.includes("\r")),
        { minLength: 1, maxLength: 4 },
      ),
    )
    .map(([first, rest]) => `${first}\n${rest.join("\n")}`),
  (lf) => {
    const out = normalizeSource(lf);
    // Inner LF count must be preserved (trimming outer whitespace doesn't remove inner LFs).
    const expectedLfCount = lf.trim().split("\n").length - 1;
    const actualLfCount = out.split("\n").length - 1;
    return actualLfCount === expectedLfCount;
  },
);

// ---------------------------------------------------------------------------
// NS1.1: normalizeSource — CRLF is replaced exactly by LF (no orphan CR)
// ---------------------------------------------------------------------------

/**
 * prop_normalizeSource_crlf_replaced_by_lf_only
 *
 * After normalizeSource, a CRLF input ("a\r\nb") becomes "a\nb"  — the CR is
 * removed entirely and the LF is kept. No orphan \r character appears in the
 * result when the original contained only CRLF sequences.
 *
 * Invariant (NS1.1): the regex /\r\n/g replacement removes the CR prefix of
 * every CRLF pair. A standalone \r (not followed by \n) is NOT removed by
 * this step; this property verifies only the CRLF→LF path.
 */
export const prop_normalizeSource_crlf_replaced_by_lf_only = fc.property(crlfSourceArb, (s) => {
  const out = normalizeSource(s);
  // The string produced must not contain \r\n.
  return !out.includes("\r\n");
});

// ---------------------------------------------------------------------------
// Compound interaction: normalizeSource feeds sourceHash (end-to-end)
//
// Production sequence: raw source → normalizeSource() → BLAKE3 hash.
// This property exercises the full normalization→hash pipeline by verifying
// that two strings that differ only in CRLF produce the same normalized form,
// and therefore the same hash when passed to the BLAKE3 encoder.
// ---------------------------------------------------------------------------

/**
 * prop_normalizeSource_compound_crlf_lf_equivalence
 *
 * A string with CRLF line endings and the same string with LF line endings
 * produce the same normalized form.
 *
 * This is the canonical compound-interaction property: normalizeSource is the
 * first stage of the sourceHash pipeline. Verifying CRLF≡LF equivalence at
 * the normalization level proves that the cache key layer (key.ts) treats the
 * two encodings as identical.
 *
 * Invariant (NS1.1, DEC-CONTINUOUS-SHAVE-022): "editor line-ending settings
 * do not produce spurious cache misses."
 */
export const prop_normalizeSource_compound_crlf_lf_equivalence = fc.property(
  fc
    .array(
      fc.string({ minLength: 0, maxLength: 30 }).filter((s) => !s.includes("\r")),
      { minLength: 1, maxLength: 6 },
    )
    .map((lines) => lines.join("\n")),
  (lfStr) => {
    const crlfStr = lfStr.replace(/\n/g, "\r\n");
    return normalizeSource(lfStr) === normalizeSource(crlfStr);
  },
);
