# @yakcc/verify-l2

L2 verification: SMT proofs that an atom meets its contract's postconditions on every input that
meets its preconditions. Plan and slices: [#1421](https://github.com/cneckar/yakcc/issues/1421).

```ts
import { verifyL2 } from "@yakcc/verify-l2";

const report = await verifyL2(
  "function sumTo(n: number): number { let s = 0; for (let i = 0; i < n; i++) { s = s + i; } return s; }",
  {
    inputs: [{ name: "n", type: "number" }],
    outputs: [{ type: "number" }],
    preconditions: [],
    postconditions: ["result >= 0"],
    loopInvariants: [["s >= 0 && i >= 0"]],
  },
);
// report.verdict === "proven": post_0, loop_0_entry and loop_0_preserve are all proven.
```

## What it does

- **Conditions are ECMAScript expressions.** They range over the parameters (and `result` in a
  postcondition, and the carried variables, by source name, in a loop invariant). They are lifted
  by the same lifter as the atom, so a condition means what the graph's operations mean.
- **Numbers are IEEE 754 binary64** in the solver's FloatingPoint theory. NaN, ±0, ±∞ and
  subnormals are values, and arithmetic rounds to nearest, ties to even. Numbers are declared as
  64-bit vectors, so a counterexample gives exact bits.
- **Each obligation has one of five outcomes:**

  | Outcome | Meaning |
  |---|---|
  | `proven` | the negated claim is unsatisfiable |
  | `disproven` | a counterexample. For a postcondition, it is confirmed by running the reference lowering in a sandbox with a time limit |
  | `unknown` | the solver could not decide, or a counterexample did not reproduce (an encoder bug without loops or calls; "too weak to decide" with them). Never reported as `disproven` |
  | `timeout` | the time or resource budget ran out |
  | `unsupported` | a construct outside the exact fragment, named. Never approximated |

- **The obligations** are:
  - every postcondition (on normal returns);
  - each loop's invariant on entry, and its preservation by a pass;
  - each callee's preconditions at every call.
- **The verdict** is `proven` only when:
  - there is at least one postcondition;
  - every obligation is proven;
  - the preconditions are satisfiable.

  Otherwise it is one of:
  - `no-obligations` (not a proof);
  - `vacuous` (unsatisfiable preconditions: not a proof);
  - `not-proven`.
- **Integers stay integers.** Lengths, `indexOf`, integer literals, and `+`/`-` of these carry an
  exact SMT Int beside their binary64 value. Comparisons of two such numbers are made on the
  integers while both are within ±2^53. That is where they equal their binary64 values, and every
  length is.
- **Every query is a deterministic SMT-LIB2 text,** recorded with its BLAKE3 hash.

## The fragment

| Slice | Supported |
|---|---|
| 1 | `number` (binary64) and `boolean`. Literals, `NaN`, `Infinity`. `+ - * /` and compound assignments; unary `- + !`; `< > <= >=`; `=== !== == !=`; `&& \|\| ??`; `?:`; `if`/`return` |
| 2 | `& \| ^ ~ << >> >>>` through an exact ToInt32 (`yk_toInt32` in the query prelude), checked against ECMAScript at edge values |
| 3 | `while`/`for` loops, by invariants (`loopInvariants`, one list per loop in `loopsOf` order). Entry and preservation are obligations. The exit is a fact over fresh carried values. A fact is assumed only by obligations made after it, so a wrong invariant cannot prove its own loop. `++`/`--` |
| 4 | `Math.abs floor ceil trunc sqrt min max sign fround` (ECMAScript's NaN and ±0 rules). Calls of supplied callees (`options.callees`, by link spec, `module#symbol` or symbol): their preconditions are obligations, their postconditions a fact only when `proven` |
| 5 | `throw` in a branch: the branch is a path that does not return. Postconditions assume it is not taken. `report.throws` says whether each throw is reachable under the preconditions, with an input |
| arrays, `undefined` | `number[]`, `boolean[]`, `string[]` (also `readonly T[]`, `Array<T>`) as read-only sequences, numbers by their 64 bits. Literals, `length`, `xs[i]`, `slice`, `concat`; `includes`, `indexOf` on strings and booleans (not numbers: `includes` finds NaN, `indexOf` does not, both find -0 for 0). `s[i]` and `xs[i]` are `undefined` unless `i` is an integer in range; `undefined` is converted as ECMAScript does (NaN, `"undefined"`, false, equality, `??`). A result, carried value or argument that may be undefined is an obligation (`defined_<n>`) |
| strings | `string` as a sequence of UTF-16 code units (`(Seq (_ BitVec 16))`), at most 2^53 - 1 long (a longer result is a RangeError). Literals, templates, `+` (concatenation; with booleans), `=== !== == !=`, truthiness. `length`; `charCodeAt`, `charAt`, `slice`, `substring` with ECMAScript's index rules; `startsWith`, `endsWith`, `includes`, `indexOf` without a position |

**Unsupported** (named in the reason):
- `%` (ECMAScript's is fmod; SMT's `fp.rem` is the IEEE remainder) and `**`;
- `Math.round` and the approximated `Math` functions;
- any call, member read, write or other effect not listed above, anywhere in the graph: every
  node of every scope is encoded, so an unused `console.log` or `xs[0] = 1` is refused too;
- `for…of`/`for…in`, throws inside loops, closures, async functions and generators;
- a number converted to a string or a string to a number, `<` on strings, string methods not
  listed, and the search methods with a position;
- writes, `push` and other mutation, `===` on arrays, `includes`/`indexOf` on number arrays, empty
  array literals, objects.

## The record and the registry (slice 6)

- `l2Record(report, contract)` and `encodeL2Record` produce the canonical JSON of an L2 block's
  `smt_cert` artifact: every obligation's query hash and outcome, the verdict, the encoder and
  solver, the budgets, the loop invariants (proof hints, kept out of `spec.yak`) and the callees
  assumed, with their roots.
- `l2Artifact(record)` gives its manifest entry.
- `@yakcc/contracts`' `validateProofManifestL2` requires the entry, over the L0 floor of property
  tests. `@yakcc/ir`'s block parser applies it to blocks whose spec says `level: "L2"`.
- Manifest artifacts are hashed into `proof_root`, so the record is committed by the block's root.
- `recheckL2` recomputes a record from the block. `@yakcc/proof-verifier`'s `issueL2Attestation`
  re-checks and signs `{ level: "L2", block, record_hash, encoder, solver }`.

## The corpus (slice 7)

`scripts/measure-corpus.mjs` measures the bootstrap registry. See [results](results/README.md):
- no spec has conditions yet;
- most blocks are statement fragments;
- the fragment's next steps are strings, arrays and records.

## Not claimed

- Termination (loops are partial correctness).
- Exceptional exits.
- Soundness beyond Z3's and this encoder's.
- That a lowering other than the reference preserves the proven property.

The solver is `z3-solver` (Z3 compiled to WebAssembly), pinned. Queries are passed in memory this
package allocates and frees after Z3 answers: z3-solver's own string path puts them on a stack the
solver thread may read after it is popped. Call `shutdownSolver()` before exiting a process that
used the solver.
