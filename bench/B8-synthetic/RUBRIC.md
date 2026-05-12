# B8-SYNTHETIC Benchmark Rubric

**Source:** #192 (WI-BENCHMARK-B8-SYNTHETIC) + #167 (WI-BENCHMARK-SUITE DQ-5/6/7/9)

---

## Pass Bars (per #192 + #167 DQ-5)

| Bar | Target | Measured at | Notes |
|-----|--------|-------------|-------|
| Synthetic asymptote ≥ 80% | mean savings % at f=1.0 ≥ 80% | f=1.0 (Slice 1) | Even theoretical ceiling must be viable |
| Monotonic curve | savings % must not decrease as f increases | f∈{0.1…1.0} (Slice 2) | Non-monotonic = simulation bug, not publishable |
| Cross-validation within ±15% | synthetic predictions vs production B8 | Slice 3 | Done at B8-CURVE land time |

---

## KILL Bars (per #192 + #167 DQ-5)

| Bar | Condition | Consequence |
|-----|-----------|-------------|
| **Asymptote < 50%** | mean savings % at f=1.0 < 50% | Architecture fundamentally limited; production cannot exceed this ceiling; triggers replanning before production B8 starts |
| **Non-monotonic curve** | any decreasing savings as f increases | Bug in simulation; not safe to publish; requires investigation |

---

## Two Curves Reported (per #167 DQ-9)

Per the benchmark spec, B8 reports **two curves on the same axes**:

- **Curve A — All Tasks:** includes 0%-hit-by-construction tasks (honest worst-case)
- **Curve B — Tasks-with-Coverage:** excludes 0%-hit-by-construction tasks (honest best-case)

The gap between the two curves is the **corpus-coverage signal**: it reveals how much
of the savings opportunity is from tasks where the registry has nothing to offer, vs
tasks where the registry has relevant atoms.

---

## Three Comparator Conditions (per #167 DQ-7)

Per the benchmark spec, B8 uses three conditions:

| Condition | Description | Slice |
|-----------|-------------|-------|
| **(a) Naive baseline** | Transcript as-is — LLM had no hook (actual emission) | Slice 1 (done) |
| **(b) Yakcc-aware-prompt baseline** | Re-run prompt with "atoms exist, here are examples" preamble | **Deferred** (requires LLM re-runs) |
| **(c) Simulated-hooked** | Replay with simulated interception against corpus C_f | Slice 1 (done) |

Slice 1 implements conditions (a) vs (c). Condition (b) is explicitly deferred to
production B8 per #192 spec ("Optional for synthetic — requires re-running the LLM").

---

## Per-Fraction Stratified Sampling (per #167 DQ-6)

Per the benchmark spec, sampling for each fraction f must be:
- **Stratified proportionally** by atom-tier (substrate / glue / application)
- Slice 1: f=1.0 only (full corpus — trivially stratified since all tasks included)
- Slice 2: f ∈ {0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0} with per-tier stratification

---

## Score Interpretation at f=1.0 (Slice 1)

The f=1.0 result is the **synthetic ceiling** — the upper bound on what the hook can
save at 100% corpus utilization. This number will not improve in production; production
B8 numbers can only be equal to or worse than the synthetic ceiling.

| Synthetic ceiling savings % | Interpretation |
|------------------------------|----------------|
| ≥ 80% | PASS — ceiling is viable; production worth pursuing |
| 50% – 79% | WARN — ceiling is marginal; investigate corpus composition |
| < 50% | KILL — ceiling too low; architecture needs replanning |

---

## D1 Gate Clarification

Issue #192 says "gated only on D1". D1 was decided NOT-shipping per #150's closing
comments — single-vector + BGE + D3 strictness fix meets all quality targets.

This benchmark uses the **shipped single-vector schema** (the registry's actual current
state). The benchmark measures the hook's scaling characteristics, which is independent
of whether D1 ships.
