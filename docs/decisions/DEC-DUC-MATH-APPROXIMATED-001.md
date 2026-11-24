# DEC-DUC-MATH-APPROXIMATED-001: what a graph's implementation-approximated Math operations mean

**Status:** Proposed (lane:polyglot, for lane:core's decision)
**Issue:** https://github.com/cneckar/yakcc/issues/1311 (found lowering to the JVM); #1292 (the format lock)
**Related:** DEC-DUC-BYTECODE-TARGETS-001, DEC-DUC-CROSS-LANGUAGE-OPS-001

---

## The gap
ECMAScript specifies `Math.exp`, `log`, `log1p`, `log2`, `log10`, `expm1`, `cbrt`, `sin`, `cos`, `tan`, `asin`, `acos`, `atan`, `atan2`, `sinh`, `cosh`, `tanh`, `asinh`, `acosh`, `atanh`, `pow` and `**` only as *implementation-approximated* (ECMA-262 21.3.2). Their results differ:
- **between engines;**
- **between versions of one engine:** V8 moved from fdlibm to llvm-libc, whose results are correctly rounded. In V8 12.4 (Node 22), `Math.exp(1)` is `Math.E`; fdlibm's is one unit above it.
- **between a lowering's targets:** on 200000 arguments each, the JVM's `StrictMath` disagreed with V8 12.4 on:

  | Function | Disagreements |
  |---|---|
  | `pow` | 3226 |
  | `tanh` | 221 |
  | `atan2` | 23827 |
  | `cbrt` | 16551 |
  | `log2` | 31871 |

A graph that contains one of these operations therefore has no defined result. Two correct lowerings can disagree, a differential test can only follow one engine, and an atom's identity does not fix its behavior. This is a gap in what the format means, classified (c) for #1292.

## Proposal
A graph's implementation-approximated Math operation means its **correctly rounded** result: the exact mathematical value, rounded to the nearest double, ties to even. The special cases are ECMA-262's, including `pow`'s NaN for `(±1) ** ±Infinity`.

## Why
- **Deterministic:** every target can compute it, as runtime atoms shared by all lowerings (DEC-DUC-WASM-MEMORY-001).
- **The direction engines are going:** it is what current V8 computes for the functions it takes from llvm-libc.
- **A test oracle that needs no engine:** the exact value can be computed with the runtime's big integers.

## Alternatives
- **"Whatever the reference engine does":** not reproducible across engine versions, and not computable on a target without that engine.
- **fdlibm:** deterministic, but it is no longer what V8 does, and it differs from correctly rounded results in the last place.

## Consequences, if decided
- The bytecode lowerings implement these operations as correctly rounded runtime atoms. The usual design is a double-double fast path, with an exact big-integer fallback where the fast path cannot decide the rounding.
- Their differential tests use an exact oracle rather than the engine.
- Until then, the JVM lowering refuses them with the reason, and WasmGC imports the host engine's.
