// SPDX-License-Identifier: MIT
// Vitest harness for as-backend.props.ts
// Two-file pattern: this file is the thin vitest wrapper; the corpus lives in
// the sibling as-backend.props.ts (vitest-free, hashable as a manifest artifact).
//
// All properties are pure / synchronous — no asc invocation, no disk IO.
// numRuns: 100 gives thorough coverage at low cost for string-scanning functions.

import * as fc from "fast-check";
import { it } from "vitest";
import {
  prop_assemblyScriptBackend_name_is_as,
  prop_inferDomain_ambiguous_returns_f64,
  prop_inferDomain_bigint_keyword_returns_i64,
  prop_inferDomain_bitop_returns_i32,
  prop_inferDomain_large_literal_returns_i64,
  prop_inferDomain_math_f64_returns_f64,
  prop_inferDomain_true_division_returns_f64,
  prop_prepareAsSource_i64_domain_strips_bigint_constructor,
  prop_prepareAsSource_rewrites_number_to_domain,
  prop_prepareAsSource_strips_contracts_import,
  prop_prepareAsSource_strips_intra_import,
  prop_prepareAsSource_strips_shadow_alias,
} from "./as-backend.props.js";

const opts = { numRuns: 100 };

// ---------------------------------------------------------------------------
// AB1 — inferDomainFromSource
// ---------------------------------------------------------------------------

it("property: prop_inferDomain_bitop_returns_i32", () => {
  fc.assert(prop_inferDomain_bitop_returns_i32, opts);
});

it("property: prop_inferDomain_true_division_returns_f64", () => {
  fc.assert(prop_inferDomain_true_division_returns_f64, opts);
});

it("property: prop_inferDomain_math_f64_returns_f64", () => {
  fc.assert(prop_inferDomain_math_f64_returns_f64, opts);
});

it("property: prop_inferDomain_bigint_keyword_returns_i64", () => {
  fc.assert(prop_inferDomain_bigint_keyword_returns_i64, opts);
});

it("property: prop_inferDomain_large_literal_returns_i64", () => {
  fc.assert(prop_inferDomain_large_literal_returns_i64, opts);
});

it("property: prop_inferDomain_ambiguous_returns_f64", () => {
  fc.assert(prop_inferDomain_ambiguous_returns_f64, opts);
});

// ---------------------------------------------------------------------------
// AB2 — prepareAsSource
// ---------------------------------------------------------------------------

it("property: prop_prepareAsSource_strips_intra_import", () => {
  fc.assert(prop_prepareAsSource_strips_intra_import, opts);
});

it("property: prop_prepareAsSource_strips_contracts_import", () => {
  fc.assert(prop_prepareAsSource_strips_contracts_import, opts);
});

it("property: prop_prepareAsSource_strips_shadow_alias", () => {
  fc.assert(prop_prepareAsSource_strips_shadow_alias, opts);
});

it("property: prop_prepareAsSource_rewrites_number_to_domain", () => {
  fc.assert(prop_prepareAsSource_rewrites_number_to_domain, opts);
});

it("property: prop_prepareAsSource_i64_domain_strips_bigint_constructor", () => {
  fc.assert(prop_prepareAsSource_i64_domain_strips_bigint_constructor, opts);
});

// ---------------------------------------------------------------------------
// AB3 — assemblyScriptBackend factory structural contract
// ---------------------------------------------------------------------------

it("property: prop_assemblyScriptBackend_name_is_as", () => {
  fc.assert(prop_assemblyScriptBackend_name_is_as, opts);
});
