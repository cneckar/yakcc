/**
 * Tests for the STEF (Single Typed Exported Function) predicate and the
 * decompose() fast-path it enables. P0 fix for #549.
 *
 * @decision DEC-SHAVE-WHOLE-FUNCTION-PRESERVATION-001
 * status: decided
 *
 * Production sequence:
 *   1. decompose() receives a TypeScript source string.
 *   2. It parses the source into a ts-morph Project (in-memory).
 *   3. matchesStefPredicate() is called on the SourceFile.
 *   4a. If true  → return a single AtomLeaf covering the full file. No recursion.
 *   4b. If false → continue through the normal glue-aware fragmentation walk.
 *
 * Compound-interaction test: "arrayMedian-style STEF source returns one atom via
 * decompose()" exercises the full end-to-end production sequence — it crosses the
 * decompose() → matchesStefPredicate() boundary in the same way production does,
 * and asserts on the RecursionTree rather than only on the predicate.
 */

import type { BlockMerkleRoot } from "@yakcc/contracts";
import { Project } from "ts-morph";
import { describe, expect, it } from "vitest";
import type { ShaveRegistryView } from "../types.js";
import { decompose } from "./recursion.js";
import { matchesStefPredicate } from "./stef.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function loadSource(code: string) {
  const project = new Project({ useInMemoryFileSystem: true });
  return project.createSourceFile("test.ts", code);
}

/** A registry that always returns no matches — no known primitives. */
const emptyRegistry: Pick<ShaveRegistryView, "findByCanonicalAstHash"> = {
  findByCanonicalAstHash: async () => [],
};

// ---------------------------------------------------------------------------
// matchesStefPredicate unit tests
// ---------------------------------------------------------------------------

describe("matchesStefPredicate (P0 #549)", () => {
  it("returns true for arrayMedian-style single typed exported function", () => {
    const source = loadSource(`
      /**
       * Compute the median of a numeric array using O(n log n) sort.
       * Returns NaN for empty arrays.
       */
      export function arrayMedian(values: readonly number[]): number {
        if (values.length === 0) return NaN;
        const sorted = [...values].sort((a, b) => a - b);
        const mid = Math.floor(sorted.length / 2);
        return sorted.length % 2 === 0 ? (sorted[mid-1]! + sorted[mid]!) / 2 : sorted[mid]!;
      }
    `);
    expect(matchesStefPredicate(source)).toBe(true);
  });

  it("returns false for multi-function source", () => {
    const source = loadSource(`
      /** A */ export function a(x: number): number { return x; }
      /** B */ export function b(y: string): string { return y; }
    `);
    expect(matchesStefPredicate(source)).toBe(false);
  });

  it("returns true for STEF + import + type alias + interface noise", () => {
    const source = loadSource(`
      import { something } from "elsewhere";
      export type Foo = number;
      export interface Bar { x: number; }
      /** doc */ export function fn(x: number): number { return x; }
    `);
    expect(matchesStefPredicate(source)).toBe(true);
  });

  it("returns false when a parameter has no type annotation (implicit any)", () => {
    // TypeScript strict mode would reject this, but ts-morph accepts it; STEF must not.
    const source = loadSource(`
      /** doc */ export function fn(x): number { return (x as number); }
    `);
    expect(matchesStefPredicate(source)).toBe(false);
  });

  it("returns false when JSDoc is absent (only a line comment)", () => {
    const source = loadSource(`
      // just a line comment
      export function fn(x: number): number { return x; }
    `);
    expect(matchesStefPredicate(source)).toBe(false);
  });

  it("returns false when return type is implicit", () => {
    const source = loadSource(`
      /** doc */ export function fn(x: number) { return x + 1; }
    `);
    expect(matchesStefPredicate(source)).toBe(false);
  });

  it("returns true for parse-rfc3339-utc shape (export interface + export function)", () => {
    // Reviewer R0 finding 2: exported interface alongside exported function is a
    // real shape in the B7 failure set (parse-rfc3339-utc). STEF must admit it.
    const source = loadSource(`
      /** Result components of a parsed RFC 3339 datetime. */
      export interface Components {
        year: number;
        month: number;
      }
      /** Parse an RFC 3339 datetime string into its components. */
      export function parse(s: string): Components {
        return { year: 2026, month: 1 };
      }
    `);
    expect(matchesStefPredicate(source)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// decompose() fast-path integration tests (compound-interaction)
// ---------------------------------------------------------------------------

describe("decompose() STEF fast-path (P0 #549)", () => {
  it("returns a single AtomLeaf for arrayMedian-style STEF source", async () => {
    const source = `
/**
 * Compute the median of a numeric array using O(n log n) sort.
 * Returns NaN for empty arrays.
 */
export function arrayMedian(values: readonly number[]): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid-1]! + sorted[mid]!) / 2 : sorted[mid]!;
}
`.trim();

    const tree = await decompose(source, emptyRegistry);

    // Fast-path must produce exactly one leaf (the whole file), not a branch tree.
    expect(tree.leafCount).toBe(1);
    expect(tree.maxDepth).toBe(0);
    expect(tree.root.kind).toBe("atom");

    if (tree.root.kind === "atom") {
      expect(tree.root.atomTest.reason).toBe("single-typed-exported-function");
      expect(tree.root.atomTest.isAtom).toBe(true);
      // The source range must span the full source text.
      // start=0 because the fast-path uses file.getFullStart() (includes leading
      // trivia / JSDoc bytes). end must equal source.length.
      expect(tree.root.sourceRange.start).toBe(0);
      expect(tree.root.sourceRange.end).toBe(source.length);
      // The leaf source must be the entire source string.
      expect(tree.root.source).toBe(source);
    }
  });

  it("multi-function source does NOT use the STEF fast-path (glue-aware path unchanged)", async () => {
    // DEC-V2-GLUE-AWARE-SHAVE-001 invariant: non-STEF source must not be changed.
    // Key invariant to verify: the STEF fast-path was NOT taken (reason must not
    // be "single-typed-exported-function"). The existing isAtom() / fragmentation
    // behavior for multi-function source is unchanged — this test guards against
    // STEF wrongly claiming files it should not.
    const source = `
/** A */ export function a(x: number): number { return x; }
/** B */ export function b(y: number): number { return y; }
`.trim();

    const tree = await decompose(source, emptyRegistry);

    // The STEF fast-path must NOT have fired: the reason must not be
    // "single-typed-exported-function". The exact leaf count and branch/atom
    // shape are determined by the existing isAtom() classification and are not
    // our invariant here.
    const reason = tree.root.kind === "atom" ? tree.root.atomTest.reason : "branch";
    expect(reason).not.toBe("single-typed-exported-function");
  });

  it("STEF + import/type/interface still returns one atom via decompose()", async () => {
    const source = `
import { something } from "elsewhere";
export type Foo = number;
export interface Bar { x: number; }
/** doc */
export function fn(x: number): number { return x; }
`.trim();

    const tree = await decompose(source, emptyRegistry);

    expect(tree.leafCount).toBe(1);
    expect(tree.root.kind).toBe("atom");
    if (tree.root.kind === "atom") {
      expect(tree.root.atomTest.reason).toBe("single-typed-exported-function");
    }
  });

  it("parse-rfc3339-utc shape (export interface + export function) returns one atom", async () => {
    const source = `
/** Result components of a parsed RFC 3339 datetime. */
export interface Components {
  year: number;
  month: number;
}
/** Parse an RFC 3339 datetime string into its components. */
export function parse(s: string): Components {
  return { year: 2026, month: 1 };
}
`.trim();

    const tree = await decompose(source, emptyRegistry);

    expect(tree.leafCount).toBe(1);
    expect(tree.root.kind).toBe("atom");
    if (tree.root.kind === "atom") {
      expect(tree.root.atomTest.reason).toBe("single-typed-exported-function");
    }
  });
});
