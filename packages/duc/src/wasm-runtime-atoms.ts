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
  // from the binary exponent (x = mant 2^e, mant below 2^53: log10 x below (e + 53) log10 2) and an
  // exact correction both ways, so the estimate needs no host function.
  let k = Math.ceil((e + 53) * 0.3010299956639812);
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
    // sort(comparefn): stable (an insertion sort), the comparator's result made a number (NaN is
    // 0), undefined elements last without calling it; in place, the array returned.
    [`__ykSort${kind}`]: {
      inputs: [arr, "function"],
      output: "unknown",
      source: `export function f(a: ${arr}, g: (p: unknown, q: unknown) => unknown): ${arr} {
  const n = a.length;
  let i = 1;
  while (i < n) {
    const x = a[i];
    let j = i - 1;
    while (j >= 0) {
      const y = a[j];
      const ty = __ykTag(y);
      const tx = __ykTag(x);
      let c = 0;
      if (ty === 0 && tx === 0) c = 0;
      else if (ty === 0) c = 1;
      else if (tx === 0) c = -1;
      else {
        c = __ykToNumber(g(y, x));
        if (c !== c) c = 0;
      }
      if (c <= 0) break;
      a[j + 1] = y;
      j = j - 1;
    }
    a[j + 1] = x;
    i = i + 1;
  }
  return a;
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
  // the objects being written (a cycle is a TypeError); indent and gap the space argument's; rep
  // the replacer function, or undefined; plist the property list (an array replacer's), or
  // undefined.
  __ykJsonValue: {
    inputs: ["unknown", "string", "unknown[]", "string", "string", "unknown", "unknown"],
    output: "unknown",
    source: String.raw`export function f(v: unknown, key: string, stack: unknown[], indent: string, gap: string, rep: unknown, plist: unknown): unknown {
  let x = v;
  if (__ykTag(x) === 7) {
    const tj = __ykGetAny(x, "toJSON");
    if (__ykTag(tj) === 8) x = tj(key);
  }
  if (__ykTag(rep) === 8) x = rep(key, x);
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
      const e = __ykJsonValue(__ykIndex(x, i), __ykNumberToString(i), stack, inner, gap, rep, plist);
      if (i > 0) parts = parts + sep;
      parts = parts + (__ykTag(e) === 0 ? "null" : __ykStr(e));
      i = i + 1;
    }
    if (n === 0) out = "[]";
    else if (gap.length > 0) out = "[\n" + inner + parts + "\n" + indent + "]";
    else out = "[" + parts + "]";
  } else {
    const keys = __ykTag(plist) === 0 ? __ykKeysOf(x, false) : __ykArrAny(plist);
    let parts = "";
    let count = 0;
    let i = 0;
    while (i < keys.length) {
      const k = __ykStr(keys[i]);
      const e = __ykJsonValue(__ykGetAny(x, k), k, stack, inner, gap, rep, plist);
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
  // JSON.stringify(value, replacer, space): a function replacer called for every property, or an
  // array's strings and numbers (as strings, once each) the properties written of objects.
  __ykJsonStringify: {
    inputs: ["unknown", "unknown", "unknown"],
    output: "unknown",
    source: String.raw`export function f(x: unknown, replacer: unknown, space: unknown): unknown {
  let rep = __ykUndef();
  let plist = __ykUndef();
  const tr = __ykTag(replacer);
  if (tr === 8) rep = replacer;
  else if (tr === 5 || tr === 6) {
    const names: unknown[] = [];
    const n = __ykNum(__ykGetAny(replacer, "length"));
    let j = 0;
    while (j < n) {
      const e = __ykIndex(replacer, j);
      const te = __ykTag(e);
      if (te === 3 || te === 4) {
        const item = te === 3 ? __ykNumberToString(__ykNum(e)) : __ykStr(e);
        let seen = false;
        let m = 0;
        while (m < names.length) {
          if (__ykStrEquals(__ykStr(names[m]), item)) seen = true;
          m = m + 1;
        }
        if (!seen) names.push(item);
      }
      j = j + 1;
    }
    plist = names;
  }
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
  return __ykJsonValue(x, "", stack, "", gap, rep, plist);
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
  // JSON.parse(text, reviver): the whole text one JSON value, else a SyntaxError; then, with a
  // reviver, InternalizeJSONProperty from the root.
  __ykJsonParse: {
    inputs: ["unknown", "unknown"],
    output: "unknown",
    source: String.raw`export function f(text: unknown, reviver: unknown): unknown {
  const s = __ykToString(text);
  const pos = [0];
  const v = __ykJsonParseValue(s, pos);
  __ykJsonWs(s, pos);
  if (pos[0] !== s.length) return __ykJsonError();
  if (__ykTag(reviver) !== 8) return v;
  return __ykJsonRevive(v, "", reviver);
}`,
  },
  // InternalizeJSONProperty, of the value of a property named name: its elements' or properties'
  // values revived first (a property revived to undefined deleted), then it.
  __ykJsonRevive: {
    inputs: ["unknown", "string", "unknown"],
    output: "unknown",
    source: String.raw`export function f(val: unknown, name: string, reviver: unknown): unknown {
  const t = __ykTag(val);
  if (t === 6) {
    const a = __ykArrAny(val);
    const n = a.length;
    let i = 0;
    while (i < n) {
      a[i] = __ykJsonRevive(a[i], __ykNumberToString(i), reviver);
      i = i + 1;
    }
  } else if (t === 7) {
    const keys = __ykKeysOf(val, false);
    let i = 0;
    while (i < keys.length) {
      const k = __ykStr(keys[i]);
      const e = __ykJsonRevive(__ykGetAny(val, k), k, reviver);
      if (__ykTag(e) === 0) __ykObjDelete(val, k);
      else __ykPut(val, k, e);
      i = i + 1;
    }
  }
  return reviver(name, val);
}`,
  },
};

/**
 * Map and Set (ECMA-262 24.1, 24.2), and the call of a method of a value of any kind. A Map or a
 * Set is an object whose class is "Map" or "Set" and whose keys and values are its entries (a Set's
 * values are unused), in the order they were added, compared by SameValueZero; it has no own
 * properties. Its keys(), values() and entries() are arrays of a snapshot (an iterator's next() is
 * not lowered). __ykInvoke calls a method: an object's own function property, else the builtin
 * method of the receiver's kind (an array's, a string's, a Map's or a Set's), else a TypeError.
 */
export const COLLECTION_ATOMS: Readonly<Record<string, RuntimeAtom>> = {
  // Whether a class names an error (every error class's name ends in "Error").
  __ykIsErrorCls: {
    inputs: ["unknown"],
    output: "boolean",
    source: String.raw`export function f(c: unknown): boolean {
  if (__ykTag(c) !== 4) return false;
  return __ykEndsWith(__ykStr(c), "Error", Infinity);
}`,
  },
  // SameValueZero: NaN is NaN, and -0 is 0.
  __ykSameValueZero: {
    inputs: ["unknown", "unknown"],
    output: "boolean",
    source: String.raw`export function f(a: unknown, b: unknown): boolean {
  const t = __ykTag(a);
  if (t !== __ykTag(b)) return false;
  if (t === 3) {
    const x = __ykNum(a);
    const y = __ykNum(b);
    return x === y || (x !== x && y !== y);
  }
  return __ykStrictEquals(a, b);
}`,
  },
  // A Map's or a Set's entry index for a key, or -1.
  __ykCollFind: {
    inputs: ["YkObject", "unknown"],
    output: "number",
    source: String.raw`export function f(o: YkObject, k: unknown): number {
  const keys = __ykObjKeys(o);
  let i = 0;
  while (i < keys.length) {
    if (__ykSameValueZero(keys[i], k)) return i;
    i = i + 1;
  }
  return -1;
}`,
  },
  // Map.prototype.set (and, with v unused, Set.prototype.add): -0 is stored as 0.
  __ykCollSet: {
    inputs: ["YkObject", "unknown", "unknown"],
    output: "YkObject",
    source: String.raw`export function f(o: YkObject, k0: unknown, v: unknown): YkObject {
  let k = k0;
  if (__ykTag(k) === 3 && __ykNum(k) === 0) k = 0;
  const i = __ykCollFind(o, k);
  const vals = __ykObjVals(o);
  if (i >= 0) {
    vals[i] = v;
    return o;
  }
  __ykObjKeys(o).push(k);
  vals.push(v);
  return o;
}`,
  },
  // Map.prototype.delete and Set.prototype.delete: whether the key was there.
  __ykCollDelete: {
    inputs: ["YkObject", "unknown"],
    output: "boolean",
    source: String.raw`export function f(o: YkObject, k: unknown): boolean {
  const i = __ykCollFind(o, k);
  if (i < 0) return false;
  const keys = __ykObjKeys(o);
  const vals = __ykObjVals(o);
  let j = i;
  while (j + 1 < keys.length) {
    keys[j] = keys[j + 1];
    vals[j] = vals[j + 1];
    j = j + 1;
  }
  keys.pop();
  vals.pop();
  return true;
}`,
  },
  // new Map(iterable) and new Set(iterable): each [key, value] entry, or each value, added.
  __ykCollNew: {
    inputs: ["string", "unknown"],
    output: "YkObject",
    source: String.raw`export function f(cls: string, init: unknown): YkObject {
  const o = __ykObjNew(cls);
  const t = __ykTag(init);
  if (t === 0 || t === 1) return o;
  const src = __ykIterSource(init);
  const n = __ykNum(__ykGetAny(src, "length"));
  let i = 0;
  while (i < n) {
    const e = __ykIndex(src, i);
    if (__ykStrEquals(cls, "Map")) __ykCollSet(o, __ykIndex(e, 0), __ykIndex(e, 1));
    else __ykCollSet(o, e, __ykUndef());
    i = i + 1;
  }
  return o;
}`,
  },
  // A Map's entries ([key, value] arrays), keys or values, or a Set's values: a snapshot.
  __ykCollList: {
    inputs: ["YkObject", "number"],
    output: "unknown[]",
    source: String.raw`export function f(o: YkObject, which: number): unknown[] {
  const keys = __ykObjKeys(o);
  const vals = __ykObjVals(o);
  const out = [];
  out.push(__ykUndef());
  out.pop();
  let i = 0;
  while (i < keys.length) {
    if (which === 0) out.push([keys[i], vals[i]]);
    else if (which === 3) out.push([keys[i], keys[i]]);
    else if (which === 1) out.push(keys[i]);
    else out.push(vals[i]);
    i = i + 1;
  }
  return out;
}`,
  },
  // A builtin method of an array (of numbers or of any values), by name: the result, or
  // __ykNoMethod when the array has no such method.
  __ykArrayMethod: {
    inputs: ["unknown", "string", "unknown[]"],
    output: "unknown",
    source: String.raw`export function f(a: unknown, name: string, args: unknown[]): unknown {
  const n = __ykNum(__ykGetAny(a, "length"));
  const arg = (i: number): unknown => (i < args.length ? args[i] : __ykUndef());
  if (__ykStrEquals(name, "push")) {
    let i = 0;
    let len = n;
    while (i < args.length) {
      if (__ykTag(a) === 5) len = __ykArr(a).push(__ykNum(args[i]));
      else len = __ykArrAny(a).push(args[i]);
      i = i + 1;
    }
    return len;
  }
  if (__ykStrEquals(name, "pop")) {
    if (n === 0) return __ykUndef();
    if (__ykTag(a) === 5) return __ykArr(a).pop();
    return __ykArrAny(a).pop();
  }
  if (__ykStrEquals(name, "indexOf") || __ykStrEquals(name, "includes")) {
    const x = arg(0);
    let i = 0;
    while (i < n) {
      const e = __ykIndex(a, i);
      const hit = __ykStrEquals(name, "includes") ? __ykSameValueZero(e, x) : __ykStrictEquals(e, x);
      if (hit) return __ykStrEquals(name, "includes") ? true : i;
      i = i + 1;
    }
    return __ykStrEquals(name, "includes") ? false : -1;
  }
  if (__ykStrEquals(name, "join")) {
    const sepArg = arg(0);
    const sep = __ykTag(sepArg) === 0 ? "," : __ykToString(sepArg);
    let out = "";
    let i = 0;
    while (i < n) {
      if (i > 0) out = out + sep;
      const e = __ykIndex(a, i);
      const t = __ykTag(e);
      if (t !== 0 && t !== 1) out = out + __ykToString(e);
      i = i + 1;
    }
    return out;
  }
  // sort() with no comparator: by ToString, undefined last; stable (an insertion sort).
  if (__ykStrEquals(name, "sort")) {
    if (args.length > 0 && __ykTag(arg(0)) !== 0) {
      const g = arg(0);
      if (__ykTag(g) !== 8) return __ykNotAFunction();
    }
    const g = arg(0);
    let i = 1;
    while (i < n) {
      const x = __ykIndex(a, i);
      let j = i - 1;
      while (j >= 0) {
        const y = __ykIndex(a, j);
        const ty = __ykTag(y);
        const tx = __ykTag(x);
        let c = 0;
        if (ty === 0 && tx === 0) c = 0;
        else if (ty === 0) c = 1;
        else if (tx === 0) c = -1;
        else if (__ykTag(g) === 8) {
          c = __ykToNumber(__ykCallWith(g, [y, x]));
          if (c !== c) c = 0;
        } else {
          const sy = __ykToString(y);
          const sx = __ykToString(x);
          c = __ykStrLess(sx, sy) ? 1 : __ykStrLess(sy, sx) ? -1 : 0;
        }
        if (c <= 0) break;
        if (__ykTag(a) === 5) __ykArr(a)[j + 1] = __ykNum(y);
        else __ykArrAny(a)[j + 1] = y;
        j = j - 1;
      }
      if (__ykTag(a) === 5) __ykArr(a)[j + 1] = __ykNum(x);
      else __ykArrAny(a)[j + 1] = x;
      i = i + 1;
    }
    return a;
  }
  // slice, at, lastIndexOf, reverse (in place), concat.
  const rel = (v: unknown, d: number): number => {
    if (__ykTag(v) === 0) return d;
    const k = __ykToInteger(v);
    if (k < 0) return k + n < 0 ? 0 : k + n;
    return k > n ? n : k;
  };
  if (__ykStrEquals(name, "slice")) {
    const from = rel(arg(0), 0);
    const to = rel(arg(1), n);
    const out = [];
    out.push(__ykUndef());
    out.pop();
    let i = from;
    while (i < to) {
      out.push(__ykIndex(a, i));
      i = i + 1;
    }
    return out;
  }
  if (__ykStrEquals(name, "at")) {
    const k0 = __ykToInteger(arg(0));
    const k = k0 >= 0 ? k0 : n + k0;
    if (k < 0 || k >= n) return __ykUndef();
    return __ykIndex(a, k);
  }
  if (__ykStrEquals(name, "lastIndexOf")) {
    const x = arg(0);
    let i = args.length > 1 ? __ykToInteger(arg(1)) : n - 1;
    if (i < 0) i = i + n;
    if (i >= n) i = n - 1;
    while (i >= 0) {
      if (__ykStrictEquals(__ykIndex(a, i), x)) return i;
      i = i - 1;
    }
    return -1;
  }
  if (__ykStrEquals(name, "reverse")) {
    let lo = 0;
    let hi = n - 1;
    while (lo < hi) {
      const x = __ykIndex(a, lo);
      const y = __ykIndex(a, hi);
      if (__ykTag(a) === 5) {
        __ykArr(a)[lo] = __ykNum(y);
        __ykArr(a)[hi] = __ykNum(x);
      } else {
        __ykArrAny(a)[lo] = y;
        __ykArrAny(a)[hi] = x;
      }
      lo = lo + 1;
      hi = hi - 1;
    }
    return a;
  }
  if (__ykStrEquals(name, "concat")) {
    const out = [];
    out.push(__ykUndef());
    out.pop();
    let i = 0;
    while (i < n) {
      out.push(__ykIndex(a, i));
      i = i + 1;
    }
    let j = 0;
    while (j < args.length) {
      const e = args[j];
      const te = __ykTag(e);
      if (te === 5 || te === 6) {
        const m = __ykNum(__ykGetAny(e, "length"));
        let k = 0;
        while (k < m) {
          out.push(__ykIndex(e, k));
          k = k + 1;
        }
      } else out.push(e);
      j = j + 1;
    }
    return out;
  }
  const g = arg(0);
  if (__ykStrEquals(name, "forEach") || __ykStrEquals(name, "map") || __ykStrEquals(name, "filter") || __ykStrEquals(name, "some") || __ykStrEquals(name, "every") || __ykStrEquals(name, "find") || __ykStrEquals(name, "findIndex")) {
    if (__ykTag(g) !== 8) return __ykNotAFunction();
    const out = [];
    out.push(__ykUndef());
    out.pop();
    let i = 0;
    while (i < n) {
      const x = __ykIndex(a, i);
      const r = __ykCallWith(g, [x, i, a]);
      if (__ykStrEquals(name, "map")) out.push(r);
      else if (__ykStrEquals(name, "filter")) {
        if (__ykTruthy(r)) out.push(x);
      } else if (__ykStrEquals(name, "some")) {
        if (__ykTruthy(r)) return true;
      } else if (__ykStrEquals(name, "every")) {
        if (!__ykTruthy(r)) return false;
      } else if (__ykStrEquals(name, "find")) {
        if (__ykTruthy(r)) return x;
      } else if (__ykStrEquals(name, "findIndex")) {
        if (__ykTruthy(r)) return i;
      }
      i = i + 1;
    }
    if (__ykStrEquals(name, "map") || __ykStrEquals(name, "filter")) return out;
    if (__ykStrEquals(name, "some")) return false;
    if (__ykStrEquals(name, "every")) return true;
    if (__ykStrEquals(name, "findIndex")) return -1;
    return __ykUndef();
  }
  return __ykNoMethod();
}`,
  },
  // A builtin method of a string, by name (the runtime's string atoms), or __ykNoMethod.
  __ykStringMethod: {
    inputs: ["string", "string", "unknown[]"],
    output: "unknown",
    source: String.raw`export function f(s: string, name: string, args: unknown[]): unknown {
  const arg = (i: number): unknown => (i < args.length ? args[i] : __ykUndef());
  const num = (i: number, d: number): number => (__ykTag(arg(i)) === 0 ? d : __ykToNumber(arg(i)));
  if (__ykStrEquals(name, "charCodeAt")) return __ykCharCodeAt(s, num(0, 0));
  if (__ykStrEquals(name, "charAt")) return __ykCharAt(s, num(0, 0));
  if (__ykStrEquals(name, "slice")) return __ykSlice(s, num(0, 0), num(1, Infinity));
  if (__ykStrEquals(name, "substring")) return __ykSubstring(s, num(0, 0), num(1, Infinity));
  if (__ykStrEquals(name, "indexOf")) return __ykIndexOf(s, __ykToString(arg(0)), num(1, 0));
  if (__ykStrEquals(name, "includes")) return __ykIndexOf(s, __ykToString(arg(0)), num(1, 0)) !== -1;
  if (__ykStrEquals(name, "startsWith")) return __ykStartsWith(s, __ykToString(arg(0)), num(1, 0));
  if (__ykStrEquals(name, "endsWith")) return __ykEndsWith(s, __ykToString(arg(0)), num(1, Infinity));
  if (__ykStrEquals(name, "trim")) return __ykTrim(s);
  if (__ykStrEquals(name, "toString")) return s;
  return __ykNoMethod();
}`,
  },
  // A method that is not there: a TypeError.
  __ykNoMethod: {
    inputs: [],
    output: "unknown",
    source: String.raw`export function f(): unknown {
  throw __ykMakeError("TypeError", "is not a function");
}`,
  },
  // recv.name(...args) for a receiver of any kind.
  // Number.isNaN, isFinite, isInteger and isSafeInteger: false for anything but a number.
  __ykNumberIsNaN: {
    inputs: ["unknown"],
    output: "boolean",
    source: String.raw`export function f(x: unknown): boolean {
  if (__ykTag(x) !== 3) return false;
  const n = __ykNum(x);
  return n !== n;
}`,
  },
  __ykNumberIsFinite: {
    inputs: ["unknown"],
    output: "boolean",
    source: String.raw`export function f(x: unknown): boolean {
  if (__ykTag(x) !== 3) return false;
  const n = __ykNum(x);
  return n === n && n !== Infinity && n !== -Infinity;
}`,
  },
  __ykNumberIsInteger: {
    inputs: ["unknown"],
    output: "boolean",
    source: String.raw`export function f(x: unknown): boolean {
  if (__ykTag(x) !== 3) return false;
  const n = __ykNum(x);
  return n === n && n !== Infinity && n !== -Infinity && Math.trunc(n) === n;
}`,
  },
  __ykNumberIsSafeInteger: {
    inputs: ["unknown"],
    output: "boolean",
    source: String.raw`export function f(x: unknown): boolean {
  if (__ykTag(x) !== 3) return false;
  const n = __ykNum(x);
  return n === n && Math.trunc(n) === n && Math.abs(n) <= 9007199254740991;
}`,
  },
  // key in o: an own property, or one o's prototype chain has (ECMAScript 2025's, as V8 has them,
  // with V8's own stack of an error); a TypeError when o is not an object. A function's prototype
  // property (a function declaration's, not an arrow's) is not known here.
  __ykIn: {
    inputs: ["unknown", "unknown"],
    output: "boolean",
    source: String.raw`export function f(key: unknown, o: unknown): boolean {
  const t = __ykTag(o);
  if (t !== 5 && t !== 6 && t !== 7 && t !== 8) {
    throw __ykMakeError("TypeError", "Cannot use 'in' operator to search for '" + __ykToString(key) + "' in " + __ykToString(o));
  }
  const k = __ykTag(key) === 3 ? __ykNumberToString(__ykNum(key)) : __ykToString(key);
  const listed = (names: string): boolean => __ykIndexOf("," + names + ",", "," + k + ",", 0) >= 0 && __ykIndexOf(k, ",", 0) < 0;
  if (listed("constructor,__defineGetter__,__defineSetter__,hasOwnProperty,__lookupGetter__,__lookupSetter__,isPrototypeOf,propertyIsEnumerable,toString,valueOf,__proto__,toLocaleString")) return true;
  if (t === 5 || t === 6) {
    if (listed("length,at,concat,copyWithin,fill,find,findIndex,findLast,findLastIndex,lastIndexOf,pop,push,reverse,shift,unshift,slice,sort,splice,includes,indexOf,join,keys,entries,values,forEach,filter,flat,flatMap,map,every,some,reduce,reduceRight,toReversed,toSorted,toSpliced,with")) return true;
    const n = __ykToNumber(k);
    return __ykStrEquals(__ykNumberToString(n), k) && n >= 0 && n === Math.floor(n) && n < __ykNum(__ykGetAny(o, "length"));
  }
  if (t === 8) return listed("length,name,arguments,caller,apply,bind,call");
  const ob = __ykObj(o);
  const cls = __ykObjCls(ob);
  if (__ykTag(cls) === 4 && __ykStrEquals(__ykStr(cls), "Map")) return listed("get,set,has,delete,clear,entries,forEach,keys,size,values");
  if (__ykTag(cls) === 4 && __ykStrEquals(__ykStr(cls), "Set")) return listed("has,add,delete,clear,entries,forEach,size,values,keys,union,intersection,difference,symmetricDifference,isSubsetOf,isSupersetOf,isDisjointFrom");
  if (__ykIsErrorCls(cls) && listed("name,message,stack")) return true;
  return __ykHas(ob, k);
}`,
  },
  // An optional chain's link (a?.k, a?.[key], a?.m(...), f?.(...)): undefined when what it reads
  // is undefined or null, else the plain link's result.
  __ykOptGet: {
    inputs: ["unknown", "string"],
    output: "unknown",
    source: String.raw`export function f(x: unknown, k: string): unknown {
  const t = __ykTag(x);
  if (t === 0 || t === 1) return __ykUndef();
  return __ykGetAny(x, k);
}`,
  },
  __ykOptGetKey: {
    inputs: ["unknown", "unknown"],
    output: "unknown",
    source: String.raw`export function f(x: unknown, key: unknown): unknown {
  const t = __ykTag(x);
  if (t === 0 || t === 1) return __ykUndef();
  return __ykGetKey(x, key);
}`,
  },
  __ykOptInvoke: {
    inputs: ["unknown", "string", "unknown[]"],
    output: "unknown",
    source: String.raw`export function f(x: unknown, name: string, args: unknown[]): unknown {
  const t = __ykTag(x);
  if (t === 0 || t === 1) return __ykUndef();
  return __ykInvoke(x, name, args);
}`,
  },
  __ykOptCall: {
    inputs: ["unknown", "unknown[]"],
    output: "unknown",
    source: String.raw`export function f(g: unknown, args: unknown[]): unknown {
  const t = __ykTag(g);
  if (t === 0 || t === 1) return __ykUndef();
  return __ykCallWith(g, args);
}`,
  },
  __ykInvoke: {
    inputs: ["unknown", "string", "unknown[]"],
    output: "unknown",
    source: String.raw`export function f(recv: unknown, name: string, args: unknown[]): unknown {
  const t = __ykTag(recv);
  if (t === 0 || t === 1) return __ykTypeError();
  const arg = (i: number): unknown => (i < args.length ? args[i] : __ykUndef());
  if (t === 7) {
    const o = __ykObj(recv);
    const cls = __ykObjCls(o);
    const coll = __ykTag(cls) === 4 && (__ykStrEquals(__ykStr(cls), "Map") || __ykStrEquals(__ykStr(cls), "Set"));
    if (!coll && __ykHas(o, name)) return __ykCallWith(__ykGet(o, name), args);
    if (coll) {
      const isMap = __ykStrEquals(__ykStr(cls), "Map");
      if (__ykStrEquals(name, "get")) {
        const i = __ykCollFind(o, arg(0));
        return i < 0 ? __ykUndef() : __ykObjVals(o)[i];
      }
      if (__ykStrEquals(name, "has")) return __ykCollFind(o, arg(0)) >= 0;
      if (isMap && __ykStrEquals(name, "set")) return __ykCollSet(o, arg(0), arg(1));
      if (!isMap && __ykStrEquals(name, "add")) return __ykCollSet(o, arg(0), __ykUndef());
      if (__ykStrEquals(name, "delete")) return __ykCollDelete(o, arg(0));
      if (__ykStrEquals(name, "clear")) {
        const keys = __ykObjKeys(o);
        const vals = __ykObjVals(o);
        while (keys.length > 0) {
          keys.pop();
          vals.pop();
        }
        return __ykUndef();
      }
      if (__ykStrEquals(name, "entries")) return isMap ? __ykCollList(o, 0) : __ykCollList(o, 3);
      if (__ykStrEquals(name, "keys")) return __ykCollList(o, 1);
      if (__ykStrEquals(name, "values")) return isMap ? __ykCollList(o, 2) : __ykCollList(o, 1);
      if (__ykStrEquals(name, "forEach")) {
        const g = arg(0);
        if (__ykTag(g) !== 8) return __ykNotAFunction();
        const keys = __ykObjKeys(o);
        let i = 0;
        while (i < keys.length) {
          const k = keys[i];
          __ykCallWith(g, [isMap ? __ykObjVals(o)[i] : k, k, o]);
          i = i + 1;
        }
        return __ykUndef();
      }
    }
    if (__ykStrEquals(name, "toString")) return __ykToString(recv);
    return __ykNoMethod();
  }
  if ((t === 5 || t === 6) && __ykStrEquals(name, "toString")) return __ykToString(recv);
  if (t === 5 || t === 6) return __ykArrayMethod(recv, name, args);
  if (t === 4) return __ykStringMethod(__ykStr(recv), name, args);
  if (t === 3 && __ykStrEquals(name, "toString")) return __ykNumberToStringRadix(__ykNum(recv), arg(0));
  if (t === 3 && __ykStrEquals(name, "toFixed")) return __ykToFixed(__ykNum(recv), arg(0));
  if (t === 2 && __ykStrEquals(name, "toString")) return __ykBool(recv) ? "true" : "false";
  return __ykNoMethod();
}`,
  },
};

/**
 * More of String.prototype and Array.prototype, as the specification defines them: each argument
 * a value of any kind, converted as the method does (an absent one is undefined).
 */
export const METHOD_ATOMS: Readonly<Record<string, RuntimeAtom>> = {
  // Each element an iterable gives (__ykIterSource), pushed onto out.
  __ykRestFrom: {
    inputs: ["unknown[]", "number"],
    output: "unknown[]",
    source: String.raw`export function f(a: unknown[], from: number): unknown[] {
  const out: unknown[] = [];
  let i = from;
  while (i < a.length) {
    out.push(a[i]);
    i = i + 1;
  }
  return out;
}`,
  },
  __ykAppendAll: {
    inputs: ["unknown[]", "unknown"],
    output: "unknown",
    source: String.raw`export function f(out: unknown[], x: unknown): unknown {
  const src = __ykIterSource(x);
  const n = __ykNum(__ykGetAny(src, "length"));
  let i = 0;
  while (i < n) {
    out.push(__ykIndex(src, i));
    i = i + 1;
  }
  return __ykUndef();
}`,
  },
  // Object.assign's copy of one source (an object literal's spread): its own enumerable keys, in
  // order; undefined and null give none.
  __ykAssign: {
    inputs: ["YkObject", "unknown"],
    output: "unknown",
    source: String.raw`export function f(o: YkObject, src: unknown): unknown {
  const t = __ykTag(src);
  if (t === 0 || t === 1) return __ykUndef();
  const keys = __ykKeysOf(src, false);
  let i = 0;
  while (i < keys.length) {
    const k = __ykStr(keys[i]);
    __ykPut(o, k, t === 7 ? __ykGetAny(src, k) : __ykIndex(src, i));
    i = i + 1;
  }
  return __ykUndef();
}`,
  },
  // Array.from(items): an iterable's elements, else an array-like's (its length, its indices).
  __ykArrayFrom: {
    inputs: ["unknown"],
    output: "unknown[]",
    source: String.raw`export function f(x: unknown): unknown[] {
  const out = [];
  out.push(__ykUndef());
  out.pop();
  const t = __ykTag(x);
  if (t === 0 || t === 1) return __ykArrAny(__ykCannotConvert());
  const coll = t === 7 && __ykTag(__ykObjCls(__ykObj(x))) === 4 && (__ykStrEquals(__ykStr(__ykObjCls(__ykObj(x))), "Map") || __ykStrEquals(__ykStr(__ykObjCls(__ykObj(x))), "Set"));
  if (t === 4 || t === 5 || t === 6 || coll) {
    __ykAppendAll(out, x);
    return out;
  }
  const n = __ykToInteger(__ykGetAny(x, "length"));
  let i = 0;
  while (i < n) {
    out.push(t === 7 ? __ykGetAny(x, __ykNumberToString(i)) : __ykUndef());
    i = i + 1;
  }
  return out;
}`,
  },
  // Math.max / Math.min of an array of arguments (a spread call): NaN if any is NaN; -0 below 0.
  __ykMaxMinOf: {
    inputs: ["unknown[]", "boolean"],
    output: "number",
    source: String.raw`export function f(args: unknown[], max: boolean): number {
  let r = max ? -Infinity : Infinity;
  let i = 0;
  while (i < args.length) {
    const v = __ykToNumber(args[i]);
    if (v !== v) r = NaN;
    else if (r === r) r = max ? Math.max(r, v) : Math.min(r, v);
    i = i + 1;
  }
  return r;
}`,
  },
  // ToIntegerOrInfinity of any value.
  __ykToInteger: {
    inputs: ["unknown"],
    output: "number",
    source: String.raw`export function f(x: unknown): number {
  const n = __ykToNumber(x);
  if (n !== n) return 0;
  return Math.trunc(n);
}`,
  },
  // String.prototype.split(separator, limit) for a string separator.
  __ykSplit: {
    inputs: ["string", "unknown", "unknown"],
    output: "unknown[]",
    source: String.raw`export function f(s: string, sep: unknown, limit: unknown): unknown[] {
  const out = [];
  out.push(__ykUndef());
  out.pop();
  let lim = 4294967295;
  if (__ykTag(limit) !== 0) {
    lim = __ykToInt32(__ykToNumber(limit));
    if (lim < 0) lim = lim + 4294967296;
  }
  const r = __ykToString(sep);
  if (lim === 0) return out;
  if (__ykTag(sep) === 0) {
    out.push(s);
    return out;
  }
  if (s.length === 0) {
    if (r.length > 0) out.push(s);
    return out;
  }
  if (r.length === 0) {
    let i = 0;
    while (i < s.length && out.length < lim) {
      out.push(__ykSub(s, i, i + 1));
      i = i + 1;
    }
    return out;
  }
  let p = 0;
  let q = __ykIndexOf(s, r, 0);
  while (q !== -1) {
    out.push(__ykSub(s, p, q));
    if (out.length >= lim) return out;
    p = q + r.length;
    q = __ykIndexOf(s, r, p);
  }
  out.push(__ykSub(s, p, s.length));
  return out;
}`,
  },
  // String.prototype.repeat(count): a RangeError for a negative or infinite count.
  __ykRepeat: {
    inputs: ["string", "unknown"],
    output: "string",
    source: String.raw`export function f(s: string, count: unknown): string {
  const n = __ykToInteger(count);
  if (n < 0 || n === Infinity) return __ykStr(__ykRangeError());
  let out = "";
  let k = 0;
  while (k < n) {
    out = out + s;
    k = k + 1;
  }
  return out;
}`,
  },
  // Number.prototype.toString(radix) for a radix other than 10, as V8 writes it
  // (DoubleToRadixCString): fraction digits while they are above half a unit in the last place of
  // the value (scaled with them), rounded to even with a carry back through the digits written;
  // integer digits by repeated division, those below the double's precision zeros.
  __ykNumberToRadix: {
    inputs: ["number", "number"],
    output: "string",
    source: String.raw`export function f(x: number, radix: number): string {
  const chars = "0123456789abcdefghijklmnopqrstuvwxyz";
  if (x !== x) return "NaN";
  if (x === Infinity) return "Infinity";
  if (x === -Infinity) return "-Infinity";
  const negative = x < 0;
  const value = negative ? -x : x;
  let integer = Math.floor(value);
  let fraction = value - integer;
  const biased = Math.floor(__ykF64Hi(value) / 1048576) % 2048;
  const ulp = biased === 0 ? __ykPow2(-1074) : __ykPow2(biased - 1075);
  let delta = 0.5 * (value + ulp - value);
  delta = Math.max(__ykPow2(-1074), delta);
  const digits: number[] = [];
  if (fraction >= delta) {
    let going = true;
    while (going) {
      fraction = fraction * radix;
      delta = delta * radix;
      const digit = Math.floor(fraction);
      digits.push(digit);
      fraction = fraction - digit;
      if (fraction > 0.5 || (fraction === 0.5 && digit % 2 === 1)) {
        if (fraction + delta > 1) {
          let carrying = true;
          while (carrying) {
            if (digits.length === 0) {
              integer = integer + 1;
              carrying = false;
            } else {
              const d = digits[digits.length - 1] as number;
              digits.pop();
              if (d + 1 < radix) {
                digits.push(d + 1);
                carrying = false;
              }
            }
          }
          going = false;
        }
      }
      if (going && !(fraction >= delta)) going = false;
    }
  }
  let intPart = "";
  while (integer / radix >= 9007199254740992) {
    integer = integer / radix;
    intPart = "0" + intPart;
  }
  let more = true;
  while (more) {
    const remainder = integer % radix;
    intPart = __ykSub(chars, remainder, remainder + 1) + intPart;
    integer = (integer - remainder) / radix;
    more = integer > 0;
  }
  let out = negative ? "-" + intPart : intPart;
  if (digits.length > 0) {
    out = out + ".";
    let i = 0;
    while (i < digits.length) {
      const d = digits[i] as number;
      out = out + __ykSub(chars, d, d + 1);
      i = i + 1;
    }
  }
  return out;
}`,
  },
  // Number.prototype.toString(radix): radix 10 (or undefined) NumberToString, else a RangeError
  // outside 2..36.
  __ykNumberToStringRadix: {
    inputs: ["number", "unknown"],
    output: "string",
    source: String.raw`export function f(x: number, radix: unknown): string {
  if (__ykTag(radix) === 0) return __ykNumberToString(x);
  const r = __ykToInteger(radix);
  if (r < 2 || r > 36) throw __ykMakeError("RangeError", "toString() radix must be between 2 and 36");
  if (r === 10) return __ykNumberToString(x);
  return __ykNumberToRadix(x, r);
}`,
  },
  // Number.prototype.toFixed(digits), exactly: the integer n nearest x * 10^f (the larger of two),
  // from x's significand and exponent as big integers, written with f fraction digits.
  __ykToFixed: {
    inputs: ["number", "unknown"],
    output: "string",
    source: String.raw`export function f(x0: number, digits: unknown): string {
  const fd = __ykToInteger(digits);
  if (fd < 0 || fd > 100 || fd === Infinity) {
    throw __ykMakeError("RangeError", "toFixed() digits argument must be between 0 and 100");
  }
  if (x0 !== x0) return "NaN";
  if (x0 >= 1e21 || x0 <= -1e21) return __ykNumberToString(x0);
  const negative = x0 < 0;
  // -0 is written as 0, and its bits read without the sign.
  const x = Math.abs(x0);
  const hi = __ykF64Hi(x);
  const lo = __ykF64Lo(x);
  const biased = Math.floor(hi / 1048576);
  let mant = (hi - biased * 1048576) * 4294967296 + lo;
  let e = -1074;
  if (biased > 0) {
    mant = mant + 4503599627370496;
    e = biased - 1075;
  }
  let n = __ykBigFromInt(mant);
  let k = 0;
  while (k < fd) {
    __ykBigMulSmall(n, 10);
    k = k + 1;
  }
  if (e >= 0) __ykBigShl(n, e);
  else {
    const up = __ykBigBit(n, -e - 1);
    n = __ykBigShr(n, -e);
    if (up === 1) n = __ykBigAdd(n, [1]);
  }
  let text = "";
  while (n.length > 0) {
    let rem = 0;
    let i = n.length - 1;
    while (i >= 0) {
      const t = rem * 16777216 + n[i];
      const q = Math.floor(t / 10000000);
      n[i] = q;
      rem = t - q * 10000000;
      i = i - 1;
    }
    while (n.length > 0 && n[n.length - 1] === 0) n.pop();
    let chunk = __ykNumberToString(rem);
    if (n.length > 0) while (chunk.length < 7) chunk = "0" + chunk;
    text = chunk + text;
  }
  if (text.length === 0) text = "0";
  if (fd > 0) {
    while (text.length <= fd) text = "0" + text;
    text = __ykSub(text, 0, text.length - fd) + "." + __ykSub(text, text.length - fd, text.length);
  }
  return negative ? "-" + text : text;
}`,
  },
  // A RangeError: Invalid count value.
  __ykRangeError: {
    inputs: [],
    output: "unknown",
    source: String.raw`export function f(): unknown {
  throw __ykMakeError("RangeError", "Invalid count value");
}`,
  },
  // String.prototype.padStart / padEnd.
  __ykPad: {
    inputs: ["string", "unknown", "unknown", "boolean"],
    output: "string",
    source: String.raw`export function f(s: string, maxLength: unknown, fill: unknown, atStart: boolean): string {
  let max = __ykToInteger(maxLength);
  if (max <= s.length) return s;
  const filler = __ykTag(fill) === 0 ? " " : __ykToString(fill);
  if (filler.length === 0) return s;
  const want = max - s.length;
  let pad = "";
  while (pad.length < want) pad = pad + filler;
  pad = __ykSub(pad, 0, want);
  return atStart ? pad + s : s + pad;
}`,
  },
  // String.prototype.lastIndexOf(search, position).
  __ykLastIndexOf: {
    inputs: ["string", "unknown", "unknown"],
    output: "number",
    source: String.raw`export function f(s: string, search: unknown, position: unknown): number {
  const r = __ykToString(search);
  const num = __ykToNumber(position);
  let pos = num !== num ? Infinity : Math.trunc(num);
  if (pos < 0) pos = 0;
  let start = pos > s.length ? s.length : pos;
  if (start > s.length - r.length) start = s.length - r.length;
  let i = start;
  while (i >= 0) {
    if (__ykStrEquals(__ykSub(s, i, i + r.length), r)) return i;
    i = i - 1;
  }
  return -1;
}`,
  },
  // String.prototype.trimStart / trimEnd (atStart).
  __ykTrimSide: {
    inputs: ["string", "boolean"],
    output: "string",
    source: `export function f(s: string, atStart: boolean): string {
  let from = 0;
  let to = s.length;
  if (atStart) {
    while (from < to && ${isSpace("__ykUnit(s, from)")}) from = from + 1;
  } else {
    while (to > from && ${isSpace("__ykUnit(s, to - 1)")}) to = to - 1;
  }
  return __ykSub(s, from, to);
}`,
  },
  // String.prototype.at(index): a unit, or undefined.
  __ykStrAt: {
    inputs: ["string", "unknown"],
    output: "unknown",
    source: String.raw`export function f(s: string, index: unknown): unknown {
  const rel = __ykToInteger(index);
  const k = rel >= 0 ? rel : s.length + rel;
  if (k < 0 || k >= s.length) return __ykUndef();
  return __ykSub(s, k, k + 1);
}`,
  },
  // GetSubstitution for a string pattern: $$, $&, $\`, $' (no captures: $n is itself).
  __ykSubstitute: {
    inputs: ["string", "string", "number", "string"],
    output: "string",
    source: String.raw`export function f(matched: string, s: string, position: number, rep: string): string {
  let out = "";
  let i = 0;
  while (i < rep.length) {
    const c = __ykUnit(rep, i);
    if (c === 36 && i + 1 < rep.length) {
      const d = __ykUnit(rep, i + 1);
      if (d === 36) {
        out = out + "$";
        i = i + 2;
        continue;
      }
      if (d === 38) {
        out = out + matched;
        i = i + 2;
        continue;
      }
      if (d === 96) {
        out = out + __ykSub(s, 0, position);
        i = i + 2;
        continue;
      }
      if (d === 39) {
        out = out + __ykSub(s, position + matched.length, s.length);
        i = i + 2;
        continue;
      }
    }
    out = out + __ykSub(rep, i, i + 1);
    i = i + 1;
  }
  return out;
}`,
  },
  // String.prototype.replace / replaceAll (all) with a string pattern: the replacement a string
  // (GetSubstitution) or a function value (called with the match, its position and the string).
  __ykReplace: {
    inputs: ["string", "unknown", "unknown", "boolean"],
    output: "string",
    source: String.raw`export function f(s: string, pattern: unknown, replacement: unknown, all: boolean): string {
  const search = __ykToString(pattern);
  const fn = __ykTag(replacement) === 8;
  const rep = fn ? "" : __ykToString(replacement);
  const positions: number[] = [];
  let p = __ykIndexOf(s, search, 0);
  while (p !== -1) {
    positions.push(p);
    if (!all) break;
    const next = p + (search.length === 0 ? 1 : search.length);
    if (next > s.length) break;
    p = __ykIndexOf(s, search, next);
  }
  let out = "";
  let end = 0;
  let i = 0;
  while (i < positions.length) {
    const at = positions[i];
    const piece = fn ? __ykToString(__ykCallWith(replacement, [search, at, s])) : __ykSubstitute(search, s, at, rep);
    out = out + __ykSub(s, end, at) + piece;
    end = at + search.length;
    i = i + 1;
  }
  return out + __ykSub(s, end, s.length);
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
  // x[key] for a value of any kind and a key of any kind: a string's or an array's element at an
  // index (a number, or a string that is one's canonical form), else the property ToPropertyKey
  // names (an object's own, a length).
  __ykGetKey: {
    inputs: ["unknown", "unknown"],
    output: "unknown",
    source: `export function f(x: unknown, key: unknown): unknown {
  const t = __ykTag(x);
  if (t === 0 || t === 1) return __ykTypeError();
  const tk = __ykTag(key);
  const indexed = t === 4 || t === 5 || t === 6;
  if (tk === 3 && indexed) return __ykIndex(x, __ykNum(key));
  const k = tk === 3 ? __ykNumberToString(__ykNum(key)) : __ykToString(key);
  if (indexed) {
    const n = __ykToNumber(k);
    if (__ykStrEquals(__ykNumberToString(n), k)) return __ykIndex(x, n);
  }
  return __ykGetAny(x, k);
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
  // delete o[k]: the property removed, the others in their order.
  __ykObjDelete: {
    inputs: ["YkObject", "string"],
    output: "unknown",
    source: `export function f(o: YkObject, k: string): unknown {
  const keys = __ykObjKeys(o);
  const vals = __ykObjVals(o);
  let i = 0;
  let found = false;
  while (i < keys.length) {
    if (!found && __ykStrEquals(__ykStr(keys[i]), k)) found = true;
    if (found && i + 1 < keys.length) {
      keys[i] = keys[i + 1];
      vals[i] = vals[i + 1];
    }
    i = i + 1;
  }
  if (found) {
    keys.pop();
    vals.pop();
  }
  return __ykUndef();
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
    const c = __ykObjCls(o);
    // A Map or a Set: no own properties; its size.
    if (__ykTag(c) === 4 && (__ykStrEquals(__ykStr(c), "Map") || __ykStrEquals(__ykStr(c), "Set"))) {
      if (__ykStrEquals(k, "size")) return __ykObjKeys(o).length;
      return __ykUndef();
    }
    if (__ykHas(o, k)) return __ykGet(o, k);
    if (__ykIsErrorCls(c)) {
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
  // ToInt32 (ECMA-262 7.1.6) of a number: modulo 2^32, as a signed 32-bit integer; NaN and the
  // infinities are 0. Each step is exact: a power of two divides exactly, and the difference of
  // two integers that is below 2^32 is a double.
  __ykToInt32: {
    inputs: ["number"],
    output: "number",
    source: `export function f(x: number): number {
  const n = Math.trunc(x);
  const m = n - Math.floor(n / 4294967296) * 4294967296;
  if (m !== m) return 0;
  return m >= 2147483648 ? m - 4294967296 : m;
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
    const c = __ykObjCls(o);
    // A Map or a Set has no own properties.
    if (__ykTag(c) === 4 && (__ykStrEquals(__ykStr(c), "Map") || __ykStrEquals(__ykStr(c), "Set")))
      return out;
    const own = __ykOwnKeys(o);
    if (!__ykIsErrorCls(c)) return own;
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
  // A Map's entries, a Set's values (a snapshot).
  if (t === 7) {
    const o = __ykObj(x);
    const c = __ykObjCls(o);
    if (__ykTag(c) === 4 && __ykStrEquals(__ykStr(c), "Map")) return __ykCollList(o, 0);
    if (__ykTag(c) === 4 && __ykStrEquals(__ykStr(c), "Set")) return __ykCollList(o, 1);
  }
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
  if (__ykStrEquals(c, "Error")) return __ykIsErrorCls(cls);
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
  const c = __ykObjCls(o);
  if (__ykTag(c) === 4 && __ykStrEquals(__ykStr(c), "Map")) return "[object Map]";
  if (__ykTag(c) === 4 && __ykStrEquals(__ykStr(c), "Set")) return "[object Set]";
  if (!__ykIsErrorCls(c)) return "[object Object]";
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
