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
