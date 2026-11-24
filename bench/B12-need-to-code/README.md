# B12 — From a described need to the code that implements it (WI-REUSE, GH #1253)

A composing model knows what it needs ("count the edits between two strings"), not what the
library calls it. B12 measures how well each way of matching gets from that description to
the corpus function that implements it. It also measures whether the system can tell a
right match from a wrong one, because a reuse decision depends on that.

B11 showed the problem: with the registry's production retrieval, 7 of 29 needed atoms
reached a B11 slice. B12 is the harness for finding a better path.

## The pipeline

1. **Query card.** What the composing model writes: a one-sentence need, parameter types,
   an output type, and two to four example calls with results.
2. **Library cards** (`harness/cards.mjs`). What is known about each of the 2,985 corpus
   definitions without a model:
   - parameter names, from the source;
   - the JSDoc description, where there is one (231 definitions);
   - whether the sandbox can call it (1,824 can);
   - example calls and observed types, from running it on fixed probe inputs (634 have
     examples).
3. **Stage 1, recall.** Text channels pick a shortlist of 50: dense embedding similarity
   (bge-small, as the registry uses) and BM25, fused by reciprocal rank.
4. **Stage 2, execution** (`harness/match.mjs`). Each callable candidate in the shortlist
   is run on the query's examples in a vm sandbox (`harness/sandbox.mjs`). Candidates that
   reproduce every example move to the front.
5. **Stage 3, decision.** Reuse the top candidate only if it reproduced every example and
   the query gave at least two. A stricter rule reuses only if exactly one shortlisted
   candidate did.

The sandbox loads a corpus module (transpiled to CommonJS) with a `require` that resolves
only inside its own fixture package. It then picks top-level bindings by name, so internal
helpers that a module never exports are callable too. Every call has a 200 ms limit, and
values cross the boundary as tagged JSON, so Maps, Sets, Dates and bytes compare by value.
vm is not a security boundary: the corpus is vendored repository code, and the context
only keeps host APIs out of reach.

## Results on the seed set

These numbers are on the **seed set** (`queries/seed.json`): 46 queries written by the
harness author, who knows the answers. 38 have a target in the corpus, and 8 are needs that
nothing in the corpus implements. The seed set is for developing the pipeline. Its numbers
show direction, not the result. The held-out set comes from `harness/generate-queries.mjs`,
which needs a key.

| Configuration | Top-1 | Top-5 | Top-50 | MRR | Reuse: precision / recall / false on negatives | Unique-only rule | AUROC |
|---|---|---|---|---|---|---|---|
| `registry-spec` (production: canonical spec text, dense + BM25) | 0.13 | 0.42 | 0.68 | 0.26 | – | – | 0.64 |
| `card-dense` (card text, dense) | 0.32 | 0.50 | 0.84 | 0.41 | – | – | 0.69 |
| `card-hybrid` (+ BM25) | 0.39 | 0.63 | 0.87 | 0.50 | – | – | 0.59 |
| `card-hybrid+examples` (example calls in both texts) | 0.37 | 0.68 | 0.84 | 0.50 | – | – | 0.74 |
| **`+execution`** (shortlist reordered by execution) | **0.71** | 0.82 | 0.84 | 0.76 | 0.92 / 0.63 / 0.00 | 1.00 / 0.55 / 0.00 | 0.95 |
| `+execution (package cap)` (at most 5 per package) | 0.66 | 0.74 | 0.76 | 0.69 | 0.92 / 0.58 / 0.00 | 0.95 / 0.53 / 0.00 | 0.95 |
| `+execution (signature)` (shortlist reordered by signature first) | 0.74 | 0.76 | 0.84 | 0.75 | 0.96 / 0.66 / 0.00 | 1.00 / 0.55 / 0.00 | 0.99 |
| `exec-all` (no retrieval: every callable, about 1 s per query) | 0.87 | 0.89 | 0.89 | 0.88 | 0.97 / 0.79 / 0.00 | 1.00 / 0.61 / 0.00 | 0.96 |

How to read it:
- **Top-k and MRR** are over the 38 positive queries.
- **Reuse** columns:
  - precision is the share of accepted top candidates that were right;
  - recall is the share of positives accepted correctly;
  - "false on negatives" is the share of the 8 nothing-fits needs that were wrongly
    accepted.
- **AUROC** asks whether the confidence in the top candidate is higher when it is right
  than when it is wrong (0.5 is chance, 1 is perfect).

### What the seed numbers show

- **The production text is the weakest representation.** The spec text the registry
  embeds ranks the right function first for 13% of needs. A card built from the code
  (name, parameters, JSDoc, observed types) more than doubles that, and BM25 lifts it to
  0.39.
- **Execution is the step change.** Running the shortlist on the query's examples lifts
  top-1 from 0.37 to 0.71, with the same shortlist. The confidence then separates right
  from wrong almost perfectly (AUROC 0.95, against 0.59 to 0.74 for text similarity).
  Text similarity finds candidates; it cannot decide between them.
- **No wrong reuse on the negatives.** None of the 8 nothing-fits needs had a candidate
  that reproduced its examples, so none was accepted. Text scores alone cannot do this:
  B11 found irrelevant hits scoring above the 0.8 threshold.
- **Recall is now the limit.** With execution, every positive whose target was in the
  shortlist and could run was found. The misses are targets outside the shortlist (16%),
  targets that cannot run (class methods, classes, higher-order functions), and queries
  with no examples. `exec-all` shows the ceiling when every callable function is tried:
  0.87 top-1. All 4 of its misses are those not-executable cases.
- **The package cap hurts.** Capping each package at 5 shortlist slots drops top-50 from
  0.84 to 0.76, because related functions cluster in a package (semver, uuid). B11's zod
  dominance needs a different fix: a better text representation, which the cards already
  give.
- **Signature reordering helps a little,** but only once execution has run (top-1 0.74
  against 0.71). Probed types are noisy in JavaScript, which accepts nearly any argument.
- **Examples can be too weak to decide.** The accepted-but-not-target cases:
  - `validRange` reproduces the "normalize a semver string" examples;
  - `isCurrency` reproduces the "is an integer string" examples;
  - validator's `isUUID` reproduces the "is a UUID" examples. It is a real UUID validator,
    so this is a second correct implementation, not an error.

  The seed set lists strict targets, so precision here is a lower bound. Reusing only when
  exactly one candidate passes gives precision 1.00 at lower recall. When several pass,
  the right move is to ask for a discriminating example.

### Suggested path

1. Index library cards, not spec text.
2. Use dense + BM25 for a shortlist.
3. Run the shortlist on the composing model's examples.
4. Reuse only on a unique pass of at least two examples. Otherwise ask for more examples,
   or write the function.

Confirm this on the held-out set before changing the registry.

## Asking without code: the confirm step

Asking the composing model to write code, or even example calls, in order to find code
makes it pay for what reuse is meant to save. `harness/confirm.mjs` tests the alternative:

1. The model sends only what it needs: one or two sentences and the types. Measured in
   real tokens, that is far smaller than writing the function.
2. The library searches (card text, dense + BM25) and shows the top K candidates. Each
   shows its name, package, doc and up to three example calls observed by running it.
3. The model picks one, or says none fits. It reads; it does not write code or invent
   examples.

For each query the step records:
- the pick and its outcome: right, wrong reuse, missed (it said none but the target was
  shown), or correct-none;
- the tokens of the request, of the examples the examples style would have added, and of
  the confirm turn's input and output.

Library-side work (cards, probes, descriptions) is paid once per function, not per
request.

**Status: run** with Opus 5.5 (results below).

## Held-out results (Opus 5.5)

`queries/generated.json` holds 172 queries for functions across 14 corpus packages, made by
`generate-queries.mjs`. For each function, one call described it from its code with the
name masked, and a fresh call that saw only that description wrote the query.
- In 134 of the 172 (78%), the real target reproduces the examples the model wrote. In 38
  it does not, because the description or the model's examples are wrong.
- `results/descriptions.json` holds model-written one-line descriptions of the 2,754
  definitions without JSDoc (`describe-atoms.mjs`). This is a one-time library cost.

### Search (`results/eval-generated*.json`)

| Configuration | Top-1 | Top-5 | Top-50 |
|---|---|---|---|
| Production spec text | 0.23 | 0.51 | 0.84 |
| Card text, dense + BM25 | 0.37 | 0.60 | 0.88 |
| **Card text + model descriptions, dense + BM25** | **0.59** | **0.85** | **0.97** |
| + execution on the model's examples (with descriptions) | 0.67 | 0.80 | 0.99 |

- **Descriptions are the largest single gain.** On the seed set they lift text-only top-1
  from 0.39 to 0.58, and execution top-1 from 0.71 to 0.89.
- **Execution helps less on held-out queries than on the seed set,** because 22% of the
  model's own examples do not hold for the target. Reuse precision with execution is 0.85
  (0.99 with the unique-pass rule).

### Confirm step (`results/confirm-generated-desc-k10.json`)

The model sends only the need and types, sees the top 10 candidates (with descriptions and
observed calls), and picks one or none.

| | Held-out (172) | Seed (46), K = 10, no descriptions |
|---|---|---|
| Target among the 10 shown | 0.93 | 0.74 |
| Picked the target | 0.80 (0.89 counting the same function from another build) | 0.74 |
| Picked the target when it was shown | 0.86 | 1.00 |
| Reuse precision | 0.85 (0.95 counting other builds) | 1.00 |
| Needs with no answer, answered "none" | – (the held-out set has none) | 8 of 8 |

Of the 24 picks that missed the exact target:
- **16 were the same function from another build** of its package. uuid, for example,
  ships cjs, esm and browser copies.
- **5 were the public wrapper of an internal target,** such as `get` for `baseGet` or
  `distance` for `myers_x`. Each implements the described need.
- **3 were wrong:** `escape` for a JSON-pointer unescape, validator's `trim` for lodash's,
  and semver's `clean` for `valid`.

### What it costs, and where it pays

Mean tokens per need, real tokenizer:

| | Model writes | Model reads |
|---|---|---|
| The request (need and types) | 105 | – |
| Examples, if the request had included them | +103 | – |
| The confirm turn | 114 (pick, reason, thinking) | 1,552 (10 candidates) |
| **Writing the target function itself** (mean; median 59) | **about 100** | – |

**At this granularity, search does not save tokens.** These functions are small helpers.
Describing and confirming costs about 220 output and 1,550 input tokens, while writing
the function costs about 100 output tokens. At Opus 5.5 prices that is about $0.011
against about $0.002 per need. Reuse pays only when the reused unit is much larger than
its description: whole modules, or compositions of many atoms. It also pays when reuse
buys something besides tokens, such as code that is already tested and verified. The
confirm turn could be cheaper (effort low, K = 5, shorter candidate blocks), but not by
5×. So the next measurement should be at module or composition scale, not atom scale.

### Caveats

- **Same-model phrasing.** The same model wrote the queries and the library
  descriptions, so their phrasing may match unusually well.
- **The queries come from descriptions of the code,** so some are implementation-specific
  (for example, "return [validLen, placeHoldersLen]"). That makes them easier than real
  needs.
- **The sample is biased toward small functions:** callable, deterministic, with probe
  examples.
- **One planned run did not happen.** The confirm step on held-out queries without
  descriptions stopped when the API account ran out of credit.

**Total spend: about $14 on Opus 5.5** ($4.09 queries, $7.44 descriptions, about $2.60
confirm runs).

## Running

```sh
pnpm --filter @yakcc/shave build && pnpm --filter @yakcc/registry build   # dist imports
node --test harness/b12.test.mjs              # self-test: no model, no embedding model
node harness/eval.mjs                         # seed set -> results/eval-seed.json (~1-3 min)
node harness/eval.mjs --no-exec-all           # skip the ~1 s/query brute-force reference
```

`.cache/` keeps the built cards and the embeddings between runs (git-ignored).
`--rebuild-cards` rebuilds the cards.

### Steps that need a model (not run)

Each reads `ANTHROPIC_API_KEY` (or `CLAUDE_API_KEY`) and refuses without one, and `--dry-run` prints the plan and cost without
calling anything:

| Step | What it makes | Calls | Estimated cost (Opus 5.5 / Sonnet 5.5 / Haiku 5.5) |
|---|---|---|---|
| `harness/generate-queries.mjs` | The held-out query set. One call describes the function from its code (name masked); a fresh call that sees only that description writes the need and the examples, as a composing model would. Targets are re-run on the examples. | 346 (173 functions across 14 packages) | $5.19 / $2.59 / $0.13 |
| `harness/confirm.mjs` | The confirm step, on the seed set (or `--queries queries/generated.json`). | 46 at K = 5 | $0.34 / $0.17 / $0.01 |
| `harness/describe-atoms.mjs` | A one-line behavior for each of the 2,754 definitions without JSDoc. The eval uses it via `--descriptions`. | 2,754 | $8.67 / $4.33 / $0.22 |

Prices are first-party list prices as of 2026-11. The default model is Opus 5.5; `--model`
picks another. Then:

```sh
node harness/eval.mjs --queries queries/generated.json --out results/eval-generated.json \
  --descriptions results/descriptions.json
```

## Limitations

- **The seed set is author-written,** and its targets are strict. See above.
- **Only callable code can be checked by execution.** That rules out class methods, classes,
  and functions that need host APIs or packages outside the fixtures (1,161 of 2,985
  definitions). For those, the decision falls back to text similarity, which this
  benchmark shows to be weak.
- **Higher-order functions** (memoize, debounce) have no value examples. Their queries can
  only be text-matched.
- **Probe-based types are a heuristic.** Card examples come from fixed probes, and
  JavaScript accepts nearly any argument, so observed types are noisy.
- **The query's interface must match the function's.** Execution checks the composing
  model's interface. A function that does the right thing with different parameters, such
  as date-fns' internal `parseDate`, fails the examples. Adapting interfaces is future
  work.
