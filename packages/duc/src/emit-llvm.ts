// SPDX-License-Identifier: Apache-2.0
/**
 * Lowering a graph directly to LLVM IR (#1292), from which a compiler backend writes the relocatable
 * object file a stock linker takes: x86-64, AArch64, ARM, RISC-V; ELF, Mach-O, COFF. The graph is
 * lowered directly, with no other high-level language in between.
 *
 * The subset is the typed one the WebAssembly lowering has (#1289): the contract's signature and the
 * graph's inferred types make every value a number (`double`) or a boolean (`i1`). The function is
 * exported under the platform's C calling convention: `double f(double, _Bool, …)`.
 *
 * JavaScript's semantics hold exactly. Arithmetic is IEEE `double`, and `%` is `frem`, which has the
 * remainder's sign and -0 as JavaScript's `%` does. Truthiness is JavaScript's: a number is falsy when
 * it is 0, -0 or NaN (`fcmp one x, 0`). `Math.floor`, `ceil`, `trunc`, `sqrt`, `abs` are the LLVM
 * intrinsics, `min`/`max` are written out (NaN wins; -0 is less than +0), and
 * `round` and `sign` are written out with JavaScript's ties and zeros. The other `Math` functions and
 * `**` are implementation-approximated in ECMAScript, so a native libm may differ from a JavaScript
 * engine in the last bit; they are refused here, with that reason, rather than lowered to a
 * different result.
 */
import { type DucType, parseType } from "./infer-types.js";
import { bodyPathOf, joinOwners, sidePath } from "./line-form.js";
import { loweringView } from "./ordering.js";
import { paramIndex } from "./params.js";
import { type ScopeItem, scopePlanner } from "./scopes.js";
import type { DucBranch, DucGraph, DucLoop, DucNode, ValueId } from "./types.js";

export class LlvmEmitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LlvmEmitError";
  }
}

export interface NativeSignature {
  /** The contract's input types, in parameter order. */
  readonly inputs: readonly string[];
  readonly output?: string;
}

type LType = "double" | "i1";
/** A value at the native boundary: a typed number or boolean, or a boxed value (emit-llvm-boxed.ts). */
export type NativeType = LType | "i64";

export interface LlvmModule {
  /** The module's text (`.ll`). */
  readonly ir: string;
  /** The exported symbol, as C names it. */
  readonly symbol: string;
  readonly params: readonly NativeType[];
  readonly result: NativeType;
}

const NATIVE_MATH: Readonly<Record<string, string>> = {
  floor: "llvm.floor.f64",
  ceil: "llvm.ceil.f64",
  trunc: "llvm.trunc.f64",
  sqrt: "llvm.sqrt.f64",
  abs: "llvm.fabs.f64",
};
const MATH_CONSTANTS: Readonly<Record<string, number>> = {
  PI: Math.PI,
  E: Math.E,
  LN2: Math.LN2,
  LN10: Math.LN10,
  LOG2E: Math.LOG2E,
  LOG10E: Math.LOG10E,
  SQRT2: Math.SQRT2,
  SQRT1_2: Math.SQRT1_2,
};
const APPROXIMATED = new Set([
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
  "atan2",
  "sinh",
  "cosh",
  "tanh",
  "asinh",
  "acosh",
  "atanh",
  "cbrt",
  "hypot",
  "pow",
]);
const COMPARE: Readonly<Record<string, string>> = {
  "<": "olt",
  ">": "ogt",
  "<=": "ole",
  ">=": "oge",
  "===": "oeq",
  "==": "oeq",
  "!==": "une",
  "!=": "une",
};
const BINARY: Readonly<Record<string, string>> = {
  "+": "fadd",
  "-": "fsub",
  "*": "fmul",
  "/": "fdiv",
  "%": "frem",
};

/** A double as LLVM writes it exactly: its IEEE bits in hexadecimal. */
function doubleConstant(x: number): string {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, x);
  return `0x${view.getBigUint64(0).toString(16).toUpperCase().padStart(16, "0")}`;
}

function ltype(t: DucType | undefined, what: string): LType {
  if (t === undefined) throw new LlvmEmitError(`${what} has no inferred type`);
  if (t.k === "num") return "double";
  if (t.k === "boolean") return "i1";
  if (t.k === "union" && t.of.length > 0) {
    const kinds = new Set(t.of.map((x) => ltype(x, what)));
    if (kinds.size === 1) return [...kinds][0] as LType;
  }
  throw new LlvmEmitError(`${what} is not a number or a boolean here`);
}

/** A symbol a linker takes: letters, digits and `_`. */
function isSymbol(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);
}

/** The graph lowered to an LLVM module exporting `symbol`. Throws LlvmEmitError outside the subset. */
export function emitLlvm(source: DucGraph, signature: NativeSignature, symbol = "f"): LlvmModule {
  if (!isSymbol(symbol)) throw new LlvmEmitError(`"${symbol}" is not a symbol a linker takes`);
  if (source.mode !== undefined)
    throw new LlvmEmitError(`an ${source.mode} function has no form here`);
  if (source.obs.length !== 1) throw new LlvmEmitError("the subset has exactly one result");
  const { graph: g } = loweringView(source);
  const owners = joinOwners(g);
  const producer = new Map<ValueId, DucNode>();
  for (const n of g.nodes) for (const v of n.outputs) producer.set(v, n);

  const alias = new Map<ValueId, ValueId>();
  for (const loop of g.nodes.filter((n) => n.kind === "loop")) {
    const rec = loop.loop as DucLoop;
    if (rec.iterate !== undefined) throw new LlvmEmitError("iteration is not in the subset");
    if (rec.cond === undefined) throw new LlvmEmitError("a loop with no condition");
    rec.invariant.forEach((v, j) => alias.set(v, loop.inputs[rec.carry.length + j] as ValueId));
  }
  const resolve = (v: ValueId): ValueId => {
    const a = alias.get(v);
    return a === undefined ? v : resolve(a);
  };
  const mathValue = new Set<ValueId>();
  const mathMember = new Map<ValueId, string>();
  for (const n of g.nodes) {
    if (n.kind !== "diamond-source") continue;
    if (n.diamond?.reason === "platform-primitive" && n.diamond.symbol === "Math") {
      mathValue.add(n.outputs[0] as ValueId);
      continue;
    }
    throw new LlvmEmitError(`"${n.diamond?.symbol}" is not in the native base set`);
  }
  // Inside a loop, Math arrives as an invariant standing for the outer value.
  for (const n of g.nodes)
    if (
      n.kind === "op" &&
      mathValue.has(resolve(n.inputs[0] as ValueId)) &&
      /^\.\w+$/.test(n.label ?? "")
    )
      mathMember.set(n.outputs[0] as ValueId, (n.label as string).slice(1));
  const called = new Set(
    g.nodes
      .filter((n) => n.kind === "op" && n.label === "CallExpression")
      .map((n) => resolve(n.inputs[0] as ValueId)),
  );

  const params = g.nodes
    .filter((n) => n.kind === "param-source")
    .sort((a, b) => paramIndex(a.label) - paramIndex(b.label));
  if (params.length !== signature.inputs.length)
    throw new LlvmEmitError("the signature and the graph have different parameter counts");
  const paramTypes: LType[] = params.map((_, i) =>
    ltype(parseType(signature.inputs[i] as string), `parameter ${i}`),
  );

  const planner = scopePlanner(g, owners, resolve, (m) => new LlvmEmitError(m));

  // Every value lives in a stack slot (an alloca in the entry block); LLVM promotes them to
  // registers. Instructions are written to `body`; the slots are declared before it.
  const body: string[] = [];
  const slots = new Map<ValueId, { name: string; type: LType }>();
  const known = new Map<ValueId, LType>();
  const intrinsics = new Set<string>();
  let temp = 0;
  let label = 0;
  const fresh = (): string => `%t${temp++}`;
  const freshLabel = (what: string): string => `${what}${label++}`;
  const emit = (line: string): void => void body.push(`  ${line}`);

  const slotOf = (v: ValueId, t: LType): string => {
    const s = slots.get(v);
    if (s !== undefined) {
      if (s.type !== t)
        throw new LlvmEmitError(`value ${v} is a number on one path and a boolean on another`);
      return s.name;
    }
    const name = `%s${slots.size}`;
    slots.set(v, { name, type: t });
    return name;
  };
  const typeOf = (v0: ValueId): LType => {
    const v = resolve(v0);
    const p = producer.get(v);
    if (p?.kind === "param-source") return paramTypes[paramIndex(p.label)] as LType;
    if (p?.kind === "literal-source")
      return p.label === "true" || p.label === "false" ? "i1" : "double";
    if (MATH_CONSTANTS[mathMember.get(v) ?? ""] !== undefined) return "double";
    const t = known.get(v);
    if (t === undefined) throw new LlvmEmitError(`value ${v} is used before it is computed`);
    return t;
  };

  /** A value as an operand: a constant, or a load of its slot. */
  const operand = (v0: ValueId): { t: LType; r: string } => {
    const v = resolve(v0);
    const constant = MATH_CONSTANTS[mathMember.get(v) ?? ""];
    if (constant !== undefined) return { t: "double", r: doubleConstant(constant) };
    const p = producer.get(v);
    if (p?.kind === "literal-source") {
      const text = p.label ?? "";
      if (text === "true" || text === "false") return { t: "i1", r: text };
      const n = Number(text.replace(/_/g, ""));
      if (text === "" || (Number.isNaN(n) && text !== "NaN"))
        throw new LlvmEmitError(`the literal ${text} is not a number or a boolean`);
      return { t: "double", r: doubleConstant(n) };
    }
    const t = typeOf(v);
    const r = fresh();
    emit(`${r} = load ${t}, ptr ${slotOf(v, t)}`);
    return { t, r };
  };
  /** A value as a number: a boolean is 0 or 1, as JavaScript converts it. */
  const number = (v: ValueId): string => {
    const o = operand(v);
    if (o.t === "double") return o.r;
    const r = fresh();
    emit(`${r} = uitofp i1 ${o.r} to double`);
    return r;
  };
  /** A value's truthiness, as JavaScript decides it: 0, -0 and NaN are falsy. */
  const truthy = (v: ValueId): string => {
    const o = operand(v);
    if (o.t === "i1") return o.r;
    const r = fresh();
    emit(`${r} = fcmp one double ${o.r}, 0.0`);
    return r;
  };
  const set = (v: ValueId, t: LType, r: string): void => {
    const was = known.get(v);
    if (was !== undefined && was !== t)
      throw new LlvmEmitError(`value ${v} is a number on one path and a boolean on another`);
    known.set(v, t);
    emit(`store ${t} ${r}, ptr ${slotOf(v, t)}`);
  };
  const sameType = (a: ValueId, b: ValueId, what: string): LType => {
    const ta = typeOf(a);
    if (typeOf(b) !== ta) throw new LlvmEmitError(`${what} mixes a number and a boolean`);
    return ta;
  };
  const call = (name: string, args: readonly string[]): string => {
    intrinsics.add(name);
    const r = fresh();
    emit(`${r} = call double @${name}(${args.map((a) => `double ${a}`).join(", ")})`);
    return r;
  };
  const op = (text: string): string => {
    const r = fresh();
    emit(`${r} = ${text}`);
    return r;
  };
  /**
   * JavaScript's Math.min / Math.max of two numbers, written out so every backend can select it:
   * NaN if either is NaN; otherwise the smaller (larger); and of two equal values, the one whose sign
   * min (max) prefers: OR (AND) of their bits gives -0 (+0) for a 0 and a -0, and either value when
   * they are the same.
   */
  const minMax = (name: "min" | "max", a: string, b: string): string => {
    const nan = op(`fcmp uno double ${a}, ${b}`);
    const pick = op(`fcmp ${name === "min" ? "olt" : "ogt"} double ${a}, ${b}`);
    const eq = op(`fcmp oeq double ${a}, ${b}`);
    const ia = op(`bitcast double ${a} to i64`);
    const ib = op(`bitcast double ${b} to i64`);
    const both = op(`${name === "min" ? "or" : "and"} i64 ${ia}, ${ib}`);
    const tie = op(`bitcast i64 ${both} to double`);
    const one = op(`select i1 ${pick}, double ${a}, double ${b}`);
    const two = op(`select i1 ${eq}, double ${tie}, double ${one}`);
    return op(`select i1 ${nan}, double 0x7FF8000000000000, double ${two}`);
  };

  const emitNode = (n: DucNode): void => {
    if (n.kind === "literal-source" || n.kind === "param-source" || n.kind === "carry-source")
      return;
    if (n.kind === "diamond-source") return;
    if (n.closure !== undefined) throw new LlvmEmitError("a closure is not in the subset");
    const out = n.outputs[0] as ValueId | undefined;
    if (out === undefined) throw new LlvmEmitError(`"${n.label}" has no result`);
    const lbl = n.label ?? "";
    const ins = n.inputs as readonly ValueId[];
    if (n.kind === "sel") {
      const [c, t, e] = ins as [ValueId, ValueId, ValueId];
      const ty = sameType(t, e, "a select");
      const cond = truthy(c);
      const a = operand(t).r;
      const b = operand(e).r;
      set(out, ty, op(`select i1 ${cond}, ${ty} ${a}, ${ty} ${b}`));
      return;
    }
    if (n.kind !== "op") throw new LlvmEmitError(`a ${n.kind} node is not in the subset`);
    if (mathMember.has(out)) {
      const name = mathMember.get(out) as string;
      if (MATH_CONSTANTS[name] === undefined && !called.has(out))
        throw new LlvmEmitError(`Math.${name} is not a constant or a called function`);
      return;
    }
    if (lbl === "CallExpression" && mathMember.has(resolve(ins[0] as ValueId))) {
      const name = mathMember.get(resolve(ins[0] as ValueId)) as string;
      const args = ins.slice(1);
      if (NATIVE_MATH[name] !== undefined && args.length === 1) {
        set(out, "double", call(NATIVE_MATH[name] as string, [number(args[0] as ValueId)]));
      } else if ((name === "min" || name === "max") && args.length >= 1) {
        let acc = number(args[0] as ValueId);
        for (const a of args.slice(1)) acc = minMax(name, acc, number(a));
        set(out, "double", acc);
      } else if (name === "round" && args.length === 1) {
        // JavaScript's round: ties toward +Infinity, and a zero result keeps the argument's sign
        // (`Math.round(-0.4)` is -0). floor(x + 0.5) is wrong at 0.49999999999999994.
        const x = number(args[0] as ValueId);
        const r = call("llvm.floor.f64", [x]);
        const diff = op(`fsub double ${x}, ${r}`);
        const up = op(`fcmp oge double ${diff}, 0x3FE0000000000000`);
        const r1 = op(`fadd double ${r}, 1.0`);
        const res = op(`select i1 ${up}, double ${r1}, double ${r}`);
        const zero = op(`fcmp oeq double ${res}, 0.0`);
        const signed = call("llvm.copysign.f64", ["0.0", x]);
        set(out, "double", op(`select i1 ${zero}, double ${signed}, double ${res}`));
      } else if (name === "sign" && args.length === 1) {
        // 1 or -1, and the argument itself for 0, -0 and NaN.
        const x = number(args[0] as ValueId);
        const pos = op(`fcmp ogt double ${x}, 0.0`);
        const neg = op(`fcmp olt double ${x}, 0.0`);
        const m = op(`select i1 ${neg}, double -1.0, double ${x}`);
        set(out, "double", op(`select i1 ${pos}, double 1.0, double ${m}`));
      } else if (APPROXIMATED.has(name)) {
        throw new LlvmEmitError(
          `Math.${name} is implementation-approximated in ECMAScript: a native libm need not give the reference's last bit`,
        );
      } else throw new LlvmEmitError(`Math.${name} is not in the subset`);
      return;
    }
    if (ins.length === 2 && BINARY[lbl] !== undefined) {
      const a = number(ins[0] as ValueId);
      const b = number(ins[1] as ValueId);
      set(out, "double", op(`${BINARY[lbl]} double ${a}, ${b}`));
      return;
    }
    if (ins.length === 2 && lbl === "**")
      throw new LlvmEmitError(
        "** is implementation-approximated in ECMAScript: a native pow need not give the reference's last bit",
      );
    if (ins.length === 2 && COMPARE[lbl] !== undefined) {
      const a = ins[0] as ValueId;
      const b = ins[1] as ValueId;
      const bothBool = typeOf(a) === "i1" && typeOf(b) === "i1";
      if (bothBool && /^[!=]==?$/.test(lbl)) {
        const x = operand(a).r;
        const y = operand(b).r;
        set(out, "i1", op(`icmp ${lbl.startsWith("!") ? "ne" : "eq"} i1 ${x}, ${y}`));
      } else if (!bothBool && typeOf(a) !== typeOf(b) && /^[!=]==$/.test(lbl)) {
        // A number and a boolean are never strictly equal.
        set(out, "i1", lbl.startsWith("!") ? "true" : "false");
      } else {
        const x = number(a);
        const y = number(b);
        set(out, "i1", op(`fcmp ${COMPARE[lbl]} double ${x}, ${y}`));
      }
      return;
    }
    if (ins.length === 1 && lbl === "-") {
      set(out, "double", op(`fneg double ${number(ins[0] as ValueId)}`));
      return;
    }
    if (ins.length === 1 && lbl === "+") {
      set(out, "double", number(ins[0] as ValueId));
      return;
    }
    if (ins.length === 1 && lbl === "!") {
      set(out, "i1", op(`xor i1 ${truthy(ins[0] as ValueId)}, true`));
      return;
    }
    if (ins.length === 2 && (lbl === "&&" || lbl === "||")) {
      // a && b is a when a is falsy, else b; a || b is a when a is truthy, else b.
      const [a, b] = ins as [ValueId, ValueId];
      const ty = sameType(a, b, `"${lbl}"`);
      const c = truthy(a);
      const x = operand(a).r;
      const y = operand(b).r;
      set(
        out,
        ty,
        op(
          lbl === "&&"
            ? `select i1 ${c}, ${ty} ${y}, ${ty} ${x}`
            : `select i1 ${c}, ${ty} ${x}, ${ty} ${y}`,
        ),
      );
      return;
    }
    throw new LlvmEmitError(`the operation "${lbl}" is not in the subset`);
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
  const block = (name: string): void => void body.push(`${name}:`);

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
      for (const j of joins) {
        const o = operand(j.inputs[input] as ValueId);
        set(j.outputs[0] as ValueId, o.t, o.r);
      }
      emit(`br label %${endL}`);
    }
    block(endL);
  };

  const emitLoop = (loop: DucNode): void => {
    const rec = loop.loop as DucLoop;
    const bodyPath = bodyPathOf(loop);
    rec.carry.forEach((c, i) => {
      const o = operand(loop.inputs[i] as ValueId);
      set(c, o.t, o.r);
    });
    const head = freshLabel("loop");
    const inner = freshLabel("body");
    const exit = freshLabel("exit");
    emit(`br label %${head}`);
    block(head);
    // What the condition needs is computed first; the loop ends when it is falsy.
    const items = planner.ordered(planner.itemsOf(bodyPath));
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
    // The next carries are computed together, then assigned.
    const next = rec.next.map((nv, i) => {
      const o = operand(nv);
      if (o.t !== typeOf(rec.carry[i] as ValueId))
        throw new LlvmEmitError("a loop's carry changes between a number and a boolean");
      return o;
    });
    next.forEach((o, i) => set(rec.carry[i] as ValueId, o.t, o.r));
    emit(`br label %${head}`);
    block(exit);
    loop.outputs.forEach((v, i) => {
      const o = operand(rec.carry[i] as ValueId);
      set(v, o.t, o.r);
    });
  };

  // The parameters go to their slots first.
  params.forEach((p, i) => set(p.outputs[0] as ValueId, paramTypes[i] as LType, `%p${i}`));
  emitScope(undefined);
  const result = operand(g.obs[0] as ValueId);
  emit(`ret ${result.t} ${result.r}`);
  if (
    signature.output !== undefined &&
    ltype(parseType(signature.output), "the result") !== result.t
  )
    throw new LlvmEmitError(
      `the result is ${result.t === "double" ? "a number" : "a boolean"}, and the contract says ${signature.output}`,
    );

  // A C `_Bool` travels zero-extended, as the platform ABIs say.
  const ret = (t: LType): string => (t === "i1" ? "zeroext i1" : "double");
  const param = (t: LType): string => (t === "i1" ? "i1 zeroext" : "double");
  const lines = [
    "; yakcc native lowering (#1292)",
    `source_filename = "${symbol}"`,
    "",
    `define ${ret(result.t)} @${symbol}(${paramTypes.map((t, i) => `${param(t)} %p${i}`).join(", ")}) nounwind {`,
    "entry:",
    ...[...slots.values()].map((s) => `  ${s.name} = alloca ${s.type}`),
    ...body,
    "}",
    "",
    ...[...intrinsics]
      .sort()
      .map((name) =>
        name === "llvm.copysign.f64"
          ? `declare double @${name}(double, double)`
          : `declare double @${name}(double)`,
      ),
    "",
  ];
  return { ir: lines.join("\n"), symbol, params: paramTypes, result: result.t };
}
