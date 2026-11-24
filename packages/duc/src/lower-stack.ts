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
  ARRAY_FN_ATOMS,
  BIGNUM_ATOMS,
  DYNAMIC_ATOMS,
  JSON_ATOMS,
  RUNTIME_ATOMS,
  type RuntimeAtom,
} from "./wasm-runtime-atoms.js";

/**
 * A closure's typing found something other than a number stored in arrays it was given as arrays of
 * numbers (its parameters at these indices): its caller grows what it passed, and types again.
 */
class GrowParams extends Error {
  /** Each a parameter's index, then, inside a function passed as it is, its captures' indices. */
  constructor(readonly paths: readonly (readonly number[])[]) {
    super("parameters to grow");
  }
}

/** What a program threw, uncaught, as its caller sees it: the thrown value. */
export class Thrown {
  constructor(readonly value: unknown) {}
}

/**
 * A JavaScript object as the bytecode targets hold one: its own keys and values, in order, and the
 * class an error inherits its name from (an error's own properties but its stack).
 */
export function jsObjectParts(o: object): { keys: string[]; vals: unknown[]; cls?: string } {
  if (o instanceof Error) {
    const keys = Object.getOwnPropertyNames(o).filter((k) => k !== "stack");
    const vals = keys.map((k) => (o as unknown as Record<string, unknown>)[k]);
    return { keys, vals, cls: (Object.getPrototypeOf(o) as { name: string }).name };
  }
  return { keys: Object.keys(o), vals: Object.values(o) };
}

/** A JavaScript object from its parts: an error of the class, when it has one. */
export function jsObjectFrom(
  keys: readonly string[],
  vals: readonly unknown[],
  cls?: unknown,
): object {
  let o: Record<string, unknown> = {};
  if (typeof cls === "string") {
    const C = (globalThis as Record<string, unknown>)[cls];
    const e =
      typeof C === "function" && (C === Error || C.prototype instanceof Error)
        ? (new (C as ErrorConstructor)() as unknown as Record<string, unknown>)
        : (Object.assign(new Error(), { name: cls }) as unknown as Record<string, unknown>);
    o = e;
  }
  keys.forEach((k, i) => {
    o[k] = vals[i];
  });
  return o;
}

/** A graph outside what the lowering covers, with the reason. A target rethrows it as its own. */
export class LoweringError extends Error {}

/** Every runtime atom the lowering can call, by name. */
export const ATOMS: Readonly<Record<string, RuntimeAtom>> = {
  ...RUNTIME_ATOMS,
  ...BIGNUM_ATOMS,
  ...DYNAMIC_ATOMS,
  ...ARRAY_FN_ATOMS,
  ...JSON_ATOMS,
};

/**
 * A value's type: a number, a boolean, a string, an array of numbers, or a value of any of these
 * kinds or undefined or null.
 */
export type WT = "f64" | "i32" | "str" | "nums" | "arr" | "obj" | "any";

/**
 * A parameter's type: a value's, or a function the caller passes as it is: a closure's graph and
 * the types of what it captures. Such a parameter is its captures, as parameters of their types;
 * calling it calls the closure's function directly.
 */
export type PT = WT | FnArg;
export interface FnArg {
  readonly fn: DucGraph;
  readonly caps: readonly PT[];
}
/** A parameter's value types, as the function takes them: a function's are its captures'. */
export const flatPT = (t: PT): WT[] => (typeof t === "string" ? [t] : t.caps.flatMap(flatPT));
const paramCount = (g: DucGraph): number => g.nodes.filter((n) => n.kind === "param-source").length;

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
  | {
      readonly op: "i32";
      readonly name: "eqz" | "and" | "eq" | "or" | "xor" | "shl" | "shr_s" | "shr_u";
    }
  /** A number that is a 32-bit integer, as one; and a 32-bit integer read as unsigned. */
  | { readonly op: "i32.of.f64" }
  | { readonly op: "f64.of.u32" }
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
  | { readonly op: "br_if"; readonly depth: number }
  /**
   * Exceptions: `throw` throws the value of any kind on the stack; `try` ... `catch` ... `end` runs
   * its first part, and when that throws, the second with the thrown value on the stack. Neither
   * part leaves a value.
   */
  | { readonly op: "throw" }
  | { readonly op: "try" }
  | { readonly op: "catch" };

/** The array methods that take a function: each a runtime atom, lowered once per callback. */
const ARRAY_FN_METHODS: ReadonlySet<string> = new Set([
  "map",
  "filter",
  "forEach",
  "some",
  "every",
  "find",
  "findIndex",
  "reduce",
]);
/** The atom of an array method that takes a function, for the array's kind and arguments. */
const arrayFnAtom = (kind: "nums" | "arr", method: string, nargs: number): string => {
  const name = `${method[0]?.toUpperCase()}${method.slice(1)}`;
  const init = method === "reduce" && nargs >= 2 ? "Init" : "";
  return `__yk${name}${init}${kind === "nums" ? "Nums" : "Any"}`;
};

/**
 * A builtin used as a function value, as the closure of the call it means: the source of that
 * closure, or undefined when the builtin is not one of these (a variadic Math function's meaning
 * depends on how many arguments it is given, so it is not).
 */
function builtinSource(c: Callee): string | undefined {
  const one = (call: string): string => `export function f(x: unknown) { return ${call}; }`;
  if (c.k === "string-of") return one("String(x)");
  if (c.k === "number-of") return one("Number(x)");
  if (c.k === "boolean-of") return one("Boolean(x)");
  if (c.k === "math" && (NATIVE_MATH.has(c.name) || UNARY_HOST_MATH.has(c.name)))
    return one(`Math.${c.name}(x as number)`);
  return undefined;
}
const UNARY_HOST_MATH: ReadonlySet<string> = new Set([
  "round",
  "sign",
  "exp",
  "expm1",
  "log",
  "log1p",
  "log2",
  "log10",
  "sin",
  "cos",
  "tan",
  "asin",
  "acos",
  "atan",
  "sinh",
  "cosh",
  "tanh",
  "asinh",
  "acosh",
  "atanh",
  "cbrt",
  "fround",
]);
const builtinGraphs = new Map<string, DucGraph>();
/** A builtin's closure graph, lifted once (its operations as ECMAScript's). */
function builtinGraph(source: string): DucGraph {
  let g = builtinGraphs.get(source);
  if (g === undefined) {
    g = ecmaScriptView(liftAtom(source));
    builtinGraphs.set(source, g);
  }
  return g;
}

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
/** The bitwise operators: their operands are ToInt32's (a shift's count ToUint32's, mod 32). */
const BITWISE: Readonly<Record<string, "and" | "or" | "xor" | "shl" | "shr_s" | "shr_u">> = {
  "&": "and",
  "|": "or",
  "^": "xor",
  "<<": "shl",
  ">>": "shr_s",
  ">>>": "shr_u",
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
  // Undefined as a value (in an atom a literal undefined stands for a default).
  __ykUndef: { params: [], result: "any" },
  // An object: a cast to one, an empty one of a class (a string, or not one for a plain object),
  // its keys and its values (arrays, shared, in insertion order), and its class.
  __ykObj: { params: ["any"], result: "obj" },
  __ykObjNew: { params: ["any"], result: "obj" },
  __ykObjKeys: { params: ["obj"], result: "arr" },
  __ykObjVals: { params: ["obj"], result: "arr" },
  __ykObjCls: { params: ["obj"], result: "any" },
  __ykSame: { params: ["any", "any"], result: "i32" },
  // A function value (tag 8): its trampoline's id and its captures; made, and read.
  __ykFnNew: { params: ["f64", "arr"], result: "any" },
  __ykFnId: { params: ["any"], result: "f64" },
  __ykFnCaps: { params: ["any"], result: "arr" },
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
      const lowered = topLevel(() => lowerFunction(atomGraph(key), params, result, this, true));
      f.locals = lowered.locals;
      f.code = lowered.code;
    }
    return { fn: fkey, params, result };
  }

  /**
   * A closure's function, for one signature: its captures, then its parameters. Lowered once per
   * signature, the first time a call needs it; its result type is the lowering's.
   */
  private graphId(graph: DucGraph): number {
    let id = this.graphIds.get(graph);
    if (id === undefined) {
      id = this.nextGraphId++;
      this.graphIds.set(graph, id);
    }
    return id;
  }
  private ptKey(t: PT): string {
    return typeof t === "string"
      ? t
      : `fn${this.graphId(t.fn)}(${t.caps.map((c) => this.ptKey(c)).join(",")})`;
  }
  /**
   * A runtime atom that takes functions (an array's map, filter, ...), for one signature: lowered
   * once per signature, each function passed as it is. Its result type is the lowering's.
   */
  atomWith(key: string, params: readonly PT[]): { fn: string; result: WT } {
    const fkey = `atom:${key}:${params.map((p) => this.ptKey(p)).join(",")}`;
    const known = this.funcs.get(fkey);
    if (known !== undefined) return { fn: fkey, result: known.result };
    if (!this.atoms.includes(key)) this.atoms.push(key);
    const lowered = lowerFunction(atomGraph(key), params, undefined, this, true);
    this.funcs.set(fkey, { kind: "lowered", params: params.flatMap(flatPT), ...lowered });
    return { fn: fkey, result: lowered.result };
  }
  closure(
    graph: DucGraph,
    params: readonly PT[],
    trusted: boolean,
    capCount = 0,
  ): { fn: string; result: WT } {
    const id = this.graphId(graph);
    const fkey = `closure:${id}:${params.map((p) => this.ptKey(p)).join(",")}`;
    const known = this.funcs.get(fkey);
    if (known !== undefined) return { fn: fkey, result: known.result };
    // A closure that calls itself returns a value of any kind: a call of it while it is being
    // lowered (for the same signature) knows its result type before its lowering ends.
    const recursive = graph.nodes.some((n) => n.kind === "op" && n.label === "function-self");
    if (this.lowering.has(fkey)) {
      if (recursive) return { fn: fkey, result: "any" };
      throw new LoweringError("a closure that calls itself is not in the subset yet");
    }
    this.lowering.add(fkey);
    try {
      const declared = recursive ? "any" : undefined;
      const lowered = lowerFunction(graph, params, declared, this, trusted, capCount);
      this.funcs.set(fkey, { kind: "lowered", params: params.flatMap(flatPT), ...lowered });
      return { fn: fkey, result: lowered.result };
    } finally {
      this.lowering.delete(fkey);
    }
  }

  /** The trampolines of function values, by id: each unpacks captures and arguments. */
  private readonly trampolines: string[] = [];
  private readonly trampolineIds = new Map<string, number>();
  /**
   * A function value's trampoline: for a closure with captures of these types, a function of its
   * captures and its arguments (arrays of any values) that calls the closure's function. Its id.
   */
  trampoline(graph: DucGraph, capTypes: readonly WT[], trusted: boolean): number {
    const key = `${this.graphId(graph)}:${capTypes.join(",")}`;
    const known = this.trampolineIds.get(key);
    if (known !== undefined) return known;
    const id = this.trampolines.length;
    const fkey = `tramp:${id}`;
    this.trampolines.push(fkey);
    this.trampolineIds.set(key, id);
    const at = this.primitive("arrAt").fn;
    const nargs = paramCount(graph) - capTypes.length;
    const sig: WT[] = [...capTypes, ...Array.from({ length: nargs }, () => "any" as const)];
    const { fn, result } = this.closure(graph, sig, trusted, capTypes.length);
    const code: Ins[] = [];
    capTypes.forEach((t, i) => {
      code.push({ op: "get", i: 0 }, { op: "const.f64", x: i }, { op: "call", fn: at });
      if (t !== "any") code.push({ op: "from.any", to: t });
    });
    for (let j = 0; j < nargs; j++)
      code.push({ op: "get", i: 1 }, { op: "const.f64", x: j }, { op: "call", fn: at });
    code.push({ op: "call", fn });
    if (result !== "any") code.push({ op: "to.any", from: result });
    this.funcs.set(fkey, {
      kind: "lowered",
      params: ["arr", "arr"],
      result: "any",
      locals: [],
      code,
    });
    return id;
  }
  /** The call of a value of any kind: a function value's trampoline, else a TypeError. */
  dynCall(): string {
    const fkey = "dyn:call";
    if (!this.funcs.has(fkey))
      this.funcs.set(fkey, {
        kind: "lowered",
        params: ["any", "arr"],
        result: "any",
        locals: [],
        code: [],
      });
    return fkey;
  }
  /** What can only be written once everything is lowered: the dispatch of function values. */
  finish(): void {
    const f = this.funcs.get("dyn:call");
    if (f === undefined || f.kind !== "lowered") return;
    const tag = this.primitive("__ykTag").fn;
    const code: Ins[] = [
      { op: "get", i: 0 },
      { op: "call", fn: tag },
      { op: "const.f64", x: 8 },
      { op: "f64", name: "ne" },
      { op: "if" },
      { op: "call", fn: this.atom("__ykNotAFunction").fn },
      { op: "drop", t: "any" },
      { op: "end" },
      { op: "get", i: 0 },
      { op: "call", fn: this.primitive("__ykFnId").fn },
      { op: "set", i: 2 },
      { op: "get", i: 0 },
      { op: "call", fn: this.primitive("__ykFnCaps").fn },
      { op: "set", i: 3 },
      { op: "const.undef" },
      { op: "set", i: 4 },
    ];
    this.trampolines.forEach((t, k) => {
      code.push(
        { op: "get", i: 2 },
        { op: "const.f64", x: k },
        { op: "f64", name: "eq" },
        { op: "if" },
        { op: "get", i: 3 },
        { op: "get", i: 1 },
        { op: "call", fn: t },
        { op: "set", i: 4 },
        { op: "end" },
      );
    });
    code.push({ op: "get", i: 4 });
    f.locals = ["f64", "arr", "any"];
    f.code = code;
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
 * A function no caller can retype: something other than a number stored in an array of numbers it
 * is given is outside its contract.
 */
function topLevel<T>(lower: () => T): T {
  try {
    return lower();
  } catch (e) {
    if (e instanceof GrowParams)
      throw new LoweringError(
        "something other than a number is stored in an array of numbers the function is given",
      );
    throw e;
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
  const lowered = topLevel(() => lowerFunction(ecmaScriptView(input), params, result, prog));
  f.locals = lowered.locals;
  f.code = lowered.code;
  prog.finish();
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
  | { readonly k: "boolean-of" }
  | { readonly k: "error-class"; readonly name: string }
  /** Object, and its keys, values and entries. */
  | { readonly k: "object-ns"; readonly name: string }
  /** JSON, and its stringify and parse. */
  | { readonly k: "json-ns"; readonly name: string }
  /** Array or Function: a class instanceof names, and Array.isArray. */
  | { readonly k: "class-ref"; readonly name: string }
  /** `__yakccTry(body, handler, finalizer)`: a try statement (#1276). */
  | { readonly k: "try" }
  | { readonly k: "method"; readonly recv: ValueId; readonly name: string }
  | { readonly k: "prim"; readonly name: string }
  | { readonly k: "atom"; readonly name: string }
  /** A closure the graph makes: called, it is its own function with its captures passed first. */
  | { readonly k: "closure"; readonly node: DucNode }
  /** A function the function was passed: its captures are its parameters from `base` on. */
  | { readonly k: "fnparam"; readonly arg: FnArg; readonly base: number; readonly index: number };

/** One function of the program, lowered from a graph. */
function lowerFunction(
  source: DucGraph,
  paramTypes: readonly PT[],
  declared: WT | undefined,
  mod: StackProgram,
  /**
   * A runtime atom: its element reads and writes are lowered, with undefined (out of range) standing
   * for a value it never observes. The atoms are tested against the builtins they define; a program
   * is not, so in a program an element read or write is refused for now.
   */
  trusted = false,
  /** A closure's: how many of its parameters are its captures (what a call of itself passes on). */
  capCount = 0,
): { result: WT; locals: WT[]; code: Ins[] } {
  if (source.mode !== undefined)
    throw new LoweringError(`an ${source.mode} function has no form here`);
  if (source.obs.length > 1) throw new LoweringError("the subset has at most one result");
  const { graph: g, after } = loweringView(source);
  const owners = joinOwners(g);
  const producer = new Map<ValueId, DucNode>();
  for (const n of g.nodes) for (const v of n.outputs) producer.set(v, n);

  const loops = g.nodes.filter((n) => n.kind === "loop");
  const alias = new Map<ValueId, ValueId>();
  const carryOf = new Map<ValueId, { loop: DucNode; i: number }>();
  /** Each iteration loop's element value (for-in, for-of): its loop. */
  const elementOf = new Map<ValueId, DucNode>();
  /** What an iteration loop iterates: the input after its carries (its invariants follow it). */
  const iterableOf = (loop: DucNode): ValueId => {
    const rec = loop.loop as DucLoop;
    return loop.inputs[rec.carry.length] as ValueId;
  };
  for (const loop of loops) {
    const rec = loop.loop as DucLoop;
    if (rec.iterate !== undefined) {
      if (rec.iterate.of !== "keys" && rec.iterate.of !== "values")
        throw new LoweringError(`iteration over ${rec.iterate.of} is not in the subset yet`);
      elementOf.set(rec.iterate.element as ValueId, loop);
    } else if (rec.cond === undefined) throw new LoweringError("a loop with no condition");
    // An iteration loop's iterable comes between its carries and its invariants.
    const skip = rec.carry.length + (rec.iterate !== undefined ? 1 : 0);
    rec.invariant.forEach((v, j) => alias.set(v, loop.inputs[skip + j] as ValueId));
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
  // Each parameter's first slot: a function's captures take one each.
  const slotStart: number[] = [];
  let nSlots = 0;
  for (const t of paramTypes) {
    slotStart.push(nSlots);
    nSlots += flatPT(t).length;
  }

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
  const sameCallee = (a: Callee, b: Callee): boolean =>
    a.k === b.k &&
    (a.k === "closure"
      ? a.node === (b as typeof a).node
      : a.k === "fnparam"
        ? a.index === (b as typeof a).index
        : JSON.stringify(a) === JSON.stringify(b));
  const unify = (a: VT | "?", b: VT | "?", what: string): VT | "?" => {
    if (a === "?") return b;
    if (b === "?") return a;
    if (typeof a === "object" || typeof b === "object") {
      if (typeof a === "object" && typeof b === "object" && sameCallee(a.call, b.call)) return a;
      // Two different functions, or a function and a value: a value of any kind (a function
      // value where a function is).
      if (
        (typeof a === "object" && a.call.k !== "closure" && a.call.k !== "fnparam") ||
        (typeof b === "object" && b.call.k !== "closure" && b.call.k !== "fnparam")
      )
        throw new LoweringError(`${what} mixes ${show(a)} and ${show(b)}`);
      return "any";
    }
    if (a === b) return a;
    if (trusted && a === "undef") return b;
    if (trusted && b === "undef") return a;
    return "any";
  };
  /** The empty array literals something other than a number is stored in. */
  const grown = new Set<ValueId>();
  /** The parameters (arrays of numbers) something other than a number is stored in. */
  const grownParams = new Set<number>();
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
    // An array the function was given: its caller grows it.
    if (p.kind === "param-source" && paramTypes[paramIndex(p.label)] === "nums")
      grownParams.add(paramIndex(p.label));
    if (p.kind === "op" && p.label === "[]=") return arrayOrigins(p.inputs[0] as ValueId, seen);
    return [];
  };
  /** A store of a value of type `t` in an array of numbers: a non-number grows its literals. */
  const stored = (arr: ValueId, t: VT | "?"): void => {
    if (t === "?" || t === "f64") return;
    for (const o of arrayOrigins(arr)) grown.add(o);
  };
  /**
   * A function known here: one the graph makes (a closure), or one the function was passed. Its
   * graph, its captures' types and values (a passed one's are its parameters), and how to push them.
   */
  interface Known {
    readonly fn: DucGraph;
    readonly caps: readonly PT[];
    readonly capValues: readonly ValueId[] | undefined;
    /** A passed function's parameter index. */
    readonly param?: number;
    readonly pushCaps: () => void;
  }
  const knowing = new Set<ValueId>();
  const known = (v0: ValueId): Known | "?" | undefined => {
    const v = resolve(v0);
    const t = get(v);
    if (t === "?") return "?";
    if (typeof t !== "object") return undefined;
    const c = t.call;
    if (c.k === "fnparam") {
      const base = c.base;
      const types = c.arg.caps.flatMap(flatPT);
      return {
        fn: c.arg.fn,
        caps: c.arg.caps,
        capValues: undefined,
        param: c.index,
        pushCaps: () => types.forEach((_, i) => emit({ op: "get", i: base + i })),
      };
    }
    // A builtin used as a function: a closure of the call it means (String, Number, Boolean, and
    // Math's one-argument functions), lifted once.
    const builtin = builtinSource(c);
    if (builtin !== undefined)
      return { fn: builtinGraph(builtin), caps: [], capValues: [], pushCaps: () => {} };
    if (c.k !== "closure") return undefined;
    if (knowing.has(v))
      throw new LoweringError("a closure that calls itself is not in the subset yet");
    knowing.add(v);
    try {
      const inputs = c.node.inputs as readonly ValueId[];
      const caps: PT[] = [];
      for (const x of inputs) {
        const pt = ptOf(x);
        if (pt === "?") return "?";
        caps.push(pt);
      }
      return {
        fn: c.node.closure as DucGraph,
        caps,
        capValues: inputs,
        pushCaps: () => inputs.forEach((x, i) => pushArg(x, caps[i] as PT)),
      };
    } finally {
      knowing.delete(v);
    }
  };
  /** A value's parameter type: undefined is a value of any kind; a known function is itself. */
  const ptOf = (v: ValueId): PT | "?" => {
    const t = get(v);
    if (t === "?") return "?";
    if (t === "undef") return "any";
    if (typeof t === "string") return t;
    const k = known(v);
    if (k === "?") return "?";
    if (k === undefined)
      throw new LoweringError("a function that is not a closure, passed as a value");
    return { fn: k.fn, caps: k.caps };
  };
  /** Push a value as a parameter of type `pt`: a function's captures, or the value. */
  const pushArg = (v: ValueId, pt: PT): void => {
    if (typeof pt === "string") push(v, pt);
    else (known(v) as Known).pushCaps();
  };
  /** A known function's signature for a call: its captures, then the arguments (missing: any). */
  const callSig = (k: Known, args: readonly ValueId[]): PT[] | "?" => {
    const count = paramCount(k.fn);
    const sig: PT[] = [...k.caps];
    for (let i = k.caps.length; i < count; i++) {
      const v = args[i - k.caps.length];
      if (v === undefined) {
        sig.push("any");
        continue;
      }
      const pt = ptOf(v);
      if (pt === "?") return "?";
      sig.push(pt);
    }
    return sig;
  };
  /**
   * A known function's result type for a signature: lowered, or, when it stores other than numbers
   * in arrays it was given as arrays of numbers, those arrays grown here ("?": typed again).
   */
  const knownResult = (k: Known, sig: PT[], args: readonly ValueId[]): VT | "?" => {
    try {
      return mod.closure(k.fn, sig, trusted, k.caps.length).result;
    } catch (e) {
      if (!(e instanceof GrowParams)) throw e;
      for (const path of e.paths) growAt(k, args, path);
      return "?";
    }
  };
  /**
   * Grow what a parameter of a known function's call came from: a path into its captures and
   * arguments, through functions passed as they are; a passed function's own captures are this
   * function's parameter, grown by its caller.
   */
  const growAt = (k: Known, args: readonly ValueId[], path: readonly number[]): void => {
    const [i, ...rest] = path as [number, ...number[]];
    // The function itself (param -1): its captures are its own parameters.
    if (i < k.caps.length && k.capValues === undefined)
      throw new GrowParams([k.param === -1 ? [i, ...rest] : [k.param as number, i, ...rest]]);
    const v = i < k.caps.length ? k.capValues?.[i] : args[i - k.caps.length];
    if (v === undefined) return;
    if (rest.length === 0) stored(v, "any");
    else {
      const inner = known(v);
      if (inner !== "?" && inner !== undefined) growAt(inner, [], rest);
    }
  };
  /**
   * An array method's atom signature: the array, the function passed as it is, and (reduce's)
   * initial value. "?" while a type is unknown.
   */
  const arrayFnSig = (
    callee: { recv: ValueId; name: string },
    args: readonly ValueId[],
  ): "?" | { kind: "nums" | "arr"; method: string; sig: PT[]; args: readonly ValueId[] } => {
    const [kind, method] = callee.name.split(".") as ["nums" | "arr", string];
    const used = args.slice(0, method === "reduce" ? 2 : 1);
    if (used.length === 0) throw new LoweringError(`.${method} without a function`);
    const sig: PT[] = [kind];
    for (const [i, a] of used.entries()) {
      const pt = ptOf(a);
      if (pt === "?") return "?";
      if (i === 0 && typeof pt === "string")
        throw new LoweringError(`.${method} of other than a closure is not in the subset yet`);
      sig.push(pt);
    }
    return { kind, method, sig, args: used };
  };
  /** Call a known function: its captures, then the arguments as its signature types them. */
  const callKnown = (callee: ValueId, args: readonly (ValueId | number)[]): WT => {
    const k = known(callee) as Known;
    const sig = callSig(
      k,
      args.filter((a): a is ValueId => typeof a !== "number"),
    ) as PT[];
    const { fn, result } = mod.closure(k.fn, sig, trusted, k.caps.length);
    k.pushCaps();
    for (let i = k.caps.length; i < sig.length; i++) {
      const a = args[i - k.caps.length];
      if (a === undefined) emit({ op: "const.undef" });
      else if (typeof a === "number") emit({ op: "get", i: a });
      else pushArg(a, sig[i] as PT);
    }
    emit({ op: "call", fn });
    return result;
  };
  /** The class an instanceof names: an error class, Object, Array or Function. */
  const instanceClass = (v: ValueId): string => {
    const t = get(v);
    if (typeof t === "object") {
      const c = t.call;
      if (c.k === "error-class") return c.name;
      if (c.k === "object-ns" && c.name === "") return "Object";
      if (c.k === "class-ref" && (c.name === "Array" || c.name === "Function")) return c.name;
    }
    throw new LoweringError("instanceof of other than a builtin class is not in the subset yet");
  };
  const computeType = (v: ValueId): VT | "?" => {
    const iterating = elementOf.get(v);
    if (iterating !== undefined) {
      // for-in's keys are strings; for-of's an array of numbers' numbers, a string's code points
      // (strings), anything else's values of any kind.
      if ((iterating.loop as DucLoop).iterate?.of === "keys") return "str";
      const it = get(iterableOf(iterating));
      if (it === "?") return "?";
      return it === "nums" ? "f64" : it === "str" ? "str" : "any";
    }
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
    if (p.kind === "param-source") {
      const i = paramIndex(p.label);
      const t = paramTypes[i] as PT;
      return typeof t === "string"
        ? t
        : { call: { k: "fnparam", arg: t, base: slotStart[i] as number, index: i } };
    }
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
      if (sym === "Object") return { call: { k: "object-ns", name: "" } };
      if (sym === "JSON") return { call: { k: "json-ns", name: "" } };
      if (sym === "Array" || sym === "Function") return { call: { k: "class-ref", name: sym } };
      if (sym === "String") return { call: { k: "string-of" } };
      if (sym === "Number") return { call: { k: "number-of" } };
      if (sym === "Boolean") return { call: { k: "boolean-of" } };
      if (ERROR_CLASSES.has(sym)) return { call: { k: "error-class", name: sym } };
      if (sym === "__yakccTry") return { call: { k: "try" } };
      if (PRIMITIVES[sym] !== undefined) return { call: { k: "prim", name: sym } };
      if (ATOMS[sym] !== undefined) return { call: { k: "atom", name: sym } };
      throw new LoweringError(`"${sym}" is not in the wasm base set`);
    }
    if (p.kind === "loop") return get((p.loop as DucLoop).carry[p.outputs.indexOf(v)] as ValueId);
    const ins = p.inputs as readonly ValueId[];
    if (p.kind === "sel" || owners.get(p.id) !== undefined)
      return unify(get(ins[1] as ValueId), get(ins[2] as ValueId), "a choice between two values");
    if (p.kind !== "op") throw new LoweringError(`a ${p.kind} node is not in the subset`);
    if (p.kind === "op" && p.label === "function-self") {
      // The function itself: its captures are its first parameters, passed on as they are.
      return {
        call: {
          k: "fnparam",
          arg: { fn: source, caps: paramTypes.slice(0, capCount) },
          base: 0,
          index: -1,
        },
      };
    }
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
      if (typeof t0 === "object" && t0.call.k === "class-ref") {
        if (t0.call.name !== "Array" || member !== "isArray")
          throw new LoweringError(`${t0.call.name}.${member} is not in the subset yet`);
        return { call: { k: "class-ref", name: "isArray" } };
      }
      if (typeof t0 === "object" && t0.call.k === "json-ns") {
        if (member !== "stringify" && member !== "parse")
          throw new LoweringError(`JSON.${member} is not in the subset yet`);
        return { call: { k: "json-ns", name: member } };
      }
      if (typeof t0 === "object" && t0.call.k === "object-ns") {
        if (member !== "keys" && member !== "values" && member !== "entries")
          throw new LoweringError(`Object.${member} is not in the subset yet`);
        return { call: { k: "object-ns", name: member } };
      }
      if (t0 === "nums" || t0 === "arr") {
        if (member === "length") return "f64";
        if (member === "push" || member === "pop" || ARRAY_FN_METHODS.has(member))
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
      // A call of a value of any kind: a function value's, else a TypeError.
      if (t0 === "any") return "any";
      if (typeof t0 !== "object")
        throw new LoweringError("a call of a value that is not a known function");
      const callee = t0.call;
      if (callee.k === "math") return "f64";
      if (callee.k === "string-of") return "str";
      if (callee.k === "boolean-of") return "i32";
      if (callee.k === "number-of") return "f64";
      if (callee.k === "error-class") return "obj";
      if (callee.k === "object-ns") return "arr";
      if (callee.k === "class-ref") return "i32";
      if (callee.k === "json-ns") {
        // A replacer or a reviver: not yet.
        const extra = ins[2];
        if (callee.name === "stringify" && extra !== undefined) {
          const te = get(extra);
          const p2 = producer.get(resolve(extra));
          if (te !== "undef" && p2?.label !== "null")
            throw new LoweringError("JSON.stringify with a replacer is not in the subset yet");
        }
        if (callee.name === "parse" && extra !== undefined)
          throw new LoweringError("JSON.parse with a reviver is not in the subset yet");
        return "any";
      }
      if (callee.k === "try") {
        // Its closures are called with what they capture (and the handler with what was thrown);
        // its result is a completion record or undefined: a value of any kind.
        for (const [i, a] of ins.slice(1).entries()) {
          const ta = get(a);
          if (ta === "?") return "?";
          const isClosure = typeof ta === "object" && ta.call.k === "closure";
          if (!isClosure && !(i > 0 && ta === "undef"))
            throw new LoweringError("a try whose blocks are not closures is not in the subset");
          if (!isClosure) continue;
          const k = known(a);
          if (k === "?" || k === undefined) return "?";
          const sig = callSig(k, []);
          if (sig === "?" || knownResult(k, sig, []) === "?") return "?";
        }
        return "any";
      }
      if (callee.k === "prim") return (PRIMITIVES[callee.name] as { result: WT }).result;
      if (callee.k === "method" && callee.name === "nums.push") {
        stored(callee.recv, ins[1] === undefined ? "?" : get(ins[1] as ValueId));
        return "f64";
      }
      if (callee.k === "method" && callee.name === "nums.pop") return trusted ? "f64" : "any";
      if (callee.k === "method" && callee.name === "arr.push") return "f64";
      if (callee.k === "method" && callee.name === "arr.pop") return "any";
      if (callee.k === "method" && callee.name === "toString") return "str";
      if (callee.k === "method" && ARRAY_FN_METHODS.has(callee.name.split(".")[1] ?? "")) {
        const sig = arrayFnSig(callee, ins.slice(1));
        if (sig === "?") return "?";
        try {
          return mod.atomWith(arrayFnAtom(sig.kind, sig.method, sig.args.length), sig.sig).result;
        } catch (e) {
          if (!(e instanceof GrowParams)) throw e;
          for (const path of e.paths) {
            const [i, ...rest] = path as [number, ...number[]];
            const v = i === 0 ? callee.recv : sig.args[i - 1];
            if (v === undefined) continue;
            if (rest.length === 0) stored(v, "any");
            else {
              const inner = known(v);
              if (inner !== "?" && inner !== undefined) growAt(inner, [], rest);
            }
          }
          return "?";
        }
      }
      if (callee.k === "atom")
        return wt(parseType((ATOMS[callee.name] as { output: string }).output), callee.name);
      if (callee.k === "closure" || callee.k === "fnparam") {
        const k = known(ins[0] as ValueId);
        if (k === "?" || k === undefined) return "?";
        const sig = callSig(k, ins.slice(1));
        return sig === "?" ? "?" : knownResult(k, sig, ins.slice(1));
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
      // A function stored in an object is a function value.
      for (let i = 0; i < ins.length; i++) operand(i);
      return "obj";
    }
    if (/^\.\w+=$/.test(label) && ins.length === 2) {
      const t0 = operand(0);
      if (t0 === "?") return "?";
      if (t0 !== "obj")
        throw new LoweringError(`a property write to ${show(t0)} is not in the subset yet`);
      operand(1);
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
      // A function in an array is a function value: the array holds values of any kind.
      const ts = ins.map((_, i) => operand(i));
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
    if (label === "instanceof" && ins.length === 2) {
      if (get(ins[1] as ValueId) === "?") return "?";
      instanceClass(ins[1] as ValueId);
      return "i32";
    }
    // The comma operator: its last operand's value (the others are computed for their effects).
    if (label === "," && ins.length >= 1) return get(ins[ins.length - 1] as ValueId);
    // A throw has no value: what follows it does not run.
    if (label === "throw") return "undef";
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
    if ((ins.length === 2 && BITWISE[label] !== undefined) || (ins.length === 1 && label === "~"))
      return "f64";
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
  if (grownParams.size > 0) throw new GrowParams([...grownParams].map((i) => [i]));
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
  params.forEach((p, i) => {
    if (typeof paramTypes[i] === "string")
      local.set(p.outputs[0] as ValueId, slotStart[i] as number);
  });
  const localOf = (v: ValueId): number => {
    const at0 = local.get(v);
    if (at0 !== undefined) return at0;
    const at = nSlots + locals.length;
    locals.push(value(v, `value ${v}`));
    local.set(v, at);
    return at;
  };
  /** A local of the function's own, for a value no graph value names. */
  const temp = (t: WT): number => {
    locals.push(t);
    return nSlots + locals.length - 1;
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
    if (typeof t === "object") {
      if (orDefault !== "any") throw new LoweringError("a function is used as a value here");
      materialize(v);
      return "any";
    }
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

  /**
   * A closure called with what it captures and, after those, one value of any kind (or none): the
   * thrown value a handler takes. Its result is left on the stack as a value of any kind.
   */
  const callClosureWith = (closure: ValueId, extra: number | undefined): void => {
    const result = callKnown(closure, extra === undefined ? [] : [extra]);
    if (result !== "any") emit({ op: "to.any", from: result });
  };
  /**
   * `__yakccTry(body, handler, finalizer)` (runtime.ts): the body's result, or, when it throws, the
   * handler's for what it threw (with no handler, the throw goes on). The finalizer runs however
   * that ends; a return in it (`[1, value]`) is the result instead, and ends a throw.
   */
  const emitTry = (args: readonly ValueId[]): void => {
    const [body, handler, finalizer] = args as [ValueId, ValueId | undefined, ValueId | undefined];
    const isClosure = (v: ValueId | undefined): v is ValueId => {
      if (v === undefined) return false;
      const tv = ty(v);
      return typeof tv === "object" && tv.call.k === "closure";
    };
    const r = temp("any");
    const caught = temp("any");
    const hasHandler = isClosure(handler);
    if (!isClosure(finalizer)) {
      // try { r = body() } catch (e) { r = handler(e) }; with no handler, the throw goes on.
      if (!hasHandler) {
        callClosureWith(body, undefined);
        emit({ op: "set", i: r }, { op: "get", i: r });
        return;
      }
      emit({ op: "try" });
      callClosureWith(body, undefined);
      emit({ op: "set", i: r }, { op: "catch" }, { op: "set", i: caught });
      callClosureWith(handler, caught);
      emit({ op: "set", i: r }, { op: "end" }, { op: "get", i: r });
      return;
    }
    // With a finalizer: what the body and the handler threw is held, the finalizer runs, and the
    // throw goes on unless the finalizer returned.
    const threw = temp("i32");
    emit({ op: "const.i32", x: 0 }, { op: "set", i: threw });
    emit({ op: "const.undef" }, { op: "set", i: r });
    emit({ op: "const.undef" }, { op: "set", i: caught });
    emit({ op: "try" });
    if (hasHandler) emit({ op: "try" });
    callClosureWith(body, undefined);
    emit({ op: "set", i: r });
    if (hasHandler) {
      emit({ op: "catch" }, { op: "set", i: caught });
      callClosureWith(handler, caught);
      emit({ op: "set", i: r }, { op: "end" });
    }
    emit({ op: "catch" }, { op: "set", i: caught });
    emit({ op: "const.i32", x: 1 }, { op: "set", i: threw }, { op: "end" });
    callClosureWith(finalizer, undefined);
    const done = temp("any");
    emit({ op: "set", i: done }, { op: "get", i: done });
    emit({ op: "call", fn: mod.atom("__ykIsReturn").fn }, { op: "if" });
    emit({ op: "get", i: done }, { op: "set", i: r });
    emit({ op: "const.i32", x: 0 }, { op: "set", i: threw }, { op: "end" });
    emit({ op: "get", i: threw }, { op: "if" }, { op: "get", i: caught }, { op: "throw" });
    emit({ op: "end" }, { op: "get", i: r });
  };

  /** The capture types a function value's trampoline unpacks: a function's is a value of any kind. */
  const capTypesOf = (caps: readonly PT[]): WT[] =>
    caps.map((c) => (typeof c === "string" ? c : "any"));
  /** Push a passed function (its captures in slots from `base`) as a function value. */
  const materializeFrom = (arg: FnArg, base: number): void => {
    emit({ op: "const.f64", x: mod.trampoline(arg.fn, capTypesOf(arg.caps), trusted) });
    let slot = base;
    for (const c of arg.caps) {
      if (typeof c === "string") {
        emit({ op: "get", i: slot });
        if (c !== "any") emit({ op: "to.any", from: c });
        slot += 1;
      } else {
        materializeFrom(c, slot);
        slot += flatPT(c).length;
      }
    }
    emit({ op: "arr.of", n: arg.caps.length }, { op: "call", fn: mod.primitive("__ykFnNew").fn });
  };
  /**
   * Push a known function as a function value (a value of any kind): its trampoline's id and its
   * captures, each a value of any kind (a captured function, a function value too).
   */
  const materialize = (v: ValueId): void => {
    const k = known(v);
    if (k === "?" || k === undefined)
      throw new LoweringError("a builtin function used as a value is not in the subset yet");
    if (k.capValues === undefined) {
      const c = (ty(v) as { call: { arg: FnArg; base: number } }).call;
      materializeFrom(c.arg, c.base);
      return;
    }
    const values = k.capValues;
    emit({ op: "const.f64", x: mod.trampoline(k.fn, capTypesOf(k.caps), trusted) });
    k.caps.forEach((c, i) => push(values[i] as ValueId, "any"));
    emit({ op: "arr.of", n: k.caps.length }, { op: "call", fn: mod.primitive("__ykFnNew").fn });
  };

  const emitNode = (n: DucNode): void => {
    if (n.kind === "literal-source" || n.kind === "param-source" || n.kind === "carry-source")
      return;
    if (n.kind === "diamond-source") return;
    if (n.kind === "op" && n.label === "throw") {
      push(n.inputs[0] as ValueId, "any");
      emit({ op: "throw" });
      return;
    }
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
    if (label === "CallExpression" && typeof opType(ins[0] as ValueId) === "string") {
      // A call of a value of any kind: its arguments as an array of any values, then __ykCall.
      push(ins[0] as ValueId, "any");
      for (const x of ins.slice(1)) push(x, "any");
      emit({ op: "arr.of", n: ins.length - 1 }, { op: "call", fn: mod.dynCall() });
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
      } else if (callee.k === "class-ref") {
        // Array.isArray(x): x instanceof Array.
        if (args[0] === undefined) emit({ op: "const.undef" });
        else push(args[0], "any");
        emit({ op: "const.str", s: "Array" }, { op: "call", fn: mod.atom("__ykInstanceOf").fn });
      } else if (callee.k === "json-ns") {
        const pushOrUndef = (v: ValueId | undefined): void => {
          if (v === undefined) emit({ op: "const.undef" });
          else push(v, "any");
        };
        pushOrUndef(args[0]);
        if (callee.name === "stringify") {
          pushOrUndef(args[2]);
          emit({ op: "call", fn: mod.atom("__ykJsonStringify").fn });
        } else emit({ op: "call", fn: mod.atom("__ykJsonParse").fn });
      } else if (callee.k === "object-ns") {
        // Object.keys (__ykKeysOf, not for-in), Object.values and Object.entries (__ykValuesOf).
        if (args[0] === undefined) emit({ op: "const.undef" });
        else push(args[0], "any");
        emit({ op: "const.i32", x: callee.name === "entries" ? 1 : 0 });
        const atom = callee.name === "keys" ? "__ykKeysOf" : "__ykValuesOf";
        emit({ op: "call", fn: mod.atom(atom).fn });
      } else if (callee.k === "number-of") {
        if (args.length === 0) emit({ op: "const.f64", x: 0 });
        else pushNumber(args[0] as ValueId);
      } else if (callee.k === "string-of") {
        if (args.length === 0) pushText("");
        else pushString(args[0] as ValueId);
      } else if (callee.k === "boolean-of") {
        if (args.length === 0) emit({ op: "const.i32", x: 0 });
        else truthy(args[0] as ValueId);
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
      } else if (callee.k === "method" && ARRAY_FN_METHODS.has(callee.name.split(".")[1] ?? "")) {
        const sig = arrayFnSig(callee, args) as Exclude<ReturnType<typeof arrayFnSig>, "?">;
        const { fn } = mod.atomWith(arrayFnAtom(sig.kind, sig.method, sig.args.length), sig.sig);
        push(callee.recv, sig.kind);
        sig.args.forEach((a, i) => pushArg(a, sig.sig[i + 1] as PT));
        emit({ op: "call", fn });
      } else if (callee.k === "prim") call(mod.primitive(callee.name), args, callee.name);
      else if (callee.k === "atom") call(mod.atom(callee.name), args, callee.name);
      else if (callee.k === "closure" || callee.k === "fnparam") {
        callKnown(ins[0] as ValueId, args);
      } else if (callee.k === "try") {
        emitTry(args);
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
    if ((ins.length === 2 && BITWISE[label] !== undefined) || (ins.length === 1 && label === "~")) {
      // Each operand ToInt32 (exact in a double), then a 32-bit integer.
      const int32 = (v: ValueId): void => {
        pushNumber(v);
        emit({ op: "call", fn: mod.atom("__ykToInt32").fn }, { op: "i32.of.f64" });
      };
      int32(ins[0] as ValueId);
      if (label === "~") emit({ op: "const.i32", x: -1 }, { op: "i32", name: "xor" });
      else {
        int32(ins[1] as ValueId);
        const name = BITWISE[label] as "and" | "or" | "xor" | "shl" | "shr_s" | "shr_u";
        // A shift's count is its low five bits.
        if (name === "shl" || name === "shr_s" || name === "shr_u")
          emit({ op: "const.i32", x: 31 }, { op: "i32", name: "and" });
        emit({ op: "i32", name });
      }
      emit({ op: label === ">>>" ? "f64.of.u32" : "f64.of.i32" });
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
    if (label === "instanceof" && ins.length === 2) {
      push(ins[0] as ValueId, "any");
      emit({ op: "const.str", s: instanceClass(ins[1] as ValueId) });
      emit({ op: "call", fn: mod.atom("__ykInstanceOf").fn });
      set(out);
      return;
    }
    if (label === "," && ins.length >= 1) {
      push(ins[ins.length - 1] as ValueId, t as WT);
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
    // An iteration loop goes by index over a sequence: for-in, the keys (__ykKeysOf); for-of, an
    // array of numbers or of any values itself (its length and elements read at each step, as
    // the specification's iterator does), a string's code points, or what __ykIterSource gives.
    let next: (() => void) | undefined;
    if (rec.iterate !== undefined) {
      const element = rec.iterate.element as ValueId;
      const of = ty(iterableOf(loop));
      const seqT: WT =
        rec.iterate.of === "keys"
          ? "arr"
          : of === "nums"
            ? "nums"
            : of === "arr"
              ? "arr"
              : of === "str"
                ? "arr"
                : "any";
      const seq = temp(seqT);
      const i = temp("f64");
      if (rec.iterate.of === "keys") {
        push(iterableOf(loop), "any");
        emit({ op: "const.i32", x: 1 }, { op: "call", fn: mod.atom("__ykKeysOf").fn });
      } else if (of === "nums" || of === "arr") push(iterableOf(loop), of);
      else if (of === "str") {
        push(iterableOf(loop), "str");
        emit({ op: "call", fn: mod.atom("__ykCodePoints").fn });
      } else {
        push(iterableOf(loop), "any");
        emit({ op: "call", fn: mod.atom("__ykIterSource").fn });
      }
      emit({ op: "set", i: seq }, { op: "const.f64", x: 0 }, { op: "set", i: i });
      emit({ op: "block" }, { op: "loop" });
      // Stop when the index reaches the sequence's length.
      emit({ op: "get", i: i }, { op: "get", i: seq });
      if (seqT === "nums") emit({ op: "nums.len" }, { op: "f64.of.i32" });
      else if (seqT === "arr") emit({ op: "arr.len" }, { op: "f64.of.i32" });
      else {
        emit({ op: "const.str", s: "length" }, { op: "call", fn: mod.atom("__ykGetAny").fn });
        emit({ op: "from.any", to: "f64" });
      }
      emit({ op: "f64", name: "lt" }, { op: "i32", name: "eqz" }, { op: "br_if", depth: 1 });
      // The element.
      emit({ op: "get", i: seq }, { op: "get", i: i });
      if (seqT === "nums") emit({ op: "call", fn: mod.primitive("numsGet").fn });
      else if (seqT === "arr") emit({ op: "call", fn: mod.primitive("arrAt").fn });
      else emit({ op: "call", fn: mod.atom("__ykIndex").fn });
      const et = ty(element);
      if (typeof et === "string" && et !== "undef") {
        if (seqT !== "nums" && et !== "any") emit({ op: "from.any", to: et });
        set(element);
      } else emit({ op: "drop", t: seqT === "nums" ? "f64" : "any" });
      next = () =>
        emit(
          { op: "get", i: i },
          { op: "const.f64", x: 1 },
          { op: "f64", name: "add" },
          { op: "set", i: i },
        );
      if (rec.cond === undefined) {
        emitItems(ordered(itemsOf(body)));
        next();
        const live0 = rec.carry
          .map((c, j) => ({ c, next: rec.next[j] as ValueId, t: ty(c) }))
          .filter((x) => typeof x.t === "string" && x.t !== "undef");
        for (const x of live0) push(x.next, x.t as WT);
        for (const x of [...live0].reverse()) set(x.c);
        emit({ op: "br", depth: 0 }, { op: "end" }, { op: "end" });
        loop.outputs.forEach((v, j) => assign(v, rec.carry[j] as ValueId));
        return;
      }
    } else emit({ op: "block" }, { op: "loop" });
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
    next?.();
    for (const x of live) push(x.next, x.t as WT);
    for (const x of [...live].reverse()) set(x.c);
    emit({ op: "br", depth: 0 }, { op: "end" }, { op: "end" });
    loop.outputs.forEach((v, i) => assign(v, rec.carry[i] as ValueId));
  };

  emitScope(undefined);
  // A function with no result, or whose result is undefined, returns undefined.
  if (g.obs.length === 0 || ty(g.obs[0] as ValueId) === "undef") {
    const result = declared ?? "any";
    if (result !== "any") throw new LoweringError("the result has no value here");
    emit({ op: "const.undef" });
    return { result, locals, code };
  }
  // The result as the contract types it: a value of any kind is read as the kind it says. A
  // function returned is a function value.
  const computedT = opType(g.obs[0] as ValueId);
  const computed = typeof computedT === "object" ? "any" : computedT;
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
