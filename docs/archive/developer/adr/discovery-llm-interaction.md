# DEC-V3-DISCOVERY-D4-001 — LLM-facing interaction design

**Status:** Accepted (D4 design phase; implementation deferred to v3 implementation initiative)
**Date:** 2026-05-10
**Issue:** https://github.com/cneckar/yakcc/issues/154
**Initiative:** WI-V3-DISCOVERY-SYSTEM (D4 of 6)

---

## Context

D1 (`docs/archive/developer/adr/discovery-multi-dim-embeddings.md`, `DEC-V3-DISCOVERY-D1-001`) established the
multi-dimensional storage schema: 5 `FLOAT[384]` columns in a `sqlite-vec` `vec0` virtual table
(`contract_embeddings`), one per SpecYak semantic axis (`embedding_behavior`,
`embedding_guarantees`, `embedding_error_conditions`, `embedding_non_functional`,
`embedding_property_tests`). D1 committed the absent-dimension rule: a missing SpecYak source
field yields a zero vector; query-time must skip zero-vector dimensions.

D2 (`docs/archive/developer/adr/discovery-query-language.md`, `DEC-V3-DISCOVERY-D2-001`) established the
LLM-facing query surface: `QueryIntentCard` with freeform per-dimension texts, per-dimension
`weights`, and `topK` (default 10). D2 committed the `Candidate` result type carrying
`perDimensionScores: PerDimensionScores` and `combinedScore: number` in [0, 1], the auto-accept
threshold (top-1 `combinedScore > 0.85` AND gap-to-top-2 > 0.15), and the programmatic API
(`Registry.findCandidatesByQuery`). D2 deferred the LLM tool call shape and the interaction
protocol to D4.

D3 (`docs/archive/developer/adr/discovery-ranking.md`, `DEC-V3-DISCOVERY-D3-001`) established the ranking
algorithm: per-dimension weighted cosine renormalized over the surviving non-null dimension set,
a 5-stage pipeline (vector KNN → structural filter → strictness filter → reserved Stage 4 →
final ranking + tiebreaker), the tiebreaker hierarchy (property-test depth → usage history →
test history → atom age → lex `BlockMerkleRoot`; ε = 0.02), and the `CandidateNearMiss` shape
(`failedAtLayer: 'structural' | 'strictness' | 'property_test' | 'min_score'`). D3 committed the
score bands (≥ 0.85 strong, 0.70–0.85 confident, 0.50–0.70 weak, < 0.50 poor).

D4 (this ADR) establishes how the LLM interacts with the discovery system: the tool call shape
the LLM sees, the evidence rendering contract for each candidate, the 4-band protocol for
handling score bands, the verbatim system-prompt text, the confidence calibration mechanism, the
three pinned failure-mode response shapes, and the D5 boundary. No source files are modified by
this ADR.

---

## Boundary with D1 + D2 + D3

| Domain | Authority | ADR |
|---|---|---|
| Storage schema (5 columns, model, zero-vector rule, migration 7) | D1 | `docs/archive/developer/adr/discovery-multi-dim-embeddings.md` |
| Query surface (QueryIntentCard, Candidate shape, CLI flags, auto-accept thresholds, cross-provider invariant) | D2 | `docs/archive/developer/adr/discovery-query-language.md` |
| Ranking formula, aggregation strategy, pipeline, tiebreakers, score normalization, negative-space behavior | D3 | `docs/archive/developer/adr/discovery-ranking.md` |
| Tool call shape, evidence rendering contract, 4-band protocol, system-prompt text, confidence calibration, failure-mode shapes, D5 boundary | D4 (this ADR) | `docs/archive/developer/adr/discovery-llm-interaction.md` |

Neither D1, D2, nor D3 is modified by D4. If a future WI touches more than one of these authority
domains, all owning ADRs must be revised.

---

## Decision

### Q1: Tool call shape — single `yakcc_resolve` in v1

**Decision:** Ship a single-call primary tool definition only in v1. Defer the multi-step
(`yakcc_search` / `yakcc_inspect` / `yakcc_select`) protocol to a v3.1 D4-revision WI.

**Concretely:**
- The v1 tool definition the LLM caller sees is **one** function: `yakcc_resolve(query: QueryIntentCard) → QueryResult`.
- `QueryIntentCard` is the D2 type, used verbatim. No D4-specific schema variant.
- `QueryResult` is whatever D3's `findCandidatesByQuery` returns plus the `near_misses` array
  (D3 §Q6) and the `status` field committed by Q3 of this ADR.
- No `high-K` two-tool variant in v1. The single call returns up to `topK` candidates with the
  per-candidate evidence projection from Q2 below.

**Why single only:**
- Two MCP tool definitions for the same retrieval domain doubles the LLM-side prompt surface
  (the LLM must learn when to use which) for unmeasured benefit.
- The "high-K" cutoff has no empirical floor yet — picking a number now (5? 10? 20?) commits the
  design to a guess. D5 will surface the data.
- D2's `topK` default of 10 + ~80 token-per-candidate evidence (Q2) yields ~800-token responses,
  well within current LLM context budgets.

**Revisit trigger (v3.1):** D5 reports either (a) median response token count exceeds 2,000
tokens AND callers regularly request `topK` > 20, or (b) measured per-candidate inspection token
cost during refinement is materially higher than upfront full-list response cost. Either trigger
justifies adding the multi-step protocol as a secondary surface.

The multi-step alternative is documented fully in the Alternatives section (rejected for v1) and
the When to revisit section (named trigger), but its exact tool shape belongs to the v3.1
D4-revision WI.

---

### Q2: Evidence response format — fixed projection of D2's `Candidate`

**Decision:** Pin a fixed projection of D2's `Candidate` rendered per-candidate. The ~80-token-
per-candidate target from issue #154 is the design target; the field set and order are locked.

**Per-candidate rendering template (field order is part of the contract):**

```
Candidate {N} of {K}
  Address:        {BlockMerkleRoot, abbreviated to first 16 hex chars + "..."}
  Behavior:       {spec.behavior, single line, no truncation in v1}
  Inputs:         {spec.signature.inputs, comma-separated "name: type" pairs}
  Outputs:        {spec.signature.outputs, comma-separated "name: type" pairs}
  Score:          {combinedScore.toFixed(2)} ({band: "strong" | "confident" | "weak" | "poor"})
  Per-dim:        {comma-separated per-dim scores, only for dims present in PerDimensionScores; e.g. "behavior=0.91, guarantees=0.88"}
  Key guarantees: {first 3 spec.guarantees[*].description joined with ", "}
  Property tests: {spec.propertyTests.length} ({passing test_history count})
  Used by:        {runtime_exposure.requests_seen}
```

**Rendering contract:**
- One blank line between candidates.
- `Per-dim:` line is omitted when only one dimension was queried (redundant with `Score`).
- Fields whose source is empty or null are omitted entirely (no `Key guarantees: (none)` lines).
- Field names are spelled exactly as above (case-sensitive); the LLM keys off these in parsing.

**For near-misses:** The same template plus a header line `[NEAR-MISS — failed at: {failedAtLayer}]`
and a `Reason:` line containing `failureReason` from D3 §Q6's `CandidateNearMiss`.

**Why this projection:**
- Each field is a direct projection of an existing field on D2's `Candidate` or D3's
  `CandidateNearMiss` — no new shape, no parallel structure.
- ~80 tokens/candidate at K=10 = ~800 tokens for a full response, fitting comfortably in any
  modern LLM context.
- The field order (address → behavior → signature → score → guarantees → tests → usage) matches
  the LLM's decision flow: "what is this thing → does it do what I want → does it match my types
  → how good is the match → what does it promise → has it been tested → is it used."

**Revisit trigger:** D5 reports the field set is over- or under-specified for actual LLM decision
quality.

**Implementation note:** This template is documented here as a **contract**, not implemented
here. Implementation belongs to `WI-V3-DISCOVERY-IMPL-CLI` (CLI human-readable mode) and the
implementation WI for the MCP tool surface (TBD).

---

### Q3: Iterative refinement protocol — 4-band + explicit `no_match`

**Decision:** Use D3's score bands directly. Pin an explicit `no_match` signal for the < 0.5
case so the caller can react. Add `status: "matched" | "weak_only" | "no_match"` to the
`QueryResult` envelope.

**The 4-band protocol (mapped to D3 bands):**

| Top score | D3 band | LLM behavior |
|---|---|---|
| ≥ 0.85 AND gap-to-top-2 > 0.15 | Strong + auto-accept | Insert `BlockMerkleRoot` reference into project manifest. No user prompt. |
| ≥ 0.85 AND gap ≤ 0.15 | Strong but ambiguous | Surface top-1 + top-2 with their differential evidence; ask user. |
| 0.70 – 0.85 | Confident | Surface top candidate to user with "this looks like a fit, here's why, here's the alternative." |
| 0.50 – 0.70 | Weak | Show user the candidate; they decide whether to use or write glue. |
| < 0.50 | Poor | Emit `no_match` signal; do NOT silently fall through to writing the code. |

**The `no_match` status field:**

- When the top combined score is < 0.5 AND there are no surviving filter-stage candidates
  (`candidates` is empty AND all entries are `near_misses`): `QueryResult.status = "no_match"`.
- When the top combined score is < 0.5 BUT some candidates survived all filter stages (rare;
  "everything is weakly relevant"): `QueryResult.status = "weak_only"`.
- Otherwise: `QueryResult.status = "matched"`.

`QueryResult.status` is computed at query time from the Stage 5 output. The LLM keys its
prompt-driven behavior off this field.

**On `no_match`, the LLM's prescribed reaction (per Q4 system-prompt text):**
- Do NOT silently fall through to writing the code.
- Instead, choose between two paths and explicitly state the choice:
  1. **Widen and retry** — drop or relax a `signature`/`nonFunctional` constraint; re-issue
     `yakcc_resolve`. Use the `near_misses[*].failedAtLayer` annotations from D3 §Q6 to choose
     which constraint to relax.
  2. **Author and file a new atom** — emit a `NEW_ATOM_PROPOSAL` block in the LLM output for
     the user.

**Why explicit `no_match`:** "Silent fall-through to writing the code" makes the registry
invisible to the user when the registry has a real gap. The user never learns "this capability is
missing" — they just see code. The `no_match` signal forces the LLM to surface the gap, which
is the only way the registry's coverage gets better over time.

**Revisit trigger:** D5 reports that LLMs comply with the `no_match` protocol < 80% of the time
across N sessions, suggesting the system-prompt wording is insufficiently directive. In that
case, Q4 system-prompt revision.

**Implementation note:** `status: "matched" | "weak_only" | "no_match"` is added to the
documented result envelope shape in the ADR. The exact field placement on the runtime envelope
is owned by `WI-V3-DISCOVERY-IMPL-QUERY`; D4 commits the semantic.

---

### Q4: System-prompt text — verbatim locked text

**Decision:** Pin the exact verbatim text in this ADR. The text lives in two places: (a) inline
here for design provenance; (b) `docs/system-prompts/yakcc-discovery.md` as a copy-paste-ready
file with this ADR as the stated authority.

**Verbatim system-prompt text (locked; any change requires a D4 ADR revision):**

```
You have access to the yakcc discovery system via the `yakcc_resolve` tool.

When you need to write code that performs a generic operation — parsing,
validating, transforming, computing, formatting, hashing, comparing —
first call `yakcc_resolve` with a structured intent describing what the
code should do.

Build the intent as:

  - behavior: a one-line natural-language description of what the code does.
  - guarantees: an array of specific properties the code must satisfy.
                Be specific. "rejects non-integer values" disambiguates from
                "rejects non-numeric values."
  - signature: input/output types as { name?, type } pairs.
                Names are optional; types are required.
  - errorConditions, propertyTests, nonFunctional: optional dimensions you
                can populate to narrow the search.
  - weights: optional per-dimension floats. Higher = more important. Omit
                for equal weighting.

The system returns up to topK candidate atoms — pre-tested, pre-verified
implementations from the registry. Each candidate carries a combinedScore
in [0, 1] and a band classification:

  - score >= 0.85 (strong):     reference the atom by BlockMerkleRoot.
  - 0.70 - 0.85   (confident):  present to user with "this looks like a fit."
  - 0.50 - 0.70   (weak):       show alternatives; let user decide.
  - score <  0.50 (poor):       result.status will be "no_match". Do NOT
                                silently write the code. Instead, either:
                                  (a) widen the query (relax a constraint
                                      based on near_misses[*].failedAtLayer)
                                      and re-issue, or
                                  (b) emit a NEW_ATOM_PROPOSAL block
                                      describing the gap so the registry
                                      coverage improves.

Auto-accept rule: if combinedScore > 0.85 AND the gap to the second-best
candidate is > 0.15, insert the BlockMerkleRoot reference into the project
manifest without prompting the user.

Reserve hand-written code for project-specific business logic that does
not generalize — the "glue" per the project's content-addressing model.
Generic operations belong in the registry.

If `yakcc_resolve` is unreachable (registry offline, transport error),
fall back to writing the code directly and emit a REGISTRY_UNREACHABLE
note in your output so the user can audit later.
```

**Why this prompt wording:**
- The `no_match` path is spelled out with its two required reactions (widen or propose) because
  omitting prescribed reactions results in LLMs defaulting to the easiest path (writing the code
  directly), defeating the registry's gap-surfacing function.
- The auto-accept rule is explicit (score + gap) so the LLM does not over-auto-accept ambiguous
  strong matches.
- The REGISTRY_UNREACHABLE fallback path is named so every session where the registry is offline
  produces a detectable audit trail.
- The "generic operations belong in the registry" framing establishes the scope boundary at the
  point of use, not in a separate document the LLM cannot see.

**Canonical location:** `docs/system-prompts/yakcc-discovery.md` (new file; first line states
authority; then blank line; then the verbatim block above without surrounding code fences).

**Revisit trigger:** D5 reports that LLMs given this system prompt produce queries with
materially worse hit rates than a hand-tuned prompt. Tighten the wording. Or: a popular LLM
requires structurally different prompt phrasing for tool use; file a per-vendor adaptation as a
separate downstream WI (per #154 Out of scope).

---

### Q5: Confidence calibration — caller-side `ConfidenceMode` enum

**Decision:** Hybrid auto-accept driven by an explicit caller-side signal. The caller (LLM,
with prompt context) sets a per-query `confidenceMode` field. The enum type is:

```typescript
// D4-introduced field on the caller's side.
// Carried as a tool-call argument or as a field on the result-handling envelope.
// EXACT placement (QueryIntentCard field vs separate request field on yakcc_resolve)
// is pinned by the implementation WI; D4 commits the semantic.
type ConfidenceMode =
  | "auto_accept"     // when D2 gate fires, insert without user prompt (for trivial queries)
  | "always_show"     // always surface top candidate to user, even when D2 gate fires
  | "hybrid"          // DEFAULT: auto_accept when gate fires AND top score > 0.92, otherwise always_show
```

**Default: `"hybrid"`.**

**How the mechanism works:**
- D2's auto-accept rule (top-1 `combinedScore > 0.85` AND gap > 0.15) is the **gate**.
- D4 layers a per-query `confidenceMode` that determines what happens *when the gate fires*.
- In `"auto_accept"` mode: auto-accept fires whenever the D2 gate fires.
- In `"always_show"` mode: the D2 gate is ignored; the top candidate is always surfaced to the user.
- In `"hybrid"` mode (default): auto-accept fires only when the gate fires AND `combinedScore > 0.92`.
  The 0.92 threshold is a stricter secondary check — "be confident *and* very confident."

**The "trivial vs non-trivial" judgment is caller-driven, not registry-driven:**
- The LLM has prompt context the registry does not (user's risk tolerance, project domain,
  security sensitivity).
- A trivial query (e.g. `clamp(x, lo, hi)`) → caller sets `confidenceMode: "auto_accept"`.
- A non-trivial query (e.g. password-hashing function) → caller sets `confidenceMode: "always_show"`.
- When uncertain, caller leaves at default `"hybrid"`, which uses score > 0.92 as a proxy for
  "the system itself is confident this is a slam dunk."

**Why caller-side, not derived from IntentCard:**
- D5 cannot empirically calibrate a "trivial" classifier from the IntentCard alone — risk context
  lives in the LLM's prompt, not the query.
- A QueryIntentCard-derived heuristic (e.g. "if `propertyTests` is empty, treat as trivial")
  would silently impose risk policy from the wrong layer.
- Caller-driven is testable: the system-prompt wording can be tuned to teach the LLM when each
  mode is appropriate; D5 measures compliance.

**System-prompt teaching:** The verbatim prompt in Q4 does NOT mention `confidenceMode` directly
in v1 — the `"hybrid"` default is "good enough for most coding LLM use." A v3.1 D4 revision may
add per-mode prompt guidance once D5 data informs when each mode helps.

**Revisit trigger:** D5 reports `"hybrid"` mode default produces > 5% false-accept rate, OR
`"auto_accept"` mode is being used by LLMs in clearly non-trivial contexts (suggests prompt
teaching gap).

**Implementation note:** The exact placement of `confidenceMode` (whether it lives on
`QueryIntentCard` or as a separate `yakcc_resolve` request parameter) is the implementation WI's
call; D4 commits only the type and semantic.

---

### Q6: Failure modes — three pinned response shapes

**Decision:** Three failure modes with pinned response shapes and pinned LLM reactions. All three
shapes are locked by D4; exact field placement on the runtime envelope is owned by the
implementation WI.

#### F1: Registry offline / unreachable

**Detection:** Tool call fails with transport error, timeout, or HTTP 5xx (when federation
surface is reached). Locally: SQLite open fails or the registry handle is unavailable.

**Response shape (caller-visible; this is NOT a `QueryResult`):**

```typescript
type RegistryUnreachable = {
  kind: "registry_unreachable";
  reason: "transport_error" | "timeout" | "registry_unavailable";
  detail: string;       // human-readable; safe to show in LLM logs
};
```

**LLM reaction (taught via the Q4 system prompt):**
- Fall back to writing the code directly.
- Emit `REGISTRY_UNREACHABLE: <reason> (<detail>)` as a marker in LLM output so the user can
  audit later and re-attempt registry lookup when the system is back.

**Revisit trigger:** If federation transports become more diverse (gRPC, WebSocket), the `reason`
enum may need expansion. File a D4 revision at that point.

---

#### F2: Vague IntentCard (insufficient signal to disambiguate)

**Detection:** Stage 5 returns ≥ 5 candidates within ε = 0.02 of the top score (D3 §Q4's tie
window applied to the "many ties" scenario), OR the top score is < 0.5 (the disambiguation case,
not the `no_match` case — these two conditions are mutually exclusive in normal operation but
both can emit `disambiguation_hint`).

**Response shape:** Standard `QueryResult` with a new `disambiguation_hint` field:

```typescript
QueryResult {
  status: "matched" | "weak_only" | "no_match";
  candidates: Candidate[];
  near_misses: CandidateNearMiss[];
  disambiguation_hint?: {
    kind: "vague_intent";
    suggested_dimensions: ("guarantees" | "errorConditions" | "nonFunctional" | "propertyTests" | "signature")[];
    detail: string;  // e.g. "5 candidates within 0.02 of top score; consider adding signature constraints"
  };
}
```

**`suggested_dimensions` selection rule:** The dimensions NOT present in the original
`QueryIntentCard` (the absent dimensions the LLM could populate to narrow the search). Computed
at query time from the `QueryIntentCard`'s surviving-dimension set.

**LLM reaction:** Re-issue `yakcc_resolve` with at least one suggested dimension populated. If
the LLM cannot generate plausible content for any suggested dimension, surface the candidate list
to the user and let them disambiguate.

**Revisit trigger:** D5 reports `disambiguation_hint` is rarely actionable — perhaps
`suggested_dimensions` should be ranked by likely-impact rather than just listed.

---

#### F3: Tied candidates (multiple at same `combinedScore`)

**Detection:** D3 §Q4's tiebreaker chain fires (≥ 2 candidates within ε = 0.02 after Stage 5
ranking).

**Response shape:** Standard `QueryResult.candidates`, but each tied candidate carries an
explicit `tiebreaker_reason` field exposing which D3 §Q4 tiebreaker resolved its position:

```typescript
Candidate {
  // ... existing fields per D2/D3
  tiebreaker_reason?: {
    rank_within_tie: number;           // 1-indexed position within the tie window
    decided_by: "property_test_depth" | "usage_history" | "test_history" | "atom_age" | "lex_block_merkle_root";
    detail: string;  // human-readable; e.g. "ranked above tied peer by usage_history (1,432 vs 891 requests)"
  };
}
```

`tiebreaker_reason` is present only on candidates that are part of a multi-candidate tie window;
single-candidate tie windows and non-tied candidates have it absent.

**LLM reaction:** Surface `tiebreaker_reason.detail` to the user when presenting tied candidates
so the user understands *why* the system preferred one over the other. The LLM does NOT silently
pick the rank-1 within the tie window without showing the rationale, unless
`confidenceMode === "auto_accept"`, in which case auto-accept fires per D2 rules and only the
rank-1 is surfaced.

**Why these three failure modes:**
- F1 protects the project from total registry outages (the build doesn't break; user gets explicit notice).
- F2 turns "I got 30 vaguely-relevant results" from a dead end into actionable refinement guidance.
- F3 makes the tiebreaker chain *visible* — without `tiebreaker_reason`, the LLM looks like it's
  guessing when it picks rank-1 from a tie. Visibility is what lets the user trust the registry.

**Revisit triggers:**
- F1: federation transports diversify (gRPC, WebSocket) — expand `reason` enum.
- F2: D5 reports `disambiguation_hint` is rarely actionable — rank `suggested_dimensions` by
  likely-impact.
- F3: D5 reports that exposing `tiebreaker_reason.detail` confuses users — evaluate an
  abbreviated form.

---

### Q8: Descent-and-Compose Discipline — WI-578 prompt rewrite (2026-05-15)

**Decision:** Rewrite `docs/system-prompts/yakcc-discovery.md` from a polite suggestion into an
imperative descent-and-compose discipline. This is a D4 ADR revision as required by the authority
comment at the top of the prompt file.

**What changed:**

The original Q4 prompt (locked in this ADR) offered soft guidance:

- "first call `yakcc_resolve` with a structured intent"
- "Reserve hand-written code for project-specific business logic"
- "(a) widen the query … and re-issue" on `no_match`

The revised prompt (`docs/system-prompts/yakcc-discovery.md` as of WI-578) replaces that
guidance with imperative rules:

- "You MUST start every search with the most specific intent you can articulate"
- "You MUST NOT widen an intent to make a search hit"
- "There are NO carve-outs"
- A mandatory self-check step before every `yakcc_resolve` call
- Descent-on-miss rule: decompose, query each piece, compose upward
- A verbatim URL-parser walkthrough as the canonical protocol
- Explicit `refuse` instruction for single-word or vague intents

**Why:** GH #578 (label: `load-bearing`) documented that the original prompt produced loose
initial intents in practice — "validation," "parser," "helper" — resulting in oversized atoms
that carry unused capabilities. The soft-suggestion framing allowed LLMs to rationalize skipping
discovery by treating generic operations as "business logic." The imperative rewrite closes that
escape hatch.

**Invariants verified (grep-level, DEC-HOOK-PROMPT-DESCENT-001):**
- `grep -c "You MUST" docs/system-prompts/yakcc-discovery.md` ≥ 4
- `grep -c "You MUST NOT" docs/system-prompts/yakcc-discovery.md` ≥ 1
- `grep -c "NO carve-outs" docs/system-prompts/yakcc-discovery.md` ≥ 1
- `grep -ci "self-check" docs/system-prompts/yakcc-discovery.md` ≥ 1
- `grep -c "URL parser" docs/system-prompts/yakcc-discovery.md` ≥ 1
- `grep -c "You SHOULD consider\|Try to\|When possible\|Reserve hand-written code"` = 0
- `grep -ci "business logic\|one-off\|application-specific"` = 0

**What is NOT changed:** The D4 design decisions Q1–Q7 remain in force. The tool call shape,
evidence rendering contract, 4-band protocol, `status` enum, `ConfidenceMode` type, failure mode
shapes, and D4/D5 boundary are all unchanged. Only the system-prompt text (previously locked
verbatim in Q4) is updated. The Q4 "locked text" section above is now superseded by the revised
file at `docs/system-prompts/yakcc-discovery.md`.

**Rollback:** `git revert` the WI-578 landing commit. The prompt file reverts to its previous
49-line form; behavior reverts to the pre-#578 baseline.

**Issue:** https://github.com/cneckar/yakcc/issues/578
**Decision ID:** DEC-HOOK-PROMPT-DESCENT-001
**Date:** 2026-05-15

---

### Q9: Forceful substitution directive — B4-v5 rerun (2026-05-31)

**Decision:** Replace the weak "Compile and stop" section in
`docs/system-prompts/yakcc-discovery.md` with an imperative substitution directive
that makes the `yakcc_compile` → verbatim-write path unambiguous and frames
re-implementation as a protocol violation.

**What changed:**

The pre-1030 "Compile and stop" section (predating the `yakcc_compile` tool→source
path) gave soft guidance:

- "your final answer for that sub-intent MUST be a single line: `yakcc compile <atom_id>`"
- "Do NOT also write or restate the implementation."

The B4-v5 benchmark rerun identified the failure mode: models were calling
`yakcc_compile` (compile=1 in 5/6 hooked cells) but then re-authoring the full
implementation anyway (`wrote_compiled_source=false` everywhere), producing 3,400–5,100
output tokens of unnecessary re-implementation. The old directive targeted the pre-tool
CLI path and did not address the case where the tool returns a `source` field that the
model should write verbatim.

The revised directive (as of this WI, issue #1030) replaces the weak section with:

1. An explicit 4-step sequence: call `yakcc_compile({ atom_id })` → tool returns
   `source` → write THAT EXACT `source` verbatim using Write/Edit → STOP.
2. A "protocol violation" framing for re-implementation: "Re-implementing what
   `yakcc_compile` already returned is a protocol violation."
3. A correct-flow diagram (`yakcc_resolve → auto_accept → yakcc_compile → Write(verbatim)`).
4. An explicit "Do NOT" list covering the four observed failure patterns.
5. A "stop immediately, delete, substitute" instruction for mid-stream self-correction.

**Empirical evidence:**

With the new directive + `auto_accept` tier firing (the score/confidence band gate) +
the #1028 compile fix (which corrected `atom_id` → correct field in the tool call),
all 6 hooked B4-v5 cells flipped from re-authoring to verbatim substitution
(`wrote_compiled_source=true`). Output token count halved vs the hedge/re-author
baseline. This is the empirical validation that justifies the wording as production
copy rather than a further experimental variant.

**Invariants verified (DEC-BENCH-B4-V5-SUBSTITUTION-DIRECTIVE-001):**
- `grep -c "protocol violation" docs/system-prompts/yakcc-discovery.md` ≥ 1
- `grep -ci "verbatim" docs/system-prompts/yakcc-discovery.md` ≥ 1
- `grep -c "DEC-BENCH-B4-V5-SUBSTITUTION-DIRECTIVE-001" docs/system-prompts/yakcc-discovery.md` ≥ 1
- The `## Compile and stop` section exists exactly once (no duplicate/contradictory section).

**What is NOT changed:** D4 design decisions Q1–Q8 remain in force. The tool call
shape, evidence rendering contract, 4-band protocol, `status` enum, `ConfidenceMode`
type, failure-mode shapes, and D4/D5 boundary are all unchanged. Only the
"Compile and stop" subsection of the system-prompt text is updated.

**Rollback:** `git revert` the WI-1030 landing commit.

**Issue:** https://github.com/cneckar/yakcc/issues/1030
**Decision ID:** DEC-BENCH-B4-V5-SUBSTITUTION-DIRECTIVE-001
**Date:** 2026-05-31

---

### Q10: Compose-by-reference emit path on strong match (2026-06-01)

**Decision:** When `.yakcc/manifest.json` is present at the project root
(indicating the project is wired for `yakcc build`), on `auto_accept` the model
MUST call `yakcc_reference` (not `yakcc_compile`) and write only the returned
`import_line` (~10 tokens). The verbatim `yakcc_compile` path from Q9/#1030
remains valid for projects not wired for compose-by-reference.

**Detection signal:** `.yakcc/manifest.json` presence at project root. This file
is created when the project adopts compose-by-reference (#1044). Its presence is
the unambiguous signal that `yakcc build` is wired and will materialize atom
implementations at build time.

**What changed:**

The Q9 directive (#1030) mandated: `yakcc_resolve → auto_accept →
yakcc_compile → Write(source verbatim)`. The B4-v5 rerun (#1041) proved this
path is token-negative: writing `yakcc_compile`'s returned source (~370 tokens)
equals re-authoring the implementation. The reference-emit path collapses that
to ~10 tokens (the import line alone).

The revised two-branch directive (as of this WI, issue #1048) adds a detection
gate before the Q9 sequence:

1. **Reference path** (`.yakcc/manifest.json` present — preferred, token-savings):
   - Call `yakcc_reference({ atom_id: candidates[0].atom_id })` — NOT `yakcc_compile`.
   - Write the returned `import_line` verbatim to the target file.
   - Append the returned `manifest_entry` to the `references` array in
     `.yakcc/manifest.json`.
   - Write the returned `dts_ref.dts` to `dts_ref.path` (enables typecheck before build).
   - You MUST NOT write the atom's implementation body. `yakcc build` materializes it.

2. **Verbatim path** (`.yakcc/manifest.json` absent — fallback, existing Q9 behaviour):
   - Call `yakcc_compile({ atom_id })` and write the returned `source` verbatim.
   - The Q9 "protocol violation" framing for re-implementation remains fully in force.

**Token rationale (#1041):**
- Verbatim path: ~370 output tokens (the full implementation body).
- Reference path: ~10 output tokens (one import line).
- Savings: ~360 tokens per `auto_accept` hit on a reference-wired project.
- This is the empirical motivation documented in #1041 that justifies the
  reference-emit path as the preferred fork rather than a suggestion.

**Relationship to prior Q-sections:**
- Branches from Q9/#1030: the verbatim `yakcc_compile` directive is preserved
  as the fallback; it is NOT deleted or superseded for non-reference projects.
- Coexists with #1029 (auto_accept tier): the detection gate fires AFTER
  `auto_accept` is confirmed; the `confidence_tier` semantics and score bands
  are unchanged.
- References the `yakcc_reference` MCP tool introduced by #1047
  (DEC-COMPOSE-BY-REF-REFERENCE-TOOL-001).

**Invariants verified (DEC-COMPOSE-BY-REF-REFERENCE-EMIT-001):**
- `grep -c "yakcc_reference" docs/system-prompts/yakcc-discovery.md` ≥ 1
- `grep -c "manifest.json" docs/system-prompts/yakcc-discovery.md` ≥ 1
- `grep -c "import_line" docs/system-prompts/yakcc-discovery.md` ≥ 1
- `grep -c "manifest_entry" docs/system-prompts/yakcc-discovery.md` ≥ 1
- `grep -c "dts_ref" docs/system-prompts/yakcc-discovery.md` ≥ 1
- `grep -c "You MUST NOT write the atom" docs/system-prompts/yakcc-discovery.md` ≥ 1
- The Section B verbatim path (yakcc_compile) still exists exactly once.
- `grep -c "You SHOULD consider\|Try to\|When possible\|Reserve hand-written code"` = 0

**What is NOT changed:** Q1–Q9 substantive decisions remain in force. The
two-branch detection gate does not alter tool-call shape, evidence rendering
contract, 4-band protocol, `status` enum, `ConfidenceMode` type, failure-mode
shapes, or D4/D5 boundary. The Q9 verbatim `yakcc_compile` path is preserved as
the fallback for all non-reference-wired projects.

**Rollback:** `git revert` the WI-1048 landing commit. The prompt file reverts
to the Q9/single-path form; Section A is removed; Section B reverts to the flat
verbatim directive.

**Issue:** https://github.com/cneckar/yakcc/issues/1048
**Decision ID:** DEC-COMPOSE-BY-REF-REFERENCE-EMIT-001
**Date:** 2026-06-01

---

### Q11: Reference-emit output minimization — terse, no model-written .d.ts (2026-06-01)

**Decision:** Revise Section A of `docs/system-prompts/yakcc-discovery.md` so
the model emits ONLY two artifacts on the reference path (import line + manifest
entry), tersely, with no narration. The model MUST NOT write the `.d.ts` file —
`yakcc build` (#1046) generates `.yakcc/atoms/<alias>.d.ts` from the manifest.

**New decision ID:** DEC-COMPOSE-BY-REF-REFERENCE-EMIT-MIN-001
**Issue:** https://github.com/cneckar/yakcc/issues/1062
**Refines:** DEC-COMPOSE-BY-REF-REFERENCE-EMIT-001 (#1048, Q10)
**Date:** 2026-06-01

**Empirical basis — #1061 paid run:**

The #1061 paid run measured reference-mode output at ~430–635 tokens versus the
idealized ~14-token import line, yielding only 1.3–6× collapse rather than the
expected ~30×. Token breakdown:

| component            | tokens (approx) |
|----------------------|-----------------|
| import line          | ~14             |
| manifest entry       | ~40             |
| `.d.ts` content      | ~68             |
| narration/prose      | ~300–500        |
| **total**            | **~430–635**    |

Two defects in the #1048 Section A caused this:

1. **Redundant `.d.ts` write (step 4):** The old Section A instructed the model
   to "Write the returned `dts_ref.dts` to `dts_ref.path` so the import
   typechecks before `yakcc build` runs." But `yakcc build` (#1046) already
   generates `.yakcc/atoms/<alias>.d.ts` from the manifest automatically —
   the model-emitted `.d.ts` was entirely redundant output (~68 tokens).

2. **Narration invited by numbered steps:** The "Step by step — you MUST follow
   all four steps" structure trained the model to narrate each step
   ("I will now complete Step 1… Step 2…"), dominating the output with
   ~300–500 tokens of prose that carried zero semantic value.

**What changed (as of this WI, issue #1062):**

1. The four-step sequence is collapsed to two write operations + an explicit
   stop instruction.
2. The `.d.ts` step is removed entirely. The `dts_ref` field is explicitly
   labelled "for your reference only — do NOT write it; yakcc build generates
   it."
3. A direct terseness directive is added:
   > "Emit ONLY these two artifacts. You MUST NOT narrate the steps, explain
   > what you are doing, or add any prose or commentary — the discovery work
   > is done; output only the import line and the manifest entry. Narration
   > is wasted output."
4. An explicit directive added: "You MUST NOT write the `.d.ts` file. …
   Emitting the `.d.ts` yourself is a protocol violation equivalent to
   emitting the implementation body."

**Token savings (measured — #1061 paid re-run, $0.44, 32 cells, 100% behavioral compliance):**
- Pre-fix reference output: ~430–635 tokens (narration + .d.ts + import + manifest)
- Post-fix reference output: **~139–288 tokens** (Sonnet: 139–170; Haiku: 227–288),
  scaling with atom size
- Measured collapse: **2.7–19.4×** vs pre-fix baseline — large atoms with Sonnet
  reach 19.4× (avl-tree) and 17.1× (dijkstra-heap); Haiku large atoms ~5–12×;
  small atoms (crc32c) ~2.7–3.3×
- The model still emits minor framing prose alongside the manifest entry, so output
  does NOT reach the idealized floor of ~54 tokens (import line ~14 + manifest entry
  ~40). That idealized floor is a structural lower bound, not the achieved result.
- The remaining lever toward the ~30×+ structural target is moving the manifest-entry
  append into the `yakcc_reference` tool itself, so the model writes only the import
  line (~14 tokens). That is deferred to a follow-up WI.

**Relationship to prior Q-sections:**
- Refines Q10/#1048: Section A is updated; Section B (verbatim `yakcc_compile`
  fallback) is fully preserved — untouched.
- Q9/#1030 forceful substitution directive: unchanged and still in force.
- Q8/#578 imperative descent-and-compose discipline: unchanged.
- The `dts_ref` field is still DESCRIBED in the prompt (the model receives it
  from `yakcc_reference`) — only the write instruction is removed.

**Invariants verified (DEC-COMPOSE-BY-REF-REFERENCE-EMIT-MIN-001):**
- `grep -c "MUST NOT write the .d.ts\|do NOT write it\|yakcc build.*generates" docs/system-prompts/yakcc-discovery.md` ≥ 1
- `grep -ci "MUST NOT narrate\|Emit ONLY these\|no narration\|do not narrate" docs/system-prompts/yakcc-discovery.md` ≥ 1
- `grep -c "dts_ref" docs/system-prompts/yakcc-discovery.md` ≥ 1 (field still referenced)
- `grep -c "You MUST NOT write the atom" docs/system-prompts/yakcc-discovery.md` ≥ 1
- Section B verbatim path (`yakcc_compile`) still exists exactly once.
- `grep -c "You SHOULD consider\|Try to\|When possible"` = 0 (no soft phrases)

**What is NOT changed:** Q1–Q10 substantive decisions remain in force. The
tool-call shape, evidence rendering contract, 4-band protocol, `status` enum,
`ConfidenceMode` type, failure-mode shapes, and D4/D5 boundary are all unchanged.
The `dts_ref` field in the `yakcc_reference` return shape is unchanged (D5/tool
layer). Only the model's write instructions in Section A are updated.

**Rollback:** `git revert` the WI-1062 landing commit. Section A reverts to the
Q10/four-step form with the `.d.ts` write instruction.

---

### Q12: apply-mode — manifest+dts written by tool, model writes only import_line (2026-06-01)

**Decision:** Revise Section A of `docs/system-prompts/yakcc-discovery.md` so
the model passes `project_root` to `yakcc_reference`, which applies the manifest
entry and `.d.ts` as side effects, then writes ONLY the returned `import_line`
(~14 tokens). The manifest-entry append and `.d.ts` write are removed from the
model's task entirely.

**New decision ID:** DEC-COMPOSE-BY-REF-REFERENCE-APPLY-001
**Issue:** https://github.com/cneckar/yakcc/issues/1062
**Refines:** DEC-COMPOSE-BY-REF-REFERENCE-EMIT-MIN-001 (Q11/#1062)
**Date:** 2026-06-01

**Context — Q11 post-fix measurements (#1061 paid re-run):**

After Q11 removed the `.d.ts` write and the narration invitation, reference-mode
output fell to ~139–288 tokens. Token breakdown of the remaining output:

| component            | tokens (approx) |
|----------------------|-----------------|
| import line          | ~14             |
| manifest entry JSON  | ~40             |
| framing/prose        | ~85–234         |
| **total**            | **~139–288**    |

The manifest-entry append (step 3 of Q11 Section A) accounted for ~40 tokens of
deterministic JSON that the tool already computed. Both the manifest-entry JSON
and the surrounding framing were model output that carried no semantic value —
the tool had already computed all of this. The structural floor (import line
only) was ~14 tokens.

**What changed (as of this WI, DEC-COMPOSE-BY-REF-REFERENCE-APPLY-001 / part 2 of #1062):**

1. `yakcc_reference` now accepts an optional `project_root` parameter (apply-mode,
   implemented in `packages/mcp-registry/src/tools/reference.ts`). When present:
   - The tool reads `<project_root>/.yakcc/manifest.json` via `parseProjectManifest`
     (or starts from `emptyManifest()` if absent).
   - Calls `addReference(existingManifest, {root, symbol})` — idempotent on re-apply;
     re-applying the same atom does not create a duplicate manifest entry.
   - Writes the updated manifest back via `serializeProjectManifest`.
   - Writes the `.d.ts` via `generateAtomDts(spec, symbol)` to
     `materializedDtsPath(alias)` under `project_root`.
   - Returns ONLY `{ atom_id, root, import_line, applied: true, manifest_path, dts_path }`.
   When `project_root` is absent, the full legacy artifact is returned unchanged
   (`applied: false`) — backward-compatible for non-apply callers.

2. Section A of `docs/system-prompts/yakcc-discovery.md` is revised so the
   correct sequence is:
   - Call `yakcc_reference({ atom_id, project_root })` — ONE tool call.
   - Write the returned `import_line` verbatim — ONE write.
   - STOP. The manifest entry and `.d.ts` are already written by the tool.

3. The model is explicitly forbidden from appending the manifest entry itself
   (`You MUST NOT append the manifest entry yourself`). Without this directive
   the model could inadvertently double-append on auto_accept.

**Token savings (measured; $0.41 run, Haiku+Sonnet, N=2, 100% behavioral compliance):**

Three-stage progression of reference-emit output collapse (all measured):

| Stage | Reference output | Collapse vs verbatim |
|-------|-----------------|----------------------|
| #1048 broken prompt (narration + redundant .d.ts) | ~430–635 tok | 1.3–6× |
| #1063 terse fix (no .d.ts, no narration; model still wrote manifest entry) | ~139–288 tok | 2.7–19.4× |
| #1062b apply-mode (tool writes manifest+dts; model writes only the import line) | **~25–35 tok** | **17.7–101.8×** |

Per-atom measured collapse at apply-mode (#1062b), all N=2 runs:
- crc32c: 17.7× (Haiku) / 18.0× (Sonnet)
- lru-ttl-cache: 47.8× / 46.6×
- avl-tree: 100.6× / 101.8×
- dijkstra-heap: 59.7× / 97.4×

The behavioral collapse now meets and exceeds the structural ~50× ceiling on large atoms.
Because the model's reference output is ~25–35 tokens regardless of atom size (it emits only the
import line), larger atoms collapse harder — avl-tree and dijkstra both exceed 97×. The
"structural ceiling" framing is superseded: apply-mode collapses to a near-constant token floor,
not a proportional fraction of verbatim output.

**Authority invariant (Sacred Practice #12):**
Manifest I/O is exclusively via `parseProjectManifest` / `serializeProjectManifest` /
`addReference` from `@yakcc/compile` (DEC-COMPOSE-BY-REF-MANIFEST-001). The `.d.ts`
path is exclusively via `materializedDtsPath` / `generateAtomDts`
(DEC-COMPOSE-BY-REF-DTS-001). No parallel manifest logic exists in the handler.
The `project-manifest.ts` and `assemble.ts` source files in `@yakcc/compile` are
unchanged — only `reference.ts` (the MCP tool handler) and the system prompt
are modified by this WI.

**Error discipline (DEC-MCP-ERROR-AS-CONTENT-004):**
The handler NEVER throws on apply-mode failure. An unwritable `project_root` or
unparseable existing manifest returns `{ error: "apply_failed", message: … }` as
content — error-as-content, not a thrown exception.

**Relationship to prior Q-sections:**
- Refines Q11/#1062: Section A is updated; Section B (verbatim `yakcc_compile`
  fallback) is fully preserved — untouched.
- Refines Q10/#1048: the two-branch detection gate (reference path vs verbatim
  path) remains in force. Apply-mode is the updated reference path.
- Q9/#1030 forceful substitution directive: unchanged and still in force for Section B.
- Q8/#578 imperative descent-and-compose discipline: unchanged.
- The `dts_ref` field is still present in the non-apply-mode response (legacy
  callers); Section A no longer instructs the model to write it.

**Invariants verified (DEC-COMPOSE-BY-REF-REFERENCE-APPLY-001):**
- `grep -c "project_root" docs/system-prompts/yakcc-discovery.md` ≥ 1
- `grep -c "applied.*true\|apply-mode\|MUST NOT append the manifest" docs/system-prompts/yakcc-discovery.md` ≥ 1
- `grep -c "MUST NOT narrate\|Emit ONLY\|one.*write\|ONE write" docs/system-prompts/yakcc-discovery.md` ≥ 1
- `grep -c "MUST NOT write the .d.ts\|do NOT write it\|yakcc build.*generates" docs/system-prompts/yakcc-discovery.md` ≥ 1
- `grep -c "You MUST NOT write the atom" docs/system-prompts/yakcc-discovery.md` ≥ 1
- Section B verbatim path (`yakcc_compile`) still exists exactly once.
- `grep -c "You SHOULD consider\|Try to\|When possible"` = 0 (no soft phrases)

**What is NOT changed:** Q1–Q11 substantive decisions remain in force. The
tool-call shape, evidence rendering contract, 4-band protocol, `status` enum,
`ConfidenceMode` type, failure-mode shapes, and D4/D5 boundary are all unchanged.
The non-apply-mode response shape (legacy callers without `project_root`) is
unchanged. Only the model's write instructions in Section A and the tool handler's
apply-mode branch are modified by this WI.

**Rollback:** `git revert` the WI-1062b landing commit. Section A reverts to the
Q11/two-write form (import_line + manifest_entry append); `reference.ts` reverts
to the non-apply-mode-only form.

---

### Q7: Boundary with D5 (quality measurement)

**Decision:** D4 pins **interaction shape** in v1; D5 measures and tunes **calibration knobs**.
The boundary is enumerated explicitly to prevent D5 from reopening D4 questions or D4 from
pre-empting D5 concerns.

**Pinned in v1 by D4 (frozen until a D4 ADR revision):**
- Tool-call shape (single `yakcc_resolve`)
- Evidence response field set + rendering contract (Q2)
- 4-band score → LLM behavior mapping (Q3)
- `no_match` / `weak_only` / `matched` status enum (Q3)
- Verbatim system-prompt text (Q4)
- `ConfidenceMode` type (Q5)
- `RegistryUnreachable` / `disambiguation_hint` / `tiebreaker_reason` shapes (Q6)
- Canonical location of system prompt (`docs/system-prompts/yakcc-discovery.md`)

**Tunable by D5 (revisions allowed via D4 ADR amendment):**
- The 0.92 hybrid threshold for auto-accept (Q5)
- The "5 candidates within ε" cutoff for triggering `disambiguation_hint` (Q6 F2)
- Per-candidate token budget target (Q2; currently ~80 tokens — measured against actual LLM context budgets)
- System-prompt wording (Q4) if D5 measures compliance gaps
- Whether to add the multi-step protocol (Q1) based on response-token-cost measurements

**Not D4's concern (D5 owns wholly):**
- Hit-rate / recall / precision metrics for the discovery system as a whole
- Per-LLM-vendor adaptations (per #154 Out of scope)
- Token-cost benchmarks
- A/B testing infrastructure for prompt variants

**Why this boundary:** D4 is the LLM-interaction *contract*; D5 is the LLM-interaction *quality
measurement*. D4 must produce a stable contract before D5 can measure against it. D5's
measurements then inform the next D4 revision's tuning. Treating them as a feedback loop
(D4 → D5 → D4-revision) is how the system improves over time without unstable churn.

**Revisit trigger:** None for the boundary itself. The boundary is the design.

---

## Worked LLM-session examples

These examples illustrate the complete D4 interaction protocol end-to-end, covering the evidence
rendering template (Q2), the 4-band protocol (Q3), the confidence calibration (Q5), and the
three failure modes (Q6).

### Example 1: Simple match — behavior-only query, strong match, auto-accept

**LLM intent:** Write a function that clamps a number between a lower and upper bound.

**`yakcc_resolve` call:**
```json
{
  "behavior": "clamp a number between a lower bound and upper bound",
  "topK": 5
}
```

**`QueryResult`:** status: "matched", 1 candidate (combinedScore 0.94, gap-to-top-2 = 0.21).

**Evidence rendering:**
```
Candidate 1 of 1
  Address:        a3f9c2d4e5b1f820...
  Behavior:       clamp a numeric value to the range [lo, hi]
  Inputs:         x: number, lo: number, hi: number
  Outputs:        result: number
  Score:          0.94 (strong)
  Key guarantees: returns lo when x < lo, returns hi when x > hi, returns x otherwise
  Property tests: 12 (12 passing)
  Used by:        4,821
```

**LLM reaction (Q3 band: strong + gap > 0.15 → auto-accept):**
D2 auto-accept gate fires. `confidenceMode` is `"hybrid"` (default); since `combinedScore =
0.94 > 0.92`, hybrid auto-accept fires. The LLM inserts `a3f9c2d4e5b1f820...` into the project
manifest without prompting the user.

**Notes:** The `Per-dim:` line is omitted (only one dimension queried). The `Key guarantees:`
field is present (atom has guarantees). Auto-accept is the correct outcome here — this is a
textbook trivial operation with high confidence and large gap.

---

### Example 2: Multi-dim query with weights — shows `Per-dim:` rendering and Q5 interaction

**LLM intent:** Find a pure function that validates an email address with explicit error
conditions for malformed input.

**`yakcc_resolve` call:**
```json
{
  "behavior": "validate an email address string",
  "guarantees": ["rejects strings without @ symbol", "rejects empty strings"],
  "errorConditions": ["throws InvalidEmailError on malformed input"],
  "weights": { "behavior": 0.5, "guarantees": 0.3, "errorConditions": 0.2 },
  "nonFunctional": { "purity": "pure" },
  "topK": 3
}
```

**`QueryResult`:** status: "matched", 2 candidates (scores 0.88 and 0.86; gap = 0.02 ≤ 0.15 →
strong-but-ambiguous band).

**Evidence rendering:**
```
Candidate 1 of 2
  Address:        b7e1d3a4c9f20831...
  Behavior:       validate an email address string; returns void or throws
  Inputs:         email: string
  Outputs:        (void)
  Score:          0.88 (strong)
  Per-dim:        behavior=0.91, guarantees=0.87, errorConditions=0.84
  Key guarantees: rejects strings without @ symbol, rejects empty strings, rejects strings with consecutive dots
  Property tests: 8 (8 passing)
  Used by:        2,104

Candidate 2 of 2
  Address:        c4f2b8a1e3d70925...
  Behavior:       validate an email address; throws on invalid format
  Inputs:         value: string
  Outputs:        (void)
  Score:          0.86 (strong)
  Per-dim:        behavior=0.88, guarantees=0.86, errorConditions=0.82
  Key guarantees: rejects strings without @ symbol, rejects strings with spaces
  Property tests: 5 (5 passing)
  Used by:        891
```

**LLM reaction (Q3 band: strong, gap ≤ 0.15 → surface both with differential evidence):**
The D2 auto-accept gate does NOT fire (gap = 0.02 ≤ 0.15). `confidenceMode` is `"hybrid"`
(default); even if it were `"auto_accept"`, the gate threshold alone would block auto-accept.
The LLM surfaces both candidates to the user, highlighting:
- Candidate 1 has more property tests (8 vs 5) and higher usage (2,104 vs 891).
- Candidate 2's `guarantees` coverage is slightly narrower (2 guarantees surfaced vs 3).
The user chooses.

**Notes:** `Per-dim:` line is present (3 dimensions queried). Both candidates show tiebreaker-
adjacent behavior — even though scores differ by 0.02 (within ε), the explicit gap comparison
(Q3 band rule) catches this before the tiebreaker chain runs, correctly routing to user display.

---

### Example 3: Vague intent — F2 `disambiguation_hint` flow

**LLM intent:** Find something to parse strings.

**`yakcc_resolve` call:**
```json
{
  "behavior": "parse a string",
  "topK": 10
}
```

**`QueryResult`:** status: "matched", 10 candidates all within 0.02 of the top score (0.71).
`disambiguation_hint` fires (≥ 5 candidates within ε = 0.02).

**Evidence rendering (first 2 of 10 shown; LLM sees all 10):**
```
Candidate 1 of 10
  Address:        d2a9e4f1c8b30714...
  Behavior:       parse a CSV string into an array of string arrays
  Inputs:         csv: string
  Outputs:        rows: string[][]
  Score:          0.71 (confident)
  Property tests: 3 (3 passing)
  Used by:        512

Candidate 2 of 10
  Address:        e5b3c1d7a2f40829...
  Behavior:       parse a JSON string into a JavaScript object
  Inputs:         json: string
  Outputs:        result: unknown
  Score:          0.71 (confident)
  Property tests: 6 (6 passing)
  Used by:        8,341
```

**`disambiguation_hint` in the result:**
```json
{
  "kind": "vague_intent",
  "suggested_dimensions": ["guarantees", "signature", "errorConditions"],
  "detail": "10 candidates within 0.02 of top score 0.71; consider adding signature or guarantees constraints"
}
```

**LLM reaction (F2 flow):**
The LLM re-issues `yakcc_resolve` with at least one suggested dimension added. Example
follow-up call after the LLM recognizes context (user is parsing JSON):
```json
{
  "behavior": "parse a JSON string into a JavaScript object",
  "signature": { "inputs": [{ "name": "json", "type": "string" }], "outputs": [{ "type": "unknown" }] },
  "errorConditions": ["throws SyntaxError on invalid JSON"],
  "topK": 5
}
```
This narrowed call is expected to return a confident or strong single candidate.

**Notes:** The LLM correctly uses the `disambiguation_hint.suggested_dimensions` list to choose
which field to add. If the LLM cannot generate plausible constraint content for any suggested
dimension (e.g. the LLM genuinely does not know what type the output should be), it surfaces
all 10 candidates to the user.

---

### Example 4: `no_match` — NEW_ATOM_PROPOSAL path

**LLM intent:** Find a pure TypeScript function that computes the Haversine distance between two
GPS coordinates with sub-meter precision.

**`yakcc_resolve` call:**
```json
{
  "behavior": "compute Haversine distance between two GPS coordinates",
  "guarantees": ["result accurate to sub-meter precision", "handles antimeridian crossing"],
  "signature": {
    "inputs": [
      { "name": "lat1", "type": "number" }, { "name": "lon1", "type": "number" },
      { "name": "lat2", "type": "number" }, { "name": "lon2", "type": "number" }
    ],
    "outputs": [{ "name": "distanceMeters", "type": "number" }]
  },
  "nonFunctional": { "purity": "pure" },
  "topK": 5
}
```

**`QueryResult`:** status: "no_match", candidates: [], near_misses: 2.

**Near-miss rendering:**
```
[NEAR-MISS — failed at: structural]
Candidate 1 of 2
  Address:        f1d4b2e9a5c80736...
  Behavior:       compute distance between two GPS points using Haversine formula
  Inputs:         point1: {lat: number, lon: number}, point2: {lat: number, lon: number}
  Outputs:        km: number
  Score:          0.79 (confident)
  Reason:         expected inputs: [number, number, number, number]; stored signature: [{lat: number, lon: number}, {lat: number, lon: number}]

[NEAR-MISS — failed at: min_score]
Candidate 2 of 2
  Address:        a8c3f5d2b9e10724...
  Behavior:       compute great-circle distance in kilometers
  Inputs:         lat1: number, lon1: number, lat2: number, lon2: number
  Outputs:        distanceKm: number
  Score:          0.44 (poor)
  Key guarantees: accurate to within 1 kilometer
  Reason:         combinedScore 0.44 below minScore threshold
```

**LLM reaction (Q3 no_match path):**
`QueryResult.status = "no_match"`. The LLM does NOT silently write the Haversine code.
Instead, it evaluates the two paths:

1. **Widen and retry:** Near-miss 1 failed at `structural` (signature mismatch: flat vs object
   args). The LLM could relax the signature constraint to allow `{ lat, lon }` object inputs. But
   near-miss 2 (flat signature) has `combinedScore = 0.44` and only "accurate to within 1 km"
   (not sub-meter). The LLM determines widening is unlikely to produce a compliant result.
2. **NEW_ATOM_PROPOSAL:** The LLM emits:

```
NEW_ATOM_PROPOSAL
  behavior: compute Haversine distance between two GPS coordinates with sub-meter precision
  guarantees:
    - result accurate to sub-meter precision
    - handles antimeridian crossing correctly
  signature:
    inputs: lat1: number, lon1: number, lat2: number, lon2: number
    outputs: distanceMeters: number
  nonFunctional:
    purity: pure
  rationale: registry has a structurally-mismatched Haversine (object args) and a low-precision
             great-circle implementation; neither satisfies the sub-meter + flat-signature requirement.
```

This proposal is surfaced to the user for review and eventual `yakcc propose` submission (the manual-authoring template prints from `yakcc propose` on a registry miss; there is no separate `block author` subcommand).

---

### Example 5: Tied candidates — F3 `tiebreaker_reason` exposure

**LLM intent:** Find a function that trims whitespace from both ends of a string.

**`yakcc_resolve` call:**
```json
{
  "behavior": "trim whitespace from both ends of a string",
  "signature": {
    "inputs": [{ "name": "s", "type": "string" }],
    "outputs": [{ "type": "string" }]
  },
  "topK": 3
}
```

**`QueryResult`:** status: "matched", 2 candidates both with `combinedScore = 0.88` (within
ε = 0.02). D3 §Q4 tiebreaker chain fires.

**Evidence rendering (with tiebreaker_reason):**
```
Candidate 1 of 2
  Address:        b3e8f4a1c7d20915...
  Behavior:       trim leading and trailing whitespace from a string
  Inputs:         s: string
  Outputs:        string
  Score:          0.88 (strong)
  Key guarantees: result has no leading whitespace, result has no trailing whitespace
  Property tests: 15 (15 passing)
  Used by:        12,432
  [Tiebreaker: ranked above tied peer by property_test_depth (15 vs 9 property tests)]

Candidate 2 of 2
  Address:        c9a5d2f8b1e30726...
  Behavior:       remove whitespace from string start and end
  Inputs:         s: string
  Outputs:        string
  Score:          0.88 (strong)
  Key guarantees: trims spaces and tabs
  Property tests: 9 (9 passing)
  Used by:        3,891
  [Tiebreaker: resolved by property_test_depth; see candidate 1]
```

**LLM reaction (F3 flow):**
Both candidates score 0.88. The D2 auto-accept gate fires (`combinedScore = 0.88 > 0.85`). But
the gap between the two candidates is 0 (tied), so the "gap-to-top-2 > 0.15" condition is NOT
satisfied. The auto-accept gate does not fire for tied candidates.

The LLM surfaces both to the user with the `tiebreaker_reason.detail`: "ranked above tied peer
by property_test_depth (15 vs 9 property tests)." This explains to the user why candidate 1
appears first, without the user needing to understand the tiebreaker chain.

**Notes:** `confidenceMode` is `"auto_accept"`, the LLM would still surface the tiebreaker
rationale for the rank-1 candidate so the user can make an informed decision. If
`confidenceMode` were `"auto_accept"` AND the auto-accept gate fired (i.e. a different scenario
where scores were NOT tied), the tiebreaker reason would be omitted from the output (only rank-1
would be surfaced without rationale).

---

## Alternatives considered

| Alternative | Status | Rejection rationale |
|---|---|---|
| Multi-step tool protocol (`yakcc_search` / `yakcc_inspect` / `yakcc_select`) | Rejected for v1; D5 trigger defined (Q1) | Doubles LLM-side prompt surface for unmeasured benefit. High-K cutoff has no empirical floor. D2's default K=10 + ~80 tok/candidate = ~800 token responses, well within context budgets. D5 trigger: median response tokens > 2,000 AND callers regularly request topK > 20. |
| `QueryIntentCard`-derived `confidenceMode` (e.g. infer "trivial" from `propertyTests` being empty) | Rejected (Q5) | Risk context lives in the LLM's prompt, not the query. A `propertyTests`-empty query may be a trivial operation OR a domain where tests haven't been written. Registry-side inference silently imposes risk policy from the wrong layer. Caller-driven is testable by prompt tuning. |
| Silent fall-through to code-writing on `no_match` | Rejected (Q3) | Makes the registry invisible when it has real gaps. The user never learns "this capability is missing" — they just see code. `no_match` signal forces gap surfacing, which is the only mechanism for registry coverage improvement over time. |
| `tiebreaker_reason` absent (LLM silently picks rank-1 from tie) | Rejected (Q6 F3) | Without rationale, the LLM appears to guess. Visibility of the tiebreaker chain is what lets the user trust the registry's rank-1 selection when scores are identical. |
| `disambiguation_hint.suggested_dimensions` ranked by likely-impact (not just listed) | Deferred to D5 (Q6 F2) | Ranking by likely-impact requires knowing which dimensions, when added, most narrow the result set for this particular query. That is an empirical question D5 can answer from production data. Listed (unranked) is safe and actionable for v1. |
| Folding `ConfidenceMode` as a D4 query field on `QueryIntentCard` | Implementation WI decision (Q5) | The semantic is D4's; the placement (whether on `QueryIntentCard` or as a separate request field) is an API ergonomics decision for the implementation WI. Both are valid; D4 does not pre-empt it. |
| Per-vendor system-prompt variants | Deferred (out of scope per #154) | A popular LLM requiring structurally different prompt phrasing triggers a separate downstream WI per the #154 out-of-scope clause. D4 ships one canonical prompt; vendor adaptation is a follow-up concern. |

---

## When to revisit

The "When to revisit" triggers below cross-reference Q7's D4-pinned vs D5-tunable table. The
right column identifies who acts when the trigger fires.

| Trigger | Who acts |
|---|---|
| D5 reports median response token count > 2,000 AND callers regularly request `topK` > 20 | File v3.1 D4-revision WI to specify multi-step protocol (`yakcc_search` / `yakcc_inspect` / `yakcc_select`) |
| D5 reports per-candidate inspection token cost during refinement is materially higher than upfront full-list response | Same v3.1 D4-revision WI trigger as above |
| D5 reports the evidence field set is over- or under-specified for actual LLM decision quality | D4 ADR amendment on Q2 field set |
| D5 reports LLM `no_match` protocol compliance < 80% | D4 ADR amendment + Q4 system-prompt revision |
| D5 reports `"hybrid"` confidenceMode produces > 5% false-accept rate | D4 ADR amendment: tune 0.92 threshold |
| D5 reports `"auto_accept"` mode used by LLMs in clearly non-trivial contexts | D4 ADR amendment: add per-mode prompt guidance to Q4 system-prompt |
| D5 reports `disambiguation_hint` is rarely actionable | D4 ADR amendment on Q6 F2 `suggested_dimensions` ranking |
| D5 reports `tiebreaker_reason.detail` confuses users | D4 ADR amendment on Q6 F3 abbreviated form |
| D5 reports materially worse hit rates with Q4 prompt vs hand-tuned prompt | D4 ADR amendment: tighten system-prompt wording |
| Federation transports diversify (gRPC, WebSocket) | D4 ADR amendment: expand Q6 F1 `reason` enum |
| A popular LLM requires structurally different prompt phrasing | File separate per-vendor adaptation WI (out of scope per #154) |
| 0.92 hybrid threshold, ε = 0.02 tie cutoff, "5 candidates" disambiguation cutoff, ~80-token budget | D5 owns; amend D4 with D5 measurements |

---

## Implementation phase boundary

D4 commits the design only. No source files are modified by this ADR.

The implementation split follows the WI assignments established by D1, D2, and D3:

1. **`WI-V3-DISCOVERY-IMPL-QUERY`** — Owns the `QueryResult` envelope shape, including the
   `status: "matched" | "weak_only" | "no_match"` field (Q3), the `disambiguation_hint` field
   (Q6 F2), and the exact placement of `confidenceMode` on the request surface (Q5). Must also
   implement the `RegistryUnreachable` response path (Q6 F1) for the programmatic API surface.
   The tiebreaker chain (D3 §Q4) produces the data that populates `tiebreaker_reason`; this WI
   must surface that data per the Q6 F3 shape.

2. **`WI-V3-DISCOVERY-IMPL-CLI`** — Owns the human-readable rendering of the evidence projection
   template (Q2) in `yakcc query --format text` mode. Also owns the JSON serialization of
   `disambiguation_hint`, `tiebreaker_reason`, and `RegistryUnreachable` in `--format json` mode.

3. **MCP tool surface implementation (WI TBD)** — Owns the `yakcc_resolve` MCP tool definition,
   the tool-call argument schema (including where `confidenceMode` lives in the request), and the
   LLM-visible response serialization of the Q2 evidence template. This WI also owns deployment
   of `docs/system-prompts/yakcc-discovery.md` as the system-prompt addition in MCP server
   configuration.

---

## Two-path model — canonical MCP intent-time vs PreToolUse fallback (added 2026-05-30 per #950)

This ADR was originally written under the assumption that the LLM would consult `yakcc_resolve` during plan formulation — proactive, intent-time. Production realignment per **DEC-HOOK-PROACTIVE-PRIMARY-001** (MASTER_PLAN.md Decision Log) names that path *canonical* and codifies the current `PreToolUse` substitution path as a *fallback*:

**Canonical (MCP, intent-time):** LLM in an MCP-aware IDE builds an IntentCard from its plan → calls `yakcc_resolve` MCP tool → tool queries local registry then global via `@yakcc/mcp-registry` (cneckar/yakcc#944 / yakcc#951) → returns candidates with the Q5 confidence bands as **structured MCP content** (`{ confidence_tier, candidates: [...] }`) → LLM picks the band and emits `yakcc compile <atom-id>` for an accept, or a *fully-formed atom triplet* (`spec.yak` + impl + LLM-authored property tests) for a no-fit (cneckar/yakcc#954).

**Fallback (PreToolUse, post-emission):** LLM emits code without consulting yakcc (no system prompt delivered, MCP not configured, or short-context session forgot the tool) → `PreToolUse` fires on `Edit`/`Write`/`MultiEdit` → the current `hook-intercept` substitution decision catches what it can; `@yakcc/variance` machine-generates synthetic property tests post-hoc.

Both paths preserve the cornerstones:
- **Air-gap (B6):** canonical path queries local first; global query is gated by network availability and disabled by `--airgapped`. Fallback path is local-only by design.
- **No identity (DEC-COMMONS-NO-AUTH-001):** the MCP query payload carries only the IntentCard (content-derived, not user-derived).

This ADR's Q1–Q8 substantive decisions (band semantics, evidence template, ranking inputs, system-prompt content) remain authoritative for *both* paths. What this section adds is the deployment posture: which path is the canonical first attempt and which is the safety net. Implementation lives in:

- **Gap A** — `WI-HOOK-PROACTIVE-A-YAKCC-RESOLVE-WIRING` (cneckar/yakcc#953) — delivering the system prompt into LLM context and wiring `yakcc_resolve` to fall through local → global. This is what makes the canonical path actually reachable end-to-end.
- **Gap C** — `WI-HOOK-PROACTIVE-C-ATOM-TRIPLET-EMISSION` (cneckar/yakcc#954) — defining and parsing the LLM-emits-fully-formed-atom-triplet format so a no-fit produces LLM-authored property tests rather than the variance-synthesized fallback.
- **Gap B** is covered by cneckar/yakcc#944 / cneckar/yakcc#951 (`@yakcc/mcp-registry`) — the global query surface needed by the canonical path's local→global cascade.

The fallback path is intentionally NOT retired. Agents in the wild that don't know about yakcc still grow the commons via the post-hoc `storeBlock` → `commonsSubmit` chain. The canonical path delivers *higher-quality* growth (LLM-authored contracts and property tests vs synthetic ones); both shapes of growth coexist.

---

## References

- Issue #1062 (WI-1062b — apply-mode: manifest+dts written by tool, model writes only import_line; D4 ADR revision in Q12)
- `DEC-COMPOSE-BY-REF-REFERENCE-APPLY-001` — apply-mode; model writes only import_line (`docs/system-prompts/yakcc-discovery.md`, Q12 of this ADR)
- Issue #1062 (WI-1062 — Reference-emit output minimization; D4 ADR revision in Q11)
- `DEC-COMPOSE-BY-REF-REFERENCE-EMIT-MIN-001` — terse reference-emit, no model-written .d.ts (`docs/system-prompts/yakcc-discovery.md`, Q11 of this ADR)
- Issue #1048 (WI-1048 — Compose-by-reference reference-emit path; D4 ADR revision in Q10)
- `DEC-COMPOSE-BY-REF-REFERENCE-EMIT-001` — reference-emit preferred path when `.yakcc/manifest.json` present (`docs/system-prompts/yakcc-discovery.md`, Q10 of this ADR)
- Issue #1047 (`yakcc_reference` MCP tool; `DEC-COMPOSE-BY-REF-REFERENCE-TOOL-001`)
- Issue #1041 (B4-v5 token-savings analysis; empirical basis for Q10)
- Issue #1030 (WI-1030 — Forceful substitution directive; D4 ADR revision in Q9)
- `DEC-BENCH-B4-V5-SUBSTITUTION-DIRECTIVE-001` — B4-v5 rerun empirical validation; forceful compile-and-stop directive (`docs/system-prompts/yakcc-discovery.md`, Q9 of this ADR)
- Issue #578 (WI-578 — Descent-and-Compose prompt rewrite; D4 ADR revision in Q8)
- Issue #154 (this work item — V3-DISCOVERY-D4)
- Issue #153 (D3 — V3-DISCOVERY-D3)
- Issue #152 (D2 — V3-DISCOVERY-D2)
- Issue #151 (D1 — V3-DISCOVERY-D1)
- Issue #150 (parent initiative — WI-V3-DISCOVERY-SYSTEM)
- `DEC-V3-DISCOVERY-D4-001` (`MASTER_PLAN.md`) — This decision log entry
- `DEC-V3-DISCOVERY-D3-001` (`MASTER_PLAN.md`) — Ranking + scoring algorithm (D3)
- `DEC-V3-DISCOVERY-D2-001` (`MASTER_PLAN.md`) — Query language / API surface (D2)
- `DEC-V3-DISCOVERY-D1-001` (`MASTER_PLAN.md`) — Multi-dimensional embedding schema (D1)
- `DEC-VECTOR-RETRIEVAL-001` (`packages/registry/src/index.ts`) — Public vector-search surface on Registry interface
- `DEC-VECTOR-RETRIEVAL-002` (`packages/registry/src/index.ts`) — Query-text derivation rule for `findCandidatesByIntent`
- `DEC-VECTOR-RETRIEVAL-003` (`packages/registry/src/index.ts`) — Structural rerank scoring formula (coexisting path)
- `DEC-VECTOR-RETRIEVAL-004` (`packages/registry/src/index.ts`) — `IntentQuery` is a local structural type (circular-dep avoidance)
- `DEC-VERIFY-010` (`VERIFICATION.md`) — L1+ behavioral embedding via sandbox execution (Stage 4 trigger; v3.1 boundary)
- `DEC-EMBED-010` (`MASTER_PLAN.md`) — Local embeddings via `transformers.js`, provider interface
- `DEC-CI-OFFLINE-001` (`MASTER_PLAN.md`) — Single canonical offline-embedding-provider authority
- `docs/system-prompts/yakcc-discovery.md` — Verbatim system-prompt text (canonical distribution surface; authority: this ADR)
- `packages/registry/src/index.ts` — Registry interface, `CandidateMatch`, `IntentQuery`, `FindCandidatesOptions` (lines 254–464)
- `packages/registry/src/storage.ts:540-700` — Current `findCandidatesByIntent` implementation (coexisting path)
- `packages/registry/src/search.ts` — `structuralMatch` (Stage 2 reuse target per D3)
- `packages/registry/src/schema.ts` — `test_history`, `runtime_exposure`, `BlockTripletRow` table shapes
