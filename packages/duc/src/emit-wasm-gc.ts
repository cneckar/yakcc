import { WASM_HOST, WasmEmitError, type WasmSignature } from "./emit-wasm.js";
// SPDX-License-Identifier: Apache-2.0
/**
 * Lowering a graph to WebAssembly with GC types (DEC-DUC-WASM-MEMORY-001, #1300): the typed
 * subset of `emitWasm` (numbers and booleans) extended with strings, and the runtime's operations
 * lowered as atoms.
 *
 * Values are typed from the contract and the graph. A number is `f64`, a boolean `i32`, and a
 * string an `(array (mut i16))` of UTF-16 units, as ECMAScript's strings are. The module holds:
 * - the function, `f`;
 * - the runtime atoms it reaches (`wasm-runtime-atoms.ts`), each lifted from its TypeScript and
 *   lowered here like any graph;
 * - the three primitives the atoms are written over (`__ykUnit`, `__ykSub`, `__ykJoin`), the only
 *   string code written directly in wasm;
 * - exports a host uses to make and read strings (`strNew`, `strSet`, `strLen`, `strGet`).
 *
 * A value whose type is `T | undefined` is lowered as a `T`: `undefined` stands for a default that
 * is never observed. That is how a loop that returns early lifts: its value carry starts undefined
 * and is read only once a return has set it. The contract's output type must not include
 * `undefined`. Anything else (a string with a number under `+`, `==` across types, objects, arrays,
 * closures, throws) is refused with the reason.
 */
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

/** Every runtime atom the lowering can call, by name. */
const ATOMS: Readonly<Record<string, RuntimeAtom>> = {
  ...RUNTIME_ATOMS,
  ...BIGNUM_ATOMS,
  ...DYNAMIC_ATOMS,
};

/**
 * A value's wasm type: a number, a boolean, a string, an array of numbers, or a value of any of
 * these kinds or undefined or null (`any`, an `anyref`: see BASE_TYPES).
 */
type WT = "f64" | "i32" | "str" | "nums" | "any";

export interface WasmGcModule {
  readonly bytes: Uint8Array;
  /** The host functions the module imports, by name (from `WASM_HOST`). */
  readonly imports: readonly string[];
  readonly params: readonly WT[];
  readonly result: WT;
  /** The runtime atoms the module contains, by name. */
  readonly atoms: readonly string[];
}

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
const s64 = (n: number): number[] => {
  const out: number[] = [];
  let v = BigInt(n);
  for (;;) {
    const byte = Number(v & 0x7fn);
    v >>= 7n;
    if ((v === 0n && (byte & 0x40) === 0) || (v === -1n && (byte & 0x40) !== 0)) {
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
const name = (s: string): number[] => {
  const b = [...new TextEncoder().encode(s)];
  return [...u32(b.length), ...b];
};
const vec = (items: number[][]): number[] => [...u32(items.length), ...items.flat()];
const section = (id: number, body: number[]): number[] => [id, ...u32(body.length), ...body];

/**
 * The types every module starts with. A string is type 0, an array of mutable i16 (UTF-16 units). An
 * array of numbers is type 2, a struct of its length and its storage, type 1 (an array of mutable
 * f64) with room to grow. A value of either is a `(ref null <type>)`.
 */
const STR = 0;
const F64S = 1;
const NUMS = 2;
/**
 * A value of any kind is an `anyref`: a number is a box (type 3, a struct of one f64), a boolean is
 * the i31 0 or 1, undefined is the i31 2, null is the null reference, and a string or an array is
 * itself. `__ykTag` tells them apart.
 */
const BOX = 3;
const BASE_TYPES: number[][] = [
  [0x5e, 0x77, 0x01],
  [0x5e, 0x7c, 0x01],
  [0x5f, 0x02, 0x7f, 0x01, 0x63, F64S, 0x01],
  [0x5f, 0x01, 0x7c, 0x00],
];
/** Abstract heap types. */
const HT_I31 = 0x6c;
const HT_EQ = 0x6d;
const HT_ANY = 0x6e;
const VAL: Record<WT, number[]> = {
  f64: [0x7c],
  i32: [0x7f],
  str: [0x63, STR],
  nums: [0x63, NUMS],
  any: [0x63, HT_ANY],
};
/** The i31 that is undefined. */
const UNDEFINED_I31 = 2;

const I = {
  get: 0x20,
  set: 0x21,
  tee: 0x22,
  i32const: 0x41,
  f64const: 0x44,
  select: 0x1b,
  selectT: 0x1c,
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
  i32add: 0x6a,
  i32sub: 0x6b,
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
  refEq: 0xd3,
  f64fromU32: 0xb8,
  refAsNonNull: 0xd4,
} as const;
/** The GC instructions (prefix 0xfb) and i32.trunc_sat_f64_s (0xfc 0x02). */
const GC = {
  arrayNewDefault: [0xfb, 0x07, STR],
  arrayNewFixed: (n: number) => [0xfb, 0x08, STR, ...u32(n)],
  arrayGetU: [0xfb, 0x0d, STR],
  arraySet: [0xfb, 0x0e, STR],
  arrayLen: [0xfb, 0x0f],
  arrayCopy: [0xfb, 0x11, STR, STR],
  truncSat: [0xfc, 0x02],
  f64sNewDefault: [0xfb, 0x07, F64S],
  f64sNewFixed: (n: number) => [0xfb, 0x08, F64S, ...u32(n)],
  f64sGet: [0xfb, 0x0b, F64S],
  f64sSet: [0xfb, 0x0e, F64S],
  f64sCopy: [0xfb, 0x11, F64S, F64S],
  numsNew: [0xfb, 0x00, NUMS],
  numsLen: [0xfb, 0x02, NUMS, 0x00],
  numsData: [0xfb, 0x02, NUMS, 0x01],
  numsSetLen: [0xfb, 0x05, NUMS, 0x00],
  numsSetData: [0xfb, 0x05, NUMS, 0x01],
  boxNew: [0xfb, 0x00, BOX],
  boxGet: [0xfb, 0x02, BOX, 0x00],
  refI31: [0xfb, 0x1c],
  i31GetS: [0xfb, 0x1d],
  refTest: (ht: number) => [0xfb, 0x14, ht],
  refCast: (ht: number) => [0xfb, 0x16, ht],
  refCastNull: (ht: number) => [0xfb, 0x17, ht],
  refNullAny: [0xd0, HT_ANY],
  refIsNull: [0xd1],
};

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
const AMBIENT_NUMBERS: Readonly<Record<string, number>> = {
  NaN: Number.NaN,
  Infinity: Number.POSITIVE_INFINITY,
};

/** The primitives: their parameter and result types. */
const PRIMITIVES: Readonly<Record<string, { params: WT[]; result: WT }>> = {
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
  __ykSame: { params: ["any", "any"], result: "i32" },
};

/** The array operations, written directly: what an array of numbers is made of. */
const ARRAY_PRIMITIVES: Readonly<Record<string, { params: WT[]; result: WT }>> = {
  numsPush: { params: ["nums", "f64"], result: "f64" },
  numsPop: { params: ["nums"], result: "f64" },
  numsGet: { params: ["nums", "f64"], result: "f64" },
  numsSet: { params: ["nums", "f64", "f64"], result: "nums" },
  // A program's element read: the element, or undefined at an index that is not one.
  numsAt: { params: ["nums", "f64"], result: "any" },
};

/** What crosses the boundary: values made and read from JavaScript (`instantiateWasmGc`). */
const MARSHAL: Readonly<Record<string, { params: WT[]; result: WT | undefined }>> = {
  strNew: { params: ["i32"], result: "str" },
  strSet: { params: ["str", "i32", "i32"], result: undefined },
  strLen: { params: ["str"], result: "i32" },
  strGet: { params: ["str", "i32"], result: "i32" },
  numsNew: { params: ["i32"], result: "nums" },
  numsSetAt: { params: ["nums", "i32", "f64"], result: undefined },
  numsLen: { params: ["nums"], result: "i32" },
  numsGetAt: { params: ["nums", "i32"], result: "f64" },
  mkNum: { params: ["f64"], result: "any" },
  mkBool: { params: ["i32"], result: "any" },
  mkUndef: { params: [], result: "any" },
  mkNull: { params: [], result: "any" },
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

// --- the module: functions referred to by key, given indices when it is written ---

type Tok = number | { readonly fn: string };

interface Func {
  readonly params: readonly WT[];
  readonly result: WT | undefined;
  locals: (readonly number[])[];
  code: Tok[];
}

class Module {
  readonly imports: string[] = [];
  readonly hostArity = new Map<string, number>();
  readonly funcs = new Map<string, Func>();
  readonly atoms: string[] = [];

  importHost(host: string, arity: number): Tok {
    if (WASM_HOST[host] === undefined) throw new WasmEmitError(`"${host}" is not a host function`);
    if (!this.imports.includes(host)) this.imports.push(host);
    this.hostArity.set(host, Math.max(this.hostArity.get(host) ?? 0, arity));
    return { fn: `host:${host}` };
  }

  /** A runtime atom: lowered once, the first time a function calls it. */
  atom(key: string): { tok: Tok; params: readonly WT[]; result: WT } {
    const a = ATOMS[key];
    if (a === undefined) throw new WasmEmitError(`"${key}" is not a runtime atom`);
    const params = a.inputs.map((t) => wt(parseType(t), `${key}'s parameter`));
    const result = wt(parseType(a.output), `${key}'s result`);
    const fkey = `atom:${key}`;
    if (!this.funcs.has(fkey)) {
      const f: Func = { params, result, locals: [], code: [] };
      this.funcs.set(fkey, f);
      this.atoms.push(key);
      const lowered = lowerFunction(atomGraph(key), params, result, this, true);
      f.locals = lowered.locals;
      f.code = lowered.code;
    }
    return { tok: { fn: fkey }, params, result };
  }

  primitive(key: string): { tok: Tok; params: readonly WT[]; result: WT } {
    const p = (PRIMITIVES[key] ?? ARRAY_PRIMITIVES[key]) as { params: WT[]; result: WT };
    const fkey = `prim:${key}`;
    if (!this.funcs.has(fkey)) {
      this.funcs.set(fkey, { ...p, ...primitiveBody(key) });
      // A write at the end of an array is a push.
      if (key === "numsSet") this.primitive("numsPush");
    }
    return { tok: { fn: fkey }, params: p.params, result: p.result };
  }

  write(exports: Readonly<Record<string, string>>): Uint8Array {
    const order = [...this.funcs.keys()];
    const index = new Map<string, number>();
    this.imports.forEach((h, i) => index.set(`host:${h}`, i));
    order.forEach((k, i) => index.set(k, this.imports.length + i));
    const types: number[][] = [...BASE_TYPES];
    const typeIndex = new Map<string, number>();
    const fnType = (params: readonly number[][], result: readonly number[][]): number => {
      const bytes = [0x60, ...vec(params.map((p) => [...p])), ...vec(result.map((r) => [...r]))];
      const key = bytes.join(",");
      let at = typeIndex.get(key);
      if (at === undefined) {
        at = types.push(bytes) - 1;
        typeIndex.set(key, at);
      }
      return at;
    };
    const importEntries = this.imports.map((h) => {
      const t = fnType(
        Array.from({ length: this.hostArity.get(h) ?? 1 }, () => VAL.f64),
        [VAL.f64],
      );
      return [...name("host"), ...name(h), 0x00, ...u32(t)];
    });
    const funcTypes = order.map((k) => {
      const f = this.funcs.get(k) as Func;
      return u32(
        fnType(
          f.params.map((p) => VAL[p]),
          f.result === undefined ? [] : [VAL[f.result]],
        ),
      );
    });
    const bodies = order.map((k) => {
      const f = this.funcs.get(k) as Func;
      const code = f.code.flatMap((t) =>
        typeof t === "number" ? [t] : u32(index.get(t.fn) as number),
      );
      const body = [...vec(f.locals.map((l) => [...u32(1), ...l])), ...code];
      return [...u32(body.length), ...body];
    });
    const exportEntries = Object.entries(exports).map(([as, k]) => [
      ...name(as),
      0x00,
      ...u32(index.get(k) as number),
    ]);
    return new Uint8Array([
      0x00,
      0x61,
      0x73,
      0x6d,
      0x01,
      0x00,
      0x00,
      0x00,
      ...section(1, vec(types)),
      ...(importEntries.length > 0 ? section(2, vec(importEntries)) : []),
      ...section(3, vec(funcTypes)),
      ...section(7, vec(exportEntries)),
      ...section(10, vec(bodies)),
    ]);
  }
}

/** The primitives, written directly: `__ykUnit`, `__ykSub`, `__ykJoin`, and the host's string access. */
function primitiveBody(key: string): { locals: number[][]; code: Tok[] } {
  const get = (i: number) => [I.get, ...u32(i)];
  const trunc = (i: number) => [...get(i), ...GC.truncSat];
  switch (key) {
    case "__ykUnit":
      // As charCodeAt: the unit at the index, NaN out of range (a negative index is a large
      // unsigned one).
      return {
        locals: [VAL.i32],
        code: [
          ...trunc(1),
          I.tee,
          ...u32(2),
          ...get(0),
          ...GC.arrayLen,
          0x49, // i32.lt_u
          I.if,
          0x7c,
          ...get(0),
          ...get(2),
          ...GC.arrayGetU,
          I.f64fromU32,
          0x05, // else
          I.f64const,
          ...f64(Number.NaN),
          I.end,
          I.end,
        ],
      };
    case "__ykSub":
      // n = to - from; out = new [n]; copy s[from..to) into out.
      return {
        locals: [VAL.i32, VAL.str],
        code: [
          ...trunc(2),
          ...trunc(1),
          I.i32sub,
          I.set,
          ...u32(3),
          ...get(3),
          ...GC.arrayNewDefault,
          I.set,
          ...u32(4),
          ...get(4),
          I.i32const,
          0,
          ...get(0),
          ...trunc(1),
          ...get(3),
          ...GC.arrayCopy,
          ...get(4),
          I.end,
        ],
      };
    case "__ykJoin":
      // out = new [len a + len b]; copy a, then b.
      return {
        locals: [VAL.str],
        code: [
          ...get(0),
          ...GC.arrayLen,
          ...get(1),
          ...GC.arrayLen,
          I.i32add,
          ...GC.arrayNewDefault,
          I.set,
          ...u32(2),
          ...get(2),
          I.i32const,
          0,
          ...get(0),
          I.i32const,
          0,
          ...get(0),
          ...GC.arrayLen,
          ...GC.arrayCopy,
          ...get(2),
          ...get(0),
          ...GC.arrayLen,
          ...get(1),
          I.i32const,
          0,
          ...get(1),
          ...GC.arrayLen,
          ...GC.arrayCopy,
          ...get(2),
          I.end,
        ],
      };
    case "__ykChar":
      return { locals: [], code: [...trunc(0), ...GC.arrayNewFixed(1), I.end] };
    case "__ykF64Hi":
      // i64.reinterpret_f64; shift right 32; f64.convert_i64_u
      return { locals: [], code: [...get(0), 0xbd, 0x42, 32, 0x88, 0xba, I.end] };
    case "__ykF64Lo":
      // i64.reinterpret_f64; and 0xffffffff; f64.convert_i64_u
      return { locals: [], code: [...get(0), 0xbd, 0x42, ...s64(0xffffffff), 0x83, 0xba, I.end] };
    case "__ykPow2": {
      // k = i64.trunc_sat_f64_s(e); k > 1023: Infinity; k < -1074: 0; k >= -1022: the bits
      // (k + 1023) << 52; otherwise the subnormal 1 << (k + 1074). Each a double's bits exactly.
      const k = 1;
      const i64 = (n: number) => [0x42, ...s64(n)];
      return {
        locals: [[0x7e]],
        code: [
          ...get(0),
          0xfc,
          0x06,
          I.set,
          ...u32(k),
          ...get(k),
          ...i64(1023),
          0x55, // i64.gt_s
          I.if,
          0x7c,
          I.f64const,
          ...f64(Number.POSITIVE_INFINITY),
          0x05, // else
          ...get(k),
          ...i64(-1074),
          0x53, // i64.lt_s
          I.if,
          0x7c,
          I.f64const,
          ...f64(0),
          0x05,
          ...get(k),
          ...i64(-1022),
          0x59, // i64.ge_s
          I.if,
          0x7e,
          ...get(k),
          ...i64(1023),
          0x7c, // i64.add
          ...i64(52),
          0x86, // i64.shl
          0x05,
          ...i64(1),
          ...get(k),
          ...i64(1074),
          0x7c,
          0x86,
          I.end,
          0xbf, // f64.reinterpret_i64
          I.end,
          I.end,
          I.end,
        ],
      };
    }
    case "numsPush": {
      // len = a.len; data = a.data; when full, grow to 2 len + 4; data[len] = x; a.len = len + 1.
      const [a, x, len, data, grown] = [0, 1, 2, 3, 4];
      return {
        locals: [VAL.i32, [0x63, F64S], [0x63, F64S]],
        code: [
          ...get(a),
          ...GC.numsLen,
          I.set,
          ...u32(len),
          ...get(a),
          ...GC.numsData,
          I.set,
          ...u32(data),
          ...get(len),
          ...get(data),
          ...GC.arrayLen,
          I.i32eq,
          I.if,
          0x40,
          ...get(len),
          I.i32const,
          1,
          0x74,
          I.i32const,
          4,
          I.i32add,
          ...GC.f64sNewDefault,
          I.set,
          ...u32(grown),
          ...get(grown),
          I.i32const,
          0,
          ...get(data),
          I.i32const,
          0,
          ...get(len),
          ...GC.f64sCopy,
          ...get(a),
          ...get(grown),
          ...GC.numsSetData,
          ...get(grown),
          I.set,
          ...u32(data),
          I.end,
          ...get(data),
          ...get(len),
          ...get(x),
          ...GC.f64sSet,
          ...get(a),
          ...get(len),
          I.i32const,
          1,
          I.i32add,
          ...GC.numsSetLen,
          ...get(len),
          I.i32const,
          1,
          I.i32add,
          I.f64fromI32,
          I.end,
        ],
      };
    }
    case "numsPop": {
      // An empty array pops undefined: NaN stands for it here, and is never observed.
      const [a, len] = [0, 1];
      return {
        locals: [VAL.i32],
        code: [
          ...get(a),
          ...GC.numsLen,
          I.set,
          ...u32(len),
          ...get(len),
          I.i32eqz,
          I.if,
          0x7c,
          I.f64const,
          ...f64(Number.NaN),
          I.else,
          ...get(a),
          ...get(len),
          I.i32const,
          1,
          I.i32sub,
          ...GC.numsSetLen,
          ...get(a),
          ...GC.numsData,
          ...get(len),
          I.i32const,
          1,
          I.i32sub,
          ...GC.f64sGet,
          I.end,
          I.end,
        ],
      };
    }
    case "numsGet": {
      // An index out of range, or not an integer, reads undefined: NaN stands for it here.
      const [a, i, k] = [0, 1, 2];
      return {
        locals: [VAL.i32],
        code: [
          ...trunc(i),
          I.set,
          ...u32(k),
          ...get(k),
          I.f64fromI32,
          ...get(i),
          I.f64ne,
          ...get(k),
          I.i32const,
          0,
          0x48,
          I.i32or,
          ...get(k),
          ...get(a),
          ...GC.numsLen,
          0x4e,
          I.i32or,
          I.if,
          0x7c,
          I.f64const,
          ...f64(Number.NaN),
          I.else,
          ...get(a),
          ...GC.numsData,
          ...get(k),
          ...GC.f64sGet,
          I.end,
          I.end,
        ],
      };
    }
    case "numsSet": {
      // a[i] = v for i within the array, or at its end (a push); anywhere else is not lowered.
      const [a, i, v, k] = [0, 1, 2, 3];
      return {
        locals: [VAL.i32],
        code: [
          ...trunc(i),
          I.set,
          ...u32(k),
          ...get(k),
          ...get(a),
          ...GC.numsLen,
          I.i32eq,
          I.if,
          0x40,
          ...get(a),
          ...get(v),
          I.call,
          { fn: "prim:numsPush" },
          0x1a,
          I.else,
          ...get(a),
          ...GC.numsData,
          ...get(k),
          ...get(v),
          ...GC.f64sSet,
          I.end,
          ...get(a),
          I.end,
        ],
      };
    }
    case "__ykTag":
      // null 1; an i31: 2 (a boolean) for 0 and 1, 0 for undefined; a box 3; a string 4; else 5.
      return {
        locals: [],
        code: [
          ...get(0),
          ...GC.refIsNull,
          I.if,
          0x7c,
          I.f64const,
          ...f64(1),
          I.else,
          ...get(0),
          ...GC.refTest(HT_I31),
          I.if,
          0x7c,
          ...get(0),
          ...GC.refCast(HT_I31),
          ...GC.i31GetS,
          I.i32const,
          UNDEFINED_I31,
          I.i32eq,
          I.if,
          0x7c,
          I.f64const,
          ...f64(0),
          I.else,
          I.f64const,
          ...f64(2),
          I.end,
          I.else,
          ...get(0),
          ...GC.refTest(BOX),
          I.if,
          0x7c,
          I.f64const,
          ...f64(3),
          I.else,
          ...get(0),
          ...GC.refTest(STR),
          I.if,
          0x7c,
          I.f64const,
          ...f64(4),
          I.else,
          I.f64const,
          ...f64(5),
          I.end,
          I.end,
          I.end,
          I.end,
          I.end,
        ],
      };
    case "__ykNum":
      return { locals: [], code: [...get(0), ...GC.refCast(BOX), ...GC.boxGet, I.end] };
    case "__ykBool":
      return { locals: [], code: [...get(0), ...GC.refCast(HT_I31), ...GC.i31GetS, I.end] };
    case "__ykStr":
      return { locals: [], code: [...get(0), ...GC.refCastNull(STR), I.end] };
    case "__ykArr":
      return { locals: [], code: [...get(0), ...GC.refCastNull(NUMS), I.end] };
    case "__ykSame":
      return {
        locals: [],
        code: [
          ...get(0),
          ...GC.refCastNull(HT_EQ),
          ...get(1),
          ...GC.refCastNull(HT_EQ),
          I.refEq,
          I.end,
        ],
      };
    case "numsAt":
      // An index is one when it is an integer in [0, length): -0 is 0.
      return {
        locals: [],
        code: [
          ...get(1),
          ...get(1),
          0x9d, // f64.trunc
          I.f64eq,
          ...get(1),
          I.f64const,
          ...f64(0),
          I.f64ge,
          I.i32and,
          ...get(1),
          ...get(0),
          ...GC.numsLen,
          I.f64fromI32,
          I.f64lt,
          I.i32and,
          I.if,
          ...VAL.any,
          ...get(0),
          ...GC.numsData,
          ...trunc(1),
          ...GC.f64sGet,
          ...GC.boxNew,
          I.else,
          I.i32const,
          UNDEFINED_I31,
          ...GC.refI31,
          I.end,
          I.end,
        ],
      };
    case "numsNew":
      return {
        locals: [],
        code: [...get(0), ...get(0), ...GC.f64sNewDefault, ...GC.numsNew, I.end],
      };
    case "numsSetAt":
      return {
        locals: [],
        code: [...get(0), ...GC.numsData, ...get(1), ...get(2), ...GC.f64sSet, I.end],
      };
    case "numsLen":
      return { locals: [], code: [...get(0), ...GC.numsLen, I.end] };
    case "numsGetAt":
      return { locals: [], code: [...get(0), ...GC.numsData, ...get(1), ...GC.f64sGet, I.end] };
    case "mkNum":
      return { locals: [], code: [...get(0), ...GC.boxNew, I.end] };
    case "mkBool":
      return { locals: [], code: [...get(0), ...GC.refI31, I.end] };
    case "mkUndef":
      return { locals: [], code: [I.i32const, UNDEFINED_I31, ...GC.refI31, I.end] };
    case "mkNull":
      return { locals: [], code: [...GC.refNullAny, I.end] };
    case "strNew":
      return { locals: [], code: [...get(0), ...GC.arrayNewDefault, I.end] };
    case "strSet":
      return { locals: [], code: [...get(0), ...get(1), ...get(2), ...GC.arraySet, I.end] };
    case "strLen":
      return { locals: [], code: [...get(0), ...GC.arrayLen, I.end] };
    case "strGet":
      return { locals: [], code: [...get(0), ...get(1), ...GC.arrayGetU, I.end] };
  }
  throw new WasmEmitError(`no primitive ${key}`);
}

function wt(t: DucType | undefined, what: string): WT {
  if (t === undefined) throw new WasmEmitError(`${what} has no type`);
  if (t.k === "num") return "f64";
  if (t.k === "boolean") return "i32";
  if (t.k === "string") return "str";
  if (t.k === "array" && t.of?.k === "num") return "nums";
  // A value that may be of more than one kind, undefined or null.
  if (t.k === "unknown" || t.k === "null" || t.k === "undefined") return "any";
  if (t.k === "union") {
    const kinds = new Set(t.of.map((x) => wt(x, what)));
    return kinds.size === 1 ? ([...kinds][0] as WT) : "any";
  }
  throw new WasmEmitError(
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
  | { readonly k: "method"; readonly recv: ValueId; readonly name: string }
  | { readonly k: "prim"; readonly name: string }
  | { readonly k: "atom"; readonly name: string };

/** One function of the module, lowered from a graph. */
function lowerFunction(
  source: DucGraph,
  paramTypes: readonly WT[],
  declared: WT | undefined,
  mod: Module,
  /**
   * A runtime atom: its element reads and writes are lowered, with undefined (out of range) standing
   * for a value it never observes. The atoms are tested against the builtins they define; a program
   * is not, so in a program an element read or write is refused for now.
   */
  trusted = false,
): { result: WT; locals: number[][]; code: Tok[] } {
  if (source.mode !== undefined)
    throw new WasmEmitError(`an ${source.mode} function has no form here`);
  if (source.obs.length !== 1) throw new WasmEmitError("the subset has exactly one result");
  const { graph: g, after } = loweringView(source);
  const owners = joinOwners(g);
  const producer = new Map<ValueId, DucNode>();
  for (const n of g.nodes) for (const v of n.outputs) producer.set(v, n);

  const loops = g.nodes.filter((n) => n.kind === "loop");
  const alias = new Map<ValueId, ValueId>();
  const carryOf = new Map<ValueId, { loop: DucNode; i: number }>();
  for (const loop of loops) {
    const rec = loop.loop as DucLoop;
    if (rec.iterate !== undefined) throw new WasmEmitError("iteration is not in the subset");
    if (rec.cond === undefined) throw new WasmEmitError("a loop with no condition");
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
    throw new WasmEmitError("the signature and the graph have different parameter counts");

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
      throw new WasmEmitError(`${what} mixes ${show(a)} and ${show(b)}`);
    }
    if (a === b) return a;
    if (trusted && a === "undef") return b;
    if (trusted && b === "undef") return a;
    return "any";
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
    if (p === undefined) throw new WasmEmitError(`value ${v} has no producer`);
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
      throw new WasmEmitError(`the literal ${text} is not in the subset`);
    }
    if (p.kind === "diamond-source") {
      const sym = p.diamond?.symbol ?? "";
      if (sym === "undefined") return "undef";
      if (AMBIENT_NUMBERS[sym] !== undefined) return "f64";
      if (sym === "Math") return { call: { k: "math", name: "" } };
      if (sym === "String") return { call: { k: "string-of" } };
      if (sym === "Number") return { call: { k: "number-of" } };
      if (PRIMITIVES[sym] !== undefined) return { call: { k: "prim", name: sym } };
      if (ATOMS[sym] !== undefined) return { call: { k: "atom", name: sym } };
      throw new WasmEmitError(`"${sym}" is not in the wasm base set`);
    }
    if (p.kind === "loop") return get((p.loop as DucLoop).carry[p.outputs.indexOf(v)] as ValueId);
    const ins = p.inputs as readonly ValueId[];
    if (p.kind === "sel" || owners.get(p.id) !== undefined)
      return unify(get(ins[1] as ValueId), get(ins[2] as ValueId), "a choice between two values");
    if (p.kind !== "op") throw new WasmEmitError(`a ${p.kind} node is not in the subset`);
    if (p.closure !== undefined) throw new WasmEmitError("a closure is not in the subset");
    const label = p.label ?? "";
    const operand = (i: number): VT | "?" => {
      const t = get(ins[i] as ValueId);
      if (t !== "undef") return t;
      // In a program, undefined is a value like any other; in a runtime atom it is never one.
      if (trusted) throw new WasmEmitError(`undefined is an operand of "${label}"`);
      return "any";
    };
    if (/^\.\w+$/.test(label) && ins.length === 1) {
      const member = label.slice(1);
      const t0 = operand(0);
      if (t0 === "?") return "?";
      if (typeof t0 === "object" && t0.call.k === "math")
        return MATH_CONSTANTS[member] !== undefined ? "f64" : { call: { k: "math", name: member } };
      if (t0 === "nums") {
        if (member === "length") return "f64";
        if (member === "push" || member === "pop")
          return { call: { k: "method", recv: ins[0] as ValueId, name: `nums.${member}` } };
        throw new WasmEmitError(`the array method ${member} is not in the subset yet`);
      }
      if (t0 === "any")
        throw new WasmEmitError(
          `the member ${member} of a value of any kind is not in the subset yet`,
        );
      if ((t0 === "f64" || t0 === "i32") && member === "toString")
        return { call: { k: "method", recv: ins[0] as ValueId, name: "toString" } };
      if (t0 === "str") {
        if (member === "length") return "f64";
        if (STRING_METHODS[member] !== undefined)
          return { call: { k: "method", recv: ins[0] as ValueId, name: member } };
        throw new WasmEmitError(`the string method ${member} is not in the subset yet`);
      }
      throw new WasmEmitError(`the member ${member} of ${show(t0)} is not in the subset`);
    }
    if (label === "CallExpression") {
      const t0 = operand(0);
      if (t0 === "?") return "?";
      if (typeof t0 !== "object")
        throw new WasmEmitError("a call of a value that is not a known function");
      const callee = t0.call;
      if (callee.k === "math") return "f64";
      if (callee.k === "string-of") return "str";
      if (callee.k === "number-of") return "f64";
      if (callee.k === "prim") return (PRIMITIVES[callee.name] as { result: WT }).result;
      if (callee.k === "method" && callee.name === "nums.push") return "f64";
      if (callee.k === "method" && callee.name === "nums.pop") return "f64";
      if (callee.k === "method" && callee.name === "toString") return "str";
      if (callee.k === "atom")
        return wt(parseType((ATOMS[callee.name] as { output: string }).output), callee.name);
      const m = STRING_METHODS[callee.name] as { atom: string; notFound?: boolean };
      if (m.notFound === true) return "i32";
      return wt(parseType((ATOMS[m.atom] as { output: string }).output), m.atom);
    }
    if (ins.length === 2 && label === "+") {
      const known = [operand(0), operand(1)].filter((x) => x !== "?");
      if (known.some((x) => typeof x === "object")) throw new WasmEmitError("+ of a function");
      if (known.length === 0) return "?";
      // An array's primitive is its join, a string: + of one concatenates.
      if (known.some((x) => x === "str" || x === "nums")) return "str";
      // A value of any kind may be a string: ECMAScript's + decides (the runtime atom).
      if (known.some((x) => x === "any")) return known.length === 2 ? "any" : "?";
      return "f64";
    }
    if (label === "ArrayLiteral") {
      for (let i = 0; i < ins.length; i++) {
        const t = operand(i);
        if (t !== "?" && t !== "f64")
          throw new WasmEmitError("an array literal of other than numbers");
      }
      return "nums";
    }
    if (label === "ElementAccess" && ins.length === 2) {
      const t0 = operand(0);
      if (t0 === "?") return "?";
      if (t0 !== "nums")
        throw new WasmEmitError(`an element read of ${show(t0)} is not in the subset`);
      const t1 = operand(1);
      if (t1 !== "?" && t1 !== "f64")
        throw new WasmEmitError(`an element read at ${show(t1)} is not in the subset yet`);
      // In a program a read out of range is undefined: a value of any kind.
      return trusted ? "f64" : "any";
    }
    if (label === "[]=" && ins.length === 3) {
      const t0 = operand(0);
      if (t0 === "?") return "?";
      if (t0 !== "nums")
        throw new WasmEmitError(`an element write to ${show(t0)} is not in the subset`);
      if (!trusted)
        throw new WasmEmitError("an element write is not in the subset of a program yet");
      return "nums";
    }
    if (label.startsWith("template:")) {
      // The label holds the template's cooked text, its value (the literal normal form, #1303).
      for (let i = 0; i < ins.length; i++) {
        const t = operand(i);
        if (typeof t === "object") throw new WasmEmitError("a template literal of a function");
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
    throw new WasmEmitError(`the operation "${label}" is not in the subset`);
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
    if (round > allValues.length + 2) throw new WasmEmitError("the types do not settle");
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
  }
  /** A value's settled type: never typed is undefined (it never has a value). */
  const ty = (v: ValueId): VT => {
    const t = get(v);
    return t === "?" ? "undef" : t;
  };
  const value = (v: ValueId, what: string): WT => {
    const t = ty(v);
    if (typeof t !== "string" || t === "undef")
      throw new WasmEmitError(`${what} has no value here`);
    return t;
  };

  // --- code ---
  const code: Tok[] = [];
  const locals: number[][] = [];
  const local = new Map<ValueId, number>();
  params.forEach((p, i) => local.set(p.outputs[0] as ValueId, i));
  const localOf = (v: ValueId): number => {
    const at0 = local.get(v);
    if (at0 !== undefined) return at0;
    const at = params.length + locals.length;
    locals.push(VAL[value(v, `value ${v}`)]);
    local.set(v, at);
    return at;
  };
  const pushDefault = (t: WT): void => {
    if (t === "any") code.push(I.i32const, UNDEFINED_I31, ...GC.refI31);
    else if (t === "f64") code.push(I.f64const, ...f64(Number.NaN));
    else if (t === "i32") code.push(I.i32const, 0);
    else if (t === "nums")
      code.push(I.i32const, 0, I.i32const, 4, ...GC.f64sNewDefault, ...GC.numsNew);
    else code.push(...GC.arrayNewFixed(0));
  };
  /** Push a string constant: its UTF-16 units, as a new array. */
  const pushText = (text: string): void => {
    for (let i = 0; i < text.length; i++) code.push(I.i32const, ...s32(text.charCodeAt(i)));
    code.push(...GC.arrayNewFixed(text.length));
  };
  /**
   * Push a value as a string, as ECMAScript's ToString: a string is itself, a number is
   * Number::toString (the runtime atom), a boolean is "true" or "false".
   */
  const pushString = (v: ValueId): void => {
    const t = opType(v);
    if (t === "any") {
      push(v, "any");
      code.push(I.call, mod.atom("__ykToString").tok);
      return;
    }
    if (typeof t !== "string" || t === "undef")
      throw new WasmEmitError("a value made a string has no value here");
    if (t === "str") push(v);
    else if (t === "f64") call(mod.atom("__ykNumberToString"), [v], "ToString");
    else if (t === "i32") {
      pushText("true");
      pushText("false");
      push(v);
      select("str");
    } else call(mod.atom("__ykJoinNums"), [v], "ToString");
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
      if (got === "f64") code.push(...GC.boxNew);
      else if (got === "i32") code.push(I.i32eqz, I.i32eqz, ...GC.refI31);
      return;
    }
    if (got === "any") {
      if (want === "f64") code.push(...GC.refCast(BOX), ...GC.boxGet);
      else if (want === "i32") code.push(...GC.refCast(HT_I31), ...GC.i31GetS);
      else code.push(...GC.refCastNull(want === "str" ? STR : NUMS));
      return;
    }
    if (got === "i32" && want === "f64") {
      code.push(I.f64fromI32);
      return;
    }
    throw new WasmEmitError(
      `${what} is ${got === "str" ? "a string" : "not a string"}, and a ${want === "str" ? "string" : "number"} is needed`,
    );
  };
  /** Push a value as it is held; an undefined pushes `want`'s default (undefined for any). */
  const pushRaw = (v0: ValueId, orDefault?: WT): WT => {
    const v = resolve(v0);
    const t = ty(v);
    if (t === "undef") {
      if (orDefault === undefined) throw new WasmEmitError("undefined is used as a value");
      pushDefault(orDefault);
      return orDefault;
    }
    if (typeof t === "object") throw new WasmEmitError("a function is used as a value");
    const p = producer.get(v);
    if (p?.kind === "literal-source") {
      const text = p.label ?? "";
      if (text === "null") code.push(...GC.refNullAny);
      else if (t === "i32") code.push(I.i32const, ...s32(text === "true" ? 1 : 0));
      else if (t === "str") {
        const s = JSON.parse(text) as string;
        for (let i = 0; i < s.length; i++) code.push(I.i32const, ...s32(s.charCodeAt(i)));
        code.push(...GC.arrayNewFixed(s.length));
      } else {
        const n = Number(text.replace(/_/g, ""));
        if (Number.isNaN(n) && text !== "NaN")
          throw new WasmEmitError(`the literal ${text} is not a number`);
        code.push(I.f64const, ...f64(n));
      }
      return t;
    }
    if (p?.kind === "diamond-source" && AMBIENT_NUMBERS[p.diamond?.symbol ?? ""] !== undefined) {
      code.push(I.f64const, ...f64(AMBIENT_NUMBERS[p.diamond?.symbol ?? ""] as number));
      return "f64";
    }
    if (
      p?.kind === "op" &&
      /^\.\w+$/.test(p.label ?? "") &&
      typeof ty(p.inputs[0] as ValueId) === "object"
    ) {
      code.push(I.f64const, ...f64(MATH_CONSTANTS[(p.label ?? "").slice(1)] as number));
      return "f64";
    }
    code.push(I.get, ...u32(localOf(v)));
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
      code.push(I.call, mod.atom("__ykToNumber").tok);
      return;
    }
    if (typeof t !== "string" || t === "undef")
      throw new WasmEmitError("a value made a number has no value here");
    if (t === "str") call(mod.atom("__ykStringToNumber"), [v], "ToNumber");
    else if (t === "nums") {
      call(mod.atom("__ykJoinNums"), [v], "ToNumber");
      code.push(I.call, mod.atom("__ykStringToNumber").tok);
    } else pushAs(v, "f64", "an operand");
  };
  /** Push a value's truthiness as an i32 (nonzero is true). */
  const truthy = (v: ValueId): void => {
    if (opType(v) === "any") {
      push(v, "any");
      code.push(I.call, mod.atom("__ykTruthy").tok);
      return;
    }
    const t = push(v);
    if (t === "i32") return;
    if (t === "str") {
      code.push(...GC.arrayLen);
      return;
    }
    if (t === "nums") {
      // An array is an object: always truthy.
      code.push(0x1a, I.i32const, 1);
      return;
    }
    code.push(I.f64const, ...f64(0), I.f64ne);
    push(v);
    push(v);
    code.push(I.f64eq, I.i32and);
  };
  const set = (v: ValueId): void => {
    code.push(I.set, ...u32(localOf(v)));
  };
  const select = (t: WT): void => {
    // A reference is chosen by a typed select.
    if (t === "f64" || t === "i32") code.push(I.select);
    else code.push(I.selectT, ...vec([VAL[t]]));
  };
  const call = (
    target: { tok: Tok; params: readonly WT[] },
    args: readonly (ValueId | number)[],
    what: string,
  ): void => {
    target.params.forEach((pt, i) => {
      const a = args[i];
      if (typeof a === "number") code.push(I.f64const, ...f64(a));
      else if (a === undefined)
        throw new WasmEmitError(`${what} needs ${target.params.length} arguments`);
      else pushAs(a, pt, `argument ${i + 1} of ${what}`);
    });
    code.push(I.call, target.tok);
  };

  const emitNode = (n: DucNode): void => {
    if (n.kind === "literal-source" || n.kind === "param-source" || n.kind === "carry-source")
      return;
    if (n.kind === "diamond-source") return;
    const out = n.outputs[0] as ValueId | undefined;
    if (out === undefined) throw new WasmEmitError(`"${n.label}" has no result`);
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
    if (n.kind !== "op") throw new WasmEmitError(`a ${n.kind} node is not in the subset`);
    if (/^\.\w+$/.test(label) && ins.length === 1) {
      const t0 = ty(ins[0] as ValueId);
      if (typeof t0 === "object") return; // a Math constant, pushed where it is used
      if (t0 === "str" && label === ".length") {
        push(ins[0] as ValueId);
        code.push(...GC.arrayLen, I.f64fromU32);
        set(out);
        return;
      }
      if (t0 === "nums" && label === ".length") {
        push(ins[0] as ValueId);
        code.push(...GC.numsLen, I.f64fromI32);
        set(out);
        return;
      }
    }
    if (label === "CallExpression") {
      const callee = (ty(ins[0] as ValueId) as { call: Callee }).call;
      const args = ins.slice(1);
      if (callee.k === "math") {
        const m = callee.name;
        if (NATIVE_MATH[m] !== undefined && args.length === 1) {
          pushNumber(args[0] as ValueId);
          code.push(NATIVE_MATH[m] as number);
        } else if ((m === "min" || m === "max") && args.length >= 1) {
          pushNumber(args[0] as ValueId);
          for (const a of args.slice(1)) {
            pushNumber(a);
            code.push(m === "min" ? I.f64min : I.f64max);
          }
        } else {
          const tok = mod.importHost(`Math.${m}`, args.length);
          for (const a of args) pushNumber(a);
          code.push(I.call, tok);
        }
      } else if (callee.k === "number-of") {
        if (args.length === 0) code.push(I.f64const, ...f64(0));
        else pushNumber(args[0] as ValueId);
      } else if (callee.k === "string-of") {
        if (args.length === 0) pushText("");
        else pushString(args[0] as ValueId);
      } else if (callee.k === "method" && callee.name === "toString") {
        if (args.length > 0)
          throw new WasmEmitError("toString with a radix is not in the subset yet");
        pushString(callee.recv);
      } else if (callee.k === "method" && callee.name === "nums.push") {
        if (args.length !== 1)
          throw new WasmEmitError("push of other than one value is not in the subset yet");
        call(mod.primitive("numsPush"), [callee.recv, args[0] as ValueId], "push");
      } else if (callee.k === "method" && callee.name === "nums.pop") {
        call(mod.primitive("numsPop"), [callee.recv], "pop");
      } else if (callee.k === "prim") call(mod.primitive(callee.name), args, callee.name);
      else if (callee.k === "atom") call(mod.atom(callee.name), args, callee.name);
      else {
        const m = STRING_METHODS[callee.name] as (typeof STRING_METHODS)[string];
        const atom = mod.atom(m.atom);
        const given: (ValueId | number)[] = [callee.recv];
        m.args.forEach((d, i) => {
          const a = args[i];
          if (a !== undefined) given.push(a);
          else if (d === "str")
            throw new WasmEmitError(`.${callee.name} without a string to search for`);
          else given.push(d);
        });
        call(atom, given, `.${callee.name}`);
        if (m.notFound === true) code.push(I.f64const, ...f64(-1), I.f64ne);
      }
      set(out);
      return;
    }
    if (ins.length === 2 && label === "+" && t === "any") {
      push(ins[0] as ValueId, "any");
      push(ins[1] as ValueId, "any");
      code.push(I.call, mod.atom("__ykAdd").tok);
      set(out);
      return;
    }
    if (ins.length === 2 && label === "+" && t === "str") {
      pushString(ins[0] as ValueId);
      pushString(ins[1] as ValueId);
      code.push(I.call, mod.primitive("__ykJoin").tok);
      set(out);
      return;
    }
    if (label === "ArrayLiteral") {
      if (ins.length === 0) pushDefault("nums");
      else {
        code.push(I.i32const, ...s32(ins.length));
        for (const v of ins) pushNumber(v);
        code.push(...GC.f64sNewFixed(ins.length), ...GC.numsNew);
      }
      set(out);
      return;
    }
    if (label === "ElementAccess") {
      call(mod.primitive(t === "any" ? "numsAt" : "numsGet"), ins, "an element read");
      set(out);
      return;
    }
    if (label === "[]=") {
      call(mod.primitive("numsSet"), ins, "an element write");
      set(out);
      return;
    }
    if (label.startsWith("template:")) {
      const texts = JSON.parse(label.slice("template:".length)) as string[];
      const join = mod.primitive("__ykJoin").tok;
      pushText(texts[0] ?? "");
      ins.forEach((v, i) => {
        pushString(v);
        code.push(I.call, join);
        pushText(texts[i + 1] ?? "");
        code.push(I.call, join);
      });
      set(out);
      return;
    }
    if (ins.length === 2 && F64_BINARY[label] !== undefined) {
      pushNumber(ins[0] as ValueId);
      pushNumber(ins[1] as ValueId);
      code.push(F64_BINARY[label] as number);
      set(out);
      return;
    }
    if (ins.length === 2 && (label === "%" || label === "**")) {
      const tok = mod.importHost(label, 2);
      pushNumber(ins[0] as ValueId);
      pushNumber(ins[1] as ValueId);
      code.push(I.call, tok);
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
          code.push(I.call, mod.atom(strictly ? "__ykStrictEquals" : "__ykLooseEquals").tok);
          if (negated) code.push(I.i32eqz);
        } else {
          const swap = label === ">" || label === "<=";
          push(swap ? b : a, "any");
          push(swap ? a : b, "any");
          code.push(I.call, mod.atom("__ykCompare").tok);
          code.push(I.f64const, ...f64(label === "<" || label === ">" ? 0 : 1), I.f64eq);
        }
        set(out);
        return;
      }
      const ta = value(a, "an operand");
      const tb = value(b, "an operand");
      // ECMAScript's IsStrictlyEqual, IsLooselyEqual and IsLessThan over these types. An array of
      // numbers is an object: equal only to itself, and a primitive (its join) where one is needed.
      const strictly = label === "===" || label === "!==";
      const strLike = (t: WT) => t === "str" || t === "nums";
      if (ta === tb && equality) {
        if (ta === "str") call(mod.atom("__ykStrEquals"), [a, b], label);
        else {
          push(a);
          push(b);
          code.push(ta === "nums" ? I.refEq : ta === "i32" ? I.i32eq : I.f64eq);
        }
        if (negated) code.push(I.i32eqz);
      } else if (equality && strictly) {
        code.push(I.i32const, negated ? 1 : 0);
      } else if (equality && strLike(ta) && strLike(tb)) {
        // A string and an array: the array's join, compared as a string.
        pushString(a);
        pushString(b);
        code.push(I.call, mod.atom("__ykStrEquals").tok);
        if (negated) code.push(I.i32eqz);
      } else if (!equality && strLike(ta) && strLike(tb)) {
        // Both primitives are strings: compared by code units. a > b is b < a; a <= b is !(b < a);
        // a >= b is !(a < b).
        const swap = label === ">" || label === "<=";
        pushString(swap ? b : a);
        pushString(swap ? a : b);
        code.push(I.call, mod.atom("__ykStrLess").tok);
        if (label === "<=" || label === ">=") code.push(I.i32eqz);
      } else {
        pushNumber(a);
        pushNumber(b);
        code.push(F64_COMPARE[label] as number);
      }
      set(out);
      return;
    }
    if (ins.length === 1 && label === "-") {
      pushNumber(ins[0] as ValueId);
      code.push(I.f64neg);
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
        code.push(I.call, mod.atom("__ykTypeOf").tok);
      } else {
        const names: Record<string, string> = {
          f64: "number",
          i32: "boolean",
          str: "string",
          nums: "object",
          undef: "undefined",
        };
        const name0 = typeof t0 === "string" ? names[t0] : undefined;
        if (name0 === undefined) throw new WasmEmitError("typeof of a function");
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
        code.push(I.call, mod.primitive("__ykTag").tok, I.f64const, ...f64(2), I.f64ge);
        select(t as WT);
      }
      set(out);
      return;
    }
    if (ins.length === 1 && label === "!") {
      truthy(ins[0] as ValueId);
      code.push(I.i32eqz);
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
    throw new WasmEmitError(`the operation "${label}" is not in the subset`);
  };

  const { itemsOf, ordered, needsOf, producesOf } = scopePlanner(
    g,
    owners,
    resolve,
    (m) => new WasmEmitError(m),
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
    code.push(I.if, 0x40);
    emitScope(sidePath(b, "t"));
    for (const j of joins) assign(j.outputs[0] as ValueId, j.inputs[1] as ValueId);
    code.push(I.else);
    emitScope(sidePath(b, "e"));
    for (const j of joins) assign(j.outputs[0] as ValueId, j.inputs[2] as ValueId);
    code.push(I.end);
  };
  const emitLoop = (loop: DucNode): void => {
    const rec = loop.loop as DucLoop;
    const body = bodyPathOf(loop);
    rec.carry.forEach((c, i) => assign(c, loop.inputs[i] as ValueId));
    code.push(I.block, 0x40, I.loop, 0x40);
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
    code.push(I.i32eqz, I.brIf, ...u32(1));
    emitItems(items.filter((it) => !forCond.has(it)));
    // The next carries, computed together, then assigned.
    const live = rec.carry
      .map((c, i) => ({ c, next: rec.next[i] as ValueId, t: ty(c) }))
      .filter((x) => typeof x.t === "string" && x.t !== "undef");
    for (const x of live) push(x.next, x.t as WT);
    for (const x of [...live].reverse()) set(x.c);
    code.push(I.br, ...u32(0), I.end, I.end);
    loop.outputs.forEach((v, i) => assign(v, rec.carry[i] as ValueId));
  };

  emitScope(undefined);
  // The result as the contract types it: a value of any kind is read as the kind it says.
  const computed = opType(g.obs[0] as ValueId);
  if (typeof computed !== "string" || computed === "undef")
    throw new WasmEmitError("the result has no value here");
  const result = declared ?? computed;
  if (result !== computed && computed !== "any" && result !== "any")
    throw new WasmEmitError(
      `the result is ${show(computed)}, and the contract says ${show(result)}`,
    );
  push(g.obs[0] as ValueId, result);
  code.push(I.end);
  return { result, locals, code };
}

/**
 * The graph lowered to a WasmGC module exporting `f`, with the runtime atoms it reaches. The
 * signature's output type is required, and must not include undefined.
 */
export function emitWasmGc(input: DucGraph, signature: WasmSignature): WasmGcModule {
  // ECMAScript's operations: each generic operation as the case of them it is (#1310).
  const source = ecmaScriptView(input);
  if (signature.output === undefined)
    throw new WasmEmitError("the contract's output type is needed");
  const out = parseType(signature.output);
  const params = signature.inputs.map((t, i) => wt(parseType(t), `parameter ${i}`));
  const result = wt(out, "the result");
  const mod = new Module();
  const f: Func = { params, result, locals: [], code: [] };
  mod.funcs.set("f", f);
  const lowered = lowerFunction(source, params, result, mod);
  f.locals = lowered.locals;
  f.code = lowered.code;
  // The boundary: values made and read from JavaScript, and a value of any kind's kind and parts.
  const exports: Record<string, string> = { f: "f" };
  for (const [k, sig] of Object.entries(MARSHAL)) {
    mod.funcs.set(`mar:${k}`, { ...sig, ...primitiveBody(k) });
    exports[k] = `mar:${k}`;
  }
  for (const k of ["__ykTag", "__ykNum", "__ykBool", "__ykStr", "__ykArr"]) {
    mod.primitive(k);
    exports[k] = `prim:${k}`;
  }
  const bytes = mod.write(exports);
  return { bytes, imports: [...mod.imports], params, result, atoms: [...mod.atoms] };
}

/** The module instantiated: `f` as JavaScript calls it, with strings converted at the boundary. */
export async function instantiateWasmGc(m: WasmGcModule): Promise<(...args: unknown[]) => unknown> {
  const host: Record<string, (...a: number[]) => number> = {};
  for (const n of m.imports) host[n] = WASM_HOST[n] as (...a: number[]) => number;
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
  const x = instance.exports as Record<string, (...a: unknown[]) => unknown>;
  const fn = (k: string) => x[k] as (...a: unknown[]) => unknown;
  const toWasm = (v: unknown, t: WT): unknown => {
    if (t === "i32") return v ? 1 : 0;
    if (t === "f64") return v;
    if (t === "nums") {
      const a = v as readonly number[];
      const r = fn("numsNew")(a.length);
      a.forEach((e, i) => fn("numsSetAt")(r, i, e));
      return r;
    }
    if (t === "any") {
      if (v === undefined) return fn("mkUndef")();
      if (v === null) return fn("mkNull")();
      if (typeof v === "boolean") return fn("mkBool")(v ? 1 : 0);
      if (typeof v === "number") return fn("mkNum")(v);
      if (typeof v === "string") return toWasm(v, "str");
      if (Array.isArray(v) && v.every((e) => typeof e === "number")) return toWasm(v, "nums");
      throw new TypeError(`${String(v)} is not a value the WasmGC lowering represents`);
    }
    const s = String(v);
    const r = fn("strNew")(s.length);
    for (let i = 0; i < s.length; i++) fn("strSet")(r, i, s.charCodeAt(i));
    return r;
  };
  const fromWasm = (v: unknown, t: WT): unknown => {
    if (t === "i32") return v !== 0;
    if (t === "f64") return v;
    if (t === "nums") {
      const n = fn("numsLen")(v) as number;
      return Array.from({ length: n }, (_, i) => fn("numsGetAt")(v, i));
    }
    if (t === "any") {
      const tag = fn("__ykTag")(v);
      if (tag === 0) return undefined;
      if (tag === 1) return null;
      if (tag === 2) return fn("__ykBool")(v) !== 0;
      if (tag === 3) return fn("__ykNum")(v);
      return fromWasm(v, tag === 4 ? "str" : "nums");
    }
    const n = fn("strLen")(v) as number;
    let s = "";
    for (let i = 0; i < n; i++) s += String.fromCharCode(fn("strGet")(v, i) as number);
    return s;
  };
  return (...args) =>
    fromWasm(fn("f")(...args.map((a, i) => toWasm(a, m.params[i] as WT))), m.result);
}
