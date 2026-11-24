# DEC-DUC-TYPED-NATIVE-001: typed specialization of the native lowering

**Status:** Proposed (lane:native)
**Date:** 2026-11-24
**Issue:** https://github.com/cneckar/yakcc/issues/1369
**Related:** DEC-DUC-NATIVE-RUNTIME-001 (boxed values), DEC-DUC-OPERATIONS-AS-ATOMS-001 (the leaves), #1361 (self-rebuild), #1363 (C's memory)

---

## Context
The native lowering boxes every value (DEC-DUC-NATIVE-RUNTIME-001) and calls the runtime for every operation. That is exact for every value a JavaScript graph computes. It is also too slow for raised C:
- SQLite, libuv, simdutf and the TypeScript compiler have to run at usable speed for the self-rebuild (#1370);
- #1369 asks for raised C within 2× of clang `-O2`.

Raised C has a regular shape (`raise-c.ts`):
- numbers are doubles, and C's integers are numbers kept in range by `| 0`, `>>> 0` and `__ykI32Mul`;
- 64-bit integers are BigInts, wrapped by `__ykU64`/`__ykI64`;
- memory is the leaves `__ykLoad*`/`__ykStore*` over integer addresses;
- local constant tables are arrays of numbers.

## Decision
**Specialize, don't replace.** The boxed lowering stays the definition of what a graph computes. A function is also lowered *typed*: each value that the graph proves to have a machine type keeps it, and every other value stays boxed.

### Types
| Static type | Representation | Proven by |
|---|---|---|
| number | `double` | numeric literals, arithmetic of numbers, `| 0`, `>>> 0`, the numeric leaves |
| boolean | `i1` | comparisons, `!`, boolean literals |
| BigInt within 127 bits | `i128` | a **bit-width analysis**, described below |
| anything else | boxed `i64` | — |

**The bit-width analysis.**
- A BigInt from `__ykU64`, `__ykI64`, `__ykLoad64`, `__ykF64Bits`, or a literal is 64 bits wide (its value's width, for a literal).
- `+` and `-` add one bit; `*` adds the widths; `<<` by a literal `k` adds `k`.
- `&`, `|`, `^`, `>>`, `/` and `%` keep the widest operand's width.
- If a value may exceed 127 bits, or is shifted by a non-literal amount and not then wrapped, it stays boxed. `i128` then computes exactly what the arbitrary-precision BigInt does.

### Exactness at the edges
- **Entry guards.** A typed function checks, on entry, that each typed parameter has its type (a number, a boolean, a BigInt that fits). If one does not, it runs the function's boxed lowering instead. A caller that passes something else (JavaScript allows it) therefore gets the boxed result. No source annotation is trusted.
- **ToInt32 and ToUint32** are inline:
  - when `|x| < 2^63`, `fptosi` to `i64` then truncate, which is exactly ECMA-262's modulo;
  - NaN, the infinities, and larger values take the runtime's slow path.
- **BigInt division by zero, and `__ykNumToBig` of a non-integer,** raise the runtime's RangeError, as the boxed lowering does.
- **`Number(i128)` (`__ykBigToF64`)** is LLVM `sitofp`, round to nearest even, as `Number(bigint)` is.

### Memory
The leaves keep their traps (#1363). A load or store checks two caches inline, then calls the runtime:
- **the runtime's cache**: the region last allocated or found (a new frame's accesses hit it);
- **the site's own cache**: the region this access last hit (a function reading its caller's buffer hits it).

A site's cached region is still that region while the 16 bytes before its bytes hold its base: a free clears them, and a reused block holds its new region's base. A large block's bytes go back to the C library, so freeing one changes an epoch that every site's cache holds as well. A hit is an inline compare and a native `load`/`store` (`align 1`, little-endian). A miss calls the runtime, which finds the region or traps, and both caches take it. Addresses, allocation and the traps are the boxed lowering's own.

**Constant data** (`__ykData` of literal elements) is laid out at its first evaluation, and its address kept at the site: the address depends only on the content. Raise-c lowers a `static const` array whose address is taken to constant data, as C's static storage is, rather than a frame filled on every call.

### Arrays of numbers
A local array whose every use is an indexed read or write of a number, and whose reads flow only into numeric operations, is a stack array of doubles. A read out of range gives NaN, which is `ToNumber(undefined)`: exact, because every consumer is numeric. Any other array stays boxed.

### Calls
- A call to a typed function with typed arguments is a direct call with the typed signature.
- Any other call boxes its arguments and goes through the boxed calling convention.

### Floating point
Compile with `-O2` without fast-math and without FP contraction (`-ffp-contract=off`), so no `fma` changes a result.

## Evidence required
- The #1359 Math and the #1363 musl functions lower typed, and equal the boxed lowering and native C bit for bit.
- Their speed is within 2× of clang `-O2` on the same C.

## Alternatives
- **A second, separate typed emitter.** It duplicates the scope, loop and branch lowering, and gives no fallback for values outside its types.
- **Trusting TypeScript annotations.** That is unsound: annotations aren't enforced at run time, and a graph's identity doesn't include them.
- **Fixed 64-bit integers for BigInts.** Wrong for raised C's intermediates: a `u64 × u64` product before `__ykU64` wraps it is 128 bits.
