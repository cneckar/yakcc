// SPDX-License-Identifier: Apache-2.0
/**
 * The runtime's operations as atoms (DEC-DUC-WASM-MEMORY-001): ordinary TypeScript functions,
 * lifted to graphs and lowered like any other atom. Each states an ECMAScript string operation in
 * terms of three primitives, the only operations a target writes itself:
 * - `__ykUnit(s, i)`: the UTF-16 unit at an integer index `i` in range;
 * - `__ykSub(s, from, to)`: the units from `from` to `to`, integers with `0 <= from <= to <= s.length`;
 * - `__ykJoin(a, b)`: the units of `a`, then those of `b`;
 * and a string's `length`. The atoms carry the semantics: ToIntegerOrInfinity, clamping, negative
 * indices, NaN out of range, the search loops, UTF-16 order, ECMAScript's whitespace. A target
 * gets them all by lowering these graphs, and they are tested against the engine's own builtins.
 */

/** A runtime atom: its source, and the contract types of its parameters and result. */
export interface RuntimeAtom {
  readonly source: string;
  readonly inputs: readonly string[];
  readonly output: string;
}

/** ToIntegerOrInfinity of a number already a number: NaN is 0, a fraction truncates. */
const toInt = (x: string): string => `(${x} !== ${x} ? 0 : Math.trunc(${x}))`;

/** ECMAScript's WhiteSpace and LineTerminator code units (String.prototype.trim). */
const isSpace = (u: string): string =>
  `(${u} === 9 || ${u} === 10 || ${u} === 11 || ${u} === 12 || ${u} === 13 || ${u} === 32 || ${u} === 160 || ${u} === 5760 || (${u} >= 8192 && ${u} <= 8202) || ${u} === 8232 || ${u} === 8233 || ${u} === 8239 || ${u} === 8287 || ${u} === 12288 || ${u} === 65279)`;

export const RUNTIME_ATOMS: Readonly<Record<string, RuntimeAtom>> = {
  // String.prototype.charCodeAt
  __ykCharCodeAt: {
    inputs: ["string", "number"],
    output: "number",
    source: `export function f(s: string, pos: number): number {
  const p = ${toInt("pos")};
  if (p < 0 || p >= s.length) return NaN;
  return __ykUnit(s, p);
}`,
  },
  // String.prototype.charAt
  __ykCharAt: {
    inputs: ["string", "number"],
    output: "string",
    source: `export function f(s: string, pos: number): string {
  const p = ${toInt("pos")};
  if (p < 0 || p >= s.length) return "";
  return __ykSub(s, p, p + 1);
}`,
  },
  // String.prototype.slice(start, end)
  __ykSlice: {
    inputs: ["string", "number", "number"],
    output: "string",
    source: `export function f(s: string, start: number, end: number): string {
  const len = s.length;
  const a = ${toInt("start")};
  const b = ${toInt("end")};
  const from = a < 0 ? Math.max(len + a, 0) : Math.min(a, len);
  const to = b < 0 ? Math.max(len + b, 0) : Math.min(b, len);
  if (to <= from) return "";
  return __ykSub(s, from, to);
}`,
  },
  // String.prototype.substring(start, end)
  __ykSubstring: {
    inputs: ["string", "number", "number"],
    output: "string",
    source: `export function f(s: string, start: number, end: number): string {
  const len = s.length;
  const a = Math.min(Math.max(${toInt("start")}, 0), len);
  const b = Math.min(Math.max(${toInt("end")}, 0), len);
  return __ykSub(s, Math.min(a, b), Math.max(a, b));
}`,
  },
  // String.prototype.indexOf(search, position)
  __ykIndexOf: {
    inputs: ["string", "string", "number"],
    output: "number",
    source: `export function f(s: string, t: string, pos: number): number {
  const len = s.length;
  const n = t.length;
  let k = Math.min(Math.max(${toInt("pos")}, 0), len);
  while (k + n <= len) {
    let j = 0;
    while (j < n && __ykUnit(s, k + j) === __ykUnit(t, j)) j = j + 1;
    if (j === n) return k;
    k = k + 1;
  }
  return -1;
}`,
  },
  // String.prototype.startsWith(search, position)
  __ykStartsWith: {
    inputs: ["string", "string", "number"],
    output: "boolean",
    source: `export function f(s: string, t: string, pos: number): boolean {
  const start = Math.min(Math.max(${toInt("pos")}, 0), s.length);
  const n = t.length;
  if (start + n > s.length) return false;
  let j = 0;
  while (j < n) {
    if (__ykUnit(s, start + j) !== __ykUnit(t, j)) return false;
    j = j + 1;
  }
  return true;
}`,
  },
  // String.prototype.endsWith(search, endPosition)
  __ykEndsWith: {
    inputs: ["string", "string", "number"],
    output: "boolean",
    source: `export function f(s: string, t: string, endPosition: number): boolean {
  const end = Math.min(Math.max(${toInt("endPosition")}, 0), s.length);
  const n = t.length;
  const start = end - n;
  if (start < 0) return false;
  let j = 0;
  while (j < n) {
    if (__ykUnit(s, start + j) !== __ykUnit(t, j)) return false;
    j = j + 1;
  }
  return true;
}`,
  },
  // String.prototype.trim
  __ykTrim: {
    inputs: ["string"],
    output: "string",
    source: `export function f(s: string): string {
  let from = 0;
  let to = s.length;
  while (from < to && ${isSpace("__ykUnit(s, from)")}) from = from + 1;
  while (to > from && ${isSpace("__ykUnit(s, to - 1)")}) to = to - 1;
  return __ykSub(s, from, to);
}`,
  },
  // === on two strings: the same units
  __ykStrEquals: {
    inputs: ["string", "string"],
    output: "boolean",
    source: `export function f(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let i = 0;
  while (i < a.length) {
    if (__ykUnit(a, i) !== __ykUnit(b, i)) return false;
    i = i + 1;
  }
  return true;
}`,
  },
  // a < b on two strings: UTF-16 code unit order (IsLessThan, 7.2.13)
  __ykStrLess: {
    inputs: ["string", "string"],
    output: "boolean",
    source: `export function f(a: string, b: string): boolean {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n) {
    const x = __ykUnit(a, i);
    const y = __ykUnit(b, i);
    if (x !== y) return x < y;
    i = i + 1;
  }
  return a.length < b.length;
}`,
  },
};

/**
 * The primitives as the reference engine has them, to run the atoms' sources in JavaScript and
 * compare them with the builtins they define.
 */
export const RUNTIME_PRIMITIVES_JS = {
  __ykUnit: (s: string, i: number): number => s.charCodeAt(i),
  __ykSub: (s: string, from: number, to: number): string => s.substring(from, to),
  __ykJoin: (a: string, b: string): string => a + b,
} as const;
