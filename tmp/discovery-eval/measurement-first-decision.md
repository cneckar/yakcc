# Measurement-First Decision — Single-Vector Baseline

**WI-V3-DISCOVERY-D5-HARNESS** (issue #200)
**Generated:** 2026-05-10T18:02:02.841Z
**HEAD SHA:** 31192ca
**Provider:** Xenova/all-MiniLM-L6-v2
**Corpus:** bootstrap-inline (9 entries: 5 seed-derived + 4 synthetic)

---

## The Gate

Per DEC-V3-INITIATIVE-001: if single-vector M1 hit-rate ALREADY meets >=80%, the 5x storage
cost in D1 (1,920 floats/atom) is unjustified. This file is the operator-facing decision input.

---

## Provider Note

Provider: transformers.js local (Xenova/all-MiniLM-L6-v2) — SEMANTIC embeddings. These numbers are the operator-meaningful baseline.

---

## Baseline Results (Xenova/all-MiniLM-L6-v2)

| Metric | Value | Target | Pass? |
|--------|-------|--------|-------|
| M1 Hit rate | 55.6% | >=80% | FAIL |
| M2 Precision@1 | 80.0% | >=70% | PASS |
| M3 Recall@10 | 100.0% | >=90% | PASS |
| M4 MRR | 0.850 | >=0.70 | PASS |
| M5 Brier strong | N/A (no data) | <0.10 | N/A |
| M5 Brier confident | N/A (no data) | <0.10 | N/A |
| M5 Brier weak | N/A (no data) | <0.10 | N/A |
| M5 Brier poor | 0.03781 | <0.10 | PASS |

---

## Operator Decision

**M1 FAILS (55.6% < 80%)**

Single-vector embedding does NOT meet the M1 target.
v3-implementation MAY PROCEED with D1's multi-dimensional schema.

Worst-performing entries (lowest top-1 score):
  - synth-haversine-negative-001: combinedScore=0.304
  - synth-validate-email-001: combinedScore=0.358
  - synth-clamp-001: combinedScore=0.364

These entries justify per-dimension embeddings in D1:
- Entries failing M2 suggest top-1 retrieval is imprecise (wrong atom ranked first)
- Entries failing M3 suggest the correct atom is not in the top-10 at all
- Entries failing M4 suggest ranking quality is poor

---

## Worst-Performing Entries

**M2 (Precision@1 failures):**
  - seed-bracket-001: top1=ceb61944a0ee78407db73e8523ee40525c3f526047baa159a91705c54eeeed96 expected=081b337edc82be91038fee7cd8cc528f85ea9387240744af465da3e3cfb2753a

**M3 (Recall@10 failures):**
  (none — all eligible entries found in top-10)

**M4 (MRR failures):**
  - seed-bracket-001: rank=4
  - seed-ascii-char-001: rank=1
  - seed-digit-001: rank=1

---

## Next Steps

1. v3-implementation MAY PROCEED with D1 multi-dimensional schema.
2. Use worst-performing entries above as justification per dimension for D1's 5-vector design.
3. After D1 lands, re-run this harness to confirm multi-dimensional improves M1.
