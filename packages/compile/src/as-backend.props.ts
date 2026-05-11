// SPDX-License-Identifier: MIT
// @decision DEC-V2-PROPTEST-PATH-A-004: hand-authored property-test corpus for
// @yakcc/compile as-backend.ts atoms. Two-file pattern: this file (.props.ts)
// is vitest-free and holds the corpus; the sibling .props.test.ts is the
// vitest harness.
// Status: accepted (WI-87-FILL-COMPILE-SLICE-3)
// Rationale: The corpus file must be runtime-independent so L10 can hash it as
// a manifest artifact. Property tests cover the three exported pure surfaces:
// inferDomainFromSource, prepareAsSource, and the assemblyScriptBackend factory
// (structural / name invariants only — no asc invocation in this corpus).
//
// Atoms covered (3 named):
//   AB1 — inferDomainFromSource: numeric domain classification heuristics
//   AB2 — prepareAsSource: TS-to-AS source transformation pipeline
//   AB3 — assemblyScriptBackend / WasmBackend: factory structural contract
//
// Properties (12 named):
//   prop_inferDomain_bitop_returns_i32
//   prop_inferDomain_true_division_returns_f64
//   prop_inferDomain_math_f64_returns_f64
//   prop_inferDomain_bigint_keyword_returns_i64
//   prop_inferDomain_large_literal_returns_i64
//   prop_inferDomain_ambiguous_returns_f64
//   prop_prepareAsSource_strips_intra_import
//   prop_prepareAsSource_strips_contracts_import
//   prop_prepareAsSource_strips_shadow_alias
//   prop_prepareAsSource_rewrites_number_to_domain
//   prop_prepareAsSource_i64_domain_strips_bigint_constructor
//   prop_assemblyScriptBackend_name_is_as
// ---------------------------------------------------------------------------

import * as fc from "fast-check";
import { assemblyScriptBackend, inferDomainFromSource, prepareAsSource } from "./as-backend.js";

// ---------------------------------------------------------------------------
// Shared arbitraries
// ---------------------------------------------------------------------------

/** A short identifier usable as a function/variable name. */
const identArb: fc.Arbitrary<string> = fc
  .stringMatching(/^[a-z][a-z0-9]{2,10}$/)
  .filter((s) => s.length >= 3);

/** A simple valid i32 arithmetic expression (uses bitwise op to anchor domain). */
const i32SrcArb: fc.Arbitrary<string> = identArb.map(
  (name) => `export function ${name}(a: number, b: number): number { return (a + b) | 0; }`,
);

/** A simple valid f64 arithmetic expression (uses true division to anchor domain). */
const f64SrcArb: fc.Arbitrary<string> = identArb.map(
  (name) => `export function ${name}(a: number, b: number): number { return a / b; }`,
);

/** A simple valid i64 expression (bigint keyword anchor). */
const i64SrcArb: fc.Arbitrary<string> = identArb.map(
  (name) =>
    `export function ${name}(a: bigint, b: bigint): bigint { return BigInt(1000000000) + a + b; }`,
);

/** A source line that looks like an intra-corpus import (from "./<module>.js"). */
const intraImportLineArb: fc.Arbitrary<string> = identArb.map(
  (mod) => `import type { Foo } from "./${mod}.js";`,
);

/** A source line that looks like a @yakcc/contracts import. */
const contractsImportLineArb: fc.Arbitrary<string> = fc.constant(
  `import type { BlockMerkleRoot } from "@yakcc/contracts";`,
);

/** A source line that looks like a shadow type alias. */
const shadowAliasLineArb: fc.Arbitrary<string> = identArb.map(
  (id) => `type _${id} = typeof ${id};`,
);

// ---------------------------------------------------------------------------
// AB1 — inferDomainFromSource: numeric domain classification heuristics
// ---------------------------------------------------------------------------

/**
 * prop_inferDomain_bitop_returns_i32
 *
 * Any source containing a bitwise operator (| 0 idiom) is classified as i32,
 * regardless of other content.
 *
 * Invariant (AB1): bitop is the highest-priority rule in the domain inference
 * priority block (DEC-V1-DOMAIN-INFER-PARITY-001). A source with both a bitwise
 * op and a float literal must still return i32 — bitop wins over f64.
 */
export const prop_inferDomain_bitop_returns_i32 = fc.property(
  i32SrcArb,
  (src) => inferDomainFromSource(src) === "i32",
);

/**
 * prop_inferDomain_true_division_returns_f64
 *
 * A source containing a true division (/) with no bitwise operators is classified
 * as f64.
 *
 * Invariant (AB1): true division is an unambiguous f64 indicator. Sources with only
 * division and no bitop fall into the f64 domain, which is the conservative safe
 * choice for non-integer arithmetic.
 */
export const prop_inferDomain_true_division_returns_f64 = fc.property(
  f64SrcArb,
  (src) => inferDomainFromSource(src) === "f64",
);

/**
 * prop_inferDomain_math_f64_returns_f64
 *
 * A source containing a Math.sqrt, Math.sin, or Math.cos call is classified as f64.
 *
 * Invariant (AB1): f64 Math functions are rule-3 indicators. Any source that calls
 * a recognised f64 Math method with no bitop present must return f64.
 */
export const prop_inferDomain_math_f64_returns_f64 = fc.property(
  identArb,
  fc.constantFrom("sqrt", "sin", "cos", "log", "exp", "abs"),
  (name, mathFn) => {
    const src = `export function ${name}(a: number): number { return Math.${mathFn}(a); }`;
    return inferDomainFromSource(src) === "f64";
  },
);

/**
 * prop_inferDomain_bigint_keyword_returns_i64
 *
 * A source containing the `bigint` keyword (but no bitop, no true division) is
 * classified as i64.
 *
 * Invariant (AB1): bigint keyword is a rule-7 i64 indicator. It ranks below bitop
 * and f64 in the priority block, so this test uses sources with bigint and no
 * conflicting higher-priority indicators.
 */
export const prop_inferDomain_bigint_keyword_returns_i64 = fc.property(identArb, (name) => {
  const src = `export function ${name}(a: bigint): bigint { return a + BigInt(1); }`;
  return inferDomainFromSource(src) === "i64";
});

/**
 * prop_inferDomain_large_literal_returns_i64
 *
 * A source containing an integer literal larger than 2^31-1 (but no bitop,
 * no true division, no bigint keyword) is classified as i64.
 *
 * Invariant (AB1): large integer literals (> 2147483647) are rule-5 i64 indicators.
 * They rank below bitop and f64 in priority; sources with large literals and no
 * higher-priority indicators must return i64.
 */
export const prop_inferDomain_large_literal_returns_i64 = fc.property(
  identArb,
  fc.integer({ min: 2147483648, max: 9999999999 }),
  (name, large) => {
    const src = `export function ${name}(a: number): number { return a + ${large}; }`;
    return inferDomainFromSource(src) === "i64";
  },
);

/**
 * prop_inferDomain_ambiguous_returns_f64
 *
 * A source with no domain indicators (no bitop, no division, no Math.f64, no bigint,
 * no large literal, no floor hint) is classified as f64 by the default fallback.
 *
 * Invariant (AB1): the conservative fallback is f64, matching visitor.ts policy
 * (DEC-V1-DOMAIN-INFER-PARITY-001). f64 is never lossy for integer inputs, so
 * returning f64 for ambiguous sources is safe for downstream asc compilation.
 */
export const prop_inferDomain_ambiguous_returns_f64 = fc.property(identArb, (name) => {
  // A simple addition with no indicators — pure addition is ambiguous → f64
  const src = `export function ${name}(a: number): number { return a + a; }`;
  return inferDomainFromSource(src) === "f64";
});

// ---------------------------------------------------------------------------
// AB2 — prepareAsSource: TS-to-AS source transformation pipeline
// ---------------------------------------------------------------------------

/**
 * prop_prepareAsSource_strips_intra_import
 *
 * An intra-corpus import line (`import type { X } from "./<mod>.js"`) is stripped
 * from the output of prepareAsSource.
 *
 * Invariant (AB2): INTRA_IMPORT_RE matches relative imports from "./" prefix.
 * The AS compiler cannot resolve intra-corpus TS imports; stripping them is
 * required to produce valid asc input. The surrounding code must be preserved.
 */
export const prop_prepareAsSource_strips_intra_import = fc.property(
  intraImportLineArb,
  identArb,
  (importLine, name) => {
    const body = `export function ${name}(a: number): number { return (a + 1) | 0; }`;
    const source = `${importLine}\n${body}`;
    const prepared = prepareAsSource(source, "i32");
    return !prepared.includes(importLine) && prepared.includes(name);
  },
);

/**
 * prop_prepareAsSource_strips_contracts_import
 *
 * A `@yakcc/contracts` import line is stripped from the prepareAsSource output.
 *
 * Invariant (AB2): CONTRACTS_IMPORT_RE matches imports from "@yakcc/contracts".
 * These types are not available in the AS compilation environment; they must be
 * stripped before handing source to asc.
 */
export const prop_prepareAsSource_strips_contracts_import = fc.property(
  contractsImportLineArb,
  identArb,
  (importLine, name) => {
    const body = `export function ${name}(a: number): number { return a | 0; }`;
    const source = `${importLine}\n${body}`;
    const prepared = prepareAsSource(source, "i32");
    return !prepared.includes("@yakcc/contracts") && prepared.includes(name);
  },
);

/**
 * prop_prepareAsSource_strips_shadow_alias
 *
 * A shadow type alias line (`type _X = typeof X;`) is stripped from the output.
 *
 * Invariant (AB2): SHADOW_ALIAS_RE matches `type _<id> = typeof <id>` patterns.
 * Shadow aliases are intra-corpus TS-only constructs that asc cannot compile;
 * stripping them prevents asc compile failures on otherwise valid atom sources.
 */
export const prop_prepareAsSource_strips_shadow_alias = fc.property(
  shadowAliasLineArb,
  identArb,
  (aliasLine, name) => {
    const body = `export function ${name}(a: number): number { return a | 0; }`;
    const source = `${aliasLine}\n${body}`;
    const prepared = prepareAsSource(source, "i32");
    return !prepared.includes(aliasLine) && prepared.includes(name);
  },
);

/**
 * prop_prepareAsSource_rewrites_number_to_domain
 *
 * Every `: number` type annotation in the source is rewritten to the AS-native
 * type corresponding to the inferred domain.
 *
 * Invariant (AB2): type annotation rewriting is the final transformation step.
 * The AS compiler requires concrete numeric types (i32/i64/f64); TS `number` is
 * not a valid asc type. After rewriting, the output must not contain `: number`
 * and must contain the expected domain type annotation.
 */
export const prop_prepareAsSource_rewrites_number_to_domain = fc.property(
  identArb,
  fc.constantFrom("i32" as const, "f64" as const, "i64" as const),
  (name, domain) => {
    const src = `export function ${name}(a: number, b: number): number { return (a + b) | 0; }`;
    const prepared = prepareAsSource(src, domain);
    const expectedType = domain === "i64" ? "i64" : domain === "f64" ? "f64" : "i32";
    return !prepared.includes(": number") && prepared.includes(`: ${expectedType}`);
  },
);

/**
 * prop_prepareAsSource_i64_domain_strips_bigint_constructor
 *
 * When the domain is i64, BigInt(expr) constructor calls are rewritten to
 * (expr as i64) casts and bigint n-suffix literals are stripped to plain integers.
 *
 * Invariant (AB2): the i64 domain rewrite is required because asc has no BigInt()
 * constructor — it uses plain i64 literals and explicit casts. Without this rewrite,
 * asc will fail to compile any source that uses the TS BigInt() constructor or n-suffix
 * literals.
 */
export const prop_prepareAsSource_i64_domain_strips_bigint_constructor = fc.property(
  identArb,
  fc.integer({ min: 1, max: 9999999999 }),
  (name, large) => {
    const src = `export function ${name}(a: bigint): bigint { return a + BigInt(${large}); }`;
    const prepared = prepareAsSource(src, "i64");
    // BigInt(large) → (large as i64); bigint → i64; no ': number' anywhere
    return (
      !prepared.includes("BigInt(") &&
      !prepared.includes(": bigint") &&
      prepared.includes(": i64") &&
      prepared.includes("as i64")
    );
  },
);

// ---------------------------------------------------------------------------
// AB3 — assemblyScriptBackend / WasmBackend: factory structural contract
// ---------------------------------------------------------------------------

/**
 * prop_assemblyScriptBackend_name_is_as
 *
 * assemblyScriptBackend() returns a WasmBackend whose .name property is exactly "as".
 *
 * Invariant (AB3): the backend name is used by callers (e.g. assemble(), tooling)
 * to identify the compilation path. Callers downstream of the assembly pipeline
 * discriminate backends by name; an unexpected name would silently mis-route WASM
 * compilation results. Both default construction and exportMemory:true must return "as".
 *
 * This is a pure structural test — no asc invocation, no disk IO.
 */
export const prop_assemblyScriptBackend_name_is_as = fc.property(fc.boolean(), (exportMemory) => {
  const backend = assemblyScriptBackend({ exportMemory });
  return backend.name === "as";
});
