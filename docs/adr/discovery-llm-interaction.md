# DEC-V3-DISCOVERY-D4-001 — LLM-facing interaction design

**Status:** Accepted (D4 design phase; implementation deferred to v3 implementation initiative)
**Date:** 2026-05-10
**Issue:** https://github.com/cneckar/yakcc/issues/154
**Initiative:** WI-V3-DISCOVERY-SYSTEM (D4 of 6)

---

## Context

D1 (`docs/adr/discovery-multi-dim-embeddings.md`, `DEC-V3-DISCOVERY-D1-001`) established the
multi-dimensional storage schema: 5 `FLOAT[384]` columns in a `sqlite-vec` `vec0` virtual table
(`contract_embeddings`), one per SpecYak semantic axis (`embedding_behavior`,
`embedding_guarantees`, `embedding_error_conditions`, `embedding_non_functional`,
`embedding_property_tests`). D1 committed the absent-dimension rule: a missing SpecYak source
field yields a zero vector; query-time must skip zero-vector dimensions.

D2 (`docs/adr/discovery-query-language.md`, `DEC-V3-DISCOVERY-D2-001`) established the
LLM-facing query surface: `QueryIntentCard` with freeform per-dimension texts, per-dimension
`weights`, and `topK` (default 10). D2 committed the `Candidate` result type carrying
`perDimensionScores: PerDimensionScores` and `combinedScore: number` in [0, 1], the auto-accept
threshold (top-1 `combinedScore > 0.85` AND gap-to-top-2 > 0.15), and the programmatic API
(`Registry.findCandidatesByQuery`). D2 deferred the LLM tool call shape and the interaction
protocol to D4.

D3 (`docs/adr/discovery-ranking.md`, `DEC-V3-DISCOVERY-D3-001`) established the ranking
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
| Storage schema (5 columns, model, zero-vector rule, migration 7) | D1 | `docs/adr/discovery-multi-dim-embeddings.md` |
| Query surface (QueryIntentCard, Candidate shape, CLI flags, auto-accept thresholds, cross-provider invariant) | D2 | `docs/adr/discovery-query-language.md` |
| Ranking formula, aggregation strategy, pipeline, tiebreakers, score normalization, negative-space behavior | D3 | `docs/adr/discovery-ranking.md` |
| Tool call shape, evidence rendering contract, 4-band protocol, system-prompt text, confidence calibration, failure-mode shapes, D5 boundary | D4 (this ADR) | `docs/adr/discovery-llm-interaction.md` |

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

## References

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
