// SPDX-License-Identifier: Apache-2.0
/**
 * Lowering a graph directly to WebAssembly (#1289): the typed subset, where the contract's signature
 * and the graph's inferred types make every value a number (f64) or a boolean (i32). The module is
 * written as a binary here, with no other tool.
 *
 * Within the subset every operation is pure and total on f64 (a division by zero is Infinity, not a
 * trap), so the heap token's order is data dependency only, and is dropped (loweringView). Branches
 * become `if`, loops `block`/`loop`: the condition is computed from the carries before the body, and
 * the next carries are assigned together. JavaScript's own semantics hold:
 * - `Math.floor`, `ceil`, `trunc`, `sqrt`, `abs`, `min`, `max` are wasm's f64 instructions, which have
 *   the same IEEE semantics (NaN, -0);
 * - `%`, `**` and the other `Math` functions are imported from the host (`WASM_HOST`), whose results
 *   are JavaScript's by definition;
 * - truthiness is JavaScript's: a number is falsy when 0, -0 or NaN.
 * Anything else (strings, arrays, objects, free names, throws, closures, iteration) is refused, with
 * the reason.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emitLlvmBoxed } from "./emit-llvm-boxed.js";
import { type DucType, parseType } from "./infer-types.js";
import { bodyPathOf, joinOwners, sidePath } from "./line-form.js";
import { RUNTIME_SOURCE, compileObject } from "./native.js";
import { loweringView } from "./ordering.js";
import { paramIndex } from "./params.js";
import { type ScopeItem, scopePlanner } from "./scopes.js";
import type { DucBranch, DucGraph, DucLoop, DucNode, ValueId } from "./types.js";

export class WasmEmitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WasmEmitError";
  }
}

export interface WasmSignature {
  /** The contract's input types, in parameter order. */
  readonly inputs: readonly string[];
  readonly output?: string;
}

type WType = "f64" | "i32";

export interface WasmModule {
  readonly bytes: Uint8Array;
  /** The host functions the module imports, by name (from `WASM_HOST`). */
  readonly imports: readonly string[];
  readonly params: readonly WType[];
  readonly result: WType;
  /** True when the i32 result is a boolean. */
  readonly booleanResult: boolean;
}

/** The host functions a lowering may import: JavaScript's own operations. */
export const WASM_HOST: Readonly<Record<string, (...a: number[]) => number>> = {
  "%": (a, b) => (a as number) % (b as number),
  "**": (a, b) => (a as number) ** (b as number),
  ...Object.fromEntries(
    [
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
      "fround",
    ].map((name) => [
      `Math.${name}`,
      (...a: number[]) =>
        (Math as unknown as Record<string, (...x: number[]) => number>)[name]?.(...a) as number,
    ]),
  ),
};

/** Math members that are f64 instructions with JavaScript's semantics. */
const NATIVE_MATH: Readonly<Record<string, number>> = {
  floor: 0x9c,
  ceil: 0x9b,
  trunc: 0x9d,
  sqrt: 0x9f,
  abs: 0x99,
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

// --- binary encoding ---

const u32 = (n: number): number[] => {
  const out: number[] = [];
  let v = n >>> 0;
  do {
    let byte = v & 0x7f;
    v >>>= 7;
    if (v !== 0) byte |= 0x80;
    out.push(byte);
  } while (v !== 0);
  return out;
};
const s32 = (n: number): number[] => {
  const out: number[] = [];
  let v = n | 0;
  for (;;) {
    const byte = v & 0x7f;
    v >>= 7;
    if ((v === 0 && (byte & 0x40) === 0) || (v === -1 && (byte & 0x40) !== 0)) {
      out.push(byte);
      return out;
    }
    out.push(byte | 0x80);
  }
};
const f64 = (x: number): number[] => {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setFloat64(0, x, true);
  return [...b];
};
const str = (s: string): number[] => {
  const b = [...new TextEncoder().encode(s)];
  return [...u32(b.length), ...b];
};
const vec = (items: number[][]): number[] => [...u32(items.length), ...items.flat()];
const section = (id: number, body: number[]): number[] => [id, ...u32(body.length), ...body];
const VALTYPE: Record<WType, number> = { f64: 0x7c, i32: 0x7f };

const I = {
  get: 0x20,
  set: 0x21,
  i32const: 0x41,
  f64const: 0x44,
  select: 0x1b,
  if: 0x04,
  else: 0x05,
  end: 0x0b,
  block: 0x02,
  loop: 0x03,
  br: 0x0c,
  brIf: 0x0d,
  call: 0x10,
  i32eqz: 0x45,
  i32eq: 0x46,
  i32ne: 0x47,
  i32and: 0x71,
  i32or: 0x72,
  f64eq: 0x61,
  f64ne: 0x62,
  f64lt: 0x63,
  f64gt: 0x64,
  f64le: 0x65,
  f64ge: 0x66,
  f64neg: 0x9a,
  f64add: 0xa0,
  f64sub: 0xa1,
  f64mul: 0xa2,
  f64div: 0xa3,
  f64min: 0xa4,
  f64max: 0xa5,
  f64fromI32: 0xb7,
} as const;

const F64_BINARY: Readonly<Record<string, number>> = {
  "+": I.f64add,
  "-": I.f64sub,
  "*": I.f64mul,
  "/": I.f64div,
};
const F64_COMPARE: Readonly<Record<string, number>> = {
  "<": I.f64lt,
  ">": I.f64gt,
  "<=": I.f64le,
  ">=": I.f64ge,
  "===": I.f64eq,
  "==": I.f64eq,
  "!==": I.f64ne,
  "!=": I.f64ne,
};

function wtype(t: DucType | undefined, what: string): WType {
  if (t === undefined) throw new WasmEmitError(`${what} has no inferred type`);
  if (t.k === "num") return "f64";
  if (t.k === "boolean") return "i32";
  if (t.k === "union" && t.of.length > 0) {
    const kinds = new Set(t.of.map((x) => wtype(x, what)));
    if (kinds.size === 1) return [...kinds][0] as WType;
  }
  throw new WasmEmitError(`${what} is not a number or a boolean here`);
}

/** The graph lowered to a WebAssembly module exporting `f`. Throws WasmEmitError outside the subset. */
export function emitWasm(source: DucGraph, signature: WasmSignature): WasmModule {
  if (source.mode !== undefined)
    throw new WasmEmitError(`an ${source.mode} function has no form here`);
  if (source.obs.length !== 1) throw new WasmEmitError("the subset has exactly one result");
  const { graph: g } = loweringView(source);
  const branches = g.branches ?? [];
  const owners = joinOwners(g);
  const producer = new Map<ValueId, DucNode>();
  for (const n of g.nodes) for (const v of n.outputs) producer.set(v, n);

  // Loops: invariants read the outer value; carries are the loop's locals.
  const loops = g.nodes.filter((n) => n.kind === "loop");
  const alias = new Map<ValueId, ValueId>();
  for (const loop of loops) {
    const rec = loop.loop as DucLoop;
    if (rec.iterate !== undefined) throw new WasmEmitError("iteration is not in the subset");
    if (rec.cond === undefined) throw new WasmEmitError("a loop with no condition");
    rec.invariant.forEach((v, j) => alias.set(v, loop.inputs[rec.carry.length + j] as ValueId));
  }
  const resolve = (v: ValueId): ValueId => {
    const a = alias.get(v);
    return a === undefined ? v : resolve(a);
  };

  // Math members read from the Math primitive: not values, but what a call names.
  const mathValue = new Set<ValueId>();
  const mathMember = new Map<ValueId, string>();
  for (const n of g.nodes) {
    if (n.kind === "diamond-source") {
      if (n.diamond?.reason === "platform-primitive" && n.diamond.symbol === "Math") {
        mathValue.add(n.outputs[0] as ValueId);
        continue;
      }
      throw new WasmEmitError(`"${n.diamond?.symbol}" is not in the wasm base set`);
    }
  }
  for (const n of g.nodes) {
    // Inside a loop, Math arrives as an invariant standing for the outer value.
    if (
      n.kind === "op" &&
      mathValue.has(resolve(n.inputs[0] as ValueId)) &&
      /^\.\w+$/.test(n.label ?? "")
    )
      mathMember.set(n.outputs[0] as ValueId, (n.label as string).slice(1));
  }

  const calledValues = new Set(
    g.nodes
      .filter((n) => n.kind === "op" && n.label === "CallExpression")
      .map((n) => resolve(n.inputs[0] as ValueId)),
  );
  const isCalled = (v: ValueId): boolean => calledValues.has(v);

  // Locals: the parameters first, then one per value.
  const params = g.nodes
    .filter((n) => n.kind === "param-source")
    .sort((a, b) => paramIndex(a.label) - paramIndex(b.label));
  if (params.length !== signature.inputs.length)
    throw new WasmEmitError("the signature and the graph have different parameter counts");
  const local = new Map<ValueId, number>();
  const localTypes: WType[] = [];
  const paramTypes: WType[] = params.map((p, i) => {
    const t = wtype(parseType(signature.inputs[i] as string), `parameter ${i}`);
    local.set(p.outputs[0] as ValueId, i);
    return t;
  });
  // Each value's wasm type is the type of what computes it: known once it is set.
  const known = new Map<ValueId, WType>();
  const typeOf = (v0: ValueId): WType => {
    const v = resolve(v0);
    const p = producer.get(v);
    if (p?.kind === "param-source") return paramTypes[paramIndex(p.label)] as WType;
    if (p?.kind === "literal-source")
      return p.label === "true" || p.label === "false" ? "i32" : "f64";
    if (MATH_CONSTANTS[mathMember.get(v) ?? ""] !== undefined) return "f64";
    const t = known.get(v);
    if (t === undefined) throw new WasmEmitError(`value ${v} is used before it is computed`);
    return t;
  };
  const localOf = (v: ValueId, t: WType): number => {
    const at0 = local.get(v);
    if (at0 !== undefined) return at0;
    const at = params.length + localTypes.length;
    localTypes.push(t);
    local.set(v, at);
    return at;
  };

  const imports: string[] = [];
  const importIndex = (name: string): number => {
    if (WASM_HOST[name] === undefined) throw new WasmEmitError(`"${name}" is not a host function`);
    let at = imports.indexOf(name);
    if (at === -1) at = imports.push(name) - 1;
    return at;
  };
  const code: number[] = [];

  /** Push a value: a literal as a constant, else its local. */
  const push = (v0: ValueId): WType => {
    const v = resolve(v0);
    const constant = MATH_CONSTANTS[mathMember.get(v) ?? ""];
    if (constant !== undefined) {
      code.push(I.f64const, ...f64(constant));
      return "f64";
    }
    const p = producer.get(v);
    if (p?.kind === "literal-source") {
      const text = p.label ?? "";
      if (text === "true" || text === "false") {
        code.push(I.i32const, ...s32(text === "true" ? 1 : 0));
        return "i32";
      }
      const n = Number(text.replace(/_/g, ""));
      if (text === "" || (Number.isNaN(n) && text !== "NaN"))
        throw new WasmEmitError(`the literal ${text} is not a number or a boolean`);
      code.push(I.f64const, ...f64(n));
      return "f64";
    }
    const t = typeOf(v);
    code.push(I.get, ...u32(localOf(v, t)));
    return t;
  };
  /** Push a value as a number (a boolean is 0 or 1, as JavaScript converts it). */
  const pushNumber = (v: ValueId): void => {
    if (push(v) === "i32") code.push(I.f64fromI32);
  };
  /** Push a value's truthiness as an i32, as JavaScript decides it (0, -0 and NaN are falsy). */
  const truthy = (v: ValueId): void => {
    if (push(v) === "i32") return;
    // x !== 0 && x === x
    code.push(I.f64const, ...f64(0), I.f64ne);
    push(v);
    push(v);
    code.push(I.f64eq, I.i32and);
  };

  const set = (v: ValueId, t: WType): void => {
    const was = known.get(v);
    if (was !== undefined && was !== t)
      throw new WasmEmitError(`value ${v} is a number on one path and a boolean on another`);
    known.set(v, t);
    code.push(I.set, ...u32(localOf(v, t)));
  };
  /** The one wasm type of two values, or a refusal for a number mixed with a boolean. */
  const sameType = (a: ValueId, b: ValueId, what: string): WType => {
    const ta = typeOf(a);
    if (typeOf(b) !== ta) throw new WasmEmitError(`${what} mixes a number and a boolean`);
    return ta;
  };

  const emitNode = (n: DucNode): void => {
    if (n.kind === "literal-source" || n.kind === "param-source" || n.kind === "carry-source")
      return;
    if (n.kind === "diamond-source") return;
    if (n.closure !== undefined) throw new WasmEmitError("a closure is not in the subset");
    const out = n.outputs[0] as ValueId | undefined;
    if (out === undefined) throw new WasmEmitError(`"${n.label}" has no result`);
    const label = n.label ?? "";
    const ins = n.inputs as readonly ValueId[];
    if (n.kind === "sel") {
      const [c, t, e] = ins as [ValueId, ValueId, ValueId];
      const ty = sameType(t, e, "a select");
      push(t);
      push(e);
      truthy(c);
      code.push(I.select);
      set(out, ty);
      return;
    }
    if (n.kind !== "op") throw new WasmEmitError(`a ${n.kind} node is not in the subset`);
    if (mathMember.has(out)) {
      const name = mathMember.get(out) as string;
      // A constant is pushed where it is used; a function is named by the call that uses it.
      if (MATH_CONSTANTS[name] === undefined && !isCalled(out))
        throw new WasmEmitError(`Math.${name} is not a constant or a called function`);
      return;
    }
    if (label === "CallExpression" && mathMember.has(resolve(ins[0] as ValueId))) {
      const name = mathMember.get(resolve(ins[0] as ValueId)) as string;
      const args = ins.slice(1);
      if (NATIVE_MATH[name] !== undefined && args.length === 1) {
        pushNumber(args[0] as ValueId);
        code.push(NATIVE_MATH[name] as number);
      } else if ((name === "min" || name === "max") && args.length >= 1) {
        pushNumber(args[0] as ValueId);
        for (const a of args.slice(1)) {
          pushNumber(a);
          code.push(name === "min" ? I.f64min : I.f64max);
        }
      } else {
        const host = `Math.${name}`;
        for (const a of args) pushNumber(a);
        code.push(I.call, ...u32(importIndex(host)));
        hostArity.set(host, Math.max(hostArity.get(host) ?? 0, args.length));
      }
      set(out, "f64");
      return;
    }
    if (ins.length === 2 && F64_BINARY[label] !== undefined) {
      pushNumber(ins[0] as ValueId);
      pushNumber(ins[1] as ValueId);
      code.push(F64_BINARY[label] as number);
      set(out, "f64");
      return;
    }
    if (ins.length === 2 && (label === "%" || label === "**")) {
      pushNumber(ins[0] as ValueId);
      pushNumber(ins[1] as ValueId);
      code.push(I.call, ...u32(importIndex(label)));
      hostArity.set(label, 2);
      set(out, "f64");
      return;
    }
    if (ins.length === 2 && F64_COMPARE[label] !== undefined) {
      const a = ins[0] as ValueId;
      const b = ins[1] as ValueId;
      const bothBool = typeOf(a) === "i32" && typeOf(b) === "i32";
      if (bothBool && /^[!=]==?$/.test(label)) {
        push(a);
        push(b);
        code.push(label.startsWith("!") ? I.i32ne : I.i32eq);
      } else if (!bothBool && typeOf(a) !== typeOf(b) && /^[!=]==$/.test(label)) {
        // A number and a boolean are never strictly equal.
        code.push(I.i32const, ...s32(label.startsWith("!") ? 1 : 0));
      } else {
        pushNumber(a);
        pushNumber(b);
        code.push(F64_COMPARE[label] as number);
      }
      set(out, "i32");
      return;
    }
    if (ins.length === 1 && label === "-") {
      pushNumber(ins[0] as ValueId);
      code.push(I.f64neg);
      set(out, "f64");
      return;
    }
    if (ins.length === 1 && label === "+") {
      pushNumber(ins[0] as ValueId);
      set(out, "f64");
      return;
    }
    if (ins.length === 1 && label === "!") {
      truthy(ins[0] as ValueId);
      code.push(I.i32eqz);
      set(out, "i32");
      return;
    }
    if (ins.length === 2 && (label === "&&" || label === "||")) {
      // a && b is a when a is falsy, else b; a || b is a when a is truthy, else b.
      const [a, b] = ins as [ValueId, ValueId];
      const ty = sameType(a, b, `"${label}"`);
      if (label === "&&") {
        push(b);
        push(a);
      } else {
        push(a);
        push(b);
      }
      truthy(a);
      code.push(I.select);
      set(out, ty);
      return;
    }
    throw new WasmEmitError(`the operation "${label}" is not in the subset`);
  };
  const hostArity = new Map<string, number>();

  // Each scope's items in dependency order.
  type Item = ScopeItem;
  const { itemsOf, ordered, needsOf, producesOf } = scopePlanner(
    g,
    owners,
    resolve,
    (m) => new WasmEmitError(m),
  );

  const emitItems = (items: readonly Item[]): void => {
    for (const it of items) {
      if (it.kind === "node") emitNode(it.node);
      else if (it.kind === "branch") emitBranch(it.branch);
      else emitLoop(it.node);
    }
  };
  const emitScope = (scope: string | undefined): void => emitItems(ordered(itemsOf(scope)));

  const emitBranch = (b: DucBranch): void => {
    const joins = g.nodes.filter((n) => owners.get(n.id)?.id === b.id);
    truthy(b.cond);
    code.push(I.if, 0x40);
    emitScope(sidePath(b, "t"));
    for (const j of joins) set(j.outputs[0] as ValueId, push(j.inputs[1] as ValueId));
    code.push(I.else);
    emitScope(sidePath(b, "e"));
    for (const j of joins) set(j.outputs[0] as ValueId, push(j.inputs[2] as ValueId));
    code.push(I.end);
  };

  const emitLoop = (loop: DucNode): void => {
    const rec = loop.loop as DucLoop;
    const body = bodyPathOf(loop);
    // The carries start from the loop's inputs.
    rec.carry.forEach((c, i) => set(c, push(loop.inputs[i] as ValueId)));
    code.push(I.block, 0x40, I.loop, 0x40);
    // What the condition needs is computed first; the loop ends when it is falsy.
    const items = ordered(itemsOf(body));
    const forCond = new Set<Item>();
    const want = [resolve(rec.cond as ValueId)];
    const producedBy = new Map<ValueId, Item>();
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
    code.push(I.i32eqz, I.brIf, ...u32(1));
    emitItems(items.filter((it) => !forCond.has(it)));
    // The next carries, computed together, then assigned.
    for (const [i, nv] of rec.next.entries()) {
      if (push(nv) !== typeOf(rec.carry[i] as ValueId))
        throw new WasmEmitError("a loop's carry changes between a number and a boolean");
    }
    for (let i = rec.carry.length - 1; i >= 0; i--) {
      const c = rec.carry[i] as ValueId;
      set(c, typeOf(c));
    }
    code.push(I.br, ...u32(0), I.end, I.end);
    loop.outputs.forEach((v, i) => set(v, push(rec.carry[i] as ValueId)));
  };

  emitScope(undefined);
  const result = push(g.obs[0] as ValueId);
  code.push(I.end);
  if (signature.output !== undefined && wtype(parseType(signature.output), "the result") !== result)
    throw new WasmEmitError(
      `the result is ${result === "f64" ? "a number" : "a boolean"}, and the contract says ${signature.output}`,
    );

  // The module: types (imports' and f's), imports, one function, its export.
  const importTypes = imports.map((name) => [
    0x60,
    ...vec(Array.from({ length: hostArity.get(name) ?? 1 }, () => [VALTYPE.f64])),
    ...vec([[VALTYPE.f64]]),
  ]);
  const fType = [0x60, ...vec(paramTypes.map((t) => [VALTYPE[t]])), ...vec([[VALTYPE[result]]])];
  const types = section(1, vec([...importTypes, fType]));
  const importSec = section(
    2,
    vec(imports.map((name, i) => [...str("host"), ...str(name), 0x00, ...u32(i)])),
  );
  const funcSec = section(3, vec([u32(imports.length)]));
  const exportSec = section(7, vec([[...str("f"), 0x00, ...u32(imports.length)]]));
  const localsDecl = vec(localTypes.map((t) => [...u32(1), VALTYPE[t]]));
  const fnBody = [...localsDecl, ...code];
  const codeSec = section(10, vec([[...u32(fnBody.length), ...fnBody]]));
  const bytes = new Uint8Array([
    0x00,
    0x61,
    0x73,
    0x6d,
    0x01,
    0x00,
    0x00,
    0x00,
    ...types,
    ...(imports.length > 0 ? importSec : []),
    ...funcSec,
    ...exportSec,
    ...codeSec,
  ]);
  const booleanResult = result === "i32";
  return { bytes, imports, params: paramTypes, result, booleanResult };
}

/** The module instantiated with the host functions: `f` as JavaScript calls it. */
export async function instantiateWasm(
  m: WasmModule,
): Promise<(...args: unknown[]) => number | boolean> {
  const host: Record<string, (...a: number[]) => number> = {};
  for (const name of m.imports) host[name] = WASM_HOST[name] as (...a: number[]) => number;
  // The global WebAssembly of the runtime (typed here: the package's lib has no DOM types).
  const wasm = (
    globalThis as unknown as {
      WebAssembly: {
        instantiate(
          bytes: Uint8Array,
          imports: Record<string, unknown>,
        ): Promise<{ instance: { exports: Record<string, unknown> } }>;
      };
    }
  ).WebAssembly;
  const { instance } = await wasm.instantiate(m.bytes, { host });
  const f = instance.exports.f as (...a: number[]) => number;
  return (...args) => {
    const r = f(...args.map((a, i) => (m.params[i] === "i32" ? (a ? 1 : 0) : (a as number))));
    return m.booleanResult ? r !== 0 : r;
  };
}

// =================================================================================================
// Beyond the typed subset: boxed values in linear memory, with the native runtime (#1300)
//
// DEC-DUC-WASM-MEMORY-001 (proposed): strings, arrays, objects, closures and exceptions are lowered
// to wasm as the native lowering lowers them (DEC-DUC-NATIVE-RUNTIME-001). Every value is a
// NaN-boxed i64, and every operation is a call into the runtime, `runtime/yk.c`. That file is
// compiled unchanged for wasm32-wasi by clang, against a WASI sysroot. The graph goes to LLVM IR
// (`emitLlvmBoxed`), and LLVM's wasm32 backend writes the object. The heap is the module's linear
// memory, and the runtime's longjmp becomes wasm exception handling. One runtime and one value
// semantics serve every native target and wasm.
// =================================================================================================

/** Where the tools for the boxed wasm lowering are. */
export interface WasmToolchain {
  /** A WASI sysroot (wasi-libc): `include/` and `lib/wasm32-wasi/`. */
  readonly sysroot: string;
  /** compiler-rt's builtins for wasm32 (`libclang_rt.builtins-wasm32.a`). */
  readonly builtins: string;
  readonly clang?: string;
  readonly llc?: string;
  readonly wasmLd?: string;
}

/**
 * The toolchain the environment names (YAKCC_WASI_SYSROOT, YAKCC_WASM_BUILTINS), or undefined when
 * either is missing, so a caller can say what is needed instead of failing in a tool.
 */
export function wasmToolchainFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): WasmToolchain | undefined {
  const sysroot = env.YAKCC_WASI_SYSROOT;
  const builtins = env.YAKCC_WASM_BUILTINS;
  if (sysroot === undefined || builtins === undefined) return undefined;
  if (!existsSync(join(sysroot, "lib", "wasm32-wasi", "libc.a")) || !existsSync(builtins))
    return undefined;
  return { sysroot, builtins };
}

/**
 * LLVM 18 lowers setjmp/longjmp to wasm exceptions (`-mllvm -wasm-enable-sjlj`) by calling
 * `saveSetjmp`, `testSetjmp` and `getTempRet0`, as Emscripten defined them. wasi-libc's libsetjmp
 * has only the later names (`__wasm_setjmp`), from LLVM 19. These are the earlier ones. The throw
 * itself is wasi-libc's `__wasm_longjmp`, whose payload ({env, val}) LLVM 18's catch reads. A
 * toolchain with the later names links none of these.
 */
export const WASM_SJLJ_SHIM = `#include <stdint.h>
#include <stdlib.h>
typedef struct { uintptr_t id; uint32_t label; } yk_sjlj_entry;
static uint32_t yk_sjlj_next = 0;
static uint32_t yk_sjlj_temp = 0;
uint32_t getTempRet0(void) { return yk_sjlj_temp; }
void setTempRet0(uint32_t v) { yk_sjlj_temp = v; }
yk_sjlj_entry *saveSetjmp(uintptr_t *env, uint32_t label, yk_sjlj_entry *table, uint32_t size) {
  yk_sjlj_next++;
  *env = yk_sjlj_next;
  for (uint32_t i = 0; i < size; i++) {
    if (table[i].id == 0) {
      table[i].id = yk_sjlj_next;
      table[i].label = label;
      table[i + 1].id = 0;
      yk_sjlj_temp = size;
      return table;
    }
  }
  size *= 2;
  table = realloc(table, sizeof(yk_sjlj_entry) * (size + 1));
  table = saveSetjmp(env, label, table, size);
  yk_sjlj_temp = size;
  return table;
}
uint32_t testSetjmp(uintptr_t id, yk_sjlj_entry *table, uint32_t size) {
  for (uint32_t i = 0; i < size && table[i].id != 0; i++)
    if (table[i].id == id) return table[i].label;
  return 0;
}
`;

const WASM_TRIPLE = "wasm32-unknown-wasi";

function runTool(tool: string, args: readonly string[], what: string): void {
  const run = spawnSync(tool, args, { maxBuffer: 1 << 26 });
  if (run.error !== undefined)
    throw new WasmEmitError(`${tool} could not be run for ${what} (${run.error.message})`);
  if (run.status !== 0)
    throw new WasmEmitError(`${tool} failed for ${what}: ${run.stderr.toString().trim()}`);
}

/** The runtime (yk.c, unchanged) and the setjmp shim, compiled for wasm32-wasi, once per directory. */
function wasmRuntimeObjects(tc: WasmToolchain, dir: string): string[] {
  const yk = join(dir, "yk.o");
  const shim = join(dir, "sjlj.o");
  if (!existsSync(yk)) {
    const common = [`--target=${WASM_TRIPLE}`, `--sysroot=${tc.sysroot}`, "-O2", "-c"];
    runTool(
      tc.clang ?? "clang",
      [...common, "-std=c11", "-mllvm", "-wasm-enable-sjlj", RUNTIME_SOURCE, "-o", yk],
      "the runtime",
    );
    writeFileSync(join(dir, "sjlj.c"), WASM_SJLJ_SHIM);
    runTool(tc.clang ?? "clang", [...common, join(dir, "sjlj.c"), "-o", shim], "the setjmp shim");
  }
  return [yk, shim];
}

/**
 * A boxed graph lowered to a WASI command module: the function, the runtime and wasi-libc in one
 * linear memory. The command reads one call per line on stdin, its arguments in the runtime's text
 * form (`yk_read`), and writes each result (`yk_write`). An uncaught throw ends it with exit code
 * 70 and `Uncaught <value>` on stderr. It also exports the function, `f(i64, …) -> i64` on boxed
 * values. Refusals are emitLlvmBoxed's (LlvmEmitError); a missing tool is a WasmEmitError.
 */
export function emitWasmBoxed(source: DucGraph, tc: WasmToolchain, work?: string): Uint8Array {
  const m = emitLlvmBoxed(source);
  const dir = work ?? mkdtempSync(join(tmpdir(), "duc-wasm-"));
  const [yk, shim] = wasmRuntimeObjects(tc, dir);
  // Each build has its own directory and fixed file names: wasm-ld writes the output's name into
  // the module (its name section), and the same graph must give the same bytes.
  const build = mkdtempSync(join(dir, "build-"));
  const fo = join(build, "f.o");
  writeFileSync(
    fo,
    compileObject(m, { target: WASM_TRIPLE, ...(tc.llc !== undefined ? { llc: tc.llc } : {}) }),
  );
  const n = m.params.length;
  const main = join(dir, `main-${n}.c`);
  if (!existsSync(`${main}.o`)) {
    writeFileSync(
      main,
      [
        "#include <stdio.h>",
        "#include <stdint.h>",
        "typedef uint64_t yk;",
        `extern yk ${m.symbol}(${Array(n).fill("yk").join(", ") || "void"});`,
        "yk yk_read(FILE *); void yk_write(FILE *, yk);",
        `int main(void) { for (;;) { ${Array.from({ length: n }, (_, i) => `yk a${i} = yk_read(stdin);`).join(" ")} yk_write(stdout, ${m.symbol}(${Array.from({ length: n }, (_, i) => `a${i}`).join(", ")})); fputc('\\n', stdout); fflush(stdout); } }`,
      ].join("\n"),
    );
    runTool(
      tc.clang ?? "clang",
      [`--target=${WASM_TRIPLE}`, `--sysroot=${tc.sysroot}`, "-O2", "-c", main, "-o", `${main}.o`],
      "the command's main",
    );
  }
  const out = join(build, "module.wasm");
  const lib = join(tc.sysroot, "lib", "wasm32-wasi");
  runTool(
    tc.wasmLd ?? "wasm-ld",
    [
      join(lib, "crt1-command.o"),
      `${main}.o`,
      fo,
      yk as string,
      shim as string,
      `-L${lib}`,
      "-lc",
      "-lsetjmp",
      tc.builtins,
      `--export=${m.symbol}`,
      "-o",
      out,
    ],
    "the module",
  );
  return new Uint8Array(readFileSync(out));
}
