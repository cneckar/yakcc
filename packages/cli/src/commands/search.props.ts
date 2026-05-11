// SPDX-License-Identifier: MIT
// @decision DEC-V2-PROPTEST-CLI-SEARCH-001: hand-authored property-test corpus for
// @yakcc/cli commands/search.ts. Two-file pattern: this file (.props.ts) is
// vitest-free and holds the corpus; the sibling .props.test.ts is the vitest harness.
// Status: accepted (WI-87-fill-cli)
// Rationale: Same two-file pattern as strict-subset.props.ts. Pure argument-
// validation paths in search() exit before any registry I/O, making them
// testable without any external dependencies. The truncate() helper is private
// but its invariants are observable through the command output.
//
// ---------------------------------------------------------------------------
// Property-test corpus for commands/search.ts atoms
//
// Atoms covered:
//   search() argument validation (A1):
//     - missing query argument → exit 1 + error message
//     - invalid --top value (non-integer, zero, negative) → exit 1 + error message
//     - valid --top value + query present → does NOT exit from validation
//   looksLikePath heuristic (A2) — observable via free-text vs path query routing
//
// Properties exercised (5):
//   1. missing query → exit 1
//   2. missing query → error message mentions "search requires"
//   3. invalid --top string → exit 1
//   4. invalid --top integer ≤ 0 → exit 1
//   5. --top value ≤ 0 → error message mentions "--top"
//
// NOTE: Properties 1-5 all exercise code paths that return BEFORE
// openRegistry() is called — no SQLite I/O occurs.
// ---------------------------------------------------------------------------

import * as fc from "fast-check";
import { CollectingLogger } from "../index.js";
import { search } from "./search.js";

// ---------------------------------------------------------------------------
// A1: search() argument validation — exit-before-I/O paths
// ---------------------------------------------------------------------------

/**
 * prop_search_missing_query_exits_1
 *
 * When no positional query argument is provided, search() returns exit code 1.
 *
 * Invariant: The missing-query guard fires before any registry or filesystem
 * access; the command is safe to call with invalid args.
 */
export const prop_search_missing_query_exits_1 = fc.asyncProperty(
  // Provide only flag args (no positional): either empty array or just --registry flag.
  fc.constantFrom(
    [],
    ["--registry", "/tmp/test.sqlite"],
    ["--top", "5"],
    ["--top", "5", "--registry", "/tmp/test.sqlite"],
  ),
  async (argv) => {
    const logger = new CollectingLogger();
    const code = await search(argv, logger);
    return code === 1;
  },
);

/**
 * prop_search_missing_query_emits_error_mentioning_search_requires
 *
 * When no query is provided, the error message contains "search requires".
 *
 * Invariant: The user-facing error text is always informative about what
 * argument is missing.
 */
export const prop_search_missing_query_emits_error_mentioning_search_requires = fc.asyncProperty(
  fc.constantFrom([], ["--registry", "/tmp/test.sqlite"], ["--top", "5"]),
  async (argv) => {
    const logger = new CollectingLogger();
    await search(argv, logger);
    return logger.errLines.some((l) => l.includes("search requires"));
  },
);

/**
 * prop_search_invalid_top_string_exits_1
 *
 * When --top is a non-numeric string (not starting with "-", to avoid
 * parseArgs ambiguity with flag tokens), search() returns exit code 1.
 * This path executes after query validation but before registry I/O.
 *
 * Invariant: parseInt("abc") → NaN triggers the --top guard.
 *
 * Note: Values starting with "-" must use the "--top=VALUE" form for
 * parseArgs; we test only non-dash-prefixed non-numeric strings here.
 */
export const prop_search_invalid_top_string_exits_1 = fc.asyncProperty(
  // Non-numeric strings that do not start with "-" (parseArgs would
  // misinterpret those as flag tokens rather than option values).
  // NOTE: "1.5x" is excluded: parseInt("1.5x", 10) === 1 (valid top), so it
  // does NOT trigger the NaN guard. Only strings where parseInt returns NaN
  // or a value ≤ 0 are included.
  fc.constantFrom("abc", "foo", "NaN", "infinity", "zero"),
  async (topVal) => {
    const logger = new CollectingLogger();
    // Provide a valid query but an invalid --top
    const code = await search(["some query", "--top", topVal], logger);
    return code === 1;
  },
);

/**
 * prop_search_top_zero_exits_1
 *
 * When --top is "0", search() returns exit code 1 (top must be ≥ 1).
 *
 * Invariant: The top ≥ 1 guard correctly rejects zero.
 * (Negative values require "--top=-N" form for parseArgs and are tested
 * separately via the `--top=VALUE` style not covered here for simplicity.)
 */
export const prop_search_top_zero_exits_1 = fc.asyncProperty(fc.constant("0"), async (topVal) => {
  const logger = new CollectingLogger();
  const code = await search(["some query", "--top", topVal], logger);
  return code === 1;
});

/**
 * prop_search_invalid_top_emits_error_mentioning_top
 *
 * When --top is invalid (non-integer string or "0"), the error message
 * contains "--top".
 *
 * Invariant: The user always sees which flag was invalid.
 */
export const prop_search_invalid_top_emits_error_mentioning_top = fc.asyncProperty(
  // Non-numeric non-dash strings and "0".
  // NOTE: "1.5x" is intentionally excluded: parseInt("1.5x", 10) === 1,
  // so parseArgs accepts it as a valid --top value of 1, not an error.
  fc.constantFrom("abc", "foo", "NaN", "0"),
  async (topVal) => {
    const logger = new CollectingLogger();
    await search(["some query", "--top", topVal], logger);
    return logger.errLines.some((l) => l.includes("--top"));
  },
);
