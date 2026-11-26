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

/** The sorts this encoder knows: ECMAScript's Number as binary64, and Boolean. */
export type Sort = "F64" | "Bool";

/** An SMT-LIB2 term with its sort. */
export interface Term {
  readonly sort: Sort;
  readonly smt: string;
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
  return sort === "F64" ? "(_ FloatingPoint 11 53)" : "Bool";
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
  return t.sort === "F64" ? t : { sort: "F64", smt: `(ite ${t.smt} ${ONE.smt} ${ZERO.smt})` };
}

/** ToBoolean: a number is false at ±0 and NaN. */
export function truthy(t: Term): Term {
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

/** A literal by its label: a number or a boolean. */
export function literal(label: string): Term {
  if (label === "true" || label === "false") return { sort: "Bool", smt: label };
  if (NUMBER_LITERAL.test(label)) return f64Literal(Number(label));
  throw new Unsupported("literal", `the literal ${label}`);
}

/** An ECMAScript operator (as `ecmaScriptView` writes it) on encoded operands. */
export function operation(label: string, args: readonly Term[]): Term {
  if (args.length === 2) {
    const [a, b] = args as [Term, Term];
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
