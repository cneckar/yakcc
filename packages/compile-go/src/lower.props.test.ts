// SPDX-License-Identifier: MIT
/**
 * Property test: every IR atom either lowers to valid Go or throws
 * CannotLowerToGoError. No other error type and no silent TS-syntax leak
 * is permitted.
 *
 * Mirrors lower.props.test.ts in @yakcc/compile-python (WI-943) for the
 * Go direction (WI-973). Closes the same bug class: ensures that if the
 * Go emitter hits an unhandled node, it throws a typed, actionable error
 * instead of silently leaking TS syntax into Go output.
 *
 * Compound-interaction scope: exercises the full production sequence
 *   compileToGo -> lowerSource -> lowerFunctionDecl
 *              -> lowerBlock -> lowerStatement / lowerExpr
 * crossing all three internal component boundaries without mocks.
 *
 * @decision DEC-WI973-003 (loud failure — no silent fallbacks)
 */

import { CannotLowerToGoError } from "@yakcc/contracts";
import type { BlockMerkleRoot, CanonicalAstHash, SpecHash } from "@yakcc/registry";
import type { BlockTripletRow } from "@yakcc/registry";
import { describe, expect, it } from "vitest";
import { compileToGo } from "./compile-go.js";

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
 * Assert the property: compileToGo either succeeds with Go-only output
 * or throws CannotLowerToGoError. No other outcome is acceptable.
 *
 * On success, verify that common TS-syntax markers are absent from the output.
 */
function assertLowersCleanlyOrThrowsLoud(src: string): void {
  let result: { source: string } | undefined;
  let thrown: unknown;

  try {
    result = compileToGo(makeRow(src));
  } catch (err) {
    thrown = err;
  }

  if (thrown !== undefined) {
    // The only acceptable error class is CannotLowerToGoError.
    expect(thrown, `Expected CannotLowerToGoError but got: ${String(thrown)}`).toBeInstanceOf(
      CannotLowerToGoError,
    );
    // When it does throw, the error must carry a non-empty nodeKind and a
    // parseable location so the next implementer can act on it.
    if (thrown instanceof CannotLowerToGoError) {
      expect(thrown.nodeKind.length).toBeGreaterThan(0);
      expect(thrown.location.line).toBeGreaterThanOrEqual(1);
      expect(thrown.location.column).toBeGreaterThanOrEqual(0);
    }
    return;
  }

  // Success path: assert no raw TS syntax leaked into the Go output.
  const source = result?.source;
  // TS keywords that must NOT appear verbatim in Go output
  expect(source).not.toMatch(/\bconst\s+\w/);
  expect(source).not.toMatch(/\blet\s+\w/);
  expect(source).not.toMatch(/\bvar\s+\w+\s*=/);
  expect(source).not.toMatch(/\binterface\s+\w/);
  expect(source).not.toMatch(/\btype\s+\w+\s*=/);
  // Arrow functions must not appear verbatim
  expect(source).not.toMatch(/=>/);
  // TS cast / non-null assertion must not appear verbatim
  expect(source).not.toMatch(/ as \w/);
  expect(source).not.toMatch(/\w!/);
  // Must have a package declaration
  expect(source).toMatch(/^package \w+/m);
}

// ---------------------------------------------------------------------------
// Atom corpus — IR atoms that test all major lowerStatement branches
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
    "const declaration",
    `export function square(x: number): number {
  const y = x * x;
  return y;
}`,
  ],
  [
    "for-of loop",
    `export function sumArr(xs: number[]): number {
  let total = 0;
  for (const x of xs) { total = total + x; }
  return total;
}`,
  ],
  [
    "while loop",
    `export function countdown(n: number): number {
  while (n > 0) { n = n - 1; }
  return n;
}`,
  ],
  ["boolean return", "export function negate(b: boolean): boolean { return !b; }"],
  ["string return", "export function echo(s: string): string { return s; }"],
  [
    "array parameter and return",
    `export function firstOrZero(xs: number[]): number {
  if (xs.length === 0) { return 0; }
  return xs[0] as number;
}`,
  ],
  [
    "Record type parameter",
    `export function lookup(m: Record<string, number>, key: string): number {
  return (m[key] as number);
}`,
  ],
  [
    "generic function <T>",
    `export function identity<T>(x: T): T {
  return x;
}`,
  ],
  [
    "generic function <T, R>",
    `export function mapFirst<T, R>(xs: T[], fn: R): R {
  return fn;
}`,
  ],
  [
    "comparison expression",
    `export function isPositive(x: number): boolean {
  return x > 0;
}`,
  ],
  [
    "element access",
    `export function head(xs: number[]): number {
  return xs[0] as number;
}`,
  ],
];

// ---------------------------------------------------------------------------
// Property test: each atom either lowers cleanly or throws CannotLowerToGoError
// ---------------------------------------------------------------------------

describe("compileToGo — bug-class closure (WI-973)", () => {
  it.each(ATOMS)(
    "atom '%s' either lowers to valid Go or throws CannotLowerToGoError",
    (_label, src) => {
      assertLowersCleanlyOrThrowsLoud(src);
    },
  );
});

// ---------------------------------------------------------------------------
// Compound-interaction test: full production sequence end-to-end
//
// Covers the real production path:
//   compileToGo -> lowerSource -> lowerFunctionDecl
//              -> lowerBlock -> lowerStatement (multiple branches)
//              -> lowerExpr (multiple branches)
//
// Crosses lowerStatement, lowerExpr, lowerBinary, lowerTypeNode component
// boundaries in a single realistic atom that uses multiple node kinds.
// ---------------------------------------------------------------------------

describe("compileToGo — compound interaction (all major node paths)", () => {
  const COMPLEX_ATOM = `
export function sumPositives(xs: number[]): number {
  let total = 0;
  for (const x of xs) {
    if (x > 0) {
      total = total + x;
    }
  }
  return total;
}`;

  it("lowers complex atom without leaking TS syntax", () => {
    assertLowersCleanlyOrThrowsLoud(COMPLEX_ATOM);
  });

  it("on success: source contains func, range, and return", () => {
    let source: string | undefined;
    try {
      source = compileToGo(makeRow(COMPLEX_ATOM)).source;
    } catch (err) {
      expect(err).toBeInstanceOf(CannotLowerToGoError);
      return;
    }
    expect(source).toContain("func SumPositives(");
    expect(source).toContain("range xs");
    expect(source).toContain("return total");
  });
});

// ---------------------------------------------------------------------------
// Regression: formerly-unhandled constructs now throw CannotLowerToGoError
// ---------------------------------------------------------------------------

describe("compileToGo — formerly-unhandled constructs throw CannotLowerToGoError", () => {
  it("template literal throws CannotLowerToGoError", () => {
    const src = "export function greet(name: string): string { return `Hello, ${name}!`; }";
    expect(() => compileToGo(makeRow(src))).toThrowError(CannotLowerToGoError);
  });

  it("thrown error names the node kind and has a location", () => {
    const src = "export function greet(name: string): string { return `Hello, ${name}!`; }";
    let err: unknown;
    try {
      compileToGo(makeRow(src));
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(CannotLowerToGoError);
    if (err instanceof CannotLowerToGoError) {
      expect(err.nodeKind.length).toBeGreaterThan(0);
      expect(err.location.line).toBeGreaterThanOrEqual(1);
      expect(err.message).toContain("Cannot lower TS-subset IR to Go");
    }
  });
});
