// SPDX-License-Identifier: Apache-2.0
// Property tests for the invariants the DUC layer must never violate.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  influenceCone,
  mayInfluence,
  mayInfluencePairs,
  renderWitness,
  usupp,
  witness,
} from "./influence.js";
import { liftAtom } from "./lift.js";
import { type NodeSpec, mkGraph } from "./testkit.js";
import { diamondSources } from "./types.js";
import type { DucGraph, ValueId } from "./types.js";
import { isWellFormed } from "./wellformed.js";

// ---------------------------------------------------------------------------
// A generator of well-formed graphs: sources first, then ops whose inputs are
// drawn only from already-defined values (so acyclic + single-assignment +
// conservation hold by construction).
// ---------------------------------------------------------------------------
const arbGraph: fc.Arbitrary<DucGraph> = fc
  .record({
    sources: fc.array(fc.boolean(), { minLength: 1, maxLength: 4 }), // true => diamond
    ops: fc.array(fc.array(fc.nat(), { minLength: 1, maxLength: 3 }), { maxLength: 8 }),
    obsSeed: fc.array(fc.nat(), { minLength: 1, maxLength: 4 }),
  })
  .map(({ sources, ops, obsSeed }) => {
    const specs: NodeSpec[] = [];
    const values: string[] = [];
    let v = 0;
    let n = 0;
    sources.forEach((isDiamond, i) => {
      const value = `v${v++}`;
      values.push(value);
      specs.push({
        id: `n${n++}`,
        out: [value],
        kind: isDiamond ? "diamond-source" : "param-source",
        ...(isDiamond ? { diamond: { reason: "free-identifier" as const, symbol: `X${i}` } } : {}),
      });
    });
    for (const pick of ops) {
      const inputs = pick.map((p) => values[p % values.length] as string);
      const value = `v${v++}`;
      values.push(value);
      specs.push({ id: `n${n++}`, in: inputs, out: [value], kind: "op" });
    }
    const obs = [...new Set(obsSeed.map((s) => values[s % values.length] as string))];
    return mkGraph(specs, obs);
  });

describe("graph invariants (generated well-formed graphs)", () => {
  it("the constructed graph is always well-formed", () => {
    fc.assert(
      fc.property(arbGraph, (graph) => {
        expect(isWellFormed(graph).wellFormed).toBe(true);
      }),
    );
  });

  it("may-influence is irreflexive and matches the backward cone", () => {
    fc.assert(
      fc.property(arbGraph, (graph) => {
        for (const value of graph.values) {
          const cone = influenceCone(graph, value);
          expect(cone.has(value)).toBe(false);
          for (const source of cone) {
            expect(mayInfluence(graph, source, value)).toBe(true);
          }
        }
      }),
    );
  });

  it("may-influence is transitive", () => {
    fc.assert(
      fc.property(arbGraph, (graph) => {
        const reach = new Map<ValueId, ReadonlySet<ValueId>>();
        for (const value of graph.values) reach.set(value, influenceCone(graph, value));
        for (const [target, cone] of reach) {
          for (const mid of cone) {
            // everything that influences `mid` also influences `target`
            for (const deep of reach.get(mid) ?? []) {
              expect(cone.has(deep)).toBe(true);
            }
          }
        }
      }),
    );
  });

  it("usupp of any value is a subset of the graph's diamond-sources and reaches it", () => {
    fc.assert(
      fc.property(arbGraph, (graph) => {
        const diamondValues = new Set(diamondSources(graph).flatMap((n) => n.outputs));
        for (const value of graph.values) {
          for (const support of usupp(graph, value)) {
            expect(diamondValues.has(support.value)).toBe(true);
            const reaches =
              support.value === value || influenceCone(graph, value).has(support.value);
            expect(reaches).toBe(true);
          }
        }
      }),
    );
  });

  it("every witness terminates and its leaves are exactly the sources it depends on", () => {
    fc.assert(
      fc.property(arbGraph, (graph) => {
        for (const value of graph.values) {
          const term = witness(graph, value);
          expect(() => renderWitness(term)).not.toThrow();
          // A leaf is a term with no children; its value must be a source (0-ary node).
          const sourceValues = new Set(
            graph.nodes.filter((nd) => nd.inputs.length === 0).flatMap((nd) => nd.outputs),
          );
          const leaves: ValueId[] = [];
          const walk = (t: ReturnType<typeof witness>): void => {
            if (t.children.length === 0) leaves.push(t.value);
            else t.children.forEach(walk);
          };
          walk(term);
          for (const leaf of leaves) expect(sourceValues.has(leaf)).toBe(true);
        }
      }),
    );
  });

  it("mayInfluencePairs equals the union of per-target cones", () => {
    fc.assert(
      fc.property(arbGraph, (graph) => {
        const fromPairs = new Set(mayInfluencePairs(graph).map(([e, f]) => `${e}->${f}`));
        const fromCones = new Set<string>();
        for (const value of graph.values) {
          for (const source of influenceCone(graph, value)) fromCones.add(`${source}->${value}`);
        }
        expect(fromPairs).toEqual(fromCones);
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// A generator of arithmetic expressions over params a,b,c plus a free call.
// ---------------------------------------------------------------------------
const { expr } = fc.letrec((tie) => ({
  expr: fc.oneof(
    { maxDepth: 3, depthSize: "small" },
    fc.constantFrom("a", "b", "c", "1", "k()"),
    fc
      .tuple(tie("expr"), fc.constantFrom("+", "-", "*"), tie("expr"))
      .map(([l, op, r]) => `(${String(l)} ${op} ${String(r)})`),
  ),
})) as { expr: fc.Arbitrary<string> };

describe("lift invariants (generated expressions)", () => {
  it("every lift is well-formed and every mentioned parameter influences the result", () => {
    fc.assert(
      fc.property(expr, (body) => {
        const src = `export function g(a: number, b: number, c: number): number { return ${body}; }`;
        const graph = liftAtom(src);
        expect(isWellFormed(graph).wellFormed).toBe(true);
        const obs = graph.obs[0] as ValueId;
        const params = graph.nodes.filter((nd) => nd.kind === "param-source");
        ["a", "b", "c"].forEach((name, i) => {
          if (new RegExp(`\\b${name}\\b`).test(body)) {
            const value = params[i]?.outputs[0] as ValueId;
            // "influences" includes the degenerate case where the body is the
            // bare parameter (value === obs); may-influence is irreflexive.
            expect(value === obs || mayInfluence(graph, value, obs)).toBe(true);
          }
        });
      }),
      { numRuns: 200 },
    );
  });
});
