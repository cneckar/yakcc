# B11 — Reuse economics (WI-REUSE, GH #1253 / #1258)

Does reusing registry work lower the cost of later composition tasks, and at what
reuse count does it break even? The question is asked in the form the SEAM "work
cache" deck argues for: a single run cannot show a saving by construction. Break-even
appears only when later work reuses earlier work. This suite measures the arms, not
the deck's numbers.

## Arms (per task)

| Arm | Context given to the model |
|---|---|
| `scratch` | The task spec only. |
| `slice` | The task spec, plus the retrieved slice in rank order within the token budget. This is the default composition context. |
| `slice-fill` | The task spec, plus the slice under the budgeted source-spread fill (#1271). |
| `fallback` | Gap-gated (#1263). It composes from the rank-order slice, and synthesizes only on a measured gap, with the reason logged. See "Fallback policy". |
| `slice-oracle` (opt-in) | The task spec, plus the hand-curated fixture slice, which always holds the needed atoms. This is the ceiling with perfect retrieval. The gap between it and `slice` is what retrieval's misses cost. |

The slice is real registry retrieval by default (`--slice retrieved`). See "Retrieval".
`--slice fixture` swaps in the hand-curated slices for every arm.

Both slice arms choose their candidates with `selectCompositionContext` from
`@yakcc/shave` (`packages/shave/src/retrieval/context.ts`, DEC-RETRIEVAL-CONTEXT-001). With
`sourceSpread` absent it selects in rank order. With `sourceSpread: { maxPackageShare }` it
applies the fill (DEC-RETRIEVAL-FILL-001). Defaults are a 1200-token budget and a share of
0.5.

### Fallback policy (#1263)

The arm decides whether the slice is worth composing from. Two gates are available
(`--gate`). Neither reads the held-out check.

**`confirm` (default).** Retrieval scores do not separate relevant slices from irrelevant
ones (see "Retrieval"), and B12 found that a model reading candidates does:

| Step | Trigger reason | What the arm does |
|---|---|---|
| A reading turn shows the task and the slice; the model answers which candidates it would reuse (`{"use": [...]}`) | – | One short turn. |
| It keeps none | `none-confirmed` | Writes from the spec alone, without the slice's tokens. |
| It keeps some, and the reply has closure holes (names nothing defines, checked by the TypeScript checker against ES2022 only) | `unexplained-residual` | Composes from only the kept candidates, then one repair turn with the missing names. |
| It keeps some, and the reply has no holes | none | Composes from only the kept candidates. |

**`score`.** The earlier rule (`decideFallback`, DEC-RETRIEVAL-GAP-GATE-001):
- If no candidate reaches 0.8, the arm writes from the spec (`near-miss-only`).
- Otherwise it composes, with the same repair turn.

It is kept for comparison.

Every trigger is written to `triggers`. The counts by reason and the synthesis rate are in
`triggerCounts`. A reply that stops on a refusal or on the token cap fails with its stop
reason, and is not read as a hole. In the offline dry run, the client keeps nothing at the
confirm turn, so every fallback row reads `none-confirmed`. The scripted tests cover the
compose path.

This is the TypeScript-text form of the policy. The graph form is `composeMissing` in
`packages/federation/src/authored.ts`, where the gaps are `no-match` and a failed check
such as `closure`. Moving the arms to line-form composition is a design decision for the
live run (see Limitations).

### Fill on and off (#1271)

`results/fill-selections.json` records each task's fixture-slice candidate set in rank
order and under the fill, at budgets 400, 600 and 1200 (`node harness/selections.mjs`).
`results/fill-selections-retrieved.json` is the same record for the retrieved slices
(`--slice retrieved`). Every run also records both sets per task in `selections`. The
findings below are for the fixture slices. For retrieved slices, see "Retrieval".

- At 1200 tokens the two sets agree on every task. The fill changes nothing there.
- At 600 tokens they differ on five tasks. In each case one package held every candidate
  that fit, and the fill capped it. For example, on `build-order`:

| | Selected | Tokens by package |
|---|---|---|
| rank | `topo-toposort`, `topo-unique-nodes`, `topo-outgoing`, `topo-nodes-hash` | toposort 516 |
| fill | `topo-unique-nodes`, `topo-outgoing`, `topo-nodes-hash`, `semver-lru` | toposort 162, semver 190 |

  Spreading dropped `toposort`, the atom that does the sorting, and admitted an unrelated
  LRU cache. The fill also drops a needed atom on `days-between`
  (`differenceInMilliseconds`) and `uuid-normalize` (`unsafeStringify`). On these tasks
  every needed atom comes from one package, so a share cap works against them. Whether
  that costs pass rate is what the `slice` and `slice-fill` arms measure.

## Retrieval

`harness/retrieve.mjs` builds the slices from real retrieval, offline, with no model API:

1. **Pool.** Every named definition in the shave corpus fixtures: functions, classes,
   methods, and const-bound function expressions, de-duplicated by text. Shave's three
   synthetic test packages are left out.
2. **Specs.** Each definition gets the spec shave persists offline: `staticExtract` →
   `validateIntentCard` → `specFromIntent`. It is stored as a block in an in-memory
   registry that uses the local embedding provider (`Xenova/bge-small-en-v1.5`, the same
   one bootstrap uses). 2,360 of 2,985 definitions store. The rest are mostly class methods,
   which are not valid source on their own; their class is in the pool and covers them.
3. **Query.** Each task's spec is the query for `registry.findCandidatesByIntent` with
   `lexical: true`: embedding KNN fused with BM25 (DEC-RETRIEVAL-LEXICAL-001). The top 8
   are the slice.
4. **Score.** Each candidate's score is the registry's `cosineDistanceToCombinedScore`. A
   lexical-only hit has no embedding distance, and the registry reports it as 0.75.

The output is `retrieval/production.json`, which is deterministic: two runs are
byte-identical. `retrieval/with-behavior.json` is a diagnostic variant whose spec keeps
the extracted behavior text. In production, `specFromIntent` keeps behavior only as a
30-character name slug. A needed atom counts as retrieved when a candidate has its package
and name, or contains its span (a class covers its methods).

### Recall on the composition tasks

7 of the 29 needed atoms reach the top-8 slice, and 16 reach the top 50. No task gets all of
its atoms, and seven get none.

| Task | In slice | Needed atom: rank in top 8 / rank in top 50 | Best score |
|---|---|---|---|
| `add-days-iso` | 2/3 | parseDate 7/7, addDays 3/3, addLeadingZeros –/37 | 0.84 |
| `add-durations` | 0/2 | parse –/>50, fmtShort –/10 | 0.82 |
| `base64url-from-string` | 0/3 | fromByteArray, encodeChunk, tripletToBase64 all –/>50 | 0.84 |
| `build-order` | 0/3 | uniqueNodes, makeOutgoingEdges, toposort all –/>50 | 0.80 |
| `days-between` | 0/3 | parseDate –/9, validateDate –/14, differenceInMilliseconds –/12 | 0.81 |
| `memoize-lru` | 0/2 | memoize –/15, LRUCache –/>50 | 0.84 |
| `pointer-get` | 2/3 | compilePointer 6/6, untilde –/>50, get 1/1 | 0.85 |
| `sort-versions` | 0/3 | compareMain, comparePre –/>50, compareIdentifiers –/26 | 0.81 |
| `suggest-words` | 0/2 | distance –/5, closest –/>50 | 0.80 |
| `uuid-normalize` | 2/3 | validate 5/9, parse 3/7, unsafeStringify –/>50 | 0.82 |
| `uuid-version` | 1/2 | validate –/18, version 4/4 | 0.81 |

The top-8 and top-50 ranks come from separate queries. With the lexical channel on, the
registry fuses over a KNN pool of 4k, so the two can order differently.

Keeping the behavior text does not help. The `with-behavior` variant gets 5 of 29 in the
top 8 and 17 of 29 in the top 50.

### What the retrieval shows

- **One package crowds out the rest.** zod is about 70% of the pool, and it takes 94 of the
  168 slice slots.
- **Scores are compressed.** The best score per task is 0.77 to 0.86, whether or not the
  slice holds anything needed. Fifteen of 21 tasks have a best score at or above 0.8. That
  includes seed tasks such as `slugify` (0.83) whose function is not in the corpus at all.
  So under real retrieval the fallback arm's 0.8 strong-match threshold does not separate
  relevant slices from irrelevant ones, and the arm composes from irrelevant slices on most
  tasks. The threshold needs calibrating against these scores before the fallback arm's
  trigger counts mean anything.
- **The lexical channel admits generic hits.** 34 of the 168 slots are lexical-only.
  zod's `assertNotEqual` appears in five tasks' slices.
- **Undocumented functions get thin specs.** With no JSDoc, the extracted behavior is the
  signature, for example `function _maxLength(maximum, params) -> unknown`.
- **The fill does not change real slices at the default budget.** All eight candidates
  fit in 1200 tokens (about 850 on average). At 600 tokens the fill changes 3 tasks, and
  at 400 it changes 5 (`results/fill-selections-retrieved.json`).

### Limits of this retrieval

- **One query per task.** The query is the whole task spec. A composing model would
  instead name each atom it needs and search for each one (#1275, item 4). Per-atom
  queries need a model or hand-written sub-queries, and the hand-written kind would leak
  the answer.
- **Raw corpus, not shave's atoms.** The pool is definitions as written, not shave's
  slicer output, and it has no graph candidates (#1280).

## Scoring

Held-out checks, not a grader. The candidate is transpiled (TypeScript) and run in a
fresh `vm` context with no host globals. Pass means every held-out assertion holds.
This removes the answer-key circularity the deck's own scoring has.

## Metrics

| Scope | Metrics |
|---|---|
| Per row | arm, seed, model, pass, error, input and output tokens (all turns), turns, wall time, stop reason, selection mode, and for `fallback` the decision and trigger |
| Per arm and per difficulty class | pass rate, total and mean tokens, mean time (`summary`, `byDifficulty`) |
| Per model | input and output tokens and calls (`tokensByModel`), so runs with several models add up |
| Break-even | see below |

Cost is tokens times the model's price. Prices are not stored here.

## Running

```sh
pnpm --filter @yakcc/shave build                 # the runner imports shave's retrieval code
node --test harness/harness.test.mjs harness/run.test.mjs harness/retrieval.test.mjs
node harness/build-tasks.mjs --check             # corpus task files match their source
node harness/retrieve.mjs                        # rebuild retrieval/production.json (~1 min;
                                                 # needs registry and contracts built and the
                                                 # embedding model, fetched once then cached)
node harness/run.mjs --dry-run --seeds 3         # plan and token upper bound; no calls
node harness/run.mjs --client offline --seeds 3 --out results/offline-validation.json
node harness/selections.mjs [--slice retrieved]  # fill on/off candidate sets
```

Options: `--seeds N`, `--arms scratch,slice,slice-fill,fallback[,slice-oracle]`,
`--slice retrieved|fixture`, `--retrieval <file>`, `--budget`, `--share`, `--effort` (live
only).

## Status

- **Harness: built and tested.** 89 tests pass across `harness.test.mjs`, `run.test.mjs`
  and `retrieval.test.mjs`.
- **Offline dry run:** `results/offline-validation.json`, with three seeds and every arm. The
  offline client returns reference solutions, so every row passes and the token counts are
  estimates. It checks that the harness runs end to end. It is **not** a measurement of
  reuse. It uses the retrieved slices.
- **Live run: not run.** It needs a key and approved spend. `results/dry-run-plan.json`
  bounds a three-seed run on the retrieved slices at 378 calls, about 400k input tokens,
  and at most 756k output tokens (2000 per call, thinking included). The confirm gate adds
  one reading turn per fallback row. Adding
  `slice-oracle` adds 63 calls. Run it only with approval:

  ```sh
  ANTHROPIC_API_KEY=... node harness/run.mjs --client anthropic --model claude-sonnet-5-5 \
    --seeds 3 --out results/<run>.json
  ```

  The live client uses the Anthropic SDK that `@yakcc/shave` pins. It uses no server-side
  model fallback, because every arm must run on the same model.
- **Scale: 21 tasks** (#1272). There are ten single-function seed tasks and eleven
  composition tasks drawn from the shave corpus fixtures. See "Tasks" below.

## Tasks

| Difficulty class | Count | Meaning |
|---|---|---|
| `single` | 10 | One small self-contained function. The slice is a stub signature, not corpus source. |
| `compose-2` | 4 | Needs two corpus atoms combined. |
| `compose-3+` | 7 | Needs three or more corpus atoms combined. |

| Task | Class | Corpus atoms it composes | Slice candidates |
|---|---|---|---|
| `add-days-iso` | compose-3+ | date-fns `parseDate`, `addDays`, `addLeadingZeros` | 6 |
| `add-durations` | compose-2 | ms `parse`, `fmtShort` | 4 |
| `base64url-from-string` | compose-3+ | base64-js `fromByteArray`, `encodeChunk`, `tripletToBase64` | 5 |
| `build-order` | compose-3+ | toposort `uniqueNodes`, `makeOutgoingEdges`, `toposort` | 5 |
| `days-between` | compose-3+ | date-fns `parseDate`, `validateDate`, `differenceInMilliseconds` | 6 |
| `memoize-lru` | compose-2 | lodash `memoize`, semver `internal/lrucache` `LRUCache` | 4 |
| `pointer-get` | compose-3+ | jsonpointer `compilePointer`, `untilde`, `get` | 6 |
| `sort-versions` | compose-3+ | semver `compareMain`, `comparePre`, `compareIdentifiers` | 7 |
| `suggest-words` | compose-2 | fastest-levenshtein `distance`, `closest` | 4 |
| `uuid-normalize` | compose-3+ | uuid `validate`, `parse`, `unsafeStringify` | 6 |
| `uuid-version` | compose-2 | uuid `validate`, `version` | 4 |
| `chunk`, `clamp`, `group-by`, `parse-int-strict`, `range`, `safe-filename`, `shallow-equal`, `slugify`, `title-case`, `unique` | single | none | 1 to 2 |

The composition tasks are written in `tasks-src/corpus-tasks.mjs`.
`node harness/build-tasks.mjs` writes `tasks/<id>.json`. It resolves each slice candidate's
`ref` (fixture file and definition name) to the exact span in
`packages/shave/src/__fixtures__/module-graph`, so the candidate text is real corpus source
and its citation gives the lines it came from. `--check` fails when a task file is stale.
The self-test re-derives every citation from the fixture.

The specs differ from the atoms on purpose where real reuse would have to adapt. Three
self-tests confirm that a naive copy fails the held-out check:

- `daysBetween` must handle years below 100, which `Date.UTC` maps to 19xx.
- `memoizeLru` must cache `undefined`, which semver's `LRUCache` drops.
- `suggest` returns a ranked list, where `closest` returns one match.

`sortVersions` also rejects a leading `v`, which semver accepts.

### Held-out discipline

- Each held-out check runs in a fresh `vm` context. The 2 s timeout covers the candidate's
  own execution, not only loading it.
- A model client sees a task only through `clientView` (id, spec, reference). The offline
  client is given only that view. A self-test makes reading `heldOut` throw and runs the
  offline client over every task. Another checks that no prompt contains a held-out check.
- The reference solutions are given to the offline client only, to validate the harness.
  The live client sees only the prompt, which `buildPrompt` builds from the spec and the
  slice.

## Limitations

- The fixture slices (`--slice fixture` and the `slice-oracle` arm) have hand-set scores
  that put the needed atoms first, and their citations are not registry blocks
  (`unregistered-sha256-<hash>`). Retrieved slices have the registry's scores and real
  block merkle roots.
- The retrieval limits are listed under "Retrieval": one query per task, a raw-definition
  pool, and a 0.8 threshold not calibrated to real scores.
- 21 tasks is still a small sample. Per-class pass rates over four to ten tasks have wide
  intervals, so report them with their counts.
- The arms work on TypeScript text. Moving them to line-form composition (#1275) is part of
  #1258's run design.

## Break-even

With a baseline (`scratch`) cost `C_s` per task, an arm cost `C_r` per task, and a
one-time setup cost `S`, the arm pays once `n * (C_s - C_r) > S`, so
`n* = ceil(S / (C_s - C_r))`. If `C_r >= C_s`, it never pays. `breakEven` reports this per
arm with costs in mean tokens per task (`nStarByTask`). It also reports cost in tokens per
passing task (`nStarByPass`), which charges an arm for its failures. The harness does not
measure `S`, so `n*` is reported over a grid of S (0, 1k, 10k and 100k tokens).
