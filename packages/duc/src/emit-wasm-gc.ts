// SPDX-License-Identifier: Apache-2.0
/**
 * Lowering a graph to WebAssembly with GC types (DEC-DUC-WASM-MEMORY-001, #1300): the stack IR of
 * `lower-stack.ts`, shared with the JVM lowering, encoded as a WasmGC module.
 *
 * A number is `f64`, a boolean `i32`, a string an `(array (mut i16))` of UTF-16 units, as
 * ECMAScript's strings are, an array of numbers a struct of its length and a growable
 * `(array (mut f64))`, and a value of any kind an `anyref` (see BASE_TYPES). The module holds:
 * - the function, `f`;
 * - the runtime atoms it reaches (`wasm-runtime-atoms.ts`), each lifted from its TypeScript and
 *   lowered like any graph;
 * - the primitives the atoms are written over, the only code written directly in wasm;
 * - exports a host uses to make and read values (`MARSHAL`).
 */
import { WASM_HOST, WasmEmitError, type WasmSignature } from "./emit-wasm.js";
import {
  type Ins,
  LoweringError,
  type StackProgram,
  Thrown,
  type WT,
  jsObjectFrom,
  jsObjectParts,
  lowerProgram,
} from "./lower-stack.js";
import type { DucGraph } from "./types.js";

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
/** An array of any values: type 5, a struct of its length and a growable type 4, (array (mut anyref)). */
const ANYS = 4;
const ARR = 5;
/** An object: type 6, a struct of its keys, its values (arrays of any values) and its class. */
const OBJ = 6;
const BASE_TYPES: number[][] = [
  [0x5e, 0x77, 0x01],
  [0x5e, 0x7c, 0x01],
  [0x5f, 0x02, 0x7f, 0x01, 0x63, F64S, 0x01],
  [0x5f, 0x01, 0x7c, 0x00],
  [0x5e, 0x63, 0x6e, 0x01],
  [0x5f, 0x02, 0x7f, 0x01, 0x63, ANYS, 0x01],
  [0x5f, 0x03, 0x63, ARR, 0x01, 0x63, ARR, 0x01, 0x63, 0x6e, 0x01],
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
  arr: [0x63, ARR],
  obj: [0x63, OBJ],
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
  anysNewFixed: (n: number) => [0xfb, 0x08, ANYS, ...u32(n)],
  arrNew: [0xfb, 0x00, ARR],
  arrLen: [0xfb, 0x02, ARR, 0x00],
  boxGet: [0xfb, 0x02, BOX, 0x00],
  refI31: [0xfb, 0x1c],
  i31GetS: [0xfb, 0x1d],
  refTest: (ht: number) => [0xfb, 0x14, ht],
  refCast: (ht: number) => [0xfb, 0x16, ht],
  refCastNull: (ht: number) => [0xfb, 0x17, ht],
  refNullAny: [0xd0, HT_ANY],
  refIsNull: [0xd1],
};

const F64_OPS: Readonly<Record<string, number>> = {
  add: 0xa0,
  sub: 0xa1,
  mul: 0xa2,
  div: 0xa3,
  neg: 0x9a,
  min: 0xa4,
  max: 0xa5,
  floor: 0x9c,
  ceil: 0x9b,
  trunc: 0x9d,
  sqrt: 0x9f,
  abs: 0x99,
  lt: 0x63,
  gt: 0x64,
  le: 0x65,
  ge: 0x66,
  eq: 0x61,
  ne: 0x62,
};
const I32_OPS: Readonly<Record<string, number>> = { eqz: 0x45, and: 0x71, eq: 0x46 };

/** An array of numbers made from its storage: `nums.of` pushes the numbers, then this. */
const NUMS_WRAP = "wasm:numsWrap";
/** An array of any values made from its storage: `arr.of` pushes the values, then this. */
const ARR_WRAP = "wasm:arrWrap";

/** The primitives the boundary reads a value of any kind with. */
const BOUNDARY_READS = [
  "__ykTag",
  "__ykNum",
  "__ykBool",
  "__ykStr",
  "__ykArr",
  "__ykArrAny",
  "__ykObj",
  "__ykObjKeys",
  "__ykObjVals",
  "__ykObjCls",
];

/** The IR as wasm instructions; `index` gives a function's index by key. */
function encode(code: readonly Ins[], index: (fn: string) => number): number[] {
  const out: number[] = [];
  for (const x of code) {
    switch (x.op) {
      case "const.f64":
        out.push(I.f64const, ...f64(x.x));
        break;
      case "const.i32":
        out.push(I.i32const, ...s32(x.x));
        break;
      case "const.str":
        for (let i = 0; i < x.s.length; i++) out.push(I.i32const, ...s32(x.s.charCodeAt(i)));
        out.push(...GC.arrayNewFixed(x.s.length));
        break;
      case "const.undef":
        out.push(I.i32const, UNDEFINED_I31, ...GC.refI31);
        break;
      case "const.null":
        out.push(...GC.refNullAny);
        break;
      case "nums.of":
        out.push(...GC.f64sNewFixed(x.n), I.call, ...u32(index(NUMS_WRAP)));
        break;
      case "get":
        out.push(I.get, ...u32(x.i));
        break;
      case "set":
        out.push(I.set, ...u32(x.i));
        break;
      case "call":
        out.push(I.call, ...u32(index(x.fn)));
        break;
      case "f64":
        out.push(F64_OPS[x.name] as number);
        break;
      case "i32":
        out.push(I32_OPS[x.name] as number);
        break;
      case "f64.of.i32":
        out.push(I.f64fromI32);
        break;
      case "str.len":
        out.push(...GC.arrayLen);
        break;
      case "nums.len":
        out.push(...GC.numsLen);
        break;
      case "arr.of":
        out.push(...GC.anysNewFixed(x.n), I.call, ...u32(index(ARR_WRAP)));
        break;
      case "arr.len":
        out.push(...GC.arrLen);
        break;
      case "to.any":
        if (x.from === "f64") out.push(...GC.boxNew);
        else if (x.from === "i32") out.push(I.i32eqz, I.i32eqz, ...GC.refI31);
        break;
      case "from.any":
        if (x.to === "f64") out.push(...GC.refCast(BOX), ...GC.boxGet);
        else if (x.to === "i32") out.push(...GC.refCast(HT_I31), ...GC.i31GetS);
        else if (x.to !== "any")
          out.push(
            ...GC.refCastNull(
              x.to === "str" ? STR : x.to === "nums" ? NUMS : x.to === "arr" ? ARR : OBJ,
            ),
          );
        break;
      case "ref.eq":
        out.push(I.refEq);
        break;
      case "select":
        if (x.t === "f64" || x.t === "i32") out.push(I.select);
        else out.push(I.selectT, ...vec([VAL[x.t]]));
        break;
      case "drop":
        out.push(0x1a);
        break;
      case "if":
        out.push(I.if, 0x40);
        break;
      case "else":
        out.push(I.else);
        break;
      case "end":
        out.push(I.end);
        break;
      case "block":
        out.push(I.block, 0x40);
        break;
      case "loop":
        out.push(I.loop, 0x40);
        break;
      case "br":
        out.push(I.br, ...u32(x.depth));
        break;
      case "br_if":
        out.push(I.brIf, ...u32(x.depth));
        break;
      // Exceptions: one tag (0), whose payload is the thrown value of any kind.
      case "throw":
        out.push(0x08, 0);
        break;
      case "try":
        out.push(0x06, 0x40);
        break;
      case "catch":
        out.push(0x07, 0);
        break;
    }
  }
  return out;
}

/** A primitive's code: bytes, and functions it calls by key (given indices when it is written). */
type Tok = number | { readonly fn: string };

/** A function as it is written: its signature, its locals and its code. */
interface WasmFunc {
  readonly params: readonly WT[];
  readonly result: WT | undefined;
  readonly locals: readonly (readonly number[])[];
  readonly code: (fnIndex: (fn: string) => number) => number[];
}

const resolveToks = (code: readonly Tok[], ix: (fn: string) => number): number[] =>
  code.flatMap((t) => (typeof t === "number" ? [t] : u32(ix(t.fn))));

/** The program as a module: its functions, the internal and marshalling ones, and the exports. */
function writeModule(prog: StackProgram, exports: Readonly<Record<string, string>>): Uint8Array {
  const funcs = new Map<string, WasmFunc>();
  for (const [k, f] of prog.funcs) {
    if (f.kind === "lowered")
      funcs.set(k, {
        params: f.params,
        result: f.result,
        locals: f.locals.map((t) => VAL[t]),
        code: (ix) => [...encode(f.code, ix), I.end],
      });
    else {
      const body = primitiveBody(k.slice("prim:".length));
      funcs.set(k, {
        params: f.params,
        result: f.result,
        locals: body.locals,
        code: (ix) => resolveToks(body.code, ix),
      });
    }
  }
  funcs.set(ARR_WRAP, {
    params: [],
    result: "arr",
    locals: [],
    code: () => [I.get, 0, ...GC.arrayLen, I.get, 0, ...GC.arrNew, I.end],
  });
  funcs.set(NUMS_WRAP, {
    params: [],
    result: "nums",
    locals: [],
    // Its one parameter is the storage, (ref null F64S): declared below by type.
    code: () => [I.get, 0, ...GC.arrayLen, I.get, 0, ...GC.numsNew, I.end],
  });
  for (const [k, sig] of Object.entries(MARSHAL)) {
    const body = primitiveBody(k);
    funcs.set(`mar:${k}`, {
      ...sig,
      locals: body.locals,
      code: (ix) => resolveToks(body.code, ix),
    });
  }
  const hosts = [...prog.hosts.keys()];
  const order = [...funcs.keys()];
  const index = new Map<string, number>();
  hosts.forEach((h, i) => index.set(`host:${h}`, i));
  order.forEach((k, i) => index.set(k, hosts.length + i));
  const ix = (fn: string): number => {
    const at = index.get(fn);
    if (at === undefined) throw new WasmEmitError(`no function ${fn}`);
    return at;
  };
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
  const throwType = fnType([VAL.any], []);
  const importEntries = hosts.map((h) => {
    const t = fnType(
      Array.from({ length: prog.hosts.get(h) ?? 1 }, () => VAL.f64),
      [VAL.f64],
    );
    return [...name("host"), ...name(h), 0x00, ...u32(t)];
  });
  const funcTypes = order.map((k) => {
    const f = funcs.get(k) as WasmFunc;
    const params =
      k === NUMS_WRAP
        ? [[0x63, F64S]]
        : k === ARR_WRAP
          ? [[0x63, ANYS]]
          : f.params.map((p) => VAL[p]);
    return u32(fnType(params, f.result === undefined ? [] : [VAL[f.result]]));
  });
  const bodies = order.map((k) => {
    const f = funcs.get(k) as WasmFunc;
    const body = [...vec(f.locals.map((l) => [...u32(1), ...l])), ...f.code(ix)];
    return [...u32(body.length), ...body];
  });
  const exportEntries = [
    ...Object.entries(exports).map(([as, k]) => [...name(as), 0x00, ...u32(ix(k))]),
    [...name("ykThrow"), 0x04, 0],
  ];
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
    // The tag of what a program throws: a value of any kind.
    ...section(13, vec([[0x00, ...u32(throwType)]])),
    ...section(7, vec(exportEntries)),
    ...section(10, vec(bodies)),
  ]);
}

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
  arrNew: { params: ["i32"], result: "arr" },
  arrSetAt: { params: ["arr", "i32", "any"], result: undefined },
  arrLen: { params: ["arr"], result: "i32" },
  arrGetAt: { params: ["arr", "i32"], result: "any" },
  objFrom: { params: ["arr", "arr", "any"], result: "obj" },
  mkNum: { params: ["f64"], result: "any" },
  mkBool: { params: ["i32"], result: "any" },
  mkUndef: { params: [], result: "any" },
  mkNull: { params: [], result: "any" },
};

/**
 * An array's operations, for an array of numbers or of any values: a struct of its length and its
 * storage, which grows to 2 len + 4 when full. `Push` gives the new length; `Pop` and `Get` give
 * the missing value (NaN for numbers, never observed in an atom; undefined for any values) for an
 * empty array or an index that is not an integer in [0, length); `Set` writes within the array or
 * at its end (a push). `boxed`: a number read as a value of any kind (`numsAt`).
 */
function arrayPrimitive(
  op: string,
  kind: "nums" | "arr",
  boxed: boolean,
): { locals: number[][]; code: Tok[] } {
  const get = (i: number) => [I.get, ...u32(i)];
  const set = (i: number) => [I.set, ...u32(i)];
  const nums = kind === "nums";
  const store = nums ? F64S : ANYS;
  const struct = nums ? NUMS : ARR;
  const len = [0xfb, 0x02, struct, 0x00];
  const data = [0xfb, 0x02, struct, 0x01];
  const setLen = [0xfb, 0x05, struct, 0x00];
  const setData = [0xfb, 0x05, struct, 0x01];
  const aget = [0xfb, 0x0b, store];
  const aset = [0xfb, 0x0e, store];
  const missing =
    nums && !boxed ? [I.f64const, ...f64(Number.NaN)] : [I.i32const, UNDEFINED_I31, ...GC.refI31];
  const box = nums && boxed ? GC.boxNew : [];
  const resultType = nums && !boxed ? [0x7c] : VAL.any;
  switch (op) {
    case "Push": {
      const [a, x, n, d, grown] = [0, 1, 2, 3, 4];
      return {
        locals: [VAL.i32, [0x63, store], [0x63, store]],
        code: [
          ...get(a),
          ...len,
          ...set(n),
          ...get(a),
          ...data,
          ...set(d),
          ...get(n),
          ...get(d),
          ...GC.arrayLen,
          I.i32eq,
          I.if,
          0x40,
          ...get(n),
          I.i32const,
          1,
          0x74, // i32.shl
          I.i32const,
          4,
          I.i32add,
          0xfb,
          0x07,
          store, // array.new_default
          ...set(grown),
          ...get(grown),
          I.i32const,
          0,
          ...get(d),
          I.i32const,
          0,
          ...get(n),
          0xfb,
          0x11,
          store,
          store, // array.copy
          ...get(a),
          ...get(grown),
          ...setData,
          ...get(grown),
          ...set(d),
          I.end,
          ...get(d),
          ...get(n),
          ...get(x),
          ...aset,
          ...get(a),
          ...get(n),
          I.i32const,
          1,
          I.i32add,
          ...setLen,
          ...get(n),
          I.i32const,
          1,
          I.i32add,
          I.f64fromI32,
          I.end,
        ],
      };
    }
    case "Pop": {
      const [a, n] = [0, 1];
      return {
        locals: [VAL.i32],
        code: [
          ...get(a),
          ...len,
          ...set(n),
          ...get(n),
          I.i32eqz,
          I.if,
          ...resultType,
          ...missing,
          I.else,
          ...get(a),
          ...get(n),
          I.i32const,
          1,
          I.i32sub,
          ...setLen,
          ...get(a),
          ...data,
          ...get(n),
          I.i32const,
          1,
          I.i32sub,
          ...aget,
          ...box,
          I.end,
          I.end,
        ],
      };
    }
    case "Get":
    case "At": {
      // An index is one when it is an integer in [0, length): -0 is 0.
      const [a, i, k] = [0, 1, 2];
      return {
        locals: [VAL.i32],
        code: [
          ...get(i),
          ...GC.truncSat,
          ...set(k),
          ...get(k),
          I.f64fromI32,
          ...get(i),
          I.f64ne,
          ...get(k),
          I.i32const,
          0,
          0x48, // i32.lt_s
          I.i32or,
          ...get(k),
          ...get(a),
          ...len,
          0x4e, // i32.ge_s
          I.i32or,
          I.if,
          ...resultType,
          ...missing,
          I.else,
          ...get(a),
          ...data,
          ...get(k),
          ...aget,
          ...box,
          I.end,
          I.end,
        ],
      };
    }
    case "Set": {
      const [a, i, v, k] = [0, 1, 2, 3];
      return {
        locals: [VAL.i32],
        code: [
          ...get(i),
          ...GC.truncSat,
          ...set(k),
          ...get(k),
          ...get(a),
          ...len,
          I.i32eq,
          I.if,
          0x40,
          ...get(a),
          ...get(v),
          I.call,
          { fn: `prim:${kind}Push` },
          0x1a,
          I.else,
          ...get(a),
          ...data,
          ...get(k),
          ...get(v),
          ...aset,
          I.end,
          ...get(a),
          I.end,
        ],
      };
    }
  }
  throw new WasmEmitError(`no array primitive ${op}`);
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
    case "numsPopAny":
      return arrayPrimitive("Pop", "nums", true);
    case "numsPush":
    case "numsPop":
    case "numsGet":
    case "numsAt":
    case "numsSet":
      return arrayPrimitive(key.slice(4), "nums", key === "numsAt");
    case "arrPush":
    case "arrPop":
    case "arrAt":
    case "arrSet":
      return arrayPrimitive(key === "arrAt" ? "Get" : key.slice(3), "arr", false);
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
          ...get(0),
          ...GC.refTest(OBJ),
          I.if,
          0x7c,
          I.f64const,
          ...f64(7),
          I.else,
          ...get(0),
          ...GC.refTest(NUMS),
          I.if,
          0x7c,
          I.f64const,
          ...f64(5),
          I.else,
          I.f64const,
          ...f64(6),
          I.end,
          I.end,
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
    case "__ykObj":
      return { locals: [], code: [...get(0), ...GC.refCastNull(OBJ), I.end] };
    case "__ykObjNew": {
      const emptyArr = [I.i32const, 0, I.i32const, 0, 0xfb, 0x07, ANYS, ...GC.arrNew];
      return {
        locals: [],
        code: [...emptyArr, ...emptyArr, ...get(0), 0xfb, 0x00, OBJ, I.end],
      };
    }
    case "__ykObjKeys":
    case "__ykObjVals":
    case "__ykObjCls": {
      const field = key === "__ykObjKeys" ? 0 : key === "__ykObjVals" ? 1 : 2;
      return { locals: [], code: [...get(0), 0xfb, 0x02, OBJ, field, I.end] };
    }
    case "objFrom":
      return { locals: [], code: [...get(0), ...get(1), ...get(2), 0xfb, 0x00, OBJ, I.end] };
    case "__ykUndef":
      return { locals: [], code: [I.i32const, UNDEFINED_I31, ...GC.refI31, I.end] };
    case "__ykArrAny":
      return { locals: [], code: [...get(0), ...GC.refCastNull(ARR), I.end] };
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
    case "arrNew":
      return {
        locals: [],
        code: [...get(0), ...get(0), 0xfb, 0x07, ANYS, ...GC.arrNew, I.end],
      };
    case "arrSetAt":
      return {
        locals: [],
        code: [...get(0), 0xfb, 0x02, ARR, 0x01, ...get(1), ...get(2), 0xfb, 0x0e, ANYS, I.end],
      };
    case "arrLen":
      return { locals: [], code: [...get(0), ...GC.arrLen, I.end] };
    case "arrGetAt":
      return {
        locals: [],
        code: [...get(0), 0xfb, 0x02, ARR, 0x01, ...get(1), 0xfb, 0x0b, ANYS, I.end],
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

/**
 * The graph lowered to a WasmGC module exporting `f`, with the runtime atoms it reaches. The
 * signature's output type is required.
 */
export function emitWasmGc(input: DucGraph, signature: WasmSignature): WasmGcModule {
  let prog: StackProgram;
  try {
    prog = lowerProgram(input, signature);
    // The boundary reads a value of any kind with the primitives.
    for (const k of BOUNDARY_READS) prog.primitive(k);
  } catch (e) {
    if (e instanceof LoweringError) throw new WasmEmitError(e.message);
    throw e;
  }
  const f = prog.funcs.get("f");
  if (f?.kind !== "lowered") throw new WasmEmitError("no function f");
  const exports: Record<string, string> = { f: "f" };
  for (const k of Object.keys(MARSHAL)) exports[k] = `mar:${k}`;
  for (const k of BOUNDARY_READS) exports[k] = `prim:${k}`;
  const bytes = writeModule(prog, exports);
  return {
    bytes,
    imports: [...prog.hosts.keys()],
    params: f.params,
    result: f.result,
    atoms: [...prog.atoms],
  };
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
    if (t === "obj") {
      const { keys, vals, cls } = jsObjectParts(v as object);
      return fn("objFrom")(toWasm(keys, "arr"), toWasm(vals, "arr"), toWasm(cls, "any"));
    }
    if (t === "arr") {
      const a = v as readonly unknown[];
      const r = fn("arrNew")(a.length);
      a.forEach((e, i) => fn("arrSetAt")(r, i, toWasm(e, "any")));
      return r;
    }
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
      if (Array.isArray(v))
        return toWasm(v, v.every((e) => typeof e === "number") ? "nums" : "arr");
      if (typeof v === "object") return toWasm(v, "obj");
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
    if (t === "obj") {
      const keys = fromWasm(fn("__ykObjKeys")(v), "arr") as string[];
      const vals = fromWasm(fn("__ykObjVals")(v), "arr") as unknown[];
      return jsObjectFrom(keys, vals, fromWasm(fn("__ykObjCls")(v), "any"));
    }
    if (t === "arr") {
      const n = fn("arrLen")(v) as number;
      return Array.from({ length: n }, (_, i) => fromWasm(fn("arrGetAt")(v, i), "any"));
    }
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
      if (tag === 6) return fromWasm(fn("__ykArrAny")(v), "arr");
      if (tag === 7) return fromWasm(fn("__ykObj")(v), "obj");
      return fromWasm(v, tag === 4 ? "str" : "nums");
    }
    const n = fn("strLen")(v) as number;
    let s = "";
    for (let i = 0; i < n; i++) s += String.fromCharCode(fn("strGet")(v, i) as number);
    return s;
  };
  // What a program throws, uncaught, reaches the caller as a Thrown of the value.
  const tag = (instance.exports as Record<string, unknown>).ykThrow as {
    readonly __brand?: never;
  };
  return (...args) => {
    try {
      return fromWasm(fn("f")(...args.map((a, i) => toWasm(a, m.params[i] as WT))), m.result);
    } catch (e) {
      const ex = e as { is?: (t: unknown) => boolean; getArg?: (t: unknown, i: number) => unknown };
      if (typeof ex?.is === "function" && ex.is(tag) && typeof ex.getArg === "function")
        throw new Thrown(fromWasm(ex.getArg(tag, 0), "any"));
      throw e;
    }
  };
}
