# Measurement-First Decision — Single-Vector Baseline

**WI-V3-DISCOVERY-D5-HARNESS** (issue #200)
**Generated:** 2026-05-10T18:02:02.841Z
**HEAD SHA:** 31192ca
**Provider:** Xenova/all-MiniLM-L6-v2
**Corpus:** bootstrap-inline (9 entries: 5 seed-derived + 4 synthetic)

---

## ⚠️ STATUS NOTICE (WI-V3-DISCOVERY-D5-CORPUS-SEED, issue #269)

**PR #267's "pause v3 IMPL" recommendation is EXPLICITLY RETRACTED per DEC-V3-INITIATIVE-002.**

This document reflects the small 9-entry inline corpus (N=5 seed-derived).
Per DEC-V3-INITIATIVE-002 (operator decision 2026-05-10), the N=5 measurement is
contaminated by: (a) too-small corpus (single-observation problem); (b) store/query
text-asymmetry bug (DEC-VECTOR-RETRIEVAL-002, not yet fixed).

**The gate cannot fire on this measurement.** Two prereqs must land first:
1. ✅ WI-V3-DISCOVERY-D5-CORPUS-SEED (issue #269) — stratified 50-entry corpus
   on the full yakcc registry (~1,773+ atoms) — **landed on this PR**
2. ⬜ WI-V3-DISCOVERY-IMPL-QUERY (issue #270) — fix the text-asymmetry bug

After both land, re-run `DISCOVERY_EVAL_PROVIDER=local pnpm --filter @yakcc/registry test`
against `bootstrap/yakcc.registry.sqlite`. The full-corpus per-category numbers in
`baseline-single-vector-full-corpus-2026-05-10.json` are the actual gate input.

See `tmp/discovery-eval/measurement-first-decision.md` (re-emitted by the full-corpus
harness) for the per-category M1..M5 breakdown once the full-corpus test is run.

---

## The Gate

Per DEC-V3-INITIATIVE-001: if single-vector M1 hit-rate ALREADY meets >=80%, the 5x storage
cost in D1 (1,920 floats/atom) is unjustified. This file is the operator-facing decision input.

---

## Provider Note

Provider: transformers.js local (Xenova/all-MiniLM-L6-v2) — SEMANTIC embeddings. These numbers are the operator-meaningful baseline.

---

## Baseline Results (Xenova/all-MiniLM-L6-v2) — INLINE 9-ENTRY CORPUS ONLY

**⚠️ These numbers are from the small 9-entry inline corpus. See notice above.**

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

## Operator Decision (INLINE CORPUS — SUPERSEDED)

**M1 FAILS (55.6% < 80%)** on the inline corpus.

This result is NOT actionable per DEC-V3-INITIATIVE-002. See status notice above.
The full-corpus per-category breakdown is the required gate input.

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

1. Run the full-corpus harness after WI-V3-DISCOVERY-IMPL-QUERY (#270) lands:
   `DISCOVERY_EVAL_PROVIDER=local pnpm --filter @yakcc/registry test`
2. The per-category M1 numbers in `baseline-single-vector-full-corpus-*.json` are
   the gate input per DEC-V3-INITIATIVE-002.
3. PR #267's "pause v3 IMPL" recommendation is retracted; do not act on it.
