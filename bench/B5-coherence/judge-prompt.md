# B5 Coherence Benchmark — LLM Judge Prompt (Frozen)

> **FROZEN TEMPLATE** — Do not modify this file without updating DEC-BENCH-B5-SLICE2-001.
> Changes invalidate comparability across runs. See rubric-eval.mjs for versioning.

---

## Task

You are an impartial judge evaluating the **coherence quality** of an AI assistant's response in a multi-turn conversation about a TypeScript/WASM code compilation system.

The conversation involves a yakcc (Yet Another Kotlin Compiler Companion) atom registry system. In this system:
- **Atoms** are named, content-addressed code units stored in a registry
- The hook system may substitute an atom's full implementation body with a content-addressed reference like `yakcc:xxxxxxxx` or an import like `import { atomName } from "@yakcc/atoms/atomName"`
- A coherent response **references the atom by name**, **uses it semantically** (imports, calls, or discusses it), and does **NOT re-emit the full implementation body verbatim**

You are scoring **{{ARM_LABEL}}** (blind evaluation — you do not know which arm uses the hook).

---

## Conversation Details

- **Category:** {{CATEGORY}}
- **Expected atoms referenced:** {{ATOM_NAMES}}
- **Turn under review:** Turn {{TURN_INDEX}} (the final assistant turn in the transcript below)

---

## Rubric

Score the assistant's **Turn {{TURN_INDEX}}** response on a 0–5 scale:

| Score | Name | Criteria |
|-------|------|----------|
| 5 | Correct | Atom referenced by name and used semantically; body NOT re-emitted; no hallucination |
| 4 | Minor slip | Atom referenced, but minor issue (parameter ordering, minor semantic imprecision) |
| 3 | Opaque hash | Atom hash/import present but no semantic engagement (treated as black box) |
| 2 | Hallucinated | Atom referenced but semantics contradict the established contract |
| 1 | Re-emission | Atom implementation body re-emitted verbatim (50+ normalized chars) |
| 0 | Catastrophic | Response is vacuous, off-topic, or context is entirely lost |

**Tier-1 classifier assessment** (for your reference — you may agree or disagree):
- Tier-1 score: **{{TIER1_SCORE}}**
- Tier-1 failure mode: **{{TIER1_FAILURE_MODE}}**
- Tier-1 rationale: *{{TIER1_DETAILS}}*

The Tier-1 classifier is reliable for score 1 (re-emission) and score 3 (opaque-hash), but unreliable for score 2 (hallucinated) and score 4 (minor-slip). You are being asked because the Tier-1 score is in that ambiguous range.

---

## Transcript

{{TRANSCRIPT}}

---

## Instructions

1. Read the full transcript above carefully.
2. Focus on **Turn {{TURN_INDEX}}** (the last assistant turn).
3. Assess: does the assistant correctly understand and use the atoms established in prior turns?
4. Score using the rubric above.
5. Output your verdict as a JSON block in this exact format:

```json
{
  "score": <integer 0-5>,
  "failureMode": <"re-emission" | "hallucinated" | "opaque-hash" | "context-collapse" | null>,
  "confidence": <"high" | "medium" | "low">,
  "rationale": "<1-3 sentences explaining your score>"
}
```

**Important:**
- `failureMode` must be `null` for scores 4 and 5
- `failureMode` must be one of the four failure modes for scores 0–3
- `confidence` reflects how certain you are; use "low" if the transcript is ambiguous
- Your `rationale` must cite specific evidence from Turn {{TURN_INDEX}}
- Do NOT let knowledge of yakcc architecture bias you — score only what is in the transcript
