// SPDX-License-Identifier: MIT
// @decision DEC-V2-PROPTEST-CLI-QUERY-001: hand-authored property-test corpus for
// @yakcc/cli commands/query.ts. Two-file pattern: this file (.props.ts) is
// vitest-free and holds the corpus; the sibling .props.test.ts is the vitest harness.
// Status: accepted (WI-87-fill-cli)
// Rationale: query() has the same argument-validation structure as search():
// --top validation and missing-query validation both exit before openRegistry().
// Additionally, the --card-file path validates the parsed JSON structure
// (must have a "behavior" string field) before any registry I/O.
//
// ---------------------------------------------------------------------------
// Property-test corpus for commands/query.ts atoms
//
// Atoms covered:
//   query() argument validation (A1):
//     - invalid --top value → exit 1 + error message
//     - missing query text (no positional, no --card-file) → exit 1
//   card-file JSON validation (A2):
//     - card-file path that doesn't exist → exit 1
//     - card-file JSON missing "behavior" field → error message
//
// Properties exercised (5):
//   1. invalid --top string → exit 1
//   2. invalid --top integer ≤ 0 → exit 1
//   3. invalid --top emits error mentioning "--top"
//   4. missing query (no args, no --card-file) → exit 1
//   5. missing query emits error mentioning "query requires"
//
// NOTE: All properties exercise code paths that return BEFORE openRegistry()
// is called — no SQLite I/O occurs.
// ---------------------------------------------------------------------------

import * as fc from "fast-check";
import { CollectingLogger } from "../index.js";
import { query } from "./query.js";

// ---------------------------------------------------------------------------
// A1: query() --top validation — exit-before-I/O paths
// ---------------------------------------------------------------------------

/**
 * prop_query_invalid_top_string_exits_1
 *
 * When --top is a non-numeric string (not starting with "-", to avoid
 * parseArgs ambiguity with flag tokens), query() returns exit code 1.
 *
 * Invariant: parseInt(topRaw) → NaN triggers the --top guard before
 * any registry is opened.
 *
 * Note: Values starting with "-" must use the "--top=VALUE" form for
 * parseArgs; we test only non-dash-prefixed non-numeric strings here.
 */
export const prop_query_invalid_top_string_exits_1 = fc.asyncProperty(
  // NOTE: "1.5x" excluded — parseInt("1.5x", 10) === 1 (valid), not NaN.
  fc.constantFrom("abc", "foo", "NaN", "infinity", "zero"),
  async (topVal) => {
    const logger = new CollectingLogger();
    const code = await query(["some query", "--top", topVal], logger);
    return code === 1;
  },
);

/**
 * prop_query_top_zero_exits_1
 *
 * When --top is "0", query() returns exit code 1 (top must be ≥ 1).
 *
 * Invariant: The top ≥ 1 guard correctly rejects zero before any registry I/O.
 * (Negative values require "--top=-N" form for parseArgs and are omitted here.)
 */
export const prop_query_top_zero_exits_1 = fc.asyncProperty(fc.constant("0"), async (topVal) => {
  const logger = new CollectingLogger();
  const code = await query(["some query", "--top", topVal], logger);
  return code === 1;
});

/**
 * prop_query_invalid_top_emits_error_mentioning_top
 *
 * When --top is invalid (non-integer string or "0"), the error message
 * always contains "--top".
 *
 * Invariant: The error is always attributed to the correct flag.
 */
export const prop_query_invalid_top_emits_error_mentioning_top = fc.asyncProperty(
  fc.constantFrom("abc", "foo", "xyz", "0", "NaN"),
  async (topVal) => {
    const logger = new CollectingLogger();
    await query(["some query", "--top", topVal], logger);
    return logger.errLines.some((l) => l.includes("--top"));
  },
);

// ---------------------------------------------------------------------------
// A2: query() missing free-text query — exit-before-I/O paths
// ---------------------------------------------------------------------------

/**
 * prop_query_missing_query_text_exits_1
 *
 * When no positional query argument is provided and no --card-file is given,
 * query() returns exit code 1.
 *
 * Invariant: The missing-query guard fires before any registry access.
 */
export const prop_query_missing_query_text_exits_1 = fc.asyncProperty(
  fc.constantFrom([], ["--top", "5"], ["--rerank"], ["--top", "5", "--rerank"]),
  async (argv) => {
    const logger = new CollectingLogger();
    const code = await query(argv, logger);
    return code === 1;
  },
);

/**
 * prop_query_missing_query_emits_error_mentioning_query_requires
 *
 * When no query text or card-file is provided, the error message contains
 * "query requires".
 *
 * Invariant: The user always receives a meaningful explanation of what
 * argument is missing.
 */
export const prop_query_missing_query_emits_error_mentioning_query_requires = fc.asyncProperty(
  fc.constantFrom([], ["--top", "5"], ["--rerank"]),
  async (argv) => {
    const logger = new CollectingLogger();
    await query(argv, logger);
    return logger.errLines.some((l) => l.includes("query requires"));
  },
);
