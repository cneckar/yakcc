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

- **Harness: built and tested.** `node --test harness/` passes 12 of 12. The offline
  validation (`results/offline-validation.json`) exercises every arm end to end. It uses
  reference solutions, so its numbers are **not** a measurement of reuse.
- **Live run: blocked.** Every arm needs a model call. `ANTHROPIC_API_KEY` is not set
  in this environment, and a live run costs money. Run it only with an approved key and
  spend:

  ```sh
  ANTHROPIC_API_KEY=... node harness/run.mjs --client anthropic --model claude-sonnet-5-5 --out results/<run>.json
  ```

- **Scale: three seed tasks.** The design calls for about ten composition tasks, with
  held-out tests, drawn from the corpus. Authoring the rest is the remaining work for
  this track.

## Break-even

With a scratch cost `C_s` per task, a slice-arm cost `C_r` per reuse, and an up-front
setup cost `S`, reuse pays once `n * (C_s - C_r) > S`, so `n* = S / (C_s - C_r)`.
The harness reports per-arm means. Fitting `S` requires the live run.
