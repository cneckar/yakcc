// SPDX-License-Identifier: MIT
// Vitest harness for contract-id.props.ts
// Two-file pattern: this file is the thin vitest wrapper; the corpus lives in
// the sibling contract-id.props.ts (vitest-free, hashable as a manifest artifact).

import * as fc from "fast-check";
import { it } from "vitest";
import {
  prop_contractIdFromBytes_collision_resistance,
  prop_contractIdFromBytes_deterministic,
  prop_contractIdFromBytes_format_brand,
  prop_contractIdFromBytes_pure,
  prop_contractId_equals_idFromBytesOfCanonicalize,
  prop_contractId_field_order_invariant,
  prop_isValidContractId_accepts_valid,
  prop_isValidContractId_rejects_non_hex,
  prop_isValidContractId_rejects_uppercase,
  prop_isValidContractId_rejects_wrong_length,
  prop_isValidContractId_total,
} from "./contract-id.props.js";

// numRuns: 100 (fast-check default, explicitly documented per eval contract).
const opts = { numRuns: 100 };
// Collision resistance uses numRuns=200 to exercise a wider input space.
const collisionOpts = { numRuns: 200 };

it("property: prop_contractIdFromBytes_deterministic", () => {
  fc.assert(prop_contractIdFromBytes_deterministic, opts);
});

it("property: prop_contractIdFromBytes_format_brand", () => {
  fc.assert(prop_contractIdFromBytes_format_brand, opts);
});

it("property: prop_contractIdFromBytes_collision_resistance", () => {
  fc.assert(prop_contractIdFromBytes_collision_resistance, collisionOpts);
});

it("property: prop_contractIdFromBytes_pure", () => {
  fc.assert(prop_contractIdFromBytes_pure, opts);
});

it("property: prop_contractId_equals_idFromBytesOfCanonicalize", () => {
  fc.assert(prop_contractId_equals_idFromBytesOfCanonicalize, opts);
});

it("property: prop_contractId_field_order_invariant", () => {
  fc.assert(prop_contractId_field_order_invariant, opts);
});

it("property: prop_isValidContractId_accepts_valid", () => {
  fc.assert(prop_isValidContractId_accepts_valid, opts);
});

it("property: prop_isValidContractId_rejects_wrong_length", () => {
  fc.assert(prop_isValidContractId_rejects_wrong_length, opts);
});

it("property: prop_isValidContractId_rejects_uppercase", () => {
  fc.assert(prop_isValidContractId_rejects_uppercase, opts);
});

it("property: prop_isValidContractId_rejects_non_hex", () => {
  fc.assert(prop_isValidContractId_rejects_non_hex, opts);
});

it("property: prop_isValidContractId_total", () => {
  fc.assert(prop_isValidContractId_total, opts);
});
