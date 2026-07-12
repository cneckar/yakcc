// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import {
  RefineError,
  boundaryType,
  paramSources,
  paramSummaryMatrix,
  refine,
  refinementIsMonotone,
  refinesInfluence,
} from "./compose.js";
import { influenceCone, influenceIndexWithSummaries } from "./influence.js";
import { N, V, mkGraph } from "./testkit.js";
import type { NodeId } from "./types.js";
import { isWellFormed } from "./wellformed.js";

// host: params a,b feed an opaque node -> c ; obs c
const host = mkGraph(
  [
    { id: "n0", out: ["a"], kind: "param-source" },
    { id: "n1", out: ["b"], kind: "param-source" },
    { id: "n2", in: ["a", "b"], out: ["c"], kind: "op" },
  ],
  ["c"],
);

// sub: real callee that only uses its first parameter -> shrinks influence.
const sub = mkGraph(
  [
    { id: "s0", out: ["p"], kind: "param-source" },
    { id: "s1", out: ["q"], kind: "param-source" },
    { id: "s2", in: ["p"], out: ["r"], kind: "op" },
  ],
  ["r"],
);

describe("boundary + summary", () => {
  it("boundaryType counts params, diamonds, and observations", () => {
    const g = mkGraph(
      [
        { id: "n0", out: ["a"], kind: "param-source" },
        {
          id: "n1",
          out: ["x"],
          kind: "diamond-source",
          diamond: { reason: "ambient-read", symbol: "Math" },
        },
        { id: "n2", in: ["a", "x"], out: ["c"], kind: "op" },
      ],
      ["c"],
    );
    expect(boundaryType(g)).toEqual({ params: 1, diamonds: 1, obs: 1 });
  });

  it("paramSources are the param-source nodes in emission order", () => {
    expect(paramSources(host).map((n) => n.id)).toEqual(["n0", "n1"]);
  });

  it("paramSummaryMatrix reports which params reach which observations", () => {
    expect(paramSummaryMatrix(host)).toEqual([[true], [true]]);
  });

  it("treats a parameter that is itself an observation as influencing it", () => {
    const g = mkGraph([{ id: "n0", out: ["a"], kind: "param-source" }], ["a"]);
    expect(paramSummaryMatrix(g)).toEqual([[true]]);
  });
});

describe("refine", () => {
  it("splices a subgraph in place of an opaque node, preserving well-formedness", () => {
    const refined = refine(host, N("n2"), sub);
    expect(isWellFormed(refined).wellFormed).toBe(true);
    // c is now defined by the spliced sub node, reading only a (p -> a).
    const definer = refined.nodes.find((n) => n.outputs.includes(V("c")));
    expect(definer?.inputs).toEqual(["a"]);
    expect(refined.obs).toEqual(["c"]);
  });

  it("refinement only removes influence (monotone): b no longer reaches c", () => {
    const refined = refine(host, N("n2"), sub);
    expect(paramSummaryMatrix(refined)).toEqual([[true], [false]]);
    expect(refinementIsMonotone(host, N("n2"), sub)).toEqual({ refines: true });
  });

  it("renames a subgraph's internal (non-boundary) values under a fresh prefix", () => {
    // A two-level sub: mid is neither a parameter-source output nor an observation,
    // so it must be renamed under the splice prefix (not identified with a host value).
    const deep = mkGraph(
      [
        { id: "s0", out: ["p"], kind: "param-source" },
        { id: "s1", out: ["q"], kind: "param-source" },
        { id: "s2", in: ["p", "q"], out: ["mid"], kind: "op" },
        { id: "s3", in: ["mid"], out: ["r"], kind: "op" },
      ],
      ["r"],
    );
    const refined = refine(host, N("n2"), deep);
    expect(isWellFormed(refined).wellFormed).toBe(true);
    // the internal value is present under the "n2::" prefix, distinct from host ids
    expect(refined.values.some((v) => v.startsWith("n2::"))).toBe(true);
    // both params still reach c through the two-level sub
    expect(paramSummaryMatrix(refined)).toEqual([[true], [true]]);
  });

  it("carries a spliced subgraph's own diamond-sources and origins into the result", () => {
    // The sub reveals an internal unknown (♦Z) when we look inside the opaque node.
    const withUnknown = mkGraph(
      [
        { id: "s0", out: ["p"], kind: "param-source" },
        { id: "s1", out: ["q"], kind: "param-source" },
        {
          id: "s2",
          out: ["z"],
          kind: "diamond-source",
          diamond: { reason: "free-identifier", symbol: "Z" },
          origin: { kind: "DiamondSource", text: "Z" },
        },
        { id: "s3", in: ["p", "z"], out: ["r"], kind: "op", origin: { kind: "Binary", text: "+" } },
      ],
      ["r"],
    );
    const refined = refine(host, N("n2"), withUnknown);
    expect(isWellFormed(refined).wellFormed).toBe(true);
    // the revealed unknown is now a source of the whole program
    const revealed = refined.nodes.find((n) => n.diamond?.symbol === "Z");
    expect(revealed?.origin?.kind).toBe("DiamondSource");
    expect(boundaryType(refined).diamonds).toBe(1);
  });

  it("throws when the node is absent", () => {
    expect(() => refine(host, N("nope"), sub)).toThrow(RefineError);
  });

  it("throws on input-arity mismatch", () => {
    const oneParam = mkGraph(
      [
        { id: "s0", out: ["p"], kind: "param-source" },
        { id: "s2", in: ["p"], out: ["r"], kind: "op" },
      ],
      ["r"],
    );
    expect(() => refine(host, N("n2"), oneParam)).toThrow(/arity/);
  });

  it("throws on output-arity mismatch", () => {
    const twoObs = mkGraph(
      [
        { id: "s0", out: ["p"], kind: "param-source" },
        { id: "s1", out: ["q"], kind: "param-source" },
        { id: "s2", in: ["p", "q"], out: ["r", "t"], kind: "op" },
      ],
      ["r", "t"],
    );
    expect(() => refine(host, N("n2"), twoObs)).toThrow(/arity/);
  });

  it("throws on an unsupported pass-through parameter->observation", () => {
    // s0's output p is both a parameter-source output and an observation, and is
    // read by the kept node s2 — the pass-through the v1 splice rejects.
    const passthrough = mkGraph(
      [
        { id: "s0", out: ["p"], kind: "param-source" },
        { id: "s1", out: ["q"], kind: "param-source" },
        { id: "s2", in: ["p"], out: ["r"], kind: "op" },
      ],
      ["p"],
    );
    expect(() => refine(host, N("n2"), passthrough)).toThrow(/pass-through/);
  });
});

describe("influence with summaries (DUC Thm 6.2(2): closure over summaries == inlining)", () => {
  it("a summarized node propagates only the allowed port pairs", () => {
    // n2 opaque over [a,b] -> c. Summarize it to pass only input 0 (a) -> output 0 (c).
    const summaries = new Map<NodeId, ReadonlySet<string>>([[N("n2"), new Set(["0->0"])]]);
    const cone = influenceCone(host, V("c"), influenceIndexWithSummaries(host, summaries));
    expect([...cone].sort()).toEqual(["a"]); // b no longer reaches c
  });

  it("an un-summarized node keeps the complete (opaque) relation", () => {
    const cone = influenceCone(host, V("c"), influenceIndexWithSummaries(host, new Map()));
    expect([...cone].sort()).toEqual(["a", "b"]);
  });

  it("equals inlining the callee: summary composition == refine-then-cone", () => {
    // `sub` uses only its first parameter, so its param->obs summary is [[true],[false]].
    // Applying that summary to n2 must give the same influence as refining n2 with sub.
    const viaSummary = influenceCone(
      host,
      V("c"),
      influenceIndexWithSummaries(host, new Map([[N("n2"), new Set(["0->0"])]])),
    );
    const refined = refine(host, N("n2"), sub);
    const viaInlining = influenceCone(refined, V("c"));
    expect([...viaSummary].sort()).toEqual([...viaInlining].sort());
  });
});

describe("refinesInfluence (strictness falsifier)", () => {
  const looser = mkGraph(
    [
      { id: "n0", out: ["a"], kind: "param-source" },
      { id: "n1", out: ["b"], kind: "param-source" },
      { id: "n2", in: ["a"], out: ["c"], kind: "op" },
    ],
    ["c"],
  );
  const addsEdge = mkGraph(
    [
      { id: "n0", out: ["a"], kind: "param-source" },
      { id: "n1", out: ["b"], kind: "param-source" },
      { id: "n2", in: ["a", "b"], out: ["c"], kind: "op" },
    ],
    ["c"],
  );

  it("accepts a genuine refinement (influence only removed)", () => {
    expect(refinesInfluence(looser, addsEdge)).toEqual({ refines: true });
  });

  it("rejects a claimed-stricter block that adds an influence edge", () => {
    const result = refinesInfluence(addsEdge, looser);
    expect(result.refines).toBe(false);
    if (result.refines) throw new Error("unreachable");
    expect(result.reason).toBe("added-influence");
    expect(result.added).toEqual([{ paramIndex: 1, obsIndex: 0 }]);
  });

  it("rejects a boundary-arity mismatch", () => {
    const oneParam = mkGraph([{ id: "n0", out: ["a"], kind: "param-source" }], ["a"]);
    const result = refinesInfluence(oneParam, looser);
    expect(result).toEqual({ refines: false, reason: "boundary-mismatch", added: [] });
  });
});
