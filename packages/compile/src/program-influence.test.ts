// SPDX-License-Identifier: MIT
import type { BlockMerkleRoot, SpecHash } from "@yakcc/contracts";
import { describe, expect, it } from "vitest";
import { analyzeProgramInfluence, checkStrictnessRefinement } from "./program-influence.js";
import type { ResolutionResult, ResolvedBlock } from "./resolve.js";

/** Build a ResolutionResult from blocks given leaves-first (callees before callers). */
function resolution(
  entry: string,
  blocks: ReadonlyArray<{ root: string; source: string; subBlocks?: readonly string[] }>,
): ResolutionResult {
  const map = new Map<BlockMerkleRoot, ResolvedBlock>();
  for (const b of blocks) {
    map.set(b.root as BlockMerkleRoot, {
      merkleRoot: b.root as BlockMerkleRoot,
      specHash: `${b.root}-spec` as SpecHash,
      source: b.source,
      subBlocks: (b.subBlocks ?? []).map((s) => s as BlockMerkleRoot),
    });
  }
  return {
    entry: entry as BlockMerkleRoot,
    blocks: map,
    order: blocks.map((b) => b.root as BlockMerkleRoot),
  };
}

describe("analyzeProgramInfluence — external unknown-support (W1/W2 at program scope)", () => {
  it("aggregates external unknowns and excludes internal sub-block calls", () => {
    const program = resolution("entry", [
      // leaf: reads the ambient Math (external)
      {
        root: "helper",
        source: "export function helper(p: number): number { return Math.abs(p); }",
      },
      // entry: imports helper as a sub-block (internal) and getData from a package (external)
      {
        root: "entry",
        source:
          'import type { helper } from "./helper";\n' +
          'import { getData } from "external-pkg";\n' +
          "export function f(x: number): number { return helper(getData(x)); }",
        subBlocks: ["helper"],
      },
    ]);
    const result = analyzeProgramInfluence(program);
    const symbols = result.externalUnknowns.map((u) => u.symbol).sort();
    expect(symbols).toEqual(["Math", "getData"]);
    expect(symbols).not.toContain("helper"); // resolved by composition — internal
    // the module is recorded for the foreign import
    expect(result.externalUnknowns.find((u) => u.symbol === "getData")).toMatchObject({
      reason: "foreign-import",
      module: "external-pkg",
    });
  });
});

describe("analyzeProgramInfluence — closure over summaries (no sub-body re-traversal)", () => {
  it("narrows a caller's influence using the callee's summary", () => {
    // helper propagates only its first parameter; the caller passes (a, b).
    const program = resolution("entry", [
      {
        root: "helper",
        source: "export function helper(p: number, q: number): number { return p; }",
      },
      {
        root: "entry",
        source:
          'import type { helper } from "./helper";\n' +
          "export function f(a: number, b: number): number { return helper(a, b); }",
        subBlocks: ["helper"],
      },
    ]);
    const result = analyzeProgramInfluence(program);

    // helper's own summary: p -> obs, q -> (nothing).
    expect(result.blocks.get("helper" as BlockMerkleRoot)?.summary).toEqual([[true], [false]]);

    // entry's composed summary: a reaches the result, b does NOT — because the
    // callee summary drops its second parameter. An opaque call would give
    // [[true],[true]]; composition narrows it to [[true],[false]].
    expect(result.entryInfluence?.summary).toEqual([[true], [false]]);
  });

  it("falls back to opaque when the call arity does not match the callee", () => {
    // entry calls helper with one argument, but helper declares two parameters.
    const program = resolution("entry", [
      {
        root: "helper",
        source: "export function helper(p: number, q: number): number { return p; }",
      },
      {
        root: "entry",
        source:
          'import type { helper } from "./helper";\n' +
          "export function f(a: number): number { return helper(a); }",
        subBlocks: ["helper"],
      },
    ]);
    const result = analyzeProgramInfluence(program);
    // arity mismatch → opaque call → a still (soundly) reaches the result.
    expect(result.entryInfluence?.summary).toEqual([[true]]);
  });
});

describe("analyzeProgramInfluence — robustness", () => {
  it("records a lift error for an unliftable block without crashing the analysis", () => {
    const program = resolution("entry", [{ root: "entry", source: "export function f( {" }]);
    const result = analyzeProgramInfluence(program);
    const entry = result.entryInfluence;
    expect(entry?.liftError).toBeDefined();
    expect(entry?.summary).toEqual([]);
  });
});

describe("checkStrictnessRefinement (W5 strictness falsifier)", () => {
  const looser = "export function f(a: number, b: number): number { return g(a); }";
  const addsEdge = "export function f(a: number, b: number): number { return g(a, b); }";

  it("accepts a genuine refinement (influence only removed)", () => {
    expect(checkStrictnessRefinement(looser, addsEdge)).toEqual({ refines: true });
  });

  it("rejects a claimed-stricter block that adds an influence edge", () => {
    const result = checkStrictnessRefinement(addsEdge, looser);
    expect(result.refines).toBe(false);
    if (result.refines) throw new Error("unreachable");
    expect(result.reason).toBe("added-influence");
  });

  it("reports boundary-mismatch when a source cannot be lifted", () => {
    expect(checkStrictnessRefinement("export function f( {", looser)).toEqual({
      refines: false,
      reason: "boundary-mismatch",
      added: [],
    });
  });
});
