# B11 — Reuse economics (WI-REUSE, GH #1253 / #1258)

Does reusing registry work lower the cost of later composition tasks, and at what
reuse count does it break even? The question is asked in the form the SEAM "work
cache" deck argues for: a single run cannot show a saving by construction. Break-even
appears only when later work reuses earlier work. This suite measures the arms, not
the deck's numbers.

## Arms (per task)

| Arm | Context given to the model |
|---|---|
| `scratch` | the task specification only |
| `slice` | the task spec plus the retrieved slice, filled under a token budget and spread across packages (`@yakcc/shave` `fill`, DEC-RETRIEVAL-FILL-001) |
| `fallback` | the same slice, with the gap-gated decision (`decideFallback`, DEC-RETRIEVAL-GAP-GATE-001) recorded. A reuse decision would use the candidate's implementation. None of the seed blocks has one, so this arm synthesizes. |

## Scoring

Held-out checks, not a grader. The candidate is transpiled (TypeScript) and run in a
fresh `vm` context with no host globals. Pass means every held-out assertion holds.
This removes the answer-key circularity the deck's own scoring has.

## Metrics

Per row: pass, input and output tokens, turns, wall time. Per arm: pass rate, mean
tokens, mean time. Cost is derived from tokens and the model's price, not stored here.

## Status

- **Harness: built and tested.** `node --test harness/harness.test.mjs` passes every test (the reference solution of each task passes, and a stub fails each one). The offline
  validation (`results/offline-validation.json`) exercises every arm end to end. It uses
  reference solutions, so its numbers are **not** a measurement of reuse.
- **Live run: blocked.** Every arm needs a model call. `ANTHROPIC_API_KEY` is not set
  in this environment, and a live run costs money. Run it only with an approved key and
  spend:

  ```sh
  ANTHROPIC_API_KEY=... node harness/run.mjs --client anthropic --model claude-sonnet-5-5 --out results/<run>.json
  ```

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

With a scratch cost `C_s` per task, a slice-arm cost `C_r` per reuse, and an up-front
setup cost `S`, reuse pays once `n * (C_s - C_r) > S`, so `n* = S / (C_s - C_r)`.
The harness reports per-arm means. Fitting `S` requires the live run.
