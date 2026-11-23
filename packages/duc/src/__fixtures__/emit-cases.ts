// SPDX-License-Identifier: Apache-2.0
// Sources the TypeScript emitter is tested on (#1275, 5A), with inputs to run them on. The type
// inference (#1277) is checked against TypeScript's own on the same sources.

export interface Case {
  readonly name: string;
  readonly source: string;
  readonly args: readonly unknown[][];
}

export const EMIT_CASES: Case[] = [
  {
    name: "arithmetic",
    source: "export function f(a: number, b: number): number { return (a + b) * (a - b); }",
    args: [
      [3, 1],
      [0, 5],
    ],
  },
  {
    name: "member read and method call",
    source: "export function f(s: string): number { return s.trim().length + Math.abs(-2); }",
    args: [["  ab "], [""]],
  },
  {
    name: "object, template and spread",
    source:
      "export function f(a: number, xs: number[]): string { const o = { k: a, ...{ z: 1 } }; return `v=${o.k} n=${[...xs, a].length}`; }",
    args: [
      [2, [1, 2]],
      [0, []],
    ],
  },
  {
    name: "write and compound assignment",
    source:
      "export function f(a: number): number { const o = { v: 0 }; o.v = a; let t = o.v; t += 3; t *= 2; return t; }",
    args: [[1], [5]],
  },
  {
    name: "prefix and postfix steps",
    source: "export function f(a: number): number { let x = a; ++x; x++; return x; }",
    args: [[1]],
  },
  {
    name: "branch with joins on both sides",
    source:
      "export function f(c: boolean, x: number, y: number): number { let r = 0; if (c) { r = x + 1; } else { r = y - 1; } return r; }",
    args: [
      [true, 1, 9],
      [false, 1, 9],
    ],
  },
  {
    name: "branch that takes existing values",
    source:
      "export function f(a: number, b: number): number { let r = a; if (b > a) { r = b; } return r; }",
    args: [
      [1, 2],
      [5, 2],
    ],
  },
  {
    name: "typeof and void",
    source:
      "export function f(x: unknown): unknown { return typeof x === 'string' ? void 0 : typeof x; }",
    args: [["a"], [1]],
  },
  {
    name: "ternary",
    source: "export function f(c: boolean, x: number): number { return c ? x * 2 : -x; }",
    args: [
      [true, 3],
      [false, 3],
    ],
  },
  {
    name: "early return",
    source:
      "export function f(c: boolean, x: number): number { if (c) { return x + 1; } return x - 1; }",
    args: [
      [true, 3],
      [false, 3],
    ],
  },
  {
    name: "while loop",
    source:
      "export function f(n: number, x: number): number { let s = 0; let i = 0; while (i < n) { s = s + x; i = i + 1; } return s; }",
    args: [
      [0, 5],
      [4, -2],
    ],
  },
  {
    name: "for loop",
    source:
      "export function f(n: number): number { let s = 0; for (let i = 0; i < n; i = i + 1) { s = s + i; } return s; }",
    args: [[0], [5]],
  },
  {
    name: "nested loops reading a parameter",
    source:
      "export function f(n: number, x: number): number { let s = 0; for (let i = 0; i < n; i = i + 1) { let j = 0; while (j < 2) { s = s + x; j = j + 1; } } return s; }",
    args: [
      [0, 3],
      [3, 5],
    ],
  },
  {
    name: "for...of with a branch",
    source:
      "export function f(xs: number[]): number { let s = 0; for (const x of xs) { if (x > 0) { s = s + x; } } return s; }",
    args: [[[]], [[1, -2, 3]]],
  },
  {
    name: "for...in",
    source:
      "export function f(o: object): number { let n = 0; for (const k in o) { n = n + 1; } return n; }",
    args: [[{}], [{ a: 1, b: 2 }]],
  },
  // Heap order (#1285): each case reads what an earlier call or write changed.
  {
    name: "a read before and after a call that changes the array",
    source:
      "export function f(xs: number[]): number[] { const a = xs.length; xs.push(1); return [a, xs.length]; }",
    args: [[[]], [[4, 5]]],
  },
  {
    name: "a push before a loop over the array",
    source:
      "export function f(xs: number[]): number { xs.push(10); let s = 0; for (const x of xs) { s = s + x; } return s; }",
    args: [[[]], [[1, 2]]],
  },
  {
    name: "a closure that writes a member between two reads",
    source:
      "export function f(o: { n: number }): number[] { const bump = (): number => { o.n = o.n + 1; return o.n; }; const a = o.n; const b = bump(); return [a, b, o.n]; }",
    args: [[{ n: 1 }], [{ n: -3 }]],
  },
  // A name a closure rebinds is a cell the closure and its scope share (#1276).
  {
    name: "a counter a closure steps",
    source:
      "export function f(n: number, k: number): number { let count = 0; const tick = (): number => { count = count + k; return count; }; let i = 0; while (i < n) { tick(); i = i + 1; } return count; }",
    args: [
      [0, 2],
      [3, 2],
    ],
  },
  // A try statement is a call of the try primitive over two closures (#1276).
  {
    name: "a try whose body returns, and a catch that reads what was thrown",
    source:
      'export function f(x: number): string { let note = "none"; try { if (x < 0) throw new RangeError("negative"); note = "ok"; return note + x; } catch (e: any) { return note + ":" + e.message; } }',
    args: [[3], [-1]],
  },
  {
    name: "a try that only assigns",
    source:
      'export function f(xs: number[]): number { let total = 0; try { for (const x of xs) { if (x < 0) throw new Error("neg"); total = total + x; } } catch (e: any) { total = -1; } return total; }',
    args: [[[1, 2]], [[1, -1]]],
  },
];
