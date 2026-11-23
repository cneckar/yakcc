import { LlvmEmitError, type LlvmModule } from "./emit-llvm.js";
// SPDX-License-Identifier: Apache-2.0
/**
 * The native lowering beyond the typed subset (#1292, DEC-DUC-NATIVE-RUNTIME-001): every value is a
 * NaN-boxed 64-bit word, and every operation the graph names is a call to the yakcc runtime
 * (`runtime/yk.c`), which implements JavaScript's semantics for it. The graph needs nothing it does not
 * carry: an operation's label names the runtime function, and the heap token's order is the order the
 * calls are made in.
 *
 * The exported function takes and returns boxed values: `uint64_t f(uint64_t, …)`.
 *
 * Covered: numbers, booleans, undefined, null, strings (UTF-16), arrays; the arithmetic, relational,
 * equality and logical operators with JavaScript's coercions; `typeof`; template literals; reading
 * `.length`, indexes and named members; the string and array methods the runtime lists; the exact
 * `Math`. Refused, with the reason: objects and writes to them, closures, free names, the approximated
 * `Math` and `**`, spread, iteration.
 */
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
const MATH1 = new Set(["floor", "ceil", "trunc", "sqrt", "abs", "sign", "round"]);
const APPROXIMATED =
  /^(exp|expm1|log|log1p|log2|log10|sin|cos|tan|asin|acos|atan|atan2|sinh|cosh|tanh|asinh|acosh|atanh|cbrt|hypot|pow)$/;
const METHODS = new Set(["charCodeAt", "slice", "indexOf", "push", "join"]);

const RUNTIME_DECLS: Readonly<Record<string, string>> = {
  yk_truthy: "declare i32 @yk_truthy(i64)",
  yk_string_utf8: "declare i64 @yk_string_utf8(ptr, i64)",
  yk_array_of: "declare i64 @yk_array_of(i64, ptr)",
  yk_template: "declare i64 @yk_template(i64, ptr, ptr)",
  yk_get: "declare i64 @yk_get(i64, i64)",
  yk_get_named: "declare i64 @yk_get_named(i64, ptr, i64)",
  yk_call_method: "declare i64 @yk_call_method(i64, ptr, i64, i64, ptr)",
  yk_math1: "declare i64 @yk_math1(ptr, i64)",
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

/** The graph lowered to an LLVM module of boxed values, calling the runtime. */
export function emitLlvmBoxed(source: DucGraph, symbol = "f"): LlvmModule {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(symbol))
    throw new LlvmEmitError(`"${symbol}" is not a symbol a linker takes`);
  if (source.mode !== undefined)
    throw new LlvmEmitError(`an ${source.mode} function has no form here`);
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
  const planner = scopePlanner(g, owners, resolve, (m) => new LlvmEmitError(m), after);

  // Math, and the members read from it.
  const mathValue = new Set<ValueId>();
  for (const n of g.nodes) {
    if (n.kind !== "diamond-source") continue;
    if (n.diamond?.reason === "platform-primitive" && n.diamond.symbol === "Math")
      mathValue.add(n.outputs[0] as ValueId);
    else throw new LlvmEmitError(`"${n.diamond?.symbol}" is not in the native base set`);
  }
  const memberOf = (v: ValueId): { node: DucNode; name: string } | undefined => {
    const p = producer.get(resolve(v));
    if (p === undefined || p.kind !== "op" || !/^\.\w+$/.test(p.label ?? "")) return undefined;
    return { node: p, name: (p.label as string).slice(1) };
  };
  const isMath = (v: ValueId): boolean => mathValue.has(resolve(v));

  const params = g.nodes
    .filter((n) => n.kind === "param-source")
    .sort((a, b) => paramIndex(a.label) - paramIndex(b.label));

  const body: string[] = [];
  const globals: string[] = [];
  const used = new Set<string>();
  const slots = new Map<ValueId, string>();
  let temp = 0;
  let label = 0;
  const fresh = (): string => `%t${temp++}`;
  const freshLabel = (what: string): string => `${what}${label++}`;
  const emit = (line: string): void => void body.push(`  ${line}`);
  const block = (name: string): void => void body.push(`${name}:`);
  const slotOf = (v: ValueId): string => {
    let s = slots.get(v);
    if (s === undefined) {
      s = `%s${slots.size}`;
      slots.set(v, s);
    }
    return s;
  };
  const call = (fn: string, args: string): string => {
    used.add(fn);
    const r = fresh();
    emit(`${r} = call i64 @${fn}(${args})`);
    return r;
  };
  /** A constant string in the module, by its UTF-8 bytes: the pointer and the length. */
  const bytes = (text: string, nul = false): { ptr: string; length: number } => {
    const { body: b, length } = llvmBytes(text);
    const name = `@.str${globals.length}`;
    globals.push(
      `${name} = private unnamed_addr constant [${length + (nul ? 1 : 0)} x i8] c"${b}${nul ? "\\00" : ""}"`,
    );
    return { ptr: name, length };
  };
  /** A list of values in a stack array, for a runtime call that takes several. */
  // Stack arrays live in the entry block: one inside a loop would grow the stack each iteration.
  const entryAllocas: string[] = [];
  const list = (values: readonly string[]): string => {
    const at = fresh();
    entryAllocas.push(`  ${at} = alloca [${Math.max(values.length, 1)} x i64]`);
    values.forEach((v, i) => {
      const p = fresh();
      emit(
        `${p} = getelementptr [${Math.max(values.length, 1)} x i64], ptr ${at}, i64 0, i64 ${i}`,
      );
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
      if (text.startsWith('"')) {
        const s = bytes(JSON.parse(text) as string);
        return call("yk_string_utf8", `ptr ${s.ptr}, i64 ${s.length}`);
      }
      const n = Number(text.replace(/_/g, ""));
      if (text === "" || (Number.isNaN(n) && text !== "NaN"))
        throw new LlvmEmitError(`the literal ${text} is not in the subset yet`);
      return boxedNumber(n);
    }
    if (p?.kind === "diamond-source") throw new LlvmEmitError("Math is not a value here");
    const r = fresh();
    emit(`${r} = load i64, ptr ${slotOf(v)}`);
    return r;
  };
  const set = (v: ValueId, r: string): void => emit(`store i64 ${r}, ptr ${slotOf(v)}`);
  const truthy = (v: ValueId): string => {
    used.add("yk_truthy");
    const i = fresh();
    emit(`${i} = call i32 @yk_truthy(i64 ${operand(v)})`);
    const b = fresh();
    emit(`${b} = icmp ne i32 ${i}, 0`);
    return b;
  };

  const emitNode = (n: DucNode): void => {
    if (["literal-source", "param-source", "carry-source", "diamond-source"].includes(n.kind))
      return;
    if (n.closure !== undefined) throw new LlvmEmitError("a closure is not in the subset yet");
    const out = n.outputs[0] as ValueId | undefined;
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
    // A member read: of Math, nothing (the call names it); otherwise the property's value.
    const member = /^\.\w+$/.test(lbl) && ins.length === 1;
    if (member && isMath(ins[0] as ValueId)) return;
    if (member) {
      const name = bytes(lbl.slice(1));
      set(
        out,
        call(
          "yk_get_named",
          `i64 ${operand(ins[0] as ValueId)}, ptr ${name.ptr}, i64 ${name.length}`,
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
    if (lbl === "CallExpression") {
      const callee = memberOf(ins[0] as ValueId);
      if (callee === undefined)
        throw new LlvmEmitError("a call of anything but a method or Math is not in the subset yet");
      const args = ins.slice(1).map(operand);
      if (isMath(callee.node.inputs[0] as ValueId)) {
        if (MATH1.has(callee.name) && args.length === 1) {
          const name = bytes(callee.name, true);
          set(out, call("yk_math1", `ptr ${name.ptr}, i64 ${args[0]}`));
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
      if (!METHODS.has(callee.name))
        throw new LlvmEmitError(`the method .${callee.name} is not in the runtime yet`);
      const name = bytes(callee.name);
      const recv = operand(callee.node.inputs[0] as ValueId);
      set(
        out,
        call(
          "yk_call_method",
          `i64 ${recv}, ptr ${name.ptr}, i64 ${name.length}, i64 ${args.length}, ptr ${list(args)}`,
        ),
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
    if (lbl.startsWith("template:")) {
      const strings = (JSON.parse(lbl.slice("template:".length)) as string[]).map((t) => {
        const s = bytes(t);
        return call("yk_string_utf8", `ptr ${s.ptr}, i64 ${s.length}`);
      });
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
    for (const [side, name, input] of [
      ["t", thenL, 1],
      ["e", elseL, 2],
    ] as const) {
      block(name);
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

  params.forEach((p, i) => set(p.outputs[0] as ValueId, `%p${i}`));
  emitScope(undefined);
  emit(`ret i64 ${operand(g.obs[0] as ValueId)}`);

  const lines = [
    "; yakcc native lowering, boxed values (#1292)",
    `source_filename = "${symbol}"`,
    "",
    ...globals,
    "",
    `define i64 @${symbol}(${params.map((_, i) => `i64 %p${i}`).join(", ")}) {`,
    "entry:",
    ...[...slots.values()].map((s) => `  ${s} = alloca i64`),
    ...entryAllocas,
    ...body,
    "}",
    "",
    ...[...used].sort().map((f) => RUNTIME_DECLS[f] as string),
    "",
  ];
  return { ir: lines.join("\n"), symbol, params: params.map(() => "i64"), result: "i64" };
}
