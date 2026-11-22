// SPDX-License-Identifier: Apache-2.0
// Semantic check: a lifted graph, evaluated on inputs, gives the same result as the source. The
// evaluator covers the arithmetic, comparison, literal and select nodes the test sources use.
import { describe, expect, it } from "vitest";
import { liftAtom } from "./lift.js";
import type { DucGraph, DucNode, ValueId } from "./types.js";

const BINARY: Record<string, (a: any, b: any) => unknown> = {
  "+": (a, b) => a + b,
  "-": (a, b) => a - b,
  "*": (a, b) => a * b,
  "<": (a, b) => a < b,
  ">": (a, b) => a > b,
  "<=": (a, b) => a <= b,
  ">=": (a, b) => a >= b,
  "===": (a, b) => a === b,
  "!==": (a, b) => a !== b,
};

function literal(label: string): unknown {
  if (label === "true") return true;
  if (label === "false") return false;
  if (label === "undefined") return undefined;
  const n = Number(label);
  if (Number.isNaN(n)) throw new Error(`unsupported literal ${label}`);
  return n;
}

/** Evaluates a graph on arguments, returning its observations in order. */
export function evaluate(g: DucGraph, args: readonly unknown[]): unknown[] {
  const values = new Map<ValueId, unknown>();
  const compute = (node: DucNode): unknown => {
    const input = (i: number): unknown => values.get(node.inputs[i] as ValueId);
    if (node.kind === "param-source") return args[Number(node.label)];
    if (node.kind === "literal-source") return literal(node.label ?? "");
    if (node.kind === "sel") return input(0) ? input(1) : input(2);
    if (node.kind === "op") {
      const fn = BINARY[node.label ?? ""];
      if (fn === undefined) throw new Error(`unsupported operation ${node.label}`);
      return fn(input(0), input(1));
    }
    throw new Error(`unsupported node ${node.kind}`);
  };
  let pending = [...g.nodes];
  while (pending.length > 0) {
    const before = pending.length;
    pending = pending.filter((node) => {
      if (!node.inputs.every((v) => values.has(v))) return true;
      values.set(node.outputs[0] as ValueId, compute(node));
      return false;
    });
    if (pending.length === before) throw new Error("a node has an input that nothing defines");
  }
  return g.obs.map((v) => values.get(v));
}

const CASES: { name: string; source: string; fn: (c: boolean, x: number) => number | undefined }[] = [
  {
    name: "partial return inside a branch",
    source: "export function f(c: boolean, x: number): number { if (c) { if (x > 0) { return 1; } } return x; }",
    fn: (c, x) => { if (c) { if (x > 0) return 1; } return x; },
  },
  {
    name: "total early return",
    source: "export function f(c: boolean, x: number): number { if (c) { return x + 1; } return x - 1; }",
    fn: (c, x) => { if (c) return x + 1; return x - 1; },
  },
  {
    name: "partial return, then more work and a later return",
    source: "export function f(c: boolean, x: number): number { if (c) { if (x > 0) { return 1; } x = x + 2; } if (x > 5) { return 7; } return x; }",
    fn: (c, x) => { if (c) { if (x > 0) return 1; x = x + 2; } if (x > 5) return 7; return x; },
  },
  {
    name: "a value assigned, then a partial return",
    source: "export function f(c: boolean, x: number): number { let r = 0; if (c) { r = x; if (x < 0) { return 9; } } return r + 1; }",
    fn: (c, x) => { let r = 0; if (c) { r = x; if (x < 0) return 9; } return r + 1; },
  },
  {
    name: "two partial returns in a row",
    source: "export function f(c: boolean, x: number): number { if (c) { if (x > 0) { return 1; } } if (x === 3) { return 2; } return x * 2; }",
    fn: (c, x) => { if (c) { if (x > 0) return 1; } if (x === 3) return 2; return x * 2; },
  },
];

describe("lifted graphs compute what the source computes (semantic check)", () => {
  for (const tc of CASES) {
    it(tc.name, () => {
      const g = liftAtom(tc.source);
      for (const c of [true, false]) {
        for (const x of [-2, 0, 3, 7]) {
          const [observed] = evaluate(g, [c, x]);
          expect(observed, `c=${c} x=${x}`).toBe(tc.fn(c, x));
        }
      }
    });
  }
});
