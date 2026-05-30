// SPDX-License-Identifier: MIT
/**
 * Property test: every IR atom either lowers to valid Python or throws
 * CannotLowerToPythonError. No other error type and no silent TS-syntax leak
 * is permitted.
 *
 * This test closes the bug class surfaced by WI-943: the three silent
 * getText() fallbacks in lower.ts that allowed raw TS syntax (arrow functions,
 * unhandled statements, bodyless FunctionExpressions) to appear verbatim in
 * Python output.
 *
 * Compound-interaction scope: exercises the full production sequence
 *   compileToPython (→ lowerSource → lowerStatement / lowerExpr / extractArrowBody)
 * crossing all three internal component boundaries without mocks.
 *
 * @decision DEC-COMPILE-PYTHON-LOUD-001
 */

import { CannotLowerToPythonError } from "@yakcc/contracts";
import type { BlockTripletRow } from "@yakcc/registry";
import type { BlockMerkleRoot, CanonicalAstHash, SpecHash } from "@yakcc/registry";
import { describe, expect, it } from "vitest";
import { compileToPython } from "./compile-python.js";

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function makeRow(implSource: string): BlockTripletRow {
  return {
    blockMerkleRoot: "dead" as BlockMerkleRoot,
    specHash: "dead" as SpecHash,
    specCanonicalBytes: new Uint8Array(),
    implSource,
    proofManifestJson: "{}",
    level: "L0",
    createdAt: 0,
    canonicalAstHash: "dead" as CanonicalAstHash,
    artifacts: new Map(),
  };
}

/**
 * Assert the property: compileToPython either succeeds with Python-only output
 * or throws CannotLowerToPythonError. No other outcome is acceptable.
 *
 * On success, verify that common TS-syntax markers are absent from the output.
 */
function assertLowersCleanlyOrThrowsLoud(src: string): void {
  let result: { source: string } | undefined;
  let thrown: unknown;

  try {
    result = compileToPython(makeRow(src));
  } catch (err) {
    thrown = err;
  }

  if (thrown !== undefined) {
    // The only acceptable error class is CannotLowerToPythonError.
    expect(thrown, `Expected CannotLowerToPythonError but got: ${String(thrown)}`).toBeInstanceOf(
      CannotLowerToPythonError,
    );
    // When it does throw, the error must carry a non-empty nodeKind and a
    // parseable location so the next implementer can act on it.
    if (thrown instanceof CannotLowerToPythonError) {
      expect(thrown.nodeKind.length).toBeGreaterThan(0);
      expect(thrown.location.line).toBeGreaterThanOrEqual(1);
      expect(thrown.location.column).toBeGreaterThanOrEqual(0);
    }
    return;
  }

  // Success path: assert no raw TS syntax leaked into the Python output.
  const source = result?.source;
  expect(source).not.toMatch(/\b(const|let|var)\s+\w/);
  expect(source).not.toMatch(/\binterface\s+\w/);
  expect(source).not.toMatch(/\btype\s+\w+\s*=/);
  // Arrow functions must not appear verbatim
  expect(source).not.toMatch(/=>/);
  // TS cast / non-null assertion must not appear verbatim
  expect(source).not.toMatch(/ as \w/);
  expect(source).not.toMatch(/\w!/);
}

// ---------------------------------------------------------------------------
// Atom corpus — known-good shapes covering all major lowerStatement branches
// ---------------------------------------------------------------------------

const ATOMS: Array<[string, string]> = [
  ["return statement", "export function add(a: number, b: number): number { return a + b; }"],
  [
    "if/else statement",
    `export function max2(a: number, b: number): number {
  if (a > b) { return a; } else { return b; }
}`,
  ],
  [
    "while loop with break",
    `export function firstZero(xs: number[]): number {
  let i = 0;
  while (i < xs.length) {
    if (xs[i] === 0) break;
    i++;
  }
  return i;
}`,
  ],
  [
    "for-of loop",
    `export function sumArr(xs: number[]): number {
  let total = 0;
  for (const x of xs) { total += x; }
  return total;
}`,
  ],
  [
    "for statement (C-style)",
    `export function countdown(n: number): number[] {
  const result: number[] = [];
  for (let i = n; i > 0; i--) { result.push(i); }
  return result;
}`,
  ],
  [
    "variable statement with initializer",
    `export function square(x: number): number {
  const y = x * x;
  return y;
}`,
  ],
  [
    "throw statement",
    `export function assertPositive(x: number): void {
  if (x <= 0) { throw new RangeError("non-positive"); }
}`,
  ],
  [
    "expression statement (assignment)",
    `export function increment(xs: number[]): void {
  xs.push(xs.length);
}`,
  ],
  [
    "ternary / conditional expression",
    "export function absVal(x: number): number { return x < 0 ? -x : x; }",
  ],
  ["template literal", "export function greet(name: string): string { return `Hello, ${name}!`; }"],
  [
    "map() comprehension",
    "export function doubled(xs: number[]): number[] { return xs.map((x) => x * 2); }",
  ],
  [
    "filter() comprehension",
    "export function positives(xs: number[]): number[] { return xs.filter((x) => x > 0); }",
  ],
  [
    "reduce() to functools",
    "export function sum(xs: number[]): number { return xs.reduce((acc, x) => acc + x, 0); }",
  ],
  [
    "object literal expression",
    "export function pair(a: number, b: number): Record<string, number> { return { a, b }; }",
  ],
  ["array literal expression", "export function wrap(x: number): number[] { return [x]; }"],
  ["string return", "export function echo(s: string): string { return s; }"],
  ["boolean return", "export function negate(b: boolean): boolean { return !b; }"],
  ["null/undefined return", "export function nothing(): null { return null; }"],
  [
    "Optional return type (T | null)",
    `export function maybeFirst(xs: number[]): number | null {
  if (xs.length === 0) return null;
  return xs[0] as number;
}`,
  ],
  [
    "Record type parameter",
    `export function lookup(map: Record<string, number>, key: string): number {
  return (map[key] ?? 0) as number;
}`,
  ],
];

// ---------------------------------------------------------------------------
// Property test: each atom either lowers cleanly or throws CannotLowerToPythonError
// ---------------------------------------------------------------------------

describe("compileToPython — bug-class closure (WI-943)", () => {
  it.each(ATOMS)(
    "atom '%s' either lowers to valid Python or throws CannotLowerToPythonError",
    (_label, src) => {
      assertLowersCleanlyOrThrowsLoud(src);
    },
  );
});

// ---------------------------------------------------------------------------
// Compound-interaction test: full production sequence end-to-end
//
// Covers the real production path:
//   compileToPython -> lowerSource -> lowerFunctionDecl
//                   -> lowerBlock -> lowerStatement (multiple branches)
//                   -> lowerExpr (multiple branches)
//
// Crosses lowerStatement, lowerExpr, lowerBinary, lowerTemplate, lowerCall
// component boundaries in a single realistic atom that uses every major node
// kind the lowerer handles.
// ---------------------------------------------------------------------------

describe("compileToPython — compound interaction (all major node paths)", () => {
  const COMPLEX_ATOM = `
export function commaSeparatedIntegers(input: string): number[] {
  const result: number[] = [];
  let pos = 0;
  while (pos < input.length) {
    const c = input[pos] as string;
    if (c >= "0" && c <= "9") {
      let val = 0;
      while (pos < input.length && input[pos] as string >= "0" && input[pos] as string <= "9") {
        val = val * 10 + (input[pos] as string).charCodeAt(0) - 48;
        pos++;
      }
      result.push(val);
    } else {
      pos++;
    }
  }
  return result;
}`;

  it("lowers complex atom without leaking TS syntax", () => {
    assertLowersCleanlyOrThrowsLoud(COMPLEX_ATOM);
  });

  it("on success: source contains def and while and return", () => {
    let source: string | undefined;
    try {
      source = compileToPython(makeRow(COMPLEX_ATOM)).source;
    } catch (err) {
      // If it throws, it MUST be CannotLowerToPythonError — not a JS error
      expect(err).toBeInstanceOf(CannotLowerToPythonError);
      return;
    }
    expect(source).toContain("def comma_separated_integers(");
    expect(source).toContain("while ");
    expect(source).toContain("return result");
  });
});

// ---------------------------------------------------------------------------
// Regression: previously-silent statement fallback now throws
// ---------------------------------------------------------------------------

describe("compileToPython — formerly silent fallbacks now throw CannotLowerToPythonError", () => {
  it("SwitchStatement throws CannotLowerToPythonError (statement fallback, Site 1)", () => {
    const src = `
export function classify(x: number): string {
  switch (x) {
    case 1: return "one";
    default: return "other";
  }
}`;
    expect(() => compileToPython(makeRow(src))).toThrowError(CannotLowerToPythonError);
  });

  it("thrown error names the node kind and has a location", () => {
    const src = `
export function classify(x: number): string {
  switch (x) {
    case 1: return "one";
    default: return "other";
  }
}`;
    let err: unknown;
    try {
      compileToPython(makeRow(src));
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(CannotLowerToPythonError);
    if (err instanceof CannotLowerToPythonError) {
      expect(err.nodeKind).toBe("SwitchStatement");
      expect(err.location.line).toBeGreaterThanOrEqual(1);
      expect(err.message).toContain("Cannot lower TS-subset IR to Python");
    }
  });
});
