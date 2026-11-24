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
  - closures, when they are called where they are made (one function per signature);
  - arrays of any values;
  - objects and errors;
  - exceptions (`throw`, and `try` with `catch` and `finally`), with runtime TypeErrors catchable.

  The design is the same on both targets: the shared lowering decides, and each target writes only its primitives.
- **(b) lowering work, no format change:**
  - Stack-map frames. The classes are version 49, which the JVM verifies by type inference. Version 50 and later need frames at every branch target, which the encoder can compute from the IR's types.
  - Nine `Math` functions have no JVM counterpart that equals V8's to the last place, and are refused with that reason:
    - `asinh`, `acosh`, `atanh` and `log2` have none at all;
    - `exp`, `cosh`, `cbrt`, `atan2` and `hypot` are in `StrictMath`, but its fdlibm differs from V8's in the last place. For example, V8's `Math.exp(1)` is `Math.E`, and fdlibm's is one unit above it.

    They become runtime atoms ported from V8's algorithms, which every target then shares; WasmGC still takes them from the host engine.
  - The other host functions are checked against V8 on 1000 generated arguments each, and agree exactly: `%`, `**`, `round`, `sign` and `fround`, and the `StrictMath` functions `sin`, `cos`, `tan`, `asin`, `acos`, `atan`, `sinh`, `tanh`, `expm1`, `log`, `log1p`, `log10` and `pow`.
  - Function values: a closure passed, returned or stored, or one that captures a function or calls itself. They are refused with the reason.
  - Property enumeration (`Object.keys`, `for...in`, `JSON`): an object keeps insertion order, while ECMAScript puts integer keys first.
  - The engines' exact TypeError messages.
  - `instanceof`.
- **(c) format gaps:** none found. The graph carried everything both lowerings need: the contract's types, the dataflow, and the heap order.
