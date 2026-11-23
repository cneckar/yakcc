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
import { bodyPathOf, joinOwners, sidePath } from "./line-form.js";
import { loweringView } from "./ordering.js";
import { paramIndex } from "./params.js";
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
};
/** The global functions the runtime gives as values. */
const GLOBALS = new Set(["String", "Number", "Boolean"]);
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
  yk_math1: "declare i64 @yk_math1(ptr, i64)",
  yk_global: "declare i64 @yk_global(ptr, i64)",
  yk_math_minmax: "declare i64 @yk_math_minmax(i32, i64, ptr)",
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
  | { readonly kind: "unsupported"; readonly what: string };

function slotsOf(label: string): Slot[] {
  return (JSON.parse(label.slice("object:".length)) as unknown[]).map((entry): Slot => {
    if (entry === null) return { kind: "unsupported", what: "spread in an object literal" };
    if (entry === 1) return { kind: "computed" };
    if (typeof entry === "string") return { kind: "named", name: entry };
    const [kind, k] = Object.entries(entry as Record<string, unknown>)[0] ?? [];
    if (kind === "method" && typeof k === "string") return { kind: "method", name: k };
    return { kind: "unsupported", what: `a ${kind} member` };
  });
}

/** The module being built: its constants, the runtime functions it calls, its functions. */
class ModuleBuilder {
  readonly globals: string[] = [];
  readonly used = new Set<string>();
  readonly functions: string[] = [];
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
function lowerFunction(
  m: ModuleBuilder,
  source: DucGraph,
  name: string,
  closure: { readonly captures: number } | undefined,
): void {
  if (source.mode !== undefined)
    throw new LlvmEmitError(`an ${source.mode} function is not in the subset yet`);
  if (source.obs.length !== 1) throw new LlvmEmitError("a native function has exactly one result");
  const { graph: g, after } = loweringView(source);
  const owners = joinOwners(g);
  const producer = new Map<ValueId, DucNode>();
  for (const n of g.nodes) for (const v of n.outputs) producer.set(v, n);

  const alias = new Map<ValueId, ValueId>();
  for (const loop of g.nodes.filter((n) => n.kind === "loop")) {
    const rec = loop.loop as DucLoop;
    if (rec.iterate !== undefined) throw new LlvmEmitError("iteration is not in the subset yet");
    if (rec.cond === undefined) throw new LlvmEmitError("a loop with no condition");
    rec.invariant.forEach((v, j) => alias.set(v, loop.inputs[rec.carry.length + j] as ValueId));
  }
  const resolve = (v: ValueId): ValueId => {
    const a = alias.get(v);
    return a === undefined ? v : resolve(a);
  };
  const planner = scopePlanner(g, owners, resolve, (msg) => new LlvmEmitError(msg), after);

  // Math, whose members a call names; and the global functions the runtime gives as values.
  const mathValue = new Set<ValueId>();
  const globalValue = new Map<ValueId, string>();
  for (const n of g.nodes) {
    if (n.kind !== "diamond-source") continue;
    const sym = n.diamond?.symbol ?? "";
    if (n.diamond?.reason === "platform-primitive" && sym === "Math")
      mathValue.add(n.outputs[0] as ValueId);
    else if (n.diamond?.reason === "platform-primitive" && GLOBALS.has(sym))
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
      if (text === "undefined") return UNDEFINED;
      if (text.startsWith('"')) return str(JSON.parse(text) as string);
      const n = Number(text.replace(/_/g, ""));
      if (text === "" || (Number.isNaN(n) && text !== "NaN"))
        throw new LlvmEmitError(`the literal ${text} is not in the subset yet`);
      return boxedNumber(n);
    }
    if (p?.kind === "diamond-source") {
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

  /** A closure node: its graph lowered to a function, and the record that holds its captures. */
  const makeClosure = (n: DucNode): string => {
    const graph = n.closure as DucGraph;
    const lbl = n.label ?? "";
    if (lbl !== "closure" && lbl !== "function")
      throw new LlvmEmitError(`a "${lbl}" function is not in the subset yet`);
    const fn = m.closureName(name);
    lowerFunction(m, graph, fn, { captures: n.inputs.length });
    const caps = n.inputs.map(operand);
    m.used.add("yk_closure_new");
    const r = fresh();
    emit(
      `${r} = call i64 @yk_closure_new(ptr @${fn}, i32 ${lbl === "function" ? 1 : 0}, i64 ${caps.length}, ptr ${list(caps)})`,
    );
    return r;
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
      if (closure === undefined) throw new LlvmEmitError("`this` outside a function");
      set(out, "%this");
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
    if (lbl === "CallExpression") {
      const callee = memberOf(ins[0] as ValueId);
      const args = ins.slice(1).map(operand);
      if (callee !== undefined && isMath(callee.node.inputs[0] as ValueId)) {
        if (MATH1.has(callee.name) && args.length === 1) {
          const key = m.constant(callee.name, true);
          set(out, call("yk_math1", `ptr ${key.ptr}, i64 ${args[0]}`));
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
        call("yk_call", `i64 ${fn}, i64 ${UNDEFINED}, i64 ${args.length}, ptr ${list(args)}`),
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
      if (ins.some((v) => producer.get(resolve(v))?.label === "..."))
        throw new LlvmEmitError("spread is not in the subset yet");
      const elems = ins.map(operand);
      set(out, call("yk_array_of", `i64 ${elems.length}, ptr ${list(elems)}`));
      return;
    }
    if (lbl.startsWith("object:")) {
      // Keys and values in source order: a computed key is the input before its value.
      const keys: string[] = [];
      const values: string[] = [];
      let at = 0;
      for (const slot of slotsOf(lbl)) {
        if (slot.kind === "unsupported")
          throw new LlvmEmitError(`${slot.what} is not in the subset yet`);
        keys.push(slot.kind === "computed" ? operand(ins[at++] as ValueId) : str(slot.name));
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
    emit(`br label %${head}`);
    block(head);
    const items = planner.ordered(planner.itemsOf(bodyPathOf(loop)));
    const forCond = new Set<ScopeItem>();
    const want = [resolve(rec.cond as ValueId)];
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
    emit(`br i1 ${truthy(rec.cond as ValueId)}, label %${inner}, label %${exit}`);
    block(inner);
    emitItems(items.filter((it) => !forCond.has(it)));
    const next = rec.next.map((nv) => operand(nv));
    next.forEach((r, i) => set(rec.carry[i] as ValueId, r));
    emit(`br label %${head}`);
    block(exit);
    loop.outputs.forEach((v, i) => set(v, operand(rec.carry[i] as ValueId)));
  };

  // Parameters: the entry function's own; a closure's captures, then its arguments.
  params.forEach((p, i) => {
    const v = p.outputs[0] as ValueId;
    if (closure === undefined) set(v, `%p${i}`);
    else if (i < closure.captures) set(v, call("yk_capture", `ptr %closure, i64 ${i}`));
    else set(v, call("yk_arg", `i64 %argc, ptr %argv, i64 ${i - closure.captures}`));
  });
  emitScope(undefined);
  emit(`ret i64 ${operand(g.obs[0] as ValueId)}`);

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
export function emitLlvmBoxed(source: DucGraph, symbol = "f"): LlvmModule {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(symbol))
    throw new LlvmEmitError(`"${symbol}" is not a symbol a linker takes`);
  const m = new ModuleBuilder();
  lowerFunction(m, source, symbol, undefined);
  const params = source.nodes.filter((n) => n.kind === "param-source").length;
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
