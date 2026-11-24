// SPDX-License-Identifier: Apache-2.0
/**
 * The lowering shared by the bytecode targets (DEC-DUC-BYTECODE-TARGETS-001, #1311): a graph to a
 * small typed stack IR, which each target encodes (`emit-wasm-gc.ts` as WasmGC, `emit-jvm.ts` as JVM
 * class files). Everything that decides what a program means is here, once: the types (a dataflow
 * fixpoint over the graph), the order of operations (`scopePlanner`), and which runtime atom
 * implements each of ECMAScript's operations (`wasm-runtime-atoms.ts`). A target supplies only the
 * encoding and the primitives the atoms are written over.
 *
 * Values are typed from the contract and the graph:
 * - `f64`, a number;
 * - `i32`, a boolean (0 or 1);
 * - `str`, a string of UTF-16 units;
 * - `nums`, an array of numbers;
 * - `any`, a value of any of these kinds, or undefined or null.
 *
 * The IR is a stack machine with structured control (`if`/`else`/`end`, `block`, `loop`, `br`,
 * `br_if`), the shape WebAssembly has; a target without it lowers it to jumps.
 */
import { WASM_HOST } from "./emit-wasm.js";
import { type DucType, parseType } from "./infer-types.js";
import { liftAtom } from "./lift.js";
import { bodyPathOf, joinOwners, sidePath } from "./line-form.js";
import { ecmaScriptView } from "./ops.js";
import { loweringView } from "./ordering.js";
import { paramIndex } from "./params.js";
import { type ScopeItem, scopePlanner } from "./scopes.js";
import type { DucBranch, DucGraph, DucLoop, DucNode, ValueId } from "./types.js";
import {
  BIGNUM_ATOMS,
  DYNAMIC_ATOMS,
  RUNTIME_ATOMS,
  type RuntimeAtom,
} from "./wasm-runtime-atoms.js";

/** A graph outside what the lowering covers, with the reason. A target rethrows it as its own. */
export class LoweringError extends Error {}

/** Every runtime atom the lowering can call, by name. */
export const ATOMS: Readonly<Record<string, RuntimeAtom>> = {
  ...RUNTIME_ATOMS,
  ...BIGNUM_ATOMS,
  ...DYNAMIC_ATOMS,
};

/**
 * A value's type: a number, a boolean, a string, an array of numbers, or a value of any of these
 * kinds or undefined or null.
 */
export type WT = "f64" | "i32" | "str" | "nums" | "arr" | "obj" | "any";

/** The f64 operations: arithmetic, Math's native functions, and comparisons (to an i32). */
export type F64Op =
  | "add"
  | "sub"
  | "mul"
  | "div"
  | "neg"
  | "min"
  | "max"
  | "floor"
  | "ceil"
  | "trunc"
  | "sqrt"
  | "abs"
  | "lt"
  | "gt"
  | "le"
  | "ge"
  | "eq"
  | "ne";

/**
 * One instruction of the stack IR. `call` names a function of the program by key (`f`,
 * `atom:<name>`, `prim:<name>`, `host:<name>`). `to.any` makes a value of any kind from a typed one;
 * `from.any` reads one as the kind its type says it is. `nums.of` makes an array of the `n` numbers
 * on the stack.
 */
export type Ins =
  | { readonly op: "const.f64"; readonly x: number }
  | { readonly op: "const.i32"; readonly x: number }
  | { readonly op: "const.str"; readonly s: string }
  | { readonly op: "const.undef" }
  | { readonly op: "const.null" }
  | { readonly op: "nums.of"; readonly n: number }
  | { readonly op: "arr.of"; readonly n: number }
  | { readonly op: "get"; readonly i: number }
  | { readonly op: "set"; readonly i: number }
  | { readonly op: "call"; readonly fn: string }
  | { readonly op: "f64"; readonly name: F64Op }
  | { readonly op: "i32"; readonly name: "eqz" | "and" | "eq" }
  | { readonly op: "f64.of.i32" }
  | { readonly op: "str.len" }
  | { readonly op: "nums.len" }
  | { readonly op: "arr.len" }
  | { readonly op: "to.any"; readonly from: WT }
  | { readonly op: "from.any"; readonly to: WT }
  | { readonly op: "ref.eq" }
  | { readonly op: "select"; readonly t: WT }
  | { readonly op: "drop"; readonly t: WT }
  | { readonly op: "if" }
  | { readonly op: "else" }
  | { readonly op: "end" }
  | { readonly op: "block" }
  | { readonly op: "loop" }
  | { readonly op: "br"; readonly depth: number }
  | { readonly op: "br_if"; readonly depth: number };

/** The error classes `new` makes: an object of that class, whose name it inherits. */
const ERROR_CLASSES: ReadonlySet<string> = new Set([
  "Error",
  "TypeError",
  "RangeError",
  "SyntaxError",
  "ReferenceError",
  "EvalError",
  "URIError",
]);

export const NATIVE_MATH: ReadonlySet<string> = new Set(["floor", "ceil", "trunc", "sqrt", "abs"]);
export const MATH_CONSTANTS: Readonly<Record<string, number>> = {
  PI: Math.PI,
  E: Math.E,
  LN2: Math.LN2,
  LN10: Math.LN10,
  LOG2E: Math.LOG2E,
  LOG10E: Math.LOG10E,
  SQRT2: Math.SQRT2,
  SQRT1_2: Math.SQRT1_2,
};
const F64_BINARY: Readonly<Record<string, F64Op>> = {
  "+": "add",
  "-": "sub",
  "*": "mul",
  "/": "div",
};
const F64_COMPARE: Readonly<Record<string, F64Op>> = {
  "<": "lt",
  ">": "gt",
  "<=": "le",
  ">=": "ge",
  "===": "eq",
  "==": "eq",
  "!==": "ne",
  "!=": "ne",
};
const AMBIENT_NUMBERS: Readonly<Record<string, number>> = {
  NaN: Number.NaN,
  Infinity: Number.POSITIVE_INFINITY,
};

/** The primitives: their parameter and result types. */
export const PRIMITIVES: Readonly<Record<string, { params: WT[]; result: WT }>> = {
  __ykUnit: { params: ["str", "f64"], result: "f64" },
  __ykSub: { params: ["str", "f64", "f64"], result: "str" },
  __ykJoin: { params: ["str", "str"], result: "str" },
  // A one-unit string, and a double's high and low 32 bits (for Number::toString).
  __ykChar: { params: ["f64"], result: "str" },
  __ykF64Hi: { params: ["f64"], result: "f64" },
  __ykF64Lo: { params: ["f64"], result: "f64" },
  // 2^e, exact over the whole range of doubles (0 below the least subnormal, Infinity above).
  __ykPow2: { params: ["f64"], result: "f64" },
  // A value of any kind: its kind (0 undefined, 1 null, 2 boolean, 3 number, 4 string, 5 array of
  // numbers), the value read as one kind, and reference equality.
  __ykTag: { params: ["any"], result: "f64" },
  __ykNum: { params: ["any"], result: "f64" },
  __ykBool: { params: ["any"], result: "i32" },
  __ykStr: { params: ["any"], result: "str" },
  __ykArr: { params: ["any"], result: "nums" },
  __ykArrAny: { params: ["any"], result: "arr" },
  // Undefined as a value; and the point where a TypeError is thrown (a trap until exceptions).
  __ykUndef: { params: [], result: "any" },
  // An object: a cast to one, an empty one of a class (a string, or not one for a plain object),
  // its keys and its values (arrays, shared, in insertion order), and its class.
  __ykObj: { params: ["any"], result: "obj" },
  __ykObjNew: { params: ["any"], result: "obj" },
  __ykObjKeys: { params: ["obj"], result: "arr" },
  __ykObjVals: { params: ["obj"], result: "arr" },
  __ykObjCls: { params: ["obj"], result: "any" },
  __ykTypeError: { params: [], result: "any" },
  __ykSame: { params: ["any", "any"], result: "i32" },
};

/** The array operations, written directly: what an array of numbers is made of. */
export const ARRAY_PRIMITIVES: Readonly<Record<string, { params: WT[]; result: WT }>> = {
  numsPush: { params: ["nums", "f64"], result: "f64" },
  numsPop: { params: ["nums"], result: "f64" },
  numsGet: { params: ["nums", "f64"], result: "f64" },
  numsSet: { params: ["nums", "f64", "f64"], result: "nums" },
  // A program's element read: the element, or undefined at an index that is not one.
  numsAt: { params: ["nums", "f64"], result: "any" },
  // A program's pop: undefined from an empty array.
  numsPopAny: { params: ["nums"], result: "any" },
  // An array of any values: the same operations, its elements values of any kind. A read out of
  // range, or at an index that is not one, is undefined; a pop of an empty array is undefined.
  arrPush: { params: ["arr", "any"], result: "f64" },
  arrPop: { params: ["arr"], result: "any" },
  arrAt: { params: ["arr", "f64"], result: "any" },
  arrSet: { params: ["arr", "f64", "any"], result: "arr" },
};

/**
 * String methods, as calls of runtime atoms. Each entry gives the atom and how a call's arguments
 * become its parameters: a missing argument takes the value ECMAScript gives `undefined` there.
 */
const STRING_METHODS: Readonly<
  Record<
    string,
    { atom: string; args: readonly ("str" | number)[]; negate?: boolean; notFound?: boolean }
  >
> = {
  charCodeAt: { atom: "__ykCharCodeAt", args: [0] },
  charAt: { atom: "__ykCharAt", args: [0] },
  slice: { atom: "__ykSlice", args: [0, Number.POSITIVE_INFINITY] },
  substring: { atom: "__ykSubstring", args: [0, Number.POSITIVE_INFINITY] },
  indexOf: { atom: "__ykIndexOf", args: ["str", 0] },
  includes: { atom: "__ykIndexOf", args: ["str", 0], notFound: true },
  startsWith: { atom: "__ykStartsWith", args: ["str", 0] },
  endsWith: { atom: "__ykEndsWith", args: ["str", Number.POSITIVE_INFINITY] },
  trim: { atom: "__ykTrim", args: [] },
};

// --- the program: functions by key, each lowered once ---

/** A function of the program: lowered from a graph (`f` and the atoms), or a target's primitive. */
export type StackFunc =
  | {
      readonly kind: "lowered";
      readonly params: readonly WT[];
      readonly result: WT;
      locals: WT[];
      code: Ins[];
    }
  | { readonly kind: "primitive"; readonly params: readonly WT[]; readonly result: WT };

/** The functions a graph reaches: `f`, the atoms, the primitives, and the host functions. */
export class StackProgram {
  readonly funcs = new Map<string, StackFunc>();
  /** The host functions reached, with the most arguments any call passes. */
  readonly hosts = new Map<string, number>();
  readonly atoms: string[] = [];
  private readonly graphIds = new WeakMap<DucGraph, number>();
  private nextGraphId = 0;
  private readonly lowering = new Set<string>();

  /** A host function (`%`, `**`, a `Math` function), by name. */
  host(name: string, arity: number): string {
    if (WASM_HOST[name] === undefined) throw new LoweringError(`"${name}" is not a host function`);
    this.hosts.set(name, Math.max(this.hosts.get(name) ?? 0, arity));
    return `host:${name}`;
  }

  /** A runtime atom: lowered once, the first time a function calls it. */
  atom(key: string): { fn: string; params: readonly WT[]; result: WT } {
    const a = ATOMS[key];
    if (a === undefined) throw new LoweringError(`"${key}" is not a runtime atom`);
    const params = a.inputs.map((t) => wt(parseType(t), `${key}'s parameter`));
    const result = wt(parseType(a.output), `${key}'s result`);
    const fkey = `atom:${key}`;
    if (!this.funcs.has(fkey)) {
      const f: StackFunc = { kind: "lowered", params, result, locals: [], code: [] };
      this.funcs.set(fkey, f);
      this.atoms.push(key);
      const lowered = lowerFunction(atomGraph(key), params, result, this, true);
      f.locals = lowered.locals;
      f.code = lowered.code;
    }
    return { fn: fkey, params, result };
  }

  /**
   * A closure's function, for one signature: its captures, then its parameters. Lowered once per
   * signature, the first time a call needs it; its result type is the lowering's.
   */
  closure(graph: DucGraph, params: readonly WT[], trusted: boolean): { fn: string; result: WT } {
    let id = this.graphIds.get(graph);
    if (id === undefined) {
      id = this.nextGraphId++;
      this.graphIds.set(graph, id);
    }
    const fkey = `closure:${id}:${params.join(",")}`;
    const known = this.funcs.get(fkey);
    if (known !== undefined) return { fn: fkey, result: known.result };
    if (this.lowering.has(fkey))
      throw new LoweringError("a closure that calls itself is not in the subset yet");
    this.lowering.add(fkey);
    try {
      const lowered = lowerFunction(graph, params, undefined, this, trusted);
      this.funcs.set(fkey, { kind: "lowered", params, ...lowered });
      return { fn: fkey, result: lowered.result };
    } finally {
      this.lowering.delete(fkey);
    }
  }

  /** A primitive: written by each target. */
  primitive(key: string): { fn: string; params: readonly WT[]; result: WT } {
    const p = (PRIMITIVES[key] ?? ARRAY_PRIMITIVES[key]) as
      | { params: WT[]; result: WT }
      | undefined;
    if (p === undefined) throw new LoweringError(`no primitive ${key}`);
    const fkey = `prim:${key}`;
    if (!this.funcs.has(fkey)) {
      this.funcs.set(fkey, { kind: "primitive", ...p });
      // A write at the end of an array is a push.
      if (key === "numsSet") this.primitive("numsPush");
      if (key === "arrSet") this.primitive("arrPush");
    }
    return { fn: fkey, params: p.params, result: p.result };
  }
}

/**
 * The graph lowered to a program whose function `f` has the contract's types. The contract's output
 * type is required.
 */
export function lowerProgram(
  input: DucGraph,
  signature: { readonly inputs: readonly string[]; readonly output?: string },
): StackProgram {
  if (signature.output === undefined)
    throw new LoweringError("the contract's output type is needed");
  const params = signature.inputs.map((t, i) => wt(parseType(t), `parameter ${i}`));
  const result = wt(parseType(signature.output), "the result");
  const prog = new StackProgram();
  const f: StackFunc = { kind: "lowered", params, result, locals: [], code: [] };
  prog.funcs.set("f", f);
  // ECMAScript's operations: each generic operation as the case of them it is (#1310).
  const lowered = lowerFunction(ecmaScriptView(input), params, result, prog);
  f.locals = lowered.locals;
  f.code = lowered.code;
  return prog;
}

function wt(t: DucType | undefined, what: string): WT {
  if (t === undefined) throw new LoweringError(`${what} has no type`);
  if (t.k === "num") return "f64";
  if (t.k === "boolean") return "i32";
  if (t.k === "string") return "str";
  if (t.k === "array" && t.of?.k === "num") return "nums";
  // An array of anything else holds values of any kind.
  if (t.k === "array") return "arr";
  // An object type, or the runtime's name for an object in an atom.
  if (t.k === "object" || (t.k === "named" && t.name === "YkObject")) return "obj";
  // A value that may be of more than one kind, undefined or null.
  if (t.k === "unknown" || t.k === "null" || t.k === "undefined") return "any";
  if (t.k === "union") {
    const kinds = new Set(t.of.map((x) => wt(x, what)));
    return kinds.size === 1 ? ([...kinds][0] as WT) : "any";
  }
  throw new LoweringError(
    `${what} is not a number, a boolean, a string or an array of numbers here`,
  );
}

const atomGraphs = new Map<string, DucGraph>();
function atomGraph(key: string): DucGraph {
  let g = atomGraphs.get(key);
  if (g === undefined) {
    g = ecmaScriptView(liftAtom((ATOMS[key] as { source: string }).source));
    atomGraphs.set(key, g);
  }
  return g;
}

/** What a value is: a typed runtime value, undefined (no value yet), or something only called. */
type VT = WT | "undef" | { readonly call: Callee };
type Callee =
  | { readonly k: "math"; readonly name: string }
  | { readonly k: "string-of" }
  | { readonly k: "number-of" }
  | { readonly k: "error-class"; readonly name: string }
  | { readonly k: "method"; readonly recv: ValueId; readonly name: string }
  | { readonly k: "prim"; readonly name: string }
  | { readonly k: "atom"; readonly name: string }
  /** A closure the graph makes: called, it is its own function with its captures passed first. */
  | { readonly k: "closure"; readonly node: DucNode };

/** One function of the program, lowered from a graph. */
function lowerFunction(
  source: DucGraph,
  paramTypes: readonly WT[],
  declared: WT | undefined,
  mod: StackProgram,
  /**
   * A runtime atom: its element reads and writes are lowered, with undefined (out of range) standing
   * for a value it never observes. The atoms are tested against the builtins they define; a program
   * is not, so in a program an element read or write is refused for now.
   */
  trusted = false,
): { result: WT; locals: WT[]; code: Ins[] } {
  if (source.mode !== undefined)
    throw new LoweringError(`an ${source.mode} function has no form here`);
  if (source.obs.length !== 1) throw new LoweringError("the subset has exactly one result");
  const { graph: g, after } = loweringView(source);
  const owners = joinOwners(g);
  const producer = new Map<ValueId, DucNode>();
  for (const n of g.nodes) for (const v of n.outputs) producer.set(v, n);

  const loops = g.nodes.filter((n) => n.kind === "loop");
  const alias = new Map<ValueId, ValueId>();
  const carryOf = new Map<ValueId, { loop: DucNode; i: number }>();
  for (const loop of loops) {
    const rec = loop.loop as DucLoop;
    if (rec.iterate !== undefined) throw new LoweringError("iteration is not in the subset");
    if (rec.cond === undefined) throw new LoweringError("a loop with no condition");
    rec.invariant.forEach((v, j) => alias.set(v, loop.inputs[rec.carry.length + j] as ValueId));
    rec.carry.forEach((c, i) => carryOf.set(c, { loop, i }));
  }
  const resolve = (v: ValueId): ValueId => {
    const a = alias.get(v);
    return a === undefined ? v : resolve(a);
  };

  const params = g.nodes
    .filter((n) => n.kind === "param-source")
    .sort((a, b) => paramIndex(a.label) - paramIndex(b.label));
  if (params.length !== paramTypes.length)
    throw new LoweringError("the signature and the graph have different parameter counts");

  // --- types: a dataflow fixpoint over the graph ---
  // Every value starts unknown ("?") and only rises, to a type or to "undef" (a literal or ambient
  // undefined). A carry is the unification of its start and its next value, so a loop's cycle
  // settles from its start; values that depend on each other settle together.
  const types = new Map<ValueId, VT | "?">();
  const get = (v: ValueId): VT | "?" => types.get(resolve(v)) ?? "?";
  const show = (t: VT | "?"): string =>
    typeof t === "string"
      ? (
          {
            f64: "a number",
            i32: "a boolean",
            str: "a string",
            nums: "an array of numbers",
            arr: "an array",
            obj: "an object",
            any: "a value of any kind",
            undef: "undefined",
            "?": "nothing yet",
          } as const
        )[t]
      : "a function";
  /**
   * The type of a value that is one of two: values of different kinds make a value of any kind. In
   * a program an undefined is a value too, so undefined and a number make a value of any kind. In a
   * runtime atom an undefined is never observed (the atoms are tested against the builtins they
   * define): it stands for the other type's default.
   */
  const unify = (a: VT | "?", b: VT | "?", what: string): VT | "?" => {
    if (a === "?") return b;
    if (b === "?") return a;
    if (typeof a === "object" || typeof b === "object") {
      if (a === b) return a;
      throw new LoweringError(`${what} mixes ${show(a)} and ${show(b)}`);
    }
    if (a === b) return a;
    if (trusted && a === "undef") return b;
    if (trusted && b === "undef") return a;
    return "any";
  };
  /** The empty array literals something other than a number is stored in. */
  const grown = new Set<ValueId>();
  /** The empty array literals an array value may be: through carries, choices and writes. */
  const arrayOrigins = (v0: ValueId, seen = new Set<ValueId>()): ValueId[] => {
    const v = resolve(v0);
    if (seen.has(v)) return [];
    seen.add(v);
    const carry = carryOf.get(v);
    if (carry !== undefined) {
      const rec = carry.loop.loop as DucLoop;
      return [
        ...arrayOrigins(carry.loop.inputs[carry.i] as ValueId, seen),
        ...arrayOrigins(rec.next[carry.i] as ValueId, seen),
      ];
    }
    const p = producer.get(v);
    if (p === undefined) return [];
    if (p.kind === "loop")
      return arrayOrigins((p.loop as DucLoop).carry[p.outputs.indexOf(v)] as ValueId, seen);
    if (p.kind === "sel" || owners.get(p.id) !== undefined)
      return [
        ...arrayOrigins(p.inputs[1] as ValueId, seen),
        ...arrayOrigins(p.inputs[2] as ValueId, seen),
      ];
    if (p.kind === "op" && p.label === "ArrayLiteral" && p.inputs.length === 0) return [v];
    if (p.kind === "op" && p.label === "[]=") return arrayOrigins(p.inputs[0] as ValueId, seen);
    return [];
  };
  /** A store of a value of type `t` in an array of numbers: a non-number grows its literals. */
  const stored = (arr: ValueId, t: VT | "?"): void => {
    if (t === "?" || t === "f64") return;
    for (const o of arrayOrigins(arr)) grown.add(o);
  };
  /**
   * A closure call's signature: its captures' types, then its arguments' (a missing argument is
   * undefined). Undefined while any is unknown. Undefined is a value of any kind here; a function is
   * not passed.
   */
  const closureSignature = (node: DucNode, args: readonly ValueId[]): WT[] | undefined => {
    const inner = node.closure as DucGraph;
    const count = inner.nodes.filter((n) => n.kind === "param-source").length;
    const captures = node.inputs as readonly ValueId[];
    const given = [...captures, ...args].slice(0, count);
    const sig: WT[] = [];
    for (let i = 0; i < count; i++) {
      const v = given[i];
      const t = v === undefined ? "undef" : get(v);
      if (t === "?") return undefined;
      if (typeof t === "object")
        throw new LoweringError("a function passed to a closure is not in the subset yet");
      sig.push(t === "undef" ? "any" : t);
    }
    return sig;
  };
  const computeType = (v: ValueId): VT | "?" => {
    const carry = carryOf.get(v);
    if (carry !== undefined) {
      const rec = carry.loop.loop as DucLoop;
      return unify(
        get(carry.loop.inputs[carry.i] as ValueId),
        get(rec.next[carry.i] as ValueId),
        "a loop's carry",
      );
    }
    const p = producer.get(v);
    if (p === undefined) throw new LoweringError(`value ${v} has no producer`);
    if (p.kind === "param-source") return paramTypes[paramIndex(p.label)] as WT;
    if (p.kind === "literal-source") {
      const text = p.label ?? "";
      // `let x;` reads as Uninitialized until it is assigned: undefined.
      if (text === "undefined" || text === "Uninitialized") return "undef";
      if (text === "true" || text === "false") return "i32";
      if (text === "null") return "any";
      if (text.startsWith('"')) return "str";
      if (text === "NaN" || (text.trim() !== "" && !Number.isNaN(Number(text.replace(/_/g, "")))))
        return "f64";
      throw new LoweringError(`the literal ${text} is not in the subset`);
    }
    if (p.kind === "diamond-source") {
      const sym = p.diamond?.symbol ?? "";
      if (sym === "undefined") return "undef";
      if (AMBIENT_NUMBERS[sym] !== undefined) return "f64";
      if (sym === "Math") return { call: { k: "math", name: "" } };
      if (sym === "String") return { call: { k: "string-of" } };
      if (sym === "Number") return { call: { k: "number-of" } };
      if (ERROR_CLASSES.has(sym)) return { call: { k: "error-class", name: sym } };
      if (PRIMITIVES[sym] !== undefined) return { call: { k: "prim", name: sym } };
      if (ATOMS[sym] !== undefined) return { call: { k: "atom", name: sym } };
      throw new LoweringError(`"${sym}" is not in the wasm base set`);
    }
    if (p.kind === "loop") return get((p.loop as DucLoop).carry[p.outputs.indexOf(v)] as ValueId);
    const ins = p.inputs as readonly ValueId[];
    if (p.kind === "sel" || owners.get(p.id) !== undefined)
      return unify(get(ins[1] as ValueId), get(ins[2] as ValueId), "a choice between two values");
    if (p.kind !== "op") throw new LoweringError(`a ${p.kind} node is not in the subset`);
    if (p.closure !== undefined) {
      if (p.label !== "closure")
        throw new LoweringError(`a "${p.label}" with a body is not in the subset`);
      return { call: { k: "closure", node: p } };
    }
    const label = p.label ?? "";
    const operand = (i: number): VT | "?" => {
      const t = get(ins[i] as ValueId);
      if (t !== "undef") return t;
      // In a program, undefined is a value like any other; in a runtime atom it is never one.
      if (trusted) throw new LoweringError(`undefined is an operand of "${label}"`);
      return "any";
    };
    if (/^\.\w+$/.test(label) && ins.length === 1) {
      const member = label.slice(1);
      const t0 = operand(0);
      if (t0 === "?") return "?";
      if (typeof t0 === "object" && t0.call.k === "math")
        return MATH_CONSTANTS[member] !== undefined ? "f64" : { call: { k: "math", name: member } };
      if (t0 === "nums" || t0 === "arr") {
        if (member === "length") return "f64";
        if (member === "push" || member === "pop")
          return { call: { k: "method", recv: ins[0] as ValueId, name: `${t0}.${member}` } };
        throw new LoweringError(`the array method ${member} is not in the subset yet`);
      }
      // A property of an object, or of a value of any kind: the runtime atoms.
      if (t0 === "obj" || t0 === "any") return "any";
      if ((t0 === "f64" || t0 === "i32") && member === "toString")
        return { call: { k: "method", recv: ins[0] as ValueId, name: "toString" } };
      if (t0 === "str") {
        if (member === "length") return "f64";
        if (STRING_METHODS[member] !== undefined)
          return { call: { k: "method", recv: ins[0] as ValueId, name: member } };
        throw new LoweringError(`the string method ${member} is not in the subset yet`);
      }
      throw new LoweringError(`the member ${member} of ${show(t0)} is not in the subset`);
    }
    if (label === "CallExpression") {
      const t0 = operand(0);
      if (t0 === "?") return "?";
      if (typeof t0 !== "object")
        throw new LoweringError("a call of a value that is not a known function");
      const callee = t0.call;
      if (callee.k === "math") return "f64";
      if (callee.k === "string-of") return "str";
      if (callee.k === "number-of") return "f64";
      if (callee.k === "error-class") return "obj";
      if (callee.k === "prim") return (PRIMITIVES[callee.name] as { result: WT }).result;
      if (callee.k === "method" && callee.name === "nums.push") {
        stored(callee.recv, ins[1] === undefined ? "?" : get(ins[1] as ValueId));
        return "f64";
      }
      if (callee.k === "method" && callee.name === "nums.pop") return trusted ? "f64" : "any";
      if (callee.k === "method" && callee.name === "arr.push") return "f64";
      if (callee.k === "method" && callee.name === "arr.pop") return "any";
      if (callee.k === "method" && callee.name === "toString") return "str";
      if (callee.k === "atom")
        return wt(parseType((ATOMS[callee.name] as { output: string }).output), callee.name);
      if (callee.k === "closure") {
        const sig = closureSignature(callee.node, ins.slice(1));
        return sig === undefined
          ? "?"
          : mod.closure(callee.node.closure as DucGraph, sig, trusted).result;
      }
      const m = STRING_METHODS[callee.name] as { atom: string; notFound?: boolean };
      if (m.notFound === true) return "i32";
      return wt(parseType((ATOMS[m.atom] as { output: string }).output), m.atom);
    }
    if (ins.length === 2 && label === "+") {
      const known = [operand(0), operand(1)].filter((x) => x !== "?");
      if (known.some((x) => typeof x === "object")) throw new LoweringError("+ of a function");
      if (known.length === 0) return "?";
      // An array's primitive is its join, a string: + of one concatenates.
      if (known.some((x) => x === "str" || x === "nums" || x === "arr" || x === "obj"))
        return "str";
      // A value of any kind may be a string: ECMAScript's + decides (the runtime atom).
      if (known.some((x) => x === "any")) return known.length === 2 ? "any" : "?";
      return "f64";
    }
    if (label.startsWith("object:")) {
      if (ins.some((_, i) => typeof operand(i) === "object"))
        throw new LoweringError("an object of functions is not in the subset yet");
      return "obj";
    }
    if (/^\.\w+=$/.test(label) && ins.length === 2) {
      const t0 = operand(0);
      if (t0 === "?") return "?";
      if (t0 !== "obj")
        throw new LoweringError(`a property write to ${show(t0)} is not in the subset yet`);
      if (typeof operand(1) === "object")
        throw new LoweringError("a function stored in an object is not in the subset yet");
      return "obj";
    }
    if (label === "NewExpression") {
      const t0 = operand(0);
      if (t0 === "?") return "?";
      if (typeof t0 === "object" && t0.call.k === "error-class") return "obj";
      throw new LoweringError("new of other than an error class is not in the subset yet");
    }
    if (label === "ArrayLiteral") {
      // As TypeScript types it: numbers make an array of numbers; anything else, or nothing in a
      // program (an array that grows), an array of any values. In a runtime atom, [] is of numbers.
      const ts = ins.map((_, i) => operand(i));
      if (ts.some((t) => typeof t === "object"))
        throw new LoweringError("an array of functions is not in the subset yet");
      // An empty array is of numbers until something else is stored in it (TypeScript's evolving
      // array): then it holds values of any kind.
      if (ins.length === 0) return grown.has(v) ? "arr" : "nums";
      if (ts.every((t) => t === "f64")) return "nums";
      if (ts.some((t) => t !== "?" && t !== "f64")) return "arr";
      return "?";
    }
    if (label === "ElementAccess" && ins.length === 2) {
      const t0 = operand(0);
      if (t0 === "?") return "?";
      if (t0 === "str" || t0 === "any" || t0 === "obj") return "any";
      if (t0 !== "nums" && t0 !== "arr")
        throw new LoweringError(`an element read of ${show(t0)} is not in the subset`);
      const t1 = operand(1);
      if (t1 !== "?" && t1 !== "f64")
        throw new LoweringError(`an element read at ${show(t1)} is not in the subset yet`);
      // In a program a read out of range is undefined: a value of any kind.
      return t0 === "nums" && trusted ? "f64" : "any";
    }
    if (label === "[]=" && ins.length === 3) {
      const t0 = operand(0);
      if (t0 === "?") return "?";
      // An object's property, by a computed key.
      if (t0 === "obj") return "obj";
      if (t0 !== "nums" && t0 !== "arr")
        throw new LoweringError(`an element write to ${show(t0)} is not in the subset`);
      if (t0 === "nums") stored(ins[0] as ValueId, get(ins[2] as ValueId));
      if (!trusted)
        throw new LoweringError("an element write is not in the subset of a program yet");
      return t0;
    }
    if (label.startsWith("template:")) {
      // The label holds the template's cooked text, its value (the literal normal form, #1303).
      for (let i = 0; i < ins.length; i++) {
        const t = operand(i);
        if (typeof t === "object") throw new LoweringError("a template literal of a function");
      }
      return "str";
    }
    if (label === "TypeOfExpression") return "str";
    if (label === "??" && ins.length === 2) {
      // A value that is never nullish is the result; undefined gives the other side.
      const t0 = get(ins[0] as ValueId);
      if (t0 === "?") return "?";
      if (t0 === "undef") return get(ins[1] as ValueId);
      if (t0 !== "any") return t0;
      return unify(t0, get(ins[1] as ValueId), '"??"');
    }
    for (let i = 0; i < ins.length; i++) operand(i);
    if (ins.length === 2 && (F64_BINARY[label] !== undefined || label === "%" || label === "**"))
      return "f64";
    if (ins.length === 2 && F64_COMPARE[label] !== undefined) return "i32";
    if (ins.length === 1 && (label === "-" || label === "+")) return "f64";
    if (ins.length === 1 && label === "!") return "i32";
    if (ins.length === 2 && (label === "&&" || label === "||"))
      return unify(get(ins[0] as ValueId), get(ins[1] as ValueId), `"${label}"`);
    throw new LoweringError(`the operation "${label}" is not in the subset`);
  };
  /** A value's type as an operand: in a program, undefined is a value of any kind. */
  const opType = (v: ValueId): VT => {
    const t = ty(v);
    return t === "undef" && !trusted ? "any" : t;
  };
  const allValues = [...new Set([...producer.keys(), ...carryOf.keys()])].filter(
    (v) => resolve(v) === v,
  );
  for (let round = 0, changed = true; changed; round++) {
    if (round > (allValues.length + 2) * (grown.size + 1) + 2)
      throw new LoweringError("the types do not settle");
    const grownBefore = grown.size;
    changed = false;
    for (const v of allValues) {
      const t = computeType(v);
      const was = types.get(v) ?? "?";
      if (
        t !== "?" &&
        (typeof t !== typeof was || (typeof t === "string" ? t !== was : was === "?"))
      ) {
        types.set(v, t);
        changed = true;
      }
    }
    // A literal that grew retypes everything that flows from it: the types start again (the
    // literals only grow, so this happens at most once for each).
    if (grown.size !== grownBefore) {
      types.clear();
      changed = true;
    }
  }
  /** A value's settled type: never typed is undefined (it never has a value). */
  const ty = (v: ValueId): VT => {
    const t = get(v);
    return t === "?" ? "undef" : t;
  };
  const value = (v: ValueId, what: string): WT => {
    const t = ty(v);
    if (typeof t !== "string" || t === "undef")
      throw new LoweringError(`${what} has no value here`);
    return t;
  };

  // --- code ---
  const code: Ins[] = [];
  const locals: WT[] = [];
  const emit = (...xs: Ins[]): void => {
    code.push(...xs);
  };
  const local = new Map<ValueId, number>();
  params.forEach((p, i) => local.set(p.outputs[0] as ValueId, i));
  const localOf = (v: ValueId): number => {
    const at0 = local.get(v);
    if (at0 !== undefined) return at0;
    const at = params.length + locals.length;
    locals.push(value(v, `value ${v}`));
    local.set(v, at);
    return at;
  };
  const pushDefault = (t: WT): void => {
    if (t === "any") emit({ op: "const.undef" });
    else if (t === "f64") emit({ op: "const.f64", x: Number.NaN });
    else if (t === "i32") emit({ op: "const.i32", x: 0 });
    else if (t === "nums") emit({ op: "nums.of", n: 0 });
    else if (t === "arr") emit({ op: "arr.of", n: 0 });
    else if (t === "obj") {
      emit({ op: "const.undef" }, { op: "call", fn: mod.primitive("__ykObjNew").fn });
    } else emit({ op: "const.str", s: "" });
  };
  /** An error of a class (new Error(m), or Error(m)): the runtime atom. */
  const makeError = (cls: string, message: ValueId | undefined): void => {
    emit({ op: "const.str", s: cls });
    if (message === undefined) emit({ op: "const.undef" });
    else push(message, "any");
    emit({ op: "call", fn: mod.atom("__ykMakeError").fn });
  };
  /** Push a string constant: its UTF-16 units, as a new array. */
  const pushText = (text: string): void => {
    emit({ op: "const.str", s: text });
  };
  /**
   * Push a value as a string, as ECMAScript's ToString: a string is itself, a number is
   * Number::toString (the runtime atom), a boolean is "true" or "false".
   */
  const pushString = (v: ValueId): void => {
    const t = opType(v);
    if (t === "any") {
      push(v, "any");
      emit({ op: "call", fn: mod.atom("__ykToString").fn });
      return;
    }
    if (typeof t !== "string" || t === "undef")
      throw new LoweringError("a value made a string has no value here");
    if (t === "str") push(v);
    else if (t === "f64") call(mod.atom("__ykNumberToString"), [v], "ToString");
    else if (t === "i32") {
      pushText("true");
      pushText("false");
      push(v);
      select("str");
    } else if (t === "obj") call(mod.atom("__ykObjToString"), [v], "ToString");
    else call(mod.atom(t === "nums" ? "__ykJoinNums" : "__ykJoinAny"), [v], "ToString");
  };
  /** Push a value; `want` is the type it is used as (an undefined stands for that type's default). */
  /**
   * Push a value. `orDefault`: where a value is chosen (a select, a join, a carry's start), an
   * undefined stands for the default of the chosen type; it is never observed there, because what
   * chooses it is the lowering's own return state. Anywhere else undefined is refused.
   */
  const push = (v0: ValueId, want?: WT): WT => {
    const got = pushRaw(v0, want);
    if (want !== undefined && got !== want) convert(got, want, "a value");
    return want ?? got;
  };
  /**
   * Convert the value on the stack between representations: into a value of any kind (a number
   * boxed, a boolean an i31), out of one as the kind its type says it is, and a boolean to a number.
   */
  const convert = (got: WT, want: WT, what: string): void => {
    if (want === "any") {
      if (got !== "any") emit({ op: "to.any", from: got });
      return;
    }
    if (got === "any") {
      emit({ op: "from.any", to: want });
      return;
    }
    if (got === "i32" && want === "f64") {
      emit({ op: "f64.of.i32" });
      return;
    }
    throw new LoweringError(
      `${what} is ${got === "str" ? "a string" : "not a string"}, and a ${want === "str" ? "string" : "number"} is needed`,
    );
  };
  /** Push a value as it is held; an undefined pushes `want`'s default (undefined for any). */
  const pushRaw = (v0: ValueId, orDefault?: WT): WT => {
    const v = resolve(v0);
    const t = ty(v);
    if (t === "undef") {
      if (orDefault === undefined) throw new LoweringError("undefined is used as a value");
      pushDefault(orDefault);
      return orDefault;
    }
    if (typeof t === "object") throw new LoweringError("a function is used as a value");
    const p = producer.get(v);
    if (p?.kind === "literal-source") {
      const text = p.label ?? "";
      if (text === "null") emit({ op: "const.null" });
      else if (t === "i32") emit({ op: "const.i32", x: text === "true" ? 1 : 0 });
      else if (t === "str") emit({ op: "const.str", s: JSON.parse(text) as string });
      else {
        const n = Number(text.replace(/_/g, ""));
        if (Number.isNaN(n) && text !== "NaN")
          throw new LoweringError(`the literal ${text} is not a number`);
        emit({ op: "const.f64", x: n });
      }
      return t;
    }
    if (p?.kind === "diamond-source" && AMBIENT_NUMBERS[p.diamond?.symbol ?? ""] !== undefined) {
      emit({ op: "const.f64", x: AMBIENT_NUMBERS[p.diamond?.symbol ?? ""] as number });
      return "f64";
    }
    if (
      p?.kind === "op" &&
      /^\.\w+$/.test(p.label ?? "") &&
      typeof ty(p.inputs[0] as ValueId) === "object"
    ) {
      emit({ op: "const.f64", x: MATH_CONSTANTS[(p.label ?? "").slice(1)] as number });
      return "f64";
    }
    emit({ op: "get", i: localOf(v) });
    return t;
  };
  /** Push a value as the parameter type `want`: a boolean converts to a number, as ToNumber does. */
  const pushAs = (v: ValueId, want: WT, what: string): void => {
    const got = pushRaw(v, want);
    if (got !== want) convert(got, want, what);
  };
  /**
   * Push a value as a number, as ECMAScript's ToNumber: a number is itself, a boolean is 0 or 1, a
   * string is StringToNumber (the runtime atom), an array of numbers is its join made a number.
   */
  const pushNumber = (v: ValueId): void => {
    const t = opType(v);
    if (t === "any") {
      push(v, "any");
      emit({ op: "call", fn: mod.atom("__ykToNumber").fn });
      return;
    }
    if (typeof t !== "string" || t === "undef")
      throw new LoweringError("a value made a number has no value here");
    if (t === "str") call(mod.atom("__ykStringToNumber"), [v], "ToNumber");
    else if (t === "nums" || t === "arr" || t === "obj") {
      const prim = { nums: "__ykJoinNums", arr: "__ykJoinAny", obj: "__ykObjToString" }[t];
      call(mod.atom(prim), [v], "ToNumber");
      emit({ op: "call", fn: mod.atom("__ykStringToNumber").fn });
    } else pushAs(v, "f64", "an operand");
  };
  /** Push a value's truthiness as an i32 (nonzero is true). */
  const truthy = (v: ValueId): void => {
    if (opType(v) === "any") {
      push(v, "any");
      emit({ op: "call", fn: mod.atom("__ykTruthy").fn });
      return;
    }
    const t = push(v);
    if (t === "i32") return;
    if (t === "str") {
      emit({ op: "str.len" });
      return;
    }
    if (t === "nums" || t === "arr" || t === "obj") {
      // An array is an object, and an object is always truthy.
      emit({ op: "drop", t }, { op: "const.i32", x: 1 });
      return;
    }
    emit({ op: "const.f64", x: 0 }, { op: "f64", name: "ne" });
    push(v);
    push(v);
    emit({ op: "f64", name: "eq" }, { op: "i32", name: "and" });
  };
  const set = (v: ValueId): void => {
    emit({ op: "set", i: localOf(v) });
  };
  const select = (t: WT): void => {
    // A reference is chosen by a typed select.
    emit({ op: "select", t });
  };
  const call = (
    target: { fn: string; params: readonly WT[] },
    args: readonly (ValueId | number)[],
    what: string,
  ): void => {
    target.params.forEach((pt, i) => {
      const a = args[i];
      if (typeof a === "number") emit({ op: "const.f64", x: a });
      else if (a === undefined)
        throw new LoweringError(`${what} needs ${target.params.length} arguments`);
      else pushAs(a, pt, `argument ${i + 1} of ${what}`);
    });
    emit({ op: "call", fn: target.fn });
  };

  const emitNode = (n: DucNode): void => {
    if (n.kind === "literal-source" || n.kind === "param-source" || n.kind === "carry-source")
      return;
    if (n.kind === "diamond-source") return;
    const out = n.outputs[0] as ValueId | undefined;
    if (out === undefined) throw new LoweringError(`"${n.label}" has no result`);
    const t = ty(out);
    // A function, or undefined: nothing to compute, only what uses it.
    if (typeof t === "object" || t === "undef") return;
    const label = n.label ?? "";
    const ins = n.inputs as readonly ValueId[];
    if (n.kind === "sel") {
      const [c, a, b] = ins as [ValueId, ValueId, ValueId];
      push(a, t);
      push(b, t);
      truthy(c);
      select(t);
      set(out);
      return;
    }
    if (n.kind !== "op") throw new LoweringError(`a ${n.kind} node is not in the subset`);
    if (/^\.\w+$/.test(label) && ins.length === 1) {
      const t0 = ty(ins[0] as ValueId);
      if (typeof t0 === "object") return; // a Math constant, pushed where it is used
      if (t0 === "str" && label === ".length") {
        push(ins[0] as ValueId);
        emit({ op: "str.len" }, { op: "f64.of.i32" });
        set(out);
        return;
      }
      if ((t0 === "nums" || t0 === "arr") && label === ".length") {
        push(ins[0] as ValueId);
        emit({ op: t0 === "nums" ? "nums.len" : "arr.len" }, { op: "f64.of.i32" });
        set(out);
        return;
      }
      if (t0 === "obj" || t0 === "any" || t0 === "undef") {
        // A property of an object or any value: its own, else what an error inherits; lengths;
        // a TypeError for undefined and null.
        push(ins[0] as ValueId, "any");
        emit({ op: "const.str", s: label.slice(1) });
        emit({ op: "call", fn: mod.atom("__ykGetAny").fn });
        set(out);
        return;
      }
    }
    if (label.startsWith("object:")) {
      // An empty object, then each property put in order (a later one replaces an earlier one).
      const keys = JSON.parse(label.slice("object:".length)) as string[];
      emit({ op: "const.undef" }, { op: "call", fn: mod.primitive("__ykObjNew").fn });
      set(out);
      keys.forEach((k, i) => {
        push(out);
        emit({ op: "const.str", s: k });
        push(ins[i] as ValueId, "any");
        emit({ op: "call", fn: mod.atom("__ykPut").fn }, { op: "drop", t: "obj" });
      });
      return;
    }
    if (/^\.\w+=$/.test(label) && ins.length === 2) {
      push(ins[0] as ValueId, "obj");
      emit({ op: "const.str", s: label.slice(1, -1) });
      push(ins[1] as ValueId, "any");
      emit({ op: "call", fn: mod.atom("__ykPut").fn });
      set(out);
      return;
    }
    if (label === "NewExpression") {
      const callee = (ty(ins[0] as ValueId) as { call: Callee }).call as { name: string };
      makeError(callee.name, ins[1]);
      set(out);
      return;
    }
    if (label === "CallExpression") {
      const callee = (ty(ins[0] as ValueId) as { call: Callee }).call;
      const args = ins.slice(1);
      if (callee.k === "math") {
        const m = callee.name;
        if (NATIVE_MATH.has(m) && args.length === 1) {
          pushNumber(args[0] as ValueId);
          emit({ op: "f64", name: m as F64Op });
        } else if ((m === "min" || m === "max") && args.length >= 1) {
          pushNumber(args[0] as ValueId);
          for (const a of args.slice(1)) {
            pushNumber(a);
            emit({ op: "f64", name: m });
          }
        } else {
          const fn = mod.host(`Math.${m}`, args.length);
          for (const a of args) pushNumber(a);
          emit({ op: "call", fn });
        }
      } else if (callee.k === "error-class") {
        makeError(callee.name, args[0]);
      } else if (callee.k === "number-of") {
        if (args.length === 0) emit({ op: "const.f64", x: 0 });
        else pushNumber(args[0] as ValueId);
      } else if (callee.k === "string-of") {
        if (args.length === 0) pushText("");
        else pushString(args[0] as ValueId);
      } else if (callee.k === "method" && callee.name === "toString") {
        if (args.length > 0)
          throw new LoweringError("toString with a radix is not in the subset yet");
        pushString(callee.recv);
      } else if (callee.k === "method" && callee.name === "nums.push") {
        if (args.length !== 1)
          throw new LoweringError("push of other than one value is not in the subset yet");
        call(mod.primitive("numsPush"), [callee.recv, args[0] as ValueId], "push");
      } else if (callee.k === "method" && callee.name === "nums.pop") {
        call(mod.primitive(trusted ? "numsPop" : "numsPopAny"), [callee.recv], "pop");
      } else if (callee.k === "method" && callee.name === "arr.push") {
        if (args.length !== 1)
          throw new LoweringError("push of other than one value is not in the subset yet");
        call(mod.primitive("arrPush"), [callee.recv, args[0] as ValueId], "push");
      } else if (callee.k === "method" && callee.name === "arr.pop") {
        call(mod.primitive("arrPop"), [callee.recv], "pop");
      } else if (callee.k === "prim") call(mod.primitive(callee.name), args, callee.name);
      else if (callee.k === "atom") call(mod.atom(callee.name), args, callee.name);
      else if (callee.k === "closure") {
        const sig = closureSignature(callee.node, args) as WT[];
        const { fn } = mod.closure(callee.node.closure as DucGraph, sig, trusted);
        const given = [...(callee.node.inputs as readonly ValueId[]), ...args];
        sig.forEach((t, i) => {
          const v = given[i];
          if (v === undefined) emit({ op: "const.undef" });
          else push(v, t);
        });
        emit({ op: "call", fn });
      } else {
        const m = STRING_METHODS[callee.name] as (typeof STRING_METHODS)[string];
        const atom = mod.atom(m.atom);
        const given: (ValueId | number)[] = [callee.recv];
        m.args.forEach((d, i) => {
          const a = args[i];
          if (a !== undefined) given.push(a);
          else if (d === "str")
            throw new LoweringError(`.${callee.name} without a string to search for`);
          else given.push(d);
        });
        call(atom, given, `.${callee.name}`);
        if (m.notFound === true) emit({ op: "const.f64", x: -1 }, { op: "f64", name: "ne" });
      }
      set(out);
      return;
    }
    if (ins.length === 2 && label === "+" && t === "any") {
      push(ins[0] as ValueId, "any");
      push(ins[1] as ValueId, "any");
      emit({ op: "call", fn: mod.atom("__ykAdd").fn });
      set(out);
      return;
    }
    if (ins.length === 2 && label === "+" && t === "str") {
      pushString(ins[0] as ValueId);
      pushString(ins[1] as ValueId);
      emit({ op: "call", fn: mod.primitive("__ykJoin").fn });
      set(out);
      return;
    }
    if (label === "ArrayLiteral") {
      if (t === "nums") {
        for (const v of ins) pushNumber(v);
        emit({ op: "nums.of", n: ins.length });
      } else {
        for (const v of ins) push(v, "any");
        emit({ op: "arr.of", n: ins.length });
      }
      set(out);
      return;
    }
    if (label === "ElementAccess") {
      const of = opType(ins[0] as ValueId);
      if (of === "obj") {
        // An object's property by a computed key: the key made a string (ToPropertyKey).
        push(ins[0] as ValueId, "any");
        pushString(ins[1] as ValueId);
        emit({ op: "call", fn: mod.atom("__ykGetAny").fn });
        set(out);
        return;
      }
      if (of === "str" || of === "any") {
        // A string's unit, or any value's element: the runtime atom.
        push(ins[0] as ValueId, "any");
        pushNumber(ins[1] as ValueId);
        emit({ op: "call", fn: mod.atom("__ykIndex").fn });
        set(out);
        return;
      }
      const prim = of === "arr" ? "arrAt" : t === "any" ? "numsAt" : "numsGet";
      call(mod.primitive(prim), ins, "an element read");
      set(out);
      return;
    }
    if (label === "[]=" && t === "obj") {
      push(ins[0] as ValueId);
      pushString(ins[1] as ValueId);
      push(ins[2] as ValueId, "any");
      emit({ op: "call", fn: mod.atom("__ykPut").fn });
      set(out);
      return;
    }
    if (label === "[]=") {
      call(mod.primitive(t === "arr" ? "arrSet" : "numsSet"), ins, "an element write");
      set(out);
      return;
    }
    if (label.startsWith("template:")) {
      const texts = JSON.parse(label.slice("template:".length)) as string[];
      const join = mod.primitive("__ykJoin").fn;
      pushText(texts[0] ?? "");
      ins.forEach((v, i) => {
        pushString(v);
        emit({ op: "call", fn: join });
        pushText(texts[i + 1] ?? "");
        emit({ op: "call", fn: join });
      });
      set(out);
      return;
    }
    if (ins.length === 2 && F64_BINARY[label] !== undefined) {
      pushNumber(ins[0] as ValueId);
      pushNumber(ins[1] as ValueId);
      emit({ op: "f64", name: F64_BINARY[label] as F64Op });
      set(out);
      return;
    }
    if (ins.length === 2 && (label === "%" || label === "**")) {
      const fn = mod.host(label, 2);
      pushNumber(ins[0] as ValueId);
      pushNumber(ins[1] as ValueId);
      emit({ op: "call", fn });
      set(out);
      return;
    }
    if (ins.length === 2 && F64_COMPARE[label] !== undefined) {
      const [a, b] = ins as [ValueId, ValueId];
      const equality = /^[!=]==?$/.test(label);
      const negated = label.startsWith("!");
      if (opType(a) === "any" || opType(b) === "any") {
        // A value of any kind: ECMAScript's comparisons, as the runtime atoms. __ykCompare is 0
        // when its first is less, 1 when not, 2 when either is NaN: a > b is b < a, a <= b is
        // b is not less than a, a >= b is a is not less than b.
        if (equality) {
          push(a, "any");
          push(b, "any");
          const strictly = label === "===" || label === "!==";
          emit({ op: "call", fn: mod.atom(strictly ? "__ykStrictEquals" : "__ykLooseEquals").fn });
          if (negated) emit({ op: "i32", name: "eqz" });
        } else {
          const swap = label === ">" || label === "<=";
          push(swap ? b : a, "any");
          push(swap ? a : b, "any");
          emit({ op: "call", fn: mod.atom("__ykCompare").fn });
          emit(
            { op: "const.f64", x: label === "<" || label === ">" ? 0 : 1 },
            { op: "f64", name: "eq" },
          );
        }
        set(out);
        return;
      }
      const ta = value(a, "an operand");
      const tb = value(b, "an operand");
      // ECMAScript's IsStrictlyEqual, IsLooselyEqual and IsLessThan over these types. An array of
      // numbers is an object: equal only to itself, and a primitive (its join) where one is needed.
      const strictly = label === "===" || label === "!==";
      const strLike = (t: WT) => t === "str" || t === "nums" || t === "arr" || t === "obj";
      if (ta === tb && equality) {
        if (ta === "str") call(mod.atom("__ykStrEquals"), [a, b], label);
        else {
          push(a);
          push(b);
          emit(
            ta === "nums" || ta === "arr" || ta === "obj" || ta === "any"
              ? { op: "ref.eq" }
              : ta === "i32"
                ? { op: "i32", name: "eq" }
                : { op: "f64", name: "eq" },
          );
        }
        if (negated) emit({ op: "i32", name: "eqz" });
      } else if (equality && strictly) {
        emit({ op: "const.i32", x: negated ? 1 : 0 });
      } else if (equality && strLike(ta) && strLike(tb)) {
        // A string and an array: the array's join, compared as a string.
        pushString(a);
        pushString(b);
        emit({ op: "call", fn: mod.atom("__ykStrEquals").fn });
        if (negated) emit({ op: "i32", name: "eqz" });
      } else if (!equality && strLike(ta) && strLike(tb)) {
        // Both primitives are strings: compared by code units. a > b is b < a; a <= b is !(b < a);
        // a >= b is !(a < b).
        const swap = label === ">" || label === "<=";
        pushString(swap ? b : a);
        pushString(swap ? a : b);
        emit({ op: "call", fn: mod.atom("__ykStrLess").fn });
        if (label === "<=" || label === ">=") emit({ op: "i32", name: "eqz" });
      } else {
        pushNumber(a);
        pushNumber(b);
        emit({ op: "f64", name: F64_COMPARE[label] as F64Op });
      }
      set(out);
      return;
    }
    if (ins.length === 1 && label === "-") {
      pushNumber(ins[0] as ValueId);
      emit({ op: "f64", name: "neg" });
      set(out);
      return;
    }
    if (ins.length === 1 && label === "+") {
      pushNumber(ins[0] as ValueId);
      set(out);
      return;
    }
    if (label === "TypeOfExpression") {
      const t0 = opType(ins[0] as ValueId);
      if (t0 === "any") {
        push(ins[0] as ValueId, "any");
        emit({ op: "call", fn: mod.atom("__ykTypeOf").fn });
      } else {
        const names: Record<string, string> = {
          f64: "number",
          i32: "boolean",
          str: "string",
          nums: "object",
          arr: "object",
          obj: "object",
          undef: "undefined",
        };
        const name0 = typeof t0 === "string" ? names[t0] : undefined;
        if (name0 === undefined) throw new LoweringError("typeof of a function");
        pushText(name0);
      }
      set(out);
      return;
    }
    if (label === "??" && ins.length === 2) {
      const [a, b] = ins as [ValueId, ValueId];
      const ta = opType(a);
      if (ty(a) === "undef") push(b, t as WT);
      else if (ta !== "any") push(a, t as WT);
      else {
        // a when it is neither undefined nor null (its kind is 2 or more), else b.
        push(a, t as WT);
        push(b, t as WT);
        push(a, "any");
        emit(
          { op: "call", fn: mod.primitive("__ykTag").fn },
          { op: "const.f64", x: 2 },
          { op: "f64", name: "ge" },
        );
        select(t as WT);
      }
      set(out);
      return;
    }
    if (ins.length === 1 && label === "!") {
      truthy(ins[0] as ValueId);
      emit({ op: "i32", name: "eqz" });
      set(out);
      return;
    }
    if (ins.length === 2 && (label === "&&" || label === "||")) {
      const [a, b] = ins as [ValueId, ValueId];
      if (label === "&&") {
        push(b, t as WT);
        push(a, t as WT);
      } else {
        push(a, t as WT);
        push(b, t as WT);
      }
      truthy(a);
      select(t as WT);
      set(out);
      return;
    }
    throw new LoweringError(`the operation "${label}" is not in the subset`);
  };

  const { itemsOf, ordered, needsOf, producesOf } = scopePlanner(
    g,
    owners,
    resolve,
    (m) => new LoweringError(m),
    after,
  );
  const emitItems = (items: readonly ScopeItem[]): void => {
    for (const it of items) {
      if (it.kind === "node") emitNode(it.node);
      else if (it.kind === "branch") emitBranch(it.branch);
      else emitLoop(it.node);
    }
  };
  const emitScope = (scope: string | undefined): void => emitItems(ordered(itemsOf(scope)));
  /** Set a value from another, when it has a value at all (a join of two undefineds has none). */
  const assign = (v: ValueId, from: ValueId): void => {
    const t = ty(v);
    if (typeof t === "object" || t === "undef") return;
    push(from, t);
    set(v);
  };
  const emitBranch = (b: DucBranch): void => {
    const joins = g.nodes.filter((n) => owners.get(n.id)?.id === b.id);
    truthy(b.cond);
    emit({ op: "if" });
    emitScope(sidePath(b, "t"));
    for (const j of joins) assign(j.outputs[0] as ValueId, j.inputs[1] as ValueId);
    emit({ op: "else" });
    emitScope(sidePath(b, "e"));
    for (const j of joins) assign(j.outputs[0] as ValueId, j.inputs[2] as ValueId);
    emit({ op: "end" });
  };
  const emitLoop = (loop: DucNode): void => {
    const rec = loop.loop as DucLoop;
    const body = bodyPathOf(loop);
    rec.carry.forEach((c, i) => assign(c, loop.inputs[i] as ValueId));
    emit({ op: "block" }, { op: "loop" });
    const items = ordered(itemsOf(body));
    const forCond = new Set<ScopeItem>();
    const want = [resolve(rec.cond as ValueId)];
    const producedBy = new Map<ValueId, ScopeItem>();
    for (const it of items) for (const v of producesOf(it)) producedBy.set(v, it);
    while (want.length > 0) {
      const v = want.pop() as ValueId;
      const it = producedBy.get(v);
      if (it === undefined || forCond.has(it)) continue;
      forCond.add(it);
      want.push(...needsOf(it));
    }
    emitItems(items.filter((it) => forCond.has(it)));
    truthy(rec.cond as ValueId);
    emit({ op: "i32", name: "eqz" }, { op: "br_if", depth: 1 });
    emitItems(items.filter((it) => !forCond.has(it)));
    // The next carries, computed together, then assigned.
    const live = rec.carry
      .map((c, i) => ({ c, next: rec.next[i] as ValueId, t: ty(c) }))
      .filter((x) => typeof x.t === "string" && x.t !== "undef");
    for (const x of live) push(x.next, x.t as WT);
    for (const x of [...live].reverse()) set(x.c);
    emit({ op: "br", depth: 0 }, { op: "end" }, { op: "end" });
    loop.outputs.forEach((v, i) => assign(v, rec.carry[i] as ValueId));
  };

  emitScope(undefined);
  // The result as the contract types it: a value of any kind is read as the kind it says.
  const computed = opType(g.obs[0] as ValueId);
  if (typeof computed !== "string" || computed === "undef")
    throw new LoweringError("the result has no value here");
  const result = declared ?? computed;
  if (
    result !== computed &&
    computed !== "any" &&
    result !== "any" &&
    !(computed === "arr" && result === "nums")
  )
    throw new LoweringError(
      `the result is ${show(computed)}, and the contract says ${show(result)}`,
    );
  if (computed === "arr" && result === "nums") {
    // The contract's array of numbers, from an array that held values of any kind: a new one, each
    // element read as a number (nothing else holds the array once it is returned).
    push(g.obs[0] as ValueId, "arr");
    emit({ op: "call", fn: mod.atom("__ykArrToNums").fn });
  } else push(g.obs[0] as ValueId, result);
  return { result, locals, code };
}
