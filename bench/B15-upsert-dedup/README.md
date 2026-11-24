# B15 — Dedup on upsert: does newly written code already exist?

When an agent writes a function and upserts it, the registry could look for stored code that
**behaves** the same, and return those neighbors with how they compare. The caller then decides
whether to keep its own version, use the stored one, or store its own as a faster alternative.
Over time each behavior collects its implementations, ranked. B15 measures whether that check
works on the corpus.

## The check (`harness/dedup.mjs`)

1. **Candidates, two sources.**
   - **Text:** the new block's spec, searched against the library's descriptions (dense, top k).
   - **Behavior:** the new function's outputs on the probe inputs and on its own examples,
     compared with every stored definition's outputs (top k). The stored side's probe outputs
     are a fingerprint computed once.
2. **Verify** each candidate in the B12 vm sandbox. The inputs are the probe inputs, the new
   block's examples and the candidate's examples. All of them are kept inside the spec's
   declared parameter types: two implementations of one spec may differ on a number passed
   where a string is declared, and that difference is not the spec's.
3. **Verdict.** Each candidate gets one of four:

   | Verdict | Meaning |
   |---|---|
   | equivalent | Agrees on every comparable input, with at least 3 informative agreements and at least 2 distinct outputs |
   | near | Agrees on all of the new block's examples and on at least 80% of the other inputs; the inputs where they differ are reported |
   | different | Otherwise |
   | inconclusive | Too few informative comparisons to say |

   "Equivalent" is observed on finitely many inputs. It is evidence, not proof.
4. **Speed.** For equivalent and near pairs, both are timed on the same inputs in the same way,
   and the ratio is reported.

## The data

Haiku wrote 210 functions from scratch, about $0.11, in `results/impls.json`. Each comes
from a B12 query (the need, the signature and the examples), the way an agent would write the
function before upserting it. The query's corpus definition is the **target**: the stored
neighbor the check should find.

The negatives are up to 5 mutants per function, from `@yakcc/variance`. Only mutants that fail
the function's own examples are kept. They are compared with the target without those examples.

## Results (`results/run.json`)

200 functions were scored. 7 targets are not callable at the spec's arity, and 3 functions
did not transpile.

| | |
|---|---|
| Target among the neighbors (text top 5) | 0.865 |
| Target among the neighbors (behavior top 5) | 0.87 |
| Target ranked first by behavior | 0.74 |
| **Target found by either source** | **0.97** |
| Target verdict: equivalent / near / different / inconclusive / not found | 121 / 16 / 42 / 15 / 6 |
| Target equivalent or near, when the new function passes its own examples | 0.75 |
| Top neighbor is the target | 0.765 |
| Mutants judged equivalent to the target (false equivalence) | 0.097 (87 of 901) |
| New function faster than the stored one (137 equivalent or near pairs) | 0.56; median time ratio 0.95, p10–p90 0.65–1.45 |

### What it shows

- **Text and behavior find different things, and together they almost always find the
  target (97%).** Each finds the target in its own top 5 about 87% of the time. Behavior also
  finds stored code whose description says nothing like the new spec.
- **"Near" is the useful verdict.** It names the input where two plausible implementations
  disagree:
  - ms `fmtShort(2.5)`: "2.5ms" in the library, "3ms" in the rewrite;
  - validator `isHexColor("abc")`: the library accepts a colour without `#`;
  - validator `escape`: the library escapes `/`;
  - lodash `get` with an empty path;
  - `toNumber("")`: 0 or NaN.

  The caller sees the difference and picks the semantics it wants.
- **Equivalent duplicates exist in the corpus.** 39 of the functions (19.5%) found another
  equivalent definition besides the target, 68 in all. Many are real duplicates:
  - ESM and CJS builds of one function (zod's `isAborted` and `isDirty`, uuid's `v1ToV6`);
  - uuid `validate` and validator `isUUID`;
  - lodash `baseAssign` and `baseAssignIn`.

  Some are not: `isEmail` against `isURL`, and `isInt` against `isCurrency`. The probe inputs
  for those types are too thin to tell them apart.
- **Probes alone are too weak for a verdict. The blocks' own tests carry it.** A mutant that
  fails its own examples still looks equivalent on generic probes 9.7% of the time. A real
  check must run each side's stored tests against the other side, not only probes.
- **"Most efficient" is a real choice, and it needs a shared test pool.** The rewrite is faster
  in 56% of the pairs. The largest gaps are suspect: semver `inc` is 5× faster, and validator
  `isEmail` is 3.6× faster. The rewrites likely cover less of the behavior, on inputs neither
  side tested. Speed should rank implementations only on the union of the group's tests.

## What the registry needs (lane core)

- **Store tests with blocks,** so verification can run each side's tests on the other.
- **An "observed equivalent" link between blocks,** with its evidence:
  - the inputs;
  - agreement;
  - counterexamples for "near".
- **Group search results by link,** so one behavior shows its implementations ranked by speed
  and size.
- **An upsert response that returns the verified neighbors,** so the caller can decide before
  or after storing.

## Running

```sh
node --test harness/b15.test.mjs
node harness/write-impls.mjs --dry-run            # then without --dry-run (Haiku, capped at $1)
node harness/run.mjs                              # local: embeddings and the vm sandbox
```

## Limitations

- **Probe pools are generic.** Dates, tuples and domain strings get few inputs, so some pairs
  are inconclusive, and some false equivalences pass.
- **The comparison runs single calls of pure functions.** Stateful code, async code and
  callbacks are not compared.
- **Timing is in-sandbox microbenchmarking** on small inputs. It ranks, but it does not
  measure asymptotics.
