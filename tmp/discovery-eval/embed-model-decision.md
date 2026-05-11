# Embedding Model Experiment — Decision Document

**WI:** WI-V3-DISCOVERY-D5-EMBED-MODEL-RUN (issue #335)
**Prior WI:** WI-V3-DISCOVERY-D5-EMBED-MODEL-EXPERIMENT (issue #326, infrastructure)
**Decision ID:** DEC-EMBED-MODEL-DEFAULT-002
**Date:** 2026-05-11
**Status:** CLOSED — winner selected; default swapped in PR #336; DEC-V3-INITIATIVE-002 closed

---

## Decision

**Winner: `Xenova/bge-small-en-v1.5`** — M2=70.0% ✅, M3=100% ✅, M4=0.823 ✅

Default swapped from `Xenova/all-MiniLM-L6-v2` to `Xenova/bge-small-en-v1.5` in
`packages/contracts/src/embeddings.ts` (PR #336). DEC-V3-INITIATIVE-002 fully closed.

---

## Results Summary

Runs executed by operator on local Windows environment with HuggingFace access.
Same 50-entry stratified corpus and bootstrap registry used for all models.

| Model | M2 | M3 | M4 | Strong-band | Verdict |
|---|---|---|---|---|---|
| `Xenova/all-MiniLM-L6-v2` (prior default) | 62.5% | 92.5% | 0.742 | — | Below M2 target |
| **`Xenova/bge-small-en-v1.5`** | **70.0%** ✅ | **100%** ✅ | **0.823** ✅ | **36/50** | **WINNER** |
| `Xenova/e5-small-v2` | 52.5% ❌ | 87.5% ❌ | 0.653 ❌ | mis-calibrated | Reject |
| `Xenova/all-MiniLM-L12-v2` | 72.5% ✅ | 97.5% ✅ | 0.824 ✅ | 0/50 (collapse) | Reject |

### Why bge-small wins over L12 (despite L12's marginally higher M2)

L12 puts 48/50 entries in the weak band (combinedScore < 0.50). The D2 auto-accept gate
(`combinedScore > 0.85 + gap > 0.15`) **never fires**. Discovery would always surface
"weak match, choose" — defeating the entire D-HOOK-4 inline-substitution contract.

bge-small distribution: **36/50 strong, 14/50 confident, 0 weak/poor.** Auto-accept fires
on 72% of queries. M5 strong-band Brier = 0.0411 (well under 0.10 target).

### Per-category breakdown (bge-small-en-v1.5)

| Category | M2 | M3 | M4 |
|---|---|---|---|
| behavior-only | 75.0% | 100% | 0.854 |
| guarantees-stressed | 62.5% | 100% | 0.771 |
| error-condition-stressed | 50.0% | 100% | 0.698 |
| non-functional-stressed | 75.0% | 100% | 0.875 |
| **multi-aspect** | **87.5%** | **100%** | **0.917** |

M3=100% across all 5 categories. Every correct atom is in top-10, every time.
**D1 multi-vector definitively unjustified** — multi-aspect is bge-small's *best* category,
not its worst (the falsifier the entire DEC-V3-INITIATIVE-002 gate was set up to surface).

---

## Context

Post-#322 (D3 filter strictness fix), the discovery pipeline sat at:

| Metric | Pre-swap | Post-swap | Target |
|--------|---------|---------|--------|
| M2 (P@1) | 62.5% | **70.0%** ✅ | 70% |
| M3 (R@10) | 92.5% | **100%** ✅ | 90% |
| M4 (MRR) | 0.742 | **0.823** ✅ | 0.70 |

This experiment closed the 7.5pt M2 gap per DEC-V3-INITIATIVE-002-DISPOSITION decision branch:
> "If M2 ≥ 70%: swap default; close DEC-V3-INITIATIVE-002."

---

## Infrastructure Delivered (WI #326)

The `DISCOVERY_EMBED_MODEL` env-var + parametric `createLocalEmbeddingProvider(modelId, dimension)`
factory was delivered in WI #326 / PR #328. This infrastructure enabled the benchmark runs.

---

## Decision Log Entry

`DEC-EMBED-MODEL-DEFAULT-002`:
**Winner:** `Xenova/bge-small-en-v1.5` (384-dim, MIT, BGE family)
**Reason:** M2=70.0% target met; strong-band distribution enables D2 auto-accept gate;
D1 multi-vector unjustified (multi-aspect best category, not worst)
**Action:** Default swapped in `packages/contracts/src/embeddings.ts`; MASTER_PLAN updated
**Gate closed:** DEC-V3-INITIATIVE-002 — single-vector production-ready
**Follow-up WIs:** None required. `WI-V3-DISCOVERY-IMPL-MIGRATION-VERIFY` (#156) dropped from critical path.
**Unblocked:** #218 (Phase 3 contract surfacing), #219 (Phase 4 Cursor parity), #194 (v0.5 commercial)
