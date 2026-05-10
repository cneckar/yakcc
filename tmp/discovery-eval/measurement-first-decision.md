# Measurement-First Decision — Single-Vector Baseline

**WI-V3-DISCOVERY-D5-HARNESS** (issue #200)
**Generated:** 2026-05-10T16:23:23.997Z
**HEAD SHA:** 2514529
**Provider:** yakcc/offline-blake3-stub
**Corpus:** bootstrap-inline (9 entries: 5 seed-derived + 4 synthetic)

---

## The Gate

Per DEC-V3-INITIATIVE-001: if single-vector M1 hit-rate ALREADY meets >=80%, the 5x storage
cost in D1 (1,920 floats/atom) is unjustified. This file is the operator-facing decision input.

---

## Provider Note

**WARNING: OFFLINE PROVIDER (BLAKE3 hashes)**

The numbers below were produced with the offline BLAKE3 embedding provider (DEC-CI-OFFLINE-001),
which produces deterministic but NON-SEMANTIC vectors. Similar behavior strings do NOT produce
nearby vectors. M1..M4 numbers DO NOT reflect real retrieval quality.

To produce the operator-meaningful baseline, re-run with:
  DISCOVERY_EVAL_PROVIDER=local pnpm --filter @yakcc/registry test

The offline-provider run validates that the harness code is correct and the corpus schema is
well-formed. It does NOT answer the "should v3-implementation proceed?" question.

---

## Baseline Results (yakcc/offline-blake3-stub)

| Metric | Value | Target | Pass? |
|--------|-------|--------|-------|
| M1 Hit rate | 0.0% | >=80% | FAIL |
| M2 Precision@1 | 40.0% | >=70% | FAIL |
| M3 Recall@10 | 100.0% | >=90% | PASS |
| M4 MRR | 0.540 | >=0.70 | FAIL |
| M5 Brier strong | N/A (no data) | <0.10 | N/A |
| M5 Brier confident | N/A (no data) | <0.10 | N/A |
| M5 Brier weak | N/A (no data) | <0.10 | N/A |
| M5 Brier poor | 0.00077 | <0.10 | PASS |

---

## Operator Decision

**M1 FAILS (0.0% < 80%)**

Single-vector embedding does NOT meet the M1 target.
v3-implementation MAY PROCEED with D1's multi-dimensional schema.

Worst-performing entries (lowest top-1 score):
  - synth-clamp-001: combinedScore=0.300
  - synth-haversine-negative-001: combinedScore=0.302
  - seed-comma-001: combinedScore=0.303

These entries justify per-dimension embeddings in D1:
- Entries failing M2 suggest top-1 retrieval is imprecise (wrong atom ranked first)
- Entries failing M3 suggest the correct atom is not in the top-10 at all
- Entries failing M4 suggest ranking quality is poor

---

## Worst-Performing Entries

**M2 (Precision@1 failures):**
  - seed-ascii-char-001: top1=02aa7b492ff9fcbb5a47cc8d664abb10fa1891b016674e98f32c7c0747d0f108 expected=5eeef96b255b42fdb4c8e7b51b335053f30c0a43d18e80e6f3ae51905028532f
  - seed-integer-001: top1=02aa7b492ff9fcbb5a47cc8d664abb10fa1891b016674e98f32c7c0747d0f108 expected=ceb61944a0ee78407db73e8523ee40525c3f526047baa159a91705c54eeeed96
  - seed-digit-001: top1=70f2615e70db2be0d9566faf06048794bc08831e13d6e432f0c92e7e9ed1eb0a expected=02aa7b492ff9fcbb5a47cc8d664abb10fa1891b016674e98f32c7c0747d0f108

**M3 (Recall@10 failures):**
  (none — all eligible entries found in top-10)

**M4 (MRR failures):**
  - seed-digit-001: rank=5
  - seed-ascii-char-001: rank=4
  - seed-integer-001: rank=4

---

## Next Steps

1. Re-run with DISCOVERY_EVAL_PROVIDER=local to produce the semantic baseline.
2. The CI run (offline provider) only validates harness correctness, not retrieval quality.
3. Commit the local-provider output as the authoritative baseline.
