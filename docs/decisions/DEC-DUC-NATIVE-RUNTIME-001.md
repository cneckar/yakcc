# DEC-DUC-NATIVE-RUNTIME-001: NaN-boxed values and a C runtime for the native lowering

**Status:** Proposed (first slice built)
**Date:** 2026-11-23
**Issue:** https://github.com/cneckar/yakcc/issues/1292 (criteria 3 and 4)
**Related:** DEC-DUC-NATIVE-BACKEND-001 (LLVM backend), #1289 (the typed subset)

---

## Context

The typed native lowering covers numbers and booleans. Everything else a JavaScript graph computes
needs a representation and a runtime: strings, arrays, objects, closures, `undefined` and `null`.

Before the format locks, #1292 asks one question: **does the graph carry what such a lowering needs?**

## Decision

### Representation and runtime

**Values are NaN-boxed into one 64-bit word**, as JavaScript engines box them:
- a double is itself, with NaN canonical;
- every other value has a tag in the top 16 bits (0xFFF9 to 0xFFFC), a space no canonical double uses.

**Strings are UTF-16 code units**, as in JavaScript.

**The runtime is one C file**, `packages/duc/runtime/yk.c`.
- clang, LLVM's C compiler, compiles it for each target, so the lowering and the runtime come from one toolchain.
- It is linked like any C library.
- Its operations follow ECMA-262 for the values it covers: ToNumber (the full StringNumericLiteral grammar), ToString (Number::toString's shortest round-trip digits and layout), ToPrimitive for arrays, `+`, the arithmetic, relational and equality operators, `typeof`, truthiness, property and index reads, and the string and array builtins it lists.

**`emitLlvmBoxed`** lowers a graph to LLVM IR. Every value is an `i64`, and each operation the graph names is a call to the runtime. The exported function is `uint64_t f(uint64_t, …)`.

### What the graph needed

**Nothing new.**

| Lowering needs | The graph already has |
|---|---|
| The runtime function for an operation | Its label, one to one: `+` is `yk_add`, `ElementAccess` is `yk_get`, `.length` is a named read, `template:[…]` is `yk_template` |
| The receiver of a method call | The member read that feeds the call |
| The order calls are made in | The heap token. `loweringView` gives each heap operation the operations it comes after, and the scope planner schedules by them, inside and across branches and loops |

Graph node order is canonical, not source order, so this ordering is required: without it, `xs.push(t)` and a later `xs.length` could be reversed.

### Memory

Values are allocated and never freed. A collector is a later slice. It doesn't change the
representation: a precise collector needs the roots, which are the values the lowering holds in
its stack slots.

## Evidence

**Natively.** Six programs, each run on 500 generated inputs of every kind in the slice, are linked
with the runtime and run on x86-64. They agree with Node exactly (`Object.is`, element by element
for arrays). The inputs include:
- numbers with -0, NaN and ±Infinity, and 1e21 / 1e-7 at the formatting boundaries;
- Unicode strings and awkward numeric strings (`" 0x1F "`, `".5"`, `"5."`, `"+.5e-3"`, NBSP and LS whitespace);
- booleans, `null` and `undefined`;
- arrays of all of these.

The six programs cover:
- `+` on every pair of kinds;
- every other operator with its coercions;
- template literals;
- string methods;
- arrays, with a loop and `push`;
- the exact `Math` on any value.

**Other architectures.** The array program also runs on AArch64, ARMv7 and RISC-V. Each is
cross-linked against the target's glibc, with the runtime compiled by clang for the target, and run
under QEMU, with the same agreement.

**What the tests found:** one runtime bug. `null == undefined` took the same-tag shortcut to strict
equality. It is fixed.

## Next slices

- Objects (property maps, writes) and the prototype methods programs use.
- Closures: a code pointer and the captured values, from the closure's own graph.
- Iteration.
- A collector.
- The boundary a contract's types give, so a typed caller need not box.
