// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { renderWitness } from "./influence.js";
import { graphNI, labelBySymbol } from "./ni.js";
import { N, V, mkGraph } from "./testkit.js";

// The paper's key-dependent branch (Example 5.3), leaking form: the secret KEY
// gates the selection, so it reaches the low observation through the condition.
const leakGraph = mkGraph(
  [
    {
      id: "n0",
      out: ["key"],
      kind: "diamond-source",
      diamond: { reason: "free-identifier", symbol: "KEY" },
    },
    { id: "n1", out: ["g0"], kind: "param-source" },
    { id: "n2", out: ["l0"], kind: "param-source" },
    { id: "n3", out: ["l1"], kind: "param-source" },
    { id: "n4", in: ["key", "g0"], out: ["cond"], kind: "op" },
    { id: "n5", in: ["cond", "l0", "l1"], out: ["obs"], kind: "sel" },
  ],
  ["obs"],
);

// The isolated form: the gate's condition is public and the key feeds only an
// unobserved output; graph-NI holds for every interpretation.
const isoGraph = mkGraph(
  [
    {
      id: "n0",
      out: ["key"],
      kind: "diamond-source",
      diamond: { reason: "free-identifier", symbol: "KEY" },
    },
    { id: "n1", out: ["g0"], kind: "param-source" },
    { id: "n2", out: ["gpub"], kind: "param-source" },
    { id: "n3", out: ["l0"], kind: "param-source" },
    { id: "n4", out: ["l1"], kind: "param-source" },
    { id: "n5", in: ["gpub", "g0"], out: ["cond"], kind: "op" },
    { id: "n6", in: ["cond", "l0", "l1"], out: ["obs"], kind: "sel" },
    { id: "n7", in: ["key", "obs"], out: ["mac"], kind: "op" },
  ],
  ["obs", "mac"],
);

describe("graph non-interference (Example 5.3, both verdicts)", () => {
  it("fails on the key-dependent branch, with the witness carrying the secret", () => {
    const labeling = labelBySymbol(leakGraph, new Set(["KEY"]), [V("obs")]);
    const result = graphNI(leakGraph, labeling);
    expect(result.holds).toBe(false);
    if (result.holds) throw new Error("unreachable");
    expect(result.leaks).toHaveLength(1);
    const leak = result.leaks[0];
    if (leak === undefined) throw new Error("unreachable");
    expect(leak.source).toBe("n0");
    expect(leak.obs).toBe("obs");
    expect(renderWitness(leak.witness)).toContain("♦KEY");
  });

  it("holds when the key only feeds an unobserved output", () => {
    const labeling = labelBySymbol(isoGraph, new Set(["KEY"]), [V("obs")]);
    expect(graphNI(isoGraph, labeling)).toEqual({ holds: true });
  });
});

describe("labelBySymbol", () => {
  it("labels only sources, high for the named symbols and low otherwise", () => {
    const labeling = labelBySymbol(leakGraph, new Set(["KEY"]), [V("obs")]);
    expect(labeling.sources.get(N("n0"))).toBe("high");
    expect(labeling.sources.get(N("n1"))).toBe("low");
    // op / sel nodes are not sources and are absent from the labeling.
    expect(labeling.sources.has(N("n4"))).toBe(false);
    expect(labeling.sources.size).toBe(4);
  });
});

describe("graphNI edge cases", () => {
  it("ignores a labelled source id that is not a node in the graph", () => {
    const labeling = {
      sources: new Map([[N("does-not-exist"), "high" as const]]),
      lowObs: [V("obs")],
    };
    expect(graphNI(leakGraph, labeling)).toEqual({ holds: true });
  });

  it("a backdoor implicit flow (secret only via a condition) is caught", () => {
    // secret -> gate condition -> selected observation; no explicit data path.
    const backdoor = mkGraph(
      [
        {
          id: "s",
          out: ["secret"],
          kind: "diamond-source",
          diamond: { reason: "free-identifier", symbol: "S" },
        },
        { id: "p0", out: ["a"], kind: "param-source" },
        { id: "p1", out: ["b"], kind: "param-source" },
        { id: "g", in: ["secret"], out: ["cond"], kind: "op" },
        { id: "sel", in: ["cond", "a", "b"], out: ["out"], kind: "sel" },
      ],
      ["out"],
    );
    const result = graphNI(backdoor, labelBySymbol(backdoor, new Set(["S"]), [V("out")]));
    expect(result.holds).toBe(false);
  });
});
