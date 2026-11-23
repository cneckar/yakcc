# DEC-DUC-NATIVE-BACKEND-001: native object files through LLVM's backend

**Status:** Proposed (prototype built)
**Date:** 2026-11-23
**Issue:** https://github.com/cneckar/yakcc/issues/1292 (criterion 4)
**Parent:** #1275 (vision item 2: lower the graph directly to each target)

---

## Context

#1292 asks for the graph to be lowered to the relocatable object files a compiler emits. Any
off-the-shelf linker must accept them, for x86-64, AArch64, 32-bit ARM, RISC-V and other common
architectures, in ELF, Mach-O and COFF. There were two options:
- **(a)** lower the graph to LLVM IR or Cranelift IR, and let that backend write the object;
- **(b)** write a code generator and object writer per architecture and format.

## Decision

**(a), through LLVM.** The graph is lowered directly to LLVM IR text (`emitLlvm`, `@yakcc/duc`). No other
high-level language sits in between. LLVM's own backend, `llc`, compiles the IR to a relocatable
object for the target triple (`compileObject`). The function is exported under the platform's C
calling convention: `double` for a number, `_Bool` (zero-extended `i1`) for a boolean.

- **What (a) gives.** LLVM is the backend of clang, rustc and swiftc. Its objects are a compiler's objects. One
  lowering reaches every architecture and object format LLVM supports.
- **What it costs.** `llc` is a tool on the machine, not a package dependency. When it is missing,
  `compileObject` says so. The lowering itself (`emitLlvm`) needs nothing.
- **Determinism.** The same graph and triple give byte-identical objects (tested).

### Semantics

The subset is the typed one of the wasm lowering (#1289): numbers and booleans. JavaScript's
semantics are kept exactly:

| JavaScript | Lowering |
|---|---|
| Arithmetic | IEEE `double` |
| `%` | `frem` (fmod) |
| Truthiness | `fcmp one x, 0` |
| `Math.floor`, `ceil`, `trunc`, `sqrt`, `abs` | LLVM intrinsics |
| `min`, `max`, `round`, `sign` | Written out with JavaScript's NaN, -0 and tie rules |

ECMAScript lets an engine approximate the other `Math` functions and `**`. A native libm need not
give a JavaScript engine's last bit, so these are refused with that reason. They are not lowered to a different result.

## Evidence

- **x86-64 ELF.** The object is linked by the system `cc` into a C harness and run on this host. It
  agrees with the source bit for bit (`Object.is`, NaN and -0 included). That holds over every emit
  case in the subset, and over 7 programs × 400 generated inputs (branches, nested loops, early exits,
  booleans, the exact `Math`, `round` ties, signed zeros).
- **AArch64, ARMv7 (hard float), RISC-V 64 (lp64d) ELF.** Each object is linked statically with
  `clang` and `lld` against the target's own glibc and libm. It runs under QEMU user mode and agrees
  with the source bit for bit on 200 generated inputs each.
- **Mach-O (x86-64, arm64) and COFF (x64, ARM64).** Each object has the right header, and its stock
  linker takes it: `ld64.lld` makes a dylib, `lld-link` makes a DLL. They are not run: there is no host here.

## Open

- **Beyond the typed subset.** Strings, arrays, objects and closures need a value representation and
  a runtime, shipped as object files of their own. What the graph must carry for that is part of the
  format lock (#1292).
- **"ia64".** Itanium is not a current LLVM target. Whether it was meant is asked on #1292.
