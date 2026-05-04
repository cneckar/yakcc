// SPDX-License-Identifier: MIT
// @decision DEC-V2-PROPTEST-PATH-A-001: hand-authored property-test corpus for
// @yakcc/ir strict-subset.ts atoms. Two-file pattern: this file (.props.ts) is
// vitest-free and holds the corpus; the sibling .props.test.ts is the vitest harness.
// Status: accepted (WI-V2-07-PREFLIGHT L2)
// Rationale: See tmp/wi-v2-07-preflight-layer-plan.md — the corpus file must be
// runtime-independent so L10 can hash it as a manifest artifact.

// ---------------------------------------------------------------------------
// Property-test corpus for strict-subset.ts atoms
//
// Atoms covered (6):
//   makeProject       (A1.1) — internal factory, tested via validateStrictSubset
//   isAnyTypeNode     (A1.2) — internal predicate, tested via no-any rule
//   checkNoWith       (A1.3) — internal rule, tested via no-with rule
//   runAllRules       (A1.4) — exported, tested directly via re-export or public API
//   validateStrictSubset (A1.5) — exported, tested directly
//   validateStrictSubsetFile (A1.6) — reads disk (Path C deferred);
//     covered here only via the pure validateStrictSubset path
// ---------------------------------------------------------------------------

import * as fc from "fast-check";
import { type ValidationResult, validateStrictSubset } from "./strict-subset.js";

// ---------------------------------------------------------------------------
// Shared arbitraries
// ---------------------------------------------------------------------------

/**
 * Arbitrary for TypeScript source strings that conform to the strict subset.
 * Uses fc.constantFrom to guarantee structural validity. All snippets are
 * syntactically valid and free of no-any, no-eval, no-with, etc. violations.
 */
const validStrictSources: fc.Arbitrary<string> = fc.constantFrom(
  "export const x = 1;",
  "export const y = 'hello';",
  "export function add(a: number, b: number): number { return a + b; }",
  "export function identity<T>(v: T): T { return v; }",
  "export type Pair = { first: number; second: string };",
  "export interface Named { readonly name: string }",
  "export const PI = 3.14159265;",
  "export function greet(name: string): string { return `Hello, ${name}`; }",
  "export function clamp(v: number, lo: number, hi: number): number { return Math.min(Math.max(v, lo), hi); }",
  "export class Box<T> { constructor(readonly value: T) {} }",
);

/**
 * Arbitrary for sources that violate the no-any rule.
 * All snippets contain an explicit `any` type annotation.
 */
const anyViolationSources: fc.Arbitrary<string> = fc.constantFrom(
  "export const x: any = 1;",
  "export function f(v: any): void { }",
  "export function g(): any { return 0; }",
  "const arr: any[] = [];",
  "export type T = { x: any };",
);

/**
 * Arbitrary for sources that violate the no-with rule.
 * `with` is illegal JavaScript/TypeScript in strict mode and the strict subset.
 */
const withViolationSources: fc.Arbitrary<string> = fc.constantFrom(
  // Note: TypeScript rejects `with` in strict mode; ts-morph still parses and
  // detects it. These are valid JS (non-strict) but invalid strict-subset.
  "function f() { with ({}) { return 1; } }",
  "function g(obj: object) { with (obj) { } }",
);

/**
 * Arbitrary for sources that violate the no-eval rule.
 */
const evalViolationSources: fc.Arbitrary<string> = fc.constantFrom(
  "const result = eval('1 + 1');",
  "const fn = new Function('x', 'return x');",
);

/**
 * Arbitrary for sources that violate the no-mutable-globals rule.
 * Top-level `let` and `var` are forbidden.
 */
const mutableGlobalSources: fc.Arbitrary<string> = fc.constantFrom(
  "let counter = 0;",
  "var name = 'test';",
  "let x = 1; let y = 2;",
);

// ---------------------------------------------------------------------------
// A1.1: makeProject — tested via validateStrictSubset determinism
//
// makeProject() is called once per validateStrictSubset invocation.
// Its effects are observable through the consistency of results.
// ---------------------------------------------------------------------------

/**
 * prop_makeProject_consistent_project_state
 *
 * For every valid strict-subset source string, two consecutive calls to
 * validateStrictSubset (each internally calls makeProject()) produce identical
 * results with respect to ok/errors structure.
 *
 * Invariant: makeProject() creates an independent in-memory Project each call;
 * no shared state leaks between invocations. The function is deterministic and
 * side-effect-free with respect to observable outputs.
 */
export const prop_makeProject_consistent_project_state = fc.property(validStrictSources, (src) => {
  const r1 = validateStrictSubset(src);
  const r2 = validateStrictSubset(src);
  // Both calls should agree on ok/errors
  if (r1.ok !== r2.ok) return false;
  if (!r1.ok && !r2.ok) {
    return r1.errors.length === r2.errors.length;
  }
  return true;
});

// ---------------------------------------------------------------------------
// A1.2: isAnyTypeNode — tested via the no-any rule through validateStrictSubset
// ---------------------------------------------------------------------------

/**
 * prop_isAnyTypeNode_detects_any_violations
 *
 * For every source string containing an explicit `any` type annotation,
 * validateStrictSubset returns { ok: false } with at least one error
 * whose rule is "no-any".
 *
 * Invariant: isAnyTypeNode correctly classifies AnyKeyword nodes in type
 * positions; the no-any rule collects these and surfaces them as violations.
 */
export const prop_isAnyTypeNode_detects_any_violations = fc.property(anyViolationSources, (src) => {
  const result = validateStrictSubset(src);
  if (result.ok) return false; // must fail
  return result.errors.some((e) => e.rule === "no-any");
});

/**
 * prop_isAnyTypeNode_absent_in_clean_sources
 *
 * For every source string that is valid strict-subset, validateStrictSubset
 * returns { ok: true } — meaning no node was classified as AnyKeyword.
 *
 * Invariant: isAnyTypeNode does not produce false positives for sources
 * that contain no `any` type usage.
 */
export const prop_isAnyTypeNode_absent_in_clean_sources = fc.property(validStrictSources, (src) => {
  const result = validateStrictSubset(src);
  return result.ok === true;
});

// ---------------------------------------------------------------------------
// A1.3: checkNoWith — tested via the no-with rule through validateStrictSubset
// ---------------------------------------------------------------------------

/**
 * prop_checkNoWith_detects_with_statements
 *
 * For every source containing a `with` statement, validateStrictSubset
 * returns { ok: false } with at least one error whose rule is "no-with".
 *
 * Invariant: checkNoWith correctly identifies WithStatement nodes and
 * surfaces them as violations.
 */
export const prop_checkNoWith_detects_with_statements = fc.property(withViolationSources, (src) => {
  const result = validateStrictSubset(src);
  if (result.ok) return false;
  return result.errors.some((e) => e.rule === "no-with");
});

// ---------------------------------------------------------------------------
// A1.4: runAllRules — tested via validateStrictSubset (which delegates to it)
//
// runAllRules is not exported from the public @yakcc/ir surface. It IS the
// core implementation of validateStrictSubset. Properties here verify that
// the rule composition operates correctly: ALL rules run even after the first
// failure (exhaustive, not short-circuit).
// ---------------------------------------------------------------------------

/**
 * prop_runAllRules_exhaustive_multiple_violations
 *
 * For a source that violates multiple rules (e.g. both no-any and no-eval),
 * validateStrictSubset returns ALL violations, not just the first one.
 *
 * Invariant: runAllRules iterates over ALL_RULES without early exit; every
 * rule has a chance to emit errors even after prior rules have found violations.
 */
export const prop_runAllRules_exhaustive_multiple_violations = fc.property(
  fc.constantFrom(
    // Contains both `any` and `eval` violations
    "const x: any = eval('1');",
    // Contains both `any` and `with` violations (non-strict context)
    "function f() { const y: any = 1; with ({}) {} }",
    // Contains `any` and mutable global
    "let x: any = 1;",
  ),
  (src) => {
    const result = validateStrictSubset(src);
    if (result.ok) return false;
    // Multiple violations must be present (at least 2 different rule names)
    const rules = new Set(result.errors.map((e) => e.rule));
    return rules.size >= 2;
  },
);

/**
 * prop_runAllRules_errors_have_required_fields
 *
 * For any source that fails validation, every ValidationError in the result
 * has all required fields: rule, message, file, line, column.
 *
 * Invariant: makeError() correctly populates all ValidationError fields;
 * runAllRules never emits a partial error object.
 */
export const prop_runAllRules_errors_have_required_fields = fc.property(
  fc.oneof(anyViolationSources, withViolationSources, evalViolationSources),
  (src) => {
    const result = validateStrictSubset(src);
    if (result.ok) return true; // no errors to check; property vacuously holds
    for (const err of result.errors) {
      if (typeof err.rule !== "string" || err.rule.length === 0) return false;
      if (typeof err.message !== "string" || err.message.length === 0) return false;
      if (typeof err.file !== "string") return false;
      if (typeof err.line !== "number" || err.line < 1) return false;
      if (typeof err.column !== "number" || err.column < 1) return false;
    }
    return true;
  },
);

// ---------------------------------------------------------------------------
// A1.5: validateStrictSubset — exported, core public API
// ---------------------------------------------------------------------------

/**
 * prop_validateStrictSubset_ok_for_clean_sources
 *
 * For every source in the valid strict-subset corpus, validateStrictSubset
 * returns { ok: true }.
 *
 * Invariant: the validator does not produce false positives on well-formed,
 * rule-compliant TypeScript source strings.
 */
export const prop_validateStrictSubset_ok_for_clean_sources = fc.property(
  validStrictSources,
  (src) => {
    const result = validateStrictSubset(src);
    return result.ok === true;
  },
);

/**
 * prop_validateStrictSubset_fails_for_any
 *
 * For every source containing an explicit `any` type, validateStrictSubset
 * returns { ok: false }.
 *
 * Invariant: the no-any rule is always executed and always produces a violation
 * for explicit `any` usage.
 */
export const prop_validateStrictSubset_fails_for_any = fc.property(anyViolationSources, (src) => {
  const result = validateStrictSubset(src);
  return result.ok === false;
});

/**
 * prop_validateStrictSubset_deterministic
 *
 * For any source string from the combined corpus, two consecutive calls to
 * validateStrictSubset return results with identical ok status and error counts.
 *
 * Invariant: validateStrictSubset is a pure, deterministic function with no
 * observable side effects between calls on the same input.
 */
export const prop_validateStrictSubset_deterministic = fc.property(
  fc.oneof(validStrictSources, anyViolationSources, withViolationSources),
  (src) => {
    const r1 = validateStrictSubset(src);
    const r2 = validateStrictSubset(src);
    if (r1.ok !== r2.ok) return false;
    if (!r1.ok && !r2.ok) {
      return r1.errors.length === r2.errors.length;
    }
    return true;
  },
);

/**
 * prop_validateStrictSubset_result_shape
 *
 * For every source string, validateStrictSubset returns either { ok: true }
 * or { ok: false, errors: ReadonlyArray<ValidationError> } — never any other
 * shape. The discriminated union is always well-formed.
 *
 * Invariant: validateStrictSubset always returns a valid ValidationResult
 * discriminated union; it never throws, never returns undefined, and never
 * returns a partial result.
 */
export const prop_validateStrictSubset_result_shape = fc.property(
  fc.oneof(validStrictSources, anyViolationSources, mutableGlobalSources),
  (src) => {
    let result: ValidationResult | undefined;
    try {
      result = validateStrictSubset(src);
    } catch {
      // validateStrictSubset must not throw — property fails
      return false;
    }
    if (result === null || result === undefined) return false;
    if (typeof result.ok !== "boolean") return false;
    if (result.ok === false) {
      if (!Array.isArray(result.errors)) return false;
    }
    return true;
  },
);

/**
 * prop_validateStrictSubset_mutable_globals_rejected
 *
 * For every source with a top-level `let` or `var` declaration,
 * validateStrictSubset returns { ok: false } with a "no-mutable-globals" error.
 *
 * Invariant: the no-mutable-globals rule is executed by runAllRules and
 * correctly rejects top-level mutable bindings.
 */
export const prop_validateStrictSubset_mutable_globals_rejected = fc.property(
  mutableGlobalSources,
  (src) => {
    const result = validateStrictSubset(src);
    if (result.ok) return false;
    return result.errors.some((e) => e.rule === "no-mutable-globals");
  },
);
