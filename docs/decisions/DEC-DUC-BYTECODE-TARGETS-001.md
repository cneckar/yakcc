# DEC-DUC-BYTECODE-TARGETS-001: the bytecode targets are wasm and the JVM

**Status:** Decided (by the user, 2026-11-24)
**Issue:** https://github.com/cneckar/yakcc/issues/1292 (criterion 3, the open question "which bytecode beyond wasm")
**Related:** DEC-DUC-WASM-MEMORY-001 (wasm on WasmGC)

---

## Decision

The graph is lowered to two bytecodes:
- **WebAssembly**, on WasmGC (DEC-DUC-WASM-MEMORY-001);
- **JVM bytecode** (class files).

There will be **no CIL** (.NET) and **no Python bytecode** lowering.

## Why
- **wasm** runs in browsers, in Node, and in standalone engines.
- **The JVM** reaches Java, Kotlin and Android. Its runtime is garbage-collected and typed by references, like WasmGC, so the two share most of a lowering's design: the value representation, and the runtime's operations as atoms.
- **CIL** would reach .NET, an audience the user chose not to target.
- **Python bytecode** changes with every Python minor version, and the graph is already lowered to Python source (`emitPython`).

## For the format lock (#1292)
Criterion 3's stack-bytecode row now has two representatives, wasm and the JVM. Each must show what
the format lacks, classified (a), (b) or (c) as in #1299, before the lock.

## Progress: the JVM lowering (#1311)

**One lowering, two encodings.**
- `lower-stack.ts` holds everything that decides what a program means:
  - the types, a dataflow fixpoint over the graph;
  - the order of operations (`scopePlanner`, with the heap order of `loweringView`);
  - which runtime atom implements each of ECMAScript's operations.

  It emits a small typed stack IR with structured control.
- `emit-wasm-gc.ts` encodes the IR as WasmGC, and `emit-jvm.ts` encodes it as JVM class files, written directly with no Java source.
- Each target writes only its primitives: the unit at an index, a substring, a join, a value of any kind's tag and parts, and the array operations. The runtime atoms are shared as they are.

**Values on the JVM:**
- a number is a `double`, and a boolean an `int`;
- a string is a `java.lang.String`, which is UTF-16, as ECMAScript's strings are;
- an array of numbers is a generated `YkNums` class (a length and a growable `double[]`);
- a value of any kind is an `Object`: a `Double`, a `Boolean`, a `String`, a `YkNums`, `null`, or `Yk.UNDEF`.

**Evidence** (`emit-jvm.test.ts`): each case below runs on a JVM, which verifies the classes as it loads them, and is compared exactly with what the WasmGC lowering is checked on:
- every runtime atom against the builtin it defines;
- Number::toString on every double of the WasmGC suite;
- StringToNumber on every string of the WasmGC suite;
- every dynamic-value operation against the engine on 1000 pairs of every kind of value;
- every program of the WasmGC suite against the TypeScript reference;
- every emit case the typed wasm lowering takes.

**What the format lacks for the JVM, classified as in #1299:**
- **(a) lowered now:**
  - numbers, booleans, strings, arrays of numbers, values of any kind, loops with early exits, and every runtime atom;
  - closures: called where they are made, passed as arguments, or captured, each lowered once per signature (a function passed as it is is part of it); and as function values (stored, returned, chosen, called through a value of any kind), through trampolines and one dispatch;
  - the array methods that take a function: `map`, `filter`, `forEach`, `reduce`, `some`, `every`, `find` and `findIndex`, as runtime atoms;
  - recursive closures (a closure that refers to itself returns a value of any kind, so a call of itself knows its result type while it is lowered), and `const` closures that call each other (through a cell, read with the comma operator);
  - builtins as functions (`String`, `Number`, `Boolean`, Math's one-argument functions): each the closure of the call it means;
  - `JSON.stringify` (key order, `toJSON`, `space`, the cycle's TypeError) and `JSON.parse` (strictly, a SyntaxError otherwise), as runtime atoms;
  - `instanceof` for the builtin classes (the error classes, `Object`, `Array`, `Function`) and `Array.isArray`;
  - iteration: `for...in` (keys in ECMAScript's order: array indices ascending, then the others as made), `for...of` over arrays (read at each step, as the iterator does), strings (by code point) and values of any kind, and `Object.keys`, `values` and `entries`;
  - arrays of any values;
  - objects and errors;
  - exceptions (`throw`, and `try` with `catch` and `finally`), with runtime TypeErrors catchable.

  The design is the same on both targets: the shared lowering decides, and each target writes only its primitives.
- **(b) lowering work, no format change:**
  - Stack-map frames. The classes are version 49, which the JVM verifies by type inference. Version 50 and later need frames at every branch target, which the encoder can compute from the IR's types.
  - The `Math` functions and `**` on the JVM. V8 computes exp, log, log1p, log2, log10, expm1, cbrt, cosh, sin, cos, tan, atan and atan2 with llvm-libc, which is correctly rounded. It computes pow, tanh, sinh, asin, acos, asinh, acosh and atanh with its own fdlibm ports, some of which call those. `StrictMath`'s fdlibm differs from all of them in the last place. On 200000 arguments each: pow 3226, tanh 221, atan2 23827, cbrt 16551, log2 31871; and exp(1) is one unit above V8's. Agreement on a sample proves nothing for the rest, so the JVM lowering maps none of them to `StrictMath`. They are refused until they are runtime atoms that compute exactly what V8 does, shared by every target: correctly rounded ones for llvm-libc's, and ports of V8's fdlibm. Only the functions exact by definition are lowered directly: `%`, `round`, `sign`, `fround`, and `sqrt`, `abs`, `floor`, `ceil`, `trunc`, `min`, `max`. An earlier lowering mapped pow, tanh and the others to `StrictMath` after a 1000-argument check passed; that was wrong, and is corrected here.
  - Variadic builtins (`Math.max`, `Math.min`) as function values, and `instanceof` of a user's class. They are refused with the reason.
  - Function declarations that call each other: the forward reference lifts as a free identifier, which only a name match could resolve. Classified (c), filed for lane:core as #1349.
  - A function value's source text (`String(f)`), which a lowering does not keep.
  - A replacer for `JSON.stringify`, a reviver for `JSON.parse`, and the engines' exact SyntaxError messages.
  - Iteration over maps, sets and other iterables.
  - The engines' exact TypeError messages.
- **(c) format gaps:** none found. The graph carried everything both lowerings need: the contract's types, the dataflow, and the heap order.
