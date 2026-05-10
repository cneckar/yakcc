# Measurement-First Decision — Single-Vector Baseline

**WI-V3-DISCOVERY-D5-HARNESS** (issue #200)
**Generated:** 2026-05-10T18:27:30.636Z
**HEAD SHA:** c4dbfee
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
| M1 Hit rate | 100.0% | >=80% | PASS |
| M2 Precision@1 | 40.0% | >=70% | FAIL |
| M3 Recall@10 | 100.0% | >=90% | PASS |
| M4 MRR | 0.540 | >=0.70 | FAIL |
| M5 Brier strong | N/A (no data) | <0.10 | N/A |
| M5 Brier confident | N/A (no data) | <0.10 | N/A |
| M5 Brier weak | 0.14272 | <0.10 | FAIL |
| M5 Brier poor | N/A (no data) | <0.10 | N/A |

---

## Operator Decision

**M1 PASSES (100.0% >= 80%)**

OPERATOR DECISION: Single-vector embedding ALREADY meets the M1 target.
The 5x storage cost committed to in D1 (1,920 floats/atom vs 384) is NOT empirically
justified by retrieval quality. **v3-implementation SHOULD PAUSE pending re-spec.**

Before proceeding with D1's multi-dimensional schema, consider:
1. Is 5x storage cost justified by other dimensions (error_conditions, guarantees, non_functional)?
2. Do M2/M3/M4 failures (below) justify multi-dimensional embeddings?
3. File a re-spec WI if the answer to (1) and (2) is no.

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
