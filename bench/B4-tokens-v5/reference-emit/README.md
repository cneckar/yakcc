# B4-v5 Reference-Emit Output-Collapse Measurement

Epic #1043 / Issue #1041 — Offline measurement of reference-emit vs verbatim-write
OUTPUT-token collapse across the B4-v5 task corpus.

## What This Measures

The **verbatim-write flow** (#1030) directs the model to write the full atom
implementation as its output — the `assemble()` source verbatim (~309–1102 tokens
per atom). The **reference-emit flow** (#1047/#1048) directs the model to write a
single import line (~13–14 tokens) returned by `yakcc_reference`.

This benchmark measures the **deterministic OUTPUT collapse** computable entirely
offline: no API key, no model calls, no network.

## How to Run

```bash
# From repo root:
node bench/B4-tokens-v5/reference-emit/measure.mjs

# JSON output (machine-readable):
node bench/B4-tokens-v5/reference-emit/measure.mjs --json

# Tests:
(cd /path/to/repo && node_modules/.pnpm/node_modules/.bin/vitest run \
  --config bench/B4-tokens-v5/reference-emit/vitest.config.mjs)
```

Results are written to `bench/B4-tokens-v5/reference-emit/results/`:
- `reference-emit-collapse.json` — machine-readable
- `reference-emit-collapse.md` — human dossier with real numbers

## Token Heuristic

**No tokenizer is bundled.** Token counts use the standard rough heuristic:

```
tokens ≈ ceil(chars / 4)
```

This is a well-known approximation: most LLM tokenizers (GPT-3/4, Claude) average
~3.5–4 chars/token for English and code. The estimate slightly overestimates token
counts (conservative).

**The collapse RATIO is robust to tokenizer choice.** Since both sides (verbatim impl
and import line) use the same heuristic divisor (4), the divisor cancels out in the
ratio. The ratio is effectively `impl_chars / import_chars` regardless of which
tokenizer is used. This makes the ratio the headline number, not the raw token counts.

## What "verbatim source" means

The reference implementations (`bench/B4-tokens-v5/tasks/<id>/reference-impl.ts`) are
the ground-truth atom implementations. Under the verbatim flow, the model writes exactly
this source as its response. Reading these files directly is equivalent to calling
`assemble(root, registry).source` for each atom — the B4 task atoms are not seed atoms;
they are the benchmark targets written during a live run.

## What "synthetic BlockMerkleRoot" means

The real BLAKE3 content-address roots for these atoms exist in the Opus-built corpus
registry (not bundled here). For offline measurement, the script derives a deterministic
64-char hex root from `SHA-256(impl_source)`. This is used only to compute the
12-character alias prefix for the import path. It is a measurement artifact, not a
production content address.

The import lines produced are **structurally identical** to what `yakcc_reference` would
return for the same atoms from the live registry — only the alias hex prefix differs.

## What "DTS one-time cost" means

`generateAtomDts(spec, symbol)` produces the TypeScript declaration file the model
writes once when first referencing an atom. It is **not repeated** per-use; the import
line alone is the recurring output cost.

The B4 corpus atoms export classes (CRC32C, Utf8Codec, etc.). `generateAtomDts` generates
function declarations. A minimal synthetic SpecYak is used (empty inputs/outputs → `void`),
so the DTS chars reported are a **lower bound** on actual class-based .d.ts size. The
verbatim vs import-line ratio is unaffected by this approximation.

## OPERATOR-GATED: Full Multi-Turn Economics

The numbers in this benchmark confirm the **OUTPUT collapse** the #1041 analysis
predicted. The full per-task economics also depend on factors that require paid
model runs:

- **Input tokens**: ~12.5KB discovery system prompt per turn
- **Prompt cache efficiency**: cache_on vs cache_off sub-conditions (2 sub-cells in v5)
- **Model narration**: per-turn thinking/reasoning/explanation tokens
- **Multi-turn overhead**: resolve + reference call(s) vs single compile turn
- **Tool-call roundtrip tokens**: tool input/output overhead per turn

These **require `ANTHROPIC_API_KEY` and a paid model run** via the v5 harness:

```bash
# Operator-gated: requires API key + corpus registry
ANTHROPIC_API_KEY=<key> YAKCC_REGISTRY_PATH=<path/to/corpus.sqlite> \
  node bench/B4-tokens-v5/harness/phase2-v5.mjs
```

**This is NOT done in this benchmark**: no API key is available in this environment.
The operator-gated paid run is Phase 2 of Epic #1043.

## Scope

- **Allowed**: `bench/B4-tokens-v5/reference-emit/*`
- **Forbidden**: modifying governed v5 harness files (`phase2-v5.mjs`, `matrix-v5.mjs`, `PROTOCOL.md`)
- **Rollback boundary**: this `reference-emit/` subdirectory only

## Files

| File | Purpose |
|------|---------|
| `measure.mjs` | Main measurement script (offline, deterministic) |
| `measure.test.mjs` | Vitest tests validating the measurement |
| `vitest.config.mjs` | Vitest config for the test file |
| `results/reference-emit-collapse.json` | Machine-readable results |
| `results/reference-emit-collapse.md` | Human dossier with real numbers |
