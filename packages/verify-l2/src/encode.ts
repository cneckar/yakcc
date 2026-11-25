// SPDX-License-Identifier: Apache-2.0
/**
 * The encoder: a DUC graph as SMT-LIB2 terms, with ECMAScript's meaning on binary64 numbers and
 * booleans (#1421, slice 1).
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
 *   Nodes inside a branch region are encoded unconditionally. That is sound because every operation
 *   encoded here is total and has no effect; a `sel` picks the value the taken path computes. An
 *   effect (heap-ordered operations, throws), a loop, a closure or a reference is unsupported.
 */
import { type DucGraph, type DucNode, type ValueId, ecmaScriptView } from "@yakcc/duc";

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
function toNumber(t: Term): Term {
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

const BITWISE = new Set([
  "&",
  "|",
  "^",
  "~",
  "<<",
  ">>",
  ">>>",
  "&=",
  "|=",
  "^=",
  "<<=",
  ">>=",
  ">>>=",
]);

/** The platform constants that are numbers. */
const PLATFORM_NUMBERS: Readonly<Record<string, number>> = {
  NaN: Number.NaN,
  Infinity: Number.POSITIVE_INFINITY,
};

const NUMBER_LITERAL = /^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

/** The encoding of one graph: definitions in dependency order, and its one result. */
export interface EncodedGraph {
  /** `(define-fun …)` lines, each value before its uses. */
  readonly defs: readonly string[];
  readonly result: Term;
}

/**
 * Encodes a graph as SMT-LIB2 definitions. `params` are the terms its parameters are bound to, in
 * order. Names are prefixed with `ns` so several graphs share one query. Throws {@link Unsupported}
 * for any construct outside the exact fragment.
 */
export function encodeGraph(input: DucGraph, ns: string, params: readonly Term[]): EncodedGraph {
  const g = ecmaScriptView(input);
  if (g.mode !== undefined) throw new Unsupported(g.mode, `an ${g.mode} function`);
  if (g.obs.length !== 1) {
    throw new Unsupported("observations", `${g.obs.length} observations; one result is required`);
  }
  // An effect anywhere is refused, even one the result does not read: a throw decides whether the
  // atom returns at all, and a write is behavior the contract does not cover (#1421 slice 5).
  for (const n of g.nodes) {
    if (n.order === 1 || n.label === "throw") {
      throw new Unsupported(n.label ?? n.kind, `${n.label ?? n.kind}: an effect`);
    }
    if (n.kind === "loop" || n.kind === "carry-source" || n.closure !== undefined) {
      throw new Unsupported(n.kind, `a ${n.closure !== undefined ? "closure" : n.kind}`);
    }
  }
  const defOf = new Map<ValueId, DucNode>();
  for (const n of g.nodes) for (const v of n.outputs) defOf.set(v, n);
  const terms = new Map<ValueId, Term>();
  const defs: string[] = [];
  const visiting = new Set<ValueId>();

  const encode = (v: ValueId): Term => {
    const done = terms.get(v);
    if (done !== undefined) return done;
    if (visiting.has(v)) throw new Unsupported("cycle", `value ${v} depends on itself`);
    visiting.add(v);
    const n = defOf.get(v);
    if (n === undefined) throw new Unsupported("dangling", `value ${v} has no definition`);
    const term = encodeNode(n);
    visiting.delete(v);
    // Sources are inlined; every computed value gets a name, so the query reads like the graph.
    if (n.kind === "param-source" || n.kind === "literal-source" || n.kind === "diamond-source") {
      terms.set(v, term);
      return term;
    }
    const name = `${ns}_${v}`;
    defs.push(`(define-fun ${name} () ${smtSort(term.sort)} ${term.smt})`);
    const named: Term = { sort: term.sort, smt: name };
    terms.set(v, named);
    return named;
  };

  const encodeNode = (n: DucNode): Term => {
    if (n.order === 1) {
      throw new Unsupported(n.label ?? n.kind, `${n.label ?? n.kind}: a heap-ordered operation`);
    }
    if (n.closure !== undefined) throw new Unsupported("closure", "a closure");
    if (n.outputs.length !== 1) {
      throw new Unsupported(n.kind, `a ${n.kind} node with ${n.outputs.length} outputs`);
    }
    switch (n.kind) {
      case "param-source": {
        const index = Number(n.label);
        const p = Number.isInteger(index) ? params[index] : undefined;
        if (p === undefined) throw new Unsupported("parameter", `parameter ${n.label ?? "?"}`);
        return p;
      }
      case "literal-source":
        return literal(n.label ?? "");
      case "diamond-source": {
        const d = n.diamond;
        const value = d?.reason === "platform-primitive" ? PLATFORM_NUMBERS[d.symbol] : undefined;
        if (value === undefined) {
          throw new Unsupported(
            d?.symbol ?? "reference",
            `a reference to ${d?.symbol ?? "?"} (${d?.reason ?? "unknown"})`,
          );
        }
        return f64Literal(value);
      }
      case "sel": {
        if (n.label !== undefined || n.inputs.length !== 3) {
          throw new Unsupported("sel", `a select labelled ${n.label ?? "?"}`);
        }
        const [c, t, e] = n.inputs.map(encode) as [Term, Term, Term];
        if (t.sort !== e.sort) {
          throw new Unsupported("union", "a select whose two values have different types");
        }
        return { sort: t.sort, smt: `(ite ${truthy(c).smt} ${t.smt} ${e.smt})` };
      }
      case "op":
        return operation(n.label ?? "", n.inputs.map(encode));
      default:
        throw new Unsupported(n.kind, `a ${n.kind} node`);
    }
  };

  const result = encode(g.obs[0] as ValueId);
  return { defs, result };
}

function literal(label: string): Term {
  if (label === "true" || label === "false") return { sort: "Bool", smt: label };
  if (NUMBER_LITERAL.test(label)) return f64Literal(Number(label));
  throw new Unsupported("literal", `the literal ${label}`);
}

function operation(label: string, args: readonly Term[]): Term {
  if (args.length === 2) {
    const [a, b] = args as [Term, Term];
    const arith = ARITHMETIC[label];
    if (arith !== undefined) {
      return { sort: "F64", smt: `(${arith} ${toNumber(a).smt} ${toNumber(b).smt})` };
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
    }
  }
  if (BITWISE.has(label)) {
    throw new Unsupported(label, `the bitwise operation ${label} (ToInt32 is #1421 slice 2)`);
  }
  throw new Unsupported(label, `the operation ${label} on ${args.length} operand(s)`);
}

function sameSortEq(a: Term, b: Term): string {
  return a.sort === "F64" ? `(fp.eq ${a.smt} ${b.smt})` : `(= ${a.smt} ${b.smt})`;
}
