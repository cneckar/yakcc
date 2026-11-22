// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { guardedInfluence } from "./guard.js";
import { mayInfluence } from "./influence.js";
import { liftAtom } from "./lift.js";
import type { DucGraph, ValueId } from "./types.js";

const paramValue = (g: DucGraph, index = 0): ValueId =>
  g.nodes.filter((n) => n.kind === "param-source")[index]?.outputs[0] as ValueId;

describe("guard labels on influence paths (WI-GUARD A2, #1255)", () => {
  it("a flow only through a branch is guarded by its condition, and has no unguarded path", () => {
    // `y` reaches the result only through the branch `y = x` under `cond`.
    const g = liftAtom(
      "export function f(c: boolean, x: number): number { let y = 0; if (c) { y = x; } return y; }",
    );
    const obs = g.obs[0] as ValueId;
    const flow = guardedInfluence(g, paramValue(g, 1)).get(obs);
    expect(flow).toBeDefined();
    expect(flow?.unguarded).toBe(false);
    expect(flow?.guards.length).toBeGreaterThan(0);
  });

  it("the condition itself is an unguarded (implicit) flow to the result", () => {
    const g = liftAtom(
      "export function f(c: boolean, x: number): number { let y = 0; if (c) { y = x; } return y; }",
    );
    const obs = g.obs[0] as ValueId;
    const flow = guardedInfluence(g, paramValue(g, 0)).get(obs);
    expect(flow?.unguarded).toBe(true); // c reaches the result with no branch edge
    expect(flow?.guards).toEqual([]);
  });

  it("a ternary's branch is guarded; its condition is not", () => {
    const g = liftAtom(
      "export function g(c: boolean, a: number, b: number): number { return c ? a : b; }",
    );
    const obs = g.obs[0] as ValueId;
    const viaBranch = guardedInfluence(g, paramValue(g, 1)).get(obs);
    expect(viaBranch?.unguarded).toBe(false);
    expect(viaBranch?.guards.length).toBe(1);
    const viaCond = guardedInfluence(g, paramValue(g, 0)).get(obs);
    expect(viaCond?.unguarded).toBe(true);
  });

  it("a flow with no control is unguarded", () => {
    const g = liftAtom("export function f(a: number, b: number): number { return a + b; }");
    const obs = g.obs[0] as ValueId;
    const flow = guardedInfluence(g, paramValue(g, 0)).get(obs);
    expect(flow).toEqual({ unguarded: true, guards: [] });
  });

  it("reachability agrees exactly with mayInfluence (annotation never prunes)", () => {
    const sources = [
      "export function f(c: boolean, x: number, y: number): number { let r = y; if (c) { r = x; } return r; }",
      "export function f(a: number, b: number): number { return a > b ? a : b * 2; }",
      "export function f(xs: number[], k: number): number { let s = 0; for (const x of xs) { s += x * k; } return s; }",
    ];
    for (const src of sources) {
      const g = liftAtom(src);
      for (const param of g.nodes.filter((n) => n.kind === "param-source")) {
        const p = param.outputs[0] as ValueId;
        const guarded = guardedInfluence(g, p);
        for (const obs of g.obs) {
          expect(guarded.has(obs)).toBe(mayInfluence(g, p, obs));
        }
      }
    }
  });
});
