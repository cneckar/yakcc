# DEC-DUC-WASM-MEMORY-001: wasm beyond numbers is lowered to WasmGC, with the runtime written as atoms

**Status:** **Decided** (by the user, 2026-11-24): WasmGC, with the runtime's operations written as atoms. The linear-memory build below (option B) stays only until the WasmGC lowering passes the same tests, and is then removed.
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

## Decision

**A, WasmGC.** The objection to A was that it needs a second runtime, to be kept in agreement with
`yk.c`. That objection goes away when the runtime is not hand-written for a target: **its
operations are atoms**, graphs like any other, lowered to each target. The same atoms define
ToNumber, ToString, the relational and equality algorithms, property order and the string and array
methods, for wasm, for the JVM (DEC-DUC-BYTECODE-TARGETS-001), and in time for native code. Each
atom is checked by the same differential tests against the TypeScript reference.

**What this needs:**
- **A value representation in WasmGC.** A value is an `anyref`:
  - a number is a boxed `f64` (or an `i31ref` where the types prove a small integer);
  - a string is an `(array i16)` of UTF-16 units;
  - an array is a struct over a growable `(array (mut anyref))`;
  - an object is a struct of keys and values in insertion order;
  - a closure is a struct of a `funcref` and its captures.
- **Runtime atoms:** the operations above, written once in TypeScript and lifted like any atom. The typed parts lower through `emitWasm`'s direct path, extended with GC types.
- **Exceptions** become wasm exception handling.
- **Async functions and generators** need stack switching (the stack-switching proposal, or JSPI in JavaScript hosts) or a transform; until then they are refused with the reason.

**Progress, slice 1 (strings):** `emitWasmGc` (`packages/duc/src/emit-wasm-gc.ts`).
- **Values:** a string is an `(array (mut i16))`.
- **Primitives:** only three are written in wasm: a unit at an index, a substring by checked bounds, and the join of two strings. Plus `length`.
- **Runtime atoms:** `charCodeAt`, `charAt`, `slice`, `substring`, `indexOf`, `includes`, `startsWith`, `endsWith`, `trim`, and string `===` and `<` (`wasm-runtime-atoms.ts`). Each is lifted from its TypeScript and lowered by the same lowerer, and each equals the engine's builtin exactly on 400 generated inputs, as JavaScript and as WasmGC.
- **Programs** over strings and numbers, with loops that return early, agree exactly with the TypeScript reference.
- **The typed subset:** every emit case `emitWasm` lowers, `emitWasmGc` lowers too, with the same results.
- **Refused for now, with reasons:** ToString of a number, `==` across types, string methods not yet written as atoms, objects, arrays, closures and throws.

**Progress, slice 2 (Number::toString and arrays of numbers):**
- **Number::toString is a runtime atom** (`__ykNumberToString`). It uses Burger and Dybvig's free-format algorithm, which gives the shortest digits that round-trip, the closest, with ties to an even digit as V8 does. It works on exact big integers, which are atoms too (`BIGNUM_ATOMS`: limbs in base 2^24 in a `number[]`), followed by ECMAScript's layout of the digits. It equals V8's `String(x)` on 2977 doubles, as JavaScript and as WasmGC. The doubles include the specials, subnormals, both ends of the range, the layout's boundaries, powers of two and ten, and random bit patterns.
- **Three more primitives:** a double's high and low 32 bits, and a one-unit string.
- **Arrays of numbers:** a struct of a length and a growable `(array (mut f64))`, with `push`, `pop`, element reads and writes, and `length`. Heap operations keep their order (`loweringView`'s `after`).
  Element reads and writes are lowered only in runtime atoms for now: an out-of-range read is undefined in JavaScript, and a program's typed number cannot hold it.
- **ToString in programs:** a string `+` with a number or a boolean, `String(x)`, `x.toString()` and template literals.

**Progress, slice 3 (ToNumber, and the atoms of dynamic values):**
- **StringToNumber is a runtime atom** (`__ykStringToNumber`). It implements ECMAScript's grammar: whitespace, the `Infinity` forms, `0x`/`0o`/`0b` integers, and decimals with an exponent. A decimal is read exactly, as a big integer times a power of ten (`__ykDecimalToDouble`), then rounded once to the nearest double, ties to even (`__ykBigToDouble`). It equals V8's `Number(s)` on 3147 strings, as JavaScript and as WasmGC. The strings include subnormals, overflow, halfway cases, and every double written three ways.
- **ToNumber in programs:** `Number(x)`, unary `+`, and arithmetic on a string, a boolean or an array of numbers (whose primitive is its join).
- **Comparisons across types**, as ECMAScript defines them:
  - `==` across types converts both sides;
  - relational operators compare as strings when both primitives are strings, and as numbers otherwise;
  - an array is equal only to itself;
  - `+` with an array concatenates its join.
- **The atoms of dynamic values** (`DYNAMIC_ATOMS`): ToNumber, ToString, `typeof`, truthiness, `===`, `==`, `+`, and the relational comparison, each over every kind of value (undefined, null, booleans, numbers, strings, arrays of numbers). Each agrees with the engine on 1000 generated pairs, as JavaScript and as WasmGC.
- **Values of any kind** are `anyref`s:
  - a number is a box, a struct of one f64;
  - a boolean is the i31 0 or 1, and undefined is the i31 2;
  - null is the null reference;
  - a string or an array is itself.

  Six primitives inspect them: `__ykTag` gives the kind, `__ykNum`, `__ykBool`, `__ykStr` and `__ykArr` read the value as that kind, and `__ykSame` is reference equality. Everything else is the atoms.
- **In a program:**
  - A value is of any kind when it can be of two kinds: a parameter or result typed `unknown`, a union, or a choice or loop carry between kinds.
  - An undefined is a value like any other.
  - An element read out of range is undefined.
  - Operators on such values call the atoms, and `??` and `typeof` are lowered.
  - A result is read as the kind its contract says.

  At the boundary, JavaScript values convert both ways, arrays included. In a runtime atom an undefined still stands for a default, because the atoms never observe one.
- **Two primitives:** `__ykPow2`, which is exact over the whole range of doubles, and `__ykUnit`, which is NaN out of range as `charCodeAt` is.
- **A lifter fix:** a block may take the rest of the function when the rest declares again a name the block declares, because the rest's reads are of its own binding. Before this, a loop that returns inside such a block was lifted opaque.

**What stays from B:** its tests. Every program the linear-memory build passes, the WasmGC build must pass on the same inputs. After that, B is removed.

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
