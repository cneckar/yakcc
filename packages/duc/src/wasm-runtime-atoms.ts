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

/** The limb base of the runtime's big integers: 2^24, so a limb times 2^24 plus a carry stays exact. */
const BASE = "16777216";

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
 * Big integers for Number::toString (ECMA-262 6.1.6.1.20), as atoms over `number[]`: limbs in base
 * 2^24, least significant first, with no zero limb at the top (zero is the empty array). Every limb
 * is an integer a double holds exactly, and so is every intermediate product.
 */
export const BIGNUM_ATOMS: Readonly<Record<string, RuntimeAtom>> = {
  // A non-negative integer below 2^53 as a big integer.
  __ykBigFromInt: {
    inputs: ["number"],
    output: "number[]",
    source: `export function f(x: number): number[] {
  const out: number[] = [];
  let v = x;
  while (v > 0) {
    const q = Math.floor(v / ${BASE});
    out.push(v - q * ${BASE});
    v = q;
  }
  return out;
}`,
  },
  // a * m, in place, for an integer 1 <= m <= 2^24; returns a.
  __ykBigMulSmall: {
    inputs: ["number[]", "number"],
    output: "number[]",
    source: `export function f(a: number[], m: number): number[] {
  let carry = 0;
  let i = 0;
  while (i < a.length) {
    const t = a[i] * m + carry;
    const q = Math.floor(t / ${BASE});
    a[i] = t - q * ${BASE};
    carry = q;
    i = i + 1;
  }
  while (carry > 0) {
    const q = Math.floor(carry / ${BASE});
    a.push(carry - q * ${BASE});
    carry = q;
  }
  return a;
}`,
  },
  // a + b, as a new big integer.
  __ykBigAdd: {
    inputs: ["number[]", "number[]"],
    output: "number[]",
    source: `export function f(a: number[], b: number[]): number[] {
  const out: number[] = [];
  const n = Math.max(a.length, b.length);
  let carry = 0;
  let i = 0;
  while (i < n) {
    let t = carry;
    if (i < a.length) t = t + a[i];
    if (i < b.length) t = t + b[i];
    if (t >= ${BASE}) {
      out.push(t - ${BASE});
      carry = 1;
    } else {
      out.push(t);
      carry = 0;
    }
    i = i + 1;
  }
  if (carry > 0) out.push(carry);
  return out;
}`,
  },
  // a - b, in place, for a >= b; returns a.
  __ykBigSub: {
    inputs: ["number[]", "number[]"],
    output: "number[]",
    source: `export function f(a: number[], b: number[]): number[] {
  let borrow = 0;
  let i = 0;
  while (i < a.length) {
    let t = a[i] - borrow;
    if (i < b.length) t = t - b[i];
    if (t < 0) {
      a[i] = t + ${BASE};
      borrow = 1;
    } else {
      a[i] = t;
      borrow = 0;
    }
    i = i + 1;
  }
  while (a.length > 0 && a[a.length - 1] === 0) a.pop();
  return a;
}`,
  },
  // The sign of a - b: -1, 0 or 1.
  __ykBigCmp: {
    inputs: ["number[]", "number[]"],
    output: "number",
    source: `export function f(a: number[], b: number[]): number {
  if (a.length !== b.length) return a.length < b.length ? -1 : 1;
  let i = a.length - 1;
  while (i >= 0) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
    i = i - 1;
  }
  return 0;
}`,
  },
  // A copy of a.
  __ykBigCopy: {
    inputs: ["number[]"],
    output: "number[]",
    source: `export function f(a: number[]): number[] {
  const out: number[] = [];
  let i = 0;
  while (i < a.length) {
    out.push(a[i]);
    i = i + 1;
  }
  return out;
}`,
  },
  // a * 2^e, in place, for an integer e >= 0; returns a.
  __ykBigShl: {
    inputs: ["number[]", "number"],
    output: "number[]",
    source: `export function f(a: number[], e: number): number[] {
  let k = e;
  while (k >= 24) {
    __ykBigMulSmall(a, ${BASE});
    k = k - 24;
  }
  if (k > 0) __ykBigMulSmall(a, Math.pow(2, k));
  return a;
}`,
  },
  // a * 10^k, in place, for an integer k >= 0; returns a.
  __ykBigMulPow10: {
    inputs: ["number[]", "number"],
    output: "number[]",
    source: `export function f(a: number[], k: number): number[] {
  let i = k;
  while (i >= 7) {
    __ykBigMulSmall(a, 10000000);
    i = i - 7;
  }
  if (i > 0) __ykBigMulSmall(a, Math.pow(10, i));
  return a;
}`,
  },
  // Number::toString(x), radix 10 (ECMA-262 6.1.6.1.20): the shortest digits that round-trip,
  // closest to x, ties to an even digit (as V8), by Burger and Dybvig's free-format algorithm on
  // exact big integers; then ECMAScript's layout of those digits.
  __ykNumberToString: {
    inputs: ["number"],
    output: "string",
    source: `export function f(x: number): string {
  if (x !== x) return "NaN";
  if (x === 0) return "0";
  if (x === Infinity) return "Infinity";
  if (x < 0) return "-" + __ykNumberToString(-x);
  const hi = __ykF64Hi(x);
  const lo = __ykF64Lo(x);
  const biased = Math.floor(hi / 1048576);
  let mant = (hi - biased * 1048576) * 4294967296 + lo;
  let e = -1074;
  if (biased > 0) {
    mant = mant + 4503599627370496;
    e = biased - 1075;
  }
  const even = mant - Math.floor(mant / 2) * 2 === 0;
  let r: number[] = __ykBigFromInt(mant);
  let s: number[] = __ykBigFromInt(2);
  let mp: number[] = __ykBigFromInt(1);
  let mm: number[] = __ykBigFromInt(1);
  if (e >= 0) {
    if (mant !== 4503599627370496) {
      __ykBigShl(r, e + 1);
      __ykBigShl(mp, e);
      __ykBigShl(mm, e);
    } else {
      __ykBigShl(r, e + 2);
      s = __ykBigFromInt(4);
      __ykBigShl(mp, e + 1);
      __ykBigShl(mm, e);
    }
  } else {
    if (e === -1074 || mant !== 4503599627370496) {
      __ykBigShl(r, 1);
      __ykBigShl(s, -e);
    } else {
      __ykBigShl(r, 2);
      s = __ykBigFromInt(4);
      __ykBigShl(s, -e);
      mp = __ykBigFromInt(2);
    }
  }
  // Scale: the smallest k with (r + m+) / s below 10^k (at or below when even), by an estimate
  // from the logarithm and an exact correction.
  let k = Math.ceil(Math.log10(x) - 1e-10);
  if (k >= 0) __ykBigMulPow10(s, k);
  else {
    __ykBigMulPow10(r, -k);
    __ykBigMulPow10(mp, -k);
    __ykBigMulPow10(mm, -k);
  }
  let high = __ykBigCmp(__ykBigAdd(r, mp), s);
  while (even ? high >= 0 : high > 0) {
    __ykBigMulSmall(s, 10);
    k = k + 1;
    high = __ykBigCmp(__ykBigAdd(r, mp), s);
  }
  let low = __ykBigCmp(__ykBigMulSmall(__ykBigAdd(r, mp), 10), s);
  while (even ? low < 0 : low <= 0) {
    __ykBigMulSmall(r, 10);
    __ykBigMulSmall(mp, 10);
    __ykBigMulSmall(mm, 10);
    k = k - 1;
    low = __ykBigCmp(__ykBigMulSmall(__ykBigAdd(r, mp), 10), s);
  }
  // Generate digits until the remainder is within the rounding interval.
  let digits = "";
  let done = false;
  while (!done) {
    __ykBigMulSmall(r, 10);
    __ykBigMulSmall(mp, 10);
    __ykBigMulSmall(mm, 10);
    let d = 0;
    while (__ykBigCmp(r, s) >= 0) {
      __ykBigSub(r, s);
      d = d + 1;
    }
    const cl = __ykBigCmp(r, mm);
    const ch = __ykBigCmp(__ykBigAdd(r, mp), s);
    const tc1 = even ? cl <= 0 : cl < 0;
    const tc2 = even ? ch >= 0 : ch > 0;
    if (tc1 && tc2) {
      const c = __ykBigCmp(__ykBigMulSmall(__ykBigCopy(r), 2), s);
      if (c > 0 || (c === 0 && d - Math.floor(d / 2) * 2 === 1)) d = d + 1;
      done = true;
    } else if (tc2) {
      d = d + 1;
      done = true;
    } else if (tc1) {
      done = true;
    }
    digits = digits + __ykChar(48 + d);
  }
  // The layout (ECMA-262 6.1.6.1.20 steps 6-10): n is k, the digits' count is kd.
  const n = k;
  const kd = digits.length;
  if (kd <= n && n <= 21) {
    let out = digits;
    let z = kd;
    while (z < n) {
      out = out + "0";
      z = z + 1;
    }
    return out;
  }
  if (0 < n && n <= 21) return digits.slice(0, n) + "." + digits.slice(n, kd);
  if (-6 < n && n <= 0) {
    let out = "0.";
    let z = n;
    while (z < 0) {
      out = out + "0";
      z = z + 1;
    }
    return out + digits;
  }
  const ex = n - 1;
  let v = ex < 0 ? -ex : ex;
  let es = "";
  let more = true;
  while (more) {
    const q = Math.floor(v / 10);
    es = __ykChar(48 + v - q * 10) + es;
    v = q;
    more = v > 0;
  }
  const mantissa = kd === 1 ? digits : digits.slice(0, 1) + "." + digits.slice(1, kd);
  return mantissa + "e" + (ex < 0 ? "-" : "+") + es;
}`,
  },
};

/**
 * The primitives as the reference engine has them, to run the atoms' sources in JavaScript and
 * compare them with the builtins they define.
 */
export const RUNTIME_PRIMITIVES_JS = {
  __ykUnit: (s: string, i: number): number => s.charCodeAt(i),
  __ykChar: (u: number): string => String.fromCharCode(u),
  __ykF64Hi: (x: number): number => {
    const v = new DataView(new ArrayBuffer(8));
    v.setFloat64(0, x);
    return v.getUint32(0);
  },
  __ykF64Lo: (x: number): number => {
    const v = new DataView(new ArrayBuffer(8));
    v.setFloat64(0, x);
    return v.getUint32(4);
  },
  __ykSub: (s: string, from: number, to: number): string => s.substring(from, to),
  __ykJoin: (a: string, b: string): string => a + b,
} as const;
