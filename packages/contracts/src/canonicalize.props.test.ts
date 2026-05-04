// SPDX-License-Identifier: MIT
// Vitest harness for canonicalize.props.ts
// Two-file pattern: this file is the thin vitest wrapper; the corpus lives in
// the sibling canonicalize.props.ts (vitest-free, hashable as a manifest artifact).

import { it } from "vitest";
import * as fc from "fast-check";
import {
  prop_canonicalize_deterministic,
  prop_canonicalize_field_order_invariant,
  prop_canonicalize_array_order_sensitive,
  prop_canonicalize_utf8_decodable,
  prop_canonicalizeText_matches_canonicalize,
  prop_canonicalizeText_deterministic,
} from "./canonicalize.props.js";

// numRuns: 100 (fast-check default, explicitly documented per eval contract).
const opts = { numRuns: 100 };

it("property: prop_canonicalize_deterministic", () => {
  fc.assert(prop_canonicalize_deterministic, opts);
});

it("property: prop_canonicalize_field_order_invariant", () => {
  fc.assert(prop_canonicalize_field_order_invariant, opts);
});

it("property: prop_canonicalize_array_order_sensitive", () => {
  fc.assert(prop_canonicalize_array_order_sensitive, opts);
});

it("property: prop_canonicalize_utf8_decodable", () => {
  fc.assert(prop_canonicalize_utf8_decodable, opts);
});

it("property: prop_canonicalizeText_matches_canonicalize", () => {
  fc.assert(prop_canonicalizeText_matches_canonicalize, opts);
});

it("property: prop_canonicalizeText_deterministic", () => {
  fc.assert(prop_canonicalizeText_deterministic, opts);
});
