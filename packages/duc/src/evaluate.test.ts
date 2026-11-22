// SPDX-License-Identifier: Apache-2.0
// Semantic check: a lifted graph, evaluated on inputs, gives the same result as the source. The
// evaluator covers the arithmetic, comparison, literal, select and loop nodes the test sources use.
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

/** The loop whose body a node lies in, innermost, or undefined at the top level. */
function innermostLoop(region: string | undefined): string | undefined {
  if (region === undefined) return undefined;
  const segs = region.split("/");
  for (let i = segs.length - 1; i >= 0; i--) {
    const seg = segs[i] as string;
    if (seg.endsWith(".b")) return seg.slice(0, -2);
  }
  return undefined;
}

const MAX_ITERATIONS = 10000;

/**
 * Evaluates the nodes of one scope (the top level, or one loop body) into `values`. A node runs once
 * its inputs have values. Loop nodes run their body until the condition is false.
 */
function evalScope(g: DucGraph, scope: string | undefined, values: Map<ValueId, unknown>): void {
  const pending = g.nodes.filter(
    (n) => innermostLoop(n.region) === scope && !n.outputs.every((v) => values.has(v)),
  );
  const compute = (node: DucNode): unknown[] => {
    const input = (i: number): unknown => values.get(node.inputs[i] as ValueId);
    if (node.kind === "param-source") return [undefined];
    if (node.kind === "literal-source") return [literal(node.label ?? "")];
    if (node.kind === "sel") return [input(0) ? input(1) : input(2)];
    if (node.kind === "op") {
      const fn = BINARY[node.label ?? ""];
      if (fn === undefined) throw new Error(`unsupported operation ${node.label}`);
      return [fn(input(0), input(1))];
    }
    if (node.kind === "loop" && node.loop !== undefined) {
      const loop = node.loop;
      const count = loop.carry.length;
      let carry = node.inputs.slice(0, count).map((v) => values.get(v));
      for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
        const local = new Map(values);
        loop.carry.forEach((v, i) => local.set(v, carry[i]));
        loop.invariant.forEach((v, j) => local.set(v, values.get(node.inputs[count + j] as ValueId)));
        evalScope(g, loop.id, local);
        if (!local.get(loop.cond)) return carry;
        carry = loop.next.map((v) => local.get(v));
      }
      throw new Error("the loop did not stop");
    }
    throw new Error(`unsupported node ${node.kind}`);
  };
  let remaining = pending;
  while (remaining.length > 0) {
    const before = remaining.length;
    remaining = remaining.filter((node) => {
      if (!node.inputs.every((v) => values.has(v))) return true;
      const outs = compute(node);
      node.outputs.forEach((v, i) => values.set(v, outs[i]));
      return false;
    });
    if (remaining.length === before) throw new Error("a node has an input that nothing defines");
  }
}

/** Evaluates a graph on arguments, returning its observations in order. */
export function evaluate(g: DucGraph, args: readonly unknown[]): unknown[] {
  const values = new Map<ValueId, unknown>();
  for (const node of g.nodes) {
    if (node.kind === "param-source") values.set(node.outputs[0] as ValueId, args[Number(node.label)]);
  }
  evalScope(g, undefined, values);
  return g.obs.map((v) => values.get(v));
}

const CASES: { name: string; source: string; args: unknown[][]; fn: (...a: any[]) => unknown }[] = [
  {
    name: "partial return inside a branch",
    source: "export function f(c: boolean, x: number): number { if (c) { if (x > 0) { return 1; } } return x; }",
    args: [[true, -2], [true, 0], [true, 3], [true, 7], [false, -2], [false, 3]],
    fn: (c: boolean, x: number) => { if (c) { if (x > 0) return 1; } return x; },
  },
  {
    name: "total early return",
    source: "export function f(c: boolean, x: number): number { if (c) { return x + 1; } return x - 1; }",
    args: [[true, 3], [false, 3]],
    fn: (c: boolean, x: number) => { if (c) return x + 1; return x - 1; },
  },
  {
    name: "partial return, then more work and a later return",
    source: "export function f(c: boolean, x: number): number { if (c) { if (x > 0) { return 1; } x = x + 2; } if (x > 5) { return 7; } return x; }",
    args: [[true, -2], [true, 0], [true, 3], [true, 7], [false, 2], [false, 9]],
    fn: (c: boolean, x: number) => { if (c) { if (x > 0) return 1; x = x + 2; } if (x > 5) return 7; return x; },
  },
  {
    name: "two partial returns in a row",
    source: "export function f(c: boolean, x: number): number { if (c) { if (x > 0) { return 1; } } if (x === 3) { return 2; } return x * 2; }",
    args: [[true, -1], [true, 3], [false, 3], [false, 4]],
    fn: (c: boolean, x: number) => { if (c) { if (x > 0) return 1; } if (x === 3) return 2; return x * 2; },
  },
  {
    name: "while loop sums a term",
    source: "export function f(n: number, x: number): number { let s = 0; let i = 0; while (i < n) { s = s + x; i = i + 1; } return s; }",
    args: [[0, 5], [1, 5], [4, -2], [3, 7]],
    fn: (n: number, x: number) => { let s = 0; let i = 0; while (i < n) { s = s + x; i = i + 1; } return s; },
  },
  {
    name: "for loop with a declared counter",
    source: "export function f(n: number): number { let s = 0; for (let i = 0; i < n; i = i + 1) { s = s + i; } return s; }",
    args: [[0], [1], [5]],
    fn: (n: number) => { let s = 0; for (let i = 0; i < n; i = i + 1) { s = s + i; } return s; },
  },
  {
    name: "a loop reads a value computed before it",
    source: "export function f(x: number): number { let a = x * 2; let s = 0; while (s < 10) { s = s + a; } return s; }",
    args: [[1], [2], [3], [4]],
    fn: (x: number) => { let a = x * 2; let s = 0; while (s < 10) { s = s + a; } return s; },
  },
  {
    name: "nested loops reading an outer parameter",
    source: "export function f(n: number, x: number): number { let s = 0; for (let i = 0; i < n; i = i + 1) { let j = 0; while (j < 2) { s = s + x; j = j + 1; } } return s; }",
    args: [[0, 3], [1, 3], [2, -1], [3, 5]],
    fn: (n: number, x: number) => { let s = 0; for (let i = 0; i < n; i = i + 1) { let j = 0; while (j < 2) { s = s + x; j = j + 1; } } return s; },
  },
  {
    name: "nested loops",
    source: "export function f(n: number): number { let s = 0; for (let i = 0; i < n; i = i + 1) { let j = 0; while (j < i) { s = s + 1; j = j + 1; } } return s; }",
    args: [[0], [1], [2], [4]],
    fn: (n: number) => { let s = 0; for (let i = 0; i < n; i = i + 1) { let j = 0; while (j < i) { s = s + 1; j = j + 1; } } return s; },
  },
];

describe("lifted graphs compute what the source computes (semantic check)", () => {
  for (const tc of CASES) {
    it(tc.name, () => {
      const g = liftAtom(tc.source);
      for (const args of tc.args) {
        const [observed] = evaluate(g, args);
        expect(observed, JSON.stringify(args)).toBe(tc.fn(...args));
      }
    });
  }
});
