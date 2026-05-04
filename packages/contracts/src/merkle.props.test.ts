// SPDX-License-Identifier: MIT
// Vitest harness for merkle.props.ts
// Two-file pattern: this file is the thin vitest wrapper; the corpus lives in
// the sibling merkle.props.ts (vitest-free, hashable as a manifest artifact).

import { it } from "vitest";
import * as fc from "fast-check";
import {
  prop_specHash_deterministic,
  prop_specHash_format_brand,
  prop_specHash_field_order_invariant,
  prop_blockMerkleRoot_deterministic,
  prop_blockMerkleRoot_format_brand,
  prop_blockMerkleRoot_field_sensitive,
  prop_isLocalTriplet_total,
  prop_isLocalTriplet_partition,
  prop_isLocalTriplet_accepts_local,
  prop_isForeignTriplet_total,
  prop_isForeignTriplet_partition,
  prop_isForeignTriplet_accepts_foreign,
  prop_specHash_via_contractSpec_deterministic,
} from "./merkle.props.js";

// numRuns: 100 (fast-check default, explicitly documented per eval contract).
const opts = { numRuns: 100 };

it("property: prop_specHash_deterministic", () => {
  fc.assert(prop_specHash_deterministic, opts);
});

it("property: prop_specHash_format_brand", () => {
  fc.assert(prop_specHash_format_brand, opts);
});

it("property: prop_specHash_field_order_invariant", () => {
  fc.assert(prop_specHash_field_order_invariant, opts);
});

it("property: prop_blockMerkleRoot_deterministic", () => {
  fc.assert(prop_blockMerkleRoot_deterministic, opts);
});

it("property: prop_blockMerkleRoot_format_brand", () => {
  fc.assert(prop_blockMerkleRoot_format_brand, opts);
});

it("property: prop_blockMerkleRoot_field_sensitive", () => {
  fc.assert(prop_blockMerkleRoot_field_sensitive, opts);
});

it("property: prop_isLocalTriplet_total", () => {
  fc.assert(prop_isLocalTriplet_total, opts);
});

it("property: prop_isLocalTriplet_partition", () => {
  fc.assert(prop_isLocalTriplet_partition, opts);
});

it("property: prop_isLocalTriplet_accepts_local", () => {
  fc.assert(prop_isLocalTriplet_accepts_local, opts);
});

it("property: prop_isForeignTriplet_total", () => {
  fc.assert(prop_isForeignTriplet_total, opts);
});

it("property: prop_isForeignTriplet_partition", () => {
  fc.assert(prop_isForeignTriplet_partition, opts);
});

it("property: prop_isForeignTriplet_accepts_foreign", () => {
  fc.assert(prop_isForeignTriplet_accepts_foreign, opts);
});

it("property: prop_specHash_via_contractSpec_deterministic (compound integration)", () => {
  fc.assert(prop_specHash_via_contractSpec_deterministic, opts);
});
