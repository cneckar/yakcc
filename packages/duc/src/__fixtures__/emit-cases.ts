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
    name: "a loop that returns, inside an else, after an if that throws",
    source:
      "export function f(n: number, cb: any) { if (n < 0) throw new Error('negative'); if (cb === 1) { n = n + 1; } else { let i = 0; while (true) { if (i * i >= n) return i; i = i + 1; } } return -n; }",
    args: [
      [10, 0],
      [10, 1],
      [0, 0],
    ],
  },
  {
    name: "a labelled continue and break of an outer loop, and a return from an inner one",
    source:
      "export function f(xs: number[][], k: number) { let n = 0; outer: for (const row of xs) { for (const x of row) { if (x < 0) continue outer; if (x === k) return [n, x]; if (x > 100) break outer; n = n + x; } n = n * 2; } return n; }",
    args: [
      [[[1, 2], [3]], 9],
      [[[1, -1, 5], [2]], 9],
      [
        [
          [1, 2],
          [3, 9],
        ],
        9,
      ],
      [[[1, 200], [3]], 9],
    ],
  },
  {
    name: "a return from a loop three deep",
    source:
      "export function f(n: number) { let i = 0; while (i < n) { let j = 0; while (j < n) { let k = 0; while (k < n) { if (i * j * k === 8) return [i, j, k]; k = k + 1; } j = j + 1; } i = i + 1; } return null; }",
    args: [[2], [3], [5]],
  },
  {
    name: "rest parameters, of the function and of a closure",
    source:
      "export function f(a: number, ...xs: number[]) { const g = (...ys: number[]) => ys.length + a; return [xs, g(1, 2), g()]; }",
    args: [[1], [1, 2, 3]],
  },
  {
    name: "a try whose loop declares a var the function reads after it",
    source:
      "export function f(xs: number[]) { var failed = false; try { for (var i = 0; i < xs.length; i++) { var x = xs[i]; if (x < 0) { failed = true; break; } } } catch (e) { failed = true; } return [failed, x]; }",
    args: [[[1, 2]], [[1, -2, 3]], [[]]],
  },
  {
    name: "a switch whose clauses fall into the next, and a default that is not last",
    source:
      "export function f(k: any, o: any): string[] { const out: string[] = []; switch (k) { case o.a: out.push('a'); case 2: out.push('two'); break; default: out.push('d'); case 3: out.push('three'); if (k === 3) break; out.push('after'); } return out; }",
    args: [
      [1, { a: 1 }],
      [2, { a: 1 }],
      [3, { a: 1 }],
      [9, { a: 1 }],
    ],
  },
  {
    name: "a switch that falls through and throws in its default",
    source:
      "export function f(k: number): number { let n = 0; switch (k) { case 1: n = n + 1; case 2: n = n + 10; break; default: throw new Error('no ' + k); } return n; }",
    args: [[1], [2]],
  },
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
  {
    name: "a closure that reads a variable reassigned after it is made",
    source:
      "export function f(xs: number[]): number[] { let last = 0; const get = (): number => last; const out: number[] = []; for (const x of xs) { last = x; out.push(get()); } return out; }",
    args: [[[]], [[3, 1, 4]]],
  },
  {
    name: "a condition that assigns, and a postfix step's value",
    source:
      "export function f(xs: number[]): number[] { let i = 0; let v = 0; let n = 0; while ((v = xs[i++]) !== undefined) { n = n + v; } return [n, i, v === undefined ? -1 : v]; }",
    args: [[[]], [[2, 3]]],
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
  {
    name: "a finally that runs on every path, and a var declared in a try",
    source:
      'export function f(x: number): string[] { const log: string[] = []; try { var half = x / 2; if (x < 0) throw new Error("neg"); log.push("body " + half); } catch (e: any) { log.push("caught " + e.message); } finally { log.push("finally"); } log.push("half " + half); return log; }',
    args: [[4], [-2]],
  },
  {
    name: "a return in a try, and a finally without a catch",
    source:
      "export function f(xs: number[]): number { let seen = 0; try { for (const x of xs) { seen = seen + 1; if (x > 2) return x; } return -1; } finally { seen = seen * 10; } }",
    args: [[[1, 5, 2]], [[1, 2]]],
  },
  // An iterating loop that breaks or returns has a condition, tested before each element (#1276).
  {
    name: "a for...of that returns",
    source:
      // The returned value is carried, undefined until a return sets it: inference does not tie it
      // to the flag that says it was set, so it allows undefined.
      'export function f(xs: number[], k: number): string | undefined { for (const x of xs) { if (x === k) return "found " + x; } return "none"; }',
    args: [
      [[1, 2, 3], 2],
      [[1, 2, 3], 9],
      [[], 1],
    ],
  },
  {
    name: "a for...in that breaks",
    source:
      'export function f(o: Record<string, number>): number { let n = 0; for (const key in o) { if (key === "stop") break; n = n + o[key]; } return n; }',
    args: [[{ a: 1, b: 2 }], [{ a: 1, stop: 5, b: 2 }]],
  },
  // A block that declares a name the rest of the function declares again takes that rest: the
  // rest's reads are of its own binding (DEC-LIFT-BLOCK-TAIL-SHADOW-001).
  {
    name: "a loop that returns, in a block whose name the rest declares again",
    source:
      "export function f(n: number, radix: number) { if (radix > 0) { let i = 2; while (i < n) { if (i >= radix) return -1; i = i + 1; } return i; } let i = 0; while (i < n) i = i + 3; return i; }",
    args: [
      [5, 0],
      [5, 9],
      [9, 4],
      [1, 2],
    ],
  },
  {
    name: "an if that exits on some paths, in a block whose names the rest declares again",
    source:
      "export function f(a: number): number { { const x = a * 2; let y = x; if (y > 10) return y; } const x = a + 1; const y = x * 3; return x + y; }",
    args: [[1], [6], [-4]],
  },
];
