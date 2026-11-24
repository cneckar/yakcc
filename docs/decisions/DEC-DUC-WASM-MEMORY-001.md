# DEC-DUC-WASM-MEMORY-001: wasm beyond numbers — linear memory and the native runtime, or WasmGC

**Status:** **Proposed.** This is for the user to decide. The linear-memory option is built as a first slice, so the choice rests on evidence.
**Date:** 2026-11-23
**Issues:**
- https://github.com/cneckar/yakcc/issues/1300
- https://github.com/cneckar/yakcc/issues/1292 (criterion 3, stack bytecode)

**Related:**
- DEC-DUC-NATIVE-RUNTIME-001 (the value semantics reused here; `runtime/yk.c` is unchanged);
- DEC-DUC-NATIVE-BACKEND-001 (LLVM as the backend);
- #1289 (`emitWasm`, the typed subset).

---

## Context

`emitWasm` (#1289) lowers the typed subset, numbers and booleans, by writing the module itself.
Strings, arrays, objects, closures and exceptions need a heap and the operations on it. #1300 asks
for a choice:
- **WasmGC:** `struct`, `array` and `ref`, preferred where engines support it;
- **a linear-memory heap with an imported runtime.**

The lowering must reuse the value semantics the native runtime settled, without changing `yk.c`.

## Options

### A. WasmGC

Values are GC references: strings as `(array i16)` of UTF-16 units, arrays and objects as structs, closures as a funcref and an array of captures. The engine collects garbage.

- **Engines:** Node 22 here (V8 12.4) accepts and runs a WasmGC module (checked: a `struct.new_default` module validates and returns an object).
  JavaScript's string builtins for wasm (`wasm:js-string`) shipped later, in V8 13, so on this Node a string cannot cross the boundary cheaply.
  WasmGC support in non-browser engines (wasmtime, wasmer) was **not checked here**.
- **Semantics:** the operations must be written again, as wasm. That means:
  - ToNumber's grammar, and ToString's shortest round-trip digits;
  - the relational and equality algorithms;
  - property order, the string and array methods, `sort`, and regular expressions.

  This is a **second runtime**, to be kept in agreement with `yk.c` forever. The only alternative is to import the operations from a JavaScript host, which then works only in a JavaScript host.
- **Size:** small modules. The runtime would be written once, as a module, and imported.

### B. Linear memory, with the native runtime compiled to wasm

- **Values:** every value is a NaN-boxed `i64`, exactly as in DEC-DUC-NATIVE-RUNTIME-001.
- **Operations:** each one is a call into `yk.c`, compiled unchanged for `wasm32-wasi` by clang against a WASI sysroot (wasi-libc).
- **The path:** the graph is lowered to LLVM IR by the same `emitLlvmBoxed` as the native targets, and LLVM's wasm32 backend writes the object.
- **The heap** is the module's linear memory.
- **Exceptions:** the runtime's `setjmp` / `longjmp` handler stack becomes wasm exception handling (`-mllvm -wasm-enable-sjlj`).
- **Built:** `emitWasmBoxed` in `packages/duc/src/emit-wasm.ts`.

- **Semantics:** one runtime and one value model for x86-64, AArch64, ARMv7, RISC-V and wasm. The conformance found natively holds on wasm by construction, and the tests below check it.
- **Engines:** the module imports only WASI preview 1 (checked). It needs no JavaScript glue and no GC proposal, so any WASI engine runs it.
  Exceptions use wasm's exception-handling instructions, as LLVM 18 emits them. V8 12.4 runs them.
- **Memory:** values are allocated and never freed, as in the native runtime today. A collector over linear memory needs its roots. Unlike native code, wasm's locals and operand stack cannot be scanned. So the lowering would have to spill live values to a shadow stack, or the heap would move to WasmGC later.
- **Size:** about **231 KB** per module (`f`, the runtime and wasi-libc, statically linked). An *imported* runtime would be one shared module plus a small module per atom. That needs a convention for sharing memory and the function table, a later slice.
- **Toolchain:** at build time, clang, `llc` and `wasm-ld` (LLVM 18 here), plus a pinned WASI sysroot. wasi-sdk 24 and 22 were both checked. `emitLlvmBoxed`, the lowering itself, needs nothing.
  LLVM 18's setjmp lowering calls the Emscripten-era names (`saveSetjmp`, `testSetjmp`, `getTempRet0`), and wasi-libc has the later ones. A 30-line shim (`WASM_SJLJ_SHIM`) supplies the earlier names. A toolchain with the later names links none of it.

## Proposal

**B now, with A as the later direction for memory.**
- #1300's first requirement is to reuse the settled value semantics. B reuses them *exactly*: the same C file and the same lowering.
- A would start a second implementation of ECMAScript's conversions, which is where the native tests found their bugs.
- B runs in every WASI engine today.
- A's advantage, a collector the engine provides, matters when atoms run long enough to fill memory. When it does, the heap can move to WasmGC behind the same lowering (`emitLlvmBoxed` → runtime calls). Only the runtime's representation changes, not the graph.

**This differs from the stated preference for WasmGC.** The user decides:
1. **B now, A later** (proposed), or A now.
2. Whether the runtime should be **imported** (one shared runtime module, small per-atom modules) rather than linked into every module. Imported is the issue's wording; linked is what is built.
3. Which WASI sysroot to pin. CI needs it to run these tests: `YAKCC_WASI_SYSROOT` and `YAKCC_WASM_BUILTINS`. Without them the suite is skipped.

**The second bytecode:** none was started. #1292's open question (JVM, CIL, Python bytecode, or wasm only) is still open.

## Evidence

`packages/duc/src/emit-wasm-boxed.test.ts`: 8 programs, each run on **300 generated inputs** in Node's
wasm engine through WASI. Every result is identical to the TypeScript reference (`emitTypeScript` of
the same graph):
- numbers by `Object.is`;
- strings by UTF-16 code units;
- arrays and objects element by element and key by key, in order;
- an uncaught throw by its ToString.

The inputs mix:
- doubles with -0, NaN, ±Infinity, 1e21 and 2^53;
- awkward numeric strings;
- strings of arbitrary UTF-16 units, lone surrogates included;
- booleans, `null` and `undefined`;
- arrays of all of these.

| Program | Covers |
|---|---|
| `+` on every pair of kinds | ToPrimitive, concatenation, Number::toString |
| Operators and their coercions | `==`, `===`, relational, `typeof`, arithmetic, `&&` / `\|\|` |
| Strings | template literals, `length`, index, `charCodeAt`, `slice`, `indexOf`, `split`, `trim` |
| Arrays | a loop with `push`, `join`, `slice`, `map`, `filter`, `reduce`, `sort` with a comparator, `includes` |
| Objects | literals, computed keys, reads and writes, methods with `this`, `Object.keys` |
| Closures | captures, a shared counter cell, recursion, functions as values |
| Exceptions, caught | `throw`, `catch`, `finally`, an error's `name` and `message`, a runtime TypeError, `instanceof` |
| Exceptions, uncaught | an Error, `null`, a number |

Also checked:
- **determinism:** the same graph gives byte-identical modules;
- **WASI only:** the module imports nothing outside WASI preview 1, and exports `f`;
- **refusals:** a free name, an async function, and `Math.sin` (which an engine may approximate) are refused with the reason, before any tool runs.

## What the format lacked (classified as in #1299)

**Nothing that must enter identity: no (c).**

| Need | Class | Where it comes from |
|---|---|---|
| The runtime function for each operation, the receiver of a method call, the order of heap operations, closures and their captures, the try primitive | — | Already in the graph, as for the native lowering: its label, its inputs, the heap token, the closure node, `__yakccTry` |
| A typed boundary, so a caller need not box (`f(i64…)` takes boxed values today) | (b) | The contract's signature, which is beside the graph |
| A collector's roots | (a) | Shadow-stack spills in the lowering, or WasmGC |
| One runtime module shared by many atoms | (a) | A linking convention for memory and the table |
| LLVM 18's setjmp names | (a) | The shim, until LLVM 19 |
| Async functions and generators, which the runtime runs on stacks of their own (`ucontext`, #1295) | (a) | wasm stack switching (the stack-switching proposal, or JSPI in JavaScript hosts), or a transform such as Asyncify. WASI has no `ucontext`. So the wasm build compiles the runtime against a header whose context functions trap (`WASM_UCONTEXT_SHIM`), and `emitWasmBoxed` refuses such graphs with the reason |
