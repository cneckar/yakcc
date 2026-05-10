# DEC-V3-DISCOVERY-D3-001 — Ranking + scoring algorithm for v3 discovery

**Status:** Accepted (D3 design phase; implementation deferred to v3 implementation initiative)
**Date:** 2026-05-08
**Issue:** https://github.com/cneckar/yakcc/issues/153
**Initiative:** WI-V3-DISCOVERY-SYSTEM (D3 of 6)

---

## Context

D1 (`docs/adr/discovery-multi-dim-embeddings.md`, `DEC-V3-DISCOVERY-D1-001`) established the
multi-dimensional storage schema: 5 `FLOAT[384]` columns in a `sqlite-vec` `vec0` virtual table
(`contract_embeddings`), one per SpecYak semantic axis:

| Storage column | SpecYak source |
|---|---|
| `embedding_behavior` | `spec.behavior` |
| `embedding_guarantees` | `spec.guarantees[*].description` + preconditions/postconditions/invariants |
| `embedding_error_conditions` | `spec.errorConditions[*].description` |
| `embedding_non_functional` | `spec.nonFunctional` serialized |
| `embedding_property_tests` | `spec.propertyTests[*].description` |

D1's **absent-dimension rule**: an absent or empty SpecYak source field yields a zero vector stored
in the corresponding column. A per-dimension NULL marker column (separate boolean sentinel) lets
the query layer detect absent dimensions. Scoring MUST skip zero-vector dimensions to avoid false
rank inflation — a query that includes the property-tests dimension must not spuriously rank atoms
that have no property tests merely because their zero vector is not maximally dissimilar to the
query vector.

D2 (`docs/adr/discovery-query-language.md`, `DEC-V3-DISCOVERY-D2-001`) established the
LLM-facing query surface: `QueryIntentCard` with per-dimension optional freeform texts and
per-dimension `weights`, plus the `Candidate` result type carrying `perDimensionScores:
PerDimensionScores` and `combinedScore: number` in [0, 1]. D2 explicitly deferred the
`combinedScore` computation formula and the `cosineDistance` normalization transform to D3:
"D2 establishes only the shape."

D2 also established the programmatic API (`Registry.findCandidatesByQuery`), the auto-accept
thresholds (`combinedScore > 0.85` AND gap-to-top-2 > 0.15), and the cross-provider rejection
invariant. None of those are reopened by D3.

**Existing single-vector path:** `Registry.findCandidatesByIntent` (`packages/registry/src/index.ts`,
DEC-VECTOR-RETRIEVAL-001/002/003/004) implements a single-vector cosine path used today for
behavior-only queries. That path is **not replaced or modified by D3**. D3 specifies ranking for
the new `findCandidatesByQuery` multi-dim path only. The two paths coexist until the
implementation WI (`WI-V3-DISCOVERY-IMPL-QUERY`) decides the runtime deprecation / alias shape
for `findCandidatesByIntent`.

---

## Boundary with D1 + D2

| Domain | Authority | ADR |
|---|---|---|
| Storage schema (5 columns, model, zero-vector rule, migration 7) | D1 | `docs/adr/discovery-multi-dim-embeddings.md` |
| Query surface (QueryIntentCard, Candidate shape, CLI flags, auto-accept thresholds, cross-provider invariant) | D2 | `docs/adr/discovery-query-language.md` |
| Ranking formula, aggregation strategy, pipeline, tiebreakers, score normalization, negative-space behavior | D3 (this ADR) | `docs/adr/discovery-ranking.md` |

Neither D1 nor D2 is modified by D3. If a future WI touches more than one of these authority
domains, both owning ADRs must be revised.

---

## Decision

### Q1: Aggregation strategy — per-dimension weighted cosine

**Decision:** Per-dimension weighted cosine sum, renormalized over the surviving (non-absent)
dimension set.

**Final formula:**

```
// Step 1: per-dimension similarity (D1's cosineDistance is in [0, 2]; lower = more similar)
similarity[d] = 1 - cosineDistance[d] / 2       // in [0, 1]; 1 = identical direction, 0 = orthogonal

// Step 2: surviving dimension set
// A dimension d is in the surviving set when:
//   - the query includes d (QueryIntentCard.behavior is not undefined/empty, etc.)
//   - the stored atom's d-column is NOT a zero vector (D1's NULL marker column is FALSE)
// When stored atom's d-column is a zero vector, perDimensionScores[d] = null (not 0)

// Step 3: weighted combination, renormalized
combinedScore = (Σ weights[d] * similarity[d]  for d in surviving_dims)
              / (Σ weights[d]                   for d in surviving_dims)
```

`combinedScore` is always in [0, 1] regardless of how many dimensions survive, because renormalization
over the denominator `Σ weights[d]` keeps the expression bounded and the numerator components are each
in [0, 1].

**Default weight:** 1.0 for any queried dimension whose weight is omitted from `QueryIntentCard.weights`.
Weights are relative; absolute scale does not matter after renormalization. A query supplying only
`behavior` and omitting `weights` entirely is equivalent to a 1.0/1.0 = 1-dimensional weighted cosine.

**NULL-skip consequence:** An atom that has zero vectors for all queried dimensions produces no
surviving dimension set and its `combinedScore` is undefined. The implementation MUST handle this
edge case by treating such atoms as non-candidates (score = 0, excluded from ranking). The query
layer must never divide by zero.

**Why weighted cosine, not an alternative:**

Option (a) — Combined embedding (concatenate all 5 dimension vectors into one 1,920-float vector):
rejected. Concatenation collapses the per-dimension weights — once all 5 axes are pooled into a
single cosine, the `QueryIntentCard.weights` field has no effect. This undoes D1's design intent
(separating dimensions so queries can weight them independently).

Option (b) — RRF — addressed in Q2.

Option (c) — Multiplicative score (`similarity[behavior] * similarity[guarantees] * ...`):
rejected. Multiplicative combination zero-collapses any atom missing even one queried dimension
(similarity[d] = 0 for absent dimension → product = 0). This penalizes atoms with partially
populated specs unfairly and produces a non-interpretable score (DEC-VECTOR-RETRIEVAL-003's
rejection rationale applies here as well).

**`autoAccepted` flag:** D2 committed the auto-accept shape as "shape deferred to D3/implementation
WI." D3 pins it: `Candidate.autoAccepted: boolean` is set to `true` by the query layer when the
auto-accept rule fires (top-1 `combinedScore > 0.85` AND gap-to-top-2 > 0.15, per D2 §Q5). The
exact field position in the `Candidate` interface is resolved by the implementation WI; D3
commits only the semantic: boolean, computed at query time, never inherited from storage.

---

### Q2: Why weighted cosine, not RRF (for v1)

**Decision:** Weighted cosine is chosen for v1. RRF is documented here, rejected for v1, and has
a named revisit trigger.

**RRF formula (for reference):**

```
// Reciprocal Rank Fusion
rrf_score = Σ weights[d] / (k + rank_d(atom))   // k = 60 (Cormack et al. standard constant)
```

Where `rank_d(atom)` is the rank of the atom within the sorted-by-cosineDistance list for
dimension d, and the sum is over all queried dimensions.

**Worked example — same query against the same 4-atom set:**

Query: `{ behavior: "validate email address", guarantees: "rejects empty string" }`, equal weights (1.0/1.0).

| Atom | `cosineDistance[behavior]` | `cosineDistance[guarantees]` | `similarity[behavior]` | `similarity[guarantees]` | **Weighted cosine** |
|---|---|---|---|---|---|
| A — email-validator | 0.20 | 0.18 | 0.90 | 0.91 | **0.905** |
| B — string-validator | 0.30 | 0.15 | 0.85 | 0.925 | **0.888** |
| C — regex-matcher | 0.40 | 0.60 | 0.80 | 0.70 | **0.750** |
| D — ip-validator | 0.22 | 0.80 | 0.89 | 0.60 | **0.745** |

Weighted cosine ranking: **A > B > C > D**.

Now via RRF (k = 60):

| Atom | `rank[behavior]` | `rank[guarantees]` | `rrf[behavior]` | `rrf[guarantees]` | **RRF score** |
|---|---|---|---|---|---|
| A — email-validator | 1 | 2 | 1/61 = 0.01639 | 1/62 = 0.01613 | **0.03252** |
| B — string-validator | 2 | 1 | 1/62 = 0.01613 | 1/61 = 0.01639 | **0.03252** |
| C — regex-matcher | 3 | 3 | 1/63 = 0.01587 | 1/63 = 0.01587 | **0.03175** |
| D — ip-validator | 4 | 4 | 1/64 = 0.01563 | 1/64 = 0.01563 | **0.03125** |

RRF ranking: **A = B (tied) > C > D**.

**Ranking difference:** Weighted cosine correctly separates A (0.905) from B (0.888) — atom A is
genuinely stronger on the behavior dimension. RRF cannot distinguish them because the per-dimension
rank difference (A is rank 1 on behavior, B is rank 1 on guarantees) exactly cancels at k=60. The
caller who weights behavior at 0.8 and guarantees at 0.2 would want A to win unambiguously; weighted
cosine honors that; RRF cannot because the weight enters only as a linear multiplier on equal reciprocal
quantities.

**Trigger to revisit RRF (D5 trigger):** If D5's quality measurement WI surfaces that per-dimension
`cosineDistance` distributions have significantly different variance across atoms in the corpus — for
example, `embedding_property_tests` distances are clustered near 0.4 while `embedding_behavior`
distances span the full [0, 2] range — then weighted cosine becomes unstable (a behavior-dimension
tie at 0.70 is semantically different from a property-tests-dimension tie at 0.70 because the two
distributions have different spreads). In that case, D5 should file a D3 revision to switch to
normalized-within-dimension cosine or to RRF, which is distribution-agnostic by construction.

---

### Q3: 5-layer pipeline composition

**Decision:** The multi-dim query pipeline executes in 5 sequential stages. Stages 2–4 apply within
the candidate set K' produced by Stage 1. If any stage drops the candidate count to 0, the
negative-space handler (Q6) takes over.

**Stage 1 — Vector index (multi-dim cosine)**

Retrieve the top K' candidates from `contract_embeddings` via per-dimension KNN queries, where
K' = max(K × 5, 50) and K = `QueryIntentCard.topK` (default 10). K' is intentionally larger than
the final output set to give the downstream filter stages room to prune without collapsing to zero.

Implementation note for `WI-V3-DISCOVERY-IMPL-QUERY`: per-dimension KNN via per-column `vec0 MATCH`
queries is the preferred path (stays inside the sqlite-vec API surface). The implementation WI must
verify that the installed `sqlite-vec` version supports per-column KNN before finalizing. If
per-column KNN is not available, fall back to loading per-dimension vectors and computing cosine
similarity in TypeScript — no D3 design change is required (the formula is the same; only the
execution location differs).

**Stage 2 — Structural filter**

Keep only candidates whose type signature unifies with the query's `signature` field, using the
existing `structuralMatch` function from `packages/registry/src/search.ts` (Stage 2 reuses this
function — do not reimplement it). If `QueryIntentCard.signature` is absent or undefined, this
stage is a no-op and all Stage 1 candidates pass through.

`structuralMatch` is a deterministic predicate (binary accept/reject), not a score component.
This is intentional (see Q5 — why structuralScore is not folded into combinedScore).

**Stage 3 — Strictness filter**

Keep only candidates whose declared strictness meets or exceeds the query's non-functional
requirements. The strictness check applies to:
- `level` — the atom's declared strictness level (from the stored SpecYak);
- `nonFunctional.purity` — e.g. reject a `sideEffecting` atom when the query requires `pure`;
- `nonFunctional.threadSafety` — e.g. reject a `unsafe` atom when the query requires `safe`.

Source: `BlockTripletRow.specCanonicalBytes` → parse SpecYak → read `level` + `nonFunctional`
fields. This is a per-candidate SpecYak parse at query time; at K' = 50 this is sub-millisecond.

If `QueryIntentCard.nonFunctional` is absent or undefined, this stage is a no-op and all Stage 2
survivors pass through.

**Stage 4 — Property-test verification (RESERVED, deferred to v3.1)**

This layer slot is explicitly reserved to avoid renumbering in a future revision. In v3, Stage 4
is a no-op: all Stage 3 survivors pass through unconditionally.

The v3.1 trigger for Stage 4: `DEC-VERIFY-010` lands and L1+ behavioral embedding or property-test
execution infrastructure is available. At that point, Stage 4 can filter candidates that fail
property-test verification against the query's constraints. The implementation WI MUST NOT implement
Stage 4 behavior in v3; the slot is reserved only.

**Stage 5 — Final ranking**

1. Compute `combinedScore` per Q1 formula for all surviving candidates.
2. Apply tiebreaker hierarchy per Q4 (within combinedScore tie window ε = 0.02).
3. Apply `QueryIntentCard.minScore` filter (if set, exclude candidates below threshold).
4. Truncate to `topK`.

**Fall-through behavior:** When any of Stages 2–4 reduces the surviving candidate set to 0, the
pipeline bypasses Stage 5 and invokes the negative-space handler (Q6). The pipeline does not
retry with a larger K' automatically; the caller (LLM or CLI) receives near-miss annotations and
decides whether to widen.

---

### Q4: Tiebreakers

**Decision:** Tiebreakers apply in priority order when two candidates' `combinedScore` values
differ by less than ε = 0.02. The hierarchy is lexicographic: candidate A beats B if A is
strictly greater on the first tiebreaker where they differ; the next tiebreaker is consulted only
when the current tiebreaker is tied.

ε = 0.02 matches the score-band granularity: it is smaller than the smallest band gap (0.15
between confident and strong). Candidates more than 0.02 apart are genuinely ranked by score;
the tiebreaker chain resolves only near-identical candidates.

| Priority | Tiebreaker | Field source | Direction |
|---|---|---|---|
| 1 | Property-test depth | Count of `propertyTests[*]` parsed from `BlockTripletRow.specCanonicalBytes` (SpecYak `spec.propertyTests` array length) | Higher wins |
| 2 | Usage history | `runtime_exposure.requests_seen` for the candidate's `BlockMerkleRoot` | Higher wins |
| 3 | Test history depth | `COUNT(*) FROM test_history WHERE block_merkle_root = ? AND passed = 1` | Higher wins |
| 4 | Atom age | `BlockTripletRow.createdAt` | Older wins (longer baked) |
| 5 | Lexicographic `BlockMerkleRoot` | The `BlockMerkleRoot` string itself | Lexicographically smaller wins (deterministic) |

**Codebase confirmation (planner codebase pass):**
- `BlockTripletRow.createdAt` — confirmed in `packages/registry/src/schema.ts`
- `runtime_exposure.requests_seen` — confirmed in `packages/registry/src/schema.ts`
- `test_history` with `passed=1` count — confirmed; already used by `selectBlocks` in `packages/registry/src/storage.ts`
- `propertyTests[*]` — derivable from `specCanonicalBytes` SpecYak parse; not a SQL column in v3 (v3.1 trigger: DEC-VERIFY-010 columns land and the count becomes a direct SQL column)
- Lex `BlockMerkleRoot` — mirrors the deterministic final tiebreaker in `selectBlocks`

**Property-test depth parse note:** Tiebreaker (1) requires a SpecYak parse of `specCanonicalBytes`
for each candidate in the tie window. At the expected tie-window size (typically 0–5 candidates),
this is negligible overhead. If the tie window frequently includes many candidates, the implementation
WI should evaluate caching parsed counts in a column as a follow-up — not a v3 requirement.

**Why property-test depth first:** The registry's monotonic improvement model (first-class test
coverage → longer production baking → usage evidence → age) is expressed by the tiebreaker order.
A more-tested atom is preferred over a less-tested one when scores are equivalent; usage history
breaks remaining ties by production validation; test history by off-line validation; atom age by
seniority; lexicographic root as a final deterministic fallback.

**Why property-test depth is a tiebreaker, not a score component:** Folding property-test depth
into `combinedScore` would penalize newly registered atoms — a brand-new atom with identical
behavior semantics would rank lower than an older atom solely because of fewer property tests,
not because of weaker embedding similarity. Tiebreaker position preserves score interpretability
as a pure similarity metric while still preferring better-validated atoms within the tie window.
The v3.1 trigger: when DEC-VERIFY-010 lands and behavioral embedding is available, property-test
verification can move to Stage 4 (a filter gate), not into the score.

---

### Q5: Score normalization + interpretation bands

**Decision:** `combinedScore` is always in [0, 1] via renormalized weights (Q1 formula). The
per-dimension similarity transform is:

```
similarity[d] = 1 - cosineDistance[d] / 2
```

Where `cosineDistance[d]` is the raw `vec0` distance for dimension d. The sqlite-vec `vec0`
distance for unit-sphere embeddings is in [0, 2] (lower = more similar; confirmed at
`packages/registry/src/storage.ts` where the comment "cosineDistance is in [0, 2] on the unit
sphere" appears at lines 629–633). Dividing by 2 maps the distance to [0, 1] (lower = lower
similarity), then subtracting from 1 inverts direction so that 1 = identical and 0 = orthogonal.

**Score interpretation bands** (calibrated empirically per D5; current values are design targets):

| `combinedScore` range | Band | Interpretation |
|---|---|---|
| ≥ 0.85 | Strong | D2 auto-accept candidate when gap-to-top-2 > 0.15 also holds |
| 0.70 – 0.85 | Confident | High-quality candidate; likely correct; LLM should inspect before accepting |
| 0.50 – 0.70 | Weak | Candidate may be relevant; LLM should compare against alternatives |
| < 0.50 | Poor | Low similarity; treat as near-miss signal |

The 0.85 band aligns exactly with D2's auto-accept threshold. D5's quality measurement WI
(`WI-V3-DISCOVERY-IMPL-EVAL`) is the primary authority for tuning band boundaries; do not adjust
without D5 data.

**Why structuralScore is NOT folded into `combinedScore`:**

The existing single-vector path (DEC-VECTOR-RETRIEVAL-003) uses an additive formula:
`(1 - cosineDistance) + structuralScore`. D3 intentionally differs from this formula.

Rationale: In the 5-dimension setting, `combinedScore` is already a normalized similarity
measure. Additively folding in a `structuralScore` term would push `combinedScore` above 1 (or
require scaling that reduces interpretability), and would cause structural mismatch to partially
attenuate rather than gate. The "strong" / "confident" / "weak" / "poor" bands have clear
semantic meaning only when the score is a pure similarity metric. If structural matching is folded
in as a score component, a "strong" result might be structurally mismatched but score 0.85
because the embedding similarity was 0.9 — which is a false positive, not a true strong match.

Gating structural matching at Stage 2 (a binary pass/reject) preserves `combinedScore`'s
interpretability: a candidate that reaches Stage 5 has already passed structural unification, so
`combinedScore` = 0.90 means "90% similar on the queried semantic axes" with no structural
caveats. Near-misses that fail Stage 2 are surfaced via Q6 with `failedAtLayer: 'structural'`.

**Revisit trigger:** D5 reports that too many candidates are filtered at Stage 2 and callers
would prefer a score-attenuated structural mismatch over complete exclusion (e.g. the LLM finds
the near-misses more useful than the perfectly-typed lower-similarity results). In that case,
file a D3 ADR revision to evaluate re-folding structuralScore as a multiplicative weight
(not additive — see Q1 option (c) rejection rationale) within the `combinedScore` formula.

---

### Q6: Negative-space handling — broaden + suggest

**Decision:** When the pipeline returns 0 candidates surviving all stages, return up to `topK`
*near-misses* with structured rejection annotations.

**`CandidateNearMiss` shape:**

```typescript
/**
 * A near-miss candidate that failed at one of the pipeline filter stages.
 * Returned in the `near_misses` array on the query result when 0 regular
 * candidates survive all pipeline stages.
 */
interface CandidateNearMiss extends Candidate {
  /** Always false — near-misses are never auto-accepted. */
  readonly autoAccepted: false;

  /**
   * The pipeline layer at which this candidate was rejected.
   * - 'structural'    — failed Stage 2 (structuralMatch returned false)
   * - 'strictness'    — failed Stage 3 (level / purity / threadSafety mismatch)
   * - 'property_test' — failed Stage 4 (reserved; v3.1; currently unused in v3)
   * - 'min_score'     — survived filter stages but combinedScore < QueryIntentCard.minScore
   */
  readonly failedAtLayer: 'structural' | 'strictness' | 'property_test' | 'min_score';

  /**
   * One-line human-readable explanation of why this candidate failed.
   * Example: "expected inputs: [number, string]; stored signature: [string, number]"
   * Example: "purity=sideEffecting but query requires pure"
   */
  readonly failureReason: string;
}
```

**Near-miss selection:** Near-misses are drawn from the Stage 1 K' candidates (pre-filter set),
sorted by `combinedScore` descending, up to `topK`. Candidates that would have passed all filter
stages but fall below `minScore` are also included as near-misses (with `failedAtLayer: 'min_score'`).

**LLM use of near-misses:** The LLM receives near-miss annotations and decides:
1. **Widen query** — relax a structural constraint (`signature`) or a strictness requirement
   (`nonFunctional`) and re-issue `findCandidatesByQuery`;
2. **Write glue** — use a near-miss atom that is close but not exactly matching (structural
   mismatch or strictness gap is small enough to bridge with a wrapper);
3. **Author a new atom** — no near-miss is close enough; the registry gap is real.

**Result envelope distinction:** The query result distinguishes "matched" candidates from
"near-miss" candidates. The exact envelope shape (separate field vs `result.kind` discriminator)
is pinned by the implementation WI (`WI-V3-DISCOVERY-IMPL-QUERY`). D3 commits the semantics: the
two lists are always separate; matched candidates are never mixed with near-misses in the same
output list; `CandidateNearMiss.autoAccepted` is always `false`.

**CLI surface:** In `--format json` mode, the JSON output includes both a `candidates` array (matched)
and a `near_misses` array (near-misses). Human-readable text output displays near-misses in a
labeled section after the main results. The CLI implementation is owned by `WI-V3-DISCOVERY-IMPL-CLI`.

**Why not refuse silently on 0 candidates:** Returning an empty array with no additional signal
removes the LLM's ability to self-correct. The LLM cannot distinguish "this capability does not
exist in the registry" from "the query constraints are too strict" without a rejection signal.
Near-miss annotations with `failedAtLayer` and `failureReason` provide exactly that signal.

---

## Alternatives considered

| Alternative | Status | Rejection rationale |
|---|---|---|
| (a) Combined embedding (concat all 5 dims into one 1,920-float vector) | Rejected (Q1) | Collapses `QueryIntentCard.weights` — the weight field becomes meaningless once all dimensions are pooled into one cosine. Undoes D1's design intent. |
| (b) RRF (`Σ w[d] / (k + rank[d])`, k=60) | Rejected for v1 (Q2); D5 trigger defined | RRF is distribution-agnostic and a useful alternative if per-dimension distance distributions have significantly different variance. For v1, weighted cosine is simpler, more interpretable, and honors the weight field correctly when dimensions have similar distributions. Worked example in Q2 shows RRF cannot separate A from B even when weights prefer one. D5 provides the empirical trigger to swap. |
| (c) Multiplicative score (product of per-dim similarities) | Rejected (Q1) | Zero-collapses atoms missing any queried dimension; non-interpretable; DEC-VECTOR-RETRIEVAL-003's rejection of multiplicative scoring applies here. |
| (d) Property-test depth as a score component (not a tiebreaker) | Rejected (Q4) | Would penalize newly registered atoms unfairly. Score should be a pure similarity metric; quality signals belong in the tiebreaker chain. v3.1 trigger documented. |
| (e) structuralScore folded into combinedScore (DEC-VECTOR-RETRIEVAL-003 pattern) | Rejected (Q5) | Breaks score interpretability in the 5-dimension setting. Structural matching is binary (a type either unifies or it doesn't); additive folding makes a structurally-mismatched atom appear as a "strong" candidate. Gating at Stage 2 + near-miss surfacing is the correct design. D5 revisit trigger documented. |
| (f) Stage 4 (property-test verification) live in v3 | Deferred (Q3) | DEC-VERIFY-010 is orthogonal; the infrastructure does not yet exist. The layer slot is reserved with an explicit no-op so that when v3.1 lands it, the stage numbering is stable. |
| (g) Refuse silently on 0 candidates (no near-miss surface) | Rejected (Q6) | Removes the LLM's ability to self-correct. Near-miss annotations with `failedAtLayer` are the LLM's signal to distinguish "registry gap" from "query too strict." |
| (h) `nonFunctional` strictness as a score component (not a filter gate) | Rejected (Q3) | Same argument as (e). Strictness is a binary requirement: the caller specifying `purity: pure` is stating a hard requirement, not a preference. A `sideEffecting` atom should never appear as a "confident" candidate for a pure-function query. Gate at Stage 3; surface as near-miss with `failedAtLayer: 'strictness'`. |

---

## When to revisit

- **Weighted cosine vs RRF:** D5 quality measurement WI reports per-dimension `cosineDistance`
  distribution variance is significantly non-uniform across the 5 dimensions, causing unstable
  ranking (a behavior-dimension tie at 0.70 has different competitive significance than a
  property-tests-dimension tie at 0.70). File a D3 revision to switch to normalized-within-dimension
  cosine or RRF at that point.
- **ε = 0.02 tiebreaker threshold:** D5 reports false-tie rate is too high (many candidates
  scoring within 0.02 of each other) or too low (tiebreaker chain never fires). Tune at that point.
- **Property-test depth as score component:** DEC-VERIFY-010 lands and property-test counts
  become SQL-accessible (a `property_test_count` column). At that point, evaluate moving
  property-test depth to a Stage 4 filter or a score component with explicit empirical justification
  from D5.
- **structuralScore re-folded into combinedScore:** D5 reports excess Stage 2 filtering (too many
  structural mismatches; callers would prefer score attenuation over binary exclusion). Evaluate
  multiplicative structural weight (NOT additive — see alternative (e) above).
- **Score band tuning (0.85 / 0.70 / 0.50):** D5 reports false-accept rate > 5% at any band, or
  recall penalty > 20% (good candidates excluded). Tune all three thresholds together from D5 data.
- **K' multiplier (max(K × 5, 50)):** If Stage 2 or Stage 3 filters consistently reduce K' to
  near-zero, increase the multiplier. The current value is a design target; D5 confirms it.
- **Stage 4 (property-test verification) activation:** DEC-VERIFY-010 ships with property-test
  execution infrastructure. File a D3 Stage 4 revision specifying the verification predicate,
  pass/fail semantics, and timeout budget.
- **Store/query text symmetry gap (open — WI-V3-DISCOVERY-IMPL-QUERY):** `DEC-VECTOR-RETRIEVAL-002`
  records the query-text derivation rule (`behavior + "\n" + params`), but `storeBlock` embeds
  `canonicalizeText(spec)` — the full canonical JSON of the entire SpecYak. This asymmetry was
  identified during D5 calibration work (WI-V3-DISCOVERY-CALIBRATION-FIX, issue #258) as the root
  cause of all correct top-1 hits producing cosineDistance in [1.02, 1.16] instead of the
  expected d < 0.5. The `1 - d/2` formula is correct; the distances are systematically above 1.0
  because query and storage vectors live in different text-space regions. Resolution: align
  `storeBlock`'s embedding text to match the query derivation in `WI-V3-DISCOVERY-IMPL-QUERY`.
  After that WI ships, re-run D5 and re-calibrate `M1_HIT_THRESHOLD` (likely back to 0.50+).
  See `DEC-V3-DISCOVERY-CALIBRATION-FIX-001` in `discovery-eval-helpers.ts`.

---

## Implementation phase boundary

D3 commits the design only. No source files are modified by this ADR.

The implementation WI for D3's ranking specification is `WI-V3-DISCOVERY-IMPL-QUERY` (named by
D1's and D2's Implementation phase boundary sections; D3 confirms this assignment and adds the
following D3-specific constraints):

1. **Per-dimension cosine via per-column `vec0` KNN** — preferred path (stays inside the existing
   sqlite-vec API surface). Implementation WI must verify installed `sqlite-vec` version supports
   per-column KNN before finalizing. Fallback: load vectors and compute cosine in TypeScript (same
   formula, different execution site).

2. **Zero-vector detection** — when reading per-dim columns, check for all-zero vectors using D1's
   NULL marker column (per-dim `_present BOOL`). Emit `null` for that dimension's `perDimensionScores`
   entry (never `0`). The `combinedScore` denominator excludes null-scored dimensions.

3. **Renormalize weights at query time** — over the surviving non-null dimension set. Never divide
   by zero (atom with no surviving dimensions → `combinedScore = 0`, excluded from ranking).

4. **ε = 0.02** — hardcoded at v3; tunable via D5 follow-up revision.

5. **`CandidateNearMiss` surface** — exposed on both CLI (`--format json` includes `near_misses`
   array) and programmatic API (separate field on result envelope; exact shape pinned by impl WI).

6. **`structuralMatch` reuse** — Stage 2 MUST call the existing `structuralMatch` from
   `packages/registry/src/search.ts`; do not reimplement type unification.

7. **`findCandidatesByIntent` coexistence** — `findCandidatesByIntent` is unchanged by the
   implementation WI. The back-compat decision (deprecate, alias, or wrap) is owned by the
   implementation WI but must not break existing callers without an explicit documented migration path.

---

## References

- Issue #153 (this work item — V3-DISCOVERY-D3)
- Issue #152 (D2 — V3-DISCOVERY-D2)
- Issue #151 (D1 — V3-DISCOVERY-D1)
- Issue #150 (parent initiative — WI-V3-DISCOVERY-SYSTEM)
- `DEC-V3-DISCOVERY-D3-001` (`MASTER_PLAN.md`) — This decision log entry
- `DEC-V3-DISCOVERY-D2-001` (`MASTER_PLAN.md`) — Query language / API surface (D2)
- `DEC-V3-DISCOVERY-D1-001` (`MASTER_PLAN.md`) — Multi-dimensional embedding schema (D1)
- `DEC-VECTOR-RETRIEVAL-001` (`packages/registry/src/index.ts`) — Public vector-search surface on Registry interface
- `DEC-VECTOR-RETRIEVAL-002` (`packages/registry/src/index.ts`) — Query-text derivation rule for `findCandidatesByIntent`
- `DEC-VECTOR-RETRIEVAL-003` (`packages/registry/src/index.ts`) — Structural rerank scoring formula (coexisting path; D3 differs intentionally)
- `DEC-VECTOR-RETRIEVAL-004` (`packages/registry/src/index.ts`) — `IntentQuery` is a local structural type (circular-dep avoidance)
- `DEC-VERIFY-010` (`VERIFICATION.md`) — L1+ behavioral embedding via sandbox execution (Stage 4 trigger; v3.1 boundary)
- `DEC-EMBED-010` (`MASTER_PLAN.md`) — Local embeddings via `transformers.js`, provider interface
- `DEC-CI-OFFLINE-001` (`MASTER_PLAN.md`) — Single canonical offline-embedding-provider authority
- `packages/registry/src/index.ts` — Registry interface, `CandidateMatch`, `IntentQuery`, `FindCandidatesOptions` (lines 254–464)
- `packages/registry/src/storage.ts:540-700` — Current `findCandidatesByIntent` implementation (coexisting path)
- `packages/registry/src/search.ts` — `structuralMatch` (Stage 2 reuse target for implementation WI)
- `packages/registry/src/schema.ts` — `test_history`, `runtime_exposure`, `BlockTripletRow` table shapes (tiebreaker field sources)
