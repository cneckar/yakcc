# B5 Coherence Rubric

**Issue:** [#189](https://github.com/cneckar/yakcc/issues/189)
**Benchmark:** B5 — Hallucination Rebound / Multi-Turn Coherence
**Authoritative version:** This file is the single source of truth for B5 scoring.

---

## Overview

B5 measures whether yakcc's hook interception preserves LLM coherence across multi-turn conversations. When the hook substitutes an atom reference (yakcc:hash) in place of the atom's full body, the LLM must be able to reason about that atom in subsequent turns without re-emitting the body, hallucinating its semantics, or losing context entirely.

The rubric applies **per turn beyond turn 1**. Turn 1 is always the user's first request and has no prior atom references to reason about — it cannot produce a coherence failure.

---

## Scoring Scale (0–5)

### Score 5 — Correct

**Definition:** The assistant correctly references a prior atom and reasons about it using its actual semantics without re-emitting the body.

**Detection rule (programmatic classifier):**
- The assistant emission references the atom by its substituted form: either the atom's function name (e.g. `parseIntList`) OR a yakcc:hash reference (e.g. `yakcc:abc123de`).
- The emission does NOT re-emit the atom's body (i.e., the complete implementation source of the atom is not present verbatim in the emission).
- The semantic reference is consistent with the atom's actual contract (no contradiction of input/output types).

**Example:** After hook substitutes `parseIntList` in turn 2, turn 3 says "now add error handling to `parseIntList`" — assistant responds "I'll add a try/catch around the `parseIntList` call" without pasting the full implementation.

---

### Score 4 — Minor Slip

**Definition:** The assistant references prior atom(s) but makes a minor reasoning error that does not constitute hallucination of semantics.

**Detection rule (programmatic classifier):**
- Atom is referenced by name or hash (not re-emitted).
- One of the following minor slip indicators is present:
  - Parameter ordering stated incorrectly (e.g., describes `fn(b, a)` when contract says `fn(a, b)`).
  - Incorrect return type stated in prose, but the code usage is correct.
  - Refers to the atom by an alternate name (aliasing), identifiable as the same atom.

**Example:** "I'll pass the delimiter first, then the string to `parseIntList`" (transposed args) while actual call site is correct.

**Note:** The programmatic classifier approximates minor slips via parameter-order mismatch detection. The LLM-judge in Slice 2 is the authoritative scorer for score-4 cases.

---

### Score 3 — Opaque Hash

**Definition:** The atom's hash or import reference is present in the emission, but the assistant treats it as an opaque identifier without demonstrating semantic understanding.

**Failure mode tag:** `opaque-hash`

**Detection rule (programmatic classifier):**
- The atom's hash or import path (`@yakcc/atoms/<name>`) is present verbatim in the emission.
- No semantic statement about the atom is present in the surrounding prose (the LLM is echoing the hash without using it).
- Indicator: the emission is structurally a "pass-through" — hash present, no reasoning about the atom's contract.

**Scoring boundary:** Score 3 is better than score 2 (the hash is at least present and the atom is not hallucinated), but worse than score 4 (the LLM is not demonstrating understanding).

---

### Score 2 — Hallucinated Semantics

**Definition:** The assistant claims the atom does something inconsistent with its registered contract.

**Failure mode tag:** `hallucinated`

**Detection rule (programmatic classifier):**
- The atom is referenced by name.
- The emission makes a specific behavioral claim about the atom (e.g., "returns a string" or "takes a delimiter argument") that directly contradicts the atom's `SpecYak.behavior`, `SpecYak.inputs`, or `SpecYak.outputs` in the registry.
- Detection: compare the emission's stated claim against the atom's registered spec fields. A contradiction on type or behavior is a hallucination.

**Example:** Atom's spec says `parseIntList(input: string): number[]`. LLM says "parseIntList accepts a delimiter and a string" — contradicts the spec which has one input parameter.

---

### Score 1 — Re-emission

**Definition:** The assistant re-emits the atom's body verbatim rather than referencing the atom by name/hash.

**Failure mode tag:** `re-emission`

**Detection rule (programmatic classifier):**
- The atom's complete `implSource` (or a substring thereof ≥ 50 characters, normalizing whitespace) is present verbatim in the assistant's emission.
- The emission effectively re-implements the atom rather than importing or referencing it.

**Byte-comparison approach:** Normalize both the emission and the atom's `implSource` by collapsing whitespace sequences to single spaces. If the normalized atom body appears in the normalized emission, classify as re-emission.

**Note:** Re-emission in turn 2 (immediately after the atom is first introduced) is less concerning than re-emission in turn 4 (three turns after introduction). The harness records the turn index for this reason.

---

### Score 0 — Catastrophic

**Definition:** The entire conversation turn is incoherent — the assistant output is off-topic, contradicts itself, or bears no meaningful relationship to the conversation context.

**Failure mode tag:** `context-collapse`

**Detection rule (programmatic classifier):**
- The emission has a length below 10 characters (vacuous output), OR
- The emission contains no reference to any conversation topic (no atom names, no code constructs, no semantic continuity with prior turns), OR
- The emission directly contradicts a prior turn's factual statement (self-contradiction within the same conversation).

**Note:** The programmatic classifier has low precision for score 0 — it catches vacuous outputs and obvious contradictions. The LLM-judge in Slice 2 is authoritative for borderline cases.

---

## Failure Mode Definitions

Four categorical failure modes are tracked independently of per-turn scores:

### `opaque-hash`
The LLM treats a yakcc atom reference as an opaque token (the hash is present but unused semantically). Score 3 turns are classified here. Indicates the hook's contract comment (D-HOOK-4) is insufficient — the LLM cannot infer the atom's semantics from the substitution context alone.

### `hallucinated`
The LLM invents atom semantics that contradict the registered spec. Score 2 turns are classified here. Indicates the LLM is not grounding its reasoning in the atom's contract — a contract-surfacing failure. B5 KILL criterion applies if this failure mode exceeds thresholds.

### `re-emission`
The LLM re-emits the atom's body verbatim. Score 1 turns are classified here. Indicates the hook's substitution is not "sticking" — the LLM ignores the reference and regenerates from its training context. Most serious coherence failure short of catastrophic.

### `context-collapse`
The conversation derails entirely. Score 0 turns are classified here. Indicates a fundamental incompatibility between the hook's interception and the LLM's conversation state.

---

## Pass/KILL Bars (from #189)

| Metric | Pass | KILL |
|--------|------|------|
| Mean coherence score | ≥ 4.0 | < 2.5 |
| Subsequent-turn coherence rate (score ≥ 4) | ≥ 90% | — |
| Catastrophic failures (score 0–1) | ≤ 5% of turns | > 15% |

KILL triggers on **either** condition: mean < 2.5 **OR** catastrophic > 15%.

**KILL meaning:** atom references break LLM context; cannot ship hook in current shape. Triggers redesign of hook contract-surfacing mechanism (D-HOOK-4).

---

## Blind-Eval Discipline

The rater (human or LLM-judge) must not know which arm they are evaluating:

1. **Transcript anonymization:** Transcripts written to `tmp/B5-coherence/transcripts/` are named `conv-<id>-arm-A.jsonl` and `conv-<id>-arm-B.jsonl`. The arm letter does NOT correspond to hook-enabled vs hook-disabled in a fixed way — the harness randomizes assignment per run.
2. **Arm-to-condition mapping:** Stored in `tmp/B5-coherence/arm-mapping.json`, written AFTER transcripts are anonymized. The rubric evaluator reads only the transcripts; the verdict script reads `arm-mapping.json` only after all scores are collected.
3. **Programmatic classifier:** The offline classifier (Slice 1) is structurally blind — it scores by pattern matching, not by knowing which arm produced the transcript.
4. **LLM-judge (Slice 2):** The judge prompt omits all yakcc-specific framing. It sees "assistant turn N" without knowing whether the hook was active.

---

## Scope Notes

- Per-turn scoring applies to turns beyond turn 1 (turn index ≥ 1 in zero-indexed conversations).
- Turn 1 of each conversation is always user-initiated; the assistant's turn-1 response is scored as it introduces atoms for the first time (score 5 = clean introduction, no prior atom to mishandle).
- Minimum scoreable turns per conversation: N=2 turns (one user + one assistant beyond the opening).
- Conversations with only 1 assistant turn are excluded from the mean coherence calculation.
