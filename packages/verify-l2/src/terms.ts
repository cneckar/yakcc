// SPDX-License-Identifier: Apache-2.0
/**
 * Terms: ECMAScript's numbers and booleans as SMT-LIB2, and its operators on them (#1421). The
 * graph walk that uses them is `encoder.ts`.
 *
 * @decision DEC-VERIFY-L2-ENCODING-001
 * title: exact or unsupported, never approximated
 * status: decided (#1421)
 * rationale:
 *   A number is an IEEE 754 binary64 term of the solver's FloatingPoint theory, so NaN, both zeros,
 *   both infinities and the subnormals are values, and every operation rounds to nearest, ties to
 *   even, as ECMAScript's Number does. An operation is encoded only where its encoding is
 *   ECMAScript's meaning on every value of the operands' sorts; anything else throws Unsupported,
 *   naming the construct, and the obligation is reported `unsupported`. The model follows Eidic's
 *   verifier (eidic/eidic docs/enhanced-verification.md), which found an unsound `x == x` proof this
 *   way and refuses floating `%`: SMT's fp.rem is the IEEE remainder, ECMAScript's `%` is fmod.
 *
 *   Every operation encoded here is total and has no effect, so a node inside a branch region is
 *   encoded unconditionally; a `sel` picks the value the taken path computes.
 */

/**
 * The sorts this encoder knows: ECMAScript's Number as binary64, Boolean, and String as a sequence
 * of UTF-16 code units (`(Seq (_ BitVec 16))`), which is exactly what ECMAScript says a string is.
 */
export type Sort = "F64" | "Bool" | "Str" | ArraySort;

/**
 * Arrays, read-only, as sequences of their elements: numbers by their 64 bits (so a model gives
 * them exactly), booleans, strings. An array is an object with an identity; nothing here observes
 * it (writes are effects, refused; `===` on arrays is refused).
 */
export type ArraySort = "ArrF64" | "ArrBool" | "ArrStr";

export function isArraySort(sort: Sort): sort is ArraySort {
  return sort === "ArrF64" || sort === "ArrBool" || sort === "ArrStr";
}

/** An array sort's element sort. */
export function elementSort(sort: ArraySort): "F64" | "Bool" | "Str" {
  return sort === "ArrF64" ? "F64" : sort === "ArrBool" ? "Bool" : "Str";
}

/** ECMAScript's maximum array length, 2^32 - 1. */
export const MAX_ARRAY_LENGTH = "4294967295";

/**
 * An SMT-LIB2 term with its sort. A number may carry `int`, an SMT Int whose rounding to binary64
 * is the number, so integer facts (string lengths, indices) stay in integer arithmetic. It is set
 * only where that holds and the number is never -0: integer literals, lengths, `indexOf`, and `+`
 * or `-` of two such numbers (one rounding of the exact result is what IEEE addition does, and
 * neither gives -0 from operands that are not -0). Never for `*` or negation: `0 * -3` is -0.
 */
export interface Term {
  readonly sort: Sort;
  readonly smt: string;
  readonly int?: string;
  /** A bound on |int| known by construction, when there is one. */
  readonly bound?: number;
  /**
   * When present, the value may be `undefined` (an element read past the end, `s[i]`): this Bool
   * says it is not, and `smt` is the value then. Only ECMAScript's own conversions of `undefined`
   * consume it (ToNumber gives NaN, ToString "undefined", ToBoolean false, equality, `??`); any
   * other use is refused.
   */
  readonly defined?: string;
}

/**
 * A record: its fields by name, each a term or a record. It is a value with no identity here:
 * fields are read and records are built, compared field by field never (`===` is refused), and
 * never written (a write is an effect, refused).
 */
export interface Rec {
  readonly sort: "Rec";
  readonly fields: ReadonlyMap<string, Term | Rec>;
}

/** The value of a possibly-undefined term when it is defined. */
export function base(t: Term): Term {
  const { defined: _defined, ...rest } = t;
  return rest;
}

/** ECMAScript's maximum string length, 2^53 - 1 (a longer result throws a RangeError). */
export const MAX_STRING_LENGTH = "9007199254740991";

/**
 * `undefined` as a term: never defined. Every conversion of it is ECMAScript's (ToNumber NaN,
 * ToString "undefined", ToBoolean false), so it can stand anywhere those apply. Its sort is a
 * placeholder, adapted to the other operand's where two values meet (`adapt`).
 */
export const UNDEFINED: Term = {
  sort: "F64",
  smt: "((_ to_fp 11 53) #x7ff8000000000000)",
  defined: "false",
};

/** `t` in `to`'s sort if `t` is the literal undefined (its value is never read). */
export function adapt(t: Term, to: Term): Term {
  return t.defined === "false" ? { sort: to.sort, smt: to.smt, defined: "false" } : t;
}

const TWO_53 = "9007199254740992";

/** A number that is the binary64 rounding of an SMT Int. */
export function intF64(int: string, smt?: string, bound?: number): Term {
  return {
    sort: "F64",
    smt: smt ?? `((_ to_fp 11 53) RNE (to_real ${int}))`,
    int,
    ...(bound !== undefined ? { bound } : {}),
  };
}

/** Whether a number's integer is within ±2^53 by construction, so it is the number exactly. */
function smallInt(t: Term): boolean {
  return t.int !== undefined && t.bound !== undefined && t.bound <= 2 ** 53;
}

function sumBound(a: Term, b: Term): number | undefined {
  return a.bound !== undefined && b.bound !== undefined ? a.bound + b.bound : undefined;
}

/** Whether an Int is within ±2^53, where its binary64 rounding is itself. */
function exactInt(int: string): string {
  return `(and (<= (- ${TWO_53}) ${int}) (<= ${int} ${TWO_53}))`;
}

function smtInt(n: number): string {
  return n < 0 ? `(- ${-n})` : String(n);
}

/** A construct the encoder cannot model exactly. The obligation that needs it is `unsupported`. */
export class Unsupported extends Error {
  constructor(
    /** The construct, as a short name: a label, a node kind, a type. */
    readonly construct: string,
    message: string,
  ) {
    super(message);
    this.name = "Unsupported";
  }
}

/** The SMT-LIB2 sort of a {@link Sort}. */
export function smtSort(sort: Sort): string {
  switch (sort) {
    case "F64":
      return "(_ FloatingPoint 11 53)";
    case "Bool":
      return "Bool";
    case "Str":
      return STR_SORT;
    case "ArrF64":
      return "(Seq (_ BitVec 64))";
    case "ArrBool":
      return "(Seq Bool)";
    case "ArrStr":
      return `(Seq ${STR_SORT})`;
  }
}

export const STR_SORT = "(Seq (_ BitVec 16))";

/** A string literal: its UTF-16 code units, each a 16-bit vector. */
export function strLiteral(value: string): Term {
  if (value.length === 0) return { sort: "Str", smt: `(as seq.empty ${STR_SORT})` };
  const units = Array.from(
    { length: value.length },
    (_, i) => `(seq.unit #x${value.charCodeAt(i).toString(16).padStart(4, "0")})`,
  );
  return {
    sort: "Str",
    smt: units.length === 1 ? (units[0] as string) : `(seq.++ ${units.join(" ")})`,
  };
}

/** The 64 bits of a binary64 number, as 16 lowercase hex digits. */
export function f64Bits(x: number): string {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, x);
  return view.getBigUint64(0).toString(16).padStart(16, "0");
}

/** The binary64 number whose bits are the given 16 hex digits. */
export function f64FromBits(hex: string): number {
  const view = new DataView(new ArrayBuffer(8));
  view.setBigUint64(0, BigInt(`0x${hex}`));
  return view.getFloat64(0);
}

/** An exact binary64 literal: its bit pattern reinterpreted, so no decimal rounding is involved. */
export function f64Literal(x: number): Term {
  return { sort: "F64", smt: `((_ to_fp 11 53) #x${f64Bits(x)})` };
}

const ONE = f64Literal(1);
const ZERO = f64Literal(0);

/** ToNumber, on the sorts encoded here: a boolean is 1 or 0. */
export function toNumber(t: Term): Term {
  if (t.defined !== undefined) {
    return {
      sort: "F64",
      smt: `(ite ${t.defined} ${toNumber(base(t)).smt} ${f64Literal(Number.NaN).smt})`,
    };
  }
  if (isArraySort(t.sort))
    throw new Unsupported("ToNumber(array)", "an array converted to a number");
  if (t.sort === "Str") {
    throw new Unsupported("ToNumber(string)", "a string converted to a number (StringToNumber)");
  }
  return t.sort === "F64" ? t : { sort: "F64", smt: `(ite ${t.smt} ${ONE.smt} ${ZERO.smt})` };
}

/** ToString, on booleans and strings; a number's ToString is not encoded. */
function toStr(t: Term): Term {
  if (t.defined !== undefined) {
    return {
      sort: "Str",
      smt: `(ite ${t.defined} ${toStr(base(t)).smt} ${strLiteral("undefined").smt})`,
    };
  }
  if (t.sort === "Str") return t;
  if (t.sort === "Bool")
    return {
      sort: "Str",
      smt: `(ite ${t.smt} ${strLiteral("true").smt} ${strLiteral("false").smt})`,
    };
  throw new Unsupported("ToString(number)", "a number converted to a string (Number::toString)");
}

/** ToBoolean: a number is false at ±0 and NaN. */
export function truthy(t: Term): Term {
  if (t.defined !== undefined)
    return { sort: "Bool", smt: `(and ${t.defined} ${truthy(base(t)).smt})` };
  if (isArraySort(t.sort)) return { sort: "Bool", smt: "true" }; // an object is truthy
  if (t.sort === "Str") return { sort: "Bool", smt: `(> (seq.len ${t.smt}) 0)` };
  return t.sort === "Bool"
    ? t
    : { sort: "Bool", smt: `(not (or (fp.isZero ${t.smt}) (fp.isNaN ${t.smt})))` };
}

const ARITHMETIC: Readonly<Record<string, string>> = {
  "+": "fp.add RNE",
  "-": "fp.sub RNE",
  "*": "fp.mul RNE",
  "/": "fp.div RNE",
  "+=": "fp.add RNE",
  "-=": "fp.sub RNE",
  "*=": "fp.mul RNE",
  "/=": "fp.div RNE",
};

/** The ordered comparisons: false when either operand is NaN, as ECMAScript's are. */
const RELATIONAL: Readonly<Record<string, string>> = {
  "<": "fp.lt",
  ">": "fp.gt",
  "<=": "fp.leq",
  ">=": "fp.geq",
};

/**
 * ECMAScript's ToInt32, as an SMT-LIB2 function from binary64 to a 32-bit vector (#1421 slice 2).
 *
 * NaN and the infinities give 0. Otherwise the value is truncated, and its integer taken modulo
 * 2^32. A binary64 of magnitude 2^84 or more is a multiple of 2^32 (its unit in the last place is at
 * least 2^32), so it gives 0. Below 2^84 the truncated magnitude converts to an 84-bit unsigned
 * vector exactly, whose low 32 bits, negated for a negative value, are the result. No integer
 * theory and no int2bv: everything stays in floating point and bit vectors.
 */
export const PRELUDE: readonly string[] = [
  "(define-fun yk_toInt32 ((x (_ FloatingPoint 11 53))) (_ BitVec 32)",
  "  (let ((t (fp.roundToIntegral RTZ x)))",
  `    (ite (or (fp.isNaN x) (fp.isInfinite x) (fp.geq (fp.abs t) ${f64LiteralSmt(2 ** 84)})) #x00000000`,
  "      (let ((m ((_ extract 31 0) ((_ fp.to_ubv 84) RTZ (fp.abs t)))))",
  "        (ite (fp.isNegative t) (bvneg m) m)))))",
];

function f64LiteralSmt(x: number): string {
  return `((_ to_fp 11 53) #x${f64Bits(x)})`;
}

/** The binary bitwise operations: the bit-vector operation, whether the result is unsigned. */
const BITWISE: Readonly<Record<string, readonly [string, "int32" | "uint32", boolean]>> = {
  "&": ["bvand", "int32", false],
  "|": ["bvor", "int32", false],
  "^": ["bvxor", "int32", false],
  "<<": ["bvshl", "int32", true],
  ">>": ["bvashr", "int32", true],
  ">>>": ["bvlshr", "uint32", true],
};

/** A 32-bit vector as the binary64 it denotes: exact, as every 32-bit integer is a binary64. */
function fromInt32(bv: string, kind: "int32" | "uint32"): Term {
  const conv = kind === "int32" ? "(_ to_fp 11 53)" : "(_ to_fp_unsigned 11 53)";
  return { sort: "F64", smt: `(${conv} RNE ${bv})` };
}

function toInt32(t: Term): string {
  return `(yk_toInt32 ${toNumber(t).smt})`;
}

/** The platform constants that are numbers. */
export const PLATFORM_NUMBERS: Readonly<Record<string, number>> = {
  NaN: Number.NaN,
  Infinity: Number.POSITIVE_INFINITY,
};

const NUMBER_LITERAL = /^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

/** A literal by its label: a number, a boolean or a string. */
export function literal(label: string): Term {
  if (label === "true" || label === "false") return { sort: "Bool", smt: label };
  if (label.startsWith('"')) return strLiteral(JSON.parse(label) as string);
  if (NUMBER_LITERAL.test(label)) {
    const n = Number(label);
    const lit = f64Literal(n);
    return Number.isSafeInteger(n) && !Object.is(n, -0)
      ? intF64(smtInt(n), lit.smt, Math.abs(n))
      : lit;
  }
  throw new Unsupported("literal", `the literal ${label}`);
}

/** An ECMAScript operator (as `ecmaScriptView` writes it) on encoded operands. */
export function operation(label: string, args: readonly Term[]): Term {
  if (args.some((a) => isArraySort(a.sort)) && !["&&", "||", "??", "!"].includes(label)) {
    throw new Unsupported(label, `${label} on an array (identity and ToPrimitive are not encoded)`);
  }
  if (args.length === 2 && (args[0]?.defined !== undefined || args[1]?.defined !== undefined)) {
    const maybe = maybeUndefined(label, args[0] as Term, args[1] as Term);
    if (maybe !== undefined) return maybe;
  }
  if (args.length === 2) {
    const [a, b] = args as [Term, Term];
    // + is concatenation when either side is a string (after ToPrimitive, a no-op on these sorts).
    if ((label === "+" || label === "+=") && (a.sort === "Str" || b.sort === "Str")) {
      return { sort: "Str", smt: `(seq.++ ${toStr(a).smt} ${toStr(b).smt})` };
    }
    if (RELATIONAL[label] !== undefined && a.sort === "Str" && b.sort === "Str") {
      throw new Unsupported(label, `${label} on two strings (code-unit order is not encoded)`);
    }
    const ia = a.sort === "F64" ? a.int : undefined;
    const ib = b.sort === "F64" ? b.int : undefined;
    if (ia !== undefined && ib !== undefined) {
      const op = { "+": "+", "+=": "+", "-": "-", "-=": "-" }[label];
      if (op !== undefined) return intF64(`(${op} ${ia} ${ib})`, undefined, sumBound(a, b));
      const cmp = { "<": "<", ">": ">", "<=": "<=", ">=": ">=", "===": "=", "==": "=" }[label];
      const neg = { "!==": "=", "!=": "=" }[label];
      const c = cmp ?? neg;
      if (c !== undefined) {
        // Exact while both are within ±2^53; beyond, the binary64 comparison decides.
        const fpOp = { "<": "fp.lt", ">": "fp.gt", "<=": "fp.leq", ">=": "fp.geq", "=": "fp.eq" }[
          c
        ] as string;
        const both = `(and ${exactInt(ia)} ${exactInt(ib)})`;
        const eq =
          smallInt(a) && smallInt(b)
            ? `(${c} ${ia} ${ib})`
            : `(ite ${both} (${c} ${ia} ${ib}) (${fpOp} ${a.smt} ${b.smt}))`;
        return { sort: "Bool", smt: neg !== undefined ? `(not ${eq})` : eq };
      }
    }
    const arith = ARITHMETIC[label];
    if (arith !== undefined) {
      return { sort: "F64", smt: `(${arith} ${toNumber(a).smt} ${toNumber(b).smt})` };
    }
    const bitwise = BITWISE[label.endsWith("=") ? label.slice(0, -1) : label];
    if (bitwise !== undefined) {
      const [op, kind, shift] = bitwise;
      // A shift count is ToUint32 of the right operand, masked to its low five bits.
      const right = shift ? `(bvand ${toInt32(b)} #x0000001f)` : toInt32(b);
      return fromInt32(`(${op} ${toInt32(a)} ${right})`, kind);
    }
    const rel = RELATIONAL[label];
    if (rel !== undefined) {
      return { sort: "Bool", smt: `(${rel} ${toNumber(a).smt} ${toNumber(b).smt})` };
    }
    switch (label) {
      case "===":
      case "!==": {
        const eq = a.sort !== b.sort ? "false" : sameSortEq(a, b);
        return { sort: "Bool", smt: label === "===" ? eq : `(not ${eq})` };
      }
      case "==":
      case "!=": {
        const eq = a.sort === b.sort ? sameSortEq(a, b) : sameSortEq(toNumber(a), toNumber(b));
        return { sort: "Bool", smt: label === "==" ? eq : `(not ${eq})` };
      }
      case "&&":
      case "||": {
        if (a.sort !== b.sort) {
          throw new Unsupported("union", `${label} on a number and a boolean gives either type`);
        }
        const c = truthy(a).smt;
        return {
          sort: a.sort,
          smt: label === "&&" ? `(ite ${c} ${b.smt} ${a.smt})` : `(ite ${c} ${a.smt} ${b.smt})`,
        };
      }
      // A number or a boolean is never null or undefined.
      case "??":
        return a;
      case "%":
      case "%=":
        throw new Unsupported(
          "%",
          "ECMAScript's % is the truncated remainder (C's fmod); SMT's fp.rem is the IEEE remainder",
        );
    }
  }
  if (args.length === 1) {
    const [a] = args as [Term];
    switch (label) {
      case "-":
        return { sort: "F64", smt: `(fp.neg ${toNumber(a).smt})` };
      case "+":
        return toNumber(a);
      case "!":
        return { sort: "Bool", smt: `(not ${truthy(a).smt})` };
      case "~":
        return fromInt32(`(bvnot ${toInt32(a)})`, "int32");
      // ++ and -- (prefix or postfix) are the operand's new value: ToNumeric(x) ± 1.
      case "++":
      case "post++":
        return { sort: "F64", smt: `(fp.add RNE ${toNumber(a).smt} ${ONE.smt})` };
      case "--":
      case "post--":
        return { sort: "F64", smt: `(fp.sub RNE ${toNumber(a).smt} ${ONE.smt})` };
    }
  }
  throw new Unsupported(label, `the operation ${label} on ${args.length} operand(s)`);
}

/**
 * The binary operators whose meaning on `undefined` is encoded here: equality (undefined equals only
 * undefined, strictly or loosely, there being no null), `&&`, `||` and `??`. Every other operator
 * reaches `undefined` through ToNumber or ToString, which handle it. Undefined if not one of these.
 */
function maybeUndefined(label: string, a0: Term, b0: Term): Term | undefined {
  const a = adapt(a0, b0);
  const b = adapt(b0, a0);
  const da = a.defined ?? "true";
  const db = b.defined ?? "true";
  switch (label) {
    case "===":
    case "!==":
    case "==":
    case "!=": {
      const strict = label === "===" || label === "!==";
      const x = base(a);
      const y = base(b);
      const both =
        x.sort === y.sort
          ? sameSortEq(x, y)
          : strict
            ? "false"
            : sameSortEq(toNumber(x), toNumber(y));
      const eq = `(or (and ${da} ${db} ${both}) (and (not ${da}) (not ${db})))`;
      return { sort: "Bool", smt: label === "===" || label === "==" ? eq : `(not ${eq})` };
    }
    case "&&":
    case "||": {
      if (a.sort !== b.sort) throw new Unsupported("union", `${label} on values of two types`);
      const c = truthy(a).smt;
      const [t, e] = label === "&&" ? [b, a] : [a, b];
      const dt = t.defined ?? "true";
      const de = e.defined ?? "true";
      return {
        sort: a.sort,
        smt: `(ite ${c} ${t.smt} ${e.smt})`,
        defined: `(ite ${c} ${dt} ${de})`,
      };
    }
    case "??": {
      if (a.defined === undefined) return a;
      if (a.sort !== b.sort) throw new Unsupported("union", "?? on values of two types");
      return {
        sort: a.sort,
        smt: `(ite ${da} ${a.smt} ${b.smt})`,
        ...(b.defined !== undefined ? { defined: `(or ${da} ${db})` } : {}),
      };
    }
  }
  return undefined;
}

function sameSortEq(a: Term, b: Term): string {
  return a.sort === "F64" ? `(fp.eq ${a.smt} ${b.smt})` : `(= ${a.smt} ${b.smt})`;
}

const NAN = f64Literal(Number.NaN);

/**
 * The `Math` functions whose meaning is exact (IEEE 754 operations or ECMAScript's own rules on NaN
 * and ±0), so their encoding is their meaning on every input. The approximated ones (`sin`, `exp`,
 * `pow`, …) and `round` and `random` are not here.
 */
export const MATH_EXACT: ReadonlySet<string> = new Set([
  "abs",
  "floor",
  "ceil",
  "trunc",
  "sqrt",
  "min",
  "max",
  "sign",
  "fround",
]);

/** A call of an exact `Math` function on encoded arguments (each ToNumber'd, as `Math` does). */
export function mathCall(name: string, args: readonly Term[]): Term {
  const xs = args.map((a) => toNumber(a).smt);
  const x = xs[0] ?? NAN.smt;
  const f = (smt: string): Term => ({ sort: "F64", smt });
  switch (name) {
    case "abs":
      return f(`(fp.abs ${x})`);
    case "floor":
      return f(`(fp.roundToIntegral RTN ${x})`);
    case "ceil":
      return f(`(fp.roundToIntegral RTP ${x})`);
    case "trunc":
      return f(`(fp.roundToIntegral RTZ ${x})`);
    case "sqrt":
      return f(`(fp.sqrt RNE ${x})`);
    case "fround":
      return f(`((_ to_fp 11 53) RNE ((_ to_fp 8 24) RNE ${x}))`);
    case "sign":
      return f(
        `(ite (or (fp.isNaN ${x}) (fp.isZero ${x})) ${x} (ite (fp.isNegative ${x}) ${f64Literal(-1).smt} ${ONE.smt}))`,
      );
    case "min":
    case "max": {
      // Integers (no NaN, no -0): an integer minimum or maximum.
      const ints = args.map((a) => (a.sort === "F64" ? a.int : undefined));
      if (ints.length > 0 && ints.every((i) => i !== undefined)) {
        const op = name === "min" ? "<=" : ">=";
        const bounds = args.map((a) => a.bound);
        return intF64(
          (ints as string[]).reduce((acc, i) => `(ite (${op} ${acc} ${i}) ${acc} ${i})`),
          undefined,
          bounds.every((b) => b !== undefined) ? Math.max(...(bounds as number[])) : undefined,
        );
      }
      // Math.min() is +Infinity, Math.max() is -Infinity; NaN wins; -0 is below +0.
      const empty = f64Literal(
        name === "min" ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY,
      );
      const pick = (a: string, b: string): string =>
        name === "min"
          ? `(ite (or (fp.isNaN ${a}) (fp.isNaN ${b})) ${NAN.smt} (ite (fp.lt ${a} ${b}) ${a} (ite (fp.lt ${b} ${a}) ${b} (ite (fp.isNegative ${a}) ${a} ${b}))))`
          : `(ite (or (fp.isNaN ${a}) (fp.isNaN ${b})) ${NAN.smt} (ite (fp.gt ${a} ${b}) ${a} (ite (fp.gt ${b} ${a}) ${b} (ite (fp.isNegative ${a}) ${b} ${a}))))`;
      return f(xs.reduce((acc, a) => pick(acc, a), empty.smt));
    }
  }
  throw new Unsupported(`Math.${name}`, `Math.${name}: not an exact operation`);
}

/**
 * ToIntegerOrInfinity(x) as an SMT Int, for an index into a string of length `len`: NaN is 0, and
 * an infinity, which no Int holds, is `neg` or `pos` (callers pick values that mean "before the
 * start" or "past the end"). A finite value truncates exactly (fp.to_real of an integral value).
 */
function toIndex(x: Term, neg: string, pos: string): string {
  const n = toNumber(x).smt;
  const viaFp = `(ite (fp.isNaN ${n}) 0 (ite (fp.isInfinite ${n}) (ite (fp.isNegative ${n}) ${neg} ${pos}) (to_int (fp.to_real (fp.roundToIntegral RTZ ${n})))))`;
  // An index with an integer is that integer, even beyond ±2^53 where the number is its rounding:
  // a string is at most 2^53 - 1 units long and rounding is monotone, so the rounded index is beyond
  // ±2^53 too, and every caller clamps or refuses both alike (they are compared only with 0 and a
  // length).
  if (x.sort === "F64" && x.int !== undefined) return x.int;
  return `(ite (fp.isNaN ${n}) 0 (ite (fp.isInfinite ${n}) (ite (fp.isNegative ${n}) ${neg} ${pos}) (to_int (fp.to_real (fp.roundToIntegral RTZ ${n})))))`;
}

/** The string members whose meaning is encoded: `length` and these methods. */
export const STRING_METHODS: ReadonlySet<string> = new Set([
  "charCodeAt",
  "charAt",
  "slice",
  "substring",
  "startsWith",
  "endsWith",
  "includes",
  "indexOf",
]);

/** A string's `length`. */
export function strLength(s: Term): Term {
  return intF64(`(seq.len ${s.smt})`, undefined, Number.MAX_SAFE_INTEGER);
}

/**
 * A call of a string method on encoded arguments, as ECMAScript defines it for code units. Only the
 * argument forms whose meaning is exact here are accepted: the search methods without a position,
 * and their search string a string (ECMAScript would ToString any other value).
 */
export function stringMethod(name: string, s: Term, args: readonly Term[]): Term {
  const len = `(seq.len ${s.smt})`;
  const bad = (why: string): never => {
    throw new Unsupported(`String.prototype.${name}`, `${name}: ${why}`);
  };
  const arg = (i: number): Term | undefined => args[i];
  switch (name) {
    case "charCodeAt":
    case "charAt": {
      if (args.length > 1) bad("more than one argument");
      const k = arg(0) === undefined ? "0" : toIndex(arg(0) as Term, "(- 1)", len);
      if (name === "charAt") return { sort: "Str", smt: `(seq.at ${s.smt} ${k})` };
      return {
        sort: "F64",
        smt: `(ite (and (<= 0 ${k}) (< ${k} ${len})) ((_ to_fp_unsigned 11 53) RNE (seq.nth ${s.smt} ${k})) ${f64Literal(Number.NaN).smt})`,
      };
    }
    case "slice":
      if (args.length > 2) bad("more than two arguments");
      return { sort: "Str", smt: seqSlice(s.smt, args, `(as seq.empty ${STR_SORT})`) };
    case "substring": {
      if (args.length > 2) bad("more than two arguments");
      const clamp = (t: Term | undefined, dflt: string): string => {
        if (t === undefined) return dflt;
        const k = toIndex(t, "0", len);
        return `(let ((k ${k})) (ite (< k 0) 0 (ite (< k ${len}) k ${len})))`;
      };
      return {
        sort: "Str",
        smt: `(let ((a ${clamp(arg(0), "0")}) (b ${clamp(arg(1), len)})) (ite (<= a b) (seq.extract ${s.smt} a (- b a)) (seq.extract ${s.smt} b (- a b))))`,
      };
    }
    case "startsWith":
    case "endsWith":
    case "includes":
    case "indexOf": {
      if (args.length !== 1) bad("a position argument is not encoded");
      const t = arg(0) as Term;
      if (t.sort !== "Str") bad("a search value that is not a string");
      if (name === "startsWith") return { sort: "Bool", smt: `(seq.prefixof ${t.smt} ${s.smt})` };
      if (name === "endsWith") return { sort: "Bool", smt: `(seq.suffixof ${t.smt} ${s.smt})` };
      if (name === "includes") return { sort: "Bool", smt: `(seq.contains ${s.smt} ${t.smt})` };
      return {
        sort: "F64",
        smt: `(let ((i (seq.indexof ${s.smt} ${t.smt} 0))) (ite (< i 0) ${f64Literal(-1).smt} ((_ to_fp 11 53) RNE (to_real i))))`,
        // seq.indexof is -1 when absent, as indexOf is.
        int: `(seq.indexof ${s.smt} ${t.smt} 0)`,
        bound: Number.MAX_SAFE_INTEGER,
      };
    }
  }
  return bad("not encoded");
}

/** A template literal: its cooked parts around its substitutions, each ToString'd. */
export function template(label: string, values: readonly Term[]): Term {
  let parts: unknown;
  try {
    parts = JSON.parse(label.slice("template:".length));
  } catch {
    throw new Unsupported("template", `the template ${label}`);
  }
  if (
    !Array.isArray(parts) ||
    parts.length !== values.length + 1 ||
    parts.some((p) => typeof p !== "string")
  ) {
    throw new Unsupported("template", `the template ${label}`);
  }
  const pieces: string[] = [];
  parts.forEach((p: string, i) => {
    if (p.length > 0) pieces.push(strLiteral(p).smt);
    const v = values[i];
    if (v !== undefined) pieces.push(toStr(v).smt);
  });
  if (pieces.length === 0) return strLiteral("");
  return {
    sort: "Str",
    smt: pieces.length === 1 ? (pieces[0] as string) : `(seq.++ ${pieces.join(" ")})`,
  };
}

/** `slice(a, b)` of a sequence: relative indices (from the end when negative), clamped to [0, len]. */
function seqSlice(seq: string, args: readonly Term[], empty: string): string {
  const len = `(seq.len ${seq})`;
  const rel = (t: Term | undefined, dflt: string): string => {
    if (t === undefined) return dflt;
    const k = toIndex(t, `(- ${len})`, len);
    return `(let ((k ${k})) (ite (< k 0) (ite (< (+ ${len} k) 0) 0 (+ ${len} k)) (ite (< k ${len}) k ${len})))`;
  };
  return `(let ((f ${rel(args[0], "0")}) (e ${rel(args[1], len)})) (ite (< f e) (seq.extract ${seq} f (- e f)) ${empty}))`;
}

/**
 * A property key from a number, for `s[i]` and `xs[i]`: the integer it is (CanonicalNumericIndexString:
 * -0 is "0", 1.5 and NaN are not integer keys) and whether it is one inside [0, len).
 */
function integerKey(idx: Term, len: string): { k: string; valid: string } {
  if (idx.sort !== "F64" || idx.defined !== undefined) {
    throw new Unsupported("ElementAccess", "an element read whose key is not a number");
  }
  if (idx.int !== undefined)
    return { k: idx.int, valid: `(and (<= 0 ${idx.int}) (< ${idx.int} ${len}))` };
  const n = idx.smt;
  const k = `(to_int (fp.to_real ${n}))`;
  return {
    k,
    valid: `(and (not (fp.isNaN ${n})) (not (fp.isInfinite ${n})) (fp.eq (fp.roundToIntegral RTZ ${n}) ${n}) (<= 0 ${k}) (< ${k} ${len}))`,
  };
}

/** `target[index]`: a string's code unit as a string, or an array's element; undefined past the end. */
export function elementAccess(target: Term, index: Term): Term {
  if (target.defined !== undefined) {
    throw new Unsupported(
      "ElementAccess",
      "an element read of a value that may be undefined (a TypeError)",
    );
  }
  const len = `(seq.len ${target.smt})`;
  const { k, valid } = integerKey(index, len);
  switch (target.sort) {
    case "Str":
      return { sort: "Str", smt: `(seq.at ${target.smt} ${k})`, defined: valid };
    case "ArrF64":
      return { sort: "F64", smt: `((_ to_fp 11 53) (seq.nth ${target.smt} ${k}))`, defined: valid };
    case "ArrBool":
    case "ArrStr":
      return {
        sort: elementSort(target.sort),
        smt: `(seq.nth ${target.smt} ${k})`,
        defined: valid,
      };
  }
  throw new Unsupported("ElementAccess", `an element read of a ${target.sort} value`);
}

/** An array literal of numbers, booleans or strings (no holes, spreads or undefined elements). */
export function arrayLiteral(elements: readonly Term[]): Term {
  const first = elements[0];
  if (first === undefined)
    throw new Unsupported("ArrayLiteral", "an empty array literal (its element type is not known)");
  if (
    elements.some((e) => e.sort !== first.sort || e.defined !== undefined || isArraySort(e.sort))
  ) {
    throw new Unsupported(
      "ArrayLiteral",
      "an array literal whose elements are not all numbers, booleans or strings",
    );
  }
  const sort: ArraySort =
    first.sort === "F64" ? "ArrF64" : first.sort === "Bool" ? "ArrBool" : "ArrStr";
  const units = elements.map(
    (e) => `(seq.unit ${e.sort === "F64" ? `(fp.to_ieee_bv ${e.smt})` : e.smt})`,
  );
  return { sort, smt: units.length === 1 ? (units[0] as string) : `(seq.++ ${units.join(" ")})` };
}

/** An array's `length`. */
export function arrayLength(xs: Term): Term {
  return intF64(`(seq.len ${xs.smt})`, undefined, Number(MAX_ARRAY_LENGTH));
}

/** The array methods whose meaning is encoded. */
export const ARRAY_METHODS: ReadonlySet<string> = new Set([
  "slice",
  "concat",
  "includes",
  "indexOf",
]);

/**
 * A call of an array method. `includes` and `indexOf` only on arrays of strings or booleans: on
 * numbers `includes` finds NaN and `indexOf` does not, and both find -0 for 0, where sequence
 * equality is structural; neither is that.
 */
export function arrayMethod(name: string, xs: Term, args: readonly Term[]): Term {
  if (!isArraySort(xs.sort)) throw new Unsupported(name, `${name} on a ${xs.sort} value`);
  const bad = (why: string): never => {
    throw new Unsupported(`Array.prototype.${name}`, `${name}: ${why}`);
  };
  const empty = `(as seq.empty ${smtSort(xs.sort)})`;
  switch (name) {
    case "slice":
      if (args.length > 2) bad("more than two arguments");
      return { sort: xs.sort, smt: seqSlice(xs.smt, args, empty) };
    case "concat": {
      if (args.some((a) => a.sort !== xs.sort || a.defined !== undefined))
        bad("an argument that is not an array of the same type");
      return {
        sort: xs.sort,
        smt: args.length === 0 ? xs.smt : `(seq.++ ${xs.smt} ${args.map((a) => a.smt).join(" ")})`,
      };
    }
    case "includes":
    case "indexOf": {
      if (xs.sort === "ArrF64")
        bad("on numbers (SameValueZero and strict equality are not sequence equality)");
      const v = args[0];
      if (args.length !== 1 || v === undefined) bad("a position argument is not encoded");
      const needle = v as Term;
      if (needle.sort !== elementSort(xs.sort) || needle.defined !== undefined)
        bad("a search value of another type");
      const unit = `(seq.unit ${needle.smt})`;
      if (name === "includes") return { sort: "Bool", smt: `(seq.contains ${xs.smt} ${unit})` };
      return {
        sort: "F64",
        smt: `(let ((i (seq.indexof ${xs.smt} ${unit} 0))) (ite (< i 0) ${f64Literal(-1).smt} ((_ to_fp 11 53) RNE (to_real i))))`,
        int: `(seq.indexof ${xs.smt} ${unit} 0)`,
        bound: Number(MAX_ARRAY_LENGTH),
      };
    }
  }
  return bad("not encoded");
}

/**
 * True lemmas of `seq.indexof seq needle 0` (= i), which Z3 does not find alone: i is non-negative
 * exactly when seq contains needle, and then needle is there, inside seq.
 */
export function indexOfLemma(seq: string, needle: string, i: string): string {
  return `(let ((i ${i})) (and (= (>= i 0) (seq.contains ${seq} ${needle})) (=> (>= i 0) (and (<= (+ i (seq.len ${needle})) (seq.len ${seq})) (= (seq.extract ${seq} i (seq.len ${needle})) ${needle})))))`;
}
