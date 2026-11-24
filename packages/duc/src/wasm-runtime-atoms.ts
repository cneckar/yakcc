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
  if (k > 0) __ykBigMulSmall(a, __ykPow2(k));
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
  while (i > 0) {
    __ykBigMulSmall(a, 10);
    i = i - 1;
  }
  return a;
}`,
  },
  // a + d, in place, for an integer 0 <= d < 2^24; returns a.
  __ykBigAddSmall: {
    inputs: ["number[]", "number"],
    output: "number[]",
    source: `export function f(a: number[], d: number): number[] {
  let carry = d;
  let i = 0;
  while (carry > 0 && i < a.length) {
    const t = a[i] + carry;
    if (t >= ${BASE}) {
      a[i] = t - ${BASE};
      carry = 1;
    } else {
      a[i] = t;
      carry = 0;
    }
    i = i + 1;
  }
  if (carry > 0) a.push(carry);
  return a;
}`,
  },
  // The number of bits of a (0 for zero).
  __ykBigBitLen: {
    inputs: ["number[]"],
    output: "number",
    source: `export function f(a: number[]): number {
  if (a.length === 0) return 0;
  let top = a[a.length - 1];
  let b = 0;
  while (top >= 1) {
    top = Math.floor(top / 2);
    b = b + 1;
  }
  return (a.length - 1) * 24 + b;
}`,
  },
  // Bit i of a (0 or 1).
  __ykBigBit: {
    inputs: ["number[]", "number"],
    output: "number",
    source: `export function f(a: number[], i: number): number {
  const limb = Math.floor(i / 24);
  if (limb >= a.length) return 0;
  const v = Math.floor(a[limb] / __ykPow2(i - limb * 24));
  return v - Math.floor(v / 2) * 2;
}`,
  },
  // Whether any of the lowest s bits of a is 1.
  __ykBigLowBits: {
    inputs: ["number[]", "number"],
    output: "boolean",
    source: `export function f(a: number[], s: number): boolean {
  const limb = Math.floor(s / 24);
  let i = 0;
  while (i < limb && i < a.length) {
    if (a[i] !== 0) return true;
    i = i + 1;
  }
  if (limb >= a.length) return false;
  const p = __ykPow2(s - limb * 24);
  return a[limb] - Math.floor(a[limb] / p) * p !== 0;
}`,
  },
  // floor(a / 2^s), as a new big integer.
  __ykBigShr: {
    inputs: ["number[]", "number"],
    output: "number[]",
    source: `export function f(a: number[], s: number): number[] {
  const drop = Math.floor(s / 24);
  const r = s - drop * 24;
  const lowP = __ykPow2(r);
  const highP = __ykPow2(24 - r);
  const out: number[] = [];
  let i = drop;
  while (i < a.length) {
    let v = Math.floor(a[i] / lowP);
    if (i + 1 < a.length) {
      const next = a[i + 1];
      v = v + (next - Math.floor(next / lowP) * lowP) * highP;
    }
    out.push(v);
    i = i + 1;
  }
  while (out.length > 0 && out[out.length - 1] === 0) out.pop();
  return out;
}`,
  },
  // The value of a big integer below 2^53, exactly.
  __ykBigValue: {
    inputs: ["number[]"],
    output: "number",
    source: `export function f(a: number[]): number {
  let v = 0;
  let i = a.length - 1;
  while (i >= 0) {
    v = v * ${BASE} + a[i];
    i = i - 1;
  }
  return v;
}`,
  },
  // q * 2^e2, rounded to the nearest double, ties to even; sticky says there are 1 bits below q.
  // q must carry at least two bits more than the result's precision whenever sticky is set.
  __ykBigToDouble: {
    inputs: ["number[]", "number", "boolean"],
    output: "number",
    source: `export function f(q: number[], e2: number, sticky: boolean): number {
  const bl = __ykBigBitLen(q);
  if (bl === 0) return 0;
  const top = bl - 1 + e2;
  if (top > 1023) return Infinity;
  let p = 53;
  if (top < -1022) p = 53 - (-1022 - top);
  if (p < 0) return 0;
  const shift = bl - p;
  let m = 0;
  if (shift <= 0) m = __ykBigValue(q) * __ykPow2(-shift);
  else {
    m = __ykBigValue(__ykBigShr(q, shift));
    const half = __ykBigBit(q, shift - 1);
    const rest = sticky || __ykBigLowBits(q, shift - 1);
    if (half === 1 && (rest || m - Math.floor(m / 2) * 2 === 1)) m = m + 1;
  }
  return m * __ykPow2(top - p + 1);
}`,
  },
  // m * 10^e10 for a big integer m, rounded to the nearest double, ties to even.
  __ykDecimalToDouble: {
    inputs: ["number[]", "number"],
    output: "number",
    source: `export function f(m: number[], e10: number): number {
  if (m.length === 0) return 0;
  const lm = __ykBigBitLen(m);
  if (e10 > 0 && lm - 1 + e10 * 3.32 > 1030) return Infinity;
  if (e10 < 0 && lm + e10 * 3.3219 < -1080) return 0;
  if (e10 >= 0) return __ykBigToDouble(__ykBigMulPow10(__ykBigCopy(m), e10), 0, false);
  const num = __ykBigCopy(m);
  const den = __ykBigMulPow10(__ykBigFromInt(1), -e10);
  const k = __ykBigBitLen(den) - lm + 56;
  if (k >= 0) __ykBigShl(num, k);
  else __ykBigShl(den, -k);
  // q = floor(num / den), in [2^55, 2^57): long division, a bit at a time from bit 57.
  let q: number[] = [];
  let b = 57;
  while (b >= 0) {
    const t = __ykBigShl(__ykBigCopy(den), b);
    if (__ykBigCmp(num, t) >= 0) {
      __ykBigSub(num, t);
      q = __ykBigAdd(q, __ykBigShl(__ykBigFromInt(1), b));
    }
    b = b - 1;
  }
  return __ykBigToDouble(q, -k, num.length > 0);
}`,
  },
  // StringToNumber (ECMA-262 7.1.4.1.1): the StringNumericLiteral grammar, rounded exactly.
  __ykStringToNumber: {
    inputs: ["string"],
    output: "number",
    source: `export function f(input: string): number {
  const s = __ykTrim(input);
  const n = s.length;
  if (n === 0) return 0;
  if (__ykStrEquals(s, "Infinity") || __ykStrEquals(s, "+Infinity")) return Infinity;
  if (__ykStrEquals(s, "-Infinity")) return -Infinity;
  const c1 = __ykUnit(s, 1);
  let radix = 0;
  if (n > 2 && __ykUnit(s, 0) === 48) {
    if (c1 === 120 || c1 === 88) radix = 16;
    else if (c1 === 111 || c1 === 79) radix = 8;
    else if (c1 === 98 || c1 === 66) radix = 2;
  }
  if (radix > 0) {
    const big: number[] = [];
    let i = 2;
    while (i < n) {
      const u = __ykUnit(s, i);
      let d = 99;
      if (u >= 48 && u <= 57) d = u - 48;
      else if (u >= 97 && u <= 102) d = u - 87;
      else if (u >= 65 && u <= 70) d = u - 55;
      if (d >= radix) return NaN;
      __ykBigMulSmall(big, radix);
      __ykBigAddSmall(big, d);
      i = i + 1;
    }
    return __ykBigToDouble(big, 0, false);
  }
  let i = 0;
  let neg = false;
  const c0 = __ykUnit(s, 0);
  if (c0 === 43 || c0 === 45) {
    neg = c0 === 45;
    i = 1;
  }
  const m: number[] = [];
  let digits = 0;
  let e10 = 0;
  while (i < n && __ykUnit(s, i) >= 48 && __ykUnit(s, i) <= 57) {
    __ykBigMulSmall(m, 10);
    __ykBigAddSmall(m, __ykUnit(s, i) - 48);
    digits = digits + 1;
    i = i + 1;
  }
  if (i < n && __ykUnit(s, i) === 46) {
    i = i + 1;
    while (i < n && __ykUnit(s, i) >= 48 && __ykUnit(s, i) <= 57) {
      __ykBigMulSmall(m, 10);
      __ykBigAddSmall(m, __ykUnit(s, i) - 48);
      digits = digits + 1;
      e10 = e10 - 1;
      i = i + 1;
    }
  }
  if (digits === 0) return NaN;
  if (i < n && (__ykUnit(s, i) === 101 || __ykUnit(s, i) === 69)) {
    i = i + 1;
    let eneg = false;
    if (i < n && (__ykUnit(s, i) === 43 || __ykUnit(s, i) === 45)) {
      eneg = __ykUnit(s, i) === 45;
      i = i + 1;
    }
    let ed = 0;
    let ev = 0;
    while (i < n && __ykUnit(s, i) >= 48 && __ykUnit(s, i) <= 57) {
      if (ev < 100000) ev = ev * 10 + __ykUnit(s, i) - 48;
      ed = ed + 1;
      i = i + 1;
    }
    if (ed === 0) return NaN;
    e10 = e10 + (eneg ? -ev : ev);
  }
  if (i !== n) return NaN;
  const v = __ykDecimalToDouble(m, e10);
  return neg ? -v : v;
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
 * The array methods that take a function (Array.prototype.map, filter, forEach, some, every, find,
 * findIndex, reduce), for an array of numbers and an array of any values. The function is passed as
 * it is: each atom is lowered once per function (lower-stack.ts). As the specification does, each
 * reads the length once, before it starts; the methods but find and findIndex skip an index the
 * function removed, and those two read it as undefined.
 */
function arrayFnAtoms(kind: "Nums" | "Any", elem: string): Record<string, RuntimeAtom> {
  const arr = `${elem}[]`;
  const loop = (body: string, after: string): string => `  const n = a.length;
  let i = 0;
  while (i < n) {
    if (i < a.length) {
${body}
    }
    i = i + 1;
  }
${after}`;
  const fn = "(x: unknown, i: number, a: unknown) => unknown";
  return {
    [`__ykMap${kind}`]: {
      inputs: [arr, "function"],
      output: "unknown",
      source: `export function f(a: ${arr}, g: ${fn}): unknown[] {
  const out = [];
${loop("      out.push(g(a[i], i, a));", "  return out;")}
}`,
    },
    [`__ykFilter${kind}`]: {
      inputs: [arr, "function"],
      output: "unknown",
      source: `export function f(a: ${arr}, g: ${fn}): ${arr} {
  const out = [];
${loop("      const x = a[i];\n      if (__ykTruthy(g(x, i, a))) out.push(x);", "  return out;")}
}`,
    },
    [`__ykForEach${kind}`]: {
      inputs: [arr, "function"],
      output: "unknown",
      source: `export function f(a: ${arr}, g: ${fn}): void {
${loop("      g(a[i], i, a);", "")}
}`,
    },
    [`__ykSome${kind}`]: {
      inputs: [arr, "function"],
      output: "unknown",
      source: `export function f(a: ${arr}, g: ${fn}): boolean {
${loop("      if (__ykTruthy(g(a[i], i, a))) return true;", "  return false;")}
}`,
    },
    [`__ykEvery${kind}`]: {
      inputs: [arr, "function"],
      output: "unknown",
      source: `export function f(a: ${arr}, g: ${fn}): boolean {
${loop("      if (!__ykTruthy(g(a[i], i, a))) return false;", "  return true;")}
}`,
    },
    [`__ykFind${kind}`]: {
      inputs: [arr, "function"],
      output: "unknown",
      source: `export function f(a: ${arr}, g: ${fn}): unknown {
  const n = a.length;
  let i = 0;
  while (i < n) {
    const x = i < a.length ? a[i] : __ykUndef();
    if (__ykTruthy(g(x, i, a))) return x;
    i = i + 1;
  }
  return __ykUndef();
}`,
    },
    [`__ykFindIndex${kind}`]: {
      inputs: [arr, "function"],
      output: "unknown",
      source: `export function f(a: ${arr}, g: ${fn}): number {
  const n = a.length;
  let i = 0;
  while (i < n) {
    const x = i < a.length ? a[i] : __ykUndef();
    if (__ykTruthy(g(x, i, a))) return i;
    i = i + 1;
  }
  return -1;
}`,
    },
    [`__ykReduceInit${kind}`]: {
      inputs: [arr, "function", "unknown"],
      output: "unknown",
      source: `export function f(a: ${arr}, g: (acc: unknown, x: unknown, i: number, a: unknown) => unknown, init: unknown): unknown {
  let acc = init;
${loop("      acc = g(acc, a[i], i, a);", "  return acc;")}
}`,
    },
    [`__ykReduce${kind}`]: {
      inputs: [arr, "function"],
      output: "unknown",
      source: `export function f(a: ${arr}, g: (acc: unknown, x: unknown, i: number, a: unknown) => unknown): unknown {
  const n = a.length;
  let i = 0;
  while (i < n && i >= a.length) i = i + 1;
  if (i >= n) throw __ykMakeError("TypeError", "Reduce of empty array with no initial value");
  let acc = a[i];
  i = i + 1;
  while (i < n) {
    if (i < a.length) acc = g(acc, a[i], i, a);
    i = i + 1;
  }
  return acc;
}`,
    },
  };
}

export const ARRAY_FN_ATOMS: Readonly<Record<string, RuntimeAtom>> = {
  ...arrayFnAtoms("Nums", "number"),
  ...arrayFnAtoms("Any", "unknown"),
};

/**
 * JSON (ECMA-262 25.5) as runtime atoms: stringify (SerializeJSONProperty, with toJSON, the gap of
 * the space argument, and the circular-structure TypeError) and parse (the JSON grammar, strictly;
 * a SyntaxError for anything else). An object's keys go in Object.keys's order.
 */
export const JSON_ATOMS: Readonly<Record<string, RuntimeAtom>> = {
  // Four lowercase hex digits of a code unit.
  __ykHex4: {
    inputs: ["number"],
    output: "string",
    source: String.raw`export function f(c: number): string {
  const digits = "0123456789abcdef";
  let out = "";
  let k = 4096;
  while (k >= 1) {
    const d = Math.floor(c / k) % 16;
    out = out + __ykSub(digits, d, d + 1);
    k = k / 16;
  }
  return out;
}`,
  },
  // QuoteJSONString: the escapes JSON names, \u00XX for other control units and for a surrogate
  // that is not one of a pair.
  __ykJsonQuote: {
    inputs: ["string"],
    output: "string",
    source: String.raw`export function f(s: string): string {
  let out = "\"";
  let i = 0;
  while (i < s.length) {
    const c = __ykUnit(s, i);
    if (c === 34) out = out + "\\\"";
    else if (c === 92) out = out + "\\\\";
    else if (c === 8) out = out + "\\b";
    else if (c === 12) out = out + "\\f";
    else if (c === 10) out = out + "\\n";
    else if (c === 13) out = out + "\\r";
    else if (c === 9) out = out + "\\t";
    else if (c < 32) out = out + "\\u" + __ykHex4(c);
    else if (c >= 55296 && c <= 57343) {
      const paired = c <= 56319 && i + 1 < s.length && __ykUnit(s, i + 1) >= 56320 && __ykUnit(s, i + 1) <= 57343;
      if (paired) {
        out = out + __ykSub(s, i, i + 2);
        i = i + 2;
        continue;
      }
      out = out + "\\u" + __ykHex4(c);
    } else out = out + __ykSub(s, i, i + 1);
    i = i + 1;
  }
  return out + "\"";
}`,
  },
  // SerializeJSONProperty: a value's JSON text, or undefined (undefined, a function). stack holds
  // the objects being written (a cycle is a TypeError); indent and gap the space argument's.
  __ykJsonValue: {
    inputs: ["unknown", "string", "unknown[]", "string", "string"],
    output: "unknown",
    source: String.raw`export function f(v: unknown, key: string, stack: unknown[], indent: string, gap: string): unknown {
  let x = v;
  if (__ykTag(x) === 7) {
    const tj = __ykGetAny(x, "toJSON");
    if (__ykTag(tj) === 8) x = tj(key);
  }
  const t = __ykTag(x);
  if (t === 1) return "null";
  if (t === 2) return __ykBool(x) ? "true" : "false";
  if (t === 4) return __ykJsonQuote(__ykStr(x));
  if (t === 3) {
    const n = __ykNum(x);
    if (n !== n || n === Infinity || n === -Infinity) return "null";
    return __ykNumberToString(n);
  }
  if (t === 0 || t === 8) return __ykUndef();
  let s = 0;
  while (s < stack.length) {
    if (__ykSame(stack[s], x)) throw __ykMakeError("TypeError", "Converting circular structure to JSON");
    s = s + 1;
  }
  stack.push(x);
  const inner = indent + gap;
  const sep = gap.length > 0 ? ",\n" + inner : ",";
  let out = "";
  if (t === 5 || t === 6) {
    const n = t === 5 ? __ykArr(x).length : __ykArrAny(x).length;
    let parts = "";
    let i = 0;
    while (i < n) {
      const e = __ykJsonValue(__ykIndex(x, i), __ykNumberToString(i), stack, inner, gap);
      if (i > 0) parts = parts + sep;
      parts = parts + (__ykTag(e) === 0 ? "null" : __ykStr(e));
      i = i + 1;
    }
    if (n === 0) out = "[]";
    else if (gap.length > 0) out = "[\n" + inner + parts + "\n" + indent + "]";
    else out = "[" + parts + "]";
  } else {
    const keys = __ykKeysOf(x, false);
    let parts = "";
    let count = 0;
    let i = 0;
    while (i < keys.length) {
      const k = __ykStr(keys[i]);
      const e = __ykJsonValue(__ykGetAny(x, k), k, stack, inner, gap);
      if (__ykTag(e) !== 0) {
        if (count > 0) parts = parts + sep;
        parts = parts + __ykJsonQuote(k) + (gap.length > 0 ? ": " : ":") + __ykStr(e);
        count = count + 1;
      }
      i = i + 1;
    }
    if (count === 0) out = "{}";
    else if (gap.length > 0) out = "{\n" + inner + parts + "\n" + indent + "}";
    else out = "{" + parts + "}";
  }
  stack.pop();
  return out;
}`,
  },
  // JSON.stringify(value, undefined, space).
  __ykJsonStringify: {
    inputs: ["unknown", "unknown"],
    output: "unknown",
    source: String.raw`export function f(x: unknown, space: unknown): unknown {
  let gap = "";
  const ts = __ykTag(space);
  if (ts === 3) {
    const n = Math.min(10, Math.trunc(__ykNum(space)));
    let i = 0;
    while (i < n) {
      gap = gap + " ";
      i = i + 1;
    }
  } else if (ts === 4) {
    const g = __ykStr(space);
    gap = g.length > 10 ? __ykSub(g, 0, 10) : g;
  }
  const stack = [];
  stack.push(__ykUndef());
  stack.pop();
  return __ykJsonValue(x, "", stack, "", gap);
}`,
  },
  // JSON's whitespace, skipped from pos[0].
  __ykJsonWs: {
    inputs: ["string", "number[]"],
    output: "unknown",
    source: String.raw`export function f(s: string, pos: number[]): unknown {
  let i = pos[0];
  while (i < s.length) {
    const c = __ykUnit(s, i);
    if (c !== 32 && c !== 9 && c !== 10 && c !== 13) break;
    i = i + 1;
  }
  pos[0] = i;
  return __ykUndef();
}`,
  },
  // A SyntaxError of JSON.parse.
  __ykJsonError: {
    inputs: [],
    output: "unknown",
    source: String.raw`export function f(): unknown {
  throw __ykMakeError("SyntaxError", "Unexpected token in JSON");
}`,
  },
  // A JSON string at pos[0] (its opening quote): its value; pos[0] after its closing quote.
  __ykJsonString: {
    inputs: ["string", "number[]"],
    output: "string",
    source: String.raw`export function f(s: string, pos: number[]): string {
  let i = pos[0] + 1;
  let out = "";
  while (true) {
    if (i >= s.length) return __ykStr(__ykJsonError());
    const c = __ykUnit(s, i);
    if (c === 34) break;
    if (c < 32) return __ykStr(__ykJsonError());
    if (c === 92) {
      if (i + 1 >= s.length) return __ykStr(__ykJsonError());
      const e = __ykUnit(s, i + 1);
      if (e === 34) out = out + "\"";
      else if (e === 92) out = out + "\\";
      else if (e === 47) out = out + "/";
      else if (e === 98) out = out + __ykChar(8);
      else if (e === 102) out = out + __ykChar(12);
      else if (e === 110) out = out + __ykChar(10);
      else if (e === 114) out = out + __ykChar(13);
      else if (e === 116) out = out + __ykChar(9);
      else if (e === 117) {
        if (i + 6 > s.length) return __ykStr(__ykJsonError());
        let v = 0;
        let j = i + 2;
        while (j < i + 6) {
          const h = __ykUnit(s, j);
          let d = -1;
          if (h >= 48 && h <= 57) d = h - 48;
          else if (h >= 97 && h <= 102) d = h - 87;
          else if (h >= 65 && h <= 70) d = h - 55;
          if (d < 0) return __ykStr(__ykJsonError());
          v = v * 16 + d;
          j = j + 1;
        }
        out = out + __ykChar(v);
        i = i + 4;
      } else return __ykStr(__ykJsonError());
      i = i + 2;
    } else {
      out = out + __ykSub(s, i, i + 1);
      i = i + 1;
    }
  }
  pos[0] = i + 1;
  return out;
}`,
  },
  // A JSON number at pos[0], by its grammar (-? int frac? exp?): its value.
  __ykJsonNumber: {
    inputs: ["string", "number[]"],
    output: "number",
    source: String.raw`export function f(s: string, pos: number[]): number {
  const start = pos[0];
  let i = start;
  if (i < s.length && __ykUnit(s, i) === 45) i = i + 1;
  if (i >= s.length) return __ykNum(__ykJsonError());
  const c0 = __ykUnit(s, i);
  if (c0 === 48) i = i + 1;
  else if (c0 >= 49 && c0 <= 57) {
    while (i < s.length && __ykUnit(s, i) >= 48 && __ykUnit(s, i) <= 57) i = i + 1;
  } else return __ykNum(__ykJsonError());
  if (i < s.length && __ykUnit(s, i) === 46) {
    i = i + 1;
    const f0 = i;
    while (i < s.length && __ykUnit(s, i) >= 48 && __ykUnit(s, i) <= 57) i = i + 1;
    if (i === f0) return __ykNum(__ykJsonError());
  }
  if (i < s.length && (__ykUnit(s, i) === 101 || __ykUnit(s, i) === 69)) {
    i = i + 1;
    if (i < s.length && (__ykUnit(s, i) === 43 || __ykUnit(s, i) === 45)) i = i + 1;
    const e0 = i;
    while (i < s.length && __ykUnit(s, i) >= 48 && __ykUnit(s, i) <= 57) i = i + 1;
    if (i === e0) return __ykNum(__ykJsonError());
  }
  pos[0] = i;
  return __ykStringToNumber(__ykSub(s, start, i));
}`,
  },
  // Whether s has the literal word w at pos[0]; pos[0] after it when it has.
  __ykJsonWord: {
    inputs: ["string", "number[]", "string"],
    output: "boolean",
    source: String.raw`export function f(s: string, pos: number[], w: string): boolean {
  const i = pos[0];
  if (i + w.length > s.length) return false;
  if (!__ykStrEquals(__ykSub(s, i, i + w.length), w)) return false;
  pos[0] = i + w.length;
  return true;
}`,
  },
  // A JSON value at pos[0] (after whitespace): its value.
  __ykJsonParseValue: {
    inputs: ["string", "number[]"],
    output: "unknown",
    source: String.raw`export function f(s: string, pos: number[]): unknown {
  __ykJsonWs(s, pos);
  const i = pos[0];
  if (i >= s.length) return __ykJsonError();
  const c = __ykUnit(s, i);
  if (c === 123) {
    pos[0] = i + 1;
    const o = __ykObjNew(__ykUndef());
    __ykJsonWs(s, pos);
    if (pos[0] < s.length && __ykUnit(s, pos[0]) === 125) {
      pos[0] = pos[0] + 1;
      return o;
    }
    while (true) {
      __ykJsonWs(s, pos);
      if (pos[0] >= s.length || __ykUnit(s, pos[0]) !== 34) return __ykJsonError();
      const k = __ykJsonString(s, pos);
      __ykJsonWs(s, pos);
      if (pos[0] >= s.length || __ykUnit(s, pos[0]) !== 58) return __ykJsonError();
      pos[0] = pos[0] + 1;
      __ykPut(o, k, __ykJsonParseValue(s, pos));
      __ykJsonWs(s, pos);
      if (pos[0] >= s.length) return __ykJsonError();
      const d = __ykUnit(s, pos[0]);
      pos[0] = pos[0] + 1;
      if (d === 125) return o;
      if (d !== 44) return __ykJsonError();
    }
  }
  if (c === 91) {
    pos[0] = i + 1;
    const a = [];
    a.push(__ykUndef());
    a.pop();
    __ykJsonWs(s, pos);
    if (pos[0] < s.length && __ykUnit(s, pos[0]) === 93) {
      pos[0] = pos[0] + 1;
      return a;
    }
    while (true) {
      a.push(__ykJsonParseValue(s, pos));
      __ykJsonWs(s, pos);
      if (pos[0] >= s.length) return __ykJsonError();
      const d = __ykUnit(s, pos[0]);
      pos[0] = pos[0] + 1;
      if (d === 93) return a;
      if (d !== 44) return __ykJsonError();
    }
  }
  if (c === 34) return __ykJsonString(s, pos);
  if (c === 45 || (c >= 48 && c <= 57)) return __ykJsonNumber(s, pos);
  if (__ykJsonWord(s, pos, "true")) return true;
  if (__ykJsonWord(s, pos, "false")) return false;
  if (__ykJsonWord(s, pos, "null")) return null;
  return __ykJsonError();
}`,
  },
  // JSON.parse(text): the whole text one JSON value, else a SyntaxError.
  __ykJsonParse: {
    inputs: ["unknown"],
    output: "unknown",
    source: String.raw`export function f(text: unknown): unknown {
  const s = __ykToString(text);
  const pos = [0];
  const v = __ykJsonParseValue(s, pos);
  __ykJsonWs(s, pos);
  if (pos[0] !== s.length) return __ykJsonError();
  return v;
}`,
  },
};

/**
 * ECMAScript's conversions and generic operators as atoms over dynamic values (`unknown`). A
 * dynamic value is inspected by primitives: `__ykTag` (0 undefined, 1 null, 2 boolean, 3 number,
 * 4 string, 5 an array of numbers, 6 an array of any values, 7 an object), and `__ykNum`, `__ykBool`,
 * `__ykStr`, `__ykArr`, `__ykArrAny`, `__ykObj` read it as that
 * kind; `__ykSame` is reference equality.
 */
export const DYNAMIC_ATOMS: Readonly<Record<string, RuntimeAtom>> = {
  // Array.prototype.join(",") of an array of numbers (ToPrimitive of an array).
  __ykJoinNums: {
    inputs: ["number[]"],
    output: "string",
    source: `export function f(a: number[]): string {
  let out = "";
  let i = 0;
  while (i < a.length) {
    if (i > 0) out = out + ",";
    out = out + __ykNumberToString(a[i]);
    i = i + 1;
  }
  return out;
}`,
  },
  // Array.prototype.join(",") of an array of any values: undefined and null are empty.
  __ykJoinAny: {
    inputs: ["unknown[]"],
    output: "string",
    source: `export function f(a: unknown[]): string {
  let out = "";
  let i = 0;
  while (i < a.length) {
    if (i > 0) out = out + ",";
    const t = __ykTag(a[i]);
    if (t !== 0 && t !== 1) out = out + __ykToString(a[i]);
    i = i + 1;
  }
  return out;
}`,
  },
  // A value's element (x[i], i a number): a string's unit, an array's element, undefined for a
  // missing one or any other value; undefined and null have none (a TypeError). __ykUndef is
  // undefined as a value (in an atom a literal undefined stands for a default).
  __ykIndex: {
    inputs: ["unknown", "number"],
    output: "unknown",
    source: `export function f(x: unknown, i: number): unknown {
  const t = __ykTag(x);
  if (t === 0 || t === 1) return __ykTypeError();
  if (i !== Math.floor(i) || i < 0) return __ykUndef();
  if (t === 4) {
    const s = __ykStr(x);
    if (i < s.length) return __ykSub(s, i, i + 1);
    return __ykUndef();
  }
  if (t === 5) {
    const a = __ykArr(x);
    if (i < a.length) return a[i];
    return __ykUndef();
  }
  if (t === 6) {
    const b = __ykArrAny(x);
    if (i < b.length) return b[i];
    return __ykUndef();
  }
  return __ykUndef();
}`,
  },
  // An array of values of any kind, each a number, as an array of numbers.
  __ykArrToNums: {
    inputs: ["unknown[]"],
    output: "number[]",
    source: `export function f(a: unknown[]): number[] {
  const out: number[] = [];
  let i = 0;
  while (i < a.length) {
    out.push(__ykNum(a[i]));
    i = i + 1;
  }
  return out;
}`,
  },
  // ToPrimitive (ECMA-262 7.1.1) of an object: an array is its join, an object its toString. Any
  // other value is itself.
  __ykToPrimitive: {
    inputs: ["unknown"],
    output: "unknown",
    source: `export function f(x: unknown): unknown {
  const t = __ykTag(x);
  if (t === 5) return __ykJoinNums(__ykArr(x));
  if (t === 6) return __ykJoinAny(__ykArrAny(x));
  if (t === 7) return __ykObjToString(__ykObj(x));
  // A function's source text, which a lowering does not keep: the text of a native function.
  if (t === 8) return "function () { [native code] }";
  return x;
}`,
  },
  // An object's own property: the value, or undefined (__ykUndef) when it has none. An object is
  // its keys and its values, two arrays in insertion order, and the class its errors inherit from.
  __ykGet: {
    inputs: ["YkObject", "string"],
    output: "unknown",
    source: `export function f(o: YkObject, k: string): unknown {
  const keys = __ykObjKeys(o);
  let i = 0;
  while (i < keys.length) {
    if (__ykStrEquals(__ykStr(keys[i]), k)) return __ykObjVals(o)[i];
    i = i + 1;
  }
  return __ykUndef();
}`,
  },
  // Whether an object has an own property.
  __ykHas: {
    inputs: ["YkObject", "string"],
    output: "boolean",
    source: `export function f(o: YkObject, k: string): boolean {
  const keys = __ykObjKeys(o);
  let i = 0;
  while (i < keys.length) {
    if (__ykStrEquals(__ykStr(keys[i]), k)) return true;
    i = i + 1;
  }
  return false;
}`,
  },
  // o[k] = v: the property replaced, or added at the end; the object.
  __ykPut: {
    inputs: ["YkObject", "string", "unknown"],
    output: "YkObject",
    source: `export function f(o: YkObject, k: string, v: unknown): YkObject {
  const keys = __ykObjKeys(o);
  const vals = __ykObjVals(o);
  let i = 0;
  while (i < keys.length) {
    if (__ykStrEquals(__ykStr(keys[i]), k)) {
      vals[i] = v;
      return o;
    }
    i = i + 1;
  }
  keys.push(k);
  vals.push(v);
  return o;
}`,
  },
  // A property of any value (x.k): an object's own, else what an error inherits (name, and an
  // empty message); an array's or a string's length; undefined otherwise. Undefined and null have
  // none (a TypeError).
  __ykGetAny: {
    inputs: ["unknown", "string"],
    output: "unknown",
    source: `export function f(x: unknown, k: string): unknown {
  const t = __ykTag(x);
  if (t === 0 || t === 1) return __ykTypeError();
  if (t === 7) {
    const o = __ykObj(x);
    if (__ykHas(o, k)) return __ykGet(o, k);
    const c = __ykObjCls(o);
    if (__ykTag(c) === 4) {
      if (__ykStrEquals(k, "name")) return c;
      if (__ykStrEquals(k, "message")) return "";
    }
    return __ykUndef();
  }
  if (__ykStrEquals(k, "length")) {
    if (t === 4) return __ykStr(x).length;
    if (t === 5) return __ykArr(x).length;
    if (t === 6) return __ykArrAny(x).length;
  }
  return __ykUndef();
}`,
  },
  // new Error(message), and its subclasses by name: an object of that class, with an own message
  // when one is given (ToString of it).
  __ykMakeError: {
    inputs: ["string", "unknown"],
    output: "YkObject",
    source: `export function f(cls: string, message: unknown): YkObject {
  const o = __ykObjNew(cls);
  if (__ykTag(message) !== 0) __ykPut(o, "message", __ykToString(message));
  return o;
}`,
  },
  // Where ECMAScript throws a TypeError for reading a property of undefined or null: a TypeError.
  __ykTypeError: {
    inputs: [],
    output: "unknown",
    source: `export function f(): unknown {
  throw __ykMakeError("TypeError", "Cannot read properties of undefined or null");
}`,
  },
  // A property key that is an array index (a canonical numeric string below 2^32 - 1): its
  // number, else -1.
  __ykArrayIndex: {
    inputs: ["string"],
    output: "number",
    source: `export function f(k: string): number {
  const n = k.length;
  if (n === 0 || n > 10) return -1;
  if (n > 1 && __ykUnit(k, 0) === 48) return -1;
  let v = 0;
  let i = 0;
  while (i < n) {
    const c = __ykUnit(k, i);
    if (c < 48 || c > 57) return -1;
    v = v * 10 + (c - 48);
    i = i + 1;
  }
  if (v >= 4294967295) return -1;
  return v;
}`,
  },
  // An object's own keys in ECMAScript's order (OrdinaryOwnPropertyKeys): the array indices
  // ascending, then the other keys in the order they were made.
  __ykOwnKeys: {
    inputs: ["YkObject"],
    output: "unknown[]",
    source: `export function f(o: YkObject): unknown[] {
  const keys = __ykObjKeys(o);
  const idx: number[] = [];
  const named = [];
  let i = 0;
  while (i < keys.length) {
    const k = __ykStr(keys[i]);
    const n = __ykArrayIndex(k);
    if (n >= 0) idx.push(n);
    else named.push(k);
    i = i + 1;
  }
  let a = 1;
  while (a < idx.length) {
    const x = idx[a];
    let b = a - 1;
    while (b >= 0 && idx[b] > x) {
      idx[b + 1] = idx[b];
      b = b - 1;
    }
    idx[b + 1] = x;
    a = a + 1;
  }
  const out = [];
  let j = 0;
  while (j < idx.length) {
    out.push(__ykNumberToString(idx[j]));
    j = j + 1;
  }
  let m = 0;
  while (m < named.length) {
    out.push(named[m]);
    m = m + 1;
  }
  return out;
}`,
  },
  // A value's own enumerable string keys: an object's (in order), an array's or a string's
  // indices; none for other values. Object.keys throws a TypeError for undefined and null; for-in
  // visits nothing (forIn).
  __ykKeysOf: {
    inputs: ["unknown", "boolean"],
    output: "unknown[]",
    source: `export function f(x: unknown, forIn: boolean): unknown[] {
  const t = __ykTag(x);
  const out = [];
  if (t === 0 || t === 1) {
    if (forIn) return out;
    return __ykArrAny(__ykCannotConvert());
  }
  if (t === 7) {
    // An error's message is its own, but not enumerable.
    const o = __ykObj(x);
    const own = __ykOwnKeys(o);
    if (__ykTag(__ykObjCls(o)) !== 4) return own;
    let i = 0;
    while (i < own.length) {
      if (!__ykStrEquals(__ykStr(own[i]), "message")) out.push(own[i]);
      i = i + 1;
    }
    return out;
  }
  let n = 0;
  if (t === 4) n = __ykStr(x).length;
  if (t === 5) n = __ykArr(x).length;
  if (t === 6) n = __ykArrAny(x).length;
  let i = 0;
  while (i < n) {
    out.push(__ykNumberToString(i));
    i = i + 1;
  }
  return out;
}`,
  },
  // Object.values and Object.entries: each own enumerable key's value, or [key, value].
  __ykValuesOf: {
    inputs: ["unknown", "boolean"],
    output: "unknown[]",
    source: `export function f(x: unknown, entries: boolean): unknown[] {
  const keys = __ykKeysOf(x, false);
  const t = __ykTag(x);
  const out = [];
  let i = 0;
  while (i < keys.length) {
    const k = keys[i];
    const v = t === 7 ? __ykGetAny(x, __ykStr(k)) : __ykIndex(x, i);
    if (entries) out.push([k, v]);
    else out.push(v);
    i = i + 1;
  }
  return out;
}`,
  },
  // Undefined or null made an object: a TypeError.
  __ykCannotConvert: {
    inputs: [],
    output: "unknown",
    source: `export function f(): unknown {
  throw __ykMakeError("TypeError", "Cannot convert undefined or null to object");
}`,
  },
  // What for-of iterates: an array itself (read as it is at each step), a string's code points;
  // anything else is not iterable (a TypeError).
  __ykIterSource: {
    inputs: ["unknown"],
    output: "unknown",
    source: `export function f(x: unknown): unknown {
  const t = __ykTag(x);
  if (t === 5 || t === 6) return x;
  if (t === 4) return __ykCodePoints(__ykStr(x));
  throw __ykMakeError("TypeError", "is not iterable");
}`,
  },
  // A string's code points, each a string: a surrogate pair together, a lone surrogate alone.
  __ykCodePoints: {
    inputs: ["string"],
    output: "unknown[]",
    source: `export function f(s: string): unknown[] {
  const out = [];
  let i = 0;
  while (i < s.length) {
    const c = __ykUnit(s, i);
    if (c >= 55296 && c <= 56319 && i + 1 < s.length) {
      const d = __ykUnit(s, i + 1);
      if (d >= 56320 && d <= 57343) {
        out.push(__ykSub(s, i, i + 2));
        i = i + 2;
        continue;
      }
    }
    out.push(__ykSub(s, i, i + 1));
    i = i + 1;
  }
  return out;
}`,
  },
  // x instanceof C, for the classes this runtime's values have: every error class is an Error, an
  // array an Array, a function a Function, and any of these an Object. Array.isArray is "Array".
  __ykInstanceOf: {
    inputs: ["unknown", "string"],
    output: "boolean",
    source: `export function f(x: unknown, c: string): boolean {
  const t = __ykTag(x);
  if (t < 5) return false;
  if (__ykStrEquals(c, "Object")) return true;
  if (__ykStrEquals(c, "Array")) return t === 5 || t === 6;
  if (__ykStrEquals(c, "Function")) return t === 8;
  if (t !== 7) return false;
  const cls = __ykObjCls(__ykObj(x));
  if (__ykTag(cls) !== 4) return false;
  if (__ykStrEquals(c, "Error")) return true;
  return __ykStrEquals(__ykStr(cls), c);
}`,
  },
  // The call of a value that is not a function: a TypeError.
  __ykNotAFunction: {
    inputs: [],
    output: "unknown",
    source: `export function f(): unknown {
  throw __ykMakeError("TypeError", "is not a function");
}`,
  },
  // Whether a finally block's completion is a return ([1, value]): it replaces the try's result.
  __ykIsReturn: {
    inputs: ["unknown"],
    output: "boolean",
    source: `export function f(x: unknown): boolean {
  const t = __ykTag(x);
  if (t === 5) {
    const a = __ykArr(x);
    return a.length > 0 && a[0] === 1;
  }
  if (t === 6) {
    const b = __ykArrAny(x);
    return b.length > 0 && __ykStrictEquals(b[0], 1);
  }
  return false;
}`,
  },
  // An object's toString: "[object Object]", or an error's (Error.prototype.toString).
  __ykObjToString: {
    inputs: ["YkObject"],
    output: "string",
    source: `export function f(o: YkObject): string {
  if (__ykTag(__ykObjCls(o)) !== 4) return "[object Object]";
  const n = __ykGetAny(o, "name");
  const m = __ykGetAny(o, "message");
  const name = __ykTag(n) === 0 ? "Error" : __ykToString(n);
  const msg = __ykTag(m) === 0 ? "" : __ykToString(m);
  if (name.length === 0) return msg;
  if (msg.length === 0) return name;
  return name + ": " + msg;
}`,
  },
  // ToNumber (ECMA-262 7.1.4).
  __ykToNumber: {
    inputs: ["unknown"],
    output: "number",
    source: `export function f(x: unknown): number {
  const t = __ykTag(x);
  if (t === 3) return __ykNum(x);
  if (t === 0) return NaN;
  if (t === 1) return 0;
  if (t === 2) return __ykBool(x) ? 1 : 0;
  if (t === 4) return __ykStringToNumber(__ykStr(x));
  return __ykStringToNumber(__ykStr(__ykToPrimitive(x)));
}`,
  },
  // ToString (ECMA-262 7.1.17).
  __ykToString: {
    inputs: ["unknown"],
    output: "string",
    source: `export function f(x: unknown): string {
  const t = __ykTag(x);
  if (t === 4) return __ykStr(x);
  if (t === 3) return __ykNumberToString(__ykNum(x));
  if (t === 0) return "undefined";
  if (t === 1) return "null";
  if (t === 2) return __ykBool(x) ? "true" : "false";
  return __ykStr(__ykToPrimitive(x));
}`,
  },
  // The typeof operator.
  __ykTypeOf: {
    inputs: ["unknown"],
    output: "string",
    source: `export function f(x: unknown): string {
  const t = __ykTag(x);
  if (t === 0) return "undefined";
  if (t === 2) return "boolean";
  if (t === 3) return "number";
  if (t === 4) return "string";
  if (t === 8) return "function";
  return "object";
}`,
  },
  // ToBoolean (ECMA-262 7.1.2).
  __ykTruthy: {
    inputs: ["unknown"],
    output: "boolean",
    source: `export function f(x: unknown): boolean {
  const t = __ykTag(x);
  if (t === 0 || t === 1) return false;
  if (t === 2) return __ykBool(x);
  if (t === 3) {
    const n = __ykNum(x);
    return n !== 0 && n === n;
  }
  if (t === 4) return __ykStr(x).length > 0;
  return true;
}`,
  },
  // IsStrictlyEqual (ECMA-262 7.2.15).
  __ykStrictEquals: {
    inputs: ["unknown", "unknown"],
    output: "boolean",
    source: `export function f(a: unknown, b: unknown): boolean {
  const t = __ykTag(a);
  if (t !== __ykTag(b)) return false;
  if (t === 0 || t === 1) return true;
  if (t === 2) return __ykBool(a) === __ykBool(b);
  if (t === 3) return __ykNum(a) === __ykNum(b);
  if (t === 4) return __ykStrEquals(__ykStr(a), __ykStr(b));
  return __ykSame(a, b);
}`,
  },
  // IsLooselyEqual (ECMA-262 7.2.14); ToPrimitive of an array is its join.
  __ykLooseEquals: {
    inputs: ["unknown", "unknown"],
    output: "boolean",
    source: `export function f(a: unknown, b: unknown): boolean {
  const ta = __ykTag(a);
  const tb = __ykTag(b);
  if (ta === tb) return __ykStrictEquals(a, b);
  if ((ta === 0 || ta === 1) && (tb === 0 || tb === 1)) return true;
  if (ta === 3 && tb === 4) return __ykNum(a) === __ykStringToNumber(__ykStr(b));
  if (ta === 4 && tb === 3) return __ykStringToNumber(__ykStr(a)) === __ykNum(b);
  if (ta === 2) return __ykLooseEquals(__ykBool(a) ? 1 : 0, b);
  if (tb === 2) return __ykLooseEquals(a, __ykBool(b) ? 1 : 0);
  if ((ta === 3 || ta === 4) && tb >= 5) return __ykLooseEquals(a, __ykToPrimitive(b));
  if (ta >= 5 && (tb === 3 || tb === 4)) return __ykLooseEquals(__ykToPrimitive(a), b);
  return false;
}`,
  },
  // The + operator (ECMA-262 13.15.3): ToPrimitive, then a string if either is one, else numbers.
  __ykAdd: {
    inputs: ["unknown", "unknown"],
    output: "unknown",
    source: `export function f(a: unknown, b: unknown): unknown {
  const pa = __ykToPrimitive(a);
  const pb = __ykToPrimitive(b);
  if (__ykTag(pa) === 4 || __ykTag(pb) === 4) return __ykToString(pa) + __ykToString(pb);
  return __ykToNumber(pa) + __ykToNumber(pb);
}`,
  },
  // IsLessThan (ECMA-262 7.2.13), after ToPrimitive: 0 when a < b, 1 when not, 2 when undefined (NaN).
  __ykCompare: {
    inputs: ["unknown", "unknown"],
    output: "number",
    source: `export function f(a: unknown, b: unknown): number {
  const pa = __ykToPrimitive(a);
  const pb = __ykToPrimitive(b);
  if (__ykTag(pa) === 4 && __ykTag(pb) === 4) return __ykStrLess(__ykStr(pa), __ykStr(pb)) ? 0 : 1;
  const x = __ykToNumber(pa);
  const y = __ykToNumber(pb);
  if (x !== x || y !== y) return 2;
  return x < y ? 0 : 1;
}`,
  },
};

/**
 * The primitives as the reference engine has them, to run the atoms' sources in JavaScript and
 * compare them with the builtins they define.
 */
export const RUNTIME_PRIMITIVES_JS = {
  __ykUnit: (s: string, i: number): number => s.charCodeAt(i),
  __ykPow2: (e: number): number => 2 ** e,
  __ykTag: (x: unknown): number =>
    x === undefined
      ? 0
      : x === null
        ? 1
        : typeof x === "boolean"
          ? 2
          : typeof x === "number"
            ? 3
            : typeof x === "string"
              ? 4
              : typeof x === "function"
                ? 8
                : !Array.isArray(x)
                  ? 7
                  : (x as unknown[]).every((e) => typeof e === "number")
                    ? 5
                    : 6,
  __ykNum: (x: unknown): number => x as number,
  __ykBool: (x: unknown): boolean => x as boolean,
  __ykStr: (x: unknown): string => x as string,
  __ykArr: (x: unknown): number[] => x as number[],
  __ykArrAny: (x: unknown): unknown[] => x as unknown[],
  __ykUndef: (): unknown => undefined,
  // An object as the atoms see it (read only, in JavaScript): its own keys but an error's stack,
  // its values, and the class an error inherits its name from.
  __ykObj: (x: unknown): object => x as object,
  __ykObjNew: (cls: unknown): object =>
    typeof cls === "string" ? Object.create({ name: cls, message: "" }) : {},
  __ykObjKeys: (o: object): unknown[] => Object.getOwnPropertyNames(o).filter((k) => k !== "stack"),
  __ykObjVals: (o: object): unknown[] =>
    Object.getOwnPropertyNames(o)
      .filter((k) => k !== "stack")
      .map((k) => (o as Record<string, unknown>)[k]),
  __ykObjCls: (o: object): unknown =>
    o instanceof Error ? (Object.getPrototypeOf(o) as { name: string }).name : undefined,
  __ykSame: (a: unknown, b: unknown): boolean => a === b,
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
