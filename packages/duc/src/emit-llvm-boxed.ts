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
]);
const MATH1 = new Set(["floor", "ceil", "trunc", "sqrt", "abs", "sign", "round"]);
const APPROXIMATED =
  /^(exp|expm1|log|log1p|log2|log10|sin|cos|tan|asin|acos|atan|atan2|sinh|cosh|tanh|asinh|acosh|atanh|cbrt|hypot|pow)$/;

const RUNTIME_DECLS: Readonly<Record<string, string>> = {
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
  yk_class_new: "declare i64 @yk_class_new(i64, i64, ptr, ptr, ptr, ptr)",
  yk_super_construct: "declare i64 @yk_super_construct(ptr, i64, i64, ptr)",
  yk_await: "declare i64 @yk_await(i64)",
  yk_yield: "declare i64 @yk_yield(i64)",
  yk_yield_star: "declare i64 @yk_yield_star(i64)",
  yk_closure_mode: "declare i64 @yk_closure_mode(i64, i32)",
  yk_super_get: "declare i64 @yk_super_get(ptr, i64, ptr, i64)",
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
  /** For a statement: the globals its results (its graph's observations) are stored in, in order. */
  readonly outs?: readonly string[];
}

function lowerFunction(
  m: ModuleBuilder,
  source: DucGraph,
  name: string,
  closure: { readonly captures: number } | undefined,
  scope?: ModuleScope,
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
    const rec = loop.loop as DucLoop;
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
  for (const n of g.nodes) {
    if (n.kind !== "diamond-source") continue;
    const sym = n.diamond?.symbol ?? "";
    if (n.diamond?.reason === "platform-primitive" && sym === "Math")
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
  const block = (lbl: string): void => void body.push(`${lbl}:`);
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
      const n = Number(text.replace(/_/g, ""));
      if (text === "" || (Number.isNaN(n) && text !== "NaN"))
        throw new LlvmEmitError(`the literal ${text} is not in the subset yet`);
      return boxedNumber(n);
    }
    if (p?.kind === "diamond-source") {
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
    const r = fresh();
    emit(`${r} = load i64, ptr ${slotOf(v)}`);
    return r;
  };
  const set = (v: ValueId, r: string): void => emit(`store i64 ${r}, ptr ${slotOf(v)}`);
  const truthy = (v: ValueId): string => {
    m.used.add("yk_truthy");
    const i = fresh();
    emit(`${i} = call i32 @yk_truthy(i64 ${operand(v)})`);
    const b = fresh();
    emit(`${b} = icmp ne i32 ${i}, 0`);
    return b;
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
    if (lbl === "...") {
      // The value spread; the list it is in (an array literal, a call's arguments) expands it.
      set(out, operand(ins[0] as ValueId));
      return;
    }
    if (lbl === "class-self") {
      if (closure === undefined) throw new LlvmEmitError("class-self outside a class's member");
      set(out, call("yk_closure_class", "ptr %closure"));
      return;
    }
    if (lbl.startsWith("Class#"))
      throw new LlvmEmitError(
        "a class with a field, a static block, a computed or private name, or a parameter property is not in the subset yet",
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
      // [kind, name, static] per member; the inputs are the members' functions, in order. A derived
      // class's parent is its first input (#1294).
      const all = JSON.parse(lbl.slice("class:".length)) as [string, string?, boolean?][];
      const derived = all[0]?.[0] === "extends";
      const members = derived ? all.slice(1) : all;
      const parent = derived ? operand(ins[0] as ValueId) : "0";
      const memberIns = derived ? ins.slice(1) : ins;
      const KIND: Record<string, number> = { constructor: 0, method: 1, get: 2, set: 3 };
      if (members.length !== memberIns.length || members.some(([k]) => KIND[k] === undefined))
        throw new LlvmEmitError(
          `a class member of kind ${members.map(([k]) => k).find((k) => KIND[k] === undefined) ?? "(computed)"} is not in the subset yet`,
        );
      const kinds = members.map(([k]) => boxedNumber(KIND[k] as number));
      const names = members.map(([, name]) => (name === undefined ? UNDEFINED : str(name)));
      const statics = members.map(([, , isStatic]) => (isStatic === true ? TRUE : FALSE));
      const fns = memberIns.map(operand);
      set(
        out,
        call(
          "yk_class_new",
          `i64 ${parent}, i64 ${members.length}, ptr ${list(kinds)}, ptr ${list(names)}, ptr ${list(statics)}, ptr ${list(fns)}`,
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
    if (lbl === "CallExpression") {
      const callee = memberOf(ins[0] as ValueId);
      const args = ins.slice(1).map(operand);
      if (callee !== undefined && isMath(callee.node.inputs[0] as ValueId)) {
        if (MATH1.has(callee.name) && args.length === 1) {
          const key = m.constant(callee.name, true);
          set(out, call("yk_math1", `ptr ${key.ptr}, i64 ${args[0]}`));
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
      // super.f(args): the parent's f, called with the receiver the read was made with (#1294).
      const viaSuper = producer.get(resolve(ins[0] as ValueId));
      const superRecv =
        viaSuper?.kind === "op" && (viaSuper.label ?? "").startsWith("super.")
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
      set(
        out,
        call("yk_call", `i64 ${fn}, i64 ${superRecv}, i64 ${args.length}, ptr ${list(args)}`),
      );
      return;
    }
    if (ins.length === 2 && BINARY[lbl] !== undefined) {
      set(
        out,
        call(
          BINARY[lbl] as string,
          `i64 ${operand(ins[0] as ValueId)}, i64 ${operand(ins[1] as ValueId)}`,
        ),
      );
      return;
    }
    if (ins.length === 2 && lbl === "**")
      throw new LlvmEmitError(
        "** is implementation-approximated in ECMAScript: a native pow need not give the reference's last bit",
      );
    if (ins.length === 1 && UNARY[lbl] !== undefined) {
      set(out, call(UNARY[lbl] as string, `i64 ${operand(ins[0] as ValueId)}`));
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
      set(rec.iterate.element, element);
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
      lowerFunction(m, compiled.graph, fn, { captures: 0 });
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
    else set(v, call("yk_arg", `i64 %argc, ptr %argv, i64 ${i - closure.captures}`));
  });
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
      ...entryAllocas,
      ...body,
      "}",
      "",
    ].join("\n"),
  );
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
        if (slot === undefined) return undefined;
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
        ...init,
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
    "",
  ].join("\n");
  return { ir, symbols };
}
