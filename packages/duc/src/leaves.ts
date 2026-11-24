// SPDX-License-Identifier: Apache-2.0
/**
 * The leaves (DEC-DUC-OPERATIONS-AS-ATOMS-001, #1362, #1363): the operations a target implements
 * itself. Each is exact, total within its stated domain, and has one meaning. Every other operation
 * is an atom, and a graph names it by a label that is a reference to the atom's root.
 *
 * This module is the one list. The lifter, the closure check and every lowering read it: a lowering
 * implements these and nothing else.
 *
 * Leaves come in two forms in a graph:
 * - **an operation label** the lifter writes for ECMAScript's own exact operations (`f64.add`,
 *   `Math.floor`, the bitwise operators on numbers), listed in `LEAF_OPERATIONS`;
 * - **a call of a leaf function** by its reserved name (`__ykF64Bits(x)`), written by a front end
 *   for an operation ECMAScript has no syntax for (fixed-width integers, a float64's bits, memory),
 *   listed in `LEAF_FUNCTIONS`. The `__yk` prefix is reserved: no source binds it.
 */

/** A leaf function: its name, its parameters' and result's representation, and its meaning. */
export interface LeafFunction {
  readonly name: string;
  /** Each parameter's representation: `f64` a number, `i64` a bigint, `addr` an address. */
  readonly params: readonly LeafType[];
  readonly result: LeafType | "void";
  readonly meaning: string;
}

/**
 * How a leaf's operand is represented in the graph's values: `f64` a number (an integer type's
 * values are numbers in its range), `i64` a bigint (64-bit integers, wrapped by the leaves), `addr`
 * an address (a number: a non-negative integer below 2^53).
 */
export type LeafType = "f64" | "i64" | "addr";

const leaf = (
  name: string,
  params: readonly LeafType[],
  result: LeafType | "void",
  meaning: string,
): LeafFunction => ({ name, params, result, meaning });

/** Fixed-width integers: C's types, two's complement. A float64 to an integer truncates. */
const INTEGER_LEAVES: readonly LeafFunction[] = [
  leaf("__ykI32Mul", ["f64", "f64"], "f64", "the low 32 bits of the product, as a signed integer"),
  leaf("__ykU64", ["i64"], "i64", "the value modulo 2^64, in [0, 2^64)"),
  leaf("__ykI64", ["i64"], "i64", "the value modulo 2^64, in [-2^63, 2^63)"),
  leaf("__ykNumToBig", ["f64"], "i64", "an integral float64 as a 64-bit integer"),
  leaf("__ykBigToI32", ["i64"], "f64", "the low 32 bits, signed"),
  leaf("__ykBigToU32", ["i64"], "f64", "the low 32 bits, unsigned"),
  leaf("__ykBigToF64", ["i64"], "f64", "the nearest float64, ties to even"),
  leaf("__ykF64ToI64", ["f64"], "i64", "truncated toward zero, modulo 2^64, signed"),
];

/** A float64's representation: its 64 bits. Its words are integer operations on the bits. */
const BITS_LEAVES: readonly LeafFunction[] = [
  leaf("__ykF64Bits", ["f64"], "i64", "the IEEE 754 binary64 bits, unsigned"),
  leaf("__ykF64FromBits", ["i64"], "f64", "the float64 whose bits are the low 64 bits"),
];

/**
 * Memory (#1363): one flat, byte-addressed, little-endian memory per program. Address 0 is never
 * allocated. An access is defined within an allocated block and refused (a trap) outside it; the
 * reference lowering checks, and a native lowering may omit the check where the source's own
 * meaning makes the access undefined (C's out-of-bounds access).
 *
 * Integers load as numbers (8, 16 and 32 bits, sign- or zero-extended) or as a bigint (64 bits);
 * a store writes the low bits of its value. An address is a number, so address arithmetic is
 * float64 arithmetic on integers, exact below 2^53.
 */
const MEMORY_LEAVES: readonly LeafFunction[] = [
  leaf("__ykAlloc", ["f64", "f64"], "addr", "a new block of n bytes aligned to a, zeroed"),
  leaf("__ykFree", ["addr"], "void", "release a block from __ykAlloc"),
  leaf("__ykLoadI8", ["addr"], "f64", "a byte, sign-extended"),
  leaf("__ykLoadU8", ["addr"], "f64", "a byte, zero-extended"),
  leaf("__ykLoadI16", ["addr"], "f64", "2 bytes, sign-extended"),
  leaf("__ykLoadU16", ["addr"], "f64", "2 bytes, zero-extended"),
  leaf("__ykLoadI32", ["addr"], "f64", "4 bytes, signed"),
  leaf("__ykLoadU32", ["addr"], "f64", "4 bytes, unsigned"),
  leaf("__ykLoadI64", ["addr"], "i64", "8 bytes, signed"),
  leaf("__ykLoadU64", ["addr"], "i64", "8 bytes, unsigned"),
  leaf("__ykLoadF32", ["addr"], "f64", "a binary32, widened exactly"),
  leaf("__ykLoadF64", ["addr"], "f64", "a binary64"),
  leaf("__ykStore8", ["addr", "f64"], "void", "the low 8 bits of an integer"),
  leaf("__ykStore16", ["addr", "f64"], "void", "the low 16 bits of an integer"),
  leaf("__ykStore32", ["addr", "f64"], "void", "the low 32 bits of an integer"),
  leaf("__ykStore64", ["addr", "i64"], "void", "the low 64 bits of a bigint"),
  leaf("__ykStoreF32", ["addr", "f64"], "void", "the float64 rounded to binary32, ties to even"),
  leaf("__ykStoreF64", ["addr", "f64"], "void", "a binary64"),
  leaf("__ykMemCopy", ["addr", "addr", "f64"], "void", "n bytes, as if through a temporary"),
  leaf("__ykMemFill", ["addr", "f64", "f64"], "void", "n bytes set to the low 8 bits of a value"),
];

/** Every leaf function, by name. */
export const LEAF_FUNCTIONS: ReadonlyMap<string, LeafFunction> = new Map(
  [...INTEGER_LEAVES, ...BITS_LEAVES, ...MEMORY_LEAVES].map((l) => [l.name, l]),
);

/** The memory leaves' names (#1363). */
export const MEMORY_LEAF_NAMES: readonly string[] = MEMORY_LEAVES.map((l) => l.name);

/** True when `name` is a leaf function's reserved name. */
export function isLeafFunction(name: string): boolean {
  return LEAF_FUNCTIONS.has(name);
}

/**
 * ECMAScript's `Math` functions that are leaves: exact IEEE 754 operations every target has (`sqrt`
 * is correctly rounded by IEEE 754; the others are exact).
 */
export const MATH_LEAVES: ReadonlySet<string> = new Set([
  "Math.abs",
  "Math.floor",
  "Math.ceil",
  "Math.trunc",
  "Math.sqrt",
]);

/** The generic operation labels that are leaves (IEEE 754 float64, by `ops.ts`). */
export const LEAF_OPERATIONS: ReadonlySet<string> = new Set([
  "f64.add",
  "f64.sub",
  "f64.mul",
  "f64.div",
  "f64.neg",
  "f64.eq",
  "f64.ne",
  "f64.lt",
  "f64.gt",
  "f64.le",
  "f64.ge",
  ...MATH_LEAVES,
]);

/** A leaf function's reference implementation. */
export type LeafImpl = (...args: never[]) => unknown;

/** The memory leaves' reference implementation: one memory, growing, every access checked. */
class ReferenceMemory {
  private bytes = new Uint8Array(1 << 16);
  private view = new DataView(this.bytes.buffer);
  private top = 16; // address 0 (and the first bytes) are never allocated
  /** Allocated blocks: start -> size. */
  private readonly blocks = new Map<number, number>();
  /** Block starts, ascending, for the bounds check. */
  private starts: number[] = [];

  alloc(n: number, align: number): number {
    const a = Math.max(1, align);
    const at = Math.ceil(this.top / a) * a;
    const end = at + Math.max(0, n);
    if (end > this.bytes.length) {
      let size = this.bytes.length;
      while (size < end) size *= 2;
      const grown = new Uint8Array(size);
      grown.set(this.bytes);
      this.bytes = grown;
      this.view = new DataView(grown.buffer);
    }
    this.top = Math.max(end, at + 1);
    this.blocks.set(at, n);
    this.starts.push(at);
    this.bytes.fill(0, at, end);
    return at;
  }

  free(p: number): void {
    if (p === 0) return;
    if (!this.blocks.delete(p)) throw new RangeError(`free of ${p}, not an allocated block`);
    this.starts = this.starts.filter((s) => s !== p);
  }

  /** The address `p` checked for an access of `n` bytes inside one live block. */
  check(p: number, n: number): number {
    let lo = 0;
    let hi = this.starts.length - 1;
    let start = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const s = this.starts[mid] as number;
      if (s <= p) {
        start = s;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    const size = start >= 0 ? this.blocks.get(start) : undefined;
    if (size === undefined || p + n > start + size || !Number.isInteger(p))
      throw new RangeError(`memory access of ${n} bytes at ${p} is outside every block`);
    return p;
  }

  get dv(): DataView {
    return this.view;
  }

  get u8(): Uint8Array {
    return this.bytes;
  }
}

/**
 * The leaf functions' reference implementations, over a fresh memory: what the TypeScript lowering
 * of a graph runs with, and what each target's leaves are tested against.
 */
export function leafFunctionsJs(): Readonly<Record<string, LeafImpl>> {
  const m = new ReferenceMemory();
  const bits = new DataView(new ArrayBuffer(8));
  const le = true;
  return {
    __ykI32Mul: (a: number, b: number): number => Math.imul(a, b),
    __ykU64: (x: bigint): bigint => BigInt.asUintN(64, x),
    __ykI64: (x: bigint): bigint => BigInt.asIntN(64, x),
    __ykNumToBig: (x: number): bigint => BigInt(x),
    __ykBigToI32: (x: bigint): number => Number(BigInt.asIntN(32, x)),
    __ykBigToU32: (x: bigint): number => Number(BigInt.asUintN(32, x)),
    __ykBigToF64: (x: bigint): number => Number(x),
    __ykF64ToI64: (x: number): bigint => BigInt.asIntN(64, BigInt(Math.trunc(x))),
    __ykF64Bits: (x: number): bigint => {
      bits.setFloat64(0, x);
      return bits.getBigUint64(0);
    },
    __ykF64FromBits: (x: bigint): number => {
      bits.setBigUint64(0, BigInt.asUintN(64, x));
      return bits.getFloat64(0);
    },
    __ykAlloc: (n: number, align: number): number => m.alloc(n, align),
    __ykFree: (p: number): void => m.free(p),
    __ykLoadI8: (p: number): number => m.dv.getInt8(m.check(p, 1)),
    __ykLoadU8: (p: number): number => m.dv.getUint8(m.check(p, 1)),
    __ykLoadI16: (p: number): number => m.dv.getInt16(m.check(p, 2), le),
    __ykLoadU16: (p: number): number => m.dv.getUint16(m.check(p, 2), le),
    __ykLoadI32: (p: number): number => m.dv.getInt32(m.check(p, 4), le),
    __ykLoadU32: (p: number): number => m.dv.getUint32(m.check(p, 4), le),
    __ykLoadI64: (p: number): bigint => m.dv.getBigInt64(m.check(p, 8), le),
    __ykLoadU64: (p: number): bigint => m.dv.getBigUint64(m.check(p, 8), le),
    __ykLoadF32: (p: number): number => m.dv.getFloat32(m.check(p, 4), le),
    __ykLoadF64: (p: number): number => m.dv.getFloat64(m.check(p, 8), le),
    __ykStore8: (p: number, v: number): void => m.dv.setUint8(m.check(p, 1), v & 0xff),
    __ykStore16: (p: number, v: number): void => m.dv.setUint16(m.check(p, 2), v & 0xffff, le),
    __ykStore32: (p: number, v: number): void => m.dv.setUint32(m.check(p, 4), v >>> 0, le),
    __ykStore64: (p: number, v: bigint): void =>
      m.dv.setBigUint64(m.check(p, 8), BigInt.asUintN(64, v), le),
    __ykStoreF32: (p: number, v: number): void => m.dv.setFloat32(m.check(p, 4), v, le),
    __ykStoreF64: (p: number, v: number): void => m.dv.setFloat64(m.check(p, 8), v, le),
    __ykMemCopy: (d: number, s: number, n: number): void => {
      if (n <= 0) return;
      m.check(d, n);
      m.check(s, n);
      m.u8.copyWithin(d, s, s + n);
    },
    __ykMemFill: (d: number, v: number, n: number): void => {
      if (n <= 0) return;
      m.u8.fill(v & 0xff, m.check(d, n), d + n);
    },
  };
}
