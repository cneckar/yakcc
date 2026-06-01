# Reference-Emit Paid Experiment

**Purpose:** Behavioral confirmation that a real model emits ~10 output tokens
under the reference-emit flow vs hundreds under the verbatim-write flow.

`measure.mjs` (#1041) proved the OUTPUT collapse OFFLINE via char/token estimation
(50x ratio across the B4-v5 corpus). This experiment confirms the same phenomenon
with real Anthropic API calls: does a model that receives the real discovery system
prompt and is placed in the correct prompt-path actually write ~10 tokens in
reference mode?

## Files

| File | Purpose |
|------|---------|
| `paid-experiment.mjs` | Main experiment script. `--dry` (default) validates wiring keyless. `--real` makes live API calls. |
| `paid-experiment.test.mjs` | Vitest tests validating experiment construction in `--dry` mode (no API). |
| `vitest.config.mjs` | Vitest config — includes both `measure.test.mjs` and `paid-experiment.test.mjs`. |
| `results/paid-experiment.json` | Raw results written after a `--real` run. |
| `results/paid-experiment.md` | Dossier written after a `--real` run. |

## Design

For each `(atom, model, condition, rep)` cell:

- **system** = `docs/system-prompts/yakcc-discovery.md` (real discovery prompt, prompt-cached via `cache_control: {type: "ephemeral"}`).
- **user message** simulates the state right before the model writes:
  - **verbatim** condition: "You called `yakcc_compile` and received this source: `<IMPL>`. Complete the task now." — no mention of `.yakcc/manifest.json`, so the prompt's Section B fires → model should write the full impl body.
  - **reference** condition: "This project is configured for compose-by-reference (`.yakcc/manifest.json` is present). You called `yakcc_reference` and received: `<JSON artifact>`. Complete the task now." — Section A fires → model should write only the import line (~10 tokens).
- Reference artifacts are built by the real `@yakcc/compile` builders (`addReference`, `referenceImportLine`, `generateAtomDts`) — same approach as `measure.mjs`.

**Atoms:**
- Small: `crc32c`, `lru-ttl-cache` (from `tasks.json`)
- Large: `avl-tree`, `dijkstra-heap` (from `tasks-hard.json`)

**Models:** `claude-haiku-4-5-20251001`, `claude-sonnet-4-6`

**Reps:** 2 per cell (configurable)

## Cost Gate (mandatory)

- `--dry` is the DEFAULT. No API calls, no key needed. Prints the full plan + per-cell messages + cost estimate.
- `--real` requires `ANTHROPIC_API_KEY` in the environment. Errors out clearly if missing.
- Hard `--max-usd` cap (default `$5.00`): estimates before running; refuses if estimate exceeds cap; aborts rolling spend if exceeded.
- The key is read ONLY from `process.env.ANTHROPIC_API_KEY`. No `.env` files, no hardcoded values.

## Running Dry (keyless validation)

```bash
node bench/B4-tokens-v5/reference-emit/paid-experiment.mjs --dry
# Or equivalently (--dry is the default):
node bench/B4-tokens-v5/reference-emit/paid-experiment.mjs
```

Prints: plan summary, cost estimate (~$0.40 for the default 32-cell matrix), per-cell messages (truncated). Makes zero API calls.

## Running Tests (keyless)

```bash
cd bench/B4-tokens-v5/reference-emit
npx vitest run --config vitest.config.mjs
```

Both `measure.test.mjs` and `paid-experiment.test.mjs` pass with no API key. 75 tests total.

## Running Real (operator-gated)

Once `ANTHROPIC_API_KEY` is available:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
node bench/B4-tokens-v5/reference-emit/paid-experiment.mjs --real
```

Configurable options:

```bash
node bench/B4-tokens-v5/reference-emit/paid-experiment.mjs --real \
  --atoms crc32c,lru-ttl-cache,avl-tree,dijkstra-heap \
  --models claude-haiku-4-5-20251001,claude-sonnet-4-6 \
  --reps 2 \
  --max-usd 5.00
```

Results are written to:
- `results/paid-experiment.json` — raw cell data (output_tokens, input_tokens, cache fields, behavioral pass, response text)
- `results/paid-experiment.md` — formatted dossier with per-(atom, model) averages and ratio

## Measured Headline (clean run, 2026-06-01)

Reference condition actual output: **430–635 tokens** (import line + manifest entry + .d.ts + narration — full Section A write).
Verbatim condition actual output: **591–2867 tokens** (full implementation body, scales with impl size).
Measured behavioral session-output collapse: **1.3x–6.0x** (small→large atoms); scales with impl size.
Reference behavioral compliance: **100%** across all 32 cells (both models, all atoms).

Note: The original ~10–20 token figure was the *import-line-only* artifact measured offline by
`measure.mjs`. The real model also writes the manifest entry, .d.ts stub, and narration as
required by Section A of the discovery prompt, bringing real reference output to 430–635 tokens.
The structural artifact collapse (what lands in the codebase) remains ~50x per measure.mjs;
the behavioral session-output collapse (what the API bills) is 1.3x–6.0x depending on impl size.

## Behavioral Correctness Flag

For each reference-condition cell, the experiment records `behavioral_pass`:
- `true` if the model's response contains the import line AND does not contain a distinctive snippet of the impl body.
- `false` if the model wrote the impl anyway (protocol violation — Section A not followed).

This is the key behavioral confirmation: if `behavioral_pass=true` across reference cells, the prompt conditioning is working correctly.

## Scope

- Does NOT modify `measure.mjs`, `phase2-v5.mjs`, `PROTOCOL.md`, or any governed harness file.
- Standalone experiment under `bench/B4-tokens-v5/reference-emit/`.
- Rollback: delete `paid-experiment.mjs`, `paid-experiment.test.mjs`, `PAID-README.md`, `results/paid-experiment.*`.
