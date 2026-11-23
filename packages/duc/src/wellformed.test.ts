// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { V, mkGraph } from "./testkit.js";
import { defMap, diamondSources, nodeId, nodeIndex, sources, valueId } from "./types.js";
import { isWellFormed } from "./wellformed.js";

describe("types helpers", () => {
  const graph = mkGraph(
    [
      { id: "n0", out: ["a"], kind: "param-source" },
      {
        id: "n1",
        out: ["b"],
        kind: "diamond-source",
        diamond: { reason: "free-identifier", symbol: "X" },
      },
      { id: "n2", in: ["a", "b"], out: ["c"], kind: "op" },
    ],
    ["c"],
  );

  it("defMap maps every value to its single definer", () => {
    const def = defMap(graph);
    expect(def.get(V("a"))).toBe("n0");
    expect(def.get(V("c"))).toBe("n2");
    expect(def.size).toBe(3);
  });

  it("nodeIndex indexes by id", () => {
    expect(nodeIndex(graph).get(nodeId("n2"))?.kind).toBe("op");
  });

  it("sources are the 0-ary nodes; diamondSources are the labelled ones", () => {
    expect(
      sources(graph)
        .map((n) => n.id)
        .sort(),
    ).toEqual(["n0", "n1"]);
    expect(diamondSources(graph).map((n) => n.id)).toEqual(["n1"]);
  });

  it("branded constructors are identity at runtime", () => {
    expect(valueId("a")).toBe("a");
    expect(nodeId("n0")).toBe("n0");
  });
});

describe("isWellFormed", () => {
  it("accepts a well-formed graph and returns a ranking respecting every edge", () => {
    const graph = mkGraph(
      [
        { id: "n0", out: ["a"], kind: "param-source" },
        { id: "n1", out: ["b"], kind: "param-source" },
        { id: "n2", in: ["a", "b"], out: ["c"], kind: "op" },
      ],
      ["c"],
    );
    const result = isWellFormed(graph);
    expect(result.wellFormed).toBe(true);
    if (!result.wellFormed) throw new Error("unreachable");
    // every edge x -> y has rank(x) < rank(y)
    const r = result.ranking;
    const rankA = r.get(V("a")) ?? -1;
    const rankN2 = r.get(nodeId("n2")) ?? -1;
    const rankC = r.get(V("c")) ?? -1;
    expect(rankA).toBeLessThan(rankN2);
    expect(rankN2).toBeLessThan(rankC);
    expect(r.size).toBe(6); // 3 values + 3 nodes
  });

  it("reports a conservation violation for a use with no def", () => {
    const graph = mkGraph([{ id: "n0", in: ["missing"], out: ["y"], kind: "op" }], ["y"]);
    const result = isWellFormed(graph);
    expect(result.wellFormed).toBe(false);
    if (result.wellFormed) throw new Error("unreachable");
    expect(result.violations).toContainEqual({
      kind: "conservation",
      value: "missing",
      usedBy: "n0",
    });
  });

  it("reports a conservation violation for a dangling observation", () => {
    const graph = mkGraph([{ id: "n0", out: ["a"], kind: "param-source" }], ["ghost"]);
    const result = isWellFormed(graph);
    if (result.wellFormed) throw new Error("unreachable");
    expect(result.violations).toContainEqual({
      kind: "conservation",
      value: "ghost",
      usedBy: "obs",
    });
  });

  it("reports a single-assignment violation when a value has two definers", () => {
    const graph = mkGraph(
      [
        { id: "n0", out: ["a"], kind: "param-source" },
        { id: "n1", out: ["a"], kind: "param-source" },
      ],
      [],
    );
    const result = isWellFormed(graph);
    if (result.wellFormed) throw new Error("unreachable");
    expect(result.violations).toContainEqual({
      kind: "single-assignment",
      value: "a",
      definedBy: ["n0", "n1"],
    });
  });

  it("detects an acyclicity violation and returns a cycle witness", () => {
    // n0: b -> a ; n1: a -> b  is a def-use cycle.
    const graph = mkGraph(
      [
        { id: "n0", in: ["b"], out: ["a"], kind: "op" },
        { id: "n1", in: ["a"], out: ["b"], kind: "op" },
      ],
      [],
    );
    const result = isWellFormed(graph);
    expect(result.wellFormed).toBe(false);
    if (result.wellFormed) throw new Error("unreachable");
    const violation = result.violations[0];
    expect(violation?.kind).toBe("acyclicity");
    if (violation?.kind !== "acyclicity") throw new Error("unreachable");
    // The cycle closes on itself (first element repeats at the end).
    expect(violation.cycle.length).toBeGreaterThanOrEqual(3);
    expect(violation.cycle[0]).toBe(violation.cycle[violation.cycle.length - 1]);
  });

  it("extracts a cycle even when acyclic vertices are scanned first", () => {
    // n0 (a) is acyclic and ranks; the c<->b pair is the cycle. Values are
    // inserted a, c, b so the cycle-extraction scan skips the ranked `a` first.
    const graph = mkGraph(
      [
        { id: "n0", out: ["a"], kind: "param-source" },
        { id: "n1", in: ["b"], out: ["c"], kind: "op" },
        { id: "n2", in: ["c"], out: ["b"], kind: "op" },
      ],
      ["a"],
    );
    const result = isWellFormed(graph);
    if (result.wellFormed) throw new Error("unreachable");
    const violation = result.violations[0];
    expect(violation?.kind).toBe("acyclicity");
    if (violation?.kind !== "acyclicity") throw new Error("unreachable");
    expect(violation.cycle).not.toContain("a");
  });

  it("checks structural clauses before acyclicity (a broken graph reports the structural fault)", () => {
    const graph = mkGraph([{ id: "n0", in: ["x"], out: ["y"], kind: "op" }], []);
    const result = isWellFormed(graph);
    if (result.wellFormed) throw new Error("unreachable");
    expect(result.violations.every((v) => v.kind !== "acyclicity")).toBe(true);
  });
});
