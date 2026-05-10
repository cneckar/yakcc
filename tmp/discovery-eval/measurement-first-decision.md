# Measurement-First Decision — Single-Vector Embedding Baseline

**Date:** 2026-05-10
**WI:** WI-V3-DISCOVERY-D5-HARNESS (#200)
**Guardrail:** DEC-V3-INITIATIVE-001 (measurement-first gate for v3 multi-dim implementation)

---

## Summary

The D5 evaluation harness has been implemented (`packages/registry/src/discovery-eval.test.ts` +
`discovery-eval-helpers.ts`). The baseline run against the **current single-vector embedding**
with the offline BLAKE3 provider (DEC-CI-OFFLINE-001) produced the following M1–M5 numbers:

| Metric | Target | Observed (offline BLAKE3) | Assessment |
|--------|--------|--------------------------|------------|
| M1 hit-rate | ≥ 80 % | **0 %** | FAILS |
| M2 precision@1 | ≥ 70 % | 25 % | FAILS |
| M3 recall@10 | ≥ 90 % | 100 % † | trivially passes |
| M4 MRR | ≥ 0.70 | 0.40 | FAILS |
| M5 Brier (poor band) | < 0.10 per band | 0.0025 | passes |

† M3 = 100% is a corpus artifact: the stub corpus has 8 atoms, K=10, and K > N causes all atoms
to appear in every top-10 result. This is NOT meaningful recall evidence.

---

## Provider context

The offline BLAKE3 provider (DEC-CI-OFFLINE-001, `createOfflineEmbeddingProvider()`) generates
embedding vectors via 12 chained BLAKE3 hashes of the text. BLAKE3 is a cryptographic hash —
it is NOT semantically aware. Texts that are semantically related produce completely unrelated
vectors. **The M1–M5 numbers above do not measure semantic retrieval quality; they measure random
vector similarity.**

The stored embedding for each block is derived from `canonicalizeText(spec)` (the full spec JSON),
while the query embedding is derived from `behavior + "\n" + inputs/outputs text`. With the offline
provider, these produce unrelated BLAKE3 vectors even when the query behavior text is an exact
substring of the stored spec. This explains M1 = 0%: all `combinedScore = 1 - cosineDistance`
values fell below the 0.50 weak-band threshold.

---

## Interpretation

### Guardrail outcome: **v3 multi-dim implementation proceeds**

The measurement-first guardrail (DEC-V3-INITIATIVE-001) asks:

> "If single-vector M1 hit-rate already meets D5's ≥ 80 % target, the 5× storage cost
> (1,920 floats/atom vs 384) committed to in D1 is unjustified and the rest of v3
> implementation pauses pending a re-spec."

With M1 = 0% against the offline provider, the target is not met. The baseline does NOT
provide evidence that single-vector embedding suffices, so **v3 multi-dim implementation
is unblocked**.

### Caveat

The offline BLAKE3 provider does not produce semantically meaningful vectors. A definitive
measurement requires running the harness with the local Xenova/all-MiniLM-L6-v2 semantic
embedding provider (`createLocalEmbeddingProvider()`, DEC-EMBED-010) against the full
seed-derived + synthetic-tasks corpus (to be authored by WI-V3-DISCOVERY-D5-CORPUS-SEED).

With the semantic provider and a realistic paraphrase corpus, M1 could be higher — potentially
above 80%, which would retroactively contradict the v3 decision. However, architectural
arguments favor v3 regardless:

1. **Query-time dimension weighting** (D1 thesis): even if single-vector embedding achieves
   M1 ≥ 80% overall, it cannot distinguish "find atoms with this BEHAVIOR" from "find atoms
   with these GUARANTEES" — both produce the same combined score, preventing per-dimension
   tuning.
2. **Correlation between query text and stored text**: the query text (`behavior + params`)
   is a strict subset of the stored embedding text (full spec JSON). Under the local semantic
   provider, the single-vector representation embeds the full spec rather than the query-facing
   behavior, creating a systematic semantic mismatch. Multi-dim embeddings (one per field group)
   eliminate this mismatch for the behavior dimension.
3. **D5 calibration data**: M5 shows all results in the "poor" band with the offline provider.
   Once the semantic provider and full corpus are available, if the strong-band Brier exceeds
   0.10, that independently justifies multi-dim refinement.

---

## Next steps

1. **Unblocked by this WI:** `WI-V3-DISCOVERY-IMPL-MIGRATION-VERIFY` — migration 7 + G1/G2/G3
   verification gates (see MASTER_PLAN.md v3 implementation row).
2. **Parallel:** `WI-V3-DISCOVERY-D5-CORPUS-SEED` — author ≥ 30 seed-derived + ≥ 20 synthetic
   corpus entries to enable meaningful M1–M5 measurement with the semantic provider.
3. **Deferred:** semantic provider evaluation (local Xenova/all-MiniLM-L6-v2 run) — requires
   `WI-V3-DISCOVERY-D5-CORPUS-SEED` and network access (`YAKCC_NETWORK_TESTS=1`).
4. **Future CI gate:** `WI-V3-DISCOVERY-D5-CI-GATE` — wire dual-gate (regression + threshold)
   once the full corpus + multi-dim system are in place.

---

## Corpus used

8 stub atoms (seed-derived-style) + 2 synthetic negative-space entries. Stub corpus behaviors:

1. Parse a comma-separated list of integers enclosed in square brackets from a string.
2. Return true if a single character is an ASCII decimal digit 0 through 9.
3. Return true if a character is an opening or closing square bracket.
4. Advance a string position past any leading whitespace characters.
5. Parse a non-negative integer starting at a position in a string, returning its value and the new position.
6. Return true if a position index equals or exceeds the string length, indicating end of input.
7. Return the character at the current position without advancing the position.
8. Throw RangeError if a string contains any character whose code point exceeds 127.

Negative-space: Haversine distance (no atom), clamp-to-bounds (no atom).
