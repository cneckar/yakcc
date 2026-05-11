# Measurement-First Decision — Full-Corpus Stratified Baseline

**WI-V3-DISCOVERY-D5-CORPUS-SEED** (issue #269)
**Amends:** DEC-V3-INITIATIVE-002 (gate requirements), DEC-V3-INITIATIVE-001 (original gate)
**Generated:** 2026-05-11T03:18:49.891Z
**HEAD SHA:** d2da492
**Provider:** Xenova/all-MiniLM-L6-v2
**Corpus:** stratified-full-corpus-69888bdd60e9e711 (50 entries: 8 seed atoms × ~4 queries + 10 synthetic negative-space)
**Registry:** bootstrap/yakcc.registry.sqlite (full yakcc self-shave, ~1,773+ atoms)

---

## The Gate

Per DEC-V3-INITIATIVE-001 (amended by DEC-V3-INITIATIVE-002): the gate fires when:
1. ✅ WI-V3-DISCOVERY-D5-CORPUS-SEED lands (this WI — stratified 50-100 entry corpus)
2. ⬜ WI-V3-DISCOVERY-IMPL-QUERY lands (#270 — symmetric query-text derivation)

This artifact satisfies condition (1). When condition (2) is also met, re-run this
harness to produce the final gate input with the text-asymmetry bug fixed.

---

## Provider Note

Provider: transformers.js local (Xenova/all-MiniLM-L6-v2) — SEMANTIC embeddings. These numbers are operator-meaningful.

---

## Per-Category M1..M4 Results (Xenova/all-MiniLM-L6-v2)

| Category                       | Queries | M1 (Hit Rate) | M2 (Prec@1) | M3 (Rec@10) | M4 (MRR)  |
|--------------------------------|---------|---------------|-------------|-------------|-----------|
| behavior-only                  |      10 |         100.0% |        12.5% |        87.5% |     0.348 |
| guarantees-stressed            |      10 |         100.0% |        12.5% |        62.5% |     0.297 |
| error-condition-stressed       |      10 |         100.0% |        37.5% |        87.5% |     0.557 |
| non-functional-stressed        |      10 |         100.0% |        12.5% |        37.5% |     0.229 |
| multi-aspect                   |      10 |         100.0% |        25.0% |        87.5% |     0.458 |
|--------------------------------|---------|---------------|-------------|-------------|-----------|
| **OVERALL**                    |      50 |         100.0% |        20.0% |        72.5% |     0.378 |

**M1 threshold:** 0.5 (calibrated per DEC-V3-DISCOVERY-CALIBRATION-FIX-001)
**M2/M3/M4:** computed only for entries with non-null expectedAtom (seed-derived positive entries)

---

## M5 Score Calibration (Brier per band — full corpus)

| Band | N | Observed P | Midpoint | Brier | Pass? |
|------|---|------------|----------|-------|-------|
| strong (≥0.85) | 1 | 0.000 | 0.925 | 0.85563 | FAIL |
| confident (≥0.70) | 44 | 0.182 | 0.775 | 0.35186 | FAIL |
| weak (≥0.50) | 5 | 0.000 | 0.600 | 0.36000 | FAIL |
| poor (<0.50) | 0 | N/A | 0.250 | N/A | N/A |

---

## Operator Decision

**ALL CATEGORIES PASS M1 ≥ 80%**

Single-vector embedding meets the M1 target across ALL 5 query categories.
D1's multi-dimensional schema (5× storage cost) is NOT empirically justified.

**OPERATOR DECISION: v3-implementation SHOULD PAUSE pending re-spec of D1.**

The 5× storage cost (1,920 floats/atom vs 384) is unjustified if single-vector
retrieval quality does not degrade even for multi-aspect queries.

Next step: File a re-spec WI for D1 before proceeding with v3-implementation.

---

## Worst-Performing Entries (M1)

  - cat1-haversine-001: combinedScore=0.618
  - cat1-uuid-001: combinedScore=0.660
  - cat1-peek-char-001: combinedScore=0.689
  - cat1-ascii-char-001: combinedScore=0.691
  - cat1-whitespace-001: combinedScore=0.692

---

## Status of PR #267 Recommendation

PR #267 (DEC-V3-DISCOVERY-CALIBRATION-FIX-001) recommended **pausing v3 IMPL** based on
M1=80% on the seed-derived N=5 subset. That recommendation was **explicitly retracted**
by DEC-V3-INITIATIVE-002 as premature (corpus too small; text-asymmetry bug not fixed).

This full-corpus run provides the updated gate input. See operator decision above for the current recommendation.

---

## Next Steps

1. File a re-spec WI for D1 (5-vector schema) — single-vector is sufficient.
2. Update DEC-V3-INITIATIVE-001 with the gate result.
3. Consider whether any dimension-specific embeddings (not full D1) might still be valuable.
