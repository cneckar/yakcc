# B5 — Hallucination Rebound / Multi-Turn Coherence Benchmark

**Issue:** [#189](https://github.com/cneckar/yakcc/issues/189)
**Parent:** WI-BENCHMARK-SUITE (#167)
**Track:** B5 of 8

---

## What it measures

B5 verifies that yakcc's hook interception does not break the LLM's coherence across multi-turn conversations. When the hook substitutes a content-addressed atom reference (yakcc:hash) in place of the atom's full implementation body, the LLM must be able to reason about that atom in subsequent turns without:
- Re-emitting the atom body verbatim (score 1, failure mode: `re-emission`)
- Hallucinating atom semantics that contradict the registry (score 2, failure mode: `hallucinated`)
- Treating the atom hash as an opaque token with no semantic use (score 3, failure mode: `opaque-hash`)
- Losing conversation context entirely (score 0, failure mode: `context-collapse`)

---

## Three-Slice Plan

### Slice 1 (this slice) — Scaffolding + offline classifier

**Goal:** Build the infrastructure that Slices 2 and 3 plug into.

**What's implemented:**
- `RUBRIC.md` — authoritative scoring spec (0–5 per turn, 4 failure modes, pass/KILL bars)
- `conversations.jsonl` — N=10 adversarial conversation seeds, 2 per shape category
- `harness/run-conversation.mjs` — runs hook-enabled and hook-disabled arms using offline simulation (no real LLM)
- `rubric-eval.mjs` — programmatic offline classifier implementing the rubric mechanically
- `corpus-spec.json` — SHA-256 fingerprint of the conversation corpus

**Slice 1 uses `assistant_emission_target` fields as simulated LLM output.** No real LLM API is called.

**Slice 1's scores are NOT the verdict.** They verify the infrastructure produces non-trivial output and the classifier logic is correct.

### Slice 2 — LLM-judge integration + N=50 corpus

**Goal:** Replace offline simulation with real LLM emission; add LLM-as-judge for ambiguous cases.

**What gets added:**
- Real LLM API integration (Anthropic Claude) replacing `assistant_emission_target` simulation
- LLM-as-judge for score-4 (minor-slip) and score-2 (hallucinated) cases where the programmatic classifier is unreliable
- Corpus expansion to N=50 conversations (5 per category × 5 categories × 2)

**Out of scope for Slice 2:**
- Human rater integration (Slice 3 or separate WI)
- Cross-vendor coherence (out of B5 entirely per #167 DQ-8)

### Slice 3 — Cross-arm blind verdict

**Goal:** Produce the final B5 verdict against the pass/KILL bars.

**What gets added:**
- Full blind verdict: final comparison of hook-enabled vs hook-disabled arms
- Final decision annotation `@decision DEC-BENCH-B5-001` per #189 acceptance criteria
- Post result as comment on #189

---

## How to run

### Prerequisites

```bash
pnpm install
pnpm build
```

### Slice 1 (offline — no LLM needed)

```bash
pnpm bench:coherence:slice1
```

Or manually:
```bash
node bench/B5-coherence/harness/run-conversation.mjs
node bench/B5-coherence/rubric-eval.mjs
```

**Output:**
- `tmp/B5-coherence/transcripts/conv-<id>-arm-{A,B}.jsonl` — per-arm transcripts (gitignored)
- `tmp/B5-coherence/arm-mapping.json` — which arm letter = which condition (gitignored)
- `tmp/B5-coherence/slice1-scores.json` — aggregate scores (committed as decision input)

---

## Methodology tradeoffs

### Offline classifier vs LLM-as-judge vs human rater

| Approach | Precision | Speed | Cost | Used in |
|----------|-----------|-------|------|---------|
| Programmatic classifier | Low-medium (pattern matching) | Instant | Zero | Slice 1 |
| LLM-as-judge | Medium-high (reasoning about code) | Minutes | API cost | Slice 2 |
| Human rater | High (ground truth) | Weeks | High | Slice 3 or separate WI |

The programmatic classifier is the foundation layer. Its known limitations:
- Score 4 (minor-slip): heuristic parameter ordering detection is weak. LLM-judge is authoritative.
- Score 2 (hallucinated): prose contradiction detection misses subtle cases. LLM-judge is authoritative.
- Score 0 (catastrophic): catches vacuous outputs; misses subtle derailments. LLM-judge supplements.

The classifier's value: it runs instantly, catches re-emission (score 1) and opaque-hash (score 3) reliably since these are structural properties, and provides the infrastructure harness that all higher-level evaluation layers plug into.

### Blind-eval discipline

Arm letters (A/B) are randomized per run. `arm-mapping.json` records which letter = which condition but is written AFTER transcripts are produced. Evaluators (LLM-judge or human) read only the transcript files — not the mapping.

The programmatic classifier is structurally blind: it scores by pattern matching on content without knowing the arm condition.

### Sample size

Slice 1: N=10 (calibration). Slice 2: N=50 (per #189 spec). The pass/KILL bars are designed for N=50. Slice 1 scores on N=10 are indicative only.

---

## Reproducibility

```bash
# Clean clone:
git clone https://github.com/cneckar/yakcc
cd yakcc
pnpm install
pnpm build
pnpm bench:coherence:slice1
```

The harness and classifier are fully deterministic given the same `conversations.jsonl`. The SHA-256 of the corpus is recorded in `corpus-spec.json`.

Arm assignment is randomized per run (for blind-eval discipline). The scores within each arm are deterministic.

---

## Falsifiability statement

B5 CAN return KILL. The KILL criterion is explicit and binary:
- Mean coherence < 2.5 on the hook-enabled arm, OR
- Catastrophic failures > 15% of scored turns

If KILL triggers, the conclusion is: **atom references break LLM context; the hook cannot ship in its current form**. This would trigger redesign of the contract-surfacing mechanism (D-HOOK-4).

The Slice 1 offline classifier will generally NOT trigger KILL on the `assistant_emission_target` seeds because those seeds were authored to represent correct behavior. Slice 2 with real LLM emission is where divergence from the expected behavior can surface a genuine KILL.

---

## Pass/KILL bars (from #189)

| Metric | Pass | KILL |
|--------|------|------|
| Mean coherence score | ≥ 4.0 | < 2.5 |
| Subsequent-turn coherence rate (score ≥ 4) | ≥ 90% | — |
| Catastrophic failures (score 0–1) | ≤ 5% of turns | > 15% |

KILL triggers on **either** condition: mean < 2.5 **OR** catastrophic > 15%.

---

## Authoritative scoring spec

See [`RUBRIC.md`](./RUBRIC.md) for the complete rubric, failure mode definitions, and blind-eval discipline notes.
