// SPDX-License-Identifier: Apache-2.0
/**
 * Lowering a graph to JVM class files (DEC-DUC-BYTECODE-TARGETS-001, #1311): the stack IR of
 * `lower-stack.ts`, the same one the WasmGC lowering encodes, written as JVM bytecode. The runtime's
 * operations are the same runtime atoms (`wasm-runtime-atoms.ts`), lowered by the same lowering; this
 * file supplies only the encoding and the primitives the atoms are written over.
 *
 * Values:
 * - a number is a `double`, a boolean an `int` (0 or 1);
 * - a string is a `java.lang.String`, UTF-16 as ECMAScript's strings are;
 * - an array of numbers is a `YkNums`, a class of two fields (its length and a growable `double[]`);
 * - a value of any kind is an `Object`: a `Double`, a `Boolean`, a `String`, a `YkNums`, `null`, or
 *   `Yk.UNDEF` (undefined, an object of its own).
 *
 * The classes are written directly (no Java source). They are class-file version 49, which a JVM
 * verifies by type inference, so the code carries no stack-map frames.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Ins,
  LoweringError,
  type StackProgram,
  type WT,
  lowerProgram,
} from "./lower-stack.js";
import type { DucGraph } from "./types.js";

/** A graph outside what the JVM lowering covers, with the reason. */
export class JvmEmitError extends Error {}

export interface JvmModule {
  /** The class files, by class name (`Yk`, whose static method `f` is the function, and `YkNums`). */
  readonly classes: ReadonlyMap<string, Uint8Array>;
  readonly params: readonly WT[];
  readonly result: WT;
  /** The runtime atoms the class contains, by name. */
  readonly atoms: readonly string[];
}

const MAIN = "Yk";
const NUMS = "YkNums";
const ARR = "YkArr";
const OBJ = "YkObj";
const OBJECT = "java/lang/Object";

/** Each type's JVM descriptor. */
const DESC: Record<WT, string> = {
  f64: "D",
  i32: "I",
  str: "Ljava/lang/String;",
  nums: `L${NUMS};`,
  arr: `L${ARR};`,
  obj: `L${OBJ};`,
  any: `L${OBJECT};`,
};
const width = (t: WT): number => (t === "f64" ? 2 : 1);
const methodDesc = (params: readonly WT[], result: WT | undefined): string =>
  `(${params.map((p) => DESC[p]).join("")})${result === undefined ? "V" : DESC[result]}`;
/** A function's method name: `f`, `atom$<name>`, `prim$<name>`, `host$<name>`. */
const methodName = (fn: string): string => fn.replace(":", "$").replace(/[.]/g, "_");

// --- the constant pool and the class file ---

const u2 = (n: number): number[] => [(n >> 8) & 0xff, n & 0xff];
const u4 = (n: number): number[] => [
  (n >>> 24) & 0xff,
  (n >>> 16) & 0xff,
  (n >>> 8) & 0xff,
  n & 0xff,
];

/** Modified UTF-8: each UTF-16 unit on its own (a lone surrogate included), and 0 as two bytes. */
function modifiedUtf8(s: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 1 && c <= 0x7f) out.push(c);
    else if (c <= 0x7ff) out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    else out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
  }
  if (out.length > 0xffff)
    throw new JvmEmitError("a string constant longer than a class file holds");
  return out;
}

class Pool {
  private readonly entries: number[][] = [];
  private readonly index = new Map<string, number>();
  private next = 1;

  private add(key: string, bytes: number[], slots = 1): number {
    const at = this.index.get(key);
    if (at !== undefined) return at;
    const i = this.next;
    this.entries.push(bytes);
    this.index.set(key, i);
    this.next += slots;
    return i;
  }
  utf8(s: string): number {
    const b = modifiedUtf8(s);
    return this.add(`u:${s}`, [1, ...u2(b.length), ...b]);
  }
  cls(name: string): number {
    return this.add(`c:${name}`, [7, ...u2(this.utf8(name))]);
  }
  str(s: string): number {
    return this.add(`s:${s}`, [8, ...u2(this.utf8(s))]);
  }
  int(n: number): number {
    return this.add(`i:${n}`, [3, ...u4(n)]);
  }
  dbl(x: number): number {
    const v = new DataView(new ArrayBuffer(8));
    v.setFloat64(0, x);
    const bytes = [...new Uint8Array(v.buffer)];
    return this.add(`d:${bytes.join(",")}`, [6, ...bytes], 2);
  }
  longConst(n: number): number {
    const v = new DataView(new ArrayBuffer(8));
    v.setBigInt64(0, BigInt(n));
    return this.add(`j:${n}`, [5, ...new Uint8Array(v.buffer)], 2);
  }
  private nat(name: string, desc: string): number {
    return this.add(`n:${name}:${desc}`, [12, ...u2(this.utf8(name)), ...u2(this.utf8(desc))]);
  }
  field(cls: string, name: string, desc: string): number {
    return this.add(`f:${cls}.${name}:${desc}`, [
      9,
      ...u2(this.cls(cls)),
      ...u2(this.nat(name, desc)),
    ]);
  }
  method(cls: string, name: string, desc: string): number {
    return this.add(`m:${cls}.${name}:${desc}`, [
      10,
      ...u2(this.cls(cls)),
      ...u2(this.nat(name, desc)),
    ]);
  }
  bytes(): number[] {
    if (this.next > 0xffff) throw new JvmEmitError("more constants than a class file holds");
    return [...u2(this.next), ...this.entries.flat()];
  }
}

interface MethodSpec {
  readonly name: string;
  readonly desc: string;
  readonly flags: number;
  readonly code: Asm;
}

function classFile(
  pool: Pool,
  name: string,
  fields: readonly { name: string; desc: string; flags: number }[],
  methods: readonly MethodSpec[],
): Uint8Array {
  const thisC = pool.cls(name);
  const superC = pool.cls(OBJECT);
  const codeName = pool.utf8("Code");
  const fieldBytes = fields.flatMap((f) => [
    ...u2(f.flags),
    ...u2(pool.utf8(f.name)),
    ...u2(pool.utf8(f.desc)),
    ...u2(0),
  ]);
  const methodBytes = methods.flatMap((m) => {
    const code = m.code.finish();
    if (code.length > 0xffff) throw new JvmEmitError(`${m.name} is longer than a method holds`);
    const attr = [
      ...u2(m.code.maxStack),
      ...u2(m.code.maxLocals),
      ...u4(code.length),
      ...code,
      ...u2(0), // exception table
      ...u2(0), // attributes
    ];
    return [
      ...u2(m.flags),
      ...u2(pool.utf8(m.name)),
      ...u2(pool.utf8(m.desc)),
      ...u2(1),
      ...u2(codeName),
      ...u4(attr.length),
      ...attr,
    ];
  });
  return new Uint8Array([
    0xca,
    0xfe,
    0xba,
    0xbe,
    ...u2(0),
    ...u2(49), // Java 5: verified by type inference, no stack-map frames
    ...pool.bytes(),
    ...u2(0x0021), // public super
    ...u2(thisC),
    ...u2(superC),
    ...u2(0), // interfaces
    ...u2(fields.length),
    ...fieldBytes,
    ...u2(methods.length),
    ...methodBytes,
    ...u2(0), // attributes
  ]);
}

// --- the assembler: bytecode, labels, and the stack depth ---

const OP = {
  aconst_null: 0x01,
  iconst_0: 0x03,
  iconst_1: 0x04,
  dconst_0: 0x0e,
  dconst_1: 0x0f,
  bipush: 0x10,
  sipush: 0x11,
  ldc_w: 0x13,
  ldc2_w: 0x14,
  iload: 0x15,
  dload: 0x18,
  aload: 0x19,
  istore: 0x36,
  dstore: 0x39,
  astore: 0x3a,
  daload: 0x31,
  aaload: 0x32,
  aastore: 0x53,
  anewarray: 0xbd,
  dastore: 0x52,
  pop: 0x57,
  pop2: 0x58,
  dup: 0x59,
  dup2: 0x5c,
  iadd: 0x60,
  isub: 0x64,
  dadd: 0x63,
  dsub: 0x67,
  dmul: 0x6b,
  ddiv: 0x6f,
  drem: 0x73,
  dneg: 0x77,
  ishl: 0x78,
  lushr: 0x7d,
  iand: 0x7e,
  land: 0x7f,
  i2d: 0x87,
  l2d: 0x8a,
  d2i: 0x8e,
  d2f: 0x90,
  f2d: 0x8d,
  i2c: 0x92,
  dcmpl: 0x97,
  dcmpg: 0x98,
  ifeq: 0x99,
  ifne: 0x9a,
  iflt: 0x9b,
  ifge: 0x9c,
  ifgt: 0x9d,
  ifle: 0x9e,
  if_icmpeq: 0x9f,
  if_icmpne: 0xa0,
  if_icmplt: 0xa1,
  if_icmpge: 0xa2,
  if_acmpeq: 0xa5,
  if_acmpne: 0xa6,
  goto: 0xa7,
  ireturn: 0xac,
  dreturn: 0xaf,
  areturn: 0xb0,
  return: 0xb1,
  getstatic: 0xb2,
  putstatic: 0xb3,
  getfield: 0xb4,
  putfield: 0xb5,
  invokevirtual: 0xb6,
  invokespecial: 0xb7,
  invokestatic: 0xb8,
  new: 0xbb,
  newarray: 0xbc,
  arraylength: 0xbe,
  checkcast: 0xc0,
  instanceof: 0xc1,
  ifnull: 0xc6,
  ifnonnull: 0xc7,
  wide: 0xc4,
} as const;

/** One method's code: bytes, forward and backward jumps to labels, and the deepest stack. */
class Asm {
  private readonly code: number[] = [];
  private readonly labelAt = new Map<number, number>();
  private readonly labelDepth = new Map<number, number>();
  private readonly fixups: { at: number; field: number; label: number }[] = [];
  private labels = 0;
  private depth = 0;
  maxStack = 0;
  maxLocals = 0;

  constructor(readonly pool: Pool) {}

  /** An instruction: its bytes, and what it does to the stack's depth (in slots). */
  op(bytes: readonly number[], delta: number): void {
    this.code.push(...bytes);
    this.depth += delta;
    if (this.depth < 0) throw new JvmEmitError("the stack underflows (a lowering error)");
    this.maxStack = Math.max(this.maxStack, this.depth);
  }
  label(): number {
    return this.labels++;
  }
  /** Place a label; after an unconditional jump the depth is the one the label was reached at. */
  place(l: number): void {
    this.labelAt.set(l, this.code.length);
    const d = this.labelDepth.get(l);
    if (d !== undefined) this.depth = d;
  }
  /** A jump to a label: `delta` is what the jump instruction pops. */
  jump(opcode: number, l: number, delta: number): void {
    const at = this.code.length;
    this.op([opcode, 0, 0], delta);
    this.fixups.push({ at, field: at + 1, label: l });
    if (!this.labelDepth.has(l)) this.labelDepth.set(l, this.depth);
  }
  locals(n: number): void {
    this.maxLocals = Math.max(this.maxLocals, n);
  }
  finish(): number[] {
    for (const f of this.fixups) {
      const to = this.labelAt.get(f.label);
      if (to === undefined) throw new JvmEmitError("a jump to a label never placed");
      const off = to - f.at;
      if (off < -0x8000 || off > 0x7fff) throw new JvmEmitError("a jump too far for a method");
      this.code[f.field] = (off >> 8) & 0xff;
      this.code[f.field + 1] = off & 0xff;
    }
    return this.code;
  }

  // --- conveniences ---
  iconst(n: number): void {
    if (n >= -1 && n <= 5) this.op([OP.iconst_0 + n], 1);
    else if (n >= -128 && n <= 127) this.op([OP.bipush, n & 0xff], 1);
    else if (n >= -32768 && n <= 32767) this.op([OP.sipush, ...u2(n & 0xffff)], 1);
    else this.op([OP.ldc_w, ...u2(this.pool.int(n))], 1);
  }
  dconst(x: number): void {
    if (Object.is(x, 0)) this.op([OP.dconst_0], 2);
    else if (x === 1) this.op([OP.dconst_1], 2);
    else this.op([OP.ldc2_w, ...u2(this.pool.dbl(x))], 2);
  }
  private slotOp(opcode: number, slot: number, delta: number): void {
    if (slot > 0xff) this.op([OP.wide, opcode, ...u2(slot)], delta);
    else this.op([opcode, slot], delta);
  }
  load(t: WT, slot: number): void {
    if (t === "f64") this.slotOp(OP.dload, slot, 2);
    else if (t === "i32") this.slotOp(OP.iload, slot, 1);
    else this.slotOp(OP.aload, slot, 1);
  }
  store(t: WT, slot: number): void {
    if (t === "f64") this.slotOp(OP.dstore, slot, -2);
    else if (t === "i32") this.slotOp(OP.istore, slot, -1);
    else this.slotOp(OP.astore, slot, -1);
  }
  /** A static call: pops its parameters, pushes its result. */
  invokestatic(cls: string, name: string, params: readonly WT[] | string, result?: WT): void {
    const desc = typeof params === "string" ? params : methodDesc(params, result);
    this.op([OP.invokestatic, ...u2(this.pool.method(cls, name, desc))], descDelta(desc, false));
  }
  invokevirtual(cls: string, name: string, desc: string): void {
    this.op([OP.invokevirtual, ...u2(this.pool.method(cls, name, desc))], descDelta(desc, true));
  }
  invokespecial(cls: string, name: string, desc: string): void {
    this.op([OP.invokespecial, ...u2(this.pool.method(cls, name, desc))], descDelta(desc, true));
  }
  getfield(cls: string, name: string, desc: string): void {
    this.op([OP.getfield, ...u2(this.pool.field(cls, name, desc))], slotsOf(desc) - 1);
  }
  putfield(cls: string, name: string, desc: string): void {
    this.op([OP.putfield, ...u2(this.pool.field(cls, name, desc))], -1 - slotsOf(desc));
  }
  getstatic(cls: string, name: string, desc: string): void {
    this.op([OP.getstatic, ...u2(this.pool.field(cls, name, desc))], slotsOf(desc));
  }
  checkcast(cls: string): void {
    this.op([OP.checkcast, ...u2(this.pool.cls(cls))], 0);
  }
  instanceOf(cls: string): void {
    this.op([OP.instanceof, ...u2(this.pool.cls(cls))], 0);
  }
  /** Push 1 when the jump's condition holds, else 0 (the condition's operands are on the stack). */
  bool(opcode: number, pops: number): void {
    const yes = this.label();
    const end = this.label();
    this.jump(opcode, yes, -pops);
    this.iconst(0);
    this.jump(OP.goto, end, 0);
    this.place(yes);
    this.iconst(1);
    this.place(end);
  }
}

/** The stack slots a field or value descriptor takes. */
const slotsOf = (desc: string): number => (desc === "D" || desc === "J" ? 2 : desc === "V" ? 0 : 1);

/** What a call does to the stack: pops its parameters (and a receiver), pushes its result. */
function descDelta(desc: string, receiver: boolean): number {
  const close = desc.indexOf(")");
  const params = desc.slice(1, close);
  let pops = receiver ? 1 : 0;
  for (let i = 0; i < params.length; i++) {
    const c = params[i];
    if (c === "D" || c === "J") pops += 2;
    else {
      pops += 1;
      while (params[i] === "[") i++;
      if (params[i] === "L") i = params.indexOf(";", i);
    }
  }
  return slotsOf(desc.slice(close + 1)) - pops;
}

// --- the IR encoded ---

/**
 * The `Math` functions `StrictMath` computes as V8 does, to the last place (checked on generated
 * arguments, `emit-jvm.test.ts`). `exp`, `cosh`, `cbrt`, `atan2` and `hypot` are not among them:
 * V8's differ from StrictMath's fdlibm in the last place (V8's `Math.exp(1)` is `Math.E`, fdlibm's is
 * one unit above it).
 */
const STRICT_MATH = new Set([
  "sin",
  "cos",
  "tan",
  "asin",
  "acos",
  "atan",
  "sinh",
  "tanh",
  "expm1",
  "log",
  "log1p",
  "log10",
  "pow",
]);

function encodeHost(a: Asm, name: string, arity: number): void {
  const fn = name.replace(/^Math\./, "");
  const desc = `(${"D".repeat(arity)})D`;
  if (name === "%") a.op([OP.drem], -2);
  else if (name === "**") a.invokestatic("java/lang/StrictMath", "pow", "(DD)D");
  else if (name === "Math.fround") a.op([OP.d2f, OP.f2d], 0);
  else if (name === "Math.round" || name === "Math.sign")
    a.invokestatic(MAIN, methodName(`host:${name}`), desc);
  else if (STRICT_MATH.has(fn)) {
    if (arity !== (fn === "pow" ? 2 : 1))
      throw new JvmEmitError(`Math.${fn} with ${arity} arguments is not in the subset yet`);
    a.invokestatic("java/lang/StrictMath", fn, desc);
  }
  // Classified (b): no JVM function computes these exactly as V8 does; they become runtime atoms
  // (ports of V8's algorithms), which every target then shares.
  else throw new JvmEmitError(`${name} has no exact counterpart on the JVM yet`);
}

/** A lowered function's code: the IR as bytecode, its locals in slots. */
function encodeFunction(
  pool: Pool,
  params: readonly WT[],
  locals: readonly WT[],
  result: WT,
  code: readonly Ins[],
  prog: StackProgram,
): Asm {
  const a = new Asm(pool);
  const types = [...params, ...locals];
  const slot: number[] = [];
  let next = 0;
  for (const t of types) {
    slot.push(next);
    next += width(t);
  }
  const scratchSlots = new Map<string, number>();
  const scratch = (t: WT, k: string): number => {
    const key = `${t}:${k}`;
    let s = scratchSlots.get(key);
    if (s === undefined) {
      s = next;
      next += width(t);
      scratchSlots.set(key, s);
    }
    return s;
  };
  const ctrl: { kind: "if" | "block" | "loop"; a: number; b: number; hasElse: boolean }[] = [];
  const target = (depth: number): number => {
    const c = ctrl[ctrl.length - 1 - depth];
    if (c === undefined) throw new JvmEmitError("a branch out of the function (a lowering error)");
    return c.kind === "loop" ? c.a : c.b;
  };
  const typeOf = (i: number): WT => types[i] as WT;
  for (const x of code) {
    switch (x.op) {
      case "const.f64":
        a.dconst(x.x);
        break;
      case "const.i32":
        a.iconst(x.x);
        break;
      case "const.str":
        a.op([OP.ldc_w, ...u2(pool.str(x.s))], 1);
        break;
      case "const.undef":
        a.getstatic(MAIN, "UNDEF", DESC.any);
        break;
      case "const.null":
        a.op([OP.aconst_null], 1);
        break;
      case "nums.of": {
        for (let i = x.n - 1; i >= 0; i--) a.store("f64", scratch("f64", `of${i}`));
        a.op([OP.new, ...u2(pool.cls(NUMS))], 1);
        a.op([OP.dup], 1);
        a.invokespecial(NUMS, "<init>", "()V");
        a.op([OP.dup], 1);
        a.iconst(x.n);
        a.putfield(NUMS, "len", "I");
        a.op([OP.dup], 1);
        a.iconst(x.n);
        a.op([OP.newarray, 7], 0); // T_DOUBLE
        for (let i = 0; i < x.n; i++) {
          a.op([OP.dup], 1);
          a.iconst(i);
          a.load("f64", scratch("f64", `of${i}`));
          a.op([OP.dastore], -4);
        }
        a.putfield(NUMS, "data", "[D");
        break;
      }
      case "arr.of": {
        for (let i = x.n - 1; i >= 0; i--) a.store("any", scratch("any", `of${i}`));
        a.op([OP.new, ...u2(pool.cls(ARR))], 1);
        a.op([OP.dup], 1);
        a.invokespecial(ARR, "<init>", "()V");
        a.op([OP.dup], 1);
        a.iconst(x.n);
        a.putfield(ARR, "len", "I");
        a.op([OP.dup], 1);
        a.iconst(x.n);
        a.op([OP.anewarray, ...u2(pool.cls(OBJECT))], 0);
        for (let i = 0; i < x.n; i++) {
          a.op([OP.dup], 1);
          a.iconst(i);
          a.load("any", scratch("any", `of${i}`));
          a.op([OP.aastore], -3);
        }
        a.putfield(ARR, "data", `[L${OBJECT};`);
        break;
      }
      case "arr.len":
        a.getfield(ARR, "len", "I");
        break;
      case "get":
        a.load(typeOf(x.i), slot[x.i] as number);
        break;
      case "set":
        a.store(typeOf(x.i), slot[x.i] as number);
        break;
      case "call": {
        if (x.fn.startsWith("host:")) {
          const host = x.fn.slice("host:".length);
          encodeHost(a, host, prog.hosts.get(host) ?? 1);
          break;
        }
        const f = prog.funcs.get(x.fn);
        if (f === undefined) throw new JvmEmitError(`no function ${x.fn}`);
        a.invokestatic(MAIN, methodName(x.fn), f.params, f.result);
        break;
      }
      case "f64":
        switch (x.name) {
          case "add":
            a.op([OP.dadd], -2);
            break;
          case "sub":
            a.op([OP.dsub], -2);
            break;
          case "mul":
            a.op([OP.dmul], -2);
            break;
          case "div":
            a.op([OP.ddiv], -2);
            break;
          case "neg":
            a.op([OP.dneg], 0);
            break;
          case "min":
          case "max":
            a.invokestatic("java/lang/Math", x.name, "(DD)D");
            break;
          case "floor":
          case "ceil":
          case "sqrt":
          case "abs":
            a.invokestatic("java/lang/Math", x.name, "(D)D");
            break;
          case "trunc": {
            // Toward zero: ceil below zero (and for NaN), floor otherwise; -0.5 is -0.
            const down = a.label();
            const end = a.label();
            a.op([OP.dup2], 2);
            a.dconst(0);
            a.op([OP.dcmpl], -3);
            a.jump(OP.ifge, down, -1);
            a.invokestatic("java/lang/Math", "ceil", "(D)D");
            a.jump(OP.goto, end, 0);
            a.place(down);
            a.invokestatic("java/lang/Math", "floor", "(D)D");
            a.place(end);
            break;
          }
          default: {
            // A comparison: dcmpg makes NaN greater (so < and <= are false), dcmpl less.
            const [cmp, jump] = {
              lt: [OP.dcmpg, OP.iflt],
              le: [OP.dcmpg, OP.ifle],
              gt: [OP.dcmpl, OP.ifgt],
              ge: [OP.dcmpl, OP.ifge],
              eq: [OP.dcmpl, OP.ifeq],
              ne: [OP.dcmpl, OP.ifne],
            }[x.name] as [number, number];
            a.op([cmp], -3);
            a.bool(jump, 1);
          }
        }
        break;
      case "i32":
        if (x.name === "and") a.op([OP.iand], -1);
        else if (x.name === "eqz") a.bool(OP.ifeq, 1);
        else a.bool(OP.if_icmpeq, 2);
        break;
      case "f64.of.i32":
        a.op([OP.i2d], 1);
        break;
      case "str.len":
        a.invokevirtual("java/lang/String", "length", "()I");
        break;
      case "nums.len":
        a.getfield(NUMS, "len", "I");
        break;
      case "to.any":
        if (x.from === "f64")
          a.invokestatic("java/lang/Double", "valueOf", "(D)Ljava/lang/Double;");
        else if (x.from === "i32")
          a.invokestatic("java/lang/Boolean", "valueOf", "(Z)Ljava/lang/Boolean;");
        break;
      case "from.any":
        if (x.to === "f64") {
          a.checkcast("java/lang/Double");
          a.invokevirtual("java/lang/Double", "doubleValue", "()D");
        } else if (x.to === "i32") {
          a.checkcast("java/lang/Boolean");
          a.invokevirtual("java/lang/Boolean", "booleanValue", "()Z");
        } else if (x.to === "str") a.checkcast("java/lang/String");
        else if (x.to === "nums") a.checkcast(NUMS);
        else if (x.to === "arr") a.checkcast(ARR);
        else if (x.to === "obj") a.checkcast(OBJ);
        break;
      case "ref.eq":
        a.bool(OP.if_acmpeq, 2);
        break;
      case "select": {
        // [a, b, cond]: a when cond is nonzero, else b.
        const c = scratch("i32", "selC");
        const sb = scratch(x.t, "selB");
        const sa = scratch(x.t, "selA");
        a.store("i32", c);
        a.store(x.t, sb);
        a.store(x.t, sa);
        const other = a.label();
        const end = a.label();
        a.load("i32", c);
        a.jump(OP.ifeq, other, -1);
        a.load(x.t, sa);
        a.jump(OP.goto, end, 0);
        a.place(other);
        a.load(x.t, sb);
        a.place(end);
        break;
      }
      case "drop":
        a.op([x.t === "f64" ? OP.pop2 : OP.pop], -width(x.t));
        break;
      case "if": {
        const c = { kind: "if" as const, a: a.label(), b: a.label(), hasElse: false };
        a.jump(OP.ifeq, c.a, -1);
        ctrl.push(c);
        break;
      }
      case "else": {
        const c = ctrl[ctrl.length - 1];
        if (c?.kind !== "if") throw new JvmEmitError("an else outside an if (a lowering error)");
        a.jump(OP.goto, c.b, 0);
        a.place(c.a);
        c.hasElse = true;
        break;
      }
      case "end": {
        const c = ctrl.pop();
        if (c === undefined) throw new JvmEmitError("an end outside a block (a lowering error)");
        if (c.kind === "if" && !c.hasElse) a.place(c.a);
        a.place(c.b);
        break;
      }
      case "block":
        ctrl.push({ kind: "block", a: -1, b: a.label(), hasElse: false });
        break;
      case "loop": {
        const start = a.label();
        a.place(start);
        ctrl.push({ kind: "loop", a: start, b: a.label(), hasElse: false });
        break;
      }
      case "br":
        a.jump(OP.goto, target(x.depth), 0);
        break;
      case "br_if":
        a.jump(OP.ifne, target(x.depth), -1);
        break;
    }
  }
  a.op(
    [result === "f64" ? OP.dreturn : result === "i32" ? OP.ireturn : OP.areturn],
    -width(result),
  );
  a.locals(next);
  return a;
}

// --- the primitives, written directly ---

/**
 * A primitive's code, as the WasmGC lowering's are: the same meaning (`RUNTIME_PRIMITIVES_JS`
 * defines it), written for the JVM.
 */
function primitiveCode(pool: Pool, key: string, params: readonly WT[], result: WT): Asm {
  const a = new Asm(pool);
  const slot: number[] = [];
  let next = 0;
  for (const t of params) {
    slot.push(next);
    next += width(t);
  }
  const p = (i: number): void => a.load(params[i] as WT, slot[i] as number);
  const local = (t: WT): number => {
    const s = next;
    next += width(t);
    return s;
  };
  const ret = (): void =>
    a.op(
      [result === "f64" ? OP.dreturn : result === "i32" ? OP.ireturn : OP.areturn],
      -width(result),
    );
  const nan = (): void => a.dconst(Number.NaN);
  /** An index from a number: toward zero, saturating, NaN 0 (as wasm's trunc_sat). */
  const index = (i: number): void => {
    p(i);
    a.op([OP.d2i], -1);
  };
  // The array operations, for an array of numbers or of any values.
  const kind: "nums" | "arr" = key.startsWith("arr") ? "arr" : "nums";
  const cls = kind === "nums" ? NUMS : ARR;
  const store = kind === "nums" ? "[D" : `[L${OBJECT};`;
  const elem: WT = kind === "nums" ? "f64" : "any";
  const data = (): void => {
    p(0);
    a.getfield(cls, "data", store);
  };
  const len = (): void => {
    p(0);
    a.getfield(cls, "len", "I");
  };
  const aload = (): void =>
    a.op([kind === "nums" ? OP.daload : OP.aaload], kind === "nums" ? 0 : -1);
  const astore = (): void =>
    a.op([kind === "nums" ? OP.dastore : OP.aastore], kind === "nums" ? -4 : -3);
  const newStore = (): void => {
    if (kind === "nums") a.op([OP.newarray, 7], 0);
    else a.op([OP.anewarray, ...u2(pool.cls(OBJECT))], 0);
  };
  /** The value an empty pop or a missing element gives: NaN in an atom's numbers, else undefined. */
  const missing = (): void => {
    if (key === "numsPop" || key === "numsGet") nan();
    else a.getstatic(MAIN, "UNDEF", DESC.any);
  };
  switch (key) {
    case "__ykUnit": {
      // charCodeAt: the unit at the index, NaN out of range.
      const k = local("i32");
      const out = a.label();
      index(1);
      a.store("i32", k);
      a.load("i32", k);
      a.jump(OP.iflt, out, -1);
      a.load("i32", k);
      p(0);
      a.invokevirtual("java/lang/String", "length", "()I");
      a.jump(OP.if_icmpge, out, -2);
      p(0);
      a.load("i32", k);
      a.invokevirtual("java/lang/String", "charAt", "(I)C");
      a.op([OP.i2d], 1);
      ret();
      a.place(out);
      nan();
      ret();
      break;
    }
    case "__ykSub":
      p(0);
      index(1);
      index(2);
      a.invokevirtual("java/lang/String", "substring", "(II)Ljava/lang/String;");
      ret();
      break;
    case "__ykJoin":
      p(0);
      p(1);
      a.invokevirtual("java/lang/String", "concat", "(Ljava/lang/String;)Ljava/lang/String;");
      ret();
      break;
    case "__ykChar":
      index(0);
      a.op([OP.i2c], 0);
      a.invokestatic("java/lang/String", "valueOf", "(C)Ljava/lang/String;");
      ret();
      break;
    case "__ykF64Hi":
    case "__ykF64Lo":
      p(0);
      a.invokestatic("java/lang/Double", "doubleToRawLongBits", "(D)J");
      if (key === "__ykF64Hi") {
        a.iconst(32);
        a.op([OP.lushr], -1);
      } else {
        a.op([OP.ldc2_w, ...u2(pool.longConst(0xffffffff))], 2);
        a.op([OP.land], -2);
      }
      a.op([OP.l2d], 0);
      ret();
      break;
    case "__ykPow2":
      // 2^e exactly: scalb rounds once, and 2^e needs no rounding (0 or Infinity outside).
      a.dconst(1);
      index(0);
      a.invokestatic("java/lang/Math", "scalb", "(DI)D");
      ret();
      break;
    case "__ykTag": {
      // undefined 0, null 1, a boolean 2, a number 3, a string 4, an array 5.
      const kinds: [string, number][] = [
        ["java/lang/Boolean", 2],
        ["java/lang/Double", 3],
        ["java/lang/String", 4],
        [NUMS, 5],
        [OBJ, 7],
      ];
      const notNull = a.label();
      p(0);
      a.jump(OP.ifnonnull, notNull, -1);
      a.dconst(1);
      ret();
      a.place(notNull);
      const notUndef = a.label();
      p(0);
      a.getstatic(MAIN, "UNDEF", DESC.any);
      a.jump(OP.if_acmpne, notUndef, -2);
      a.dconst(0);
      ret();
      a.place(notUndef);
      for (const [cls, tag] of kinds) {
        const no = a.label();
        p(0);
        a.instanceOf(cls);
        a.jump(OP.ifeq, no, -1);
        a.dconst(tag);
        ret();
        a.place(no);
      }
      a.dconst(6);
      ret();
      break;
    }
    case "__ykNum":
      p(0);
      a.checkcast("java/lang/Double");
      a.invokevirtual("java/lang/Double", "doubleValue", "()D");
      ret();
      break;
    case "__ykBool":
      p(0);
      a.checkcast("java/lang/Boolean");
      a.invokevirtual("java/lang/Boolean", "booleanValue", "()Z");
      ret();
      break;
    case "__ykStr":
      p(0);
      a.checkcast("java/lang/String");
      ret();
      break;
    case "__ykArr":
      p(0);
      a.checkcast(NUMS);
      ret();
      break;
    case "__ykObj":
      p(0);
      a.checkcast(OBJ);
      ret();
      break;
    case "__ykObjNew": {
      // A new object of the class: two empty arrays.
      const emptyArr = (): void => {
        a.op([OP.new, ...u2(pool.cls(ARR))], 1);
        a.op([OP.dup], 1);
        a.invokespecial(ARR, "<init>", "()V");
        a.op([OP.dup], 1);
        a.iconst(0);
        a.op([OP.anewarray, ...u2(pool.cls(OBJECT))], 0);
        a.putfield(ARR, "data", `[L${OBJECT};`);
      };
      a.op([OP.new, ...u2(pool.cls(OBJ))], 1);
      a.op([OP.dup], 1);
      a.invokespecial(OBJ, "<init>", "()V");
      a.op([OP.dup], 1);
      emptyArr();
      a.putfield(OBJ, "keys", DESC.arr);
      a.op([OP.dup], 1);
      emptyArr();
      a.putfield(OBJ, "vals", DESC.arr);
      a.op([OP.dup], 1);
      p(0);
      a.putfield(OBJ, "cls", DESC.any);
      ret();
      break;
    }
    case "__ykObjKeys":
    case "__ykObjVals":
    case "__ykObjCls": {
      const field = key === "__ykObjKeys" ? "keys" : key === "__ykObjVals" ? "vals" : "cls";
      p(0);
      a.getfield(OBJ, field, field === "cls" ? DESC.any : DESC.arr);
      ret();
      break;
    }
    case "__ykUndef":
      a.getstatic(MAIN, "UNDEF", DESC.any);
      ret();
      break;
    case "__ykTypeError":
      // Thrown, until exceptions are lowered: the program stops where ECMAScript throws.
      a.op([OP.new, ...u2(pool.cls("java/lang/IllegalStateException"))], 1);
      a.op([OP.dup], 1);
      a.invokespecial("java/lang/IllegalStateException", "<init>", "()V");
      a.op([0xbf], -1); // athrow
      break;
    case "__ykArrAny":
      p(0);
      a.checkcast(ARR);
      ret();
      break;
    case "__ykSame":
      p(0);
      p(1);
      a.bool(OP.if_acmpeq, 2);
      ret();
      break;
    case "numsPush":
    case "arrPush": {
      // When full, grow to 2 len + 4; data[len] = x; len = len + 1; the new length.
      const n = local("i32");
      const grown = local("any");
      const room = a.label();
      len();
      a.store("i32", n);
      a.load("i32", n);
      data();
      a.op([OP.arraylength], 0);
      a.jump(OP.if_icmplt, room, -2);
      a.load("i32", n);
      a.iconst(1);
      a.op([OP.ishl], -1);
      a.iconst(4);
      a.op([OP.iadd], -1);
      newStore();
      a.store("any", grown);
      data();
      a.iconst(0);
      a.load("any", grown);
      a.iconst(0);
      a.load("i32", n);
      a.invokestatic("java/lang/System", "arraycopy", "(Ljava/lang/Object;ILjava/lang/Object;II)V");
      p(0);
      a.load("any", grown);
      a.putfield(cls, "data", store);
      a.place(room);
      data();
      a.load("i32", n);
      p(1);
      astore();
      p(0);
      a.load("i32", n);
      a.iconst(1);
      a.op([OP.iadd], -1);
      a.putfield(cls, "len", "I");
      a.load("i32", n);
      a.iconst(1);
      a.op([OP.iadd], -1);
      a.op([OP.i2d], 1);
      ret();
      break;
    }
    case "numsPop":
    case "numsPopAny":
    case "arrPop": {
      // An empty array pops undefined (NaN stands for it in an atom, and is never observed).
      const n = local("i32");
      const some = a.label();
      len();
      a.jump(OP.ifne, some, -1);
      missing();
      ret();
      a.place(some);
      len();
      a.iconst(1);
      a.op([OP.isub], -1);
      a.store("i32", n);
      p(0);
      a.load("i32", n);
      a.putfield(cls, "len", "I");
      data();
      a.load("i32", n);
      aload();
      if (key === "numsPopAny")
        a.invokestatic("java/lang/Double", "valueOf", "(D)Ljava/lang/Double;");
      ret();
      break;
    }
    case "numsGet":
    case "numsAt":
    case "arrAt": {
      // An index that is an integer in [0, length) reads the element; any other reads undefined
      // (NaN stands for it in an atom's numsGet; numsAt is a program's, and gives undefined).
      const k = local("i32");
      const out = a.label();
      index(1);
      a.store("i32", k);
      a.load("i32", k);
      a.op([OP.i2d], 1);
      p(1);
      a.op([OP.dcmpl], -3);
      a.jump(OP.ifne, out, -1);
      a.load("i32", k);
      a.jump(OP.iflt, out, -1);
      a.load("i32", k);
      len();
      a.jump(OP.if_icmpge, out, -2);
      data();
      a.load("i32", k);
      aload();
      if (key === "numsAt") a.invokestatic("java/lang/Double", "valueOf", "(D)Ljava/lang/Double;");
      ret();
      a.place(out);
      missing();
      ret();
      break;
    }
    case "numsSet":
    case "arrSet": {
      // a[i] = v within the array, or at its end (a push); anywhere else is not lowered.
      const k = local("i32");
      const inside = a.label();
      const end = a.label();
      index(1);
      a.store("i32", k);
      a.load("i32", k);
      len();
      a.jump(OP.if_icmpne, inside, -2);
      p(0);
      p(2);
      a.invokestatic(MAIN, methodName(`prim:${kind}Push`), [kind, elem], "f64");
      a.op([OP.pop2], -2);
      a.jump(OP.goto, end, 0);
      a.place(inside);
      data();
      a.load("i32", k);
      p(2);
      astore();
      a.place(end);
      p(0);
      ret();
      break;
    }
    default:
      throw new JvmEmitError(`no JVM primitive ${key}`);
  }
  a.locals(next);
  return a;
}

/** Math.round and Math.sign, as ECMAScript defines them. */
function hostHelper(pool: Pool, name: string): Asm {
  const a = new Asm(pool);
  const x = (): void => a.load("f64", 0);
  const ret = (): void => a.op([OP.dreturn], -2);
  if (name === "Math.sign") {
    // NaN, -0 and +0 are themselves; otherwise -1 or 1.
    const pos = a.label();
    const neg = a.label();
    x();
    a.dconst(0);
    a.op([OP.dcmpl], -3);
    a.jump(OP.ifgt, pos, -1);
    x();
    a.dconst(0);
    a.op([OP.dcmpg], -3);
    a.jump(OP.iflt, neg, -1);
    x();
    ret();
    a.place(pos);
    a.dconst(1);
    ret();
    a.place(neg);
    a.dconst(-1);
    ret();
  } else {
    // The integer closest to x, ties toward +Infinity: floor(x + 0.5), except where that sum
    // rounds (x within 0.5 of a large odd integer is itself), and -0 for x in [-0.5, -0].
    const small = a.label();
    const asIs = a.label();
    // |x| >= 2^52, NaN, or an infinity: x is an integer (or NaN) already.
    x();
    a.invokestatic("java/lang/Math", "abs", "(D)D");
    a.dconst(2 ** 52);
    a.op([OP.dcmpl], -3);
    a.jump(OP.ifge, asIs, -1);
    x();
    x();
    a.op([OP.dcmpl], -3);
    a.jump(OP.ifne, asIs, -1);
    // x in [-0.5, 0): -0.
    x();
    a.dconst(-0.5);
    a.op([OP.dcmpl], -3);
    a.jump(OP.iflt, small, -1);
    x();
    a.dconst(0);
    a.op([OP.dcmpg], -3);
    a.jump(OP.ifge, small, -1);
    a.dconst(-0);
    ret();
    a.place(small);
    // floor(x), plus 1 when x - floor(x) >= 0.5 (exact: no sum that rounds).
    const fl = 2;
    x();
    a.invokestatic("java/lang/Math", "floor", "(D)D");
    a.store("f64", fl);
    const down = a.label();
    x();
    a.load("f64", fl);
    a.op([OP.dsub], -2);
    a.dconst(0.5);
    a.op([OP.dcmpl], -3);
    a.jump(OP.iflt, down, -1);
    a.load("f64", fl);
    a.dconst(1);
    a.op([OP.dadd], -2);
    ret();
    a.place(down);
    a.load("f64", fl);
    ret();
    a.place(asIs);
    x();
    ret();
    a.locals(4);
    return a;
  }
  a.locals(2);
  return a;
}

/** The class of an array: its length, its storage, and a constructor. */
function arrayClass(name: string, store: string): Uint8Array {
  return dataClass(name, [
    { name: "len", desc: "I" },
    { name: "data", desc: store },
  ]);
}

/** A class of public fields and a constructor that sets none of them. */
function dataClass(name: string, fields: readonly { name: string; desc: string }[]): Uint8Array {
  const pool = new Pool();
  const init = new Asm(pool);
  init.load("any", 0);
  init.invokespecial(OBJECT, "<init>", "()V");
  init.op([OP.return], 0);
  init.locals(1);
  return classFile(
    pool,
    name,
    fields.map((f) => ({ ...f, flags: 0x0001 })),
    [{ name: "<init>", desc: "()V", flags: 0x0001, code: init }],
  );
}

/**
 * The graph lowered to JVM classes: `Yk`, whose static method `f` is the function, with the
 * runtime atoms and primitives it reaches, and `YkNums`. The signature's output type is required.
 */
export function emitJvm(
  input: DucGraph,
  signature: { readonly inputs: readonly string[]; readonly output?: string },
): JvmModule {
  let prog: StackProgram;
  try {
    prog = lowerProgram(input, signature);
  } catch (e) {
    if (e instanceof LoweringError) throw new JvmEmitError(e.message);
    throw e;
  }
  const pool = new Pool();
  const methods: MethodSpec[] = [];
  for (const [k, f] of prog.funcs) {
    const code =
      f.kind === "lowered"
        ? encodeFunction(pool, f.params, f.locals, f.result, f.code, prog)
        : primitiveCode(pool, k.slice("prim:".length), f.params, f.result);
    methods.push({
      name: methodName(k),
      desc: methodDesc(f.params, f.result),
      flags: 0x0009,
      code,
    });
  }
  for (const h of ["Math.round", "Math.sign"])
    if (prog.hosts.has(h))
      methods.push({
        name: methodName(`host:${h}`),
        desc: "(D)D",
        flags: 0x0009,
        code: hostHelper(pool, h),
      });
  // undefined: an object of its own.
  const clinit = new Asm(pool);
  clinit.op([OP.new, ...u2(pool.cls(OBJECT))], 1);
  clinit.op([OP.dup], 1);
  clinit.invokespecial(OBJECT, "<init>", "()V");
  clinit.op([OP.putstatic, ...u2(pool.field(MAIN, "UNDEF", DESC.any))], -1);
  clinit.op([OP.return], 0);
  methods.push({ name: "<clinit>", desc: "()V", flags: 0x0008, code: clinit });
  const main = classFile(pool, MAIN, [{ name: "UNDEF", desc: DESC.any, flags: 0x0019 }], methods);
  const f = prog.funcs.get("f");
  if (f?.kind !== "lowered") throw new JvmEmitError("no function f");
  return {
    classes: new Map([
      [MAIN, main],
      [NUMS, arrayClass(NUMS, "[D")],
      [ARR, arrayClass(ARR, `[L${OBJECT};`)],
      [
        OBJ,
        dataClass(OBJ, [
          { name: "keys", desc: DESC.arr },
          { name: "vals", desc: DESC.arr },
          { name: "cls", desc: DESC.any },
        ]),
      ],
    ]),
    params: f.params,
    result: f.result,
    atoms: [...prog.atoms],
  };
}

// --- running on a JVM ---

/**
 * The harness that calls `Yk.f` on each line of its input and writes each result. A value is
 * written as: `u` undefined, `l` null, `t`/`f` a boolean, `n` and a double's 16 hex digits, `s` and
 * a string's UTF-16 units (4 hex digits each), `a` and an array's elements (16 hex digits each); a
 * call that throws writes `!` and the exception. Test tooling only: the lowering writes no Java.
 */
const HARNESS = `import java.io.*;
import java.lang.reflect.*;
public class YkHarness {
  static Class<?> nums, arr, obj;
  static Object undef;
  public static void main(String[] argv) throws Exception {
    Class<?> yk = Class.forName("Yk");
    nums = Class.forName("YkNums");
    arr = Class.forName("YkArr");
    obj = Class.forName("YkObj");
    undef = yk.getField("UNDEF").get(null);
    Method f = null;
    for (Method m : yk.getMethods()) if (m.getName().equals("f")) f = m;
    Class<?>[] pt = f.getParameterTypes();
    BufferedReader in = new BufferedReader(new InputStreamReader(System.in, "UTF-8"));
    PrintStream out = new PrintStream(new BufferedOutputStream(System.out), false, "UTF-8");
    String line;
    while ((line = in.readLine()) != null) {
      String[] parts = line.split("\\t", -1);
      Object[] args = new Object[pt.length];
      for (int i = 0; i < pt.length; i++) args[i] = dec(parts[i], pt[i]);
      try {
        out.println(enc(f.invoke(null, args), f.getReturnType()));
      } catch (InvocationTargetException e) {
        out.println("!" + e.getCause());
      }
    }
    out.flush();
  }
  static double bits(String h) { return Double.longBitsToDouble(Long.parseUnsignedLong(h, 16)); }
  static Object dec(String s, Class<?> t) throws Exception {
    char k = s.charAt(0);
    String r = s.substring(1);
    if (t == double.class) return bits(r);
    if (t == int.class) return k == 't' ? 1 : 0;
    switch (k) {
      case 'u': return undef;
      case 'l': return null;
      case 't': return Boolean.TRUE;
      case 'f': return Boolean.FALSE;
      case 'n': return bits(r);
      case 'O': {
        Object keys = dec("A" + r, Object.class);
        Object[] kv = (Object[]) arr.getField("data").get(keys);
        int n = arr.getField("len").getInt(keys) / 2;
        Object[] ks = new Object[n], vs = new Object[n];
        for (int i = 0; i < n; i++) { ks[i] = kv[2 * i]; vs[i] = kv[2 * i + 1]; }
        Object o = obj.getConstructor().newInstance();
        obj.getField("keys").set(o, mkArr(ks));
        obj.getField("vals").set(o, mkArr(vs));
        return o;
      }
      case 'A': {
        java.util.List<Object> xs = new java.util.ArrayList<>();
        int at = 0;
        while (at < r.length()) {
          int colon = r.indexOf(':', at);
          int n = Integer.parseInt(r.substring(at, colon));
          xs.add(dec(r.substring(colon + 1, colon + 1 + n), Object.class));
          at = colon + 1 + n;
        }
        Object o = arr.getConstructor().newInstance();
        arr.getField("len").setInt(o, xs.size());
        arr.getField("data").set(o, xs.toArray());
        return o;
      }
      case 's': {
        char[] c = new char[r.length() / 4];
        for (int i = 0; i < c.length; i++) c[i] = (char) Integer.parseInt(r.substring(4 * i, 4 * i + 4), 16);
        return new String(c);
      }
      default: {
        int n = r.length() / 16;
        double[] d = new double[n];
        for (int i = 0; i < n; i++) d[i] = bits(r.substring(16 * i, 16 * i + 16));
        Object o = nums.getConstructor().newInstance();
        nums.getField("len").setInt(o, n);
        nums.getField("data").set(o, d);
        return o;
      }
    }
  }
  static Object mkArr(Object[] xs) throws Exception {
    Object o = arr.getConstructor().newInstance();
    arr.getField("len").setInt(o, xs.length);
    arr.getField("data").set(o, xs);
    return o;
  }
  static String hex(double d) { return String.format("%016x", Double.doubleToRawLongBits(d)); }
  static String enc(Object v, Class<?> t) throws Exception {
    if (t == double.class) return "n" + hex((Double) v);
    if (t == int.class) return ((Integer) v) != 0 ? "t" : "f";
    if (v == null) return "l";
    if (v == undef) return "u";
    if (v instanceof Boolean) return ((Boolean) v) ? "t" : "f";
    if (v instanceof Double) return "n" + hex((Double) v);
    if (v instanceof String) {
      StringBuilder b = new StringBuilder("s");
      String s = (String) v;
      for (int i = 0; i < s.length(); i++) b.append(String.format("%04x", (int) s.charAt(i)));
      return b.toString();
    }
    if (obj.isInstance(v)) {
      Object keys = obj.getField("keys").get(v), vals = obj.getField("vals").get(v);
      int n = arr.getField("len").getInt(keys);
      Object[] ks = (Object[]) arr.getField("data").get(keys);
      Object[] vs = (Object[]) arr.getField("data").get(vals);
      StringBuilder b = new StringBuilder("O");
      for (int i = 0; i < n; i++) {
        String k = enc(ks[i], Object.class), e = enc(vs[i], Object.class);
        b.append(k.length()).append(':').append(k).append(e.length()).append(':').append(e);
      }
      return b.toString();
    }
    if (arr.isInstance(v)) {
      int n = arr.getField("len").getInt(v);
      Object[] d = (Object[]) arr.getField("data").get(v);
      StringBuilder b = new StringBuilder("A");
      for (int i = 0; i < n; i++) {
        String e = enc(d[i], Object.class);
        b.append(e.length()).append(':').append(e);
      }
      return b.toString();
    }
    int n = nums.getField("len").getInt(v);
    double[] d = (double[]) nums.getField("data").get(v);
    StringBuilder b = new StringBuilder("a");
    for (int i = 0; i < n; i++) b.append(hex(d[i]));
    return b.toString();
  }
}
`;

let harnessDir: string | undefined;

/** Whether a JDK (java and javac) is on the path. */
export function jdkAvailable(): boolean {
  const ok = (cmd: string): boolean =>
    spawnSync(cmd, ["-version"], { stdio: "ignore" }).status === 0;
  return ok("java") && ok("javac");
}

function harness(): string {
  if (harnessDir !== undefined) return harnessDir;
  const dir = mkdtempSync(join(tmpdir(), "yk-jvm-harness-"));
  writeFileSync(join(dir, "YkHarness.java"), HARNESS);
  const r = spawnSync("javac", ["-d", dir, join(dir, "YkHarness.java")], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`javac failed: ${r.stderr}`);
  harnessDir = dir;
  return dir;
}

const hex16 = (x: number): string => {
  const v = new DataView(new ArrayBuffer(8));
  v.setFloat64(0, x);
  return v.getBigUint64(0).toString(16).padStart(16, "0");
};
const fromHex16 = (h: string): number => {
  const v = new DataView(new ArrayBuffer(8));
  v.setBigUint64(0, BigInt(`0x${h}`));
  return v.getFloat64(0);
};

/** A value as the harness reads it; `t`, the parameter's type, decides an empty array's kind. */
function encodeValue(v: unknown, t?: WT): string {
  if (v === undefined) return "u";
  if (v === null) return "l";
  if (typeof v === "boolean") return v ? "t" : "f";
  if (typeof v === "number") return `n${hex16(v)}`;
  if (typeof v === "string")
    return `s${[...Array(v.length).keys()].map((i) => v.charCodeAt(i).toString(16).padStart(4, "0")).join("")}`;
  if (Array.isArray(v) && t !== "arr" && v.every((e) => typeof e === "number"))
    return `a${v.map((e) => hex16(e as number)).join("")}`;
  if (v !== null && typeof v === "object" && !Array.isArray(v))
    return `O${Object.entries(v)
      .flatMap(([k, e]) => [encodeValue(k), encodeValue(e)])
      .map((x) => `${x.length}:${x}`)
      .join("")}`;
  if (Array.isArray(v))
    return `A${v
      .map((e) => {
        const x = encodeValue(e);
        return `${x.length}:${x}`;
      })
      .join("")}`;
  throw new TypeError(`${String(v)} is not a value the JVM lowering represents`);
}

function decodeValue(s: string): unknown {
  const k = s[0];
  const r = s.slice(1);
  if (k === "u") return undefined;
  if (k === "l") return null;
  if (k === "t") return true;
  if (k === "f") return false;
  if (k === "n") return fromHex16(r);
  if (k === "s") {
    let out = "";
    for (let i = 0; i < r.length; i += 4)
      out += String.fromCharCode(Number.parseInt(r.slice(i, i + 4), 16));
    return out;
  }
  if (k === "O") {
    const kv = decodeValue(`A${r}`) as unknown[];
    const o: Record<string, unknown> = {};
    for (let i = 0; i < kv.length; i += 2) o[kv[i] as string] = kv[i + 1];
    return o;
  }
  if (k === "A") {
    const out: unknown[] = [];
    let at = 0;
    while (at < r.length) {
      const colon = r.indexOf(":", at);
      const n = Number(r.slice(at, colon));
      out.push(decodeValue(r.slice(colon + 1, colon + 1 + n)));
      at = colon + 1 + n;
    }
    return out;
  }
  if (k === "a")
    return Array.from({ length: r.length / 16 }, (_, i) => fromHex16(r.slice(16 * i, 16 * i + 16)));
  // A call that threw: its exception, as an Error.
  return new Error(r);
}

/**
 * Run `f` on a JVM for each argument list, in one JVM: the results, in order (a call that throws
 * gives an Error). The JVM verifies the classes as it loads them.
 */
export function runJvm(m: JvmModule, calls: readonly (readonly unknown[])[]): unknown[] {
  const dir = mkdtempSync(join(tmpdir(), "yk-jvm-"));
  mkdirSync(dir, { recursive: true });
  for (const [name, bytes] of m.classes) writeFileSync(join(dir, `${name}.class`), bytes);
  const input = calls
    .map((args) => args.map((v, i) => encodeValue(v, m.params[i])).join("\t"))
    .join("\n");
  const r = spawnSync("java", ["-cp", `${dir}:${harness()}`, "YkHarness"], {
    input: calls.length > 0 ? `${input}\n` : "",
    encoding: "utf8",
    maxBuffer: 1 << 28,
    // A program that does not stop is a failure, not a hang.
    timeout: 120_000,
  });
  if (r.error !== undefined) throw new Error(`the JVM did not finish: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`the JVM failed: ${r.stderr}`);
  const lines = r.stdout.split("\n").filter((l) => l.length > 0);
  if (lines.length !== calls.length)
    throw new Error(`the JVM answered ${lines.length} of ${calls.length} calls: ${r.stderr}`);
  return lines.map(decodeValue);
}
