# B5 — Hallucination Rebound / Multi-Turn Coherence Benchmark

<!--
@decision DEC-V0-BENCH-SLICE3-RELABEL-001
@title B5-coherence pass-bars are directional targets only pre-characterisation-data
@status accepted
@rationale Per WI-BENCHMARK-SUITE-CHARACTERISATION-PASS, pass-bars are directional targets only pre-characterisation-data.
-->

> **Note (WI-BENCHMARK-SUITE-CHARACTERISATION-PASS / PR #448):** This bench is part of the `WI-BENCHMARK-SUITE-CHARACTERISATION-PASS` initiative (PR #448). Pass-bars are directional targets only; no measurement triggers a project-level KILL pre-data. Pass-bar revision happens after the characterisation distributions are in.

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
- `RUBRIC.md` — authoritative scoring spec (0–5 per turn, 4 failure modes, pass/directional-target bars)
- `conversations.jsonl` — N=10 adversarial conversation seeds, 2 per shape category
- `harness/run-conversation.mjs` — runs hook-enabled and hook-disabled arms using offline simulation (no real LLM)
- `rubric-eval.mjs` — programmatic offline classifier implementing the rubric mechanically
- `corpus-spec.json` — SHA-256 fingerprint of the conversation corpus

**Slice 1 uses `assistant_emission_target` fields as simulated LLM output.** No real LLM API is called.

**Slice 1's scores are NOT the verdict.** They verify the infrastructure produces non-trivial output and the classifier logic is correct.

### Slice 2 (this slice) — LLM-judge + N=50 corpus

**Goal:** Add LLM-as-judge for ambiguous Tier-1 cases; expand corpus to N=50.

**What's implemented:**
- `conversations.jsonl` — expanded from N=10 to N=50 (5 categories x 10 seeds each; new seeds conv-iter-003..010, conv-xref-003..010, conv-debug-003..010, conv-refactor-003..010, conv-compose-003..010)
- `llm-judge.mjs` — Tier-2 LLM judge (claude-opus-4-7, temperature 0, exponential backoff). Gated on `ANTHROPIC_API_KEY`; returns `{ status: "skipped_no_api_key" }` when absent.
- `judge-prompt.md` — frozen judge prompt template (do not modify without updating DEC-BENCH-B5-SLICE2-001)
- `rubric-eval.mjs` — updated for Tier-1+Tier-2 flow; emits `tmp/B5-coherence/slice2-scores.json`
- `corpus-spec.json` — updated SHA-256 for N=50 corpus (`e25d3e259110c6dd34dfccde111ae7a3b14a7f4285e00a96b7c2cdc57dcba799`)
- `package.json` (bench-local) — `@anthropic-ai/sdk` as bench-local dep (NOT in root package.json)

**Blind discipline:** Judge receives only arm_A/arm_B labels; never hook-enabled/hook-disabled.

**Tier-2 invocation criteria:** Tier-1 score 2 (hallucinated) or score 4 (minor-slip) only.

**Baseline artifact:** `tmp/B5-coherence/slice2-scores.json` — offline run with `judge_status: "skipped_no_api_key"`. Hook-enabled arm mean=4.506, 156 turns scored, N=50 corpus.

**Out of scope for Slice 2:**
- Real LLM emission (still uses `assistant_emission_target` simulation from Slice 1)
- Cross-arm blind verdict (Slice 3)
- Human rater integration (Slice 3 or separate WI)

### Slice 3 — Cross-arm blind verdict

**Goal:** Produce the final B5 verdict against the pass/directional-target bars.

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


### Slice 2 (offline baseline — no LLM judge needed)

```bash
pnpm bench:coherence:slice2
```

Or manually:
```bash
node bench/B5-coherence/harness/run-conversation.mjs
node bench/B5-coherence/rubric-eval.mjs
```

**Output:**
- `tmp/B5-coherence/transcripts/conv-<id>-arm-{A,B}.jsonl` — per-arm transcripts (gitignored)
- `tmp/B5-coherence/arm-mapping.json` — which arm letter = which condition (gitignored)
- `tmp/B5-coherence/slice2-scores.json` — aggregate scores with `judge_status: "skipped_no_api_key"` when key absent

### Slice 2 (with LLM judge)

Set `ANTHROPIC_API_KEY` then run:

```bash
ANTHROPIC_API_KEY=sk-ant-... pnpm bench:coherence:slice2
```

First install bench-local deps (once):
```bash
pnpm --dir bench/B5-coherence install
```

**Output:** `tmp/B5-coherence/slice2-scores.json` with `judge_status: "judged"` and per-turn `tier2_used` flags.

------

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

Slice 1: N=10 (calibration). Slice 2: N=50 (per #189 spec). The pass/directional-target bars are designed for N=50. Slice 1 scores on N=10 are indicative only.

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

B5 has explicit directional failure criteria (no KILL pre-data). The criteria are:
- Mean coherence < 2.5 on the hook-enabled arm, OR
- Catastrophic failures > 15% of scored turns

If these criteria trigger post-characterisation, the conclusion is: **atom references break LLM context; the hook cannot ship in its current form**. This would trigger redesign of the contract-surfacing mechanism (D-HOOK-4).

The Slice 1 offline classifier will generally NOT reach these thresholds on the `assistant_emission_target` seeds because those seeds were authored to represent correct behavior. Slice 2 with real LLM emission is where divergence from the expected behavior can surface genuine threshold violations.

---

## Pass / Directional Target Bars (from #189)

| Metric | Pass | Directional target (no KILL pre-data) |
|--------|------|--------------------------------------|
| Mean coherence score | ≥ 4.0 | < 2.5 |
| Subsequent-turn coherence rate (score ≥ 4) | ≥ 90% | — |
| Catastrophic failures (score 0–1) | ≤ 5% of turns | > 15% |

Directional target triggers on **either** condition: mean < 2.5 **OR** catastrophic > 15%. No measurement triggers a project-level KILL pre-characterisation-data.

---

## Authoritative scoring spec

See [`RUBRIC.md`](./RUBRIC.md) for the complete rubric, failure mode definitions, and blind-eval discipline notes.
