// SPDX-License-Identifier: Apache-2.0
/**
 * The native lowering beyond the typed subset (#1292, DEC-DUC-NATIVE-RUNTIME-001): every value is a
 * NaN-boxed 64-bit word, and every operation the graph names is a call to the yakcc runtime
 * (`runtime/yk.c`), which implements JavaScript's semantics for it. The graph needs nothing it does not
 * carry: an operation's label names the runtime function, a method call's receiver is the member
 * read that feeds it, and the heap token's order is the order the calls are made in.
 *
 * A closure's graph is a function of its own, with one calling convention for every JavaScript
 * function: `i64 (ptr closure, i64 this, i64 argc, ptr argv)`. Its captures (its graph's first
 * parameters) are read from the closure record, its own parameters from `argv` (undefined past
 * `argc`). `function-self` is the closure itself; `this` is the receiver the call gives.
 *
 * The exported function takes and returns boxed values: `uint64_t f(uint64_t, …)`.
 *
 * BigInts are the runtime's own arbitrary-precision values (ECMAScript's operators on them, and
 * their TypeError and RangeError), and the fixed-width and float64-bits leaves that raised C's
 * 64-bit integers and a double's bits lower to (DEC-DUC-OPERATIONS-AS-ATOMS-001) are direct calls
 * of the runtime's functions for them (#1361).
 *
 * Covered: numbers, booleans, undefined, null, strings (UTF-16), arrays, plain objects, closures; the
 * operators with JavaScript's coercions; `typeof`; template literals; reads and writes of members and
 * elements; calls of closures and of methods (an object's own, and the string and array builtins the
 * runtime lists); the exact `Math`. Refused, with the reason: free names, `new`, accessors, spread,
 * iteration, async and generator functions, the approximated `Math` and `**`.
 */
import { LlvmEmitError, type LlvmModule } from "./emit-llvm.js";
import { DECLARES } from "./lift.js";
import { bodyPathOf, joinOwners, sidePath } from "./line-form.js";
import { ecmaScriptView } from "./ops.js";
import { loweringView } from "./ordering.js";
import { paramIndex } from "./params.js";
import { RegexCompileError, regexMatcherGraph } from "./regex.js";
import { type ScopeItem, scopePlanner } from "./scopes.js";
import type { DucBranch, DucGraph, DucLoop, DucNode, ValueId } from "./types.js";

const TAG = (tag: bigint, payload: bigint): string => ((tag << 48n) | payload).toString();
const UNDEFINED = TAG(0xfff9n, 0n);
const NULL = TAG(0xfff9n, 1n);
const FALSE = TAG(0xfff9n, 2n);
const TRUE = TAG(0xfff9n, 3n);

/** A number as its boxed word: its IEEE bits, NaN canonical. */
function boxedNumber(x: number): string {
  if (Number.isNaN(x)) return "9221120237041090560";
  const v = new DataView(new ArrayBuffer(8));
  v.setFloat64(0, x);
  return v.getBigUint64(0).toString();
}

const BINARY: Readonly<Record<string, string>> = {
  "+": "yk_add",
  "-": "yk_sub",
  "*": "yk_mul",
  "/": "yk_div",
  "%": "yk_mod",
  "|": "yk_bitor",
  "&": "yk_bitand",
  "^": "yk_bitxor",
  "<<": "yk_shl",
  ">>": "yk_shr",
  ">>>": "yk_ushr",
  "===": "yk_seq",
  "!==": "yk_sne",
  "==": "yk_eq",
  "!=": "yk_ne",
  "<": "yk_lt",
  ">": "yk_gt",
  "<=": "yk_le",
  ">=": "yk_ge",
};
/**
 * The operators a number's own operation computes when both operands are numbers (#1369): the
 * double operation inline, behind a check of the operands' tags, and the runtime's otherwise. A
 * boxed number is its double's bits, so no conversion is needed; a NaN result is made canonical, as
 * the runtime's numbers are.
 */
const FAST_ARITH: Readonly<Record<string, string>> = {
  "+": "fadd",
  "-": "fsub",
  "*": "fmul",
  "/": "fdiv",
  "%": "frem",
};
const FAST_COMPARE: Readonly<Record<string, string>> = {
  "<": "olt",
  ">": "ogt",
  "<=": "ole",
  ">=": "oge",
  "===": "oeq",
  "!==": "une",
  "==": "oeq",
  "!=": "une",
};
/** The bitwise operators on ToInt32 (ToUint32 for >>>), inline for a number below 2^63. */
const FAST_BITWISE: Readonly<Record<string, string>> = {
  "|": "or",
  "&": "and",
  "^": "xor",
  "<<": "shl",
  ">>": "ashr",
  ">>>": "lshr",
};
/** Every boxed value at or above this (unsigned) is tagged: below it, a double. */
const NUMBER_LIMIT = "-1970324836974592"; // 0xFFF9000000000000
const CANONICAL_NAN = "9221120237041090560"; // 0x7FF8000000000000
const UNARY: Readonly<Record<string, string>> = {
  "-": "yk_neg",
  "+": "yk_pos",
  "!": "yk_not",
  TypeOfExpression: "yk_typeof",
  "~": "yk_bitnot",
};
/** The global functions the runtime gives as values. */
const GLOBALS = new Set([
  "String",
  "Number",
  "Boolean",
  "parseFloat",
  "parseInt",
  "isNaN",
  "isFinite",
  "Array",
  "NaN",
  "Infinity",
  "__yakccTry",
  "__yakccTryAsync",
  "__yakccTryGen",
  "Promise",
  "queueMicrotask",
  "Error",
  "TypeError",
  "RangeError",
  "SyntaxError",
  "Map",
  "Set",
  "Object",
  "JSON",
  "BigInt",
  "ArrayBuffer",
  "DataView",
  "TextEncoder",
  "Int8Array",
  "Uint8Array",
  "Uint8ClampedArray",
  "Int16Array",
  "Uint16Array",
  "Int32Array",
  "Uint32Array",
  "Float32Array",
  "Float64Array",
  "BigInt64Array",
  "BigUint64Array",
]);
/**
 * The fixed-width and float64-bits leaves (DEC-DUC-OPERATIONS-AS-ATOMS-001) that raised C calls:
 * each the runtime function that implements it, and its arity. A call of one is a direct call.
 */
const LEAVES: Readonly<Record<string, [string, number]>> = {
  __ykI32Mul: ["yk_leaf_i32mul", 2],
  __ykU64: ["yk_leaf_u64", 1],
  __ykI64: ["yk_leaf_i64", 1],
  __ykNumToBig: ["yk_leaf_num_to_big", 1],
  __ykBigToI32: ["yk_leaf_big_to_i32", 1],
  __ykBigToU32: ["yk_leaf_big_to_u32", 1],
  __ykBigToF64: ["yk_leaf_big_to_f64", 1],
  __ykF64ToI64: ["yk_leaf_f64_to_i64", 1],
  __ykF64Bits: ["yk_leaf_f64_bits", 1],
  __ykF64FromBits: ["yk_leaf_f64_from_bits", 1],
  __ykF64Hi: ["yk_leaf_f64_hi", 1],
  __ykF64Lo: ["yk_leaf_f64_lo", 1],
  __ykF64Make: ["yk_leaf_f64_make", 2],
  // C's memory (#1363): regions, constant data, little-endian loads and stores, binary32 rounding.
  __ykAlloc: ["yk_leaf_alloc", 2],
  __ykFree: ["yk_leaf_free", 1],
  __ykData: ["yk_leaf_data", 2],
  __ykLoad8: ["yk_leaf_load8", 1],
  __ykLoad16: ["yk_leaf_load16", 1],
  __ykLoad32: ["yk_leaf_load32", 1],
  __ykLoad64: ["yk_leaf_load64", 1],
  __ykLoadF64: ["yk_leaf_load_f64", 1],
  __ykLoadF32: ["yk_leaf_load_f32", 1],
  __ykStore8: ["yk_leaf_store8", 2],
  __ykStore16: ["yk_leaf_store16", 2],
  __ykStore32: ["yk_leaf_store32", 2],
  __ykStore64: ["yk_leaf_store64", 2],
  __ykStoreF64: ["yk_leaf_store_f64", 2],
  __ykStoreF32: ["yk_leaf_store_f32", 2],
  __ykF32: ["yk_leaf_f32", 1],
  __ykFnAddr: ["yk_leaf_fn_addr", 1],
  __ykFnAt: ["yk_leaf_fn_at", 1],
};
/**
 * The memory leaves with an inline fast path (#1369): an access to the region the runtime's cache
 * holds (`yk_mcache_*`) is a native load or store; anything else is the runtime's leaf, which finds
 * the region or traps and fills the cache. Each: its size, its LLVM type, how its value converts.
 */
const MEM_INLINE: Readonly<
  Record<string, { size: number; ty: string; kind: "u" | "f64" | "f32"; store: boolean }>
> = {
  __ykLoad8: { size: 1, ty: "i8", kind: "u", store: false },
  __ykLoad16: { size: 2, ty: "i16", kind: "u", store: false },
  __ykLoad32: { size: 4, ty: "i32", kind: "u", store: false },
  __ykLoadF64: { size: 8, ty: "double", kind: "f64", store: false },
  __ykLoadF32: { size: 4, ty: "float", kind: "f32", store: false },
  __ykStore8: { size: 1, ty: "i8", kind: "u", store: true },
  __ykStore16: { size: 2, ty: "i16", kind: "u", store: true },
  __ykStore32: { size: 4, ty: "i32", kind: "u", store: true },
  __ykStoreF64: { size: 8, ty: "double", kind: "f64", store: true },
  __ykStoreF32: { size: 4, ty: "float", kind: "f32", store: true },
};
const MEM_CACHE_DECLS = [
  "@yk_mcache_base = external global i64",
  "@yk_mcache_len = external global i64",
  "@yk_mcache_bytes = external global ptr",
  "@yk_mcache_writable = external global i64",
  "@yk_mcache2_base = external global i64",
  "@yk_mcache2_len = external global i64",
  "@yk_mcache2_bytes = external global ptr",
  "@yk_mcache2_writable = external global i64",
  "@yk_mcache_epoch = external global i64",
];
/** The access sites' own caches: each is named once per process (`@yk.msite.N`). */
let memorySites = 0;
/** A BigInt literal: its digits (any radix prefix kept), then n. */
const BIGINT_LITERAL = /^(0[xXoObB][0-9a-fA-F_]+|[0-9_]+)n$/;
const MATH1 = new Set(["floor", "ceil", "trunc", "sqrt", "abs", "sign", "round"]);
const APPROXIMATED =
  /^(exp|expm1|log|log1p|log2|log10|sin|cos|tan|asin|acos|atan|atan2|sinh|cosh|tanh|asinh|acosh|atanh|cbrt|hypot|pow)$/;

const RUNTIME_DECLS: Readonly<Record<string, string>> = {
  yk_bigint_literal: "declare i64 @yk_bigint_literal(ptr, i64)",
  yk_bigint_from_i128: "declare i64 @yk_bigint_from_i128(i64, i64)",
  yk_bigint_word: "declare i64 @yk_bigint_word(i64, i32)",
  ...Object.fromEntries(
    Object.values(LEAVES).map(([fn, n]) => [
      fn,
      `declare i64 @${fn}(${Array(n).fill("i64").join(", ")})`,
    ]),
  ),
  yk_truthy: "declare i32 @yk_truthy(i64)",
  yk_string_utf8: "declare i64 @yk_string_utf8(ptr, i64)",
  yk_array_of: "declare i64 @yk_array_of(i64, ptr)",
  yk_object_of: "declare i64 @yk_object_of(i64, ptr, ptr)",
  yk_template: "declare i64 @yk_template(i64, ptr, ptr)",
  yk_get: "declare i64 @yk_get(i64, i64)",
  yk_get_named: "declare i64 @yk_get_named(i64, ptr, i64)",
  yk_set: "declare i64 @yk_set(i64, i64, i64)",
  yk_set_named: "declare i64 @yk_set_named(i64, ptr, i64, i64)",
  yk_call_method: "declare i64 @yk_call_method(i64, ptr, i64, i64, ptr)",
  yk_call: "declare i64 @yk_call(i64, i64, i64, ptr)",
  yk_closure_new: "declare i64 @yk_closure_new(ptr, i32, i64, ptr)",
  yk_closure_self: "declare i64 @yk_closure_self(ptr)",
  yk_capture: "declare i64 @yk_capture(ptr, i64)",
  yk_arg: "declare i64 @yk_arg(i64, ptr, i64)",
  yk_rest: "declare i64 @yk_rest(i64, ptr, i64)",
  yk_math1: "declare i64 @yk_math1(ptr, i64)",
  yk_global: "declare i64 @yk_global(ptr, i64)",
  yk_new: "declare i64 @yk_new(i64, i64, ptr)",
  yk_string_is: "declare i32 @yk_string_is(i64, ptr, i64)",
  yk_fail: "declare void @yk_fail(ptr)",
  yk_throw: "declare void @yk_throw(i64) noreturn",
  yk_inc: "declare i64 @yk_inc(i64)",
  yk_dec: "declare i64 @yk_dec(i64)",
  yk_is_nullish: "declare i32 @yk_is_nullish(i64)",
  yk_instanceof: "declare i64 @yk_instanceof(i64, i64)",
  yk_in: "declare i64 @yk_in(i64, i64)",
  yk_define: "declare i64 @yk_define(i64, i64, i64)",
  yk_define_accessor: "declare i64 @yk_define_accessor(i64, i64, i64, i64)",
  yk_spread_into: "declare i64 @yk_spread_into(i64, i64)",
  yk_spread_list: "declare i64 @yk_spread_list(i64, ptr, ptr)",
  yk_call_spread: "declare i64 @yk_call_spread(i64, i64, i64)",
  yk_call_method_spread: "declare i64 @yk_call_method_spread(i64, ptr, i64, i64)",
  yk_new_spread: "declare i64 @yk_new_spread(i64, i64)",
  yk_class_new: "declare i64 @yk_class_new(ptr, i64, i64, ptr, ptr, ptr, ptr)",
  yk_private_key: "declare i64 @yk_private_key(ptr, ptr, i64)",
  yk_private_get: "declare i64 @yk_private_get(i64, i64)",
  yk_private_set: "declare i64 @yk_private_set(i64, i64, i64)",
  yk_private_has: "declare i64 @yk_private_has(i64, i64)",
  yk_super_construct: "declare i64 @yk_super_construct(ptr, i64, i64, ptr)",
  yk_await: "declare i64 @yk_await(i64)",
  yk_yield: "declare i64 @yk_yield(i64)",
  yk_yield_star: "declare i64 @yk_yield_star(i64)",
  yk_closure_mode: "declare i64 @yk_closure_mode(i64, i32)",
  yk_super_get: "declare i64 @yk_super_get(ptr, i64, ptr, i64)",
  yk_super_get_key: "declare i64 @yk_super_get_key(ptr, i64, i64)",
  yk_iter_close: "declare void @yk_iter_close(i64)",
  yk_closure_class: "declare i64 @yk_closure_class(ptr)",
  yk_closure_inherit: "declare i64 @yk_closure_inherit(i64, ptr)",
  yk_delete: "declare i64 @yk_delete(i64, i64)",
  yk_regexp_new: "declare i64 @yk_regexp_new(i64, i64, i64, i64)",
  yk_delete_named: "declare i64 @yk_delete_named(i64, ptr, i64)",
  yk_iter_new: "declare i64 @yk_iter_new(i64, i32)",
  yk_iter_next: "declare i32 @yk_iter_next(i64, ptr)",
  yk_math_minmax: "declare i64 @yk_math_minmax(i32, i64, ptr)",
  yk_math_minmax_list: "declare i64 @yk_math_minmax_list(i32, i64)",
  ...Object.fromEntries(Object.values(BINARY).map((f) => [f, `declare i64 @${f}(i64, i64)`])),
  ...Object.fromEntries(Object.values(UNARY).map((f) => [f, `declare i64 @${f}(i64)`])),
};

/** UTF-8 bytes as an LLVM string constant body. */
function llvmBytes(text: string): { body: string; length: number } {
  const bytes = new TextEncoder().encode(text);
  let body = "";
  for (const b of bytes)
    body +=
      b >= 0x20 && b < 0x7f && b !== 0x22 && b !== 0x5c
        ? String.fromCharCode(b)
        : `\\${b.toString(16).toUpperCase().padStart(2, "0")}`;
  return { body, length: bytes.length };
}

/** A slot of an object literal's label: a named or computed key, a method, a spread. */
type Slot =
  | { readonly kind: "named"; readonly name: string }
  | { readonly kind: "computed" }
  | { readonly kind: "method"; readonly name: string }
  | { readonly kind: "spread" }
  | { readonly kind: "get" | "set"; readonly name?: string }
  | { readonly kind: "unsupported"; readonly what: string };

function slotsOf(label: string): Slot[] {
  return (JSON.parse(label.slice("object:".length)) as unknown[]).map((entry): Slot => {
    if (entry === null) return { kind: "spread" };
    if (entry === 1) return { kind: "computed" };
    if (typeof entry === "string") return { kind: "named", name: entry };
    const [kind, k] = Object.entries(entry as Record<string, unknown>)[0] ?? [];
    if (kind === "method" && typeof k === "string") return { kind: "method", name: k };
    // An accessor: named, or computed (its key the input before its function).
    if (kind === "get" || kind === "set")
      return typeof k === "string" ? { kind, name: k } : { kind };
    return { kind: "unsupported", what: `a ${kind} member` };
  });
}

/** The module being built: its constants, the runtime functions it calls, its functions. */
class ModuleBuilder {
  readonly globals: string[] = [];
  readonly used = new Set<string>();
  /** The LLVM intrinsics the functions call, declared once. */
  readonly intrinsics = new Set<string>();
  readonly functions: string[] = [];
  /** Each regex literal's matcher, lowered once: its function's name. */
  readonly matchers = new Map<string, string>();
  private closures = 0;

  constant(text: string, nul = false): { ptr: string; length: number } {
    const { body, length } = llvmBytes(text);
    const name = `@.str${this.globals.length}`;
    this.globals.push(
      `${name} = private unnamed_addr constant [${length + (nul ? 1 : 0)} x i8] c"${body}${nul ? "\\00" : ""}"`,
    );
    return { ptr: name, length };
  }

  closureName(of: string): string {
    return `${of}.closure${this.closures++}`;
  }
}

/**
 * One graph lowered to one LLVM function. The entry function takes its parameters as `i64`s; a
 * closure's function takes the closure, the receiver, and the arguments.
 */
/**
 * A module's scope, for a graph that is one of its statements (#1290): what a free name is (a load of
 * a module binding, `module`, `exports`, `require`), how a written binding is stored, and, for a
 * statement, the bindings its results are stored in.
 */
interface ModuleScope {
  /** The value of a free name in the module, as IR emitted by `emit`, or undefined when it is not one. */
  readonly read: (
    name: string,
    emit: (line: string) => void,
    fresh: () => string,
  ) => string | undefined;
  readonly write: (name: string, value: string, emit: (line: string) => void) => boolean;
  /**
   * A free name bound to a function declaration nothing in the program reassigns: the LLVM
   * function its closure's code is, which a call may call directly (#1369). Undefined otherwise.
   */
  readonly direct?: (name: string) => string | undefined;
  /** For a statement: the globals its results (its graph's observations) are stored in, in order. */
  readonly outs?: readonly string[];
}

function lowerFunction(
  m: ModuleBuilder,
  source: DucGraph,
  name: string,
  closure: { readonly captures: number } | undefined,
  scope?: ModuleScope,
  /** The parameters (by value) this lowering may take as numbers: a speculated clone's (#1369). */
  numberParams?: ReadonlySet<ValueId>,
): void {
  // An async function's or a generator's body is lowered as any function's: the runtime runs it as a
  // coroutine, which await and yield suspend (#1295). The closure carries the mode.
  if (source.mode === "async generator" || (source.mode !== undefined && closure === undefined))
    throw new LlvmEmitError(`an ${source.mode} function is not in the subset yet`);
  if (scope?.outs === undefined && source.obs.length > 1)
    throw new LlvmEmitError("a native function has at most one result");
  // A statement's one result names its declared values (#1292): they go to the module's bindings.
  const declaredValues =
    scope?.outs === undefined
      ? undefined
      : source.nodes.find(
          (n) =>
            n.outputs.includes(source.obs[0] as ValueId) && (n.label ?? "").startsWith(DECLARES),
        )?.inputs;
  if (scope?.outs !== undefined && declaredValues?.length !== scope.outs.length)
    throw new LlvmEmitError("a statement's declared values and the names it declares differ");
  const { graph: g, after } = loweringView(source);
  const owners = joinOwners(g);
  const producer = new Map<ValueId, DucNode>();
  for (const n of g.nodes) for (const v of n.outputs) producer.set(v, n);

  const alias = new Map<ValueId, ValueId>();
  for (const loop of g.nodes.filter((n) => n.kind === "loop")) {
    const rec = loop.loop;
    // An opaque loop (a summary the lifter could not decompose) has no body to lower.
    if (rec === undefined)
      throw new LlvmEmitError(`the opaque loop ${loop.label ?? ""} is not in the subset`);
    if (rec.iterate === undefined && rec.cond === undefined)
      throw new LlvmEmitError("a loop with no condition");
    // An iteration's iterable is the input after the carries; the invariants come after it.
    const offset = rec.carry.length + (rec.iterate !== undefined ? 1 : 0);
    rec.invariant.forEach((v, j) => alias.set(v, loop.inputs[offset + j] as ValueId));
  }
  const resolve = (v: ValueId): ValueId => {
    const a = alias.get(v);
    return a === undefined ? v : resolve(a);
  };
  const planner = scopePlanner(g, owners, resolve, (msg) => new LlvmEmitError(msg), after);

  // Math, whose members a call names; and the global functions the runtime gives as values.
  const mathValue = new Set<ValueId>();
  const globalValue = new Map<ValueId, string>();
  const freeValue = new Map<ValueId, string>();
  const leafValue = new Map<ValueId, string>();
  for (const n of g.nodes) {
    if (n.kind !== "diamond-source") continue;
    const sym = n.diamond?.symbol ?? "";
    if (LEAVES[sym] !== undefined) leafValue.set(n.outputs[0] as ValueId, sym);
    else if (n.diamond?.reason === "platform-primitive" && sym === "Math")
      mathValue.add(n.outputs[0] as ValueId);
    else if (n.diamond?.reason === "platform-primitive" && GLOBALS.has(sym))
      globalValue.set(n.outputs[0] as ValueId, sym);
    else if (scope !== undefined && n.diamond?.reason === "free-identifier")
      freeValue.set(n.outputs[0] as ValueId, sym);
    else if (scope !== undefined && n.diamond?.reason === "platform-primitive")
      // In a module, a platform global the runtime lacks is undefined, as on a platform without it:
      // what a `typeof` probe for it sees. Any other use fails when it runs.
      globalValue.set(n.outputs[0] as ValueId, sym);
    else throw new LlvmEmitError(`"${sym}" is not in the native base set`);
  }
  const memberOf = (v: ValueId): { node: DucNode; name: string } | undefined => {
    const p = producer.get(resolve(v));
    if (p === undefined || p.kind !== "op" || !/^\.[\w$]+$/.test(p.label ?? "")) return undefined;
    return { node: p, name: (p.label as string).slice(1) };
  };
  const isMath = (v: ValueId): boolean => mathValue.has(resolve(v));

  // --- Typed BigInts (#1369, DEC-DUC-TYPED-NATIVE-001): a BigInt the graph proves narrower than 128
  // bits is an i128, not a heap value. The proof: the integer ranges of numbers (an int32 or uint32
  // from `| 0`, `>>> 0`, the 32-bit loads, ...) and the widths of BigInts (from the fixed-width
  // leaves, literals, and the operators' growth). Anything else stays boxed.
  const leafOf = (n: DucNode): string | undefined =>
    n.label === "CallExpression" ? leafValue.get(resolve(n.inputs[0] as ValueId)) : undefined;
  const numRange = new Map<ValueId, "i32" | "u32">();
  const bigWidth = new Map<ValueId, number>();
  /** A BigInt the graph fixes: a literal, or __ykNumToBig of an integer literal (raise-c's `32n`). */
  const literalBig = (v: ValueId): bigint | undefined => {
    const p = producer.get(resolve(v));
    if (
      p?.kind === "op" &&
      p.label === "CallExpression" &&
      leafValue.get(resolve(p.inputs[0] as ValueId)) === "__ykNumToBig" &&
      p.inputs.length === 2
    ) {
      const a = producer.get(resolve(p.inputs[1] as ValueId));
      const x =
        a?.kind === "literal-source" ? Number((a.label ?? "").replace(/_/g, "")) : Number.NaN;
      return Number.isSafeInteger(x) ? BigInt(x) : undefined;
    }
    if (p?.kind !== "literal-source" || !BIGINT_LITERAL.test(p.label ?? "")) return undefined;
    return BigInt((p.label as string).slice(0, -1).replace(/_/g, ""));
  };
  const widthOf = (v: ValueId): number | undefined => {
    const lit = literalBig(v);
    if (lit !== undefined) return (lit < 0n ? -lit : lit).toString(2).length + 1;
    return bigWidth.get(resolve(v));
  };
  const rangeOf = (v: ValueId): "i32" | "u32" | undefined => {
    const p = producer.get(resolve(v));
    if (p?.kind === "literal-source") {
      const x = Number(p.label);
      if (Number.isInteger(x) && x >= -(2 ** 31) && x < 2 ** 31 && !Object.is(x, -0)) return "i32";
      if (Number.isInteger(x) && x >= 0 && x < 2 ** 32) return "u32";
      return undefined;
    }
    return numRange.get(resolve(v));
  };
  /** A value proved a number: a number literal, or an integer range's. */
  const isNumberish = (v: ValueId): boolean => {
    const p = producer.get(resolve(v));
    if (p?.kind === "literal-source") {
      const t = (p.label ?? "").replace(/_/g, "");
      return t === "NaN" || (t !== "" && !BIGINT_LITERAL.test(t) && !Number.isNaN(Number(t)));
    }
    return numRange.has(resolve(v));
  };
  for (let changed = true; changed; ) {
    changed = false;
    for (const n of g.nodes) {
      if (n.kind !== "op") continue;
      const out = n.outputs[0] as ValueId | undefined;
      if (out === undefined || numRange.has(out) || bigWidth.has(out)) continue;
      const ins = n.inputs as readonly ValueId[];
      const lbl = n.label ?? "";
      const leaf = leafOf(n);
      let range: "i32" | "u32" | undefined;
      let width: number | undefined;
      if (leaf !== undefined) {
        const a = ins[1] as ValueId;
        if (leaf === "__ykBigToI32" || leaf === "__ykI32Mul") range = "i32";
        else if (
          leaf === "__ykBigToU32" ||
          leaf === "__ykLoad8" ||
          leaf === "__ykLoad16" ||
          leaf === "__ykLoad32"
        )
          range = "u32";
        else if (leaf === "__ykF64Bits" || leaf === "__ykU64" || leaf === "__ykLoad64") width = 65;
        else if (leaf === "__ykI64") width = 64;
        else if (leaf === "__ykNumToBig" && a !== undefined && rangeOf(a) !== undefined) width = 33;
      } else if (ins.length === 2 && ["|", "&", "^", "<<", ">>"].includes(lbl)) {
        // On numbers, ToInt32's; on BigInts (both operands proved BigInts), the BigInt's.
        const wa = widthOf(ins[0] as ValueId);
        const wb = widthOf(ins[1] as ValueId);
        if (wa !== undefined && wb !== undefined) {
          if (lbl === ">>") {
            const k = literalBig(ins[1] as ValueId);
            if (k !== undefined && k >= 0n) width = wa;
          } else if (lbl === "<<") {
            const k = literalBig(ins[1] as ValueId);
            if (k !== undefined && k >= 0n && k <= 127n) width = wa + Number(k);
          } else width = Math.max(wa, wb);
        } else if (isNumberish(ins[0] as ValueId) || isNumberish(ins[1] as ValueId))
          // With a number operand the result, if there is one (a BigInt operand throws), is ToInt32's.
          range = "i32";
      } else if (ins.length === 2 && lbl === ">>>") {
        // On anything but BigInts (which throw), ToUint32's.
        range = "u32";
      } else if (ins.length === 2 && (lbl === "+" || lbl === "-" || lbl === "*")) {
        const wa = widthOf(ins[0] as ValueId);
        const wb = widthOf(ins[1] as ValueId);
        if (wa !== undefined && wb !== undefined)
          width = lbl === "*" ? wa + wb : Math.max(wa, wb) + 1;
      } else if (ins.length === 1 && lbl === "-") {
        const wa = widthOf(ins[0] as ValueId);
        if (wa !== undefined) width = wa + 1;
      } else if (ins.length === 1 && lbl === "~") {
        const wa = widthOf(ins[0] as ValueId);
        if (wa !== undefined) width = wa + 1;
        else if (isNumberish(ins[0] as ValueId)) range = "i32";
      }
      if (range !== undefined) {
        numRange.set(out, range);
        changed = true;
      } else if (width !== undefined && width <= 127) {
        bigWidth.set(out, width);
        changed = true;
      }
    }
  }
  // --- Constant tables (#1369): an array literal of number literals whose every use reads an element
  // (never written, returned, passed or captured) is one constant array, read in place.
  const constTables = new Map<ValueId, { global: string; n: number }>();
  const dataTables = new Map<ValueId, { global: string; n: number }>();
  /** A number the graph fixes: a numeric literal, or the negation of one (`-0.5`). */
  const literalNumber = (v: ValueId): number | undefined => {
    const p = producer.get(resolve(v));
    if (p?.kind === "literal-source") {
      const t = (p.label ?? "").replace(/_/g, "");
      if (t === "NaN") return Number.NaN;
      if (t === "" || BIGINT_LITERAL.test(t) || t.startsWith('"') || t.startsWith("'"))
        return undefined;
      const x = Number(t);
      return Number.isNaN(x) ? undefined : x;
    }
    if (p?.kind === "op" && p.label === "-" && p.inputs.length === 1) {
      const x = literalNumber(p.inputs[0] as ValueId);
      return x === undefined ? undefined : -x;
    }
    return undefined;
  };
  {
    const uses = new Map<ValueId, DucNode[]>();
    for (const n of g.nodes)
      for (const v of n.inputs) {
        const r = resolve(v as ValueId);
        uses.set(r, [...(uses.get(r) ?? []), n]);
      }
    const escaping = new Set<ValueId>([
      ...g.obs.map((v) => resolve(v)),
      ...(g.branches ?? []).map((b) => resolve(b.cond as ValueId)),
    ]);
    for (const n of g.nodes) {
      if (n.kind !== "op" || n.label !== "ArrayLiteral" || n.inputs.length === 0) continue;
      const out = n.outputs[0] as ValueId;
      const values = n.inputs.map((v) => literalNumber(v as ValueId));
      if (values.some((x) => x === undefined) || escaping.has(out)) continue;
      const consumers = uses.get(out) ?? [];
      // Constant data's elements (`__ykData(kind, [..])`, raise-c's constant arrays): laid out
      // once, at the first call (the address depends only on the content).
      if (
        consumers.length > 0 &&
        consumers.every(
          (c) =>
            leafOf(c) === "__ykData" &&
            c.inputs.length === 3 &&
            resolve(c.inputs[2] as ValueId) === out &&
            resolve(c.inputs[1] as ValueId) !== out &&
            producer.get(resolve(c.inputs[1] as ValueId))?.kind === "literal-source",
        )
      ) {
        const name = `@cdat${m.globals.length}`;
        m.globals.push(
          `${name} = private unnamed_addr constant [${values.length} x i64] [${values.map((x) => `i64 ${boxedNumber(x as number)}`).join(", ")}]`,
        );
        dataTables.set(out, { global: name, n: values.length });
        continue;
      }
      if (
        consumers.length === 0 ||
        !consumers.every(
          (c) =>
            c.kind === "op" &&
            c.label === "ElementAccess" &&
            c.inputs.length === 2 &&
            resolve(c.inputs[0] as ValueId) === out &&
            resolve(c.inputs[1] as ValueId) !== out,
        )
      )
        continue;
      const name = `@ctab${m.globals.length}`;
      m.globals.push(
        `${name} = private unnamed_addr constant [${values.length} x i64] [${values.map((x) => `i64 ${boxedNumber(x as number)}`).join(", ")}]`,
      );
      constTables.set(out, { global: name, n: values.length });
    }
  }
  // --- Proven numbers (#1369): a value the graph proves is a number (or never produced: its
  // operation throws first) needs no tag check. Carries, joins and loop results are assumed numbers
  // until one of their inputs is not (an optimistic fixpoint).
  const NUMBER_LEAVES = new Set([
    "__ykAlloc",
    "__ykData",
    "__ykBigToI32",
    "__ykBigToU32",
    "__ykBigToF64",
    "__ykI32Mul",
    "__ykLoad8",
    "__ykLoad16",
    "__ykLoad32",
    "__ykLoadF64",
    "__ykLoadF32",
    "__ykF64FromBits",
    "__ykF64Hi",
    "__ykF64Lo",
    "__ykF64Make",
    "__ykF32",
  ]);
  // Integer intervals (#1369): an index the graph bounds (`x & 1`, `x >>> 31`, …) reads a
  // constant table in range, so the read is a number with no check.
  const intervals = new Map<ValueId, readonly [number, number] | null>();
  const intRange = (v0: ValueId): readonly [number, number] | undefined => {
    const v = resolve(v0);
    if (intervals.has(v)) return intervals.get(v) ?? undefined;
    intervals.set(v, null); // a cycle bounds nothing
    let r: readonly [number, number] | undefined;
    const lit = literalNumber(v);
    const p = producer.get(v);
    if (lit !== undefined) r = Number.isInteger(lit) ? [lit, lit] : undefined;
    else if (p?.kind === "op" && p.inputs.length === 2) {
      const a = p.inputs[0] as ValueId;
      const b = p.inputs[1] as ValueId;
      const ra = intRange(a);
      const rb = intRange(b);
      const i32 = (x: readonly [number, number] | undefined) =>
        x !== undefined && x[0] >= -(2 ** 31) && x[1] < 2 ** 31;
      const u32 = (x: readonly [number, number] | undefined) =>
        x !== undefined && x[0] >= 0 && x[1] < 2 ** 32;
      // Each value an interval bounds is a Number (an operand with one is a Number, and a Number
      // with a BigInt throws; `>>>` throws on a BigInt): the result is a Number or never made.
      if (p.label === "&") {
        // A non-negative mask bounds the result: ToInt32 of a mask in [0, 2^31) is itself.
        const mask = (x: readonly [number, number] | undefined) =>
          x !== undefined && x[0] >= 0 && x[1] < 2 ** 31 ? x[1] : undefined;
        const m = mask(rb) ?? mask(ra);
        if (m !== undefined) r = [0, m];
      } else if (p.label === ">>>" && rb !== undefined && rb[0] === rb[1]) {
        const k = (((rb[0] % 32) + 32) % 32) as number;
        r = k === 0 ? (u32(ra) ? ra : [0, 2 ** 32 - 1]) : [0, 2 ** (32 - k) - 1];
      } else if (p.label === "|" && rb !== undefined && rb[0] === 0 && rb[1] === 0 && i32(ra))
        r = ra;
      else if (p.label === "|" && ra !== undefined && ra[0] === 0 && ra[1] === 0 && i32(rb)) r = rb;
    }
    intervals.set(v, r ?? null);
    return r;
  };
  /** A constant table read whose index the intervals keep in range: always an element. */
  const tableInRange = (n: DucNode): boolean => {
    if (n.kind !== "op" || n.label !== "ElementAccess" || n.inputs.length !== 2) return false;
    const table = constTables.get(resolve(n.inputs[0] as ValueId));
    const r = intRange(n.inputs[1] as ValueId);
    return table !== undefined && r !== undefined && r[0] >= 0 && r[1] < table.n;
  };
  const provenNumber = new Set<ValueId>();
  {
    const loopOf = new Map<ValueId, { loop: DucNode; i: number; carry: boolean }>();
    for (const n of g.nodes)
      if (n.kind === "loop" && n.loop !== undefined) {
        n.loop.carry.forEach((c, i) => loopOf.set(c, { loop: n, i, carry: true }));
        n.outputs.forEach((o, i) => loopOf.set(o, { loop: n, i, carry: false }));
      }
    const assumed = new Set<ValueId>();
    for (const n of g.nodes) {
      if (n.kind === "sel") for (const o of n.outputs) assumed.add(o);
      if (n.kind === "loop" && n.loop !== undefined) {
        for (const c of n.loop.carry) assumed.add(c);
        for (const o of n.outputs) assumed.add(o);
      }
    }
    const isNumberLiteral = (p: DucNode): boolean => {
      const t = (p.label ?? "").replace(/_/g, "");
      return (
        t === "NaN" ||
        (t !== "" && !BIGINT_LITERAL.test(t) && !t.startsWith('"') && !Number.isNaN(Number(t)))
      );
    };
    const compute = (): Set<ValueId> => {
      const out = new Set<ValueId>();
      const num = (v0: ValueId): boolean => {
        const v = resolve(v0);
        if (assumed.has(v) || numberParams?.has(v) === true) return true;
        if (out.has(v)) return true;
        const p = producer.get(v);
        if (p === undefined) return false;
        if (p.kind === "literal-source") return isNumberLiteral(p);
        return false;
      };
      for (let changed = true; changed; ) {
        changed = false;
        for (const n of g.nodes) {
          if (n.kind !== "op") continue;
          const o = n.outputs[0] as ValueId | undefined;
          if (o === undefined || out.has(o)) continue;
          const ins = n.inputs as readonly ValueId[];
          const lbl = n.label ?? "";
          const leaf = leafOf(n);
          const callee = lbl === "CallExpression" ? memberOf(ins[0] as ValueId) : undefined;
          let yes = false;
          if (numRange.has(o) || tableInRange(n)) yes = true;
          else if (leaf !== undefined) yes = NUMBER_LEAVES.has(leaf);
          else if (callee !== undefined && isMath(callee.node.inputs[0] as ValueId)) yes = true;
          else if (ins.length === 2 && ["+", "-", "*", "/", "%"].includes(lbl))
            yes = num(ins[0] as ValueId) && num(ins[1] as ValueId);
          else if (ins.length === 1 && lbl === "+") yes = true;
          else if (ins.length === 1 && ["-", "++", "--", "post++", "post--"].includes(lbl))
            yes = num(ins[0] as ValueId);
          if (yes) {
            out.add(o);
            changed = true;
          }
        }
      }
      return out;
    };
    for (;;) {
      const proven = compute();
      const holds = (v: ValueId): boolean => {
        const r = resolve(v);
        if (assumed.has(r) || proven.has(r) || numberParams?.has(r) === true) return true;
        const p = producer.get(r);
        return p?.kind === "literal-source" && isNumberLiteral(p);
      };
      let removed = false;
      for (const v of [...assumed]) {
        let ok = true;
        const p = producer.get(v);
        if (p?.kind === "sel") ok = holds(p.inputs[1] as ValueId) && holds(p.inputs[2] as ValueId);
        else {
          const at = loopOf.get(v);
          if (at === undefined) ok = false;
          else {
            const rec = at.loop.loop as DucLoop;
            ok =
              holds(at.loop.inputs[at.i] as ValueId) &&
              holds(rec.next[at.i] as ValueId) &&
              holds(rec.carry[at.i] as ValueId);
          }
        }
        if (!ok) {
          assumed.delete(v);
          removed = true;
        }
      }
      if (!removed) {
        for (const v of numberParams ?? []) provenNumber.add(v);
        for (const v of proven) provenNumber.add(v);
        for (const v of assumed) provenNumber.add(v);
        break;
      }
    }
  }
  /** Whether every value is a proven number (or a number literal). */
  const allNumbers = (vs: readonly ValueId[]): boolean =>
    vs.every((v0) => {
      const v = resolve(v0);
      if (provenNumber.has(v)) return true;
      const p = producer.get(v);
      const t = (p?.label ?? "").replace(/_/g, "");
      return (
        p?.kind === "literal-source" &&
        (t === "NaN" ||
          (t !== "" && !BIGINT_LITERAL.test(t) && !t.startsWith('"') && !Number.isNaN(Number(t))))
      );
    });
  // Values whose every use is a proven-number arithmetic or comparison (#1369): such a consumer
  // reads the double's bits, so a NaN result needs no canonical form. Anything that can reach boxed
  // code (a result, a join, a carry, a call, a store) is canonical.
  const rawNumbers = new Set<ValueId>();
  {
    const usesOf = new Map<ValueId, DucNode[]>();
    const escapes = new Set<ValueId>([
      ...g.obs.map((v) => resolve(v)),
      ...(g.branches ?? []).map((b) => resolve(b.cond as ValueId)),
    ]);
    for (const n of g.nodes) {
      for (const v of n.inputs) {
        const r = resolve(v as ValueId);
        usesOf.set(r, [...(usesOf.get(r) ?? []), n]);
      }
      if (n.kind === "loop" && n.loop !== undefined) {
        for (const v of n.loop.next) escapes.add(resolve(v));
        if (n.loop.cond !== undefined) escapes.add(resolve(n.loop.cond));
      }
    }
    const numericUse = (n: DucNode): boolean =>
      n.kind === "op" &&
      ((n.inputs.length === 2 &&
        (FAST_ARITH[n.label ?? ""] !== undefined || FAST_COMPARE[n.label ?? ""] !== undefined)) ||
        (n.inputs.length === 1 && n.label === "-")) &&
      allNumbers(n.inputs as readonly ValueId[]);
    for (const n of g.nodes) {
      const o = n.outputs[0] as ValueId | undefined;
      if (o === undefined || escapes.has(o) || !provenNumber.has(o)) continue;
      const us = usesOf.get(o) ?? [];
      if (us.length > 0 && us.every(numericUse)) rawNumbers.add(o);
    }
  }
  /** A double result for `out`: its bits as they are when only numeric operations read it. */
  const numberResult = (out: ValueId, d: string): string => {
    if (!rawNumbers.has(out)) return boxDouble(d);
    const bits = fresh();
    emit(`${bits} = bitcast double ${d} to i64`);
    return bits;
  };
  /** Whether a value is a typed BigInt: an i128 (a literal, or an operation the proof types). */
  const isTypedBig = (v: ValueId): boolean =>
    widthOf(v) !== undefined && (widthOf(v) as number) <= 127;
  const bigSlots = new Map<ValueId, string>();
  const bigSlotOf = (v: ValueId): string => {
    let s0 = bigSlots.get(v);
    if (s0 === undefined) {
      s0 = `%b${bigSlots.size}`;
      bigSlots.set(v, s0);
    }
    return s0;
  };

  const params = g.nodes
    .filter((n) => n.kind === "param-source")
    .sort((a, b) => paramIndex(a.label) - paramIndex(b.label));

  const body: string[] = [];
  const entryAllocas: string[] = [];
  const slots = new Map<ValueId, string>();
  let temp = 0;
  let label = 0;
  const fresh = (): string => `%t${temp++}`;
  const freshLabel = (what: string): string => `${what}${label++}`;
  const emit = (line: string): void => void body.push(`  ${line}`);
  // The block being written: the entry block until the first label.
  let current = "entry";
  const block = (lbl: string): void => {
    body.push(`${lbl}:`);
    current = lbl;
  };
  const currentLabel = (): string => current;
  const slotOf = (v: ValueId): string => {
    let s = slots.get(v);
    if (s === undefined) {
      s = `%s${slots.size}`;
      slots.set(v, s);
    }
    return s;
  };
  const call = (fn: string, args: string): string => {
    m.used.add(fn);
    const r = fresh();
    emit(`${r} = call i64 @${fn}(${args})`);
    return r;
  };
  const str = (text: string): string => {
    const s = m.constant(text);
    return call("yk_string_utf8", `ptr ${s.ptr}, i64 ${s.length}`);
  };
  // Stack arrays live in the entry block: one inside a loop would grow the stack each iteration.
  const list = (values: readonly string[]): string => {
    const at = fresh();
    const n = Math.max(values.length, 1);
    entryAllocas.push(`  ${at} = alloca [${n} x i64]`);
    values.forEach((v, i) => {
      const p = fresh();
      emit(`${p} = getelementptr [${n} x i64], ptr ${at}, i64 0, i64 ${i}`);
      emit(`store i64 ${v}, ptr ${p}`);
    });
    return at;
  };

  const operand = (v0: ValueId): string => {
    const v = resolve(v0);
    const p = producer.get(v);
    if (p?.kind === "literal-source") {
      const text = p.label ?? "";
      if (text === "true") return TRUE;
      if (text === "false") return FALSE;
      if (text === "null") return NULL;
      // `let x;`: undefined until written.
      if (text === "undefined" || text === "Uninitialized") return UNDEFINED;
      if (text.startsWith('"')) return str(JSON.parse(text) as string);
      // A regex literal: its object, made when the function starts.
      if (text.startsWith("/")) {
        const r = fresh();
        emit(`${r} = load i64, ptr ${slotOf(v)}`);
        return r;
      }
      if (BIGINT_LITERAL.test(text)) {
        const digits = m.constant(text.slice(0, -1), true);
        return call("yk_bigint_literal", `ptr ${digits.ptr}, i64 ${digits.length}`);
      }
      const n = Number(text.replace(/_/g, ""));
      if (text === "" || (Number.isNaN(n) && text !== "NaN"))
        throw new LlvmEmitError(`the literal ${text} is not in the subset yet`);
      return boxedNumber(n);
    }
    if (p?.kind === "diamond-source") {
      const leaf = leafValue.get(v);
      if (leaf !== undefined) {
        // A leaf as a value: the runtime's function value for it.
        const key = m.constant(leaf);
        return call("yk_global", `ptr ${key.ptr}, i64 ${key.length}`);
      }
      const free = freeValue.get(v);
      if (free !== undefined) {
        // A name the module does not declare and the platform does not give is absent: undefined,
        // what a probe for it (`typeof define`) sees. The gate admits such a name only when it is
        // probed (DEC-DUC-FEATURE-DETECTION-001).
        return scope?.read(free, emit, fresh) ?? UNDEFINED;
      }
      const sym = globalValue.get(v);
      if (sym === undefined) throw new LlvmEmitError("Math is not a value here");
      const key = m.constant(sym);
      return call("yk_global", `ptr ${key.ptr}, i64 ${key.length}`);
    }
    if (bigWidth.has(v)) return boxBig(bigOperand(v));
    const r = fresh();
    emit(`${r} = load i64, ptr ${slotOf(v)}`);
    return r;
  };
  const set = (v: ValueId, r: string): void => emit(`store i64 ${r}, ptr ${slotOf(v)}`);
  /** A typed BigInt's i128: a literal's constant, or the value's own slot. */
  const bigOperand = (v0: ValueId): string => {
    const v = resolve(v0);
    const lit = literalBig(v);
    if (lit !== undefined) return lit.toString();
    const r = fresh();
    emit(`${r} = load i128, ptr ${bigSlotOf(v)}`);
    return r;
  };
  /** An i128 as a boxed BigInt (the runtime's). */
  const boxBig = (x: string): string => {
    const lo = fresh();
    emit(`${lo} = trunc i128 ${x} to i64`);
    const sh = fresh();
    emit(`${sh} = lshr i128 ${x}, 64`);
    const hi = fresh();
    emit(`${hi} = trunc i128 ${sh} to i64`);
    return call("yk_bigint_from_i128", `i64 ${lo}, i64 ${hi}`);
  };
  /** A boxed BigInt the proof says fits as an i128 (a runtime leaf's result): its i128. */
  const unboxBig = (b: string): string => {
    m.used.add("yk_bigint_word");
    const lo = fresh();
    emit(`${lo} = call i64 @yk_bigint_word(i64 ${b}, i32 0)`);
    const hi = fresh();
    emit(`${hi} = call i64 @yk_bigint_word(i64 ${b}, i32 1)`);
    const l = fresh();
    emit(`${l} = zext i64 ${lo} to i128`);
    const h0 = fresh();
    emit(`${h0} = zext i64 ${hi} to i128`);
    const h = fresh();
    emit(`${h} = shl i128 ${h0}, 64`);
    const r = fresh();
    emit(`${r} = or i128 ${h}, ${l}`);
    return r;
  };
  const setBig = (v: ValueId, x: string): void => emit(`store i128 ${x}, ptr ${bigSlotOf(v)}`);
  /**
   * An operation with a number's fast path: `fast` (given the operands as doubles) inline when every
   * operand is a number (and `guard` holds), else `slow` (the runtime's). The value, boxed.
   */
  const numberFast = (
    args: readonly string[],
    fast: (ds: readonly string[]) => string,
    slow: () => string,
    guard?: (ds: readonly string[]) => string,
    proven = false,
  ): string => {
    if (proven && guard === undefined) {
      // Every operand a proven number: the double operation alone.
      return fast(
        args.map((a) => {
          const d = fresh();
          emit(`${d} = bitcast i64 ${a} to double`);
          return d;
        }),
      );
    }
    const fastLabel = freshLabel("fast");
    const slowLabel = freshLabel("slow");
    const join = freshLabel("joined");
    let all = proven ? "true" : "";
    for (const a of proven ? [] : args) {
      const n = fresh();
      emit(`${n} = icmp ult i64 ${a}, ${NUMBER_LIMIT}`);
      if (all === "") all = n;
      else {
        const both = fresh();
        emit(`${both} = and i1 ${all}, ${n}`);
        all = both;
      }
    }
    const check = freshLabel("check");
    emit(`br i1 ${all}, label %${check}, label %${slowLabel}`);
    block(check);
    const ds = args.map((a) => {
      const d = fresh();
      emit(`${d} = bitcast i64 ${a} to double`);
      return d;
    });
    if (guard !== undefined) emit(`br i1 ${guard(ds)}, label %${fastLabel}, label %${slowLabel}`);
    else emit(`br label %${fastLabel}`);
    block(fastLabel);
    const r1 = fast(ds);
    const fastEnd = currentLabel();
    emit(`br label %${join}`);
    block(slowLabel);
    const r2 = slow();
    const slowEnd = currentLabel();
    emit(`br label %${join}`);
    block(join);
    const r = fresh();
    emit(`${r} = phi i64 [ ${r1}, %${fastEnd} ], [ ${r2}, %${slowEnd} ]`);
    return r;
  };
  /** A double as a boxed number, NaN made canonical. */
  const boxDouble = (d: string): string => {
    const bits = fresh();
    emit(`${bits} = bitcast double ${d} to i64`);
    const nan = fresh();
    emit(`${nan} = fcmp uno double ${d}, ${d}`);
    const r = fresh();
    emit(`${r} = select i1 ${nan}, i64 ${CANONICAL_NAN}, i64 ${bits}`);
    return r;
  };
  /** Whether a double is below 2^63 in magnitude: its int64 conversion is ToInt32's modulo. */
  const smallDouble = (d: string): string => {
    const abs = fresh();
    emit(`${abs} = call double @llvm.fabs.f64(double ${d})`);
    m.intrinsics.add("declare double @llvm.fabs.f64(double)");
    const ok = fresh();
    emit(`${ok} = fcmp olt double ${abs}, 9.2e18`);
    return ok;
  };
  const toInt32 = (d: string): string => {
    const w = fresh();
    emit(`${w} = fptosi double ${d} to i64`);
    const i = fresh();
    emit(`${i} = trunc i64 ${w} to i32`);
    return i;
  };
  /**
   * A load or store of the memory leaves, inline when its address (and a store's value) is a number,
   * the address an integer inside the runtime's cached region (and it writable, for a store);
   * `slow` (the runtime's leaf) otherwise.
   */
  /** An integer the graph fixes: a literal, or + - * of such (raise-c's `i * 8`). */
  const constantInt = (c0: ValueId, depth = 0): number | undefined => {
    const lit = literalNumber(c0);
    if (lit !== undefined) return Number.isSafeInteger(lit) ? lit : undefined;
    const q = producer.get(resolve(c0));
    if (depth > 8 || q?.kind !== "op" || q.inputs.length !== 2) return undefined;
    const a = constantInt(q.inputs[0] as ValueId, depth + 1);
    const b = constantInt(q.inputs[1] as ValueId, depth + 1);
    if (a === undefined || b === undefined) return undefined;
    const r =
      q.label === "+" ? a + b : q.label === "-" ? a - b : q.label === "*" ? a * b : undefined;
    return r !== undefined && Number.isSafeInteger(r) ? r : undefined;
  };
  /**
   * Known spans of memory (#1369): this function's frames (`__ykAlloc` of a constant size) and the
   * pointer parameters it reads at constant offsets. Each: slots for the address's own byte, the
   * region's header and the region's base (the header holds it while the region lives), and the
   * span's length.
   */
  const frames = new Map<ValueId, { bytes: string; hdr: string; base: string; len: number }>();
  /** An address that is a frame plus a constant inside it, its access of `size` bytes in bounds. */
  const frameAccess = (
    v0: ValueId,
    size: number,
  ): { bytes: string; hdr: string; base: string; off: number } | undefined => {
    const v = resolve(v0);
    let f = frames.get(v);
    let off = 0;
    if (f === undefined) {
      const p = producer.get(v);
      if (p?.kind !== "op" || p.label !== "+" || p.inputs.length !== 2) return undefined;
      for (const [x, y] of [
        [p.inputs[0], p.inputs[1]],
        [p.inputs[1], p.inputs[0]],
      ] as [ValueId, ValueId][]) {
        const k = constantInt(y);
        const g0 = frames.get(resolve(x));
        if (g0 !== undefined && k !== undefined && Number.isInteger(k)) {
          f = g0;
          off = k;
        }
      }
    }
    // A frame's bytes up to 4096 stay the runtime's when it is freed (others go back to the C
    // library), so reading its header after a free is defined.
    if (f === undefined || f.len > 4096 || off < 0 || off + size > f.len) return undefined;
    return { bytes: f.bytes, hdr: f.hdr, base: f.base, off };
  };
  const memoryAccess = (
    mem: { size: number; ty: string; kind: "u" | "f64" | "f32"; store: boolean },
    args: readonly string[],
    slow: () => string,
    /** Which operands (the address, a store's value) the number proof holds. */
    proven: readonly boolean[] = [],
    /** The address is this function's frame at a constant offset: its bytes' and base's slots. */
    frame?: {
      readonly bytes: string;
      readonly hdr: string;
      readonly base: string;
      readonly off: number;
    },
  ): string => {
    for (const d of MEM_CACHE_DECLS) m.intrinsics.add(d);
    m.intrinsics.add("declare double @llvm.fabs.f64(double)");
    const range = freshLabel("mrange");
    const conv = freshLabel("mconv");
    const fast = freshLabel("mfast");
    const slowLabel = freshLabel("mslow");
    const join = freshLabel("mjoin");
    const addr = args[0] as string;
    const value = args[1];
    let p: string;
    let xd = "";
    let siteField: ((k: number) => string) | undefined;
    if (frame !== undefined) {
      // An access at a constant offset inside this function's own frame: the frame's bytes, while
      // the 16 bytes before them hold its base (it is not freed).
      let ok = "true";
      if (mem.store && proven[1] !== true) {
        ok = fresh();
        emit(`${ok} = icmp ult i64 ${value}, ${NUMBER_LIMIT}`);
      }
      if (mem.store) {
        xd = fresh();
        emit(`${xd} = bitcast i64 ${value} to double`);
        if (mem.kind === "u") {
          const small = fresh();
          emit(`${small} = and i1 ${ok}, ${smallDouble(xd)}`);
          ok = small;
        }
      }
      const bytes = fresh();
      emit(`${bytes} = load ptr, ptr ${frame.bytes}`);
      const header = fresh();
      emit(`${header} = load ptr, ptr ${frame.hdr}`);
      const owner = fresh();
      emit(`${owner} = load i64, ptr ${header}`);
      const base = fresh();
      emit(`${base} = load i64, ptr ${frame.base}`);
      const same = fresh();
      emit(`${same} = icmp eq i64 ${owner}, ${base}`);
      const all = fresh();
      emit(`${all} = and i1 ${ok}, ${same}`);
      emit(`br i1 ${all}, label %${fast}, label %${slowLabel}`);
      block(fast);
      p = fresh();
      emit(`${p} = getelementptr i8, ptr ${bytes}, i64 ${frame.off}`);
    } else {
      let numbers = "true";
      if (proven[0] !== true) {
        numbers = fresh();
        emit(`${numbers} = icmp ult i64 ${addr}, ${NUMBER_LIMIT}`);
      }
      if (mem.store && proven[1] !== true) {
        const v = fresh();
        emit(`${v} = icmp ult i64 ${value}, ${NUMBER_LIMIT}`);
        const both = fresh();
        emit(`${both} = and i1 ${numbers}, ${v}`);
        numbers = both;
      }
      emit(`br i1 ${numbers}, label %${range}, label %${slowLabel}`);
      block(range);
      const d = fresh();
      emit(`${d} = bitcast i64 ${addr} to double`);
      const nonneg = fresh();
      emit(`${nonneg} = fcmp oge double ${d}, 0.0`);
      const below = fresh();
      emit(`${below} = fcmp olt double ${d}, 9.2e18`);
      let ok = fresh();
      emit(`${ok} = and i1 ${nonneg}, ${below}`);
      if (mem.store) {
        xd = fresh();
        emit(`${xd} = bitcast i64 ${value} to double`);
        if (mem.kind === "u") {
          // ToInt32 of the value inline needs it below 2^63 in magnitude.
          const small = fresh();
          emit(`${small} = and i1 ${ok}, ${smallDouble(xd)}`);
          ok = small;
        }
      }
      emit(`br i1 ${ok}, label %${conv}, label %${slowLabel}`);
      block(conv);
      const i = fresh();
      emit(`${i} = fptosi double ${d} to i64`);
      const back = fresh();
      emit(`${back} = sitofp i64 ${i} to double`);
      const integral = fresh();
      emit(`${integral} = fcmp oeq double ${back}, ${d}`);
      // Two caches, inline: the runtime's (the region last allocated or found: a new frame's) and
      // this site's own (the region this access last hit: its base, length, bytes and the runtime's
      // epoch then). A site's region is that region still while the 16 bytes before its bytes hold
      // its base (a free clears them) and the epoch is the same (a large region's bytes going back to
      // the C library changes it). A store site's cache is only ever filled by a store that
      // succeeded, so its region is writable.
      const within = (base: string, len: string): { off: string; ok: string } => {
        const off = fresh();
        emit(`${off} = sub i64 ${i}, ${base}`);
        const room = fresh();
        emit(`${room} = icmp uge i64 ${len}, ${mem.size}`);
        const lim = fresh();
        emit(`${lim} = sub i64 ${len}, ${mem.size}`);
        const inside = fresh();
        emit(`${inside} = icmp ule i64 ${off}, ${lim}`);
        const a1 = fresh();
        emit(`${a1} = and i1 ${integral}, ${room}`);
        const ok = fresh();
        emit(`${ok} = and i1 ${a1}, ${inside}`);
        return { off, ok };
      };
      // The runtime's two entries: the region last allocated or found, and the one before it (a
      // callee's frame, then its caller's).
      const hits: [string, string][] = [];
      for (const g0 of ["@yk_mcache", "@yk_mcache2"]) {
        const gBase = fresh();
        emit(`${gBase} = load i64, ptr ${g0}_base`);
        const gLen = fresh();
        emit(`${gLen} = load i64, ptr ${g0}_len`);
        const g = within(gBase, gLen);
        let gOk = g.ok;
        if (mem.store) {
          const w = fresh();
          emit(`${w} = load i64, ptr ${g0}_writable`);
          const wr = fresh();
          emit(`${wr} = icmp ne i64 ${w}, 0`);
          const both = fresh();
          emit(`${both} = and i1 ${gOk}, ${wr}`);
          gOk = both;
        }
        const gHit = freshLabel("mglobal");
        const next = freshLabel("mnext");
        emit(`br i1 ${gOk}, label %${gHit}, label %${next}`);
        block(gHit);
        const gBytes = fresh();
        emit(`${gBytes} = load ptr, ptr ${g0}_bytes`);
        const gP = fresh();
        emit(`${gP} = getelementptr i8, ptr ${gBytes}, i64 ${g.off}`);
        emit(`br label %${fast}`);
        hits.push([gP, gHit]);
        block(next);
      }
      const site = `@yk.msite.${memorySites++}`;
      m.intrinsics.add(`${site} = internal global [4 x i64] zeroinitializer`);
      siteField = (k: number): string => {
        const q = fresh();
        emit(`${q} = getelementptr [4 x i64], ptr ${site}, i64 0, i64 ${k}`);
        return q;
      };
      const base = fresh();
      emit(`${base} = load i64, ptr ${site}`);
      const len = fresh();
      emit(`${len} = load i64, ptr ${siteField(1)}`);
      const siteEpoch = fresh();
      emit(`${siteEpoch} = load i64, ptr ${siteField(3)}`);
      const epoch = fresh();
      emit(`${epoch} = load i64, ptr @yk_mcache_epoch`);
      const current = fresh();
      emit(`${current} = icmp eq i64 ${siteEpoch}, ${epoch}`);
      const sc = within(base, len);
      const all = fresh();
      emit(`${all} = and i1 ${sc.ok}, ${current}`);
      const live = freshLabel("mlive");
      emit(`br i1 ${all}, label %${live}, label %${slowLabel}`);
      block(live);
      const bytes = fresh();
      emit(`${bytes} = load ptr, ptr ${siteField(2)}`);
      const header = fresh();
      emit(`${header} = getelementptr i8, ptr ${bytes}, i64 -16`);
      const owner = fresh();
      emit(`${owner} = load i64, ptr ${header}`);
      const same = fresh();
      emit(`${same} = icmp eq i64 ${owner}, ${base}`);
      const sP = fresh();
      emit(`${sP} = getelementptr i8, ptr ${bytes}, i64 ${sc.off}`);
      emit(`br i1 ${same}, label %${fast}, label %${slowLabel}`);
      block(fast);
      p = fresh();
      emit(`${p} = phi ptr ${[...hits, [sP, live]].map(([v, l]) => `[ ${v}, %${l} ]`).join(", ")}`);
    }
    let r1: string;
    if (mem.store) {
      if (mem.kind === "u") {
        const w = fresh();
        emit(`${w} = fptosi double ${xd} to i64`);
        const t = fresh();
        emit(`${t} = trunc i64 ${w} to ${mem.ty}`);
        emit(`store ${mem.ty} ${t}, ptr ${p}, align 1`);
      } else if (mem.kind === "f64") emit(`store double ${xd}, ptr ${p}, align 1`);
      else {
        const f = fresh();
        emit(`${f} = fptrunc double ${xd} to float`);
        emit(`store float ${f}, ptr ${p}, align 1`);
      }
      r1 = value as string;
    } else {
      const v = fresh();
      emit(`${v} = load ${mem.ty}, ptr ${p}, align 1`);
      if (mem.kind === "u") {
        const z = fresh();
        emit(`${z} = zext ${mem.ty} ${v} to i64`);
        const f = fresh();
        emit(`${f} = uitofp i64 ${z} to double`);
        r1 = fresh();
        emit(`${r1} = bitcast double ${f} to i64`);
      } else if (mem.kind === "f64") r1 = boxDouble(v);
      else {
        const f = fresh();
        emit(`${f} = fpext float ${v} to double`);
        r1 = boxDouble(f);
      }
    }
    const fastEnd = currentLabel();
    emit(`br label %${join}`);
    block(slowLabel);
    const r2 = slow();
    // The runtime found the region (or trapped) and cached it: this site's cache is it now.
    for (const [k, from, ty] of siteField === undefined
      ? []
      : ([
          [0, "@yk_mcache_base", "i64"],
          [1, "@yk_mcache_len", "i64"],
          [2, "@yk_mcache_bytes", "ptr"],
          [3, "@yk_mcache_epoch", "i64"],
        ] as const)) {
      const q = fresh();
      emit(`${q} = load ${ty}, ptr ${from}`);
      emit(`store ${ty} ${q}, ptr ${(siteField as (k: number) => string)(k)}`);
    }
    const slowEnd = currentLabel();
    emit(`br label %${join}`);
    block(join);
    const r = fresh();
    emit(`${r} = phi i64 [ ${r1}, %${fastEnd} ], [ ${r2}, %${slowEnd} ]`);
    return r;
  };
  const boolBox = (b: string): string => {
    const r = fresh();
    emit(`${r} = select i1 ${b}, i64 ${TRUE}, i64 ${FALSE}`);
    return r;
  };
  const truthy = (v: ValueId): string => {
    m.used.add("yk_truthy");
    const x = operand(v);
    if (allNumbers([v])) {
      // A proven number is falsy when it is 0, -0 or NaN.
      const d = fresh();
      emit(`${d} = bitcast i64 ${x} to double`);
      const t = fresh();
      emit(`${t} = fcmp one double ${d}, 0.0`);
      return t;
    }
    // true and false are themselves (a comparison's result, most often): no call.
    const isTrue = fresh();
    emit(`${isTrue} = icmp eq i64 ${x}, ${TRUE}`);
    const isFalse = fresh();
    emit(`${isFalse} = icmp eq i64 ${x}, ${FALSE}`);
    const isBool = fresh();
    emit(`${isBool} = or i1 ${isTrue}, ${isFalse}`);
    const boolLabel = freshLabel("isbool");
    const otherLabel = freshLabel("notbool");
    const truthJoin = freshLabel("truth");
    emit(`br i1 ${isBool}, label %${boolLabel}, label %${otherLabel}`);
    block(boolLabel);
    emit(`br label %${truthJoin}`);
    block(otherLabel);
    // A number is falsy when it is 0, -0 or NaN; true and false are themselves; else the runtime's.
    const r = numberFast(
      [x],
      ([d]) => {
        const t = fresh();
        emit(`${t} = fcmp one double ${d}, 0.0`);
        return boolBox(t);
      },
      () => {
        const i = fresh();
        emit(`${i} = call i32 @yk_truthy(i64 ${x})`);
        const t = fresh();
        emit(`${t} = icmp ne i32 ${i}, 0`);
        return boolBox(t);
      },
    );
    const b = fresh();
    emit(`${b} = icmp eq i64 ${r}, ${TRUE}`);
    const otherEnd = currentLabel();
    emit(`br label %${truthJoin}`);
    block(truthJoin);
    const t = fresh();
    emit(`${t} = phi i1 [ ${isTrue}, %${boolLabel} ], [ ${b}, %${otherEnd} ]`);
    return t;
  };

  /** Whether a value is a spread element (`...xs`): the list it is in expands it. */
  const isSpread = (v: ValueId): boolean => producer.get(resolve(v))?.label === "...";
  /** A list with spread elements, expanded: an array value. */
  const spreadList = (vs: readonly ValueId[]): string => {
    const items = vs.map(operand);
    const flags = vs.map((v) => (isSpread(v) ? TRUE : FALSE));
    return call("yk_spread_list", `i64 ${items.length}, ptr ${list(items)}, ptr ${list(flags)}`);
  };

  /** A closure node: its graph lowered to a function, and the record that holds its captures. */
  const makeClosure = (n: DucNode): string => {
    const graph = n.closure as DucGraph;
    const lbl = n.label ?? "";
    const MODES: Record<string, [number, number]> = {
      closure: [0, 0],
      function: [1, 0],
      "async closure": [0, 1],
      "async function": [1, 1],
      "function*": [1, 2],
    };
    const shape = MODES[lbl];
    if (shape === undefined)
      throw new LlvmEmitError(`a "${lbl}" function is not in the subset yet`);
    const [hasThis, mode] = shape;
    const fn = m.closureName(name);
    // Inside a module, a closure's free names are its captures; it keeps the module's platform rule.
    const inner: ModuleScope | undefined =
      scope === undefined ? undefined : { read: () => undefined, write: () => false };
    lowerFunction(m, graph, fn, { captures: n.inputs.length }, inner);
    const caps = n.inputs.map(operand);
    m.used.add("yk_closure_new");
    const r = fresh();
    emit(
      `${r} = call i64 @yk_closure_new(ptr @${fn}, i32 ${hasThis}, i64 ${caps.length}, ptr ${list(caps)})`,
    );
    const made = mode === 0 ? r : call("yk_closure_mode", `i64 ${r}, i32 ${mode}`);
    // Made inside a class's member, it knows the class (`class-self`) as the member does.
    return closure === undefined ? made : call("yk_closure_inherit", `i64 ${made}, ptr %closure`);
  };

  /** A typed BigInt producer's i128. */
  const typedBig = (n: DucNode): string => {
    const ins = n.inputs as readonly ValueId[];
    const lbl = n.label ?? "";
    const leaf = leafOf(n);
    const r = fresh();
    if (leaf !== undefined) {
      const a = ins[1] as ValueId;
      const [fn] = LEAVES[leaf] as [string, number];
      if ((leaf === "__ykU64" || leaf === "__ykI64") && isTypedBig(a)) {
        const x = bigOperand(a);
        const t = fresh();
        emit(`${t} = trunc i128 ${x} to i64`);
        emit(`${r} = ${leaf === "__ykU64" ? "zext" : "sext"} i64 ${t} to i128`);
        return r;
      }
      if (leaf === "__ykNumToBig" || leaf === "__ykF64Bits") {
        // A number: its bits (__ykF64Bits), or (__ykNumToBig, the number proved an int32 or uint32)
        // its integer; anything else, the runtime's conversion (or its error).
        const bits = leaf === "__ykF64Bits";
        // A number proved an int32 or uint32 (or not a number: the runtime's conversion).
        const x = operand(a);
        const isNum = fresh();
        emit(`${isNum} = icmp ult i64 ${x}, ${NUMBER_LIMIT}`);
        const fast = freshLabel("nbfast");
        const slow = freshLabel("nbslow");
        const join = freshLabel("nbjoin");
        emit(`br i1 ${isNum}, label %${fast}, label %${slow}`);
        block(fast);
        const w = fresh();
        if (bits) emit(`${w} = zext i64 ${x} to i128`);
        else {
          const d = fresh();
          emit(`${d} = bitcast i64 ${x} to double`);
          const i = fresh();
          emit(`${i} = fptosi double ${d} to i64`);
          emit(`${w} = sext i64 ${i} to i128`);
        }
        const fastEnd = currentLabel();
        emit(`br label %${join}`);
        block(slow);
        const b = call(fn, `i64 ${x}`);
        const u = unboxBig(b);
        const slowEnd = currentLabel();
        emit(`br label %${join}`);
        block(join);
        emit(`${r} = phi i128 [ ${w}, %${fastEnd} ], [ ${u}, %${slowEnd} ]`);
        return r;
      }
      // __ykU64/__ykI64 of a boxed value, __ykLoad64: the runtime's leaf, its result unboxed.
      const args = ins.slice(1).map(operand);
      return unboxBig(call(fn, args.map((x) => `i64 ${x}`).join(", ")));
    }
    if (ins.length === 1) {
      const x = bigOperand(ins[0] as ValueId);
      if (lbl === "-") emit(`${r} = sub i128 0, ${x}`);
      else emit(`${r} = xor i128 ${x}, -1`);
      return r;
    }
    const a = bigOperand(ins[0] as ValueId);
    // A right shift by 127 or more is the sign: an LLVM shift by the width or more is poison.
    const k = literalBig(ins[1] as ValueId);
    const b = lbl === ">>" && k !== undefined && k > 127n ? "127" : bigOperand(ins[1] as ValueId);
    const OPS: Record<string, string> = {
      "+": "add",
      "-": "sub",
      "*": "mul",
      "&": "and",
      "|": "or",
      "^": "xor",
      "<<": "shl",
      ">>": "ashr",
    };
    emit(`${r} = ${OPS[lbl] as string} i128 ${a}, ${b}`);
    return r;
  };
  /**
   * An operation whose operands are typed BigInts and whose result is not one: a comparison, a
   * conversion to a number, a double from bits. Emitted (true), or not this case (false).
   */
  const typedConsumer = (n: DucNode, out: ValueId): boolean => {
    const ins = n.inputs as readonly ValueId[];
    const lbl = n.label ?? "";
    const leaf = leafOf(n);
    if (leaf !== undefined && ins.length === 2 && isTypedBig(ins[1] as ValueId)) {
      const x = bigOperand(ins[1] as ValueId);
      if (leaf === "__ykBigToI32" || leaf === "__ykBigToU32") {
        const t = fresh();
        emit(`${t} = trunc i128 ${x} to i32`);
        const d = fresh();
        emit(`${d} = ${leaf === "__ykBigToI32" ? "sitofp" : "uitofp"} i32 ${t} to double`);
        const bits = fresh();
        emit(`${bits} = bitcast double ${d} to i64`);
        set(out, bits);
        return true;
      }
      if (leaf === "__ykF64FromBits") {
        const t = fresh();
        emit(`${t} = trunc i128 ${x} to i64`);
        const d = fresh();
        emit(`${d} = bitcast i64 ${t} to double`);
        set(out, boxDouble(d));
        return true;
      }
      return false;
    }
    const CMP: Record<string, string> = {
      "===": "eq",
      "==": "eq",
      "!==": "ne",
      "!=": "ne",
      "<": "slt",
      ">": "sgt",
      "<=": "sle",
      ">=": "sge",
    };
    if (
      ins.length === 2 &&
      CMP[lbl] !== undefined &&
      isTypedBig(ins[0] as ValueId) &&
      isTypedBig(ins[1] as ValueId)
    ) {
      const a = bigOperand(ins[0] as ValueId);
      const b = bigOperand(ins[1] as ValueId);
      const c = fresh();
      emit(`${c} = icmp ${CMP[lbl] as string} i128 ${a}, ${b}`);
      set(out, boolBox(c));
      return true;
    }
    return false;
  };

  const emitNode = (n: DucNode): void => {
    if (["literal-source", "param-source", "carry-source", "diamond-source"].includes(n.kind))
      return;
    const out = n.outputs[0] as ValueId | undefined;
    if (n.closure !== undefined) {
      if (out === undefined) throw new LlvmEmitError("a closure with no value");
      set(out, makeClosure(n));
      return;
    }
    if (out === undefined) throw new LlvmEmitError(`"${n.label}" has no result`);
    const lbl = n.label ?? "";
    const ins = n.inputs as readonly ValueId[];
    if (n.kind === "sel") {
      const [c, t, e] = ins as [ValueId, ValueId, ValueId];
      const cond = truthy(c);
      const a = operand(t);
      const b = operand(e);
      const r = fresh();
      emit(`${r} = select i1 ${cond}, i64 ${a}, i64 ${b}`);
      set(out, r);
      return;
    }
    if (n.kind !== "op") throw new LlvmEmitError(`a ${n.kind} node is not in the subset`);
    if (bigWidth.has(out)) {
      setBig(out, typedBig(n));
      return;
    }
    if (typedConsumer(n, out)) return;
    if (lbl === "this" || lbl.startsWith("ThisKeyword#")) {
      // At a CommonJS module's top level, `this` is its exports.
      const top = closure === undefined ? scope?.read("this", emit, fresh) : "%this";
      if (top === undefined) throw new LlvmEmitError("`this` outside a function");
      set(out, top);
      return;
    }
    if (lbl === "instanceof" || lbl === "in") {
      const [a, b] = ins as [ValueId, ValueId];
      set(
        out,
        call(lbl === "in" ? "yk_in" : "yk_instanceof", `i64 ${operand(a)}, i64 ${operand(b)}`),
      );
      return;
    }
    // Optional chaining: undefined when the object (or the callee) is null or undefined.
    if (lbl.startsWith("?.") || lbl === "ElementAccess?." || lbl === "CallExpression?.") {
      const base = ins[0] as ValueId;
      m.used.add("yk_is_nullish");
      const i = fresh();
      emit(`${i} = call i32 @yk_is_nullish(i64 ${operand(base)})`);
      const nullish = fresh();
      emit(`${nullish} = icmp ne i32 ${i}, 0`);
      const skip = freshLabel("absent");
      const go = freshLabel("present");
      const end = freshLabel("chained");
      emit(`br i1 ${nullish}, label %${skip}, label %${go}`);
      block(skip);
      set(out, UNDEFINED);
      emit(`br label %${end}`);
      block(go);
      const plain =
        lbl === "ElementAccess?."
          ? "ElementAccess"
          : lbl === "CallExpression?."
            ? "CallExpression"
            : `.${lbl.slice(2)}`;
      emitNode({ ...n, label: plain });
      emit(`br label %${end}`);
      block(end);
      return;
    }
    if (lbl.startsWith("array-with-holes:"))
      throw new LlvmEmitError(
        "an array with holes is not in the native subset yet: the runtime's arrays have no holes (#1330)",
      );
    // A private name (#1330): its key is the nearest class around this function that declares it,
    // and the member is in the object's private table.
    const privateKey = (name: string): string => {
      const k = m.constant(name);
      return call(
        "yk_private_key",
        `ptr ${closure === undefined ? "null" : "%closure"}, ptr ${k.ptr}, i64 ${k.length}`,
      );
    };
    if (lbl.startsWith("in:#") && ins.length === 1) {
      const key = privateKey(lbl.slice("in:".length));
      set(out, call("yk_private_has", `i64 ${operand(ins[0] as ValueId)}, i64 ${key}`));
      return;
    }
    if (/^\.#[\w$]+$/.test(lbl) && ins.length === 1) {
      const key = privateKey(lbl.slice(1));
      set(out, call("yk_private_get", `i64 ${operand(ins[0] as ValueId)}, i64 ${key}`));
      return;
    }
    if (/^\.#[\w$]+=$/.test(lbl) && ins.length === 2) {
      // The write's value is the object, as a named write's is.
      const key = privateKey(lbl.slice(1, -1));
      const obj = operand(ins[0] as ValueId);
      call("yk_private_set", `i64 ${obj}, i64 ${key}, i64 ${operand(ins[1] as ValueId)}`);
      set(out, obj);
      return;
    }
    if (/^\?\.#/.test(lbl))
      throw new LlvmEmitError(`"${lbl}" is not in the native subset yet (#1330)`);
    if (lbl === "...") {
      // The value spread, iterated here, where the spread is in heap order: a copy of its elements,
      // which the list it is in (an array literal, a call's arguments) expands. The list may be made
      // later, after a write to what was spread (#1330: `const b = [...a]; a.push(x)`).
      set(
        out,
        call(
          "yk_spread_list",
          `i64 1, ptr ${list([operand(ins[0] as ValueId)])}, ptr ${list([TRUE])}`,
        ),
      );
      return;
    }
    if (lbl === "class-self") {
      if (closure === undefined) throw new LlvmEmitError("class-self outside a class's member");
      set(out, call("yk_closure_class", "ptr %closure"));
      return;
    }
    if (lbl.startsWith("Class#"))
      throw new LlvmEmitError(
        "a class the lifter keeps as a summary (a parameter property, a decorator) is not in the subset",
      );
    if (lbl === "AwaitExpression" && ins.length === 1) {
      // The coroutine suspends until the value settles (#1295).
      set(out, call("yk_await", `i64 ${operand(ins[0] as ValueId)}`));
      return;
    }
    if (lbl === "YieldExpression" || lbl === "YieldExpression*") {
      const v = ins.length === 0 ? UNDEFINED : operand(ins[0] as ValueId);
      set(out, call(lbl === "YieldExpression" ? "yk_yield" : "yk_yield_star", `i64 ${v}`));
      return;
    }
    if (lbl === "super") {
      // A derived constructor's super(args): the parent's constructor on this receiver (#1294).
      if (closure === undefined) throw new LlvmEmitError("super() outside a constructor");
      if (ins.some(isSpread)) throw new LlvmEmitError("super(...spread) is not in the subset yet");
      const args = ins.map(operand);
      set(
        out,
        call(
          "yk_super_construct",
          `ptr %closure, i64 %this, i64 ${args.length}, ptr ${list(args)}`,
        ),
      );
      return;
    }
    if (lbl === "super[]") {
      // The parent's member by a key's value, read with the receiver (#1330).
      if (closure === undefined) throw new LlvmEmitError("super outside a class's member");
      set(
        out,
        call(
          "yk_super_get_key",
          `ptr %closure, i64 ${operand(ins[0] as ValueId)}, i64 ${operand(ins[1] as ValueId)}`,
        ),
      );
      return;
    }
    if (lbl.startsWith("super.")) {
      // The parent's member, read with the receiver (#1294).
      if (closure === undefined) throw new LlvmEmitError("super outside a class's member");
      const key = m.constant(lbl.slice("super.".length));
      set(
        out,
        call(
          "yk_super_get",
          `ptr %closure, i64 ${operand(ins[0] as ValueId)}, ptr ${key.ptr}, i64 ${key.length}`,
        ),
      );
      return;
    }
    if (lbl.startsWith("class:")) {
      // [kind, name, static] per member; the inputs are the members' functions, in order, a
      // computed name's key just before its member's (#1330). A derived class's parent is its first
      // input (#1294). A field's function is its initializer; a static block's, its body.
      const all = JSON.parse(lbl.slice("class:".length)) as [string, (string | null)?, boolean?][];
      const derived = all[0]?.[0] === "extends";
      const members = derived ? all.slice(1) : all;
      const parent = derived ? operand(ins[0] as ValueId) : "0";
      const memberIns = derived ? ins.slice(1) : ins;
      const KIND: Record<string, number> = {
        constructor: 0,
        method: 1,
        get: 2,
        set: 3,
        field: 4,
        block: 5,
      };
      const unknown = members.find(([k]) => KIND[k] === undefined);
      if (unknown !== undefined)
        throw new LlvmEmitError(`a class member of kind ${unknown[0]} is not in the subset yet`);
      const names: string[] = [];
      const fns: string[] = [];
      let at = 0;
      for (const [kind, name] of members) {
        const computed = kind !== "constructor" && kind !== "block" && name === null;
        names.push(
          computed
            ? operand(memberIns[at++] as ValueId)
            : name === undefined || name === null
              ? UNDEFINED
              : str(name),
        );
        fns.push(operand(memberIns[at++] as ValueId));
      }
      if (at !== memberIns.length)
        throw new LlvmEmitError("a class's inputs are not its members' keys and functions");
      // A private name's kind is 8 more: a computed key that is a string "#x" is not one.
      const kinds = members.map(([k, name]) =>
        boxedNumber(
          (KIND[k] as number) + (typeof name === "string" && name.startsWith("#") ? 8 : 0),
        ),
      );
      const statics = members.map(([, , isStatic]) => (isStatic === true ? TRUE : FALSE));
      set(
        out,
        call(
          "yk_class_new",
          `ptr ${closure === undefined ? "null" : "%closure"}, i64 ${parent}, i64 ${members.length}, ptr ${list(kinds)}, ptr ${list(names)}, ptr ${list(statics)}, ptr ${list(fns)}`,
        ),
      );
      return;
    }
    if (lbl.startsWith("delete.") && ins.length === 1) {
      const key = m.constant(lbl.slice("delete.".length));
      set(
        out,
        call(
          "yk_delete_named",
          `i64 ${operand(ins[0] as ValueId)}, ptr ${key.ptr}, i64 ${key.length}`,
        ),
      );
      return;
    }
    if (lbl === "delete[]" && ins.length === 2) {
      set(
        out,
        call("yk_delete", `i64 ${operand(ins[0] as ValueId)}, i64 ${operand(ins[1] as ValueId)}`),
      );
      return;
    }
    if (lbl.startsWith(DECLARES)) return; // a statement's result: stored by the statement's end
    if (lbl === "VoidExpression") {
      set(out, UNDEFINED);
      return;
    }
    if (lbl === ",") {
      set(out, operand(ins[ins.length - 1] as ValueId));
      return;
    }
    if (lbl === "throw") {
      m.used.add("yk_throw");
      emit(`call void @yk_throw(i64 ${operand(ins[0] as ValueId)})`);
      set(out, UNDEFINED);
      return;
    }
    if (
      (lbl === "++" || lbl === "post++" || lbl === "--" || lbl === "post--") &&
      ins.length === 1
    ) {
      set(out, call(lbl.endsWith("++") ? "yk_inc" : "yk_dec", `i64 ${operand(ins[0] as ValueId)}`));
      return;
    }
    // a ?? b, and the conditional assignments: a ??= b, a ||= b, a &&= b.
    if (ins.length === 2 && (lbl === "??" || lbl === "??=" || lbl === "||=" || lbl === "&&=")) {
      const [a, b] = ins as [ValueId, ValueId];
      let c: string;
      if (lbl === "??" || lbl === "??=") {
        m.used.add("yk_is_nullish");
        const i = fresh();
        emit(`${i} = call i32 @yk_is_nullish(i64 ${operand(a)})`);
        c = fresh();
        emit(`${c} = icmp eq i32 ${i}, 0`);
      } else c = truthy(a);
      const x = operand(a);
      const y = operand(b);
      const r = fresh();
      emit(
        lbl === "&&="
          ? `${r} = select i1 ${c}, i64 ${y}, i64 ${x}`
          : `${r} = select i1 ${c}, i64 ${x}, i64 ${y}`,
      );
      set(out, r);
      return;
    }
    if (
      ins.length === 2 &&
      lbl.endsWith("=") &&
      BINARY[lbl.slice(0, -1)] !== undefined &&
      lbl !== "==" &&
      lbl !== "!=" &&
      lbl !== "<=" &&
      lbl !== ">=" &&
      lbl !== "===" &&
      lbl !== "!=="
    ) {
      set(
        out,
        call(
          BINARY[lbl.slice(0, -1)] as string,
          `i64 ${operand(ins[0] as ValueId)}, i64 ${operand(ins[1] as ValueId)}`,
        ),
      );
      return;
    }
    if (lbl === "function-self") {
      if (closure === undefined) throw new LlvmEmitError("function-self outside a function");
      set(out, call("yk_closure_self", "ptr %closure"));
      return;
    }
    // A member read: of Math, nothing (the call names it); otherwise the property's value.
    const member = /^\.[\w$]+$/.test(lbl) && ins.length === 1;
    if (member && isMath(ins[0] as ValueId)) return;
    if (member) {
      const key = m.constant(lbl.slice(1));
      set(
        out,
        call(
          "yk_get_named",
          `i64 ${operand(ins[0] as ValueId)}, ptr ${key.ptr}, i64 ${key.length}`,
        ),
      );
      return;
    }
    if (/^\.[\w$]+=$/.test(lbl) && ins.length === 2) {
      const key = m.constant(lbl.slice(1, -1));
      const obj = operand(ins[0] as ValueId);
      set(
        out,
        call(
          "yk_set_named",
          `i64 ${obj}, ptr ${key.ptr}, i64 ${key.length}, i64 ${operand(ins[1] as ValueId)}`,
        ),
      );
      return;
    }
    if (lbl === "ElementAccess" && ins.length === 2) {
      const table = constTables.get(resolve(ins[0] as ValueId));
      if (table !== undefined && tableInRange(n)) {
        // An index the intervals keep in range: the load alone.
        const idx = operand(ins[1] as ValueId);
        const d = fresh();
        emit(`${d} = bitcast i64 ${idx} to double`);
        const i = fresh();
        emit(`${i} = fptosi double ${d} to i64`);
        const p = fresh();
        emit(`${p} = getelementptr [${table.n} x i64], ptr ${table.global}, i64 0, i64 ${i}`);
        const r = fresh();
        emit(`${r} = load i64, ptr ${p}`);
        set(out, r);
        return;
      }
      if (table !== undefined) {
        // A constant table's element at an integer index in range: a load; else the array's read.
        const idx = operand(ins[1] as ValueId);
        set(
          out,
          numberFast(
            [idx],
            ([d]) => {
              const i = fresh();
              emit(`${i} = fptosi double ${d} to i64`);
              const p = fresh();
              emit(`${p} = getelementptr [${table.n} x i64], ptr ${table.global}, i64 0, i64 ${i}`);
              const r = fresh();
              emit(`${r} = load i64, ptr ${p}`);
              return r;
            },
            () => {
              const arr = call("yk_array_of", `i64 ${table.n}, ptr ${table.global}`);
              return call("yk_get", `i64 ${arr}, i64 ${idx}`);
            },
            ([d]) => {
              const nonneg = fresh();
              emit(`${nonneg} = fcmp oge double ${d}, 0.0`);
              const below = fresh();
              emit(`${below} = fcmp olt double ${d}, ${table.n}.0`);
              const inRange = fresh();
              emit(`${inRange} = and i1 ${nonneg}, ${below}`);
              // In range, so fptosi is defined: an integer when converting back gives it again.
              const w = fresh();
              emit(`${w} = fptosi double ${d} to i64`);
              const t = fresh();
              emit(`${t} = sitofp i64 ${w} to double`);
              const integral = fresh();
              emit(`${integral} = fcmp oeq double ${t}, ${d}`);
              const ok = fresh();
              emit(`${ok} = and i1 ${inRange}, ${integral}`);
              return ok;
            },
          ),
        );
        return;
      }
      set(
        out,
        call("yk_get", `i64 ${operand(ins[0] as ValueId)}, i64 ${operand(ins[1] as ValueId)}`),
      );
      return;
    }
    if (lbl === "[]=" && ins.length === 3) {
      const [o, k, v] = ins as [ValueId, ValueId, ValueId];
      set(out, call("yk_set", `i64 ${operand(o)}, i64 ${operand(k)}, i64 ${operand(v)}`));
      return;
    }
    // A module binding the graph reads or writes as itself (#1276): a load or a store of its global.
    if ((lbl === "binding" || lbl === "binding=") && freeValue.has(resolve(ins[0] as ValueId))) {
      const sym = freeValue.get(resolve(ins[0] as ValueId)) as string;
      if (lbl === "binding") {
        set(out, operand(ins[0] as ValueId));
        return;
      }
      const value = operand(ins[1] as ValueId);
      if (scope?.write(sym, value, emit) !== true)
        throw new LlvmEmitError(`"${sym}" is not a binding of the module`);
      set(out, value);
      return;
    }
    if (lbl === "NewExpression") {
      const callee = operand(ins[0] as ValueId);
      if (ins.slice(1).some(isSpread)) {
        set(out, call("yk_new_spread", `i64 ${callee}, i64 ${spreadList(ins.slice(1))}`));
        return;
      }
      const args = ins.slice(1).map(operand);
      set(out, call("yk_new", `i64 ${callee}, i64 ${args.length}, ptr ${list(args)}`));
      return;
    }
    if (lbl === "CallExpression" && leafValue.has(resolve(ins[0] as ValueId))) {
      // A leaf: the runtime's function for it, called directly.
      const leafName = leafValue.get(resolve(ins[0] as ValueId)) as string;
      const [fn, arity] = LEAVES[leafName] as [string, number];
      if (ins.length - 1 !== arity)
        throw new LlvmEmitError(`the leaf ${fn} takes ${arity} arguments`);
      if (leafName === "__ykAlloc") {
        // A frame's block: a constant integral size and power-of-two alignment, with no boxing.
        const size = literalNumber(ins[1] as ValueId);
        const align = literalNumber(ins[2] as ValueId);
        if (
          size !== undefined &&
          align !== undefined &&
          Number.isInteger(size) &&
          size >= 0 &&
          size < 2 ** 31 &&
          Number.isInteger(align) &&
          align >= 1 &&
          align <= 4096 &&
          (align & (align - 1)) === 0
        ) {
          m.intrinsics.add("declare i64 @yk_frame_alloc(i64, i64)");
          m.intrinsics.add("@yk_frame_bytes = external global ptr");
          const r = fresh();
          emit(`${r} = call i64 @yk_frame_alloc(i64 ${size}, i64 ${align})`);
          set(out, r);
          // Its bytes and base, for the accesses at constant offsets inside it.
          const k = frames.size;
          const bytesSlot = `%fb${k}`;
          const hdrSlot = `%fh${k}`;
          const baseSlot = `%fa${k}`;
          entryAllocas.push(
            `  ${bytesSlot} = alloca ptr`,
            `  ${hdrSlot} = alloca ptr`,
            `  ${baseSlot} = alloca i64`,
          );
          const bytes = fresh();
          emit(`${bytes} = load ptr, ptr @yk_frame_bytes`);
          emit(`store ptr ${bytes}, ptr ${bytesSlot}`);
          const hdr = fresh();
          emit(`${hdr} = getelementptr i8, ptr ${bytes}, i64 -16`);
          emit(`store ptr ${hdr}, ptr ${hdrSlot}`);
          const d = fresh();
          emit(`${d} = bitcast i64 ${r} to double`);
          const base = fresh();
          emit(`${base} = fptoui double ${d} to i64`);
          emit(`store i64 ${base}, ptr ${baseSlot}`);
          frames.set(out as ValueId, {
            bytes: bytesSlot,
            hdr: hdrSlot,
            base: baseSlot,
            len: size <= 16 ? 16 : Math.ceil(size / 16) * 16,
          });
          return;
        }
      }
      if (leafName === "__ykFree" && allNumbers([ins[1] as ValueId])) {
        m.intrinsics.add("declare void @yk_frame_free(i64)");
        emit(`call void @yk_frame_free(i64 ${operand(ins[1] as ValueId)})`);
        set(out, UNDEFINED);
        return;
      }
      const data = leafName === "__ykData" ? dataTables.get(resolve(ins[2] as ValueId)) : undefined;
      if (data !== undefined) {
        // Constant data of literal elements: laid out at the first call, its address kept.
        const memo = `@ydata${m.globals.length}`;
        m.globals.push(`${memo} = internal global i64 0`);
        const known = fresh();
        emit(`${known} = load i64, ptr ${memo}`);
        const has = fresh();
        emit(`${has} = icmp ne i64 ${known}, 0`);
        const first = freshLabel("dfirst");
        const join = freshLabel("djoin");
        const before = currentLabel();
        emit(`br i1 ${has}, label %${join}, label %${first}`);
        block(first);
        const kind = operand(ins[1] as ValueId);
        const arr = call("yk_array_of", `i64 ${data.n}, ptr ${data.global}`);
        const made = call(fn, `i64 ${kind}, i64 ${arr}`);
        emit(`store i64 ${made}, ptr ${memo}`);
        const firstEnd = currentLabel();
        emit(`br label %${join}`);
        block(join);
        const r = fresh();
        emit(`${r} = phi i64 [ ${known}, %${before} ], [ ${made}, %${firstEnd} ]`);
        set(out, r);
        return;
      }
      const args = ins.slice(1).map(operand);
      const mem = MEM_INLINE[leafName];
      if (mem !== undefined) {
        set(
          out,
          memoryAccess(
            mem,
            args,
            () => call(fn, args.map((a) => `i64 ${a}`).join(", ")),
            ins.slice(1).map((v) => allNumbers([v as ValueId])),
            frameAccess(ins[1] as ValueId, mem.size),
          ),
        );
        return;
      }
      set(out, call(fn, args.map((a) => `i64 ${a}`).join(", ")));
      return;
    }
    if (lbl === "CallExpression") {
      const callee = memberOf(ins[0] as ValueId);
      const args = ins.slice(1).map(operand);
      if (callee !== undefined && isMath(callee.node.inputs[0] as ValueId)) {
        if (MATH1.has(callee.name) && args.length === 1) {
          const key = m.constant(callee.name, true);
          const slow = (): string => call("yk_math1", `ptr ${key.ptr}, i64 ${args[0]}`);
          // floor, ceil, trunc, sqrt and abs of a number: the exact LLVM intrinsic, inline (#1369).
          const intrinsic = (
            {
              floor: "llvm.floor.f64",
              ceil: "llvm.ceil.f64",
              trunc: "llvm.trunc.f64",
              sqrt: "llvm.sqrt.f64",
              abs: "llvm.fabs.f64",
            } as Record<string, string>
          )[callee.name];
          if (intrinsic !== undefined) {
            m.intrinsics.add(`declare double @${intrinsic}(double)`);
            set(
              out,
              numberFast(
                [args[0] as string],
                ([d]) => {
                  const r = fresh();
                  emit(`${r} = call double @${intrinsic}(double ${d})`);
                  return numberResult(out, r);
                },
                slow,
                undefined,
                allNumbers([ins[1] as ValueId]),
              ),
            );
            return;
          }
          set(out, slow());
          return;
        }
        if ((callee.name === "min" || callee.name === "max") && ins.slice(1).some(isSpread)) {
          const listed = spreadList(ins.slice(1));
          set(
            out,
            call("yk_math_minmax_list", `i32 ${callee.name === "max" ? 1 : 0}, i64 ${listed}`),
          );
          return;
        }
        if (callee.name === "min" || callee.name === "max") {
          set(
            out,
            call(
              "yk_math_minmax",
              `i32 ${callee.name === "max" ? 1 : 0}, i64 ${args.length}, ptr ${list(args)}`,
            ),
          );
          return;
        }
        if (APPROXIMATED.test(callee.name))
          throw new LlvmEmitError(
            `Math.${callee.name} is implementation-approximated in ECMAScript: a native libm need not give the reference's last bit`,
          );
        throw new LlvmEmitError(`Math.${callee.name} is not in the subset yet`);
      }
      if (callee !== undefined && ins.slice(1).some(isSpread)) {
        const key = m.constant(callee.name);
        const recv = operand(callee.node.inputs[0] as ValueId);
        set(
          out,
          call(
            "yk_call_method_spread",
            `i64 ${recv}, ptr ${key.ptr}, i64 ${key.length}, i64 ${spreadList(ins.slice(1))}`,
          ),
        );
        return;
      }
      // super.f(args) and super[k](args): the parent's f, called with the receiver the read was
      // made with (#1294). o[k](args): o's member k, called with o as its receiver (#1330).
      const viaSuper = producer.get(resolve(ins[0] as ValueId));
      const readLabel = viaSuper?.kind === "op" ? (viaSuper.label ?? "") : "";
      const superRecv =
        viaSuper !== undefined &&
        (readLabel.startsWith("super.") ||
          readLabel === "super[]" ||
          readLabel === "ElementAccess" ||
          readLabel === "ElementAccess?." ||
          /^\.#[\w$]+$/.test(readLabel))
          ? operand(viaSuper.inputs[0] as ValueId)
          : UNDEFINED;
      if (callee === undefined && ins.slice(1).some(isSpread)) {
        const fn = operand(ins[0] as ValueId);
        set(
          out,
          call("yk_call_spread", `i64 ${fn}, i64 ${superRecv}, i64 ${spreadList(ins.slice(1))}`),
        );
        return;
      }
      if (callee !== undefined) {
        // A method call: the receiver is the object the member is read from.
        const key = m.constant(callee.name);
        const recv = operand(callee.node.inputs[0] as ValueId);
        set(
          out,
          call(
            "yk_call_method",
            `i64 ${recv}, ptr ${key.ptr}, i64 ${key.length}, i64 ${args.length}, ptr ${list(args)}`,
          ),
        );
        return;
      }
      const fn = operand(ins[0] as ValueId);
      const calleeName = freeValue.get(resolve(ins[0] as ValueId));
      const direct = calleeName !== undefined ? scope?.direct?.(calleeName) : undefined;
      if (direct !== undefined) {
        // A function declaration's own code, called directly when the binding holds its closure (a
        // module not yet evaluated, in a cycle, leaves it undefined: then the generic call's error).
        const argv = list(args);
        const tag = fresh();
        emit(`${tag} = lshr i64 ${fn}, 48`);
        const isClosure = fresh();
        emit(`${isClosure} = icmp eq i64 ${tag}, 65533`);
        const yes = freshLabel("direct");
        const no = freshLabel("indirect");
        const join = freshLabel("called");
        emit(`br i1 ${isClosure}, label %${yes}, label %${no}`);
        block(yes);
        const addr = fresh();
        emit(`${addr} = and i64 ${fn}, 281474976710655`);
        const ptr = fresh();
        emit(`${ptr} = inttoptr i64 ${addr} to ptr`);
        const r1 = fresh();
        emit(
          `${r1} = call i64 @${direct}(ptr ${ptr}, i64 ${superRecv}, i64 ${args.length}, ptr ${argv})`,
        );
        const yesEnd = currentLabel();
        emit(`br label %${join}`);
        block(no);
        const r2 = call("yk_call", `i64 ${fn}, i64 ${superRecv}, i64 ${args.length}, ptr ${argv}`);
        const noEnd = currentLabel();
        emit(`br label %${join}`);
        block(join);
        const r = fresh();
        emit(`${r} = phi i64 [ ${r1}, %${yesEnd} ], [ ${r2}, %${noEnd} ]`);
        set(out, r);
        return;
      }
      set(
        out,
        call("yk_call", `i64 ${fn}, i64 ${superRecv}, i64 ${args.length}, ptr ${list(args)}`),
      );
      return;
    }
    if (ins.length === 2 && BINARY[lbl] !== undefined) {
      const a = operand(ins[0] as ValueId);
      const b = operand(ins[1] as ValueId);
      const slow = (): string => call(BINARY[lbl] as string, `i64 ${a}, i64 ${b}`);
      const arith = FAST_ARITH[lbl];
      const compare = FAST_COMPARE[lbl];
      const bitwise = FAST_BITWISE[lbl];
      if (arith !== undefined) {
        set(
          out,
          numberFast(
            [a, b],
            ([x, y]) => {
              const r = fresh();
              emit(`${r} = ${arith} double ${x}, ${y}`);
              return numberResult(out, r);
            },
            slow,
            undefined,
            allNumbers(ins as readonly ValueId[]),
          ),
        );
        return;
      }
      if (compare !== undefined) {
        set(
          out,
          numberFast(
            [a, b],
            ([x, y]) => {
              const r = fresh();
              emit(`${r} = fcmp ${compare} double ${x}, ${y}`);
              return boolBox(r);
            },
            slow,
            undefined,
            allNumbers(ins as readonly ValueId[]),
          ),
        );
        return;
      }
      if (bitwise !== undefined) {
        const unrangedA = !numRange.has(resolve(ins[0] as ValueId));
        const unrangedB = !numRange.has(resolve(ins[1] as ValueId));
        set(
          out,
          numberFast(
            [a, b],
            ([x, y]) => {
              const i = toInt32(x as string);
              const j = toInt32(y as string);
              const count = fresh();
              if (bitwise === "or" || bitwise === "and" || bitwise === "xor")
                emit(`${count} = add i32 ${j}, 0`);
              else emit(`${count} = and i32 ${j}, 31`);
              const r = fresh();
              emit(`${r} = ${bitwise} i32 ${i}, ${count}`);
              const d = fresh();
              emit(`${d} = ${bitwise === "lshr" ? "uitofp" : "sitofp"} i32 ${r} to double`);
              const bits = fresh();
              emit(`${bits} = bitcast double ${d} to i64`);
              return bits;
            },
            slow,
            // ToInt32 inline needs |x| < 2^63: known for a value the range inference holds.
            unrangedA && unrangedB
              ? ([x, y]) => {
                  const both = fresh();
                  emit(`${both} = and i1 ${smallDouble(x as string)}, ${smallDouble(y as string)}`);
                  return both;
                }
              : unrangedA
                ? ([x]) => smallDouble(x as string)
                : unrangedB
                  ? ([, y]) => smallDouble(y as string)
                  : undefined,
            allNumbers(ins as readonly ValueId[]),
          ),
        );
        return;
      }
      set(out, slow());
      return;
    }
    if (ins.length === 2 && lbl === "**") {
      // Two integer literals whose power is an integer a double holds exactly (2 ** 32): that
      // value, which every pow that is right on exact cases gives.
      const exact = exactPower(
        producer.get(resolve(ins[0] as ValueId)),
        producer.get(resolve(ins[1] as ValueId)),
      );
      if (exact !== undefined) {
        set(out, boxedNumber(exact));
        return;
      }
    }
    if (ins.length === 2 && lbl === "**")
      throw new LlvmEmitError(
        "** is implementation-approximated in ECMAScript: a native pow need not give the reference's last bit",
      );
    if (ins.length === 1 && UNARY[lbl] !== undefined) {
      const x = operand(ins[0] as ValueId);
      const slow = (): string => call(UNARY[lbl] as string, `i64 ${x}`);
      // A number's negation, plus and complement inline (#1369).
      if (lbl === "-" || lbl === "+") {
        set(
          out,
          numberFast(
            [x],
            ([d]) => {
              if (lbl === "+") return x;
              const r = fresh();
              emit(`${r} = fneg double ${d}`);
              return numberResult(out, r);
            },
            slow,
            undefined,
            allNumbers([ins[0] as ValueId]),
          ),
        );
        return;
      }
      if (lbl === "~") {
        set(
          out,
          numberFast(
            [x],
            ([d]) => {
              const i = toInt32(d as string);
              const r = fresh();
              emit(`${r} = xor i32 ${i}, -1`);
              const f = fresh();
              emit(`${f} = sitofp i32 ${r} to double`);
              const bits = fresh();
              emit(`${bits} = bitcast double ${f} to i64`);
              return bits;
            },
            slow,
            numRange.has(resolve(ins[0] as ValueId))
              ? undefined
              : ([d]) => smallDouble(d as string),
            allNumbers([ins[0] as ValueId]),
          ),
        );
        return;
      }
      set(out, slow());
      return;
    }
    if (ins.length === 2 && (lbl === "&&" || lbl === "||")) {
      const [a, b] = ins as [ValueId, ValueId];
      const c = truthy(a);
      const x = operand(a);
      const y = operand(b);
      const r = fresh();
      emit(
        lbl === "&&"
          ? `${r} = select i1 ${c}, i64 ${y}, i64 ${x}`
          : `${r} = select i1 ${c}, i64 ${x}, i64 ${y}`,
      );
      set(out, r);
      return;
    }
    if (lbl === "ArrayLiteral" && (constTables.has(out) || dataTables.has(out))) return; // in place
    if (lbl === "ArrayLiteral") {
      if (ins.some(isSpread)) {
        set(out, spreadList(ins));
        return;
      }
      const elems = ins.map(operand);
      set(out, call("yk_array_of", `i64 ${elems.length}, ptr ${list(elems)}`));
      return;
    }
    if (lbl.startsWith("object:")) {
      const slots = slotsOf(lbl);
      if (slots.some((x) => x.kind === "spread" || x.kind === "get" || x.kind === "set")) {
        // Slot by slot, in source order: a spread copies, an accessor defines, a later key wins.
        let obj = call("yk_object_of", "i64 0, ptr null, ptr null");
        let at = 0;
        for (const slot of slots) {
          if (slot.kind === "unsupported")
            throw new LlvmEmitError(`${slot.what} is not in the subset yet`);
          if (slot.kind === "spread") {
            obj = call("yk_spread_into", `i64 ${obj}, i64 ${operand(ins[at++] as ValueId)}`);
            continue;
          }
          const key =
            slot.kind === "computed" ||
            ((slot.kind === "get" || slot.kind === "set") && slot.name === undefined)
              ? operand(ins[at++] as ValueId)
              : str((slot as { name: string }).name);
          const value = operand(ins[at++] as ValueId);
          obj =
            slot.kind === "get"
              ? call("yk_define_accessor", `i64 ${obj}, i64 ${key}, i64 ${value}, i64 ${UNDEFINED}`)
              : slot.kind === "set"
                ? call(
                    "yk_define_accessor",
                    `i64 ${obj}, i64 ${key}, i64 ${UNDEFINED}, i64 ${value}`,
                  )
                : call("yk_define", `i64 ${obj}, i64 ${key}, i64 ${value}`);
        }
        set(out, obj);
        return;
      }
      // Keys and values in source order: a computed key is the input before its value.
      const keys: string[] = [];
      const values: string[] = [];
      let at = 0;
      for (const slot of slots) {
        if (
          slot.kind === "unsupported" ||
          slot.kind === "spread" ||
          slot.kind === "get" ||
          slot.kind === "set"
        )
          throw new LlvmEmitError("an object literal slot that is not a plain one");
        keys.push(
          slot.kind === "computed"
            ? operand(ins[at++] as ValueId)
            : str((slot as { name: string }).name),
        );
        values.push(operand(ins[at++] as ValueId));
      }
      set(out, call("yk_object_of", `i64 ${keys.length}, ptr ${list(keys)}, ptr ${list(values)}`));
      return;
    }
    if (lbl.startsWith("template:")) {
      const strings = (JSON.parse(lbl.slice("template:".length)) as string[]).map(str);
      const subs = ins.map(operand);
      set(out, call("yk_template", `i64 ${subs.length}, ptr ${list(strings)}, ptr ${list(subs)}`));
      return;
    }
    throw new LlvmEmitError(`the operation "${lbl}" is not in the subset yet`);
  };

  const emitItems = (items: readonly ScopeItem[]): void => {
    for (const it of items) {
      if (it.kind === "node") emitNode(it.node);
      else if (it.kind === "branch") emitBranch(it.branch);
      else emitLoop(it.node);
    }
  };
  const emitScope = (scope: string | undefined): void =>
    emitItems(planner.ordered(planner.itemsOf(scope)));

  const emitBranch = (b: DucBranch): void => {
    const joins = g.nodes.filter((n) => owners.get(n.id)?.id === b.id);
    const thenL = freshLabel("then");
    const elseL = freshLabel("else");
    const endL = freshLabel("end");
    emit(`br i1 ${truthy(b.cond)}, label %${thenL}, label %${elseL}`);
    for (const [side, lbl, input] of [
      ["t", thenL, 1],
      ["e", elseL, 2],
    ] as const) {
      block(lbl);
      emitScope(sidePath(b, side));
      for (const j of joins) set(j.outputs[0] as ValueId, operand(j.inputs[input] as ValueId));
      emit(`br label %${endL}`);
    }
    block(endL);
  };

  const emitLoop = (loop: DucNode): void => {
    const rec = loop.loop as DucLoop;
    rec.carry.forEach((c, i) => set(c, operand(loop.inputs[i] as ValueId)));
    const head = freshLabel("loop");
    const inner = freshLabel("body");
    const exit = freshLabel("exit");
    // An iteration: an iterator over the input after the carries, asked for the next element first.
    let iterator: string | undefined;
    // for await (x of it): the runtime has no async iterables (no symbols, no async generators),
    // so `it` is iterated as it is and each element awaited, as ECMAScript does for a sync
    // iterable (CreateAsyncFromSyncIterator, #1330).
    const awaitEach = rec.iterate?.of === "async values";
    if (rec.iterate !== undefined) {
      m.used.add("yk_iter_new");
      const iterable = operand(loop.inputs[rec.carry.length] as ValueId);
      iterator = fresh();
      emit(
        `${iterator} = call i64 @yk_iter_new(i64 ${iterable}, i32 ${rec.iterate.of === "keys" ? 1 : 0})`,
      );
    }
    emit(`br label %${head}`);
    block(head);
    if (rec.iterate !== undefined && iterator !== undefined) {
      m.used.add("yk_iter_next");
      const cell = fresh();
      entryAllocas.push(`  ${cell} = alloca i64`);
      const has = fresh();
      emit(`${has} = call i32 @yk_iter_next(i64 ${iterator}, ptr ${cell})`);
      const more = fresh();
      emit(`${more} = icmp ne i32 ${has}, 0`);
      const got = freshLabel("element");
      emit(`br i1 ${more}, label %${got}, label %${exit}`);
      block(got);
      const element = fresh();
      emit(`${element} = load i64, ptr ${cell}`);
      set(rec.iterate.element, awaitEach ? call("yk_await", `i64 ${element}`) : element);
    }
    const items = planner.ordered(planner.itemsOf(bodyPathOf(loop)));
    const forCond = new Set<ScopeItem>();
    const want = rec.cond !== undefined ? [resolve(rec.cond)] : [];
    const producedBy = new Map<ValueId, ScopeItem>();
    for (const it of items) for (const v of planner.producesOf(it)) producedBy.set(v, it);
    while (want.length > 0) {
      const v = want.pop() as ValueId;
      const it = producedBy.get(v);
      if (it === undefined || forCond.has(it)) continue;
      forCond.add(it);
      want.push(...planner.needsOf(it));
    }
    emitItems(items.filter((it) => forCond.has(it)));
    if (rec.cond !== undefined) emit(`br i1 ${truthy(rec.cond)}, label %${inner}, label %${exit}`);
    else emit(`br label %${inner}`);
    block(inner);
    emitItems(items.filter((it) => !forCond.has(it)));
    const next = rec.next.map((nv) => operand(nv));
    next.forEach((r, i) => set(rec.carry[i] as ValueId, r));
    emit(`br label %${head}`);
    block(exit);
    // Left early (a break, or a return carried out of the loop), a generator is closed: its
    // finally blocks run (IteratorClose, #1330). One that is done is left as it is.
    if (iterator !== undefined) {
      m.used.add("yk_iter_close");
      emit(`call void @yk_iter_close(i64 ${iterator})`);
    }
    loop.outputs.forEach((v, i) => set(v, operand(rec.carry[i] as ValueId)));
  };

  // Each regex literal: its matcher compiled from the pattern and lowered (once per module), and
  // its object made here (DEC-DUC-REGEX-GRAPH-001).
  for (const n of g.nodes) {
    const text = n.label ?? "";
    if (n.kind !== "literal-source" || !text.startsWith("/")) continue;
    let compiled: ReturnType<typeof regexMatcherGraph>;
    try {
      compiled = regexMatcherGraph(text);
    } catch (e) {
      if (e instanceof RegexCompileError) throw new LlvmEmitError(e.message);
      throw e;
    }
    let fn = m.matchers.get(text);
    if (fn === undefined) {
      fn = m.closureName(`${name.replace(/"/g, "")}.regex`);
      m.matchers.set(text, fn);
      // The matcher is lifted here, so it is read as ECMAScript reads it, as every graph is (#1310).
      lowerFunction(m, ecmaScriptView(compiled.graph), fn, { captures: 0 });
    }
    m.used.add("yk_closure_new");
    const matcher = fresh();
    emit(`${matcher} = call i64 @yk_closure_new(ptr @${fn}, i32 0, i64 0, ptr null)`);
    const names = compiled.parsed.names.map((nm) => (nm === undefined ? UNDEFINED : str(nm)));
    const namesArray = call("yk_array_of", `i64 ${names.length}, ptr ${list(names)}`);
    set(
      n.outputs[0] as ValueId,
      call(
        "yk_regexp_new",
        `i64 ${str(compiled.pattern)}, i64 ${str(compiled.flags)}, i64 ${matcher}, i64 ${namesArray}`,
      ),
    );
  }
  // Parameters: the entry function's own; a closure's captures, then its arguments.
  params.forEach((p, i) => {
    const v = p.outputs[0] as ValueId;
    if (closure === undefined && (p.label ?? "").endsWith("..."))
      throw new LlvmEmitError("a rest parameter of the exported function is not in the subset yet");
    if (closure === undefined) set(v, `%p${i}`);
    else if (i < closure.captures) set(v, call("yk_capture", `ptr %closure, i64 ${i}`));
    else if ((p.label ?? "").endsWith("..."))
      set(v, call("yk_rest", `i64 %argc, ptr %argv, i64 ${i - closure.captures}`));
    else {
      // The argument, or undefined past argc: inline (#1369).
      const k = i - closure.captures;
      const has = fresh();
      emit(`${has} = icmp ugt i64 %argc, ${k}`);
      const at = fresh();
      emit(`${at} = getelementptr i64, ptr %argv, i64 ${k}`);
      const given = freshLabel("arg");
      const join = freshLabel("argd");
      const entryEnd = currentLabel();
      emit(`br i1 ${has}, label %${given}, label %${join}`);
      block(given);
      const x = fresh();
      emit(`${x} = load i64, ptr ${at}`);
      emit(`br label %${join}`);
      block(join);
      const r = fresh();
      emit(`${r} = phi i64 [ ${x}, %${given} ], [ ${UNDEFINED}, %${entryEnd} ]`);
      set(v, r);
    }
  });
  // Parameter speculation (#1369): a function whose arguments feed numeric operations is also
  // lowered taking them as numbers. Called with numbers, it runs that clone; with anything else,
  // the lowering below, which checks each operation.
  if (
    numberParams === undefined &&
    closure !== undefined &&
    source.mode === undefined &&
    scope?.outs === undefined &&
    !g.nodes.some(
      (n) =>
        n.closure !== undefined ||
        (n.kind === "loop" && n.loop?.iterate !== undefined) ||
        (n.kind === "literal-source" && (n.label ?? "").startsWith("/")),
    )
  ) {
    const NUMERIC = new Set([
      "+",
      "-",
      "*",
      "/",
      "%",
      "<",
      ">",
      "<=",
      ">=",
      "&",
      "|",
      "^",
      "<<",
      ">>",
      ">>>",
      "~",
    ]);
    const numericUse = new Set<ValueId>();
    for (const n of g.nodes) {
      if (n.kind !== "op") continue;
      const leaf = leafOf(n);
      const callee = n.label === "CallExpression" ? memberOf(n.inputs[0] as ValueId) : undefined;
      if (NUMERIC.has(n.label ?? "") || (leaf !== undefined && MEM_INLINE[leaf] !== undefined))
        for (const v of n.inputs) numericUse.add(resolve(v as ValueId));
      else if (callee !== undefined && isMath(callee.node.inputs[0] as ValueId))
        for (const v of n.inputs.slice(1)) numericUse.add(resolve(v as ValueId));
    }
    const speculated = params.filter(
      (p, i) =>
        i >= closure.captures &&
        !(p.label ?? "").endsWith("...") &&
        numericUse.has(p.outputs[0] as ValueId),
    );
    if (speculated.length > 0) {
      const clone = m.closureName(`${name.replace(/"/g, "")}.num`);
      lowerFunction(
        m,
        source,
        clone,
        closure,
        scope,
        new Set(speculated.map((p) => p.outputs[0] as ValueId)),
      );
      let ok = "true";
      for (const p of speculated) {
        const c = fresh();
        emit(`${c} = icmp ult i64 ${operand(p.outputs[0] as ValueId)}, ${NUMBER_LIMIT}`);
        const both = fresh();
        emit(`${both} = and i1 ${ok}, ${c}`);
        ok = both;
      }
      const spec = freshLabel("numbers");
      const general = freshLabel("general");
      emit(`br i1 ${ok}, label %${spec}, label %${general}`);
      block(spec);
      const r = fresh();
      emit(`${r} = musttail call i64 @${clone}(ptr %closure, i64 %this, i64 %argc, ptr %argv)`);
      emit(`ret i64 ${r}`);
      block(general);
    }
  }
  // Pointer parameters read or written at constant offsets (#1369): the span they reach is looked
  // up once, here; each access then checks only that its region still lives.
  if (closure !== undefined) {
    const spans = new Map<ValueId, { len: number; write: boolean; uses: number }>();
    for (const n of g.nodes) {
      const leaf = leafOf(n);
      const mem = leaf === undefined ? undefined : MEM_INLINE[leaf];
      if (mem === undefined || n.inputs.length < 2) continue;
      const addr = resolve(n.inputs[1] as ValueId);
      const pa = producer.get(addr);
      let base: ValueId | undefined;
      let off: number | undefined;
      if (pa?.kind === "param-source") {
        base = addr;
        off = 0;
      } else if (pa?.kind === "op" && pa.label === "+" && pa.inputs.length === 2)
        for (const [x, y] of [
          [pa.inputs[0], pa.inputs[1]],
          [pa.inputs[1], pa.inputs[0]],
        ] as [ValueId, ValueId][]) {
          const k = constantInt(y);
          if (producer.get(resolve(x))?.kind === "param-source" && k !== undefined) {
            base = resolve(x);
            off = k;
          }
        }
      if (base === undefined || off === undefined || off < 0 || off + mem.size > 4096) continue;
      const sp = spans.get(base) ?? { len: 0, write: false, uses: 0 };
      spans.set(base, {
        len: Math.max(sp.len, off + mem.size),
        write: sp.write || mem.store,
        uses: sp.uses + 1,
      });
    }
    for (const [pv, sp] of spans) {
      const index = params.findIndex((p) => p.outputs[0] === pv);
      if (index < closure.captures || sp.uses < 2) continue;
      m.intrinsics.add("declare ptr @yk_span(i64, i64, i32, ptr, ptr)");
      const k = frames.size;
      const bytesSlot = `%fb${k}`;
      const hdrSlot = `%fh${k}`;
      const baseSlot = `%fa${k}`;
      entryAllocas.push(
        `  ${bytesSlot} = alloca ptr`,
        `  ${hdrSlot} = alloca ptr`,
        `  ${baseSlot} = alloca i64`,
      );
      // The runtime's cached region first (a caller's frame, most often), inline; else yk_span.
      for (const d0 of MEM_CACHE_DECLS) m.intrinsics.add(d0);
      const pbits = operand(pv);
      const isNum = fresh();
      emit(`${isNum} = icmp ult i64 ${pbits}, ${NUMBER_LIMIT}`);
      const pd = fresh();
      emit(`${pd} = bitcast i64 ${pbits} to double`);
      const inRange = fresh();
      emit(`${inRange} = fcmp olt double ${pd}, 9.0e15`);
      const nonneg = fresh();
      emit(`${nonneg} = fcmp oge double ${pd}, 0.0`);
      const u = fresh();
      emit(`${u} = fptoui double ${pd} to i64`);
      const back = fresh();
      emit(`${back} = uitofp i64 ${u} to double`);
      const integral = fresh();
      emit(`${integral} = fcmp oeq double ${back}, ${pd}`);
      const cBase = fresh();
      emit(`${cBase} = load i64, ptr @yk_mcache_base`);
      const cLen = fresh();
      emit(`${cLen} = load i64, ptr @yk_mcache_len`);
      const off = fresh();
      emit(`${off} = sub i64 ${u}, ${cBase}`);
      const end = fresh();
      emit(`${end} = add i64 ${off}, ${sp.len}`);
      const fits = fresh();
      emit(`${fits} = icmp ule i64 ${end}, ${cLen}`);
      const after = fresh();
      emit(`${after} = icmp ule i64 ${cBase}, ${u}`);
      const small = fresh();
      emit(`${small} = icmp ule i64 ${cLen}, 4096`);
      let ok = "true";
      for (const c of [isNum, inRange, nonneg, integral, fits, after, small]) {
        const both = fresh();
        emit(`${both} = and i1 ${ok}, ${c}`);
        ok = both;
      }
      if (sp.write) {
        const w = fresh();
        emit(`${w} = load i64, ptr @yk_mcache_writable`);
        const wr = fresh();
        emit(`${wr} = icmp ne i64 ${w}, 0`);
        const both = fresh();
        emit(`${both} = and i1 ${ok}, ${wr}`);
        ok = both;
      }
      const hit = freshLabel("spanhit");
      const miss = freshLabel("spanmiss");
      const joined = freshLabel("spanjoin");
      emit(`br i1 ${ok}, label %${hit}, label %${miss}`);
      block(hit);
      const cBytes = fresh();
      emit(`${cBytes} = load ptr, ptr @yk_mcache_bytes`);
      const atHit = fresh();
      emit(`${atHit} = getelementptr i8, ptr ${cBytes}, i64 ${off}`);
      const hdrHit = fresh();
      emit(`${hdrHit} = getelementptr i8, ptr ${cBytes}, i64 -16`);
      emit(`store ptr ${hdrHit}, ptr ${hdrSlot}`);
      emit(`store i64 ${cBase}, ptr ${baseSlot}`);
      emit(`br label %${joined}`);
      block(miss);
      const atMiss = fresh();
      emit(
        `${atMiss} = call ptr @yk_span(i64 ${pbits}, i64 ${sp.len}, i32 ${sp.write ? 1 : 0}, ptr ${hdrSlot}, ptr ${baseSlot})`,
      );
      const missEnd = currentLabel();
      emit(`br label %${joined}`);
      block(joined);
      const at = fresh();
      emit(`${at} = phi ptr [ ${atHit}, %${hit} ], [ ${atMiss}, %${missEnd} ]`);
      emit(`store ptr ${at}, ptr ${bytesSlot}`);
      frames.set(pv, { bytes: bytesSlot, hdr: hdrSlot, base: baseSlot, len: sp.len });
    }
  }
  emitScope(undefined);
  if (scope?.outs !== undefined) {
    // A statement: the values of the names it declares, from its one result.
    scope.outs.forEach((global, k) =>
      emit(
        `store i64 ${operand((declaredValues as readonly ValueId[])[k] as ValueId)}, ptr ${global}`,
      ),
    );
    emit(`ret i64 ${UNDEFINED}`);
  } else if (g.obs.length === 0) emit(`ret i64 ${UNDEFINED}`);
  else emit(`ret i64 ${operand(g.obs[0] as ValueId)}`);

  const head =
    closure === undefined
      ? `define i64 @${name}(${params.map((_, i) => `i64 %p${i}`).join(", ")}) {`
      : `define internal i64 @${name}(ptr %closure, i64 %this, i64 %argc, ptr %argv) {`;
  m.functions.push(
    [
      head,
      "entry:",
      ...[...slots.values()].map((s) => `  ${s} = alloca i64`),
      ...[...bigSlots.values()].map((s) => `  ${s} = alloca i128`),
      ...entryAllocas,
      ...body,
      "}",
      "",
    ].join("\n"),
  );
}

/**
 * b ** e for two literals, when both are integers (e >= 0) and the power is an integer below 2^53:
 * exact, so no implementation's approximation is involved. Otherwise undefined.
 */
function exactPower(b: DucNode | undefined, e: DucNode | undefined): number | undefined {
  const lit = (n: DucNode | undefined): number | undefined =>
    n?.kind === "literal-source" && /^\d+$/.test(n.label ?? "") ? Number(n.label) : undefined;
  const x = lit(b);
  const y = lit(e);
  if (x === undefined || y === undefined || !Number.isSafeInteger(x) || y > 64) return undefined;
  const p = BigInt(x) ** BigInt(y);
  return p <= 2n ** 53n ? Number(p) : undefined;
}

/** The graph lowered to an LLVM module of boxed values, calling the runtime. */
export function emitLlvmBoxed(input: DucGraph, symbol = "f"): LlvmModule {
  // ECMAScript's operations: each generic operation as the case of them it is (#1310).
  const source = ecmaScriptView(input);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(symbol))
    throw new LlvmEmitError(`"${symbol}" is not a symbol a linker takes`);
  const m = new ModuleBuilder();
  const params = source.nodes.filter((n) => n.kind === "param-source").length;
  if (source.mode === "async" || source.mode === "generator") {
    // The body is a closure the runtime runs as a coroutine; the entry calls it, giving its promise
    // or its generator (#1295).
    const body = m.closureName(symbol);
    lowerFunction(m, source, body, { captures: 0 });
    for (const f of ["yk_closure_new", "yk_closure_mode", "yk_call"]) m.used.add(f);
    const args = Array.from({ length: params }, (_, i) => `%a${i}`);
    m.functions.push(
      [
        `define i64 @${symbol}(${args.map((a) => `i64 ${a}`).join(", ")}) {`,
        `  %argv = alloca [${Math.max(params, 1)} x i64]`,
        ...args.flatMap((a, i) => [
          `  %p${i} = getelementptr [${Math.max(params, 1)} x i64], ptr %argv, i64 0, i64 ${i}`,
          `  store i64 ${a}, ptr %p${i}`,
        ]),
        `  %c = call i64 @yk_closure_new(ptr @${body}, i32 0, i64 0, ptr null)`,
        `  %m = call i64 @yk_closure_mode(i64 %c, i32 ${source.mode === "async" ? 1 : 2})`,
        `  %r = call i64 @yk_call(i64 %m, i64 ${UNDEFINED}, i64 ${params}, ptr %argv)`,
        "  ret i64 %r",
        "}",
        "",
      ].join("\n"),
    );
  } else lowerFunction(m, source, symbol, undefined);
  const ir = [
    "; yakcc native lowering, boxed values (#1292)",
    `source_filename = "${symbol}"`,
    "",
    ...m.globals,
    "",
    ...m.functions,
    ...[...m.used].sort().map((f) => RUNTIME_DECLS[f] as string),
    ...m.intrinsics,
    "",
  ].join("\n");
  return { ir, symbol, params: Array(params).fill("i64"), result: "i64" };
}

/** One statement of a module (#1290): a function declaration, or a statement, and the names it declares. */
export interface NativeModuleStatement {
  readonly kind: "function" | "statement";
  readonly declares: readonly string[];
  readonly graph: DucGraph;
}

/** A module of a package: its statements in order, and each relative `require` to the module it names. */
export interface NativeModule {
  readonly id: string;
  readonly statements: readonly NativeModuleStatement[];
  readonly requires?: Readonly<Record<string, string>>;
  /** An ECMAScript module's linking (#1333): its imports, exports and dependencies. */
  readonly esm?: NativeEsm;
}

/** Where a name an ECMAScript module imports or re-exports comes from: a module, and its export. */
export interface NativeImport {
  readonly module: string;
  /** An export name; `*` is the module's namespace. */
  readonly name: string;
}

/**
 * An ECMAScript module's linking (ECMA-262 16.2): each imported local name's module and export; each
 * export, a local binding or a re-export; the modules `export *` takes names from; and the modules
 * evaluated before its body, in the order its import and export declarations name them.
 */
export interface NativeEsm {
  readonly imports: Readonly<Record<string, NativeImport>>;
  readonly exports: Readonly<Record<string, { readonly local: string } | NativeImport>>;
  readonly stars: readonly string[];
  readonly deps: readonly string[];
}

export interface NativeModules {
  readonly ir: string;
  /** For each module id, the exported function that initializes it and returns its exports. */
  readonly symbols: Readonly<Record<string, string>>;
}

/** A module id as a C symbol: `lib/parse.js` is `yk_module_lib_parse_js`. */
export function moduleSymbol(id: string): string {
  return `yk_module_${id.replace(/[^A-Za-z0-9]/g, "_")}`;
}

/**
 * A package's modules lowered to one LLVM module (#1292, #1290), as the receiver runs them: each
 * module's bindings are globals; its initializer makes `module` and `exports`, defines its function
 * declarations, runs its statements in order, and stores each statement's results in the bindings it
 * declares. `require` resolves a relative specifier to the module the record names and initializes
 * it once; a cycle sees the exports as they are so far, as in CommonJS. A specifier the record does
 * not name fails when it is required.
 */
export function emitNativeModules(modules: readonly NativeModule[]): NativeModules {
  const m = new ModuleBuilder();
  const index = new Map(modules.map((mod, i) => [mod.id, i] as const));
  const globals: string[] = [];
  const symbols: Record<string, string> = {};
  const g = (i: number, what: string): string => `@"m${i}.${what}"`;
  // An export of an ECMAScript module, to the binding that holds it (a live binding: read where it
  // is used), or to a module's namespace; through re-exports and `export *`.
  const resolveExport = (
    i: number,
    name: string,
    seen: Set<string> = new Set(),
  ): { slot: string } | { ns: number } | undefined => {
    const mod = modules[i] as NativeModule;
    const key = `${i}:${name}`;
    if (seen.has(key)) return undefined;
    seen.add(key);
    if (name === "*") return { ns: i };
    const esm = mod.esm;
    if (esm === undefined) return undefined;
    const ex = esm.exports[name];
    if (ex !== undefined && "local" in ex) {
      const imported = esm.imports[ex.local];
      if (imported !== undefined) return resolveImport(imported, seen);
      return { slot: g(i, `b.${ex.local}`) };
    }
    if (ex !== undefined) return resolveImport(ex, seen);
    if (name === "default") return undefined;
    for (const star of esm.stars) {
      const t = index.get(star);
      const hit = t === undefined ? undefined : resolveExport(t, name, seen);
      if (hit !== undefined) return hit;
    }
    return undefined;
  };
  const resolveImport = (
    imp: NativeImport,
    seen: Set<string> = new Set(),
  ): { slot: string } | { ns: number } | undefined => {
    const t = index.get(imp.module);
    if (t === undefined) throw new LlvmEmitError(`the module ${imp.module} is not in the program`);
    return resolveExport(t, imp.name, seen);
  };
  /** Every name a module exports, `export *`'s included (not their default). */
  const exportNames = (i: number, seen: Set<number> = new Set()): string[] => {
    if (seen.has(i)) return [];
    seen.add(i);
    const esm = (modules[i] as NativeModule).esm;
    if (esm === undefined) return [];
    const out = new Set(Object.keys(esm.exports));
    for (const star of esm.stars) {
      const t = index.get(star);
      if (t !== undefined) for (const n of exportNames(t, seen)) if (n !== "default") out.add(n);
    }
    return [...out];
  };
  // Function declarations nothing reassigns (#1369): a binding a `binding=` writes anywhere in its
  // module (a nested closure's included) is not one.
  const writtenIn = (graph: DucGraph, out: Set<string>): void => {
    const prod = new Map<ValueId, DucNode>();
    for (const n of graph.nodes) for (const v of n.outputs) prod.set(v, n);
    for (const n of graph.nodes) {
      if (n.label === "binding=") {
        const target = prod.get(n.inputs[0] as ValueId);
        if (target?.kind === "diamond-source" && target.diamond?.symbol !== undefined)
          out.add(target.diamond.symbol);
      }
      if (n.closure !== undefined) writtenIn(n.closure, out);
    }
  };
  const directBySlot = new Map<string, string>();
  modules.forEach((mod, i) => {
    const written = new Set<string>();
    for (const st of mod.statements) writtenIn(st.graph, written);
    mod.statements.forEach((st, k) => {
      const name = st.declares[0];
      if (
        st.kind !== "function" ||
        name === undefined ||
        written.has(name) ||
        st.graph.mode !== undefined
      )
        return;
      directBySlot.set(g(i, `b.${name}`), `m${i}_s${k}`);
    });
  });
  modules.forEach((mod, i) => {
    const names = new Set(mod.statements.flatMap((st) => st.declares));
    for (const what of ["module", "exports", "require"])
      globals.push(`${g(i, what)} = internal global i64 ${UNDEFINED}`);
    for (const name of names)
      globals.push(`${g(i, `b.${name}`)} = internal global i64 ${UNDEFINED}`);
    globals.push(`${g(i, "state")} = internal global i32 0`);
    const scope = (outs?: readonly string[]): ModuleScope => ({
      read: (name, emit, fresh) => {
        const slot =
          name === "module" || name === "exports" || name === "require"
            ? g(i, name)
            : name === "this"
              ? g(i, "exports")
              : names.has(name)
                ? g(i, `b.${name}`)
                : undefined;
        if (slot === undefined) {
          const imp = mod.esm?.imports[name];
          if (imp === undefined) return undefined;
          const target = resolveImport(imp);
          if (target === undefined)
            throw new LlvmEmitError(
              `${imp.module} has no export ${imp.name} (imported by ${mod.id})`,
            );
          const r = fresh();
          // A live binding: the exporting module's own variable, read where it is used.
          if ("slot" in target) emit(`${r} = load i64, ptr ${target.slot}`);
          else emit(`${r} = call i64 ${g(target.ns, "init")}()`);
          return r;
        }
        const r = fresh();
        emit(`${r} = load i64, ptr ${slot}`);
        return r;
      },
      write: (name, value, emit) => {
        // `exports` is the module's own variable: `exports = module.exports = …` rebinds it.
        if (name === "exports") {
          emit(`store i64 ${value}, ptr ${g(i, "exports")}`);
          return true;
        }
        if (!names.has(name)) return false;
        emit(`store i64 ${value}, ptr ${g(i, `b.${name}`)}`);
        return true;
      },
      direct: (name) => {
        if (names.has(name)) return directBySlot.get(g(i, `b.${name}`));
        const imp = mod.esm?.imports[name];
        if (imp === undefined) return undefined;
        const target = resolveImport(imp);
        return target !== undefined && "slot" in target ? directBySlot.get(target.slot) : undefined;
      },
      ...(outs !== undefined ? { outs } : {}),
    });
    // Each statement: a function of its own. A function declaration is a closure the binding holds.
    const init: string[] = [];
    mod.statements.forEach((st, k) => {
      const fn = `m${i}_s${k}`;
      if (st.kind === "function") {
        const name = st.declares[0];
        if (name === undefined) throw new LlvmEmitError("a function statement with no name");
        lowerFunction(m, ecmaScriptView(st.graph), fn, { captures: 0 }, scope());
        m.used.add("yk_closure_new");
        init.push(`  %f${k} = call i64 @yk_closure_new(ptr @${fn}, i32 1, i64 0, ptr null)`);
        init.push(`  store i64 %f${k}, ptr ${g(i, `b.${name}`)}`);
      }
    });
    mod.statements.forEach((st, k) => {
      if (st.kind !== "statement") return;
      const fn = `m${i}_s${k}`;
      lowerFunction(
        m,
        ecmaScriptView(st.graph),
        fn,
        undefined,
        scope(st.declares.map((d) => g(i, `b.${d}`))),
      );
      init.push(`  call i64 @${fn}()`);
    });
    // require: each specifier the record names, to its module's initializer.
    const req = [
      `define internal i64 ${g(i, "require.fn")}(ptr %closure, i64 %this, i64 %argc, ptr %argv) {`,
      "entry:",
    ];
    m.used.add("yk_arg");
    m.used.add("yk_string_is");
    m.used.add("yk_fail");
    req.push("  %spec = call i64 @yk_arg(i64 %argc, ptr %argv, i64 0)");
    Object.entries(mod.requires ?? {}).forEach(([spec, target], r) => {
      const t = index.get(target);
      if (t === undefined)
        throw new LlvmEmitError(`require("${spec}") names ${target}, which is not in the package`);
      const key = m.constant(spec);
      req.push(`  %is${r} = call i32 @yk_string_is(i64 %spec, ptr ${key.ptr}, i64 ${key.length})`);
      req.push(`  %c${r} = icmp ne i32 %is${r}, 0`);
      req.push(`  br i1 %c${r}, label %hit${r}, label %next${r}`);
      req.push(`hit${r}:`);
      req.push(`  %v${r} = call i64 ${g(t, "init")}()`);
      req.push(`  ret i64 %v${r}`);
      req.push(`next${r}:`);
    });
    const missing = m.constant(`Error: Cannot find module (required from ${mod.id})`, true);
    req.push(`  call void @yk_fail(ptr ${missing.ptr})`, "  unreachable", "}", "");
    m.functions.push(req.join("\n"));
    // An ECMAScript module's exports object is its namespace: each export's value, once its body
    // has run.
    const namespace: string[] = [];
    if (mod.esm !== undefined) {
      m.used.add("yk_set_named");
      exportNames(i).forEach((name, k) => {
        const target = resolveExport(i, name);
        if (target === undefined) return;
        const key = m.constant(name);
        if ("slot" in target) namespace.push(`  %nv${k} = load i64, ptr ${target.slot}`);
        else namespace.push(`  %nv${k} = call i64 ${g(target.ns, "init")}()`);
        namespace.push(
          `  call i64 @yk_set_named(i64 %ex, ptr ${key.ptr}, i64 ${key.length}, i64 %nv${k})`,
        );
      });
    }
    // The initializer: once; a second call (a cycle, or another require) gets the exports so far.
    const exportsKey = m.constant("exports");
    m.used.add("yk_object_of");
    m.used.add("yk_get_named");
    m.functions.push(
      [
        `define i64 ${g(i, "init")}() {`,
        "entry:",
        "  %keys = alloca [1 x i64]",
        "  %vals = alloca [1 x i64]",
        `  %st = load i32, ptr ${g(i, "state")}`,
        "  %again = icmp ne i32 %st, 0",
        "  br i1 %again, label %done, label %first",
        "first:",
        `  store i32 1, ptr ${g(i, "state")}`,
        "  %ex = call i64 @yk_object_of(i64 0, ptr null, ptr null)",
        `  store i64 %ex, ptr ${g(i, "exports")}`,
        `  %ek = call i64 @yk_string_utf8(ptr ${exportsKey.ptr}, i64 ${exportsKey.length})`,
        "  store i64 %ek, ptr %keys",
        "  store i64 %ex, ptr %vals",
        "  %mod = call i64 @yk_object_of(i64 1, ptr %keys, ptr %vals)",
        `  store i64 %mod, ptr ${g(i, "module")}`,
        `  %req = call i64 @yk_closure_new(ptr ${g(i, "require.fn")}, i32 0, i64 0, ptr null)`,
        `  store i64 %req, ptr ${g(i, "require")}`,
        // An ECMAScript module's dependencies are evaluated first, in order (a cycle sees a module
        // still being evaluated, as ECMA-262's does).
        ...(mod.esm?.deps ?? []).map((d, k) => {
          const t = index.get(d);
          if (t === undefined) throw new LlvmEmitError(`the module ${d} is not in the program`);
          return `  %dep${k} = call i64 ${g(t, "init")}()`;
        }),
        ...init,
        ...namespace,
        "  br label %done",
        "done:",
        `  %m = load i64, ptr ${g(i, "module")}`,
        `  %out = call i64 @yk_get_named(i64 %m, ptr ${exportsKey.ptr}, i64 ${exportsKey.length})`,
        "  ret i64 %out",
        "}",
        "",
      ].join("\n"),
    );
    m.used.add("yk_string_utf8");
    m.used.add("yk_closure_new");
    const symbol = moduleSymbol(mod.id);
    symbols[mod.id] = symbol;
    m.functions.push(
      `define i64 @${symbol}() {\nentry:\n  %r = call i64 ${g(i, "init")}()\n  ret i64 %r\n}\n`,
    );
  });
  const ir = [
    "; yakcc native lowering, a package's modules (#1292, #1290)",
    'source_filename = "modules"',
    "",
    ...m.globals,
    ...globals,
    "",
    ...m.functions,
    ...[...m.used].sort().map((f) => RUNTIME_DECLS[f] as string),
    ...m.intrinsics,
    "",
  ].join("\n");
  return { ir, symbols };
}
