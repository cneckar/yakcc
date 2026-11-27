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
import { COMPLETES, DECLARES } from "./lift.js";
import { bodyPathOf, joinOwners, sidePath } from "./line-form.js";
import { atomGraph, atomNames, mathOperation, operationReference } from "./operations.js";
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

/**
 * A table keyed by names a program may use (an operator, a leaf, a binding): no prototype, so a
 * name like `toString` or `hasOwnProperty` is in it only if the table has it (#1370).
 */
function nameTable<T>(entries: Record<string, T>): Record<string, T> {
  return Object.freeze(Object.assign(Object.create(null) as Record<string, T>, entries));
}

const BINARY: Readonly<Record<string, string>> = nameTable({
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
});
/**
 * The operators a number's own operation computes when both operands are numbers (#1369): the
 * double operation inline, behind a check of the operands' tags, and the runtime's otherwise. A
 * boxed number is its double's bits, so no conversion is needed; a NaN result is made canonical, as
 * the runtime's numbers are.
 */
const FAST_ARITH: Readonly<Record<string, string>> = nameTable({
  "+": "fadd",
  "-": "fsub",
  "*": "fmul",
  "/": "fdiv",
  "%": "frem",
});
const FAST_COMPARE: Readonly<Record<string, string>> = nameTable({
  "<": "olt",
  ">": "ogt",
  "<=": "ole",
  ">=": "oge",
  "===": "oeq",
  "!==": "une",
  "==": "oeq",
  "!=": "une",
});
/** The bitwise operators on ToInt32 (ToUint32 for >>>), inline for a number below 2^63. */
const FAST_BITWISE: Readonly<Record<string, string>> = nameTable({
  "|": "or",
  "&": "and",
  "^": "xor",
  "<<": "shl",
  ">>": "ashr",
  ">>>": "lshr",
});
/** Every boxed value at or above this (unsigned) is tagged: below it, a double. */
const NUMBER_LIMIT = "-1970324836974592"; // 0xFFF9000000000000
const CANONICAL_NAN = "9221120237041090560"; // 0x7FF8000000000000
const UNARY: Readonly<Record<string, string>> = nameTable({
  "-": "yk_neg",
  "+": "yk_pos",
  "!": "yk_not",
  TypeOfExpression: "yk_typeof",
  "~": "yk_bitnot",
});
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
  "__yakccTryAsyncGen",
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
  "Symbol",
  "globalThis",
  "Reflect",
  "Proxy",
  "Function",
  "encodeURIComponent",
  "encodeURI",
  "decodeURIComponent",
  "decodeURI",
  "escape",
  "unescape",
  // The runtime's own internalBinding layer (#1331): Node's bindings V8's role gives.
  "__yakccRuntimeBinding",
  "__yakccDefineGlobal",
  "__yakccSetBuiltinRequire",
  "__yakccSetTickHook",
  "__yakccOnExit",
  "__yakccRunMicrotasks",
  "__yakccSetPromiseRejectHook",
  "eval",
  "EvalError",
  "ReferenceError",
  "URIError",
  "AggregateError",
  "WeakMap",
  "WeakSet",
  "WeakRef",
  "FinalizationRegistry",
  "Date",
  "RegExp",
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
const LEAVES: Readonly<Record<string, [string, number]>> = nameTable({
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
  // The system-call leaf and the thread pointer (#1365, layer 0): createCSystem's meaning.
  __yk_syscall: ["yk_leaf_syscall", 7],
  __yk_tp: ["yk_leaf_tp", 0],
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
});
/**
 * The memory leaves with an inline fast path (#1369): an access to the region the runtime's cache
 * holds (`yk_mcache_*`) is a native load or store; anything else is the runtime's leaf, which finds
 * the region or traps and fills the cache. Each: its size, its LLVM type, how its value converts.
 */
const MEM_INLINE: Readonly<
  Record<string, { size: number; ty: string; kind: "u" | "f64" | "f32"; store: boolean }>
> = nameTable({
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
});
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
/** Math's value properties (ECMA-262 21.3.1). */
const MATH_CONSTANTS: Readonly<Record<string, number>> = nameTable({
  E: Math.E,
  LN10: Math.LN10,
  LN2: Math.LN2,
  LOG10E: Math.LOG10E,
  LOG2E: Math.LOG2E,
  PI: Math.PI,
  SQRT1_2: Math.SQRT1_2,
  SQRT2: Math.SQRT2,
});
const MATH1 = new Set(["floor", "ceil", "trunc", "sqrt", "abs", "sign", "round"]);
const APPROXIMATED =
  /^(exp|expm1|log|log1p|log2|log10|sin|cos|tan|asin|acos|atan|atan2|sinh|cosh|tanh|asinh|acosh|atanh|cbrt|hypot|pow)$/;

const RUNTIME_DECLS: Readonly<Record<string, string>> = nameTable({
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
  yk_object_set_proto: "declare i64 @yk_object_set_proto(i64, i64)",
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
  yk_array_hole: "declare i64 @yk_array_hole(i64, i64)",
  yk_name_method: "declare i64 @yk_name_method(i64, i64)",
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
});

/** UTF-8 bytes as an LLVM string constant body. */
/**
 * A string's bytes as WTF-8: UTF-8, but a lone surrogate (which a JavaScript string may hold, and
 * UTF-8 cannot) is its own three bytes, which the runtime's decoder reads back as that code unit.
 */
function wtf8(text: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < text.length; i++) {
    let c = text.charCodeAt(i);
    const d = text.charCodeAt(i + 1);
    if (c >= 0xd800 && c <= 0xdbff && d >= 0xdc00 && d <= 0xdfff) {
      c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00);
      i++;
    }
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else
      out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return Uint8Array.from(out);
}

function llvmBytes(text: string): { body: string; length: number } {
  const bytes = wtf8(text);
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
    // A method with a computed key (`[Symbol.asyncIterator]() {}`): its key, then its function.
    if (kind === "method" && k === 1) return { kind: "computed" };
    // An accessor: named, or computed (its key the input before its function).
    if (kind === "get" || kind === "set")
      return typeof k === "string" ? { kind, name: k } : { kind };
    return { kind: "unsupported", what: `a ${kind} member` };
  });
}

/**
 * An atom of the library (`Math.sin` is V8's `sin`, #1362), lowered into the module once as a
 * function of the closure convention; the atoms it calls by name are lowered too, and called
 * directly. Its name.
 */
function atomFunction(m: ModuleBuilder, atom: string): string {
  const known = m.atoms.get(atom);
  if (known !== undefined) return known;
  const fn = `yk.atom.${atom}`;
  m.atoms.set(atom, fn);
  const library = new Set(atomNames());
  const scope: ModuleScope = {
    read: (name, emitLine, freshName) => {
      if (!library.has(name)) return undefined;
      // Its closure, made once (a call to it is direct; the closure is the binding's value).
      const slot = `@yk.atomc.${name}`;
      if (!m.atoms.has(`slot:${name}`)) {
        m.atoms.set(`slot:${name}`, slot);
        m.globals.push(`${slot} = internal global i64 0`);
      }
      m.intrinsics.add("declare i64 @yk_closure_once(ptr, ptr)");
      const r = freshName();
      emitLine(`${r} = call i64 @yk_closure_once(ptr ${slot}, ptr @${atomFunction(m, name)})`);
      return r;
    },
    write: () => false,
    direct: (name) => (library.has(name) ? atomFunction(m, name) : undefined),
  };
  lowerFunction(m, ecmaScriptView(atomGraph(atom)), fn, { captures: 0 }, scope);
  return fn;
}

/**
 * `Math.<name>` read as a value (`const floor = Math.floor`): a function of the closure convention
 * that does what a call of it does (the exact operations the runtime's, the others their atoms,
 * #1362), its closure made once. The value, emitted with `emit`.
 */
function mathFunctionValue(
  m: ModuleBuilder,
  name: string,
  fresh: () => string,
  emit: (line: string) => void,
): string {
  // Its value properties (21.3.1): the numbers.
  const constant = MATH_CONSTANTS[name];
  if (constant !== undefined) {
    const r = fresh();
    emit(`${r} = add i64 0, ${boxedNumber(constant)}`);
    return r;
  }
  const fn = `yk.mathval.${name}`;
  if (!m.atoms.has(`mathval:${name}`)) {
    m.atoms.set(`mathval:${name}`, fn);
    const body: string[] = [];
    let length = 1;
    m.used.add("yk_arg");
    const arg = (i: number): string => {
      body.push(`  %a${i} = call i64 @yk_arg(i64 %argc, ptr %argv, i64 ${i})`);
      return `%a${i}`;
    };
    const ref = mathOperation(name, 1) ?? mathOperation(name, 2);
    if (MATH1.has(name)) {
      const key = m.constant(name, true);
      m.used.add("yk_math1");
      body.push(`  %r = call i64 @yk_math1(ptr ${key.ptr}, i64 ${arg(0)})`);
    } else if (name === "min" || name === "max") {
      length = 2;
      m.used.add("yk_math_minmax");
      body.push(
        `  %r = call i64 @yk_math_minmax(i32 ${name === "max" ? 1 : 0}, i64 %argc, ptr %argv)`,
      );
    } else if (name === "random") {
      length = 0;
      m.intrinsics.add("declare i64 @yk_math_random()");
      body.push("  %r = call i64 @yk_math_random()");
    } else if (ref !== undefined) {
      length = ref.arity;
      m.used.add("yk_pos");
      body.push(`  %list = alloca [${ref.arity} x i64]`);
      for (let i = 0; i < ref.arity; i++) {
        body.push(`  %n${i} = call i64 @yk_pos(i64 ${arg(i)})`);
        body.push(`  %p${i} = getelementptr [${ref.arity} x i64], ptr %list, i64 0, i64 ${i}`);
        body.push(`  store i64 %n${i}, ptr %p${i}`);
      }
      body.push(
        `  %r = call i64 @${atomFunction(m, ref.atom)}(ptr null, i64 ${UNDEFINED}, i64 ${ref.arity}, ptr %list)`,
      );
    } else throw new LlvmEmitError(`Math.${name} as a value is not in the subset yet`);
    m.functions.push(
      [
        `define internal i64 @${fn}(ptr %closure, i64 %this, i64 %argc, ptr %argv) {`,
        "entry:",
        ...body,
        "  ret i64 %r",
        "}",
        "",
      ].join("\n"),
    );
    m.globals.push(`@${fn}.c = internal global i64 0`);
    m.atoms.set(`mathval:${name}:len`, String(length));
  }
  const key = m.constant(name);
  m.intrinsics.add("declare i64 @yk_builtin_once(ptr, ptr, ptr, i64, i32)");
  const r = fresh();
  emit(
    `${r} = call i64 @yk_builtin_once(ptr @${fn}.c, ptr @${fn}, ptr ${key.ptr}, i64 ${key.length}, i32 ${m.atoms.get(`mathval:${name}:len`)})`,
  );
  return r;
}

/**
 * The module's constructor (run before main, from .init_array): each name and literal the module
 * keeps in a global made then, so the lowered code reads the global with no check (#1370).
 */
function keyConstructor(m: ModuleBuilder): string[] {
  if (m.keyInits.length === 0) return [];
  return [
    "define internal void @yk.keys.init() {",
    ...m.keyInits,
    "  ret void",
    "}",
    "@llvm.global_ctors = appending global [1 x { i32, ptr, ptr }] [{ i32, ptr, ptr } { i32 65535, ptr @yk.keys.init, ptr null }]",
    "",
  ];
}

/** The module being built: its constants, the runtime functions it calls, its functions. */
class ModuleBuilder {
  readonly globals: string[] = [];
  /** Named member reads' caches made so far (yk.ic.N). */
  icSites = 0;
  readonly used = new Set<string>();
  /** The LLVM intrinsics the functions call, declared once. */
  readonly intrinsics = new Set<string>();
  readonly functions: string[] = [];
  /** Each regex literal's matcher, lowered once: its function's name. */
  readonly matchers = new Map<string, string>();
  /** Each atom an operation references (#1362), lowered once: its function's name. */
  readonly atoms = new Map<string, string>();
  /** The number clones lowered (#1369): a function's `<name>.num`. */
  readonly numClones = new Set<string>();
  /** Each property name a site reads, writes or calls by: the global its string is kept in. */
  readonly keys = new Map<string, string>();
  /** Each key global's filling, by the module's constructor (keyConstructor). */
  readonly keyInits: string[] = [];
  /** The number clones calls name, each its function's and its raw arguments' parameter list. */
  readonly numCalled = new Map<
    string,
    { of: string; rawBlocks: number; regs: number; rec?: boolean }
  >();
  /** Each `.num` clone with an `.int` clone: the ranges the `.int` clone takes its parameters (by
   * position) in (#1369). */
  readonly intClones = new Map<string, ReadonlyMap<number, NumRange>>();
  /** Calls of a `.num` clone with arguments of known ranges: each thunk's clone, its arguments'
   * ranges by position, and its signature's raw blocks, record slot and registers. */
  readonly intCalled = new Map<
    string,
    {
      of: string;
      ranges: readonly (NumRange | "both" | undefined)[];
      rawBlocks: number;
      regs: number;
      rec: boolean;
      /** The call passes boxed arguments only (not all proven numbers): the thunk checks them and
       * passes the `.int` clone its registers, else calls this, the function's own entry. */
      boxed?: string;
    }
  >();
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
  /** Whether the module binds a name (it shadows a platform global of that name). */
  readonly binds?: (name: string) => boolean;
  /** For a direct callee: the arguments its `.raw` variant takes as a block's bytes and length. */
  readonly rawArgs?: (name: string) => ReadonlySet<number> | undefined;
  /** For a direct callee: how many parameters it has. */
  readonly arity?: (name: string) => number | undefined;
  /** For a direct callee with a `.rec` variant: its record result's keys (#1369). */
  readonly record?: (name: string) => readonly string[] | undefined;
  /** For a direct callee: its result's integer range, and its record result's keys' (#1369). */
  readonly ranges?: (
    name: string,
  ) => { ret?: IntRange; keys?: ReadonlyMap<string, IntRange> } | undefined;
  /** For a statement: the globals its results (its graph's observations) are stored in, in order. */
  readonly outs?: readonly string[];
}

/**
 * Raw block arguments (#1369, typed calls between atoms): for each argument of a function, whether
 * a caller's block may be passed as its bytes and length rather than as an address. It may when the
 * function only reads and writes the argument's memory at constant offsets (each checked against the
 * length when it runs), or passes the argument on whole to a function that takes it so; `deps` are
 * those (the callee's free name, the argument's position), which the module's fixpoint resolves.
 * Such a block needs no region, and the callee no span lookup.
 */
function rawArgUses(source: DucGraph): Map<number, { deps: [string, number][] }> {
  const out = new Map<number, { deps: [string, number][] }>();
  if (source.mode !== undefined) return out;
  const { graph: g } = loweringView(ecmaScriptView(source));
  const alias = new Map<ValueId, ValueId>();
  for (const n of g.nodes) {
    const rec = n.loop;
    if (n.kind !== "loop" || rec === undefined) continue;
    const offset = rec.carry.length + (rec.iterate !== undefined ? 1 : 0);
    rec.invariant.forEach((v, j) => alias.set(v, n.inputs[offset + j] as ValueId));
  }
  const resolve = (v: ValueId): ValueId => {
    const a = alias.get(v);
    return a === undefined ? v : resolve(a);
  };
  const producer = new Map<ValueId, DucNode>();
  for (const n of g.nodes) for (const v of n.outputs) producer.set(v, n);
  const usersOf = new Map<ValueId, DucNode[]>();
  for (const n of g.nodes)
    for (const v of n.inputs) {
      const r = resolve(v as ValueId);
      usersOf.set(r, [...(usersOf.get(r) ?? []), n]);
    }
  // Values nothing may be: a result, a branch's or loop's condition, a loop's next carry.
  const held = new Set<ValueId>([
    ...g.obs.map((v) => resolve(v)),
    ...(g.branches ?? []).map((b) => resolve(b.cond as ValueId)),
  ]);
  for (const n of g.nodes) {
    if (n.loop === undefined) continue;
    for (const v of n.loop.next) held.add(resolve(v));
    if (n.loop.cond !== undefined) held.add(resolve(n.loop.cond));
  }
  const diamond = (v: ValueId): DucNode | undefined => {
    const p = producer.get(resolve(v));
    return p?.kind === "diamond-source" ? p : undefined;
  };
  const leafOf = (n: DucNode): string | undefined => {
    if (n.kind !== "op" || n.label !== "CallExpression") return undefined;
    const sym = diamond(n.inputs[0] as ValueId)?.diamond?.symbol;
    return sym !== undefined && LEAVES[sym] !== undefined ? sym : undefined;
  };
  const constantInt = (v: ValueId, depth = 0): number | undefined => {
    const p = producer.get(resolve(v));
    if (p?.kind === "literal-source") {
      const x = Number((p.label ?? "").replace(/_/g, ""));
      return /^[0-9]/.test(p.label ?? "") && Number.isSafeInteger(x) ? x : undefined;
    }
    if (depth > 8 || p?.kind !== "op" || p.inputs.length !== 2) return undefined;
    const a = constantInt(p.inputs[0] as ValueId, depth + 1);
    const b = constantInt(p.inputs[1] as ValueId, depth + 1);
    if (a === undefined || b === undefined) return undefined;
    const r =
      p.label === "+" ? a + b : p.label === "-" ? a - b : p.label === "*" ? a * b : undefined;
    return r !== undefined && Number.isSafeInteger(r) ? r : undefined;
  };
  const heapOnly = (u: DucNode, i: number): boolean =>
    (u.order === 1 && i === u.inputs.length - 1) ||
    (u.kind === "sel" && u.label === "heap") ||
    (u.label ?? "").endsWith(":heap");
  const usesOk = (v: ValueId, off: number, depth: number, deps: [string, number][]): boolean => {
    if (held.has(v)) return false;
    return (usersOf.get(v) ?? []).every((u) =>
      u.inputs.every((x, i) => {
        if (resolve(x as ValueId) !== v || heapOnly(u, i)) return true;
        const leaf = leafOf(u);
        const mem = leaf === undefined ? undefined : MEM_INLINE[leaf];
        if (i === 1 && (mem !== undefined || leaf === "__ykStore64")) {
          used++;
          return off >= 0 && !(mem?.store !== false && resolve(u.inputs[2] as ValueId) === v);
        }
        if (u.kind === "loop" && u.loop !== undefined)
          return i >= u.loop.carry.length + (u.loop.iterate !== undefined ? 1 : 0);
        if (u.kind === "op" && u.label === ",") return i < u.inputs.length - 1;
        if (depth === 0 && u.kind === "op" && u.label === "+" && u.inputs.length === 2) {
          const other = u.inputs[1 - i] as ValueId;
          const k = constantInt(other);
          if (k === undefined || k < 0 || resolve(other) === v) return false;
          return usesOk(u.outputs[0] as ValueId, off + k, depth + 1, deps);
        }
        if (
          depth === 0 &&
          i >= 1 &&
          u.kind === "op" &&
          u.label === "CallExpression" &&
          leaf === undefined &&
          diamond(u.inputs[0] as ValueId)?.diamond?.reason === "free-identifier"
        ) {
          deps.push([diamond(u.inputs[0] as ValueId)?.diamond?.symbol as string, i - 1]);
          used++;
          return true;
        }
        return false;
      }),
    );
  };
  let used = 0;
  for (const p of g.nodes) {
    if (p.kind !== "param-source" || (p.label ?? "").endsWith("...")) continue;
    const deps: [string, number][] = [];
    used = 0;
    if (usesOk(p.outputs[0] as ValueId, 0, 0, deps) && used > 0)
      out.set(paramIndex(p.label), { deps });
  }
  return out;
}

/**
 * A record result (#1369): a function whose result is an object literal of distinct named keys made
 * only to be returned. Its `.rec` variant writes the values to the caller's slots instead (the
 * object is never made); a caller that only reads the result's keys calls it so. The keys, or
 * undefined.
 */
/**
 * A template literal with no substitutions, as its source text (backticks included): the string it
 * is (ECMA-262 13.15.1, its TV). Line terminators are LF (CR LF and CR are one LF), and each escape is
 * what it means; `\\` before a line terminator is nothing.
 */
export function cookedTemplate(text: string): string {
  const body = text.slice(1, -1).replace(/\r\n?/g, "\n");
  let out = "";
  for (let i = 0; i < body.length; i++) {
    const c = body[i] as string;
    if (c !== "\\") {
      out += c;
      continue;
    }
    const e = body[++i] as string;
    const simple: Record<string, string> = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", v: "\v" };
    if (e in simple) out += simple[e];
    else if (e === "0" && !/[0-9]/.test(body[i + 1] ?? "")) out += "\0";
    else if (e === "x") {
      out += String.fromCharCode(Number.parseInt(body.slice(i + 1, i + 3), 16));
      i += 2;
    } else if (e === "u") {
      if (body[i + 1] === "{") {
        const end = body.indexOf("}", i);
        out += String.fromCodePoint(Number.parseInt(body.slice(i + 2, end), 16));
        i = end;
      } else {
        out += String.fromCharCode(Number.parseInt(body.slice(i + 1, i + 5), 16));
        i += 4;
      }
    } else if (e === "\n" || e === "\u2028" || e === "\u2029") {
      // A line continuation.
    } else out += e;
  }
  return out;
}

export function recordKeys(source: DucGraph): readonly string[] | undefined {
  if (source.mode !== undefined) return undefined;
  const { graph: g } = loweringView(ecmaScriptView(source));
  const r = g.obs[0];
  if (r === undefined || g.obs.slice(1).includes(r)) return undefined;
  const p = g.nodes.find((n) => n.outputs.includes(r));
  if (p === undefined || p.kind !== "op" || !(p.label ?? "").startsWith("object:"))
    return undefined;
  const slots = slotsOf(p.label as string);
  const names = slots.map((x) =>
    x.kind === "named" && x.name !== "__proto__" ? x.name : undefined,
  );
  if (names.length === 0 || names.length > 8 || names.some((x) => x === undefined))
    return undefined;
  if (new Set(names).size !== names.length || p.inputs.length !== names.length) return undefined;
  if (g.nodes.some((n) => n.inputs.includes(r))) return undefined;
  if ((g.branches ?? []).some((b) => b.cond === r)) return undefined;
  return names as string[];
}

type IntRange = "i32" | "u32";
/** A number proven an integer: an int32, a uint32, or either (in [-2^31, 2^32): below 2^32 in
 * magnitude, which is all its ToInt32 needs). */
type NumRange = IntRange | "int";
/**
 * A function's integer result ranges (#1369): its result's, when it is an int32 or a uint32 whatever
 * it is given (a bitwise operation with a number operand, `>>> `, Math.imul, a direct call of such a
 * function), and its record result's keys'. A direct call's result is then in that range (a binding
 * not yet its closure throws when called).
 */
export function resultRanges(
  source: DucGraph,
  callee: (name: string) => { ret?: IntRange; keys?: ReadonlyMap<string, IntRange> } | undefined,
): { ret?: IntRange; keys?: Map<string, IntRange> } {
  if (source.mode !== undefined) return {};
  const { graph: g } = loweringView(ecmaScriptView(source));
  const producer = new Map<ValueId, DucNode>();
  for (const n of g.nodes) for (const v of n.outputs) producer.set(v, n);
  const users = new Map<ValueId, DucNode[]>();
  for (const n of g.nodes)
    for (const v of n.inputs) users.set(v as ValueId, [...(users.get(v as ValueId) ?? []), n]);
  const freeName = (v: ValueId): string | undefined => {
    const p = producer.get(v);
    return p?.kind === "diamond-source" && p.diamond?.reason === "free-identifier"
      ? p.diamond.symbol
      : undefined;
  };
  const literalInt = (v: ValueId): IntRange | undefined => {
    const p = producer.get(v);
    if (p?.kind !== "literal-source") return undefined;
    const t = (p.label ?? "").replace(/_/g, "");
    if (!/^(0|[1-9][0-9]*)$/.test(t)) return undefined;
    const x = Number(t);
    return x < 2 ** 31 ? "i32" : x < 2 ** 32 ? "u32" : undefined;
  };
  const isNumber = (v: ValueId, depth: number): boolean => {
    const p = producer.get(v);
    if (p?.kind === "literal-source") {
      const t = (p.label ?? "").replace(/_/g, "");
      return t !== "" && !BIGINT_LITERAL.test(t) && !t.startsWith('"') && !Number.isNaN(Number(t));
    }
    return range(v, depth + 1) !== undefined;
  };
  const range = (v: ValueId, depth = 0): IntRange | undefined => {
    if (depth > 24) return undefined;
    const lit = literalInt(v);
    if (lit !== undefined) return lit;
    const p = producer.get(v);
    if (p?.kind !== "op") return undefined;
    const lbl = p.label ?? "";
    const ins = p.inputs as readonly ValueId[];
    if (ins.length === 2 && lbl === ">>>") return "u32";
    if (ins.length === 2 && ["|", "&", "^", "<<", ">>"].includes(lbl))
      return isNumber(ins[0] as ValueId, depth) || isNumber(ins[1] as ValueId, depth)
        ? "i32"
        : undefined;
    if (ins.length === 1 && lbl === "~")
      return isNumber(ins[0] as ValueId, depth) ? "i32" : undefined;
    if (lbl === "CallExpression") {
      const f = producer.get(ins[0] as ValueId);
      if (f?.kind === "diamond-source" && f.diamond?.symbol === "__ykI32Mul") return "i32";
      const name = freeName(ins[0] as ValueId);
      return name === undefined ? undefined : callee(name)?.ret;
    }
    // A key of a direct call's record result, the call's result only read by key.
    const key = /^\.([\w$]+)$/.exec(lbl)?.[1];
    if (key !== undefined && ins.length === 1) {
      const c = producer.get(ins[0] as ValueId);
      if (c?.kind !== "op" || c.label !== "CallExpression") return undefined;
      const name = freeName(c.inputs[0] as ValueId);
      const out = c.outputs[0] as ValueId;
      const onlyReads = (users.get(out) ?? []).every(
        (u) => u.kind === "op" && /^\.[\w$]+$/.test(u.label ?? "") && u.inputs.length === 1,
      );
      if (name === undefined || !onlyReads || g.obs.includes(out)) return undefined;
      return callee(name)?.keys?.get(key);
    }
    return undefined;
  };
  const r = g.obs[0];
  if (r === undefined) return {};
  const out: { ret?: IntRange; keys?: Map<string, IntRange> } = {};
  const ret = range(r);
  if (ret !== undefined) out.ret = ret;
  const p = producer.get(r);
  if (p?.kind === "op" && (p.label ?? "").startsWith("object:")) {
    const slots = slotsOf(p.label as string);
    if (slots.every((x) => x.kind === "named") && p.inputs.length === slots.length) {
      const keys = new Map<string, IntRange>();
      slots.forEach((x, i) => {
        const kr = range(p.inputs[i] as ValueId);
        if (kr !== undefined) keys.set((x as { name: string }).name, kr);
      });
      if (keys.size > 0) out.keys = keys;
    }
  }
  return out;
}

/** The operations on two proven integers lowered on their int64s (#1369). */
const INT_DOMAIN = new Set([
  "+",
  "-",
  "%",
  "|",
  "&",
  "^",
  "<<",
  ">>",
  ">>>",
  "<",
  ">",
  "<=",
  ">=",
  "===",
  "!==",
  "==",
  "!=",
]);
const INT_COMPARE: Readonly<Record<string, string>> = nameTable({
  "<": "slt",
  ">": "sgt",
  "<=": "sle",
  ">=": "sge",
  "===": "eq",
  "!==": "ne",
  "==": "eq",
  "!=": "ne",
});

/** A number clone this small (its graph's nodes) is a hint to inline into its callers (#1369). */
const SMALL_CLONE = 200;

function lowerFunction(
  m: ModuleBuilder,
  source: DucGraph,
  name: string,
  closure:
    | {
        readonly captures: number;
        /** Each capture that is a binding of the module: its name (read and written as the module's). */
        readonly moduleCaptures?: readonly (string | undefined)[] | undefined;
      }
    | undefined,
  scope?: ModuleScope,
  /** The parameters (by value) this lowering may take as numbers: a speculated clone's (#1369). */
  numberParams?: ReadonlySet<ValueId>,
  /** The arguments this lowering takes as a block's bytes and length: a `.raw` variant's (#1369). */
  rawParams?: ReadonlySet<number>,
  /** A `.rec` variant's (#1369): its record result's values written to %recout, not made. */
  recOut?: boolean,
  /** An `.int` clone's (#1369): number parameters its `.num` clone checked are integers in a range. */
  paramRanges?: ReadonlyMap<ValueId, NumRange>,
): void {
  const rawList = [...(rawParams ?? [])].sort((a, b) => a - b);
  const rawHead =
    rawList.map((k) => `, ptr %rawb${k}, i64 %rawl${k}`).join("") + (recOut ? ", ptr %recout" : "");
  /** The entry is only the speculation's checks and tail calls (set when it is). */
  let dispatchOnly = false;
  // A number clone's arguments, in registers too (#1369): each but a raw block's, when there is no
  // rest parameter (a caller with them at hand passes them; the entry its loaded ones).
  const argCount =
    closure === undefined
      ? 0
      : source.nodes.filter((n) => n.kind === "param-source").length - closure.captures;
  const regList = source.nodes.some(
    (n) => n.kind === "param-source" && (n.label ?? "").endsWith("..."),
  )
    ? undefined
    : Array.from({ length: argCount }, (_, k) => k).filter((k) => rawParams?.has(k) !== true);
  // An async function's or a generator's body is lowered as any function's: the runtime runs it as a
  // coroutine, which await and yield suspend (#1295). The closure carries the mode.
  if (source.mode !== undefined && closure === undefined)
    throw new LlvmEmitError(`an ${source.mode} function is not in the subset yet`);
  if (scope?.outs === undefined && source.obs.length > 1)
    throw new LlvmEmitError("a native function has at most one result");
  // A statement's one result names its declared values (#1292): they go to the module's bindings.
  // A statement that can return (a CommonJS module's top-level return, #1297) completes instead:
  // whether it returned, its value, then its declared values.
  const resultNode =
    scope?.outs === undefined
      ? undefined
      : source.nodes.find((n) => n.outputs.includes(source.obs[0] as ValueId));
  const completes = (resultNode?.label ?? "").startsWith(COMPLETES) ? resultNode : undefined;
  const declaredValues =
    completes !== undefined
      ? completes.inputs.slice(2)
      : (resultNode?.label ?? "").startsWith(DECLARES)
        ? resultNode?.inputs
        : undefined;
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
  // A function's own `arguments` (#1330): its arguments as an array, made on entry (strict code:
  // no parameter aliases them).
  const argumentsValues: ValueId[] = [];
  // A function's own new.target (ECMA-262 13.3.12): taken on entry, as yk_new or super() left it.
  const newTargetValues: ValueId[] = [];
  for (const n of g.nodes) {
    if (n.kind !== "diamond-source") continue;
    const sym = n.diamond?.symbol ?? "";
    if (sym === "arguments" && closure !== undefined) argumentsValues.push(n.outputs[0] as ValueId);
    else if (sym === "new.target" && closure !== undefined)
      newTargetValues.push(n.outputs[0] as ValueId);
    else if (LEAVES[sym] !== undefined) leafValue.set(n.outputs[0] as ValueId, sym);
    else if (n.diamond?.reason === "platform-primitive" && sym === "Math")
      mathValue.add(n.outputs[0] as ValueId);
    else if (
      scope?.binds?.(sym) === true &&
      (n.diamond?.reason === "platform-primitive" || n.diamond?.reason === "free-identifier")
    )
      // The module's own binding of the name: it shadows the platform's global.
      freeValue.set(n.outputs[0] as ValueId, sym);
    else if (
      GLOBALS.has(sym) &&
      (n.diamond?.reason === "platform-primitive" || sym.startsWith("__yakcc"))
    )
      // A platform global the runtime gives; the runtime's own (__yakcc…) whatever the lifter's
      // base set calls them.
      globalValue.set(n.outputs[0] as ValueId, sym);
    else if (scope !== undefined && n.diamond?.reason === "free-identifier")
      freeValue.set(n.outputs[0] as ValueId, sym);
    else if (scope !== undefined && n.diamond?.reason === "platform-primitive")
      // In a module, a platform global the runtime lacks is undefined, as on a platform without it:
      // what a `typeof` probe for it sees. Any other use fails when it runs.
      globalValue.set(n.outputs[0] as ValueId, sym);
    else throw new LlvmEmitError(`"${sym}" is not in the native base set`);
  }
  // An async try awaited at once (`await __yakccTryAsync(body, handler, finalizer)`, #1276): run in
  // this async function's coroutine, its blocks' awaits this function's, so it takes no more jobs
  // than the source's try statement does. The calls, by their result.
  const inlineTries = new Set<ValueId>();
  {
    const awaitedBy = new Map<ValueId, number>();
    const otherUse = new Set<ValueId>();
    for (const n of g.nodes)
      for (const v of n.inputs) {
        const r = resolve(v as ValueId);
        if (n.label === "AwaitExpression") awaitedBy.set(r, (awaitedBy.get(r) ?? 0) + 1);
        else otherUse.add(r);
      }
    for (const n of g.nodes)
      if (
        closure !== undefined &&
        n.label === "CallExpression" &&
        globalValue.get(resolve(n.inputs[0] as ValueId)) === "__yakccTryAsync"
      ) {
        const out = n.outputs[0] as ValueId;
        if (awaitedBy.get(out) === 1 && !otherUse.has(out)) inlineTries.add(out);
      }
  }
  const memberOf = (v: ValueId): { node: DucNode; name: string } | undefined => {
    const p = producer.get(resolve(v));
    if (p === undefined || p.kind !== "op" || !/^\.[\w$]+$/.test(p.label ?? "")) return undefined;
    return { node: p, name: (p.label as string).slice(1) };
  };
  const isMath = (v: ValueId): boolean => mathValue.has(resolve(v));
  // Member reads whose value only a call takes as its callee: not made where they stand (a method
  // call reads its member by key itself; another call's operand makes the read where it is used).
  const calleeReads = new Map<ValueId, DucNode>();
  /** Math.name reads only called: the call names the operation, nothing is read. */
  const mathCalleeReads = new Set<ValueId>();
  // Calls of a direct function with a record result whose value only its keys' reads take (#1369):
  // each call's slots, and each read's slot.
  const recordCalls = new Map<ValueId, { slot: string; keys: readonly string[] }>();
  const recordReads = new Map<ValueId, { slot: string; idx: number }>();
  // String builders (#1369): a loop's carry, a string at first, that the loop only appends to
  // (`out += x` on every path back to its next value). Each such loop's carries, and the appends.
  const builderCarries = new Map<DucNode, Set<number>>();
  const builderAppends = new Set<DucNode>();
  {
    const observed = new Set<ValueId>([
      ...g.obs.map((v) => resolve(v)),
      ...(g.branches ?? []).map((b) => resolve(b.cond as ValueId)),
    ]);
    const candidates = new Map<ValueId, DucNode>();
    for (const n of g.nodes)
      if (
        n.kind === "op" &&
        /^\.[\w$]+$/.test(n.label ?? "") &&
        n.inputs.length === 1 &&
        n.outputs.length === 1
      ) {
        const out = resolve(n.outputs[0] as ValueId);
        if (out === (n.outputs[0] as ValueId) && !observed.has(out)) candidates.set(out, n);
      }
    const bad = new Set<ValueId>();
    const called = new Set<ValueId>();
    for (const n of g.nodes)
      n.inputs.forEach((v, i) => {
        const r = resolve(v as ValueId);
        if (!candidates.has(r)) return;
        if (n.kind === "op" && n.label === "CallExpression" && i === 0) called.add(r);
        else bad.add(r);
      });
    for (const [v, n] of candidates)
      if (called.has(v) && !bad.has(v)) {
        if (isMath(n.inputs[0] as ValueId)) mathCalleeReads.add(v);
        else calleeReads.set(v, n);
      }
  }

  // --- Typed BigInts (#1369, DEC-DUC-TYPED-NATIVE-001): a BigInt the graph proves narrower than 128
  // bits is an i128, not a heap value. The proof: the integer ranges of numbers (an int32 or uint32
  // from `| 0`, `>>> 0`, the 32-bit loads, ...) and the widths of BigInts (from the fixed-width
  // leaves, literals, and the operators' growth). Anything else stays boxed.
  const leafOf = (n: DucNode): string | undefined =>
    n.label === "CallExpression" ? leafValue.get(resolve(n.inputs[0] as ValueId)) : undefined;
  const numRange = new Map<ValueId, NumRange>(paramRanges ?? []);
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
  const rangeOf = (v: ValueId): NumRange | undefined => {
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
      let range: NumRange | undefined;
      let width: number | undefined;
      const directName =
        lbl === "CallExpression" ? freeValue.get(resolve(ins[0] as ValueId)) : undefined;
      const recordKey = /^\.([\w$]+)$/.exec(lbl)?.[1];
      if (directName !== undefined && scope?.direct?.(directName) !== undefined) {
        // A direct call: its callee's result range (a binding not yet its closure throws).
        range = scope.ranges?.(directName)?.ret;
      } else if (recordKey !== undefined && ins.length === 1) {
        // A key of a direct call's record result, the call's result only read by key.
        const c = producer.get(resolve(ins[0] as ValueId));
        const cname =
          c?.kind === "op" && c.label === "CallExpression"
            ? freeValue.get(resolve(c.inputs[0] as ValueId))
            : undefined;
        const cout = c?.outputs[0] as ValueId | undefined;
        if (cname !== undefined && cout !== undefined && scope?.direct?.(cname) !== undefined) {
          const onlyReads = g.nodes.every((u) =>
            u.inputs.every(
              (x, xi) =>
                resolve(x as ValueId) !== cout ||
                (xi === 0 &&
                  u.kind === "op" &&
                  /^\.[\w$]+$/.test(u.label ?? "") &&
                  u.inputs.length === 1),
            ),
          );
          if (onlyReads && !g.obs.map((o) => resolve(o)).includes(cout))
            range = scope.ranges?.(cname)?.keys?.get(recordKey);
        }
      } else if (leaf !== undefined) {
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
      } else if (ins.length === 2 && lbl === "%") {
        // A uint32 modulo a positive integer literal: below both.
        const k = producer.get(resolve(ins[1] as ValueId));
        const kv =
          k?.kind === "literal-source" ? Number((k.label ?? "").replace(/_/g, "")) : Number.NaN;
        if (
          numRange.get(resolve(ins[0] as ValueId)) === "u32" &&
          Number.isInteger(kv) &&
          kv > 0 &&
          kv < 2 ** 32
        )
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
    // A loop's carry: its initial value or an iteration's next one, so in a range when both are
    // (an integer literal is in the ranges it fits).
    const litRange = (v: ValueId): NumRange | "both" | undefined => {
      const r = numRange.get(resolve(v));
      if (r !== undefined) return r;
      const p = producer.get(resolve(v));
      if (p?.kind !== "literal-source") return undefined;
      const t = (p.label ?? "").replace(/_/g, "");
      if (!/^(0|[1-9][0-9]*)$/.test(t)) return undefined;
      const x = Number(t);
      return x < 2 ** 31 ? "both" : x < 2 ** 32 ? "u32" : undefined;
    };
    for (const n of g.nodes) {
      const rec = n.loop;
      if (n.kind !== "loop" || rec === undefined) continue;
      rec.carry.forEach((c, j) => {
        const v = resolve(c);
        if (numRange.has(v)) return;
        const a = litRange(n.inputs[j] as ValueId);
        const b = litRange(rec.next[j] as ValueId);
        if (a === undefined || b === undefined) return;
        const r: NumRange =
          a === "both" ? (b === "both" ? "i32" : b) : b === "both" || a === b ? a : "int";
        numRange.set(v, r);
        changed = true;
      });
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
            resolve(c.inputs[1] as ValueId) !== out &&
            // Not a method's callee (`[9, 2][Symbol.iterator]()`): the call takes the array as this.
            !(uses.get(resolve(c.outputs[0] as ValueId)) ?? []).some(
              (u) =>
                u.kind === "op" &&
                u.label === "CallExpression" &&
                resolve(u.inputs[0] as ValueId) === resolve(c.outputs[0] as ValueId),
            ),
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
      if (provenNumber.has(v) || numRange.has(v)) return true;
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
        (FAST_ARITH[n.label ?? ""] !== undefined ||
          FAST_COMPARE[n.label ?? ""] !== undefined ||
          FAST_BITWISE[n.label ?? ""] !== undefined)) ||
        (n.inputs.length === 1 && (n.label === "-" || n.label === "~"))) &&
      allNumbers(n.inputs as readonly ValueId[]);
    // A float store's value: its fast path writes the double as it is, its slow path (a runtime
    // call) canonicalizes it first. Only a store whose own result nothing reads (it orders after).
    const heapOnlyUse = (u: DucNode, i: number): boolean =>
      (u.order === 1 && i === u.inputs.length - 1) ||
      (u.kind === "sel" && u.label === "heap") ||
      (u.label ?? "").endsWith(":heap");
    const rawStoreUse = (n: DucNode, o: ValueId): boolean => {
      const leaf =
        n.kind === "op" && n.label === "CallExpression"
          ? leafValue.get(resolve(n.inputs[0] as ValueId))
          : undefined;
      if (leaf !== "__ykStoreF64" && leaf !== "__ykStoreF32") return false;
      if (resolve(n.inputs[1] as ValueId) === o || resolve(n.inputs[2] as ValueId) !== o)
        return false;
      const st = n.outputs[0] as ValueId;
      if (escapes.has(st)) return false;
      return (usesOf.get(st) ?? []).every((u) =>
        u.inputs.every((x, i) => resolve(x as ValueId) !== st || heapOnlyUse(u, i)),
      );
    };
    for (const n of g.nodes) {
      const o = n.outputs[0] as ValueId | undefined;
      if (o === undefined || escapes.has(o) || !provenNumber.has(o)) continue;
      const us = usesOf.get(o) ?? [];
      if (us.length > 0 && us.every((u) => numericUse(u) || rawStoreUse(u, o))) rawNumbers.add(o);
    }
  }
  /**
   * A bound on a number's magnitude the graph proves (#1369): an int32 or uint32 range, a finite
   * literal, and + - * and negation of bounded numbers (each of which is a number when its inputs
   * are). Undefined when there is none.
   */
  const magnitude = (v0: ValueId, depth = 0): number | undefined => {
    const v = resolve(v0);
    const r = numRange.get(v);
    if (r !== undefined) return r === "i32" ? 2 ** 31 : 2 ** 32;
    const lit = literalNumber(v);
    if (lit !== undefined) return Number.isFinite(lit) ? Math.abs(lit) : undefined;
    const p = producer.get(v);
    if (depth > 12 || p?.kind !== "op") return undefined;
    if (p.inputs.length === 1 && p.label === "-")
      return magnitude(p.inputs[0] as ValueId, depth + 1);
    if (p.inputs.length !== 2 || !["+", "-", "*"].includes(p.label ?? "")) return undefined;
    const a = magnitude(p.inputs[0] as ValueId, depth + 1);
    const b = a === undefined ? undefined : magnitude(p.inputs[1] as ValueId, depth + 1);
    if (a === undefined || b === undefined) return undefined;
    return p.label === "*" ? a * b : a + b;
  };
  /** Whether a number is proven below 2^63 in magnitude: its int64 conversion is ToInt32's modulo. */
  const boundedInt64 = (v: ValueId): boolean => {
    const b = magnitude(v);
    return b !== undefined && b < 9.2e18;
  };
  /** A value proven a non-negative integer below 2^53: a uint32's, a literal's, or a sum of them. */
  const naturalInt = (v0: ValueId, depth = 0): boolean => {
    const v = resolve(v0);
    if (numRange.get(v) === "u32") return true;
    const p = producer.get(v);
    if (p?.kind === "literal-source") {
      const x = Number((p.label ?? "").replace(/_/g, ""));
      return Number.isSafeInteger(x) && x >= 0 && !Object.is(x, -0);
    }
    if (depth > 8 || p?.kind !== "op" || p.label !== "+" || p.inputs.length !== 2) return false;
    const b = magnitude(v);
    return (
      b !== undefined &&
      b < 2 ** 53 &&
      naturalInt(p.inputs[0] as ValueId, depth + 1) &&
      naturalInt(p.inputs[1] as ValueId, depth + 1)
    );
  };
  /** A raw double's bits made canonical (a NaN as the one NaN boxed values use). */
  const canonicalBits = (bits: string): string => {
    const d = fresh();
    emit(`${d} = bitcast i64 ${bits} to double`);
    const nan = fresh();
    emit(`${nan} = fcmp uno double ${d}, 0.0`);
    const r = fresh();
    emit(`${r} = select i1 ${nan}, i64 ${CANONICAL_NAN}, i64 ${bits}`);
    return r;
  };
  const rawBits = (d: string): string => {
    const bits = fresh();
    emit(`${bits} = bitcast double ${d} to i64`);
    return bits;
  };
  /** A double result for `out`: its bits as they are when only numeric operations read it. */
  const numberResult = (out: ValueId, d: string): string =>
    // A value of bounded magnitude (finite operands, + - * of them) is never NaN: no canonical form.
    rawNumbers.has(resolve(out)) || magnitude(out) !== undefined ? rawBits(d) : boxDouble(d);
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
  /**
   * A property name as a key (#1369): the module's one string of it, made at its first use and kept
   * in a global (one per name), so a read, a write or a call by name makes and hashes no string.
   */
  /**
   * A named member read with its site's cache (#1370): the index its key was last found at in an
   * object's own keys, tried first (objects made alike have it at the same place).
   */
  const getNamed = (obj: string, key: string): string => {
    const site = `@yk.ic.${m.icSites++}`;
    m.globals.push(`${site} = internal global i32 0`);
    m.intrinsics.add("declare i64 @yk_get_ic(i64, i64, ptr)");
    const r = fresh();
    emit(`${r} = call i64 @yk_get_ic(i64 ${obj}, i64 ${key}, ptr ${site})`);
    return r;
  };
  const keyOf = (name: string): string => {
    let g0 = m.keys.get(name);
    if (g0 === undefined) {
      g0 = `@ykey${m.keys.size}`;
      m.keys.set(name, g0);
      m.globals.push(`${g0} = internal global i64 0`);
      // Filled before main, by the module's constructor: each use is a load.
      const c = m.constant(name);
      m.intrinsics.add("declare i64 @yk_key_of(ptr, ptr, i64)");
      m.keyInits.push(`  call i64 @yk_key_of(ptr ${g0}, ptr ${c.ptr}, i64 ${c.length})`);
    }
    const k = fresh();
    emit(`${k} = load i64, ptr ${g0}`);
    return k;
  };
  /** A string literal: the module's one string of its text (immutable, so shared). */
  const str = (text: string): string => keyOf(text);

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
    const read = calleeReads.get(v);
    if (read !== undefined)
      return call(
        "yk_get",
        `i64 ${operand(read.inputs[0] as ValueId)}, i64 ${keyOf((read.label as string).slice(1))}`,
      );
    const lazy = lazyFrames.get(v);
    if (lazy !== undefined) {
      // A lazily allocated frame: allocated here when it is not yet.
      m.intrinsics.add("declare i64 @yk_frame_alloc(i64, i64)");
      const before = fresh();
      emit(`${before} = load i64, ptr ${slotOf(v)}`);
      const none = fresh();
      emit(`${none} = icmp eq i64 ${before}, 0`);
      const make = freshLabel("lazymake");
      const done = freshLabel("lazydone");
      const from = currentLabel();
      emit(`br i1 ${none}, label %${make}, label %${done}`);
      block(make);
      const made = fresh();
      emit(`${made} = call i64 @yk_frame_alloc(i64 ${lazy.size}, i64 ${lazy.align})`);
      emit(`store i64 ${made}, ptr ${slotOf(v)}`);
      emit(`br label %${done}`);
      block(done);
      const r = fresh();
      emit(`${r} = phi i64 [ ${before}, %${from} ], [ ${made}, %${make} ]`);
      return r;
    }
    const p = producer.get(v);
    if (p?.kind === "literal-source") {
      const text = p.label ?? "";
      if (text === "true") return TRUE;
      if (text === "false") return FALSE;
      if (text === "null") return NULL;
      // `let x;`: undefined until written.
      if (text === "undefined" || text === "Uninitialized") return UNDEFINED;
      if (text.startsWith('"')) return str(JSON.parse(text) as string);
      // A template with no substitutions (#1370: TypeScript's own): its cooked string.
      if (text.startsWith("`")) return str(cookedTemplate(text));
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
    if (
      (p?.kind === "diamond-source" || freeValue.has(v)) &&
      !argumentsValues.includes(v) &&
      !newTargetValues.includes(v)
    ) {
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
      // Math read as a value (`const { abs } = Math`): the runtime's global, as a program makes it.
      const sym = globalValue.get(v) ?? (mathValue.has(v) ? "Math" : undefined);
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
  /** A fast path's condition, told to LLVM as the likely one (its block laid out to fall through). */
  const likely = (c: string): string => {
    if (c === "true" || c === "false") return c;
    m.intrinsics.add("declare i1 @llvm.expect.i1(i1, i1)");
    const r = fresh();
    emit(`${r} = call i1 @llvm.expect.i1(i1 ${c}, i1 true)`);
    return r;
  };
  // Integers' own slots (#1369, DEC-DUC-TYPED-NATIVE-001): a value proven in an integer range keeps
  // its int64 beside its box, written where it is made (integer operations, loop carries), so a
  // chain of integer operations is not converted to doubles and back between them.
  const intSlots = new Map<ValueId, string>();
  const setInt = (v0: ValueId, r: string): void => {
    const v = resolve(v0);
    let s0 = intSlots.get(v);
    if (s0 === undefined) {
      s0 = `%i${intSlots.size}`;
      intSlots.set(v, s0);
    }
    emit(`store i64 ${r}, ptr ${s0}`);
  };
  /** An integer literal in [-2^31, 2^32) (not -0), or undefined. */
  const intLiteral = (v: ValueId): number | undefined => {
    const x = literalNumber(v);
    return x !== undefined &&
      Number.isInteger(x) &&
      x >= -(2 ** 31) &&
      x < 2 ** 32 &&
      !Object.is(x, -0)
      ? x
      : undefined;
  };
  /** Whether a value is proven an integer (a number, not -0): in a range, a literal, or one an
   * integer operation made (exact, below 2^53). */
  const intKnown = (v: ValueId): boolean =>
    numRange.has(resolve(v)) || intLiteral(v) !== undefined || intSlots.has(resolve(v));
  /** A proven integer's int64: its own slot's, a literal's, else its box converted. */
  const intOperand = (v0: ValueId): string => {
    const v = resolve(v0);
    const lit = intLiteral(v);
    if (lit !== undefined) return String(lit);
    const own = intSlots.get(v);
    if (own !== undefined) {
      const r = fresh();
      emit(`${r} = load i64, ptr ${own}`);
      return r;
    }
    const d = fresh();
    emit(`${d} = bitcast i64 ${operand(v)} to double`);
    const r = fresh();
    emit(`${r} = fptosi double ${d} to i64`);
    return r;
  };
  /** An integer's box: its double's bits (never NaN). */
  const intBox = (r: string): string => {
    const d = fresh();
    emit(`${d} = sitofp i64 ${r} to double`);
    const b = fresh();
    emit(`${b} = bitcast double ${d} to i64`);
    return b;
  };
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
  // Numeric work worth inline paths and a number clone: enough arithmetic, bitwise, Math and memory
  // operations (a library's function compares a length here and there; a math atom computes).
  const numericWork = ((): boolean => {
    const ARITH = new Set(["+", "-", "*", "/", "%", "&", "|", "^", "<<", ">>", ">>>", "~"]);
    const work = g.nodes.filter((n) => {
      if (n.kind !== "op") return false;
      if (ARITH.has(n.label ?? "")) return true;
      const leaf = leafOf(n);
      if (leaf !== undefined && MEM_INLINE[leaf] !== undefined) return true;
      const callee = n.label === "CallExpression" ? memberOf(n.inputs[0] as ValueId) : undefined;
      return callee !== undefined && isMath(callee.node.inputs[0] as ValueId);
    }).length;
    return work >= 4 && work * 12 >= g.nodes.length;
  })();
  const compact = !numericWork && numberParams === undefined;
  // A loop's body is where a function's time goes: there a compact function's operations keep their
  // inline fast paths too (#1369).
  const loopBodies = g.nodes.flatMap((n) => (n.loop !== undefined ? [`${n.loop.id}.b`] : []));
  const inLoop = (n: DucNode | undefined): boolean => {
    const r = n?.region;
    return r !== undefined && loopBodies.some((b) => r === b || r.startsWith(`${b}/`));
  };
  let emitting: DucNode | undefined;
  const numberFast = (
    args: readonly string[],
    fast: (ds: readonly string[]) => string,
    slow: () => string,
    guard?: (ds: readonly string[]) => string,
    proven = false,
  ): string => {
    // Code with little numeric work (a library's function): the runtime's operation, not an inline
    // fast path beside it, so the module stays small and compiles fast (#1369).
    // Strict equality keeps its few instructions everywhere: library code compares numbers
    // (`node.kind === SyntaxKind.X`) more than it does anything else (#1370).
    const equality = emitting?.label === "===" || emitting?.label === "!==";
    if (compact && !proven && !inLoop(emitting) && !equality) return slow();
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
    emit(`br i1 ${likely(all)}, label %${check}, label %${slowLabel}`);
    block(check);
    const ds = args.map((a) => {
      const d = fresh();
      emit(`${d} = bitcast i64 ${a} to double`);
      return d;
    });
    if (guard !== undefined)
      emit(`br i1 ${likely(guard(ds))}, label %${fastLabel}, label %${slowLabel}`);
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
  /** Math.imul (raise-c's __ykI32Mul): the low 32 bits of the product of two numbers' ToInt32s,
   * inline; anything else the runtime's leaf (#1369). */
  const imul = (pa: string, pb: string, va?: ValueId, vb?: ValueId): string => {
    const ua = va === undefined || !boundedInt64(va);
    const ub = vb === undefined || !boundedInt64(vb);
    return numberFast(
      [pa, pb],
      ([x, y]) => {
        const r = fresh();
        emit(`${r} = mul i32 ${toInt32(x as string)}, ${toInt32(y as string)}`);
        const d = fresh();
        emit(`${d} = sitofp i32 ${r} to double`);
        const bits = fresh();
        emit(`${bits} = bitcast double ${d} to i64`);
        return bits;
      },
      () => call("yk_leaf_i32mul", `i64 ${pa}, i64 ${pb}`),
      ua && ub
        ? ([x, y]) => {
            const both = fresh();
            emit(`${both} = and i1 ${smallDouble(x as string)}, ${smallDouble(y as string)}`);
            return both;
          }
        : ua
          ? ([x]) => smallDouble(x as string)
          : ub
            ? ([, y]) => smallDouble(y as string)
            : undefined,
      va !== undefined && vb !== undefined && allNumbers([va, vb]),
    );
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
  // Blocks whose address never escapes (#1369): an __ykAlloc of a constant size whose value is
  // only the address of inline loads and stores (at constant offsets inside it, a store's value a
  // proven number), its __ykFree, or a loop's invariant. Such a block is an alloca: no region, no
  // trap is possible (every access is inside it), and its free is nothing. A C front end spills an
  // address-taken local (a bit cast through memory) this way.
  const usersOf = new Map<ValueId, DucNode[]>();
  for (const n of g.nodes)
    for (const v of n.inputs) {
      const r = resolve(v as ValueId);
      const list = usersOf.get(r) ?? [];
      list.push(n);
      usersOf.set(r, list);
    }
  const leafOfCall = (n: DucNode): string | undefined =>
    n.kind === "op" && n.label === "CallExpression"
      ? leafValue.get(resolve(n.inputs[0] as ValueId))
      : undefined;
  const localBlocks = new Map<ValueId, { slot: string; size: number }>();
  /**
   * Whether some node reads a value, not only orders after it (a heap token's use). A comma reads
   * only its last input, and only when its own value is read.
   */
  const valueRead = (v: ValueId, depth = 0): boolean =>
    depth > 16 ||
    (usersOf.get(v) ?? []).some((u) =>
      u.inputs.some((x, i) => {
        if (resolve(x as ValueId) !== v) return false;
        if (
          (u.order === 1 && i === u.inputs.length - 1) ||
          (u.kind === "sel" && u.label === "heap") ||
          (u.label ?? "").endsWith(":heap")
        )
          return false;
        if (u.kind === "op" && u.label === ",")
          return i === u.inputs.length - 1 && valueRead(u.outputs[0] as ValueId, depth + 1);
        return true;
      }),
    ) ||
    g.obs.some((o) => resolve(o) === v);
  // A `.raw` variant's block arguments (#1369): each its bytes' and length's parameters.
  const rawBlocks = new Map<ValueId, { slot: string; len: string }>();
  params.forEach((p, i) => {
    const k = i - (closure?.captures ?? 0);
    if (closure !== undefined && k >= 0 && rawParams?.has(k) === true)
      rawBlocks.set(p.outputs[0] as ValueId, { slot: `%rawb${k}`, len: `%rawl${k}` });
  });
  /** A block's bytes for an access: a local block's (inside it) or a raw argument's (len checks). */
  const localAccess = (
    v0: ValueId,
    size: number,
  ): { slot: string; off: number; len?: string } | undefined => {
    const v = resolve(v0);
    const raw = rawBlocks.get(v);
    if (raw !== undefined) return { slot: raw.slot, off: 0, len: raw.len };
    const direct = localBlocks.get(v);
    if (direct !== undefined)
      return size <= direct.size ? { slot: direct.slot, off: 0 } : undefined;
    const p = producer.get(v);
    if (p?.kind !== "op" || p.label !== "+" || p.inputs.length !== 2) return undefined;
    for (const [x, y] of [
      [p.inputs[0], p.inputs[1]],
      [p.inputs[1], p.inputs[0]],
    ] as [ValueId, ValueId][]) {
      const b = localBlocks.get(resolve(x));
      const k = constantInt(y);
      if (b !== undefined && k !== undefined && Number.isInteger(k) && k >= 0 && k + size <= b.size)
        return { slot: b.slot, off: k };
      const r = rawBlocks.get(resolve(x));
      if (r !== undefined && k !== undefined && Number.isInteger(k) && k >= 0)
        return { slot: r.slot, off: k, len: r.len };
    }
    return undefined;
  };
  /** A call's callee's raw block arguments, when it is a direct function with a `.raw` variant. */
  const rawCallArgs = (u: DucNode): ReadonlySet<number> | undefined => {
    if (u.kind !== "op" || u.label !== "CallExpression" || leafOfCall(u) !== undefined)
      return undefined;
    const name = freeValue.get(resolve(u.inputs[0] as ValueId));
    if (name === undefined || scope?.direct?.(name) === undefined) return undefined;
    return scope.rawArgs?.(name);
  };
  /**
   * The blocks a call to a `.raw` variant passes, one per raw argument (its value is a block:
   * `isBlock`, or this function's own raw argument); undefined when one is not.
   */
  const rawCallBlocks = (u: DucNode, isBlock: (v: ValueId) => boolean): ValueId[] | undefined => {
    const raw = rawCallArgs(u);
    if (raw === undefined) return undefined;
    const end = u.order === 1 ? u.inputs.length - 1 : u.inputs.length;
    const out: ValueId[] = [];
    for (const k of [...raw].sort((a, b) => a - b)) {
      if (1 + k >= end) return undefined;
      const a = resolve(u.inputs[1 + k] as ValueId);
      if (!isBlock(a) && !rawBlocks.has(a)) return undefined;
      out.push(a);
    }
    return out;
  };
  const candidates = new Map<ValueId, { size: number; rawCalls: DucNode[] }>();
  /** A raw argument's access: inside its length, or the runtime's memory trap. */
  const blockBound = (local: { off: number; len?: string }, size: number): void => {
    if (local.len === undefined) return;
    const ok = fresh();
    emit(`${ok} = icmp ule i64 ${local.off + size}, ${local.len}`);
    const inside = freshLabel("rawin");
    const outside = freshLabel("rawout");
    emit(`br i1 ${ok}, label %${inside}, label %${outside}`);
    block(outside);
    m.intrinsics.add("declare void @yk_raw_trap(i64, i64)");
    emit(`call void @yk_raw_trap(i64 ${local.off}, i64 ${size})`);
    emit("unreachable");
    block(inside);
  };
  {
    // An address use: a load's or store's address operand (never a store's value), in bounds.
    const addressUse = (u: DucNode, v: ValueId, blockSize: number, off: number): boolean => {
      const leaf = leafOfCall(u) ?? "";
      // 64-bit accesses: a load whose result is a typed BigInt, a store of any value.
      if (leaf === "__ykLoad64" || leaf === "__ykStore64") {
        if (resolve(u.inputs[1] as ValueId) !== v) return false;
        if (leaf === "__ykStore64" && resolve(u.inputs[2] as ValueId) === v) return false;
        if (leaf === "__ykLoad64" && !isTypedBig(u.outputs[0] as ValueId)) return false;
        return off >= 0 && off + 8 <= blockSize;
      }
      const mem = MEM_INLINE[leaf];
      if (mem === undefined) return false;
      if (resolve(u.inputs[1] as ValueId) !== v) return false;
      if (mem.store && resolve(u.inputs[2] as ValueId) === v) return false;
      if (mem.store && !allNumbers([u.inputs[2] as ValueId])) return false;
      return off >= 0 && off + mem.size <= blockSize;
    };
    // Each use of a value, by input position: a heap token (an ordered node's last input, a heap
    // select or carry) orders and reads nothing.
    const heapOnly = (u: DucNode, i: number): boolean =>
      (u.order === 1 && i === u.inputs.length - 1) ||
      (u.kind === "sel" && u.label === "heap") ||
      (u.label ?? "").endsWith(":heap");
    // As localAccess reads them: the block itself, or the block plus a constant (one step).
    const blockUsesOk = (
      v: ValueId,
      size: number,
      off: number,
      depth = 0,
      rawCalls: DucNode[] = [],
    ): boolean => {
      if (depth > 1) return false;
      return (usersOf.get(v) ?? []).every((u) =>
        u.inputs.every((x, i) => {
          if (resolve(x as ValueId) !== v || heapOnly(u, i)) return true;
          const leaf = leafOfCall(u);
          if (depth === 0 && i >= 1 && rawCallArgs(u)?.has(i - 1) === true) {
            rawCalls.push(u);
            return true;
          }
          if (i === 1 && leaf !== undefined && addressUse(u, v, size, off)) return true;
          if (i === 1 && leaf === "__ykFree" && off === 0) return true;
          if (u.kind === "loop" && u.loop !== undefined) {
            // Only as an invariant (its uses inside are the body's, checked as these are).
            return i >= u.loop.carry.length + (u.loop.iterate !== undefined ? 1 : 0);
          }
          // (a, b): b is its value; a is computed and dropped.
          if (u.kind === "op" && u.label === ",") return i < u.inputs.length - 1;
          if (depth === 0 && u.kind === "op" && u.label === "+" && u.inputs.length === 2) {
            const other = u.inputs[1 - i] as ValueId;
            const k = constantInt(other);
            if (k === undefined || !Number.isInteger(k) || resolve(other) === v) return false;
            return blockUsesOk(u.outputs[0] as ValueId, size, off + k, depth + 1, rawCalls);
          }
          return false;
        }),
      );
    };
    for (const n of g.nodes) {
      if (leafOfCall(n) !== "__ykAlloc") continue;
      const size = literalNumber(n.inputs[1] as ValueId);
      const align = literalNumber(n.inputs[2] as ValueId);
      if (
        size === undefined ||
        align === undefined ||
        !Number.isInteger(size) ||
        size <= 0 ||
        size > 4096
      )
        continue;
      if (!Number.isInteger(align) || align < 1 || align > 16 || (align & (align - 1)) !== 0)
        continue;
      const v = n.outputs[0] as ValueId;
      const rawCalls: DucNode[] = [];
      if (!blockUsesOk(v, size, 0, 0, rawCalls)) continue;
      candidates.set(v, { size, rawCalls });
    }
    // A block passed to a `.raw` variant is local only when every raw argument of that call is a
    // block too (a local one, or this function's own raw argument).
    for (let changed = true; changed; ) {
      changed = false;
      for (const [v, c] of candidates)
        if (c.rawCalls.some((u) => rawCallBlocks(u, (x) => candidates.has(x)) === undefined)) {
          candidates.delete(v);
          changed = true;
        }
    }
    for (const [v, c] of candidates) {
      const slot = `%lb${localBlocks.size}`;
      entryAllocas.push(`  ${slot} = alloca [${c.size} x i8], align 16`);
      localBlocks.set(v, { slot, size: c.size });
    }
  }
  // Frames allocated on first use (#1369): an escaping block every use of which (but its frees and
  // heap tokens) is inside a branch: a rarely taken path (V8's rem_pio2 hands its tx[] to the
  // kernel only for huge arguments) costs no allocation on the common one. Its value is 0 until
  // a use allocates it; a free of one never allocated is nothing.
  const lazyFrames = new Map<ValueId, { size: number; align: number }>();
  {
    const heapOnly = (u: DucNode, i: number): boolean =>
      (u.order === 1 && i === u.inputs.length - 1) ||
      (u.kind === "sel" && u.label === "heap") ||
      (u.label ?? "").endsWith(":heap");
    // How many branches (and loop bodies) a region is inside: its path's steps ("b10.e/b8.e").
    const depthOf = (region: string | undefined): number =>
      region === undefined ? 0 : region.split("/").length;
    for (const n of g.nodes) {
      if (leafOfCall(n) !== "__ykAlloc" || n.region !== undefined) continue;
      const v = n.outputs[0] as ValueId;
      if (localBlocks.has(v)) continue;
      const size = literalNumber(n.inputs[1] as ValueId);
      const align = literalNumber(n.inputs[2] as ValueId);
      if (
        size === undefined ||
        align === undefined ||
        !Number.isInteger(size) ||
        size < 0 ||
        size >= 2 ** 31
      )
        continue;
      if (!Number.isInteger(align) || align < 1 || align > 4096 || (align & (align - 1)) !== 0)
        continue;
      let uses = 0;
      const ok = (usersOf.get(v) ?? []).every((u) =>
        u.inputs.every((x, i) => {
          if (resolve(x as ValueId) !== v || heapOnly(u, i)) return true;
          if (leafOfCall(u) === "__ykFree" && i === 1) return true;
          uses++;
          // Three branches deep or more: a path taken rarely enough that a check on it costs less
          // than an allocation on every call (V8's sin hands rem_pio2 its y[] two deep, on the
          // common path for |x| > pi/4; rem_pio2's tx[] is four deep, for huge arguments only).
          return u.closure === undefined && depthOf(u.region) >= 3;
        }),
      );
      if (ok && uses > 0 && !g.obs.some((o) => resolve(o) === v))
        lazyFrames.set(v, { size, align });
    }
  }
  /** The int64 of the integer load memoryAccess made last (#1369), or undefined. */
  let loadInt: string | undefined;
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
    /** A load whose every use reads the double's bits (rawNumbers): a NaN needs no canonical form. */
    raw = false,
    /** A store's value is proven below 2^63 in magnitude: its ToInt32 needs no check. */
    bounded = false,
    /** The address is proven a non-negative integer below 2^53: no range or integer check. */
    natural = false,
    /** Such an address's int64, when the lowering has it. */
    addrInt?: string,
  ): string => {
    for (const d of MEM_CACHE_DECLS) m.intrinsics.add(d);
    m.intrinsics.add("declare double @llvm.fabs.f64(double)");
    let intFast: string | undefined;
    loadInt = undefined;
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
        if (mem.kind === "u" && !bounded) {
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
      emit(`br i1 ${likely(numbers)}, label %${range}, label %${slowLabel}`);
      block(range);
      const d = fresh();
      emit(`${d} = bitcast i64 ${addr} to double`);
      let ok = "true";
      if (!natural) {
        const nonneg = fresh();
        emit(`${nonneg} = fcmp oge double ${d}, 0.0`);
        const below = fresh();
        emit(`${below} = fcmp olt double ${d}, 9.2e18`);
        ok = fresh();
        emit(`${ok} = and i1 ${nonneg}, ${below}`);
      }
      if (mem.store) {
        xd = fresh();
        emit(`${xd} = bitcast i64 ${value} to double`);
        if (mem.kind === "u" && !bounded) {
          // ToInt32 of the value inline needs it below 2^63 in magnitude.
          const small = fresh();
          emit(`${small} = and i1 ${ok}, ${smallDouble(xd)}`);
          ok = small;
        }
      }
      emit(`br i1 ${likely(ok)}, label %${conv}, label %${slowLabel}`);
      block(conv);
      let i = addrInt as string;
      if (!natural || addrInt === undefined) {
        i = fresh();
        emit(`${i} = fptosi double ${d} to i64`);
      }
      let integral = "true";
      if (!natural) {
        const back = fresh();
        emit(`${back} = sitofp i64 ${i} to double`);
        integral = fresh();
        emit(`${integral} = fcmp oeq double ${back}, ${d}`);
      }
      // Two caches, inline: the runtime's (the region last allocated or found: a new frame's) and
      // this site's own (the region this access last hit: its base, length, bytes and the runtime's
      // epoch then). A site's region is that region still while the 16 bytes before its bytes hold
      // its base (a free clears them) and the epoch is the same (a large region's bytes going back to
      // the C library changes it). A store site's cache is only ever filled by a store that
      // succeeded, so its region is writable.
      const within = (base: string, len: string): { off: string; ok: string } => {
        const off = fresh();
        emit(`${off} = sub i64 ${i}, ${base}`);
        // off + size <= len as one compare: off below len less size - 1 (0 when len is shorter),
        // which a loop computes once.
        let lim = len;
        if (mem.size > 1) {
          m.intrinsics.add("declare i64 @llvm.usub.sat.i64(i64, i64)");
          lim = fresh();
          emit(`${lim} = call i64 @llvm.usub.sat.i64(i64 ${len}, i64 ${mem.size - 1})`);
        }
        const inside = fresh();
        emit(`${inside} = icmp ult i64 ${off}, ${lim}`);
        const ok = fresh();
        emit(`${ok} = and i1 ${integral}, ${inside}`);
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
        // The bytes read before the test, so that a loop reads them once.
        const gBytes = fresh();
        emit(`${gBytes} = load ptr, ptr ${g0}_bytes`);
        const gHit = freshLabel("mglobal");
        const next = freshLabel("mnext");
        emit(`br i1 ${likely(gOk)}, label %${gHit}, label %${next}`);
        block(gHit);
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
      emit(`br i1 ${likely(all)}, label %${live}, label %${slowLabel}`);
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
      emit(`br i1 ${likely(same)}, label %${fast}, label %${slowLabel}`);
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
        intFast = z;
        const f = fresh();
        emit(`${f} = uitofp i64 ${z} to double`);
        r1 = fresh();
        emit(`${r1} = bitcast double ${f} to i64`);
      } else if (mem.kind === "f64") r1 = raw ? rawBits(v) : boxDouble(v);
      else {
        const f = fresh();
        emit(`${f} = fpext float ${v} to double`);
        r1 = raw ? rawBits(f) : boxDouble(f);
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
    // An integer load's int64 from the runtime's number too (a load gives one or traps).
    let intSlow: string | undefined;
    if (intFast !== undefined) {
      const d = fresh();
      emit(`${d} = bitcast i64 ${r2} to double`);
      intSlow = fresh();
      emit(`${intSlow} = fptoui double ${d} to i64`);
    }
    const slowEnd = currentLabel();
    emit(`br label %${join}`);
    block(join);
    const r = fresh();
    emit(`${r} = phi i64 [ ${r1}, %${fastEnd} ], [ ${r2}, %${slowEnd} ]`);
    if (intFast !== undefined) {
      const ri = fresh();
      emit(`${ri} = phi i64 [ ${intFast}, %${fastEnd} ], [ ${intSlow}, %${slowEnd} ]`);
      loadInt = ri;
    }
    return r;
  };
  // The runtime's layouts the lowering reads itself (#1369): yk.c asserts its structs match these.
  const LAYOUTS = [
    "%yk.array = type { i32, i32, ptr, i64, ptr }",
    "%yk.object = type { i32, i32, ptr, ptr, i32, i32, i64, ptr, ptr, ptr }",
    "%yk.view = type { i64, i32, i32, i32 }",
    "%yk.buffer = type { i32, ptr }",
  ];
  const unboxPtr = (v: string): string => {
    const a = fresh();
    emit(`${a} = and i64 ${v}, 281474976710655`);
    const p = fresh();
    emit(`${p} = inttoptr i64 ${a} to ptr`);
    return p;
  };
  /** Hot code's obj[key]: an array's element (no holes) or a Uint32Array's / Uint8Array's at an
   * index in range, read here; anything else the runtime's yk_get. */
  const indexRead = (obj: string, key: string): string => {
    for (const t of LAYOUTS) if (!m.globals.includes(t)) m.globals.unshift(t);
    const slowL = freshLabel("getslow");
    const join = freshLabel("got");
    const incoming: [string, string][] = [];
    const isNum = fresh();
    emit(`${isNum} = icmp ult i64 ${key}, ${NUMBER_LIMIT}`);
    const numL = freshLabel("getnum");
    emit(`br i1 ${isNum}, label %${numL}, label %${slowL}`);
    block(numL);
    const d = fresh();
    emit(`${d} = bitcast i64 ${key} to double`);
    const lo = fresh();
    emit(`${lo} = fcmp oge double ${d}, 0.0`);
    const hi = fresh();
    emit(`${hi} = fcmp olt double ${d}, 4294967296.0`);
    const inR = fresh();
    emit(`${inR} = and i1 ${lo}, ${hi}`);
    const rangeL = freshLabel("getrange");
    emit(`br i1 ${inR}, label %${rangeL}, label %${slowL}`);
    block(rangeL);
    const i = fresh();
    emit(`${i} = fptoui double ${d} to i32`);
    const back = fresh();
    emit(`${back} = uitofp i32 ${i} to double`);
    const whole = fresh();
    emit(`${whole} = fcmp oeq double ${back}, ${d}`);
    const intL = freshLabel("getint");
    emit(`br i1 ${whole}, label %${intL}, label %${slowL}`);
    block(intL);
    const tag = fresh();
    emit(`${tag} = lshr i64 ${obj}, 48`);
    const arrL = freshLabel("getarr");
    const objL = freshLabel("getobj");
    const notArr = freshLabel("getnotarr");
    const isArr = fresh();
    emit(`${isArr} = icmp eq i64 ${tag}, 65531`);
    emit(`br i1 ${isArr}, label %${arrL}, label %${notArr}`);
    // An array: in range, with no holes.
    block(arrL);
    const ap = unboxPtr(obj);
    const lenP = fresh();
    emit(`${lenP} = getelementptr %yk.array, ptr ${ap}, i32 0, i32 0`);
    const len = fresh();
    emit(`${len} = load i32, ptr ${lenP}`);
    const holesP = fresh();
    emit(`${holesP} = getelementptr %yk.array, ptr ${ap}, i32 0, i32 4`);
    const holes = fresh();
    emit(`${holes} = load ptr, ptr ${holesP}`);
    const noHoles = fresh();
    emit(`${noHoles} = icmp eq ptr ${holes}, null`);
    const inLen = fresh();
    emit(`${inLen} = icmp ult i32 ${i}, ${len}`);
    const okA = fresh();
    emit(`${okA} = and i1 ${noHoles}, ${inLen}`);
    const arrHit = freshLabel("getarrhit");
    emit(`br i1 ${okA}, label %${arrHit}, label %${slowL}`);
    block(arrHit);
    const itemsP = fresh();
    emit(`${itemsP} = getelementptr %yk.array, ptr ${ap}, i32 0, i32 2`);
    const items = fresh();
    emit(`${items} = load ptr, ptr ${itemsP}`);
    const ep = fresh();
    emit(`${ep} = getelementptr i64, ptr ${items}, i32 ${i}`);
    const ev = fresh();
    emit(`${ev} = load i64, ptr ${ep}`);
    incoming.push([ev, arrHit]);
    emit(`br label %${join}`);
    // A string: its unit below 256 in range, the runtime's one string of it once made.
    block(notArr);
    const strL = freshLabel("getstr");
    const notStr = freshLabel("getnotstr");
    const isStr = fresh();
    emit(`${isStr} = icmp eq i64 ${tag}, 65530`);
    emit(`br i1 ${isStr}, label %${strL}, label %${notStr}`);
    block(strL);
    if (!m.globals.includes("@yk_units = external global [256 x i64]"))
      m.globals.push("@yk_units = external global [256 x i64]");
    const sp = unboxPtr(obj);
    const slen = fresh();
    emit(`${slen} = load i32, ptr ${sp}`);
    // A rope's length word has its top bit set (not flat: the runtime's).
    const flatS = fresh();
    emit(`${flatS} = icmp sgt i32 ${slen}, -1`);
    const inS0 = fresh();
    emit(`${inS0} = icmp ult i32 ${i}, ${slen}`);
    const inS = fresh();
    emit(`${inS} = and i1 ${flatS}, ${inS0}`);
    const strIn = freshLabel("getstrin");
    emit(`br i1 ${inS}, label %${strIn}, label %${slowL}`);
    block(strIn);
    const unitsP = fresh();
    emit(`${unitsP} = getelementptr i8, ptr ${sp}, i32 8`);
    const up = fresh();
    emit(`${up} = getelementptr i16, ptr ${unitsP}, i32 ${i}`);
    const u = fresh();
    emit(`${u} = load i16, ptr ${up}`);
    const small = fresh();
    emit(`${small} = icmp ult i16 ${u}, 256`);
    const strSmall = freshLabel("getstrsmall");
    emit(`br i1 ${small}, label %${strSmall}, label %${slowL}`);
    block(strSmall);
    const ui = fresh();
    emit(`${ui} = zext i16 ${u} to i32`);
    const tp = fresh();
    emit(`${tp} = getelementptr [256 x i64], ptr @yk_units, i32 0, i32 ${ui}`);
    const sv0 = fresh();
    emit(`${sv0} = load i64, ptr ${tp}`);
    const made = fresh();
    emit(`${made} = icmp ne i64 ${sv0}, 0`);
    const strHit = freshLabel("getstrhit");
    emit(`br i1 ${made}, label %${strHit}, label %${slowL}`);
    block(strHit);
    incoming.push([sv0, strHit]);
    emit(`br label %${join}`);
    // A typed array (an object of kind 7): a Uint32Array's or Uint8Array's element in range.
    block(notStr);
    const isObj = fresh();
    emit(`${isObj} = icmp eq i64 ${tag}, 65532`);
    emit(`br i1 ${isObj}, label %${objL}, label %${slowL}`);
    block(objL);
    const op = unboxPtr(obj);
    const kindP = fresh();
    emit(`${kindP} = getelementptr %yk.object, ptr ${op}, i32 0, i32 5`);
    const kind = fresh();
    emit(`${kind} = load i32, ptr ${kindP}`);
    const isTyped = fresh();
    emit(`${isTyped} = icmp eq i32 ${kind}, 7`);
    const typedL = freshLabel("gettyped");
    emit(`br i1 ${isTyped}, label %${typedL}, label %${slowL}`);
    block(typedL);
    const extP = fresh();
    emit(`${extP} = getelementptr %yk.object, ptr ${op}, i32 0, i32 9`);
    const view = fresh();
    emit(`${view} = load ptr, ptr ${extP}`);
    const vlenP = fresh();
    emit(`${vlenP} = getelementptr %yk.view, ptr ${view}, i32 0, i32 2`);
    const vlen = fresh();
    emit(`${vlen} = load i32, ptr ${vlenP}`);
    const inV = fresh();
    emit(`${inV} = icmp ult i32 ${i}, ${vlen}`);
    const vtypeP = fresh();
    emit(`${vtypeP} = getelementptr %yk.view, ptr ${view}, i32 0, i32 3`);
    const vtype = fresh();
    emit(`${vtype} = load i32, ptr ${vtypeP}`);
    const inTL = freshLabel("getview");
    emit(`br i1 ${inV}, label %${inTL}, label %${slowL}`);
    block(inTL);
    const bufP = fresh();
    emit(`${bufP} = getelementptr %yk.view, ptr ${view}, i32 0, i32 0`);
    const buf = fresh();
    emit(`${buf} = load i64, ptr ${bufP}`);
    const bo = unboxPtr(buf);
    const bextP = fresh();
    emit(`${bextP} = getelementptr %yk.object, ptr ${bo}, i32 0, i32 9`);
    const bext = fresh();
    emit(`${bext} = load ptr, ptr ${bextP}`);
    const dataP = fresh();
    emit(`${dataP} = getelementptr %yk.buffer, ptr ${bext}, i32 0, i32 1`);
    const data = fresh();
    emit(`${data} = load ptr, ptr ${dataP}`);
    const offP = fresh();
    emit(`${offP} = getelementptr %yk.view, ptr ${view}, i32 0, i32 1`);
    const off = fresh();
    emit(`${off} = load i32, ptr ${offP}`);
    const base = fresh();
    emit(`${base} = getelementptr i8, ptr ${data}, i32 ${off}`);
    const u32L = freshLabel("getu32");
    const u8L = freshLabel("getu8");
    const notU32 = freshLabel("getnotu32");
    const isU32 = fresh();
    emit(`${isU32} = icmp eq i32 ${vtype}, 6`);
    emit(`br i1 ${isU32}, label %${u32L}, label %${notU32}`);
    block(u32L);
    const p32 = fresh();
    emit(`${p32} = getelementptr i32, ptr ${base}, i32 ${i}`);
    const x32 = fresh();
    emit(`${x32} = load i32, ptr ${p32}, align 1`);
    const f32 = fresh();
    emit(`${f32} = uitofp i32 ${x32} to double`);
    const b32 = fresh();
    emit(`${b32} = bitcast double ${f32} to i64`);
    incoming.push([b32, u32L]);
    emit(`br label %${join}`);
    block(notU32);
    const isU8 = fresh();
    emit(`${isU8} = icmp eq i32 ${vtype}, 1`);
    emit(`br i1 ${isU8}, label %${u8L}, label %${slowL}`);
    block(u8L);
    const p8 = fresh();
    emit(`${p8} = getelementptr i8, ptr ${base}, i32 ${i}`);
    const x8 = fresh();
    emit(`${x8} = load i8, ptr ${p8}`);
    const f8 = fresh();
    emit(`${f8} = uitofp i8 ${x8} to double`);
    const b8 = fresh();
    emit(`${b8} = bitcast double ${f8} to i64`);
    incoming.push([b8, u8L]);
    emit(`br label %${join}`);
    block(slowL);
    const sv = call("yk_get", `i64 ${obj}, i64 ${key}`);
    incoming.push([sv, currentLabel()]);
    emit(`br label %${join}`);
    block(join);
    const r = fresh();
    emit(`${r} = phi i64 ${incoming.map(([v, l]) => `[ ${v}, %${l} ]`).join(", ")}`);
    return r;
  };
  /** Hot code's x.length: a string's or an array's, read here; else yk_get's. */
  const lengthRead = (obj: string, key: string): string => {
    const tag = fresh();
    emit(`${tag} = lshr i64 ${obj}, 48`);
    const isS = fresh();
    emit(`${isS} = icmp eq i64 ${tag}, 65530`);
    const isA = fresh();
    emit(`${isA} = icmp eq i64 ${tag}, 65531`);
    const either = fresh();
    emit(`${either} = or i1 ${isS}, ${isA}`);
    const fastL = freshLabel("lenfast");
    const slowL = freshLabel("lenslow");
    const join = freshLabel("len");
    emit(`br i1 ${either}, label %${fastL}, label %${slowL}`);
    block(fastL);
    const p = unboxPtr(obj);
    const n0 = fresh();
    emit(`${n0} = load i32, ptr ${p}`);
    // A string's length: a rope's with its top bit cleared.
    const masked = fresh();
    emit(`${masked} = and i32 ${n0}, 2147483647`);
    const n = fresh();
    emit(`${n} = select i1 ${isS}, i32 ${masked}, i32 ${n0}`);
    const f = fresh();
    emit(`${f} = uitofp i32 ${n} to double`);
    const b = fresh();
    emit(`${b} = bitcast double ${f} to i64`);
    emit(`br label %${join}`);
    block(slowL);
    const sv = call("yk_get", `i64 ${obj}, i64 ${key}`);
    const slowEnd = currentLabel();
    emit(`br label %${join}`);
    block(join);
    const r = fresh();
    emit(`${r} = phi i64 [ ${b}, %${fastL} ], [ ${sv}, %${slowEnd} ]`);
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
      "async function*": [1, 3],
    };
    const shape = MODES[lbl];
    if (shape === undefined)
      throw new LlvmEmitError(`a "${lbl}" function is not in the subset yet`);
    const [hasThis, mode] = shape;
    const fn = m.closureName(name);
    // Inside a module, a closure's free names are its captures; it keeps the module's platform rule.
    // A capture of a module binding is the binding itself: the closure reads and writes the
    // module's (a later write is seen; its own writes are the module's).
    const moduleCaptures =
      scope === undefined ? undefined : n.inputs.map((v) => freeValue.get(resolve(v as ValueId)));
    const inner: ModuleScope | undefined =
      scope === undefined
        ? undefined
        : moduleCaptures?.some((c) => c !== undefined)
          ? {
              read: scope.read,
              write: scope.write,
              ...(scope.direct !== undefined ? { direct: scope.direct } : {}),
              // What a direct callee takes and gives, so a call in a closure (a class's method)
              // reaches its number, integer and record variants as a function's does (#1370).
              ...(scope.arity !== undefined ? { arity: scope.arity } : {}),
              ...(scope.ranges !== undefined ? { ranges: scope.ranges } : {}),
              ...(scope.record !== undefined ? { record: scope.record } : {}),
            }
          : {
              // The module's require (a global of the module's own) for an import() in it.
              read: (nm, e, f) => (nm === "require" ? scope.read(nm, e, f) : undefined),
              write: () => false,
            };
    lowerFunction(m, graph, fn, { captures: n.inputs.length, moduleCaptures }, inner);
    const caps = n.inputs.map(operand);
    m.used.add("yk_closure_new");
    const r = fresh();
    emit(
      `${r} = call i64 @yk_closure_new(ptr @${fn}, i32 ${hasThis}, i64 ${caps.length}, ptr ${list(caps)})`,
    );
    // Its name (the lifter's: a declaration's, or the binding an anonymous function is assigned to)
    // and its length (the parameters before a rest one).
    // A named function expression's own name; else the name the lifter gave it (its binding).
    const text = n.origin?.text ?? "";
    const ownName =
      /^(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/.exec(text)?.[1] ?? text;
    const params = graph.nodes.filter(
      (p) => p.kind === "param-source" && Number(p.label ?? "0") >= n.inputs.length,
    );
    const rest = params.findIndex((p) => (p.label ?? "").endsWith("..."));
    const length = Math.min(
      rest < 0 ? params.length : rest,
      expectedArgumentCount(text) ?? Number.POSITIVE_INFINITY,
    );
    m.intrinsics.add("declare i64 @yk_closure_meta(i64, ptr, i64, i64)");
    if (ownName !== undefined && /^[A-Za-z_$][\w$]*$/.test(ownName)) {
      // The name as the module's one string of it (made once, not at each closure made).
      m.intrinsics.add("declare i64 @yk_closure_meta_key(i64, i64, i64)");
      emit(`call i64 @yk_closure_meta_key(i64 ${r}, i64 ${keyOf(ownName)}, i64 ${length})`);
    } else if (length > 0)
      emit(`call i64 @yk_closure_meta(i64 ${r}, ptr null, i64 0, i64 ${length})`);
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
      if (leaf === "__ykLoad64") {
        // From a block whose address never escapes: its bytes, unsigned.
        const local = localAccess(ins[1] as ValueId, 8);
        if (local !== undefined) {
          const q = fresh();
          blockBound(local, 8);
          emit(`${q} = getelementptr i8, ptr ${local.slot}, i64 ${local.off}`);
          const v = fresh();
          emit(`${v} = load i64, ptr ${q}, align 1`);
          emit(`${r} = zext i64 ${v} to i128`);
          return r;
        }
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
    emitting = n;
    if (builderAppends.has(n)) {
      // An append to a loop's string builder: in place; its value is the builder still.
      const h = operand(ins[0] as ValueId);
      m.intrinsics.add("declare i64 @yk_sb_append(i64, i64)");
      const r = fresh();
      emit(`${r} = call i64 @yk_sb_append(i64 ${h}, i64 ${operand(ins[1] as ValueId)})`);
      set(out, r);
      return;
    }
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
    if (lbl === "import()" && ins.length >= 1) {
      // import(spec): the module's require, in a job: a promise of its namespace or exports.
      const req = scope?.read("require", emit, fresh);
      if (req === undefined) throw new LlvmEmitError("import() outside a module");
      m.intrinsics.add("declare i64 @yk_import(i64, i64)");
      const r = fresh();
      emit(`${r} = call i64 @yk_import(i64 ${req}, i64 ${operand(ins[0] as ValueId)})`);
      set(out, r);
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
    if (lbl.startsWith("array-with-holes:")) {
      // [, a, , b]: the elements at their positions, each hole an index the array does not have.
      const holes = JSON.parse(lbl.slice("array-with-holes:".length)) as number[];
      if (ins.some(isSpread))
        throw new LlvmEmitError(
          "an array with both holes and spread elements is not in the subset yet",
        );
      const elems: string[] = [];
      let k = 0;
      for (let i = 0; i < ins.length + holes.length; i++)
        elems.push(holes.includes(i) ? UNDEFINED : operand(ins[k++] as ValueId));
      const made = call("yk_array_of", `i64 ${elems.length}, ptr ${list(elems)}`);
      for (const h of holes) call("yk_array_hole", `i64 ${made}, i64 ${h}`);
      set(out, made);
      return;
    }
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
      // An inline try's result: already its block's completion (no job).
      if (inlineTries.has(resolve(ins[0] as ValueId))) {
        set(out, operand(ins[0] as ValueId));
        return;
      }
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
      if (ins.some(isSpread)) {
        m.intrinsics.add("declare i64 @yk_super_construct_spread(ptr, i64, i64)");
        const r = fresh();
        emit(
          `${r} = call i64 @yk_super_construct_spread(ptr %closure, i64 %this, i64 ${spreadList(ins)})`,
        );
        set(out, r);
        return;
      }
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
      const made = call(
        "yk_class_new",
        `ptr ${closure === undefined ? "null" : "%closure"}, i64 ${parent}, i64 ${members.length}, ptr ${list(kinds)}, ptr ${list(names)}, ptr ${list(statics)}, ptr ${list(fns)}`,
      );
      // The class's name (its declaration's, or its binding's), as the lifter records it.
      const className = n.origin?.text ?? "";
      if (/^[A-Za-z_$][\w$]*$/.test(className)) {
        m.intrinsics.add("declare i64 @yk_class_name(i64, ptr, i64)");
        const k = m.constant(className);
        emit(`call i64 @yk_class_name(i64 ${made}, ptr ${k.ptr}, i64 ${k.length})`);
      }
      set(out, made);
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
    // A statement's result: stored by the statement's end.
    if (lbl.startsWith(DECLARES) || lbl.startsWith(COMPLETES)) return;
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
      // A number's: the double's sum, inline; anything else the runtime's (ToNumeric).
      const a = operand(ins[0] as ValueId);
      const inc = lbl.endsWith("++");
      set(
        out,
        numberFast(
          [a],
          ([d]) => {
            const r = fresh();
            emit(`${r} = fadd double ${d}, ${inc ? "1.0" : "-1.0"}`);
            return boxDouble(r);
          },
          () => call(inc ? "yk_inc" : "yk_dec", `i64 ${a}`),
          undefined,
          allNumbers([ins[0] as ValueId]),
        ),
      );
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
    // Math.name only called (the call names it): nothing; read as a value (`const floor =
    // Math.floor`), the runtime's Math's member.
    if (member && isMath(ins[0] as ValueId)) {
      if (!mathCalleeReads.has(out)) set(out, mathFunctionValue(m, lbl.slice(1), fresh, emit));
      return;
    }
    const fromRecord = member ? recordReads.get(out) : undefined;
    if (fromRecord !== undefined) {
      // A record result's key: its slot, which the call filled.
      const p = fresh();
      emit(`${p} = getelementptr i64, ptr ${fromRecord.slot}, i64 ${fromRecord.idx}`);
      const r = fresh();
      emit(`${r} = load i64, ptr ${p}`);
      set(out, r);
      return;
    }
    // Read only to be called: the call reads it (a method call by its key; else operand, there).
    if (member && calleeReads.has(out)) return;
    if (member) {
      const obj = operand(ins[0] as ValueId);
      const key = keyOf(lbl.slice(1));
      set(
        out,
        lbl === ".length" && (!compact || inLoop(n))
          ? lengthRead(obj, key)
          : lbl === ".length"
            ? call("yk_get", `i64 ${obj}, i64 ${key}`)
            : getNamed(obj, key),
      );
      return;
    }
    if (/^\.[\w$]+=$/.test(lbl) && ins.length === 2) {
      const obj = operand(ins[0] as ValueId);
      const value = operand(ins[1] as ValueId);
      // With its site's cache, as a named read has (#1370).
      const site = `@yk.ic.${m.icSites++}`;
      m.globals.push(`${site} = internal global i32 0`);
      m.intrinsics.add("declare i64 @yk_set_ic(i64, i64, i64, ptr)");
      const r = fresh();
      emit(
        `${r} = call i64 @yk_set_ic(i64 ${obj}, i64 ${keyOf(lbl.slice(1, -1))}, i64 ${value}, ptr ${site})`,
      );
      set(out, r);
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
      const o = operand(ins[0] as ValueId);
      const k = operand(ins[1] as ValueId);
      set(out, !compact || inLoop(n) ? indexRead(o, k) : call("yk_get", `i64 ${o}, i64 ${k}`));
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
    if (lbl.startsWith("ObjectRest:") && ins.length === 1) {
      // {a, b, ...rest} = o: o's own enumerable properties but those taken (#1330).
      const taken = JSON.parse(lbl.slice("ObjectRest:".length)) as string[];
      m.intrinsics.add("declare i64 @yk_object_rest(i64, i64, ptr)");
      const r = fresh();
      emit(
        `${r} = call i64 @yk_object_rest(i64 ${operand(ins[0] as ValueId)}, i64 ${taken.length}, ptr ${list(taken.map(str))})`,
      );
      set(out, r);
      return;
    }
    if (lbl.startsWith("tagged:") && ins.length >= 1) {
      // A tagged template (ECMA-262 13.2.8.4): the site's template object, made once (its cooked
      // strings, undefined where an escape is invalid, and their raw text as `raw`); then the tag
      // called with it and the substitutions, a member's object its receiver.
      const parts = JSON.parse(lbl.slice("tagged:".length)) as [string | null, string][];
      const memo = `@ytmpl${m.globals.length}`;
      m.globals.push(`${memo} = internal global i64 0`);
      const known = fresh();
      emit(`${known} = load i64, ptr ${memo}`);
      const has = fresh();
      emit(`${has} = icmp ne i64 ${known}, 0`);
      const first = freshLabel("tfirst");
      const join = freshLabel("tjoin");
      const before = currentLabel();
      emit(`br i1 ${has}, label %${join}, label %${first}`);
      block(first);
      const cooked = call(
        "yk_array_of",
        `i64 ${parts.length}, ptr ${list(parts.map(([c]) => (c === null ? UNDEFINED : str(c))))}`,
      );
      const raw = call(
        "yk_array_of",
        `i64 ${parts.length}, ptr ${list(parts.map(([, r]) => str(r)))}`,
      );
      call("yk_set", `i64 ${cooked}, i64 ${str("raw")}, i64 ${raw}`);
      emit(`store i64 ${cooked}, ptr ${memo}`);
      const firstEnd = currentLabel();
      emit(`br label %${join}`);
      block(join);
      const tmpl = fresh();
      emit(`${tmpl} = phi i64 [ ${known}, %${before} ], [ ${cooked}, %${firstEnd} ]`);
      const member = memberOf(ins[0] as ValueId);
      const recv = member !== undefined ? operand(member.node.inputs[0] as ValueId) : UNDEFINED;
      const args = [tmpl, ...ins.slice(1).map((v) => operand(v as ValueId))];
      set(
        out,
        call(
          "yk_call",
          `i64 ${operand(ins[0] as ValueId)}, i64 ${recv}, i64 ${args.length}, ptr ${list(args)}`,
        ),
      );
      return;
    }
    if (lbl === "NewExpression") {
      // new RegExp(pattern, flags) of constant strings: compiled as its literal would be.
      if (
        globalValue.get(resolve(ins[0] as ValueId)) === "RegExp" &&
        (ins.length === 2 || ins.length === 3) &&
        !ins.some(isSpread)
      ) {
        const pattern = constantString(ins[1] as ValueId);
        const flags = ins.length === 3 ? constantString(ins[2] as ValueId) : "";
        if (
          pattern !== undefined &&
          flags !== undefined &&
          /^[dgimsuy]*$/.test(flags) &&
          pattern !== ""
        ) {
          set(out, regexObject(`/${pattern}/${flags}`));
          return;
        }
      }
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
      if (leafName === "__ykAlloc" && lazyFrames.has(out as ValueId)) {
        set(out, "0"); // not yet allocated
        return;
      }
      if (leafName === "__ykFree" && lazyFrames.has(resolve(ins[1] as ValueId))) {
        m.intrinsics.add("declare void @yk_frame_free(i64)");
        const bits = fresh();
        emit(`${bits} = load i64, ptr ${slotOf(resolve(ins[1] as ValueId))}`);
        const some = fresh();
        emit(`${some} = icmp ne i64 ${bits}, 0`);
        const freeL = freshLabel("lazyfree");
        const after = freshLabel("lazyfreed");
        emit(`br i1 ${some}, label %${freeL}, label %${after}`);
        block(freeL);
        emit(`call void @yk_frame_free(i64 ${bits})`);
        emit(`br label %${after}`);
        block(after);
        set(out, UNDEFINED);
        return;
      }
      if (leafName === "__ykAlloc" && localBlocks.has(out as ValueId)) {
        // A block whose address never escapes: zeroed, as an allocation's bytes are.
        const b = localBlocks.get(out as ValueId) as { slot: string; size: number };
        m.intrinsics.add("declare void @llvm.memset.p0.i64(ptr, i8, i64, i1)");
        emit(`call void @llvm.memset.p0.i64(ptr ${b.slot}, i8 0, i64 ${b.size}, i1 false)`);
        set(out, boxedNumber(0));
        return;
      }
      if (leafName === "__ykFree" && localBlocks.has(resolve(ins[1] as ValueId))) {
        set(out, UNDEFINED);
        return;
      }
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
      if (leafName === "__ykStore64") {
        const local64 = localAccess(ins[1] as ValueId, 8);
        if (local64 !== undefined) {
          // Into a block whose address never escapes: the value's low 64 bits.
          const q = fresh();
          blockBound(local64, 8);
          emit(`${q} = getelementptr i8, ptr ${local64.slot}, i64 ${local64.off}`);
          let bits: string;
          if (isTypedBig(ins[2] as ValueId)) {
            bits = fresh();
            emit(`${bits} = trunc i128 ${bigOperand(ins[2] as ValueId)} to i64`);
          } else {
            m.intrinsics.add("declare i64 @yk_big_low64(i64)");
            bits = fresh();
            emit(`${bits} = call i64 @yk_big_low64(i64 ${operand(ins[2] as ValueId)})`);
          }
          emit(`store i64 ${bits}, ptr ${q}, align 1`);
          // Its value (the stored BigInt), boxed only when something reads it rather than ordering
          // after it.
          set(out, valueRead(out as ValueId) ? operand(ins[2] as ValueId) : UNDEFINED);
          return;
        }
      }
      const args = ins.slice(1).map(operand);
      if (leafName === "__ykI32Mul") {
        set(out, imul(args[0] as string, args[1] as string, ins[1] as ValueId, ins[2] as ValueId));
        return;
      }
      const mem = MEM_INLINE[leafName];
      const local = mem === undefined ? undefined : localAccess(ins[1] as ValueId, mem.size);
      if (mem !== undefined && local !== undefined) {
        // Inside a block whose address never escapes: the bytes themselves.
        const q = fresh();
        blockBound(local, mem.size);
        emit(`${q} = getelementptr i8, ptr ${local.slot}, i64 ${local.off}`);
        if (mem.store) {
          // A raw argument's store may be of any value: its number first (a local block's is one).
          const num = allNumbers([ins[2] as ValueId])
            ? (args[1] as string)
            : call(UNARY["+"] as string, `i64 ${args[1]}`);
          const xd = fresh();
          emit(`${xd} = bitcast i64 ${num} to double`);
          if (mem.kind === "u") {
            const w = fresh();
            if (boundedInt64(ins[2] as ValueId)) {
              // Below 2^63 in magnitude: its int64's low bits.
              const w64 = fresh();
              emit(`${w64} = fptosi double ${xd} to i64`);
              emit(`${w} = trunc i64 ${w64} to i32`);
            } else {
              m.intrinsics.add("declare i32 @yk_double_to_uint32(double)");
              emit(`${w} = call i32 @yk_double_to_uint32(double ${xd})`);
            }
            let t = w;
            if (mem.ty !== "i32") {
              t = fresh();
              emit(`${t} = trunc i32 ${w} to ${mem.ty}`);
            }
            emit(`store ${mem.ty} ${t}, ptr ${q}, align 1`);
          } else if (mem.kind === "f64") emit(`store double ${xd}, ptr ${q}, align 1`);
          else {
            const f = fresh();
            emit(`${f} = fptrunc double ${xd} to float`);
            emit(`store float ${f}, ptr ${q}, align 1`);
          }
          set(out, num);
        } else {
          const v = fresh();
          emit(`${v} = load ${mem.ty}, ptr ${q}, align 1`);
          if (mem.kind === "u") {
            const z = fresh();
            emit(`${z} = zext ${mem.ty} ${v} to i64`);
            const f = fresh();
            emit(`${f} = uitofp i64 ${z} to double`);
            const r = fresh();
            emit(`${r} = bitcast double ${f} to i64`);
            set(out, r);
          } else if (mem.kind === "f64") set(out, numberResult(out, v));
          else {
            const f = fresh();
            emit(`${f} = fpext float ${v} to double`);
            set(out, numberResult(out, f));
          }
        }
        return;
      }
      if (mem !== undefined) {
        // A raw double stored (rawNumbers): the runtime's call takes it canonical.
        const rawValue = mem.store && rawNumbers.has(resolve(ins[2] as ValueId));
        set(
          out,
          memoryAccess(
            mem,
            args,
            () =>
              rawValue
                ? call(fn, `i64 ${args[0]}, i64 ${canonicalBits(args[1] as string)}`)
                : call(fn, args.map((a) => `i64 ${a}`).join(", ")),
            ins.slice(1).map((v) => allNumbers([v as ValueId])),
            frameAccess(ins[1] as ValueId, mem.size),
            !mem.store && rawNumbers.has(resolve(out as ValueId)),
            mem.store && mem.kind === "u" && boundedInt64(ins[2] as ValueId),
            naturalInt(ins[1] as ValueId),
            naturalInt(ins[1] as ValueId) && intKnown(ins[1] as ValueId)
              ? intOperand(ins[1] as ValueId)
              : undefined,
          ),
        );
        if (loadInt !== undefined && numRange.has(resolve(out as ValueId)))
          setInt(out as ValueId, loadInt);
        return;
      }
      set(out, call(fn, args.map((a) => `i64 ${a}`).join(", ")));
      return;
    }
    if (lbl === "CallExpression" && inlineTries.has(out)) {
      const args = ins.slice(1).map(operand);
      m.intrinsics.add("declare i64 @yk_try_async_now(i64, ptr)");
      const r = fresh();
      emit(`${r} = call i64 @yk_try_async_now(i64 ${args.length}, ptr ${list(args)})`);
      set(out, r);
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
        if (callee.name === "random") {
          // An implementation-chosen pseudo-random number in [0, 1) (21.3.2.27): the runtime's.
          // Arguments are evaluated (as operands, above) and ignored, as the function's are.
          m.intrinsics.add("declare i64 @yk_math_random()");
          const r = fresh();
          emit(`${r} = call i64 @yk_math_random()`);
          set(out, r);
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
        if (callee.name === "imul") {
          set(
            out,
            imul(
              args[0] ?? UNDEFINED,
              args[1] ?? UNDEFINED,
              ins[1] as ValueId | undefined,
              ins[2] as ValueId | undefined,
            ),
          );
          return;
        }
        const ref = mathOperation(callee.name, args.length);
        if (ref !== undefined) {
          // A reference to the atom implementing it: ToNumber of each argument, then the atom.
          const nums = args.map((a) => call("yk_pos", `i64 ${a}`));
          const fn = atomFunction(m, ref.atom);
          const r = fresh();
          emit(
            `${r} = call i64 @${fn}(ptr null, i64 ${UNDEFINED}, i64 ${nums.length}, ptr ${list(nums)})`,
          );
          set(out, r);
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
        const recv = operand(callee.node.inputs[0] as ValueId);
        const key = keyOf(callee.name);
        if (callee.name === "charCodeAt" && args.length === 1) {
          // A string's unit, without the method's lookup (#1369); in hot code, at an integer
          // index in range, read here.
          m.intrinsics.add("declare i64 @yk_char_code_at(i64, i64, i64)");
          const slow = (): string => {
            const r = fresh();
            emit(`${r} = call i64 @yk_char_code_at(i64 ${recv}, i64 ${key}, i64 ${args[0]})`);
            return r;
          };
          if (compact && !inLoop(n)) {
            set(out, slow());
            return;
          }
          const idx = args[0] as string;
          const slowL = freshLabel("ccslow");
          const join = freshLabel("cc");
          const tag = fresh();
          emit(`${tag} = lshr i64 ${recv}, 48`);
          const isS = fresh();
          emit(`${isS} = icmp eq i64 ${tag}, 65530`);
          const isN = fresh();
          emit(`${isN} = icmp ult i64 ${idx}, ${NUMBER_LIMIT}`);
          const both = fresh();
          emit(`${both} = and i1 ${isS}, ${isN}`);
          const l1 = freshLabel("ccstr");
          emit(`br i1 ${both}, label %${l1}, label %${slowL}`);
          block(l1);
          const d = fresh();
          emit(`${d} = bitcast i64 ${idx} to double`);
          const lo = fresh();
          emit(`${lo} = fcmp oge double ${d}, 0.0`);
          const hi = fresh();
          emit(`${hi} = fcmp olt double ${d}, 4294967296.0`);
          const inR = fresh();
          emit(`${inR} = and i1 ${lo}, ${hi}`);
          const l2 = freshLabel("ccrange");
          emit(`br i1 ${inR}, label %${l2}, label %${slowL}`);
          block(l2);
          const i = fresh();
          emit(`${i} = fptoui double ${d} to i32`);
          const back = fresh();
          emit(`${back} = uitofp i32 ${i} to double`);
          const whole = fresh();
          emit(`${whole} = fcmp oeq double ${back}, ${d}`);
          const sp = unboxPtr(recv);
          const len = fresh();
          emit(`${len} = load i32, ptr ${sp}`);
          // A rope (its length word's top bit set): the runtime's.
          const flat = fresh();
          emit(`${flat} = icmp sgt i32 ${len}, -1`);
          const inL0 = fresh();
          emit(`${inL0} = icmp ult i32 ${i}, ${len}`);
          const inL = fresh();
          emit(`${inL} = and i1 ${flat}, ${inL0}`);
          const ok = fresh();
          emit(`${ok} = and i1 ${whole}, ${inL}`);
          const l3 = freshLabel("cchit");
          emit(`br i1 ${ok}, label %${l3}, label %${slowL}`);
          block(l3);
          const units = fresh();
          emit(`${units} = getelementptr i8, ptr ${sp}, i32 8`);
          const up = fresh();
          emit(`${up} = getelementptr i16, ptr ${units}, i32 ${i}`);
          const u = fresh();
          emit(`${u} = load i16, ptr ${up}`);
          const f = fresh();
          emit(`${f} = uitofp i16 ${u} to double`);
          const b = fresh();
          emit(`${b} = bitcast double ${f} to i64`);
          emit(`br label %${join}`);
          block(slowL);
          const sv = slow();
          const slowEnd = currentLabel();
          emit(`br label %${join}`);
          block(join);
          const r = fresh();
          emit(`${r} = phi i64 [ ${b}, %${l3} ], [ ${sv}, %${slowEnd} ]`);
          set(out, r);
          return;
        }
        // With its site's cache: the index of a plain object's own method last called here.
        const site = `@yk.ic.${m.icSites++}`;
        m.globals.push(`${site} = internal global i32 0`);
        m.intrinsics.add("declare i64 @yk_call_method_ic(i64, i64, ptr, i64, ptr)");
        const r = fresh();
        emit(
          `${r} = call i64 @yk_call_method_ic(i64 ${recv}, i64 ${key}, ptr ${site}, i64 ${args.length}, ptr ${list(args)})`,
        );
        set(out, r);
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
        // Blocks passed where the callee takes raw arguments: its `.raw` variant, their bytes and
        // lengths (#1369).
        const blocks = rawCallBlocks(n, (x) => localBlocks.has(x));
        if (blocks === undefined && ins.slice(1).some((x) => rawBlocks.has(resolve(x))))
          throw new LlvmEmitError(
            `a raw block argument passed to ${calleeName} with an argument it takes raw not a block`,
          );
        const rawPass =
          blocks === undefined
            ? ""
            : blocks
                .map((b) => {
                  const r = rawBlocks.get(b);
                  if (r !== undefined) return `, ptr ${r.slot}, i64 ${r.len}`;
                  const l = localBlocks.get(b) as { slot: string; size: number };
                  return `, ptr ${l.slot}, i64 ${l.size}`;
                })
                .join("");
        // Every argument a number (but a raw block's, which a clone never speculates on), and every
        // parameter given: the callee's number clone, directly (a thunk to it when it has none).
        const target = `${direct}${blocks === undefined ? "" : ".raw"}`;
        const arity = scope?.arity?.(calleeName as string);
        const numbers =
          arity !== undefined &&
          args.length >= arity &&
          ins.slice(1).every((x) => (blocks ?? []).includes(resolve(x)) || allNumbers([x]));
        if (numbers)
          m.numCalled.set(`${target}.num`, {
            of: target,
            rawBlocks: blocks?.length ?? 0,
            regs: (arity as number) - (blocks?.length ?? 0),
          });
        const rawAt = blocks === undefined ? undefined : scope?.rawArgs?.(calleeName as string);
        const regPass = numbers
          ? Array.from({ length: arity as number }, (_, k) => k)
              .filter((k) => rawAt?.has(k) !== true)
              .map((k) => `, i64 ${args[k]}`)
              .join("")
          : "";
        const rec = recordCalls.get(out);
        if (rec !== undefined && numbers) {
          m.numCalled.set(`${target}.rec.num`, {
            of: `${target}.rec`,
            rawBlocks: 0,
            regs: arity as number,
            rec: true,
          });
        }
        let callee = `${target}${rec !== undefined ? ".rec" : ""}${numbers ? ".num" : ""}`;
        const boxedCall =
          !numbers &&
          blocks === undefined &&
          arity !== undefined &&
          args.length >= arity &&
          !ins.slice(1).some(isSpread);
        if (numbers || boxedCall) {
          // Arguments of known integer ranges: a thunk the module resolves to the callee's `.int`
          // clone when it takes them in those ranges, else to its `.num` clone (#1369).
          const ranges = Array.from({ length: arity as number }, (_, k) => {
            const v = ins[k + 1] as ValueId | undefined;
            if (v === undefined) return undefined;
            const r = numRange.get(resolve(v));
            if (r !== undefined) return r;
            const x = literalNumber(v);
            return x !== undefined && Number.isInteger(x) && !Object.is(x, -0)
              ? x >= -(2 ** 31) && x < 2 ** 31
                ? x >= 0
                  ? ("both" as const)
                  : ("i32" as const)
                : x >= 0 && x < 2 ** 32
                  ? ("u32" as const)
                  : undefined
              : undefined;
          });
          if (ranges.some((r) => r !== undefined)) {
            const code = ranges.map((r) => (r === undefined ? "x" : r[0])).join("");
            const of = numbers ? callee : `${callee}.num`;
            const thunk = `${of}.${numbers ? "r" : "b"}${code}`;
            m.intCalled.set(thunk, {
              of,
              ranges,
              rawBlocks: blocks?.length ?? 0,
              regs: (arity as number) - (blocks?.length ?? 0),
              rec: rec !== undefined,
              ...(numbers ? {} : { boxed: callee }),
            });
            callee = thunk;
          }
        }
        // In a loop, arguments not proven numbers but numbers when it runs: the number clone too,
        // tested for at the call (#1370: a hash's rotate called with the words it reads).
        const speculate =
          boxedCall &&
          blocks === undefined &&
          rec === undefined &&
          callee === target &&
          args.length === arity &&
          (arity as number) > 0 &&
          inLoop(n);
        let specEnd: string | undefined;
        let specR: string | undefined;
        if (speculate) {
          m.numCalled.set(`${target}.num`, { of: target, rawBlocks: 0, regs: arity as number });
          let all = "";
          for (const a of args) {
            const c = fresh();
            emit(`${c} = icmp ult i64 ${a}, ${NUMBER_LIMIT}`);
            if (all === "") all = c;
            else {
              const both = fresh();
              emit(`${both} = and i1 ${all}, ${c}`);
              all = both;
            }
          }
          const specL = freshLabel("specnum");
          const genL = freshLabel("specgen");
          emit(`br i1 ${likely(all)}, label %${specL}, label %${genL}`);
          block(specL);
          specR = fresh();
          emit(
            `${specR} = call i64 @${target}.num(ptr ${ptr}, i64 ${superRecv}, i64 ${args.length}, ptr ${argv}${args.map((a) => `, i64 ${a}`).join("")})`,
          );
          specEnd = currentLabel();
          emit(`br label %${join}`);
          block(genL);
        }
        const r1 = fresh();
        emit(
          `${r1} = call i64 @${callee}(ptr ${ptr}, i64 ${superRecv}, i64 ${args.length}, ptr ${argv}${rawPass}${rec !== undefined ? `, ptr ${rec.slot}` : ""}${regPass})`,
        );
        const yesEnd = currentLabel();
        emit(`br label %${join}`);
        block(no);
        const r2 = call("yk_call", `i64 ${fn}, i64 ${superRecv}, i64 ${args.length}, ptr ${argv}`);
        if (rec !== undefined)
          // Not the function's own code: its result is an object, its keys' values the slots'.
          rec.keys.forEach((k, j) => {
            const p = fresh();
            emit(`${p} = getelementptr i64, ptr ${rec.slot}, i64 ${j}`);
            emit(`store i64 ${call("yk_get", `i64 ${r2}, i64 ${keyOf(k)}`)}, ptr ${p}`);
          });
        const noEnd = currentLabel();
        emit(`br label %${join}`);
        block(join);
        const r = fresh();
        emit(
          `${r} = phi i64 [ ${r1}, %${yesEnd} ], [ ${r2}, %${noEnd} ]${specEnd !== undefined ? `, [ ${specR}, %${specEnd} ]` : ""}`,
        );
        set(out, r);
        return;
      }
      set(
        out,
        call("yk_call", `i64 ${fn}, i64 ${superRecv}, i64 ${args.length}, ptr ${list(args)}`),
      );
      return;
    }
    if (ins.length === 2 && (lbl === "===" || lbl === "!==")) {
      // Against undefined, null, true or false (each one value): the bits compared.
      const single = (v: ValueId): string | undefined => {
        const p = producer.get(resolve(v));
        if (p?.kind !== "literal-source") return undefined;
        const t = p.label ?? "";
        return t === "undefined"
          ? UNDEFINED
          : t === "null"
            ? NULL
            : t === "true"
              ? TRUE
              : t === "false"
                ? FALSE
                : undefined;
      };
      const k = single(ins[1] as ValueId) ?? single(ins[0] as ValueId);
      if (k !== undefined) {
        const other = single(ins[1] as ValueId) !== undefined ? ins[0] : ins[1];
        const c = fresh();
        emit(`${c} = icmp ${lbl === "===" ? "eq" : "ne"} i64 ${operand(other as ValueId)}, ${k}`);
        set(out, boolBox(c));
        return;
      }
    }
    if (
      ins.length === 2 &&
      intKnown(ins[0] as ValueId) &&
      intKnown(ins[1] as ValueId) &&
      INT_DOMAIN.has(lbl)
    ) {
      const [a0, b0] = ins as [ValueId, ValueId];
      const nonNeg = (v: ValueId): boolean =>
        numRange.get(resolve(v)) === "u32" || (intLiteral(v) ?? -1) >= 0;
      const mag = magnitude(out);
      const ok =
        lbl === "+" || lbl === "-"
          ? mag !== undefined && mag < 2 ** 53
          : lbl === "%"
            ? nonNeg(a0) && (intLiteral(b0) ?? 0) > 0
            : true;
      if (ok) {
        // Two integers: their int64s (an int32's operations on their low 32 bits), the result's
        // int64 kept and its box made from it.
        const x = intOperand(a0);
        const y = intOperand(b0);
        const cmp = INT_COMPARE[lbl];
        if (cmp !== undefined) {
          const c = fresh();
          emit(`${c} = icmp ${cmp} i64 ${x}, ${y}`);
          set(out, boolBox(c));
          return;
        }
        let r: string;
        if (lbl === "+" || lbl === "-" || lbl === "%") {
          r = fresh();
          emit(`${r} = ${lbl === "+" ? "add" : lbl === "-" ? "sub" : "urem"} i64 ${x}, ${y}`);
        } else {
          const x32 = fresh();
          emit(`${x32} = trunc i64 ${x} to i32`);
          const y32 = fresh();
          emit(`${y32} = trunc i64 ${y} to i32`);
          let count = y32;
          if (lbl === "<<" || lbl === ">>" || lbl === ">>>") {
            count = fresh();
            emit(`${count} = and i32 ${y32}, 31`);
          }
          const op = {
            "|": "or",
            "&": "and",
            "^": "xor",
            "<<": "shl",
            ">>": "ashr",
            ">>>": "lshr",
          }[lbl] as string;
          const r32 = fresh();
          emit(`${r32} = ${op} i32 ${x32}, ${count}`);
          r = fresh();
          emit(`${r} = ${lbl === ">>>" ? "zext" : "sext"} i32 ${r32} to i64`);
        }
        setInt(out, r);
        set(out, intBox(r));
        return;
      }
    }
    if (ins.length === 2 && (lbl === ">>>" || lbl === "|")) {
      // x >>> 0 of a uint32, x | 0 of an int32 (numbers both): the value itself.
      const z = literalNumber(ins[1] as ValueId);
      if (
        z === 0 &&
        !Object.is(z, -0) &&
        numRange.get(resolve(ins[0] as ValueId)) === (lbl === ">>>" ? "u32" : "i32")
      ) {
        set(out, operand(ins[0] as ValueId));
        return;
      }
    }
    if (ins.length === 2 && BINARY[lbl] !== undefined) {
      const a = operand(ins[0] as ValueId);
      const b = operand(ins[1] as ValueId);
      const slow = (): string => call(BINARY[lbl] as string, `i64 ${a}, i64 ${b}`);
      const arith = FAST_ARITH[lbl];
      const compare = FAST_COMPARE[lbl];
      const bitwise = FAST_BITWISE[lbl];
      const nonNegInt = (v: ValueId): boolean => {
        if (numRange.get(resolve(v)) === "u32") return true;
        const x = literalNumber(v);
        return x !== undefined && Number.isInteger(x) && x >= 0 && x < 2 ** 32 && !Object.is(x, -0);
      };
      if (
        lbl === "%" &&
        nonNegInt(ins[0] as ValueId) &&
        nonNegInt(ins[1] as ValueId) &&
        allNumbers(ins as readonly ValueId[])
      ) {
        // Two non-negative integers below 2^32: an integer remainder (NaN by zero), not fmod. (Below
        // 2^32, the signed conversions are exact and the cheaper ones.)
        const x = fresh();
        emit(`${x} = bitcast i64 ${a} to double`);
        const y = fresh();
        emit(`${y} = bitcast i64 ${b} to double`);
        const xi = fresh();
        emit(`${xi} = fptosi double ${x} to i64`);
        const yi = fresh();
        emit(`${yi} = fptosi double ${y} to i64`);
        const zero = fresh();
        emit(`${zero} = icmp eq i64 ${yi}, 0`);
        const safe = fresh();
        emit(`${safe} = select i1 ${zero}, i64 1, i64 ${yi}`);
        const q = fresh();
        emit(`${q} = urem i64 ${xi}, ${safe}`);
        const d = fresh();
        emit(`${d} = sitofp i64 ${q} to double`);
        const bits = fresh();
        emit(`${bits} = bitcast double ${d} to i64`);
        const r = fresh();
        emit(`${r} = select i1 ${zero}, i64 ${CANONICAL_NAN}, i64 ${bits}`);
        set(out, r);
        return;
      }
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
        const unrangedA = !boundedInt64(ins[0] as ValueId);
        const unrangedB = !boundedInt64(ins[1] as ValueId);
        // A raw operand (rawNumbers) reaches the runtime's operation canonical.
        const canon = (v: ValueId, x: string): string =>
          rawNumbers.has(resolve(v)) ? canonicalBits(x) : x;
        const bitwiseSlow = (): string =>
          call(
            BINARY[lbl] as string,
            `i64 ${canon(ins[0] as ValueId, a)}, i64 ${canon(ins[1] as ValueId, b)}`,
          );
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
            bitwiseSlow,
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
    const opRef = operationReference(lbl);
    if (opRef !== undefined && ins.length === opRef.arity) {
      // An operation named by its reference (`Math.sin`, #1362): ToNumber of each argument, then
      // the atom implementing it.
      const nums = ins.map((v) => call("yk_pos", `i64 ${operand(v as ValueId)}`));
      const fn = atomFunction(m, opRef.atom);
      const r = fresh();
      emit(
        `${r} = call i64 @${fn}(ptr null, i64 ${UNDEFINED}, i64 ${nums.length}, ptr ${list(nums)})`,
      );
      set(out, r);
      return;
    }
    if (ins.length === 2 && lbl === "**") {
      // ToNumeric of each, once; two BigInts: the runtime's exact power; two Numbers: pow's atom
      // (Number::exponentiate is Math.pow, V8's shaved `pow`, #1362).
      m.intrinsics.add("declare i32 @yk_exponent(i64, i64, ptr)");
      const pair = fresh();
      entryAllocas.push(`  ${pair} = alloca [2 x i64]`);
      const kind = fresh();
      emit(
        `${kind} = call i32 @yk_exponent(i64 ${operand(ins[0] as ValueId)}, i64 ${operand(ins[1] as ValueId)}, ptr ${pair})`,
      );
      const isBig = fresh();
      emit(`${isBig} = icmp ne i32 ${kind}, 0`);
      const bigL = freshLabel("powbig");
      const numL = freshLabel("pownum");
      const join = freshLabel("powjoin");
      emit(`br i1 ${isBig}, label %${bigL}, label %${numL}`);
      block(bigL);
      const r1 = fresh();
      emit(`${r1} = load i64, ptr ${pair}`);
      emit(`br label %${join}`);
      block(numL);
      const fn = atomFunction(m, "pow");
      const r2 = fresh();
      emit(`${r2} = call i64 @${fn}(ptr null, i64 ${UNDEFINED}, i64 2, ptr ${pair})`);
      const numEnd = currentLabel();
      emit(`br label %${join}`);
      block(join);
      const r = fresh();
      emit(`${r} = phi i64 [ ${r1}, %${bigL} ], [ ${r2}, %${numEnd} ]`);
      set(out, r);
      return;
    }
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
            () =>
              call(
                UNARY[lbl] as string,
                `i64 ${rawNumbers.has(resolve(ins[0] as ValueId)) ? canonicalBits(x) : x}`,
              ),
            boundedInt64(ins[0] as ValueId) ? undefined : ([d]) => smallDouble(d as string),
            allNumbers([ins[0] as ValueId]),
          ),
        );
        return;
      }
      if (lbl === "!") {
        // Undefined, null, a boolean, an array, object or function: known here; anything else
        // (a number, a string, a symbol, a BigInt) the runtime's.
        const isU = fresh();
        emit(`${isU} = icmp eq i64 ${x}, ${UNDEFINED}`);
        const isN = fresh();
        emit(`${isN} = icmp eq i64 ${x}, ${NULL}`);
        const isF = fresh();
        emit(`${isF} = icmp eq i64 ${x}, ${FALSE}`);
        const isT = fresh();
        emit(`${isT} = icmp eq i64 ${x}, ${TRUE}`);
        const tag = fresh();
        emit(`${tag} = lshr i64 ${x}, 48`);
        const lo = fresh();
        emit(`${lo} = icmp uge i64 ${tag}, 65531`);
        const hi = fresh();
        emit(`${hi} = icmp ule i64 ${tag}, 65533`);
        const isRef = fresh();
        emit(`${isRef} = and i1 ${lo}, ${hi}`);
        const f0 = fresh();
        emit(`${f0} = or i1 ${isU}, ${isN}`);
        const falsy = fresh();
        emit(`${falsy} = or i1 ${f0}, ${isF}`);
        const t0 = fresh();
        emit(`${t0} = or i1 ${isT}, ${isRef}`);
        const known = fresh();
        emit(`${known} = or i1 ${falsy}, ${t0}`);
        const kL = freshLabel("notknown");
        const sL = freshLabel("notslow");
        const jL = freshLabel("notjoin");
        emit(`br i1 ${known}, label %${kL}, label %${sL}`);
        block(kL);
        const r1 = fresh();
        emit(`${r1} = select i1 ${falsy}, i64 ${TRUE}, i64 ${FALSE}`);
        emit(`br label %${jL}`);
        block(sL);
        const r2 = slow();
        const sEnd = currentLabel();
        emit(`br label %${jL}`);
        block(jL);
        const r = fresh();
        emit(`${r} = phi i64 [ ${r1}, %${kL} ], [ ${r2}, %${sEnd} ]`);
        set(out, r);
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
      const isProto = (x: Slot): boolean => x.kind === "named" && x.name === "__proto__";
      if (
        slots.some((x) => x.kind === "spread" || x.kind === "get" || x.kind === "set" || isProto(x))
      ) {
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
          if (isProto(slot)) {
            // `__proto__: v` sets the prototype (an object), and defines no property.
            obj = call("yk_object_set_proto", `i64 ${obj}, i64 ${operand(ins[at++] as ValueId)}`);
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
      // Keys and values in source order: a computed key is the input before its value. A `.rec`
      // variant's result needs no keys (only a function value's name).
      const recHere = recOut === true && out === resolve(g.obs[0] as ValueId);
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
        const key =
          slot.kind === "computed"
            ? operand(ins[at++] as ValueId)
            : recHere
              ? ""
              : str((slot as { name: string }).name);
        keys.push(key);
        const v = ins[at++] as ValueId;
        // A function made here is named by its key (NamedEvaluation), unless its code named it.
        const made = producer.get(resolve(v))?.closure !== undefined;
        values.push(
          made
            ? call(
                "yk_name_method",
                `i64 ${operand(v)}, i64 ${key === "" ? str((slot as { name: string }).name) : key}`,
              )
            : operand(v),
        );
      }
      if (recHere) {
        // A `.rec` variant's result: its values in the caller's slots, in the keys' order.
        values.forEach((v, k) => {
          const p = fresh();
          emit(`${p} = getelementptr i64, ptr %recout, i64 ${k}`);
          emit(`store i64 ${v}, ptr ${p}`);
        });
        set(out, UNDEFINED);
        return;
      }
      // Every key a name, none twice: the runtime fills the object at once (no key looked for).
      const names = slots.map((x) =>
        x.kind === "computed" ? undefined : (x as { name: string }).name,
      );
      if (
        names.every((nm) => nm !== undefined) &&
        new Set(names).size === names.length &&
        keys.length > 0
      ) {
        m.intrinsics.add("declare i64 @yk_object_of_distinct(i64, ptr, ptr)");
        const r = fresh();
        emit(
          `${r} = call i64 @yk_object_of_distinct(i64 ${keys.length}, ptr ${list(keys)}, ptr ${list(values)})`,
        );
        set(out, r);
        return;
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
    throw new LlvmEmitError(
      `the operation "${lbl}" is not in the subset yet${n.origin?.text !== undefined ? ` (at ${n.origin.text})` : ""}`,
    );
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
    const builders = builderCarries.get(loop);
    rec.carry.forEach((c, i) => {
      const init = operand(loop.inputs[i] as ValueId);
      if (numRange.has(resolve(c)) && intKnown(loop.inputs[i] as ValueId))
        setInt(c, intOperand(loop.inputs[i] as ValueId));
      if (builders?.has(i) !== true) set(c, init);
      else {
        m.intrinsics.add("declare i64 @yk_sb_new(i64)");
        const h = fresh();
        emit(`${h} = call i64 @yk_sb_new(i64 ${init})`);
        set(c, h);
      }
    });
    const head = freshLabel("loop");
    const inner = freshLabel("body");
    const exit = freshLabel("exit");
    // An iteration: an iterator over the input after the carries, asked for the next element first.
    let iterator: string | undefined;
    // for await (x of it): the runtime's iterator awaits each next() result of an async generator,
    // or each element of anything else (CreateAsyncFromSyncIterator, #1330).
    if (rec.iterate !== undefined) {
      m.used.add("yk_iter_new");
      const iterable = operand(loop.inputs[rec.carry.length] as ValueId);
      iterator = fresh();
      emit(
        `${iterator} = call i64 @yk_iter_new(i64 ${iterable}, i32 ${rec.iterate.of === "keys" ? 1 : rec.iterate.of === "async values" ? 2 : 0})`,
      );
    }
    emit(`br label %${head}`);
    block(head);
    const items = planner.ordered(planner.itemsOf(bodyPathOf(loop)));
    const forCond = new Set<ScopeItem>();
    const want = rec.cond !== undefined ? [resolve(rec.cond)] : [];
    const producedBy = new Map<ValueId, ScopeItem>();
    for (const it of items) for (const v of planner.producesOf(it)) producedBy.set(v, it);
    const condNeeds = new Set<ValueId>();
    while (want.length > 0) {
      const v = want.pop() as ValueId;
      condNeeds.add(v);
      const it = producedBy.get(v);
      if (it === undefined || forCond.has(it)) continue;
      forCond.add(it);
      want.push(...planner.needsOf(it));
    }
    const checkCond = (): void => {
      emitItems(items.filter((it) => forCond.has(it)));
      if (rec.cond !== undefined) {
        const go = freshLabel("go");
        emit(`br i1 ${truthy(rec.cond)}, label %${go}, label %${exit}`);
        block(go);
      }
    };
    // An iteration's condition (its break flags) is checked before the next element is asked for,
    // when it does not read the element: a loop left by a break asks its iterator for nothing more.
    const condFirst = rec.iterate !== undefined && !condNeeds.has(resolve(rec.iterate.element));
    if (condFirst) checkCond();
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
      set(rec.iterate.element, element);
    }
    if (!condFirst) checkCond();
    emit(`br label %${inner}`);
    block(inner);
    emitItems(items.filter((it) => !forCond.has(it)));
    const next = rec.next.map((nv) => operand(nv));
    // A carry in an integer range: its next value's int64 too (all read before any is written).
    const intNext = rec.carry.map((c, i) =>
      numRange.has(resolve(c)) && intKnown(rec.next[i] as ValueId)
        ? intOperand(rec.next[i] as ValueId)
        : undefined,
    );
    next.forEach((r, i) => set(rec.carry[i] as ValueId, r));
    intNext.forEach((r, i) => {
      if (r !== undefined) setInt(rec.carry[i] as ValueId, r);
    });
    emit(`br label %${head}`);
    block(exit);
    // Left early (a break, or a return carried out of the loop), a generator is closed: its
    // finally blocks run (IteratorClose, #1330). One that is done is left as it is.
    if (iterator !== undefined) {
      m.used.add("yk_iter_close");
      emit(`call void @yk_iter_close(i64 ${iterator})`);
    }
    loop.outputs.forEach((v, i) => {
      const at = operand(rec.carry[i] as ValueId);
      if (builders?.has(i) !== true) set(v, at);
      else {
        // The builder's string, the variable's value after the loop.
        m.intrinsics.add("declare i64 @yk_sb_finish(i64)");
        const r = fresh();
        emit(`${r} = call i64 @yk_sb_finish(i64 ${at})`);
        set(v, r);
      }
    });
  };

  /** A regex object of `/pattern/flags`: its matcher compiled and lowered once per module. */
  function regexObject(text: string): string {
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
    return call(
      "yk_regexp_new",
      `i64 ${str(compiled.pattern)}, i64 ${str(compiled.flags)}, i64 ${matcher}, i64 ${namesArray}`,
    );
  }
  /** A string the graph computes from literals alone (`"a" + "b"`), or undefined. */
  const constantString = (v0: ValueId, depth = 0): string | undefined => {
    const p = producer.get(resolve(v0));
    if (p === undefined || depth > 256) return undefined;
    const text = p.label ?? "";
    if (p.kind === "literal-source" && text.startsWith('"')) return JSON.parse(text) as string;
    if (p.kind === "op" && text === "+" && p.inputs.length === 2) {
      const a = constantString(p.inputs[0] as ValueId, depth + 1);
      const b = a === undefined ? undefined : constantString(p.inputs[1] as ValueId, depth + 1);
      return a === undefined || b === undefined ? undefined : a + b;
    }
    return undefined;
  };
  // Each regex literal: its matcher compiled from the pattern and lowered (once per module), and
  // its object made here (DEC-DUC-REGEX-GRAPH-001).
  for (const n of g.nodes) {
    const text = n.label ?? "";
    if (n.kind !== "literal-source" || !text.startsWith("/")) continue;
    set(n.outputs[0] as ValueId, regexObject(text));
  }
  for (const v of argumentsValues) set(v, call("yk_rest", "i64 %argc, ptr %argv, i64 0"));
  if (newTargetValues.length > 0) {
    m.intrinsics.add("declare i64 @yk_take_new_target(ptr)");
    const nt = fresh();
    emit(`${nt} = call i64 @yk_take_new_target(ptr %closure)`);
    for (const v of newTargetValues) set(v, nt);
  }
  // Parameters: the entry function's own; a closure's captures, then its arguments.
  params.forEach((p, i) => {
    const v = p.outputs[0] as ValueId;
    if (closure === undefined && (p.label ?? "").endsWith("..."))
      throw new LlvmEmitError("a rest parameter of the exported function is not in the subset yet");
    if (closure === undefined) set(v, `%p${i}`);
    else if (i < closure.captures && closure.moduleCaptures?.[i] !== undefined)
      freeValue.set(v, closure.moduleCaptures[i] as string);
    else if (i < closure.captures) set(v, call("yk_capture", `ptr %closure, i64 ${i}`));
    else if ((p.label ?? "").endsWith("..."))
      set(v, call("yk_rest", `i64 %argc, ptr %argv, i64 ${i - closure.captures}`));
    else if (
      numberParams !== undefined &&
      numberParams.size > 0 &&
      regList !== undefined &&
      regList.includes(i - closure.captures)
    )
      set(v, `%n${i - closure.captures}`);
    else if (rawParams?.has(i - closure.captures) === true) {
      // A raw block argument: its bytes and length; its address is never read (0, as a local
      // block's is, so a constant offset from it folds).
      set(v, boxedNumber(0));
    } else {
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
    // A loop's carry used numerically: its initial value is (a parameter the loop starts from).
    for (let more = true; more; ) {
      more = false;
      for (const n of g.nodes) {
        const rec = n.loop;
        if (n.kind !== "loop" || rec === undefined) continue;
        rec.carry.forEach((c, j) => {
          const init = resolve(n.inputs[j] as ValueId);
          if (numericUse.has(resolve(c)) && !numericUse.has(init)) {
            numericUse.add(init);
            more = true;
          }
        });
      }
    }
    const worth = numericWork;
    const speculated = params.filter(
      (p, i) =>
        worth &&
        i >= closure.captures &&
        !(p.label ?? "").endsWith("...") &&
        rawParams?.has(i - closure.captures) !== true &&
        numericUse.has(p.outputs[0] as ValueId),
    );
    if (speculated.length > 0) {
      // Named for its function, so a caller whose arguments are numbers calls it directly.
      const clone = `${name.replace(/"/g, "")}.num`;
      m.numClones.add(clone);
      lowerFunction(
        m,
        source,
        clone,
        closure,
        scope,
        new Set(speculated.map((p) => p.outputs[0] as ValueId)),
        rawParams,
        recOut,
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
      emit(
        `${r} = tail call i64 @${clone}(ptr %closure, i64 %this, i64 %argc, ptr %argv${rawHead}${(regList ?? []).map((k) => `, i64 ${operand(params[k + closure.captures]?.outputs[0] as ValueId)}`).join("")})`,
      );
      emit(`ret i64 ${r}`);
      block(general);
      // The general lowering, a function of its own: this entry, only the checks, stays small
      // (no frame of its own to set up before the clone's tail call).
      const gen = `${name.replace(/"/g, "")}.gen`;
      lowerFunction(m, source, gen, closure, scope, new Set(), rawParams, recOut);
      const r2 = fresh();
      emit(
        `${r2} = tail call i64 @${gen}(ptr %closure, i64 %this, i64 %argc, ptr %argv${rawHead})`,
      );
      emit(`ret i64 ${r2}`);
      // Only checks and two tail calls: a small function's is inlined where it is called directly,
      // so its clone's work meets its caller's (#1369).
      dispatchOnly = g.nodes.length <= SMALL_CLONE;
      finish();
      return;
    }
  }
  // An integer range for a number clone's parameters (#1369): a parameter that a loop's carry starts
  // from, when the carry's next value is in a range (kept by | 0 or >>> 0), is checked once here; in
  // that range, the `.int` clone runs, where the carry needs no range check. Else this clone's body.
  if (
    closure !== undefined &&
    numberParams !== undefined &&
    numberParams.size > 0 &&
    paramRanges === undefined &&
    regList !== undefined
  ) {
    const ranged = new Map<ValueId, NumRange>();
    const clash = new Set<ValueId>();
    for (const n of g.nodes) {
      const rec = n.loop;
      if (n.kind !== "loop" || rec === undefined) continue;
      rec.carry.forEach((c, j) => {
        const init = resolve(n.inputs[j] as ValueId);
        const r = numRange.get(resolve(rec.next[j] as ValueId));
        const isParam = params.some(
          (p, pi) =>
            p.outputs[0] === init && pi >= closure.captures && !(p.label ?? "").endsWith("..."),
        );
        if (r === undefined || numRange.has(resolve(c)) || !isParam) return;
        // A uint32 carry's parameter is checked a uint32 (its % and >>> 0 stay integer); any other
        // an integer of either range (an int32 carry may start from a uint32: a hash's state).
        const want: NumRange = r === "u32" ? "u32" : "int";
        if (ranged.has(init) && ranged.get(init) !== want) clash.add(init);
        ranged.set(init, want);
      });
    }
    // A parameter a memory access's address is made from (p + i): its addresses are below 2^32
    // while the program's C memory is.
    const addressParts = (v0: ValueId, depth: number, into: ValueId[]): void => {
      const v = resolve(v0);
      if (numberParams.has(v)) into.push(v);
      const p = producer.get(v);
      if (depth < 8 && p?.kind === "op" && p.label === "+" && p.inputs.length === 2)
        for (const x of p.inputs) addressParts(x as ValueId, depth + 1, into);
    };
    // (Only where a loop is: a third lowering of a function pays for itself there.)
    const looped = g.nodes.some((n) => n.kind === "loop");
    for (const n of looped ? g.nodes : []) {
      const leaf = leafOf(n);
      if (leaf === undefined || MEM_INLINE[leaf] === undefined) continue;
      const parts: ValueId[] = [];
      addressParts(n.inputs[1] as ValueId, 0, parts);
      for (const v of parts) {
        if (ranged.has(v) && ranged.get(v) !== "u32") clash.add(v);
        ranged.set(v, "u32");
      }
    }
    for (const v of clash) ranged.delete(v);
    // Parameters every use of which is a ToInt32's (a bitwise operation's operand, perhaps after +
    // or -): an `.int` clone takes them in the int range too, though only a caller that has them
    // in it calls it so (this clone does not check them: a function with no loop gains nothing).
    const users = new Map<ValueId, DucNode[]>();
    for (const n of g.nodes)
      for (const v of n.inputs) {
        const r = resolve(v as ValueId);
        users.set(r, [...(users.get(r) ?? []), n]);
      }
    const intUse = (v: ValueId, depth: number): boolean => {
      const us = users.get(v) ?? [];
      return (
        us.length > 0 &&
        us.every(
          (u) =>
            u.kind === "op" &&
            (["|", "&", "^", "<<", ">>", ">>>"].includes(u.label ?? "") ||
              (depth < 4 &&
                (u.label === "+" || u.label === "-") &&
                u.inputs.length === 2 &&
                intUse(u.outputs[0] as ValueId, depth + 1))),
        )
      );
    };
    const consumed = new Map<ValueId, NumRange>();
    params.forEach((p, pi) => {
      const v = p.outputs[0] as ValueId;
      if (pi < closure.captures || (p.label ?? "").endsWith("...") || ranged.has(v)) return;
      if (numberParams.has(v) && intUse(v, 0)) consumed.set(v, "int");
    });
    const assumed = new Map<ValueId, NumRange>([...ranged, ...consumed]);
    const intClone = `${name.replace(/"/g, "")}.int`;
    if (assumed.size > 0) {
      const byPosition = new Map<number, NumRange>();
      params.forEach((p, pi) => {
        const r = assumed.get(p.outputs[0] as ValueId);
        if (r !== undefined) byPosition.set(pi - closure.captures, r);
      });
      m.intClones.set(name.replace(/"/g, ""), byPosition);
      lowerFunction(m, source, intClone, closure, scope, numberParams, rawParams, recOut, assumed);
    }
    if (ranged.size > 0) {
      let ok = "true";
      for (const [v, r] of assumed) {
        // A number parameter's register, else its argument (a number checked here).
        const x = operand(v);
        if (!numberParams.has(v)) {
          const isNum = fresh();
          emit(`${isNum} = icmp ult i64 ${x}, ${NUMBER_LIMIT}`);
          const t = fresh();
          emit(`${t} = and i1 ${ok}, ${isNum}`);
          ok = t;
        }
        const d = fresh();
        emit(`${d} = bitcast i64 ${x} to double`);
        const lo = fresh();
        emit(`${lo} = fcmp oge double ${d}, ${r === "u32" ? "0.0" : "-2147483648.0"}`);
        const hi = fresh();
        emit(`${hi} = fcmp olt double ${d}, ${r === "i32" ? "2147483648.0" : "4294967296.0"}`);
        const inR = fresh();
        emit(`${inR} = and i1 ${lo}, ${hi}`);
        // An integer (fptosi is defined where the range holds: the select keeps it so), not -0.
        const safe = fresh();
        emit(`${safe} = select i1 ${inR}, double ${d}, double 0.0`);
        const w = fresh();
        emit(`${w} = fptosi double ${safe} to i64`);
        const back = fresh();
        emit(`${back} = sitofp i64 ${w} to double`);
        const whole = fresh();
        emit(`${whole} = fcmp oeq double ${back}, ${d}`);
        const notNegZero = fresh();
        emit(`${notNegZero} = icmp ne i64 ${x}, -9223372036854775808`);
        const all = [inR, whole, notNegZero].reduce((acc, c) => {
          const t = fresh();
          emit(`${t} = and i1 ${acc}, ${c}`);
          return t;
        }, ok);
        ok = all;
      }
      const intL = freshLabel("ints");
      const bodyL = freshLabel("body");
      emit(`br i1 ${ok}, label %${intL}, label %${bodyL}`);
      block(intL);
      const clone = intClone;
      const r = fresh();
      emit(
        `${r} = tail call i64 @${clone}(ptr %closure, i64 %this, i64 %argc, ptr %argv${rawHead}${regList.map((k) => `, i64 %n${k}`).join("")})`,
      );
      emit(`ret i64 ${r}`);
      block(bodyL);
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
      if (index < closure.captures || sp.uses < 2 || rawParams?.has(index - closure.captures))
        continue;
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
  if (scope?.record !== undefined) {
    const held = new Set<ValueId>([
      ...g.obs.map((v) => resolve(v)),
      ...(g.branches ?? []).map((b) => resolve(b.cond as ValueId)),
    ]);
    for (const n of g.nodes) {
      if (n.loop === undefined) continue;
      for (const v of n.loop.next) held.add(resolve(v));
      if (n.loop.cond !== undefined) held.add(resolve(n.loop.cond));
    }
    const users = new Map<ValueId, DucNode[]>();
    for (const n of g.nodes)
      for (const v of n.inputs) {
        const r = resolve(v as ValueId);
        users.set(r, [...(users.get(r) ?? []), n]);
      }
    for (const n of g.nodes) {
      if (n.kind !== "op" || n.label !== "CallExpression" || n.outputs.length !== 1) continue;
      const out = n.outputs[0] as ValueId;
      if (resolve(out) !== out || held.has(out) || n.inputs.slice(1).some(isSpread)) continue;
      const name = freeValue.get(resolve(n.inputs[0] as ValueId));
      if (
        name === undefined ||
        scope.direct?.(name) === undefined ||
        scope.rawArgs?.(name) !== undefined
      )
        continue;
      const keys = scope.record(name);
      if (keys === undefined) continue;
      const us = users.get(out) ?? [];
      const ok =
        us.length > 0 &&
        us.every(
          (u) =>
            u.kind === "op" &&
            /^\.[\w$]+$/.test(u.label ?? "") &&
            u.inputs.length === 1 &&
            keys.includes((u.label as string).slice(1)) &&
            // Not a method call's callee: that call's receiver is the object itself.
            !(users.get(u.outputs[0] as ValueId) ?? []).some(
              (c) =>
                c.kind === "op" &&
                c.label === "CallExpression" &&
                resolve(c.inputs[0] as ValueId) === (u.outputs[0] as ValueId),
            ),
        );
      if (!ok) continue;
      const slot = fresh();
      entryAllocas.push(`  ${slot} = alloca [${keys.length} x i64]`);
      recordCalls.set(out, { slot, keys });
      for (const u of us) {
        const r = u.outputs[0] as ValueId;
        recordReads.set(r, { slot, idx: keys.indexOf((u.label as string).slice(1)) });
        calleeReads.delete(r);
      }
    }
  }
  {
    const users = new Map<ValueId, [DucNode, number][]>();
    for (const n of g.nodes)
      n.inputs.forEach((v, i) => {
        const r = resolve(v as ValueId);
        users.set(r, [...(users.get(r) ?? []), [n, i]]);
      });
    const fixed = new Set<ValueId>([
      ...g.obs.map((v) => resolve(v)),
      ...(g.branches ?? []).map((b) => resolve(b.cond as ValueId)),
    ]);
    for (const n of g.nodes) {
      if (n.loop === undefined) continue;
      if (n.loop.cond !== undefined) fixed.add(resolve(n.loop.cond));
    }
    for (const loop of g.nodes) {
      const rec = loop.loop;
      if (loop.kind !== "loop" || rec === undefined) continue;
      rec.carry.forEach((c, j) => {
        const init = loop.inputs[j] as ValueId | undefined;
        if (init === undefined || constantString(init) === undefined) return;
        const v = resolve(c);
        const next = resolve(rec.next[j] as ValueId);
        // The values the variable takes in the loop: the carry, appends' results, and selections
        // between them; each used only as one of those.
        const chain = new Set<ValueId>([v]);
        const appends: DucNode[] = [];
        const sels: DucNode[] = [];
        const work = [v];
        let ok = true;
        while (ok && work.length > 0) {
          const x = work.pop() as ValueId;
          if (fixed.has(x)) ok = false;
          for (const [u, i] of users.get(x) ?? []) {
            const o = u.outputs[0] as ValueId | undefined;
            if (
              u.kind === "op" &&
              (u.label === "+" || u.label === "+=") &&
              u.inputs.length === 2 &&
              i === 0 &&
              !chain.has(resolve(u.inputs[1] as ValueId)) &&
              o !== undefined &&
              !bigWidth.has(o)
            ) {
              appends.push(u);
              if (!chain.has(o)) {
                chain.add(o);
                work.push(o);
              }
            } else if (u.kind === "sel" && i > 0 && o !== undefined) {
              sels.push(u);
              if (!chain.has(o)) {
                chain.add(o);
                work.push(o);
              }
            } else ok = false;
          }
          // Its next value is the chain's end; no other loop's next.
          for (const other of g.nodes)
            if (other.loop !== undefined)
              other.loop.next.forEach((nv, k) => {
                if (resolve(nv) === x && !(other === loop && k === j)) ok = false;
              });
        }
        if (!ok || appends.length === 0 || !chain.has(next)) return;
        if (sels.some((sl) => sl.inputs.slice(1).some((x) => !chain.has(resolve(x as ValueId)))))
          return;
        const set0 = builderCarries.get(loop) ?? new Set<number>();
        set0.add(j);
        builderCarries.set(loop, set0);
        for (const a of appends) builderAppends.add(a);
      });
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
    if (completes !== undefined) {
      // Returned: true, and the module's evaluation ends here.
      const r = fresh();
      emit(
        `${r} = select i1 ${truthy(completes.inputs[0] as ValueId)}, i64 ${TRUE}, i64 ${UNDEFINED}`,
      );
      emit(`ret i64 ${r}`);
    } else emit(`ret i64 ${UNDEFINED}`);
  } else if (g.obs.length === 0) emit(`ret i64 ${UNDEFINED}`);
  else emit(`ret i64 ${operand(g.obs[0] as ValueId)}`);

  finish();
  function finish(): void {
    const head =
      closure === undefined
        ? `define i64 @${name}(${params.map((_, i) => `i64 %p${i}`).join(", ")}) {`
        : `define internal i64 @${name}(ptr %closure, i64 %this, i64 %argc, ptr %argv${rawHead}${numberParams !== undefined && numberParams.size > 0 ? (regList ?? []).map((k) => `, i64 %n${k}`).join("") : ""})${numberParams?.size === 0 ? " noinline" : (numberParams !== undefined && g.nodes.length <= SMALL_CLONE) || dispatchOnly ? " alwaysinline" : ""} {`;
    m.functions.push(
      [
        head,
        "entry:",
        ...[...slots.values()].map((s) => `  ${s} = alloca i64`),
        ...[...bigSlots.values()].map((s) => `  ${s} = alloca i128`),
        ...[...intSlots.values()].map((s) => `  ${s} = alloca i64`),
        ...entryAllocas,
        ...body,
        "}",
        "",
      ].join("\n"),
    );
  }
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
    ...keyConstructor(m),
    ...[...m.used].sort().map((f) => RUNTIME_DECLS[f] as string),
    ...m.intrinsics,
    "",
  ].join("\n");
  return { ir, symbol, params: Array(params).fill("i64"), result: "i64" };
}

/** One statement of a module (#1290): a function declaration, or a statement, and the names it declares. */
/** The platform globals the native runtime gives (#1370's closure listing: hand-written). */
export const NATIVE_GLOBALS: ReadonlySet<string> = GLOBALS;
/** The leaves the native lowering calls the runtime for, by their reserved names. */
export const NATIVE_LEAVES: ReadonlySet<string> = new Set(Object.keys(LEAVES));

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

/** What an import or export names: a module's binding or namespace, or a CommonJS or Node module's. */
type Resolved =
  | { readonly slot: string }
  | { readonly ns: number }
  | { readonly cjs: number; readonly name: string }
  | { readonly builtin: string; readonly name: string };

/**
 * ExpectedArgumentCount (ECMA-262 15.1.5) from a function's source text: its parameters before the
 * first with a default or a rest one; undefined when the text does not show its whole list.
 */
function expectedArgumentCount(text: string): number | undefined {
  const arrow = /^(?:async\s+)?([A-Za-z_$][\w$]*)\s*=>/.exec(text);
  if (arrow !== null) return 1;
  const open = text.indexOf("(");
  if (open < 0) return undefined;
  let depth = 0;
  let quote = "";
  let count = 0;
  let current = "";
  for (let i = open + 1; i < text.length; i++) {
    const c = text[i] as string;
    if (quote !== "") {
      if (c === "\\") i++;
      else if (c === quote) quote = "";
      current += c;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") quote = c;
    if (c === "(" || c === "[" || c === "{") depth++;
    if (c === "]" || c === "}") depth--;
    if (c === ")") {
      if (depth === 0) {
        const p = current.trim();
        return p === "" || /^\.\.\./.test(p) || topLevelDefault(p) ? count : count + 1;
      }
      depth--;
    }
    if (c === "," && depth === 0) {
      const p = current.trim();
      if (/^\.\.\./.test(p) || topLevelDefault(p)) return count;
      count++;
      current = "";
      continue;
    }
    current += c;
  }
  return undefined;
}
/** Whether a parameter's text has a default of its own (an `=` outside its pattern's brackets). */
function topLevelDefault(param: string): boolean {
  let depth = 0;
  for (let i = 0; i < param.length; i++) {
    const c = param[i];
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (c === "=" && depth === 0 && param[i + 1] !== ">" && param[i + 1] !== "=") return true;
  }
  return false;
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
  ): Resolved | undefined => {
    const mod = modules[i] as NativeModule;
    const key = `${i}:${name}`;
    if (seen.has(key)) return undefined;
    seen.add(key);
    if (name === "*") return { ns: i };
    const esm = mod.esm;
    if (esm === undefined) return undefined;
    const ex = Object.hasOwn(esm.exports, name) ? esm.exports[name] : undefined;
    if (ex !== undefined && "local" in ex) {
      const imported = Object.hasOwn(esm.imports, ex.local) ? esm.imports[ex.local] : undefined;
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
  // An import of a CommonJS module, or of Node's (a `node:` id no module of the record is, which a
  // boot program's realm gives): its `default` is `module.exports`, `*` a namespace of it, and any
  // other name that property of it, read where it is used (Node's interop, ECMA-262 16.2.1.7).
  const resolveImport = (
    imp: NativeImport,
    seen: Set<string> = new Set(),
  ): Resolved | undefined => {
    const t = index.get(imp.module);
    if (t === undefined) {
      if (imp.module.startsWith("node:")) return { builtin: imp.module, name: imp.name };
      throw new LlvmEmitError(`the module ${imp.module} is not in the program`);
    }
    if ((modules[t] as NativeModule).esm === undefined) return { cjs: t, name: imp.name };
    return resolveExport(t, imp.name, seen);
  };
  const namespaces = new Set<string>();
  /** The value an import resolved to, emitted where it is read. */
  const resolvedValue = (
    target: Resolved,
    from: number,
    fresh: () => string,
    emit: (line: string) => void,
  ): string => {
    const r = fresh();
    if ("slot" in target) {
      emit(`${r} = load i64, ptr ${target.slot}`);
      return r;
    }
    if ("ns" in target) {
      emit(`${r} = call i64 ${g(target.ns, "init")}()`);
      return r;
    }
    if ("cjs" in target) emit(`${r} = call i64 ${g(target.cjs, "init")}()`);
    else emitBuiltin(target.builtin, from, r, fresh, emit);
    if (target.name === "default") return r;
    const out = fresh();
    if (target.name === "*") {
      // One namespace per module, made at its first read.
      const slot = `@"ns.${"cjs" in target ? `m${target.cjs}` : target.builtin}"`;
      if (!namespaces.has(slot)) {
        namespaces.add(slot);
        globals.push(`${slot} = internal global i64 0`);
      }
      m.intrinsics.add("declare i64 @yk_cjs_namespace_once(ptr, i64)");
      emit(`${out} = call i64 @yk_cjs_namespace_once(ptr ${slot}, i64 ${r})`);
      return out;
    }
    const key = m.constant(target.name);
    m.used.add("yk_get_named");
    emit(`${out} = call i64 @yk_get_named(i64 ${r}, ptr ${key.ptr}, i64 ${key.length})`);
    return out;
  };
  /** Node's module `node:<id>`, as a require of it from module `from` gives it. */
  const emitBuiltin = (
    spec: string,
    from: number,
    r: string,
    fresh: () => string,
    emit: (line: string) => void,
  ): void => {
    const key = m.constant(spec);
    const who = m.constant((modules[from] as NativeModule).id);
    const s = fresh();
    m.used.add("yk_string_utf8");
    m.intrinsics.add("declare i64 @yk_require_unresolved(i64, ptr, i64)");
    emit(`${s} = call i64 @yk_string_utf8(ptr ${key.ptr}, i64 ${key.length})`);
    emit(`${r} = call i64 @yk_require_unresolved(i64 ${s}, ptr ${who.ptr}, i64 ${who.length})`);
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
  // Modules evaluated asynchronously (ECMA-262 16.2.1.5.3): an ECMAScript module with an await at
  // its top level, and one that imports such a module. Each one's body runs as an async function's
  // coroutine; its importers wait for its evaluation's promise.
  const asyncModules = new Set<number>();
  modules.forEach((mod, i) => {
    if (
      mod.esm !== undefined &&
      mod.statements.some(
        (st) =>
          st.kind === "statement" && st.graph.nodes.some((n) => n.label === "AwaitExpression"),
      )
    )
      asyncModules.add(i);
  });
  for (let grew = true; grew; ) {
    grew = false;
    modules.forEach((mod, i) => {
      if (asyncModules.has(i) || mod.esm === undefined) return;
      if (mod.esm.deps.some((d) => asyncModules.has(index.get(d) ?? -1))) {
        asyncModules.add(i);
        grew = true;
      }
    });
  }
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
  const directOf = (i: number, name: string): string | undefined => {
    const mod = modules[i] as NativeModule;
    if (mod.statements.some((st) => st.declares.includes(name)))
      return directBySlot.get(g(i, `b.${name}`));
    const imp =
      mod.esm !== undefined && Object.hasOwn(mod.esm.imports, name)
        ? mod.esm.imports[name]
        : undefined;
    if (imp === undefined) return undefined;
    const target = resolveImport(imp);
    return target !== undefined && "slot" in target ? directBySlot.get(target.slot) : undefined;
  };
  // Raw block arguments (#1369): each direct function's, the greatest fixpoint of rawArgUses (an
  // argument passed on must be one its callee takes raw).
  const rawUses = new Map<string, { i: number; uses: Map<number, { deps: [string, number][] }> }>();
  modules.forEach((mod, i) =>
    mod.statements.forEach((st, k) => {
      const fn = `m${i}_s${k}`;
      const name = st.declares[0];
      if (
        st.kind !== "function" ||
        name === undefined ||
        directBySlot.get(g(i, `b.${name}`)) !== fn
      )
        return;
      const uses = rawArgUses(st.graph);
      if (uses.size > 0) rawUses.set(fn, { i, uses });
    }),
  );
  const arities = new Map<string, number>();
  modules.forEach((mod, i) =>
    mod.statements.forEach((st, k) => {
      const ps = st.graph.nodes.filter((n) => n.kind === "param-source");
      if (st.kind === "function" && !ps.some((n) => (n.label ?? "").endsWith("...")))
        arities.set(`m${i}_s${k}`, ps.length);
    }),
  );
  const records = new Map<string, readonly string[]>();
  modules.forEach((mod, i) =>
    mod.statements.forEach((st, k) => {
      const fn = `m${i}_s${k}`;
      const name = st.declares[0];
      if (
        st.kind !== "function" ||
        name === undefined ||
        directBySlot.get(g(i, `b.${name}`)) !== fn
      )
        return;
      const keys = recordKeys(st.graph);
      if (keys !== undefined) records.set(fn, keys);
    }),
  );
  // Result ranges (#1369): a least fixpoint over the direct functions (each call's result is its
  // callee's).
  const ranges = new Map<string, { ret?: IntRange; keys?: Map<string, IntRange> }>();
  for (let changed = true; changed; ) {
    changed = false;
    modules.forEach((mod, i) =>
      mod.statements.forEach((st, k) => {
        const fn = `m${i}_s${k}`;
        const name = st.declares[0];
        if (
          st.kind !== "function" ||
          name === undefined ||
          directBySlot.get(g(i, `b.${name}`)) !== fn
        )
          return;
        const r = resultRanges(st.graph, (callee) => {
          const t = directOf(i, callee);
          return t === undefined ? undefined : ranges.get(t);
        });
        const before = JSON.stringify([ranges.get(fn)?.ret, [...(ranges.get(fn)?.keys ?? [])]]);
        const after = JSON.stringify([r.ret, [...(r.keys ?? [])]]);
        if (before !== after) {
          ranges.set(fn, r);
          changed = true;
        }
      }),
    );
  }
  const rawSets = new Map<string, Set<number>>();
  for (const [fn, r] of rawUses) rawSets.set(fn, new Set(r.uses.keys()));
  for (let changed = true; changed; ) {
    changed = false;
    for (const [fn, r] of rawUses) {
      const set = rawSets.get(fn) as Set<number>;
      for (const j of [...set]) {
        const ok = (r.uses.get(j)?.deps ?? []).every(([callee, pos]) => {
          const t = directOf(r.i, callee);
          return t !== undefined && rawSets.get(t)?.has(pos) === true;
        });
        if (!ok) {
          set.delete(j);
          changed = true;
        }
      }
    }
  }
  modules.forEach((mod, i) => {
    const names = new Set(mod.statements.flatMap((st) => st.declares));
    for (const what of ["module", "exports", "require"])
      globals.push(`${g(i, what)} = internal global i64 ${UNDEFINED}`);
    for (const name of names)
      globals.push(`${g(i, `b.${name}`)} = internal global i64 ${UNDEFINED}`);
    globals.push(`${g(i, "state")} = internal global i32 0`);
    if (asyncModules.has(i)) globals.push(`${g(i, "promise")} = internal global i64 0`);
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
          const imp =
            mod.esm !== undefined && Object.hasOwn(mod.esm.imports, name)
              ? mod.esm.imports[name]
              : undefined;
          if (imp === undefined) return undefined;
          const target = resolveImport(imp);
          if (target === undefined)
            throw new LlvmEmitError(
              `${imp.module} has no export ${imp.name} (imported by ${mod.id})`,
            );
          // A live binding: the exporting module's own variable, read where it is used.
          return resolvedValue(target, i, fresh, emit);
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
      direct: (name) => directOf(i, name),
      binds: (name) =>
        names.has(name) || (mod.esm !== undefined && Object.hasOwn(mod.esm.imports, name)),
      arity: (name) => {
        const fn = directOf(i, name);
        return fn === undefined ? undefined : arities.get(fn);
      },
      record: (name) => {
        const fn = directOf(i, name);
        return fn === undefined ? undefined : records.get(fn);
      },
      ranges: (name) => {
        const fn = directOf(i, name);
        return fn === undefined ? undefined : ranges.get(fn);
      },
      rawArgs: (name) => {
        const fn = directOf(i, name);
        const set = fn === undefined ? undefined : rawSets.get(fn);
        return set !== undefined && set.size > 0 ? set : undefined;
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
        const raw = rawSets.get(fn);
        if (raw !== undefined && raw.size > 0)
          lowerFunction(
            m,
            ecmaScriptView(st.graph),
            `${fn}.raw`,
            { captures: 0 },
            scope(),
            undefined,
            raw,
          );
        if (records.has(fn) && (raw === undefined || raw.size === 0))
          lowerFunction(
            m,
            ecmaScriptView(st.graph),
            `${fn}.rec`,
            { captures: 0 },
            scope(),
            undefined,
            undefined,
            true,
          );
        m.used.add("yk_closure_new");
        m.intrinsics.add("declare i64 @yk_class_name(i64, ptr, i64)");
        init.push(`  %f${k} = call i64 @yk_closure_new(ptr @${fn}, i32 1, i64 0, ptr null)`);
        // Its name, the declaration's (`f.name`).
        const nm = m.constant(name);
        init.push(
          `  %fn${k} = call i64 @yk_class_name(i64 %f${k}, ptr ${nm.ptr}, i64 ${nm.length})`,
        );
        // An async function's or a generator's: the runtime runs it as a coroutine (as a closure's).
        const modeCode =
          st.graph.mode === "async"
            ? 1
            : st.graph.mode === "generator"
              ? 2
              : st.graph.mode === "async generator"
                ? 3
                : 0;
        if (modeCode !== 0) {
          m.used.add("yk_closure_mode");
          init.push(`  %fm${k} = call i64 @yk_closure_mode(i64 %f${k}, i32 ${modeCode})`);
        }
        init.push(`  store i64 %f${modeCode !== 0 ? "m" : ""}${k}, ptr ${g(i, `b.${name}`)}`);
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
      const result = st.graph.nodes.find((n) => n.outputs.includes(st.graph.obs[0] as ValueId));
      if ((result?.label ?? "").startsWith(COMPLETES)) {
        // A top-level return: the module's evaluation ends with it.
        init.push(`  %ret${k} = call i64 @${fn}()`);
        init.push(`  %returned${k} = icmp eq i64 %ret${k}, ${TRUE}`);
        init.push(`  br i1 %returned${k}, label %done, label %after${k}`);
        init.push(`after${k}:`);
      } else init.push(`  call i64 @${fn}()`);
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
      // A require the record left out (one a function makes, of a module no top level needs):
      // it fails when it runs, as Node's would for a module it cannot find.
      if (t === undefined) return;
      const key = m.constant(spec);
      req.push(`  %is${r} = call i32 @yk_string_is(i64 %spec, ptr ${key.ptr}, i64 ${key.length})`);
      req.push(`  %c${r} = icmp ne i32 %is${r}, 0`);
      req.push(`  br i1 %c${r}, label %hit${r}, label %next${r}`);
      req.push(`hit${r}:`);
      req.push(`  %v${r} = call i64 ${g(t, "init")}()`);
      req.push(`  ret i64 %v${r}`);
      req.push(`next${r}:`);
    });
    const from = m.constant(mod.id);
    // Any other: the module a boot program's realm gives for it (Node's library, #1361 P2), else
    // Node's MODULE_NOT_FOUND error, thrown (a try around an optional require catches it).
    m.intrinsics.add("declare i64 @yk_require_unresolved(i64, ptr, i64)");
    req.push(
      `  %other = call i64 @yk_require_unresolved(i64 %spec, ptr ${from.ptr}, i64 ${from.length})`,
      "  ret i64 %other",
      "}",
      "",
    );
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
        let n = 0;
        const v = resolvedValue(
          target,
          i,
          () => `%nv${k}.${n++}`,
          (line) => namespace.push(`  ${line}`),
        );
        namespace.push(
          `  call i64 @yk_set_named(i64 %ex, ptr ${key.ptr}, i64 ${key.length}, i64 ${v})`,
        );
      });
    }
    // An ECMAScript module's dependencies are evaluated first, in order (a cycle sees a module
    // still being evaluated, as ECMA-262's does); an async one's evaluation is waited for.
    const isAsync = asyncModules.has(i);
    const depLines: string[] = (mod.esm?.deps ?? []).flatMap((d, k) => {
      const t = index.get(d);
      if (t !== undefined) return [`  %dep${k} = call i64 ${g(t, "init")}()`];
      if (!d.startsWith("node:")) throw new LlvmEmitError(`the module ${d} is not in the program`);
      const lines: string[] = [];
      let n = 0;
      emitBuiltin(
        d,
        i,
        `%dep${k}`,
        () => `%dep${k}.${n++}`,
        (l) => lines.push(`  ${l}`),
      );
      return lines;
    });
    if (isAsync) {
      (mod.esm?.deps ?? []).forEach((d, k) => {
        const t = index.get(d);
        if (t === undefined || !asyncModules.has(t)) return;
        const at = depLines.findIndex((l) => l.startsWith(`  %dep${k} = `));
        depLines.splice(
          at + 1,
          0,
          `  %dp${k} = load i64, ptr ${g(t, "promise")}`,
          `  %dw${k} = call i64 @yk_await(i64 %dp${k})`,
        );
      });
      m.used.add("yk_await");
      m.used.add("yk_call");
      m.used.add("yk_closure_mode");
      m.intrinsics.add("declare void @yk_module_evaluating(i64, i64)");
      m.functions.push(
        [
          `define internal i64 @"m${i}.body"(ptr %closure, i64 %this, i64 %argc, ptr %argv) {`,
          "entry:",
          `  %ex = load i64, ptr ${g(i, "exports")}`,
          ...depLines,
          ...init,
          ...namespace,
          "  br label %done",
          "done:",
          `  ret i64 ${UNDEFINED}`,
          "}",
          "",
        ].join("\n"),
      );
    }
    // The initializer: once; a second call (a cycle, or another require) gets the exports so far.
    const exportsKey = m.constant("exports");
    if (mod.esm !== undefined) m.intrinsics.add("declare i64 @yk_mark_namespace(i64)");
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
        // An ECMAScript module's exports object is its namespace, marked so: import() gives it as
        // it is (a CommonJS module's exports it wraps).
        ...(mod.esm !== undefined ? ["  %marked = call i64 @yk_mark_namespace(i64 %ex)"] : []),
        `  %ek = call i64 @yk_string_utf8(ptr ${exportsKey.ptr}, i64 ${exportsKey.length})`,
        "  store i64 %ek, ptr %keys",
        "  store i64 %ex, ptr %vals",
        "  %mod = call i64 @yk_object_of(i64 1, ptr %keys, ptr %vals)",
        `  store i64 %mod, ptr ${g(i, "module")}`,
        `  %req = call i64 @yk_closure_new(ptr ${g(i, "require.fn")}, i32 0, i64 0, ptr null)`,
        `  store i64 %req, ptr ${g(i, "require")}`,
        ...(isAsync
          ? [
              // Its body (dependencies, statements, namespace) as an async function: its promise
              // is its evaluation's, which importers and import() wait for.
              `  %body = call i64 @yk_closure_new(ptr @"m${i}.body", i32 0, i64 0, ptr null)`,
              "  %bodym = call i64 @yk_closure_mode(i64 %body, i32 1)",
              `  %eval = call i64 @yk_call(i64 %bodym, i64 ${UNDEFINED}, i64 0, ptr null)`,
              `  store i64 %eval, ptr ${g(i, "promise")}`,
              "  call void @yk_module_evaluating(i64 %ex, i64 %eval)",
            ]
          : [...depLines, ...init, ...namespace]),
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
  // A number clone a call names that its function has none of: the function itself.
  for (const [clone, { of, rawBlocks, regs, rec }] of m.numCalled) {
    if (m.numClones.has(clone)) continue;
    const ps = Array.from({ length: rawBlocks }, (_, j) => [`ptr %rb${j}`, `i64 %rl${j}`]).flat();
    if (rec === true) ps.push("ptr %recout");
    const ns = Array.from({ length: regs }, (_, j) => `, i64 %n${j}`).join("");
    m.functions.push(
      [
        `define internal i64 @${clone}(ptr %closure, i64 %this, i64 %argc, ptr %argv${ps.map((p) => `, ${p}`).join("")}${ns}) {`,
        `  %r = tail call i64 @${of}(ptr %closure, i64 %this, i64 %argc, ptr %argv${ps.map((p) => `, ${p}`).join("")})`,
        "  ret i64 %r",
        "}",
        "",
      ].join("\n"),
    );
  }
  // Calls with arguments of known ranges (#1369): the callee's `.int` clone when it takes each of
  // them in a range the argument's is within, else its `.num` clone.
  const within = (a: NumRange | "both" | undefined, want: NumRange): boolean =>
    a !== undefined && (a === want || a === "both" || want === "int");
  for (const [thunk, { of, ranges, rawBlocks, regs, rec, boxed }] of m.intCalled) {
    const takes = m.intClones.get(of);
    if (boxed !== undefined) {
      // Boxed arguments: each the `.int` clone takes is checked an integer of its range, every
      // other a number (its register); then the `.int` clone, else the function's own entry.
      const recPass = rec ? ", ptr %recout" : "";
      const head = `define internal i64 @${thunk}(ptr %closure, i64 %this, i64 %argc, ptr %argv${recPass}) alwaysinline {`;
      const own = `  %r = tail call i64 @${boxed}(ptr %closure, i64 %this, i64 %argc, ptr %argv${recPass})`;
      if (takes === undefined || [...takes.keys()].some((k) => k >= regs)) {
        m.functions.push([head, own, "  ret i64 %r", "}", ""].join("\n"));
        continue;
      }
      const lines: string[] = [];
      let ok = "true";
      for (let k = 0; k < regs; k++) {
        lines.push(
          `  %p${k} = getelementptr i64, ptr %argv, i64 ${k}`,
          `  %n${k} = load i64, ptr %p${k}`,
        );
        const want = takes.get(k);
        if (want !== undefined && within(ranges[k], want)) continue;
        if (ranges[k] !== undefined && want === undefined) continue;
        lines.push(
          `  %u${k} = icmp ult i64 %n${k}, ${NUMBER_LIMIT}`,
          `  %q${k} = and i1 ${ok}, %u${k}`,
        );
        ok = `%q${k}`;
        if (want === undefined) continue;
        const lo = want === "u32" ? "0.0" : "-2147483648.0";
        const hi = want === "i32" ? "2147483648.0" : "4294967296.0";
        lines.push(
          `  %d${k} = bitcast i64 %n${k} to double`,
          `  %lo${k} = fcmp oge double %d${k}, ${lo}`,
          `  %hi${k} = fcmp olt double %d${k}, ${hi}`,
          `  %in${k} = and i1 %lo${k}, %hi${k}`,
          `  %s${k} = select i1 %in${k}, double %d${k}, double 0.0`,
          `  %w${k} = fptosi double %s${k} to i64`,
          `  %b${k} = sitofp i64 %w${k} to double`,
          `  %e${k} = fcmp oeq double %b${k}, %d${k}`,
          `  %z${k} = icmp ne i64 %n${k}, -9223372036854775808`,
          `  %a${k} = and i1 %in${k}, %e${k}`,
          `  %c${k} = and i1 %a${k}, %z${k}`,
          `  %ok${k} = and i1 ${ok}, %c${k}`,
        );
        ok = `%ok${k}`;
      }
      const regPass = Array.from({ length: regs }, (_, k) => `, i64 %n${k}`).join("");
      m.functions.push(
        [
          head,
          ...lines,
          `  br i1 ${ok}, label %int, label %own`,
          "int:",
          `  %r1 = tail call i64 @${of}.int(ptr %closure, i64 %this, i64 %argc, ptr %argv${recPass}${regPass})`,
          "  ret i64 %r1",
          "own:",
          `  %r2 = tail call i64 @${boxed}(ptr %closure, i64 %this, i64 %argc, ptr %argv${recPass})`,
          "  ret i64 %r2",
          "}",
          "",
        ].join("\n"),
      );
      continue;
    }
    const ps = Array.from({ length: rawBlocks }, (_, j) => [`ptr %rb${j}`, `i64 %rl${j}`]).flat();
    if (rec) ps.push("ptr %recout");
    const ns = Array.from({ length: regs }, (_, j) => `i64 %n${j}`);
    const all = [...ps, ...ns];
    const pass = all.map((p) => `, ${p}`).join("");
    const head = `define internal i64 @${thunk}(ptr %closure, i64 %this, i64 %argc, ptr %argv${pass}) alwaysinline {`;
    const callTo = (to: string, r: string): string =>
      `  ${r} = tail call i64 @${to}(ptr %closure, i64 %this, i64 %argc, ptr %argv${pass})`;
    if (takes === undefined) {
      m.functions.push([head, callTo(of, "%r"), "  ret i64 %r", "}", ""].join("\n"));
      continue;
    }
    // Each argument the `.int` clone takes in a range the call does not prove: checked here (a
    // number register: an integer of that range, not -0).
    const body: string[] = [];
    let ok = "true";
    let t = 0;
    for (const [k, want] of takes) {
      if (within(ranges[k], want)) continue;
      // (With raw block arguments, a position is not its register's: the `.num` clone then.)
      if (rawBlocks > 0 || k >= regs) {
        ok = "false";
        break;
      }
      const x = `%n${k}`;
      const lo = want === "u32" ? "0.0" : "-2147483648.0";
      const hi = want === "i32" ? "2147483648.0" : "4294967296.0";
      body.push(
        `  %d${t} = bitcast i64 ${x} to double`,
        `  %lo${t} = fcmp oge double %d${t}, ${lo}`,
        `  %hi${t} = fcmp olt double %d${t}, ${hi}`,
        `  %in${t} = and i1 %lo${t}, %hi${t}`,
        `  %s${t} = select i1 %in${t}, double %d${t}, double 0.0`,
        `  %w${t} = fptosi double %s${t} to i64`,
        `  %b${t} = sitofp i64 %w${t} to double`,
        `  %e${t} = fcmp oeq double %b${t}, %d${t}`,
        `  %z${t} = icmp ne i64 ${x}, -9223372036854775808`,
        `  %a${t} = and i1 %in${t}, %e${t}`,
        `  %c${t} = and i1 %a${t}, %z${t}`,
        `  %ok${t} = and i1 ${ok}, %c${t}`,
      );
      ok = `%ok${t}`;
      t++;
    }
    if (ok === "false") {
      m.functions.push([head, callTo(of, "%r"), "  ret i64 %r", "}", ""].join("\n"));
      continue;
    }
    m.functions.push(
      [
        head,
        ...body,
        `  br i1 ${ok}, label %int, label %num`,
        "int:",
        callTo(`${of}.int`, "%r1"),
        "  ret i64 %r1",
        "num:",
        callTo(of, "%r2"),
        "  ret i64 %r2",
        "}",
        "",
      ].join("\n"),
    );
  }
  const ir = [
    "; yakcc native lowering, a package's modules (#1292, #1290)",
    'source_filename = "modules"',
    "",
    ...m.globals,
    ...globals,
    "",
    ...m.functions,
    ...keyConstructor(m),
    ...[...m.used].sort().map((f) => RUNTIME_DECLS[f] as string),
    ...m.intrinsics,
    "",
  ].join("\n");
  return { ir, symbols };
}
