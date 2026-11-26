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

### Integer ranges
A number that is known to be an int32 or a uint32 needs no range check before ToInt32. Such numbers come from `| 0`, `>>> 0`, the other bitwise operators, `Math.imul`, typed and memory loads, and a uint32 modulo a positive literal.
- **Loop carries.** A carry is in a range when both its initial value and its next value are. An integer literal counts as in every range it fits. The proof is by induction, so no optimistic assumption is involved.
- **Identities.** `x >>> 0` of a uint32 and `x | 0` of an int32 are the value itself.
- **Remainder.** `%` of two non-negative integers below 2^32 is an integer remainder, NaN when divided by zero.
- **No NaN check.** A `+`, `-` or `*` of bounded magnitude is never NaN, so its double is boxed as it is.
- **Integer addresses.** When a memory address is a sum of non-negative integers, the access only checks the address's region.

**`.int` clones.** In some functions, a number parameter starts a loop carry that is kept in a range. In a function with a loop, a parameter that a memory address is built from qualifies too. That function's `.num` clone checks once that each such parameter is an integer in its range, and not `-0`.
- If they all are, it tail-calls its `.int` clone, which assumes those ranges.
- Otherwise it runs its own body.

So a caller that passes anything else still gets exactly the boxed result.

**Integers' own slots.** A value proven an integer keeps its int64 in a slot of its own beside its box:
- a value in a range;
- an integer literal;
- the result of an integer operation, which is exact below 2^53 and never `-0`.

These integer operations on two such integers run on their int64s:
- `+` and `-`, when the result is bounded;
- `%` of a non-negative integer by a positive literal;
- the bitwise operators, on the low 32 bits;
- the comparisons.

A box made from an int64 that nothing uses is dropped. Loop carries keep their int64s, and integer loads give theirs.

### Results and strings
- **Record results.** Some functions return an object literal of distinct named keys, made only to be returned. Such a function also has a `.rec` variant that writes the values into slots the caller provides. A direct call takes it when the result is used only by reads of those keys, and none of those reads is a method call's callee. No object is made.
- **String builders.** A loop variable that starts as a constant string and that the loop only appends to (`out += x` on every path) is a runtime builder while the loop runs. Appends happen in place, each doing ToPrimitive then ToString as `+` does, and the string is made once when the loop exits.

### Floating point
Compile with `-O2` without fast-math and without FP contraction (`-ffp-contract=off`), so no `fma` changes a result.

## Evidence required
- The #1359 Math and the #1363 musl functions lower typed, and equal the boxed lowering and native C bit for bit.
- Their speed is within 2× of clang `-O2` on the same C.

**So far** (instruction counts, callgrind; results equal clang's):

| shaved C | native | clang -O2 | ratio |
|---|---|---|---|
| V8's `sin` + `exp` (`ieee754.cc`), 200K calls each | 76.4M | 41.6M | 1.84× |
| an FNV-style integer loop (xor, `Math.imul`, rotate, add), 2M iterations | 32.5M | 19.2M | 1.69× |
| an adler32-style loop over a 4096-byte local buffer, 500 passes | 60.1M | 27.9M | 2.15× |

What makes the integer loops fast: each proven integer keeps its int64 beside its box, through operations, loop carries and loads; fast paths are marked likely. What the byte loop still pays for is its memory region check on each load.

## Alternatives
- **A second, separate typed emitter.** It duplicates the scope, loop and branch lowering, and gives no fallback for values outside its types.
- **Trusting TypeScript annotations.** That is unsound: annotations aren't enforced at run time, and a graph's identity doesn't include them.
- **Fixed 64-bit integers for BigInts.** Wrong for raised C's intermediates: a `u64 × u64` product before `__ykU64` wraps it is 128 bits.
