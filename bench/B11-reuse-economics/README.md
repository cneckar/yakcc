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

Both slice arms choose their candidates with `selectCompositionContext` from
`@yakcc/shave` (`packages/shave/src/retrieval/context.ts`, DEC-RETRIEVAL-CONTEXT-001). With
`sourceSpread` absent it selects in rank order. With `sourceSpread: { maxPackageShare }` it
applies the fill (DEC-RETRIEVAL-FILL-001). Defaults are a 1200-token budget and a share of
0.5.

### Fallback policy (#1263)

`decideFallback` (DEC-RETRIEVAL-GAP-GATE-001) decides from the slice scores and the
candidate, never from the held-out check:

| Gap | Trigger reason | What the arm does |
|---|---|---|
| No candidate reaches the strong threshold (0.8) | `near-miss-only` | Writes from the spec alone (one turn). The slice is not worth its tokens. |
| A strong candidate exists, and the reply has closure holes (names nothing defines, checked by the TypeScript checker against ES2022 only) | `unexplained-residual` | One repair turn, with the missing names. |
| A strong candidate exists, and the reply has no holes | none | One turn. No synthesis. |

Every trigger is written to `triggers` (task, seed, reason, best score, holes). The counts
by reason and the synthesis rate are in `triggerCounts`. A reply that stops on a refusal or
on the token cap fails with its stop reason, and is not read as a hole.

This is the TypeScript-text form of the policy. The graph form is `composeMissing` in
`packages/federation/src/authored.ts`, where the gaps are `no-match` and a failed check
such as `closure`. Moving the arms to line-form composition is a design decision for the
live run (see Limitations).

### Fill on and off (#1271)

`results/fill-selections.json` records each task's candidate set in rank order and under
the fill, at budgets 600 and 1200 (`node harness/selections.mjs`). Every run also records
both sets per task in `selections`.

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
node --test harness/harness.test.mjs harness/run.test.mjs
node harness/build-tasks.mjs --check             # corpus task files match their source
node harness/run.mjs --dry-run --seeds 3         # plan and token upper bound; no calls
node harness/run.mjs --client offline --seeds 3 --out results/offline-validation.json
node harness/selections.mjs                      # fill on/off candidate sets
```

Options: `--seeds N`, `--arms scratch,slice,slice-fill,fallback`, `--budget`, `--share`,
`--effort` (live only).

## Status

- **Harness: built and tested.** 75 tests pass across `harness.test.mjs` and
  `run.test.mjs`.
- **Offline dry run:** `results/offline-validation.json`, with three seeds and every arm. The
  offline client returns reference solutions, so every row passes and the token counts are
  estimates. It checks that the harness runs end to end. It is **not** a measurement of
  reuse.
- **Live run: not run.** It needs a key and approved spend. `results/dry-run-plan.json`
  bounds a three-seed run at 294 calls, about 218k input tokens, and at most 588k output
  tokens (2000 per call, thinking included). Run it only with approval:

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

- The slice scores are fixture scores, set by hand so the needed atoms rank first. They are
  not retriever output, so B11 measures what a model does with a given slice, not
  retrieval quality. `scripts/retrieval-recall-measure.mjs` measures retrieval.
- The corpus spans are not registry blocks. A citation's `merkleRoot` is
  `unregistered-sha256-<hash of the span>`, not a block merkle root.
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
