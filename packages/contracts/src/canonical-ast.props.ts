// SPDX-License-Identifier: MIT
// @decision DEC-V2-PROPTEST-PATH-A-001: hand-authored property-test corpus for
// @yakcc/contracts atoms. Two-file pattern: this file (.props.ts) is vitest-free
// and holds the corpus; the sibling .props.test.ts is the vitest harness.
// Status: accepted (WI-V2-06 L1)
// Rationale: See tmp/wi-v2-06-layer-plan.md — the corpus file must be
// runtime-independent so L10 can hash it as a manifest artifact.

// ---------------------------------------------------------------------------
// Property-test corpus for canonical-ast.ts atoms
// Atoms covered: canonicalAstHash (A1.1), CanonicalAstParseError (A1.2)
// ---------------------------------------------------------------------------

import * as fc from "fast-check";
import { CanonicalAstParseError, canonicalAstHash } from "./canonical-ast.js";

// ---------------------------------------------------------------------------
// Shared arbitraries
// ---------------------------------------------------------------------------

/**
 * Arbitrary for syntactically valid, minimal TypeScript source snippets.
 * Uses a fixed set of structurally valid snippets rather than random strings to
 * guarantee syntactic validity (random strings produce parse errors, which is a
 * separate property). The set is large enough to exercise a range of AST shapes.
 */
const validTsSources: fc.Arbitrary<string> = fc.constantFrom(
  "const x = 1;",
  "const x = 2;",
  "const hello = 'world';",
  "export function f(a: number): number { return a + 1; }",
  "export function g(a: number, b: number): number { return a * b; }",
  "export const PI = 3.14159;",
  "export type T = { x: number; y: string };",
  "interface I { foo: string; bar: number }",
  "class C { constructor(readonly x: number) {} }",
  "export default function h(): void {}",
  "const arr = [1, 2, 3];",
  "export function identity<T>(x: T): T { return x; }",
  "let count = 0; count += 1;",
  "export async function fetch(): Promise<void> { await Promise.resolve(); }",
  "const obj = { a: 1, b: 2, c: 3 };",
);

/**
 * Arbitrary for syntactically invalid TypeScript source that should trigger
 * a CanonicalAstParseError. These have syntax errors (missing brackets, etc.)
 * that prevent the TypeScript parser from producing a valid AST.
 */
const invalidTsSources: fc.Arbitrary<string> = fc.constantFrom(
  "function f( { return; }", // missing closing paren
  "class { { { { {", // unbalanced braces
  "const x = }}}", // invalid expression
  "export function (: number) {}", // anonymous function with type annotation
  "=> => => {}", // arrow function without parameter list
);

/**
 * Arbitrary for whitespace/comment variations that wrap valid source.
 * Used to verify canonicalAstHash whitespace-invariance property.
 */
const whitespaceVariantArb: fc.Arbitrary<{ base: string; variant: string }> = fc.constantFrom(
  {
    base: "function f(a: number): number { return a + 1; }",
    variant: "\n\nfunction f(a: number): number { return a + 1; }\n\n",
  },
  {
    base: "const x = 1;",
    variant: "   const x = 1;   ",
  },
  {
    base: "function add(a: number, b: number): number { return a + b; }",
    variant: "// adds two numbers\nfunction add(a: number, b: number): number { return a + b; }",
  },
  {
    base: "export function sq(n: number): number { return n * n; }",
    variant: "/** @param n — input */\nexport function sq(n: number): number { return n * n; }",
  },
  {
    base: "function f(a: number): number {\n  return a + 1;\n}",
    variant: "function f(a: number): number {\n    return a + 1;\n}",
  },
);

// ---------------------------------------------------------------------------
// A1.1: canonicalAstHash properties
// ---------------------------------------------------------------------------

/**
 * prop_canonicalAstHash_deterministic
 *
 * For every syntactically valid TypeScript source string, two consecutive calls
 * to canonicalAstHash with identical input produce identical hashes.
 * Invariant: the function is a pure, deterministic mapping from source to hash.
 */
export const prop_canonicalAstHash_deterministic = fc.property(validTsSources, (src) => {
  const h1 = canonicalAstHash(src);
  const h2 = canonicalAstHash(src);
  return h1 === h2;
});

/**
 * prop_canonicalAstHash_whitespace_invariant
 *
 * For a set of known (base, variant) pairs that differ only in whitespace or
 * comments, canonicalAstHash produces the same output for base and variant.
 * Invariant: the canonical form strips whitespace and comments before hashing.
 */
export const prop_canonicalAstHash_whitespace_invariant = fc.property(
  whitespaceVariantArb,
  ({ base, variant }) => {
    return canonicalAstHash(base) === canonicalAstHash(variant);
  },
);

/**
 * prop_canonicalAstHash_format_brand
 *
 * For every syntactically valid source, the returned hash is exactly 64
 * lowercase hexadecimal characters.
 * Invariant: CanonicalAstHash is always a 64-char lowercase hex string.
 */
export const prop_canonicalAstHash_format_brand = fc.property(validTsSources, (src) => {
  const h = canonicalAstHash(src);
  return /^[0-9a-f]{64}$/.test(h);
});

/**
 * prop_canonicalAstHash_throws_on_invalid
 *
 * For every syntactically invalid source string, canonicalAstHash throws a
 * CanonicalAstParseError (not a generic Error or unexpected throw).
 * Invariant: invalid TypeScript syntax produces a typed, predictable error.
 */
export const prop_canonicalAstHash_throws_on_invalid = fc.property(invalidTsSources, (src) => {
  try {
    canonicalAstHash(src);
    // If no throw, we return false to signal property violation
    return false;
  } catch (e) {
    return e instanceof CanonicalAstParseError;
  }
});

// ---------------------------------------------------------------------------
// A1.2: CanonicalAstParseError properties
// ---------------------------------------------------------------------------

/**
 * prop_CanonicalAstParseError_name_constant
 *
 * For every (message, cause) pair, a new CanonicalAstParseError instance has
 * name === "CanonicalAstParseError" and is instanceof Error.
 * Invariant: the class sets its .name field to a stable string identity.
 */
export const prop_CanonicalAstParseError_name_constant = fc.property(
  fc.string(),
  fc.option(fc.anything(), { nil: undefined }),
  (msg, _cause) => {
    // CanonicalAstParseError takes (message, diagnostics: string[]) — the
    // constructor signature takes diagnostics, not cause. We pass [] as diagnostics.
    const err = new CanonicalAstParseError(msg, []);
    return err.name === "CanonicalAstParseError" && err instanceof Error;
  },
);

/**
 * prop_CanonicalAstParseError_message_preserved
 *
 * For every string message, the constructed error's .message property equals
 * the original message string.
 * Invariant: Error.prototype.message is set verbatim from the constructor argument.
 */
export const prop_CanonicalAstParseError_message_preserved = fc.property(fc.string(), (msg) => {
  const err = new CanonicalAstParseError(msg, []);
  return err.message === msg;
});

/**
 * prop_CanonicalAstParseError_cause_preserved
 *
 * For every diagnostics array, the constructed error's .diagnostics property
 * is the same array reference passed to the constructor.
 * Invariant: the diagnostics tuple is stored verbatim and accessible.
 */
export const prop_CanonicalAstParseError_cause_preserved = fc.property(
  fc.string(),
  fc.array(fc.string()),
  (msg, diagnostics) => {
    const err = new CanonicalAstParseError(msg, diagnostics);
    // CanonicalAstParseError stores diagnostics as a readonly property.
    // The array reference must match exactly (not a copy).
    return err.diagnostics === diagnostics;
  },
);
