// SPDX-License-Identifier: Apache-2.0
import { C_LEAVES_JS, createCMemory, createCSystem } from "./raise-c.js";

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
  leaf("__ykF32", ["f64"], "f64", "the float64 rounded to binary32, ties to even, widened"),
];

/**
 * Memory (#1363), as the C front end raises it (`raise-c.ts`, #1372): one flat, byte-addressed,
 * little-endian memory per program. An address is an integer (a number, below 2^53), so address
 * arithmetic is float64 arithmetic on integers. Address 0 is never allocated. An access is defined
 * inside a live block, and traps outside one (the reference implementation checks; a native
 * lowering may leave the check out where the source's own meaning leaves the access undefined).
 * Loads are unsigned: a signed type's value is the integer operations on the bits. A store writes
 * the low bits of its value and gives the value.
 */
const MEMORY_LEAVES: readonly LeafFunction[] = [
  leaf("__ykAlloc", ["f64", "f64"], "addr", "a new block of n bytes aligned to a, zeroed"),
  leaf("__ykFree", ["addr"], "void", "release a block from __ykAlloc"),
  leaf("__ykData", ["f64", "f64"], "addr", "constant memory: a kind's values laid out, read-only"),
  leaf("__ykLoad8", ["addr"], "f64", "a byte, unsigned"),
  leaf("__ykLoad16", ["addr"], "f64", "2 bytes, unsigned"),
  leaf("__ykLoad32", ["addr"], "f64", "4 bytes, unsigned"),
  leaf("__ykLoad64", ["addr"], "i64", "8 bytes, unsigned"),
  leaf("__ykLoadF32", ["addr"], "f64", "a binary32, widened exactly"),
  leaf("__ykLoadF64", ["addr"], "f64", "a binary64"),
  leaf("__ykStore8", ["addr", "f64"], "f64", "the low 8 bits of an integer"),
  leaf("__ykStore16", ["addr", "f64"], "f64", "the low 16 bits of an integer"),
  leaf("__ykStore32", ["addr", "f64"], "f64", "the low 32 bits of an integer"),
  leaf("__ykStore64", ["addr", "i64"], "i64", "the low 64 bits of a bigint"),
  leaf("__ykStoreF32", ["addr", "f64"], "f64", "the float64 rounded to binary32, ties to even"),
  leaf("__ykStoreF64", ["addr", "f64"], "f64", "a binary64"),
];

/**
 * Functions as values and module state, in memory (#1363): C's function pointers and statics, as
 * the C front end raises them.
 */
const REFERENCE_LEAVES: readonly LeafFunction[] = [
  leaf("__ykFnAddr", ["f64"], "addr", "a function's address: one per function, never 0"),
  leaf("__ykFnAt", ["addr"], "f64", "the function at an address from __ykFnAddr"),
  leaf("__ykStatic", ["f64"], "addr", "a static's block, by its key: defined once, initialized"),
];

/**
 * Layer 0 (#1365, DEC-DUC-NODE-BASE-SET-001): the operating system, below the shaved C library.
 * `__yk_syscall` is Linux's system call by its x86-64 number (createCSystem gives its meaning per
 * call); `__yk_tp` is the thread pointer.
 */
const SYSTEM_LEAVES: readonly LeafFunction[] = [
  leaf(
    "__yk_syscall",
    ["i64", "i64", "i64", "i64", "i64", "i64", "i64"],
    "i64",
    "the system call n with six arguments: its result, or -errno",
  ),
  leaf("__yk_tp", [], "i64", "the thread pointer: a block whose first word is its own address"),
  leaf(
    "__yk_cpuid",
    ["f64", "f64", "f64"],
    "f64",
    "cpuid: register reg (0 eax, 1 ebx, 2 ecx, 3 edx) for the leaf and subleaf, the machine's",
  ),
];

/** Every leaf function, by name. */
export const LEAF_FUNCTIONS: ReadonlyMap<string, LeafFunction> = new Map(
  [...INTEGER_LEAVES, ...BITS_LEAVES, ...MEMORY_LEAVES, ...REFERENCE_LEAVES, ...SYSTEM_LEAVES].map(
    (l) => [l.name, l],
  ),
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

/**
 * The leaf functions' reference implementations, over a fresh memory: what the TypeScript lowering
 * of a graph runs with, and what each target's leaves are tested against. They are the C front
 * end's (`C_LEAVES_JS`, `createCMemory`), which its tests show equal C compiled natively.
 */
export function leafFunctionsJs(): Readonly<Record<string, LeafImpl>> {
  const memory = createCMemory();
  return {
    ...(C_LEAVES_JS as unknown as Record<string, LeafImpl>),
    ...(memory.leaves as unknown as Record<string, LeafImpl>),
    ...(createCSystem(memory).leaves as unknown as Record<string, LeafImpl>),
  };
}
