// SPDX-License-Identifier: MIT
// Vitest harness for canonical-ast.props.ts
// Two-file pattern: this file is the thin vitest wrapper; the corpus lives in
// the sibling canonical-ast.props.ts (vitest-free, hashable as a manifest artifact).

import * as fc from "fast-check";
import { it } from "vitest";
import {
  prop_CanonicalAstParseError_cause_preserved,
  prop_CanonicalAstParseError_message_preserved,
  prop_CanonicalAstParseError_name_constant,
  prop_canonicalAstHash_deterministic,
  prop_canonicalAstHash_format_brand,
  prop_canonicalAstHash_throws_on_invalid,
  prop_canonicalAstHash_whitespace_invariant,
} from "./canonical-ast.props.js";

// canonicalAstHash properties: numRuns=15, timeout=60s.
// ts-morph invokes the TypeScript compiler per call (~200-500ms each), so 100
// runs would exceed vitest's default 5000ms timeout. 15 runs exercises all
// distinct elements of the finite constantFrom arbitraries (15 source variants)
// while staying within budget. The invariants are structural, not statistical,
// so coverage is complete at 15 runs for these constantFrom arbitraries.
const tsMorphOpts = { numRuns: 15 };
const tsMorphTimeout = 60_000;

// Error-class properties: numRuns=100 (cheap, no compiler I/O).
const opts = { numRuns: 100 };

it(
  "property: prop_canonicalAstHash_deterministic",
  () => {
    fc.assert(prop_canonicalAstHash_deterministic, tsMorphOpts);
  },
  tsMorphTimeout,
);

it(
  "property: prop_canonicalAstHash_whitespace_invariant",
  () => {
    fc.assert(prop_canonicalAstHash_whitespace_invariant, tsMorphOpts);
  },
  tsMorphTimeout,
);

it(
  "property: prop_canonicalAstHash_format_brand",
  () => {
    fc.assert(prop_canonicalAstHash_format_brand, tsMorphOpts);
  },
  tsMorphTimeout,
);

it(
  "property: prop_canonicalAstHash_throws_on_invalid",
  () => {
    fc.assert(prop_canonicalAstHash_throws_on_invalid, tsMorphOpts);
  },
  tsMorphTimeout,
);

it("property: prop_CanonicalAstParseError_name_constant", () => {
  fc.assert(prop_CanonicalAstParseError_name_constant, opts);
});

it("property: prop_CanonicalAstParseError_message_preserved", () => {
  fc.assert(prop_CanonicalAstParseError_message_preserved, opts);
});

it("property: prop_CanonicalAstParseError_cause_preserved", () => {
  fc.assert(prop_CanonicalAstParseError_cause_preserved, opts);
});
