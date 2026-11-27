import { ts } from "ts-morph";
import { operationReference } from "./operations.js";
import { ecmaScriptView } from "./ops.js";
import { loweringView } from "./ordering.js";
// SPDX-License-Identifier: Apache-2.0
/**
 * Types over a DUC graph (#1277, decision T1). The graph stays type-free: its interface types come
 * from the contract (`SpecYak` inputs and outputs, in the strict TypeScript-subset type language),
 * and the types inside it are inferred, per target, by this pass.
 *
 * The contract's type language adds `integer` and `float` to TypeScript's: both are `number` in
 * TypeScript, and a target that tells them apart reads them as written. A plain `number` there is
 * ambiguous, as is an array with no element to say its type: the lowering reports such a value,
 * with a reason, rather than guessing.
 *
 * Inference runs forward from the parameters and literals, through operations, selects, branches
 * (whose joins are selects), loops (to a fixpoint over the carried values) and closures (inferred at
 * each call, from the types of the captures and arguments).
 */
import { isRestParam, paramIndex } from "./params.js";
import type { DucGraph, DucLoop, DucNode, ValueId } from "./types.js";

export type NumberKind = "integer" | "float" | "number";

export type DucType =
  | { readonly k: "num"; readonly n: NumberKind }
  | { readonly k: "string" }
  | { readonly k: "boolean" }
  | { readonly k: "bigint" }
  | { readonly k: "null" }
  | { readonly k: "undefined" }
  | { readonly k: "void" }
  | { readonly k: "array"; readonly of: DucType | undefined }
  | { readonly k: "tuple"; readonly items: readonly DucType[] }
  | { readonly k: "object"; readonly fields: Readonly<Record<string, DucType>> }
  | {
      readonly k: "fn";
      readonly params: readonly DucType[];
      readonly result: DucType;
      readonly closure?: ClosureType;
    }
  | { readonly k: "union"; readonly of: readonly DucType[] }
  | { readonly k: "named"; readonly name: string; readonly args: readonly DucType[] }
  | { readonly k: "unknown" };

/** A closure's graph and the types of its captures: its result is inferred at each call. */
interface ClosureType {
  readonly graph: DucGraph;
  readonly captures: readonly DucType[];
}

const NUM = (n: NumberKind): DucType => ({ k: "num", n });
const STRING: DucType = { k: "string" };
const BOOLEAN: DucType = { k: "boolean" };
const UNKNOWN: DucType = { k: "unknown" };
const UNDEFINED: DucType = { k: "undefined" };

// ---------------------------------------------------------------------------
// The contract's type language
// ---------------------------------------------------------------------------

/** Parse a contract type (TypeScript-subset syntax, plus `integer` and `float`). */
export function parseType(text: string): DucType {
  const sf = ts.createSourceFile("t.ts", `type T = ${text};`, ts.ScriptTarget.Latest, true);
  const alias = sf.statements[0];
  if (alias === undefined || !ts.isTypeAliasDeclaration(alias)) return UNKNOWN;
  return fromTypeNode(alias.type);
}

function fromTypeNode(node: ts.TypeNode): DucType {
  switch (node.kind) {
    case ts.SyntaxKind.NumberKeyword:
      return NUM("number");
    case ts.SyntaxKind.StringKeyword:
      return STRING;
    case ts.SyntaxKind.BooleanKeyword:
      return BOOLEAN;
    case ts.SyntaxKind.BigIntKeyword:
      return { k: "bigint" };
    case ts.SyntaxKind.UndefinedKeyword:
      return UNDEFINED;
    case ts.SyntaxKind.VoidKeyword:
      return { k: "void" };
    case ts.SyntaxKind.UnknownKeyword:
    case ts.SyntaxKind.AnyKeyword:
      return UNKNOWN;
  }
  if (ts.isParenthesizedTypeNode(node)) return fromTypeNode(node.type);
  if (ts.isTypeOperatorNode(node)) return fromTypeNode(node.type); // readonly T[]
  if (ts.isLiteralTypeNode(node)) {
    if (node.literal.kind === ts.SyntaxKind.NullKeyword) return { k: "null" };
    if (ts.isStringLiteral(node.literal)) return STRING;
    if (ts.isNumericLiteral(node.literal))
      return NUM(/^\d+$/.test(node.literal.text) ? "integer" : "float");
    if (
      node.literal.kind === ts.SyntaxKind.TrueKeyword ||
      node.literal.kind === ts.SyntaxKind.FalseKeyword
    )
      return BOOLEAN;
    return UNKNOWN;
  }
  if (ts.isArrayTypeNode(node)) return { k: "array", of: fromTypeNode(node.elementType) };
  if (ts.isTupleTypeNode(node))
    return {
      k: "tuple",
      items: node.elements.map((e) => fromTypeNode(ts.isNamedTupleMember(e) ? e.type : e)),
    };
  if (ts.isUnionTypeNode(node)) return union(node.types.map(fromTypeNode));
  if (ts.isTypeLiteralNode(node)) {
    const fields: Record<string, DucType> = {};
    for (const m of node.members) {
      if (
        ts.isPropertySignature(m) &&
        m.type !== undefined &&
        (ts.isIdentifier(m.name) || ts.isStringLiteral(m.name))
      ) {
        const t = fromTypeNode(m.type);
        fields[m.name.text] = m.questionToken !== undefined ? union([t, UNDEFINED]) : t;
      }
    }
    return { k: "object", fields };
  }
  if (ts.isFunctionTypeNode(node)) {
    return {
      k: "fn",
      params: node.parameters.map((p) => (p.type !== undefined ? fromTypeNode(p.type) : UNKNOWN)),
      result: fromTypeNode(node.type),
    };
  }
  if (ts.isTypeReferenceNode(node)) {
    const name = node.typeName.getText();
    const args = (node.typeArguments ?? []).map(fromTypeNode);
    if (name === "integer") return NUM("integer");
    if (name === "float") return NUM("float");
    if ((name === "Array" || name === "ReadonlyArray") && args.length === 1)
      return { k: "array", of: args[0] };
    return { k: "named", name, args };
  }
  return UNKNOWN;
}

/** A type as TypeScript writes it (`integer` and `float` are `number`). */
export function typeToTypeScript(t: DucType): string {
  switch (t.k) {
    case "num":
      return "number";
    case "string":
    case "boolean":
    case "bigint":
    case "null":
    case "undefined":
    case "void":
    case "unknown":
      return t.k;
    case "array":
      return t.of === undefined ? "unknown[]" : `${wrap(t.of)}[]`;
    case "tuple":
      return `[${t.items.map(typeToTypeScript).join(", ")}]`;
    case "object":
      return `{ ${Object.entries(t.fields)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(
          ([k, v]) =>
            `${/^[A-Za-z_$][\w$]*$/.test(k) ? k : JSON.stringify(k)}: ${typeToTypeScript(v)}`,
        )
        .join("; ")} }`;
    case "fn":
      return `(${t.params.map((p, i) => `a${i}: ${typeToTypeScript(p)}`).join(", ")}) => ${typeToTypeScript(t.result)}`;
    case "union":
      return t.of.map(wrap).sort().join(" | ");
    case "named":
      return t.args.length > 0 ? `${t.name}<${t.args.map(typeToTypeScript).join(", ")}>` : t.name;
  }
}

const wrap = (t: DucType): string =>
  t.k === "union" || t.k === "fn" ? `(${typeToTypeScript(t)})` : typeToTypeScript(t);

/** A type as the contract's language writes it, keeping integer and float. */
export function typeToText(t: DucType): string {
  if (t.k === "num") return t.n;
  if (t.k === "array")
    return t.of === undefined
      ? "unknown[]"
      : `${t.of.k === "union" ? `(${typeToText(t.of)})` : typeToText(t.of)}[]`;
  if (t.k === "union") return t.of.map(typeToText).join(" | ");
  return typeToTypeScript(t);
}

// ---------------------------------------------------------------------------
// The lattice
// ---------------------------------------------------------------------------

/** The union of types, flattened, without repeats; integer with float is number. */
export function union(types: readonly DucType[]): DucType {
  const flat: DucType[] = [];
  for (const t of types) {
    if (t.k === "union") flat.push(...t.of);
    else flat.push(t);
  }
  if (flat.some((t) => t.k === "unknown")) return UNKNOWN;
  const out: DucType[] = [];
  for (const t of flat) {
    if (t.k === "num") {
      const at = out.findIndex((o) => o.k === "num");
      if (at !== -1) {
        const prev = out[at] as { k: "num"; n: NumberKind };
        out[at] = NUM(prev.n === t.n ? t.n : "number");
        continue;
      }
    }
    if (t.k === "array") {
      const at = out.findIndex((o) => o.k === "array");
      if (at !== -1) {
        const prev = out[at] as { k: "array"; of: DucType | undefined };
        const of =
          prev.of === undefined ? t.of : t.of === undefined ? prev.of : union([prev.of, t.of]);
        out[at] = { k: "array", of };
        continue;
      }
    }
    if (!out.some((o) => sameType(o, t))) out.push(t);
  }
  return out.length === 1 ? (out[0] as DucType) : { k: "union", of: out };
}

export function sameType(a: DucType, b: DucType): boolean {
  return typeToText(a) === typeToText(b);
}

const isNum = (t: DucType): t is { k: "num"; n: NumberKind } => t.k === "num";
const isString = (t: DucType): boolean => t.k === "string";

// ---------------------------------------------------------------------------
// Inference
// ---------------------------------------------------------------------------

export interface Signature {
  /** The contract's input types, in parameter order. */
  readonly inputs: readonly DucType[];
  /** The contract's output type, when it has one. */
  readonly output?: DucType;
}

export interface Ambiguity {
  readonly value: ValueId;
  readonly reason: string;
}

export interface TypeReport {
  /** The type of every value of the graph (its closures' values are inferred per call). */
  readonly types: ReadonlyMap<ValueId, DucType>;
  /** The type of each observation, in order. */
  readonly results: readonly DucType[];
  /** Values whose type a target that tells numbers apart, or needs an element type, cannot know. */
  readonly ambiguities: readonly Ambiguity[];
  /** Where the inferred result does not fit the contract's output type. */
  readonly mismatches: readonly string[];
}

/** Integer-valued members of known primitives and methods. */
const INTEGER_METHODS = new Set([
  "indexOf",
  "lastIndexOf",
  "charCodeAt",
  "codePointAt",
  "findIndex",
  "findLastIndex",
  "push",
  "unshift",
  "localeCompare",
  "search",
]);
const STRING_METHODS = new Set([
  "trim",
  "trimStart",
  "trimEnd",
  "toUpperCase",
  "toLowerCase",
  "toLocaleUpperCase",
  "toLocaleLowerCase",
  "slice",
  "substring",
  "substr",
  "padStart",
  "padEnd",
  "repeat",
  "replace",
  "replaceAll",
  "charAt",
  "concat",
  "normalize",
  "toString",
  "toFixed",
  "toPrecision",
  "join",
  "at",
]);
const BOOLEAN_METHODS = new Set([
  "includes",
  "startsWith",
  "endsWith",
  "test",
  "every",
  "some",
  "has",
  "isArray",
  "isInteger",
  "isFinite",
  "isNaN",
  "isSafeInteger",
]);
const MATH_INTEGER = new Set(["floor", "ceil", "round", "trunc", "sign", "clz32", "imul"]);

/** Infer the types of a graph's values from the contract's signature. */
export function inferTypes(input: DucGraph, sig: Signature): TypeReport {
  // The rules below read ECMAScript's operators; every operation is one of their cases (#1310).
  const g = ecmaScriptView(input);
  const types = new Map<ValueId, DucType>();
  const ambiguities: Ambiguity[] = [];
  const results = inferGraph(g, sig.inputs, types, ambiguities, 0);
  const mismatches: string[] = [];
  const declared = sig.output;
  if (declared !== undefined) {
    const got = results[0] ?? UNDEFINED;
    if (!assignable(got, declared))
      mismatches.push(
        `the result is ${typeToText(got)}, and the contract says ${typeToText(declared)}`,
      );
  }
  return { types, results, ambiguities, mismatches };
}

/** Whether a value of type `a` fits where `b` is declared (structural, and loose where unsure). */
export function assignable(a: DucType, b: DucType): boolean {
  if (b.k === "unknown" || a.k === "unknown") return true;
  if (a.k === "union") return a.of.every((x) => assignable(x, b));
  if (b.k === "union") return b.of.some((x) => assignable(a, x));
  if (a.k === "num" && b.k === "num") return b.n === "number" || a.n === b.n || a.n === "number";
  if ((a.k === "undefined" || a.k === "void") && (b.k === "void" || b.k === "undefined"))
    return true;
  if (a.k === "array" && b.k === "array")
    return a.of === undefined || b.of === undefined || assignable(a.of, b.of);
  if (a.k === "tuple" && b.k === "array")
    return b.of === undefined || a.items.every((x) => assignable(x, b.of as DucType));
  if (a.k === "tuple" && b.k === "tuple")
    return (
      a.items.length === b.items.length &&
      a.items.every((x, i) => assignable(x, b.items[i] as DucType))
    );
  if (a.k === "object" && b.k === "object")
    return Object.entries(b.fields).every(([k, t]) =>
      a.fields[k] !== undefined ? assignable(a.fields[k], t) : assignable(UNDEFINED, t),
    );
  if (a.k === "fn" && b.k === "fn") return true;
  if (b.k === "named" || a.k === "named")
    return a.k === b.k && (a as { name: string }).name === (b as { name: string }).name;
  return a.k === b.k;
}

function inferGraph(
  source: DucGraph,
  inputs: readonly DucType[],
  types: Map<ValueId, DucType>,
  ambiguities: Ambiguity[],
  depth: number,
): DucType[] {
  // The heap token orders operations and has no type (#1285).
  const g = loweringView(source).graph;
  const producer = new Map<ValueId, DucNode>();
  for (const n of g.nodes) for (const v of n.outputs) producer.set(v, n);
  const typeOf = (v: ValueId): DucType => types.get(v) ?? UNKNOWN;
  const loopOf = new Map<
    ValueId,
    { node: DucNode; loop: DucLoop; index: number; role: "carry" | "invariant" | "element" }
  >();
  for (const n of g.nodes) {
    const loop = n.loop;
    if (loop === undefined) continue;
    loop.carry.forEach((v, i) => loopOf.set(v, { node: n, loop, index: i, role: "carry" }));
    loop.invariant.forEach((v, i) => loopOf.set(v, { node: n, loop, index: i, role: "invariant" }));
    if (loop.iterate !== undefined)
      loopOf.set(loop.iterate.element, { node: n, loop, index: 0, role: "element" });
  }

  let widening = false;
  const compute = (n: DucNode): DucType[] => {
    const at = (i: number): DucType => typeOf(n.inputs[i] as ValueId);
    switch (n.kind) {
      case "param-source":
        return [inputs[paramIndex(n.label)] ?? UNKNOWN];
      case "literal-source":
        return [literalType(n.label ?? "")];
      case "diamond-source":
        return [n.diamond?.symbol !== undefined ? ambientType(n.diamond.symbol) : UNKNOWN];
      case "sel":
        return [union([at(1), at(2)])];
      case "carry-source": {
        const info = loopOf.get(n.outputs[0] as ValueId);
        if (info === undefined) return [UNKNOWN];
        const offset = info.loop.carry.length + (info.loop.iterate !== undefined ? 1 : 0);
        if (info.role === "invariant")
          return [typeOf(info.node.inputs[offset + info.index] as ValueId)];
        if (info.role === "element") {
          const of = typeOf(info.node.inputs[info.loop.carry.length] as ValueId);
          if (info.loop.iterate?.of === "keys") return [STRING];
          return [elementOf(of)];
        }
        // A carried value: its start, widened by its next values (the loop's fixpoint below), once
        // the starts are settled.
        const start = typeOf(info.node.inputs[info.index] as ValueId);
        const next = widening ? types.get(info.loop.next[info.index] as ValueId) : undefined;
        return [next !== undefined ? union([start, next]) : start];
      }
      case "loop":
        return n.outputs.map((_, i) =>
          widening ? union([at(i), typeOf((n.loop as DucLoop).next[i] as ValueId)]) : at(i),
        );
      case "op":
        return [opType(n, at, depth, ambiguities)];
    }
  };

  // Forward over the nodes, in dependency order, repeating until the loops' carried types are stable.
  // A loop's sources come after what the loop takes from outside.
  const extra = new Map<DucNode, ValueId[]>();
  for (const [v, info] of loopOf) {
    const src = producer.get(v);
    if (src !== undefined) extra.set(src, [...info.node.inputs]);
  }
  const sequence = order(g, producer, extra);
  // The fixpoint ascends from nothing known (#1370): a node is typed once its inputs are, a carry once
  // its start is, so a value not yet typed is never read as unknown, which no union narrows again
  // (a carry read before its next value, in an order the heap's edges chose, kept unknown for good).
  const typed = (v: ValueId | undefined): boolean =>
    v === undefined || types.has(v) || !producer.has(v);
  const ready = (n: DucNode): boolean => {
    if (n.kind === "carry-source") {
      const info = loopOf.get(n.outputs[0] as ValueId);
      if (info === undefined) return true;
      const offset = info.loop.carry.length + (info.loop.iterate !== undefined ? 1 : 0);
      return typed(
        info.node.inputs[
          info.role === "carry"
            ? info.index
            : info.role === "invariant"
              ? offset + info.index
              : info.loop.carry.length
        ],
      );
    }
    if (n.kind === "loop") return n.inputs.every(typed);
    return n.inputs.every(typed);
  };
  // Two phases (#1370): every carry at its start, until the types settle (no value reads a loop's next
  // values, so no unknown read early is carried on); then the carries widened by their next values.
  for (const phase of [false, true]) {
    widening = phase;
    for (let round = 0; round < MAX_ROUNDS; round++) {
      let changed = false;
      for (const n of sequence) {
        if (!ready(n)) continue;
        const outs = compute(n);
        n.outputs.forEach((v, i) => {
          const t = outs[i] ?? UNKNOWN;
          const prev = types.get(v);
          if (prev === undefined || !sameType(prev, t)) {
            types.set(v, t);
            changed = true;
          }
        });
      }
      if (!changed) break;
    }
  }

  if (depth === 0) {
    for (const [v, t] of types) {
      if (hasPlainNumber(t))
        ambiguities.push({ value: v, reason: `${typeToText(t)}: integer or float is not known` });
      if (hasEmptyArray(t))
        ambiguities.push({ value: v, reason: "an array with no element to say its element type" });
    }
  }
  return g.obs.map((v) => typeOf(v));
}

function hasPlainNumber(t: DucType): boolean {
  if (t.k === "num") return t.n === "number";
  if (t.k === "union") return t.of.some(hasPlainNumber);
  if (t.k === "array") return t.of !== undefined && hasPlainNumber(t.of);
  if (t.k === "tuple") return t.items.some(hasPlainNumber);
  if (t.k === "object") return Object.values(t.fields).some(hasPlainNumber);
  return false;
}

function hasEmptyArray(t: DucType): boolean {
  if (t.k === "array") return t.of === undefined || hasEmptyArray(t.of);
  if (t.k === "union") return t.of.some(hasEmptyArray);
  if (t.k === "object") return Object.values(t.fields).some(hasEmptyArray);
  return false;
}

/** The most rounds of the forward pass, which stops when nothing changes. */
const MAX_ROUNDS = 64;

/** The nodes in an order where each comes after the producers of its inputs (loop edges aside). */
function order(
  g: DucGraph,
  producer: Map<ValueId, DucNode>,
  extra: ReadonlyMap<DucNode, readonly ValueId[]>,
): DucNode[] {
  const out: DucNode[] = [];
  const state = new Map<DucNode, number>();
  const visit = (n: DucNode): void => {
    if (state.get(n) !== undefined) return;
    state.set(n, 1);
    for (const v of [...n.inputs, ...(extra.get(n) ?? [])]) {
      const p = producer.get(v);
      if (p !== undefined) visit(p);
    }
    state.set(n, 2);
    out.push(n);
  };
  for (const n of g.nodes) visit(n);
  return out;
}

function literalType(label: string): DucType {
  if (label === "true" || label === "false") return BOOLEAN;
  if (label === "null") return { k: "null" };
  if (label === "undefined" || label === "Uninitialized") return UNDEFINED;
  if (label.startsWith('"')) return STRING;
  if (/^\d+n$/.test(label)) return { k: "bigint" };
  if (label.startsWith("/")) return { k: "named", name: "RegExp", args: [] };
  const n = Number(label);
  if (label !== "" && !Number.isNaN(n))
    return NUM(
      Number.isInteger(n) && !label.includes(".") && !/e-/i.test(label) ? "integer" : "float",
    );
  return UNKNOWN;
}

/** A platform primitive as a value: its known namespaces are named, so their members resolve. */
function ambientType(symbol: string): DucType {
  return { k: "named", name: `@${symbol}`, args: [] };
}

function elementOf(t: DucType): DucType {
  if (t.k === "array") return t.of ?? UNKNOWN;
  if (t.k === "tuple") return union(t.items);
  if (t.k === "string") return STRING;
  if (t.k === "named" && (t.name === "Set" || t.name === "ReadonlySet") && t.args[0] !== undefined)
    return t.args[0];
  if (t.k === "named" && (t.name === "Map" || t.name === "ReadonlyMap") && t.args.length === 2)
    return { k: "tuple", items: t.args };
  return UNKNOWN;
}

function arith(a: DucType, b: DucType, op: string): DucType {
  if (!isNum(a) || !isNum(b)) {
    if (a.k === "bigint" && b.k === "bigint") return a;
    return UNKNOWN;
  }
  if (op === "/") return NUM("float");
  if (op === "**")
    return a.n === "integer" && b.n === "integer"
      ? NUM("number")
      : NUM(a.n === "float" || b.n === "float" ? "float" : "number");
  if (a.n === "integer" && b.n === "integer") return NUM("integer");
  if (a.n === "float" || b.n === "float") return NUM("float");
  return NUM("number");
}

const BINARY_BOOLEAN = new Set([
  "<",
  ">",
  "<=",
  ">=",
  "==",
  "!=",
  "===",
  "!==",
  "in",
  "instanceof",
]);
const BINARY_INTEGER = new Set(["|", "&", "^", "<<", ">>", ">>>"]);

/** The type of an operation's result. */
function opType(
  n: DucNode,
  at: (i: number) => DucType,
  depth: number,
  ambiguities: Ambiguity[],
): DucType {
  const label = n.label ?? "";
  const arity = n.inputs.length;
  // An operation reference to one of Math's atoms (#1362) gives a float64.
  if (operationReference(label) !== undefined) return NUM("float");
  if (arity === 2 && (label === "+" || label === "+=")) {
    const [a, b] = [at(0), at(1)];
    if (isString(a) || isString(b)) return STRING;
    return arith(a, b, "+");
  }
  if (arity === 2 && ["-", "*", "/", "%", "**", "-=", "*=", "/=", "%="].includes(label))
    return arith(at(0), at(1), label.replace("=", ""));
  if (arity === 2 && BINARY_BOOLEAN.has(label)) return BOOLEAN;
  if (arity === 2 && BINARY_INTEGER.has(label)) return NUM("integer");
  if (arity === 2 && (label === "&&" || label === "||" || label === "??"))
    return union([at(0), at(1)]);
  if (arity === 1 && label === "!") return BOOLEAN;
  if (arity === 1 && label === "~") return NUM("integer");
  if (arity === 1 && (label === "-" || label === "+")) return isNum(at(0)) ? at(0) : NUM("number");
  if (arity === 1 && ["++", "--", "post++", "post--"].includes(label))
    return isNum(at(0)) ? at(0) : NUM("number");
  if (label === "TypeOfExpression") return STRING;
  if (label === "VoidExpression") return UNDEFINED;
  if (label.startsWith("template:")) return STRING;
  if (label === "ArrayLiteral") {
    // A spread contributes its elements; an array with no element has no element type.
    const items = n.inputs
      .map((_, i) => at(i))
      .map((t) => (t.k === "named" && t.name === "spread" ? (t.args[0] ?? UNKNOWN) : t));
    return { k: "array", of: items.length === 0 ? undefined : union(items) };
  }
  if (label === "...") return { k: "named", name: "spread", args: [elementOf(at(0))] };
  if (label.startsWith("object:")) {
    // A key and its value; a spread (null) takes the fields of an object; a computed key (1) is a
    // key value and then its value, whose name is not known.
    const keys = JSON.parse(label.slice("object:".length)) as unknown[];
    const fields: Record<string, DucType> = {};
    let i = 0;
    for (const key of keys) {
      if (typeof key === "string") fields[key] = at(i++);
      else if (key === null) {
        const spread = at(i++);
        if (spread.k !== "object") return UNKNOWN;
        Object.assign(fields, spread.fields);
      } else return UNKNOWN;
    }
    return { k: "object", fields };
  }
  if (label === "this") return UNKNOWN;
  if (label === "closure" || label === "function") {
    const graph = n.closure;
    if (graph === undefined) return UNKNOWN;
    const captures = n.inputs.map((_, i) => at(i));
    // A closure with no parameters of its own has one result whatever calls it: infer it here.
    const own = graph.nodes.filter((p) => p.kind === "param-source").length - captures.length;
    const result =
      own === 0 && depth < 4
        ? (inferGraph(graph, captures, new Map(), ambiguities, depth + 1)[0] ?? UNDEFINED)
        : UNKNOWN;
    return { k: "fn", params: [], result, closure: { graph, captures } };
  }
  // A member read: `.length`, a field, a method (a function the call below types), a namespace member.
  if (arity === 1 && label.startsWith(".") && !label.endsWith("="))
    return memberType(at(0), label.slice(1));
  if (arity === 1 && label.startsWith("?.") && !label.endsWith("="))
    return union([memberType(at(0), label.slice(2)), UNDEFINED]);
  if (arity === 2 && label.startsWith(".") && label.endsWith("=")) return at(0);
  if (label === "[]=") return at(0);
  if (label === "ElementAccess" || label === "ElementAccess?.") {
    const base = at(0);
    if (base.k === "array" || base.k === "string" || base.k === "tuple") return elementOf(base);
    if (base.k === "object") return union(Object.values(base.fields));
    return UNKNOWN;
  }
  if (label === "CallExpression" || label === "CallExpression?." || label === "NewExpression") {
    const callee = at(0);
    const args = n.inputs.slice(1).map((_, i) => at(i + 1));
    return callType(callee, args, label === "NewExpression", depth, ambiguities);
  }
  return UNKNOWN;
}

/** A member of a value: what is known of strings, arrays, objects and the platform namespaces. */
function memberType(base: DucType, name: string): DucType {
  if (name === "length" && (base.k === "string" || base.k === "array" || base.k === "tuple"))
    return NUM("integer");
  if (base.k === "object") return base.fields[name] ?? UNDEFINED;
  if (base.k === "union") return union(base.of.map((t) => memberType(t, name)));
  // A method: a function whose result the call works out from its receiver and name.
  return { k: "named", name: `method:${name}`, args: [base] };
}

function callType(
  callee: DucType,
  args: readonly DucType[],
  isNew: boolean,
  depth: number,
  ambiguities: Ambiguity[],
): DucType {
  if (callee.k === "fn") {
    if (callee.closure !== undefined && depth < 4) {
      const inner = new Map<ValueId, DucType>();
      // A rest parameter takes the arguments from its place on, as an array.
      const given = [...callee.closure.captures, ...args];
      const rest = callee.closure.graph.nodes.find(
        (p) => p.kind === "param-source" && isRestParam(p.label),
      );
      const at = rest !== undefined ? paramIndex(rest.label) : given.length;
      const packed =
        rest !== undefined
          ? [
              ...given.slice(0, at),
              { k: "array", of: given.length > at ? union(given.slice(at)) : undefined } as DucType,
            ]
          : given;
      const results = inferGraph(callee.closure.graph, packed, inner, ambiguities, depth + 1);
      return results[0] ?? UNDEFINED;
    }
    return callee.result;
  }
  if (callee.k === "named" && callee.name.startsWith("@")) {
    // A platform constructor or function called directly.
    const sym = callee.name.slice(1);
    if (sym === "String") return STRING;
    if (sym === "Number" || sym === "parseFloat") return NUM("float");
    if (sym === "parseInt") return NUM("integer");
    if (sym === "Boolean" || sym === "isNaN" || sym === "isFinite") return BOOLEAN;
    if (isNew || /^[A-Z]/.test(sym)) return { k: "named", name: sym, args: [] };
    return UNKNOWN;
  }
  if (callee.k === "named" && callee.name.startsWith("method:")) {
    const name = callee.name.slice("method:".length);
    const recv = callee.args[0] ?? UNKNOWN;
    if (recv.k === "named" && recv.name === "@Math") {
      if (MATH_INTEGER.has(name)) return NUM("integer");
      if (
        (name === "max" || name === "min" || name === "abs") &&
        args.length > 0 &&
        args.every(isNum)
      )
        return union(args);
      return NUM("float");
    }
    if (recv.k === "named" && recv.name === "@JSON") return name === "stringify" ? STRING : UNKNOWN;
    if (recv.k === "named" && recv.name === "@Number")
      return BOOLEAN_METHODS.has(name) ? BOOLEAN : NUM("float");
    if (recv.k === "named" && recv.name === "@Array" && name === "isArray") return BOOLEAN;
    if (
      recv.k === "named" &&
      recv.name === "@Object" &&
      (name === "keys" || name === "getOwnPropertyNames")
    )
      return { k: "array", of: STRING };
    if (BOOLEAN_METHODS.has(name)) return BOOLEAN;
    if (INTEGER_METHODS.has(name)) return NUM("integer");
    if (recv.k === "string") {
      if (name === "split") return { k: "array", of: STRING };
      if (STRING_METHODS.has(name)) return STRING;
    }
    if (recv.k === "array") {
      if (name === "join") return STRING;
      if (
        name === "slice" ||
        name === "concat" ||
        name === "filter" ||
        name === "reverse" ||
        name === "sort"
      )
        return recv;
      if (name === "pop" || name === "shift" || name === "find" || name === "at")
        return union([recv.of ?? UNKNOWN, UNDEFINED]);
    }
    if (isNum(recv) && (name === "toFixed" || name === "toString" || name === "toPrecision"))
      return STRING;
    return UNKNOWN;
  }
  return UNKNOWN;
}
