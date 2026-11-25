# @yakcc/verify-l2

L2 verification: SMT proofs that an atom meets its contract's postconditions on every input that
meets its preconditions. Plan and slices: [#1421](https://github.com/cneckar/yakcc/issues/1421).

```ts
import { verifyL2 } from "@yakcc/verify-l2";

const report = await verifyL2(
  "function clamp(x: number, lo: number, hi: number): number { if (x < lo) return lo; if (x > hi) return hi; return x; }",
  {
    inputs: [{ name: "x", type: "number" }, { name: "lo", type: "number" }, { name: "hi", type: "number" }],
    outputs: [{ type: "number" }],
    preconditions: ["lo <= hi"],
    postconditions: ["result >= lo && result <= hi"],
  },
);
// report.obligations[0].outcome === "disproven", counterexample x = NaN: clamp returns NaN.
// With the precondition "x === x" added, the obligation is proven.
```

## What it does

- **Conditions are ECMAScript expressions** over the parameters, plus `result` in a
  postcondition. They are lifted by the same lifter as the atom (`liftAtom`), so a condition means
  what the graph's operations mean.
- **Numbers are IEEE 754 binary64.** They use the solver's FloatingPoint theory, so NaN, ±0, ±∞
  and the subnormals are all values, and arithmetic rounds to nearest, ties to even. Parameters are
  declared as 64-bit vectors, so a counterexample gives exact bits.
- **Each postcondition is one obligation,** with one of five outcomes:

  | Outcome | Meaning |
  |---|---|
  | `proven` | `pre ∧ ¬post` is unsatisfiable |
  | `disproven` | a counterexample, confirmed by running the reference lowering (`emitTypeScript`) |
  | `unknown` | the solver could not decide, or a counterexample did not reproduce (an encoder bug, never reported as `disproven`) |
  | `timeout` | the time or resource budget ran out |
  | `unsupported` | a construct outside the exact fragment, named. Never approximated |

- **The verdict** is `proven` only when:
  - there is at least one obligation;
  - every obligation is proven;
  - the preconditions are satisfiable.

  Otherwise it is one of:
  - `no-obligations` (nothing checked: not a proof);
  - `vacuous` (unsatisfiable preconditions: not a proof);
  - `not-proven`.
- **Every query is a deterministic SMT-LIB2 text,** recorded with its BLAKE3 hash, the encoder
  version, the solver version and the budgets, so anyone can rerun it.

## The fragment (slice 1)

| Supported | |
|---|---|
| Types | `number` (binary64) and `boolean` |
| Operations | `+ - * /` (also as compound assignments), unary `-`, `+` and `!`; `< > <= >=`; `=== !== == !=`; `&& \|\| ??`; `?:` and `if`/`return` (selects) |
| Constants | number and boolean literals, `NaN`, `Infinity` |

**Unsupported** (with the construct named in the reason):
- `%`: ECMAScript's is fmod, and SMT's `fp.rem` is the IEEE remainder;
- the bitwise operations (slice 2);
- loops (slice 3);
- calls (slice 4);
- throws and every other effect, anywhere in the graph (slice 5);
- closures, strings, objects and other types.

## Not claimed

- Termination.
- Exceptional exits.
- Soundness beyond Z3's and this encoder's.
- That a lowering other than the reference preserves the proven property.

The solver is `z3-solver` (Z3 compiled to WebAssembly), pinned. Call `shutdownSolver()` before
exiting a process that used it.
