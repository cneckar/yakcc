// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import {
  influenceCone,
  influenceIndex,
  mayInfluence,
  mayInfluencePairs,
  renderWitness,
  usupp,
  usuppOfObservations,
  witness,
} from "./influence.js";
import { V, mkGraph } from "./testkit.js";

// A small chain with one diamond:  p(param a) , d(♦X -> x) , n(a,x -> c) , m(c -> obs)
const graph = mkGraph(
  [
    { id: "n0", out: ["a"], kind: "param-source" },
    {
      id: "n1",
      out: ["x"],
      kind: "diamond-source",
      diamond: { reason: "free-identifier", symbol: "X" },
    },
    { id: "n2", in: ["a", "x"], out: ["c"], kind: "op" },
    { id: "n3", in: ["c"], out: ["r"], kind: "op" },
  ],
  ["r"],
);

describe("may-influence", () => {
  it("one-step index has matching forward and backward edges", () => {
    const index = influenceIndex(graph);
    expect(index.forward.get(V("a"))).toEqual(["c"]);
    expect(index.backward.get(V("c"))?.sort()).toEqual(["a", "x"]);
  });

  it("influenceCone is the transitive backward set, excluding the target", () => {
    const cone = influenceCone(graph, V("r"));
    expect([...cone].sort()).toEqual(["a", "c", "x"]);
    expect(cone.has(V("r"))).toBe(false);
  });

  it("mayInfluence is transitive and irreflexive", () => {
    expect(mayInfluence(graph, V("a"), V("r"))).toBe(true);
    expect(mayInfluence(graph, V("x"), V("r"))).toBe(true);
    expect(mayInfluence(graph, V("r"), V("a"))).toBe(false);
    expect(mayInfluence(graph, V("a"), V("a"))).toBe(false);
  });

  it("mayInfluencePairs materializes exactly the reachable pairs", () => {
    const pairs = mayInfluencePairs(graph)
      .map(([e, f]) => `${e}->${f}`)
      .sort();
    expect(pairs).toEqual(["a->c", "a->r", "c->r", "x->c", "x->r"]);
  });
});

describe("usupp (unknown-support)", () => {
  it("collects the diamond-sources reaching a value", () => {
    const support = usupp(graph, V("r"));
    expect(support).toHaveLength(1);
    expect(support[0]?.label.symbol).toBe("X");
    expect(support[0]?.value).toBe("x");
  });

  it("counts a diamond value itself as its own support", () => {
    expect(usupp(graph, V("x")).map((s) => s.label.symbol)).toEqual(["X"]);
  });

  it("is empty for a value with no reachable unknowns", () => {
    expect(usupp(graph, V("a"))).toEqual([]);
  });

  it("usuppOfObservations covers every observation", () => {
    const byObs = usuppOfObservations(graph);
    expect([...byObs.keys()]).toEqual(["r"]);
    expect(byObs.get(V("r"))?.[0]?.label.symbol).toBe("X");
  });
});

describe("term-model witness", () => {
  it("builds a structural term in which the unknown occurs", () => {
    const term = witness(graph, V("r"));
    const rendered = renderWitness(term);
    expect(rendered).toContain("♦X");
    // op(op(param-source, ♦X)) shape
    expect(term.kind).toBe("op");
    expect(term.children).toHaveLength(1);
  });

  it("renders a bare source leaf", () => {
    expect(renderWitness(witness(graph, V("a")))).toBe("param-source");
    expect(renderWitness(witness(graph, V("x")))).toBe("♦X");
  });

  it("shares memoized sub-terms for repeated values", () => {
    // c feeds r once; witness of r nests c's term. Build twice, structurally equal.
    const t1 = witness(graph, V("r"));
    expect(t1.children[0]?.value).toBe("c");
  });

  it("defensively renders a dangling value as an unknown leaf", () => {
    const dangling = mkGraph([{ id: "n0", in: ["ghost"], out: ["y"], kind: "op" }], ["y"]);
    const term = witness(dangling, V("ghost"));
    expect(term.kind).toBe("unknown");
    expect(renderWitness(term)).toBe("unknown");
  });
});
