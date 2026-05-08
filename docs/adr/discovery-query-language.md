# DEC-V3-DISCOVERY-D2-001 — Query language / API surface for v3 discovery

**Status:** Accepted (D2 design phase; implementation deferred to v3 implementation initiative)
**Date:** 2026-05-08
**Issue:** https://github.com/cneckar/yakcc/issues/152
**Initiative:** WI-V3-DISCOVERY-SYSTEM (D2 of 6)

---

## Context

D1 (`docs/adr/discovery-multi-dim-embeddings.md`, `DEC-V3-DISCOVERY-D1-001`) established the
storage schema for multi-dimensional embeddings: 5 `FLOAT[384]` columns in a `sqlite-vec` `vec0`
virtual table (`contract_embeddings`), keyed on `spec_hash`, using `Xenova/all-MiniLM-L6-v2`.
Each column encodes a separate semantic axis of a SpecYak spec:

| Storage column | SpecYak source |
|---|---|
| `embedding_behavior` | `spec.behavior` |
| `embedding_guarantees` | `spec.guarantees[*].description` + preconditions/postconditions/invariants |
| `embedding_error_conditions` | `spec.errorConditions[*].description` |
| `embedding_non_functional` | `spec.nonFunctional` serialized |
| `embedding_property_tests` | `spec.propertyTests[*].description` |

D1 left open two questions explicitly deferred to D2/D3:

1. **Composition rule for primary auto-derived and opt-in LLM-derived texts** — D2 defers this to
   D3 (ranking algorithm WI). D2's scope is the query schema, not the index-side enrichment path.
2. **How zero-vector dimensions are handled in the query planner** — resolved here (see Q1 below).

D2's scope is the *query surface*: what shape an LLM-facing caller provides, how that maps to
per-dimension embeddings, how results are returned, what CLI flags expose the surface, what the
programmatic API looks like, how iterative refinement is handled, and what confidence threshold
triggers auto-accept.

---

## Boundary with D1

| Domain | Authority | ADR |
|---|---|---|
| Storage schema (5 vectors, model, column names, migration 7) | D1 | `docs/adr/discovery-multi-dim-embeddings.md` |
| Query surface (LLM-facing schema, CLI flags, programmatic API, confidence thresholds, iteration) | D2 (this ADR) | `docs/adr/discovery-query-language.md` |
| Ranking algorithm formula, D5 quality triggers | D3 | TBD |

Neither ADR overrides the other. If a future WI requires both storage and query changes, each must
be updated in its owning ADR.

---

## Decision

### Q1: Query schema — `QueryIntentCard`

**Decision:** A separate `QueryIntentCard` TypeScript interface, distinct from the storage
`SpecYak`, defines the LLM-facing query surface.

**Why a separate schema?** The storage `SpecYak` type (in `packages/contracts/src/spec-yak.ts`)
carries structured ids, required fields, and rich typing that serve registry integrity. The
query surface must:

- Be smaller (no `id`, no `hash`, no `strictness`, no proof fields)
- Accept freeform descriptions (the LLM has no obligation to supply structured ids)
- Allow partial subset of dimensions (querying on behavior only is a valid use case)
- Express per-dimension weights and retrieval controls

**Final `QueryIntentCard` TypeScript interface:**

```typescript
interface QueryTypeSignatureParam {
  name?: string;       // optional: caller may not know argument names
  type: string;        // required: type string (e.g. "number", "string[]")
}

interface QueryIntentCard {
  // Dimension fields — each is optional; omitting a field skips that dimension at query time
  behavior?:         string | undefined;
  guarantees?:       string[] | undefined;       // freeform descriptions (no id required)
  errorConditions?:  string[] | undefined;       // freeform descriptions (no errorType required)
  nonFunctional?:    Partial<NonFunctionalProperties> | undefined;  // any subset accepted
  propertyTests?:    string[] | undefined;       // freeform descriptions (no id/arbitraries required)
  signature?: {
    inputs?:  QueryTypeSignatureParam[] | undefined;
    outputs?: QueryTypeSignatureParam[] | undefined;
  } | undefined;

  // Retrieval controls
  weights?: {
    behavior?:        number | undefined;
    guarantees?:      number | undefined;
    errorConditions?: number | undefined;
    nonFunctional?:   number | undefined;
    propertyTests?:   number | undefined;
  } | undefined;
  topK?:      number | undefined;    // default: 10
  minScore?:  number | undefined;    // optional; if set, candidates below this combinedScore are excluded
}
```

**Per-field reconciliation against storage `SpecYak` shape:**

| Field | Storage `SpecYak` shape | Query `QueryIntentCard` shape | Shape difference |
|---|---|---|---|
| `behavior` | `string \| undefined` | `string \| undefined` | Identical |
| `guarantees` | `ReadonlyArray<{ id: string; description: string }>` | `string[] \| undefined` | **Simplified**: query uses freeform description strings only; storage structured id+description. The query planner concatenates description text per D1's embedding concatenation rule. |
| `errorConditions` | `ReadonlyArray<{ description: string; errorType?: string }>` | `string[] \| undefined` | **Simplified**: query drops `errorType`; freeform description strings only. |
| `nonFunctional` | `{ time?, space?, purity: string, threadSafety: string }` (purity + threadSafety required) | `Partial<NonFunctionalProperties> \| undefined` | **Deviation documented**: query accepts any subset including queries that omit `purity`/`threadSafety`. The query planner MUST NOT enforce `purity`/`threadSafety` presence — those are storage-side requirements. |
| `propertyTests` | `ReadonlyArray<{ id: string; description: string; arbitraries?: string[] }>` | `string[] \| undefined` | **Simplified**: query uses freeform description strings; drops id and arbitraries. This is required to make D1's 5th dimension (`embedding_property_tests`) reachable at query time. |
| `signature` | `{ inputs: SpecYakParameter[]; outputs: SpecYakParameter[] }` where `SpecYakParameter = { name: string; type: string; description? }` | `{ inputs?: QueryTypeSignatureParam[]; outputs?: QueryTypeSignatureParam[] }` where `QueryTypeSignatureParam = { name?: string; type: string }` | **Refined**: `name` is optional at query time (caller may not know argument names); `type` remains required. `description` is dropped at query time (not used in structural matching for the query planner). `signature` stays outside the 5 embedding dimensions per D1 — it is structural, not semantic. |

**Weights map key convention:** The `weights` keys (`behavior`, `guarantees`, `errorConditions`,
`nonFunctional`, `propertyTests`) mirror SpecYak field names (no `embedding_` prefix in the
LLM-facing surface). The query planner maps query field names to storage column names internally
(`behavior` → `embedding_behavior`, etc.), keeping the LLM-facing schema clean while preserving
the storage contract.

**Per-dimension presence rule (D1 inheritance):**

Omitting a dimension field in `QueryIntentCard` has the same semantics as D1's zero-vector rule:
that dimension is **skipped at scoring time**. The implementation MUST NOT score a dimension when
the query field is absent or empty. This prevents false rank inflation from an absent dimension
accidentally matching stored zero vectors.

For `nonFunctional` and `signature`: absent means undefined/null, not an empty struct.

**Zero-vector dimension score:** When a dimension has a zero vector in storage (D1's fallback for
absent SpecYak fields), the per-dimension score for that dimension is `null` (not `0`), and `null`
dimensions are excluded from the weighted sum. This distinction prevents a query that includes a
dimension from spuriously matching atoms whose specs did not populate that dimension.

**`topK` and `minScore` defaults:**

- `topK`: 10 (matching the current `FindCandidatesOptions.k` default in `@yakcc/registry`)
- `minScore`: no default; if omitted, all top-K candidates are returned regardless of score

---

### Q2: CLI surface — extend `yakcc query`

**Decision: Path A — extend the existing `yakcc query` command.**

Three paths were evaluated:

| Path | Description | Verdict |
|---|---|---|
| **A — extend `yakcc query`** | Add per-dimension flags, weight flags, `--min-score`, `--format=json`, `--auto-accept` to the existing command | **Chosen** |
| **B — add `yakcc resolve`** | New command per #152's literal text | **Rejected** |
| **C — replace `yakcc query` with `yakcc resolve`** | Rename + replace | **Rejected** |

**Rationale for Path A:**

- The existing `yakcc query` command (DEC-CLI-QUERY-001) was already designed for semantic
  vector-search and is the correct home for multi-dimensional query capability.
- Adding `yakcc resolve` would introduce a third near-synonym verb alongside the already-similar
  `yakcc search` (structural) and `yakcc query` (semantic). Two verbs for two retrieval strategies
  is already at the cognitive limit for a discovery CLI surface.
- Path C breaks scripts that already use `yakcc query`. Rejected.
- Path B is rejected unless Path A's flag surface grows beyond ~12 flags, at which point a
  sub-command group (e.g. `yakcc query multi`) should be evaluated.

**Rejection trigger for Path B (document for future planners):** If Path A's total flag count
exceeds ~12, revisit the sub-command group option rather than adding `yakcc resolve`.

**New flags added to `yakcc query`:**

| Flag | Type | Description |
|---|---|---|
| `--behavior <text>` | string | Dimension override: sets the behavior dimension query text (replaces the free-text positional for behavior-only queries) |
| `--guarantee <text>` | string (repeatable) | One guarantee description to include in the guarantees dimension query |
| `--error <text>` | string (repeatable) | One error condition description to include in the error conditions query |
| `--non-functional <key=value>` | string (repeatable) | Non-functional property entry (e.g. `purity=pure`) |
| `--property-test <text>` | string (repeatable) | One property test description for the property tests query |
| `--weight-behavior <n>` | float | Relative weight for the behavior dimension (default: equal weight) |
| `--weight-guarantees <n>` | float | Relative weight for the guarantees dimension |
| `--weight-error-conditions <n>` | float | Relative weight for the error conditions dimension |
| `--weight-non-functional <n>` | float | Relative weight for the non-functional dimension |
| `--weight-property-tests <n>` | float | Relative weight for the property tests dimension |
| `--query <json-path>` | string | Path to a JSON file containing a `QueryIntentCard` (supersedes `--card-file`; `--card-file` remains as an alias for backward compatibility) |
| `--format json` | string | Output format; `json` emits a JSON array of candidates (default: human-readable text) |
| `--min-score <n>` | float | Minimum `combinedScore` threshold; candidates below this are excluded |
| `--auto-accept` | boolean | Automatically accept the top-1 candidate when `combinedScore > 0.85` AND gap-to-top-2 > 0.15 (see Q5) |

**Backward compatibility guarantee:**

`yakcc query <free-text>` (free-text positional, no new flags) retains its current behavior:
behavior-dimension-only query via `findCandidatesByIntent`. No existing scripts break.

The existing `--top`, `--rerank`, `--registry`, `--card-file` flags remain and retain their
current semantics.

**Worked examples (per #152 acceptance criteria):**

1. **Simple free-text (unchanged behavior):**
   ```
   yakcc query "parse integer from string"
   ```
   Produces: behavior-dimension-only query, top-10 results, human-readable output.

2. **Multi-dimension:**
   ```
   yakcc query \
     --behavior "validate email address" \
     --guarantee "returns false for empty string" \
     --guarantee "returns true for valid RFC 5322 address" \
     --error "throws TypeError when input is not a string"
   ```
   Produces: 3-dimension query (behavior + 2 guarantees + 1 error condition), equal weights.

3. **Weighted multi-dimension:**
   ```
   yakcc query \
     --behavior "sort array of numbers ascending" \
     --property-test "sorted output equals input permutation" \
     --weight-behavior 0.3 \
     --weight-property-tests 0.7
   ```
   Produces: 2-dimension query with explicit 30%/70% weight split.

4. **JSON input:**
   ```
   yakcc query --query path/to/query.json --format json
   ```
   Where `query.json` is a `QueryIntentCard` JSON file. Produces: multi-dimension query per the
   JSON card; output is a JSON array of `Candidate` objects.

5. **Auto-accept with JSON output:**
   ```
   yakcc query \
     --behavior "compute SHA-256 hash of a byte array" \
     --guarantee "output is 32 bytes for any input length" \
     --auto-accept \
     --format json
   ```
   If `combinedScore > 0.85` and gap > 0.15: emits a single-item JSON array and exits 0.
   Otherwise: emits all candidates for LLM inspection.

---

### Q3: Programmatic API

**Decision:**

Add `Registry.findCandidatesByQuery(query: QueryIntentCard, options?: FindCandidatesOptions): Promise<readonly Candidate[]>`
to the `Registry` interface in `@yakcc/registry`.

**New types:**

```typescript
/**
 * Per-dimension score map for a Candidate result.
 * A dimension is absent (undefined) when the query did not include that dimension,
 * OR when the stored atom has a zero vector for that dimension (D1's absent-dimension fallback).
 * This lets callers distinguish "queried but no signal" from "not queried".
 */
interface PerDimensionScores {
  behavior?:        number | undefined;
  guarantees?:      number | undefined;
  errorConditions?: number | undefined;
  nonFunctional?:   number | undefined;
  propertyTests?:   number | undefined;
}

/**
 * A candidate returned by findCandidatesByQuery().
 * Extends CandidateMatch (cosineDistance, structuralScore) with multi-dimensional scores.
 */
interface Candidate extends CandidateMatch {
  /** Per-dimension cosine similarity scores (0 = orthogonal, 1 = identical direction). */
  readonly perDimensionScores: PerDimensionScores;
  /**
   * Weighted sum of per-dimension scores.
   * Range: [0, 1]. Higher = more similar to the query across all queried dimensions.
   * The exact formula (normalization of cosineDistance, weight combination) is specified
   * by D3 (ranking algorithm WI). D2 establishes only the shape.
   */
  readonly combinedScore: number;
}
```

**Package placement:** `@yakcc/registry` — same package as `findCandidatesByIntent`.

Rationale: placing `findCandidatesByQuery` in a new `@yakcc/discovery` package is rejected for v3
because no concrete circular dependency has been demonstrated. The existing `findCandidatesByIntent`
method lives in `@yakcc/registry`, and `@yakcc/shave` depends on `@yakcc/registry` (not the
reverse) per DEC-VECTOR-RETRIEVAL-004. A new `@yakcc/discovery` package between them would require
`@yakcc/registry` to import from it or vice versa, risking the same circularity DEC-VECTOR-RETRIEVAL-004
already navigates. The implementation WI may revisit placement if a concrete circularity emerges;
if so, file a follow-up decision (DEC-V3-DISCOVERY-D2-002 or successor).

**Back-compat relationship with `findCandidatesByIntent`:**

`findCandidatesByIntent` remains on the `Registry` interface. A `QueryIntentCard` with only
`behavior` set and no other dimensions specified is semantically equivalent to calling
`findCandidatesByIntent` with a behavior-only `IntentQuery`. Whether to deprecate, alias, or
wrap `findCandidatesByIntent` is a runtime decision for the implementation WI (`WI-V3-DISCOVERY-IMPL-QUERY`).
D2 records the constraint: callers using `findCandidatesByIntent` must not be broken without
an explicit deprecation path and a major-version bump or clearly documented migration.

**Score normalization constraint (deferred to D3):**

`cosineDistance` is in [0, 2] (lower = more similar); `structuralScore` is in [0, 1] (higher =
more similar). The `combinedScore` formula must normalize `cosineDistance` before combining it
with dimension weights. D2 establishes that `combinedScore` is in [0, 1] and is a weighted sum,
but the exact normalization is D3's responsibility. The implementation WI must not ship an
un-normalized formula.

**Deferred to v3.1+:**

- WASM `host_resolve` syscall — requires the WASM_HOST_CONTRACT v3 host link protocol, which does
  not exist yet. Out of scope for v3.
- HTTP `POST /resolve` endpoint — federation HTTP surface for multi-dim query. Deferred to v3.1+.

---

### Q4: Iterative refinement

**Decision: Stateless.** Each `findCandidatesByQuery` call is independent. No server-side
conversation state.

The LLM already holds refinement context in its own context window. Adding server-side session
state would couple the registry to an LLM conversation lifecycle, creating a stateful service
dependency with unclear cleanup semantics. If the LLM wants to refine a query, it issues a new
`findCandidatesByQuery` call with updated weights or dimension texts.

**Trigger to revisit:** If D5's quality measurement surfaces that N+1 iteration overhead
(re-embedding each refined query) is a measurable bottleneck, reconsider caching query embeddings
per-session. That decision belongs to D5's measurement WI.

---

### Q5: Confidence thresholds

**Decision:**

Auto-accept top-1 when **all** of the following hold:
1. `combinedScore > 0.85`
2. Gap between top-1 and top-2 `combinedScore` > 0.15

When the auto-accept condition is met, the implementation:
- Treats top-1 as the resolved candidate without further LLM confirmation
- CLI (`--auto-accept`): emits only the top-1 result and exits 0
- Programmatic API: marks the returned `Candidate` with an `autoAccepted: true` flag (shape deferred to D3/implementation WI)

The 0.85 / 0.15 threshold pair matches #152's recommendation. Both thresholds are tunable
per-query:

- CLI: `--auto-accept` enables the behavior; `--min-score` sets the minimum `combinedScore`
  for inclusion (not the auto-accept threshold directly; auto-accept thresholds are fixed in the
  implementation phase per D3 data)
- Programmatic API: auto-accept options follow `FindCandidatesOptions` extension (shape defined
  by implementation WI)

**Trigger to revisit:** D5's quality measurement WI is the primary source for threshold tuning.
If D5 reports false-accept rate > 5% at the 0.85/0.15 pair, tighten the thresholds. If it
reports recall penalty > 20% (good candidates missed), relax them. Do not adjust thresholds
without D5 data.

---

### Cross-provider rejection invariant

**Decision:** The embedding provider at query time MUST be the same provider that was used to
write the index.

Cross-provider queries (registry written with `Xenova/all-MiniLM-L6-v2`, queried with a different
model) produce vectors in incompatible semantic spaces — cosine distance is meaningless across
models. The query planner implementation MUST detect and reject cross-provider queries at setup
time, not silently return garbage results.

This invariant is established by DEC-EMBED-010 (provider interface) and DEC-CI-OFFLINE-001
(offline BLAKE3 provider). The registry stores the embedding model ID alongside the vectors;
the query planner must verify that the runtime provider's `modelId` matches the stored model ID
before running a KNN query.

Failure mode: loud error (`Error: query-time embedding provider "X" does not match registry provider "Y"; aborting`), not silent fallback.

---

## Alternatives considered

| Question | Rejected alternative | Rejection rationale |
|---|---|---|
| Q1 schema | Keep storage `SpecYak` shape as the query type | LLM callers cannot construct structured `{ id: string; description: string }` arrays reliably; the query surface should accept freeform text and perform the structural mapping internally. |
| Q1 schema | Require `purity`/`threadSafety` on `nonFunctional` at query time | Query time is not the right enforcement point for storage-integrity requirements. A query for "pure functions" should be expressible as `{ purity: "pure" }` without also requiring a `threadSafety` value. |
| Q1 schema | Omit `propertyTests` from query schema | D1's 5th dimension (`embedding_property_tests`) would be unreachable at query time. |
| Q2 CLI | Path B: add `yakcc resolve` | Introduces a third near-synonym verb; forces deprecation work later; no functional advantage over extending `yakcc query`. |
| Q2 CLI | Path C: replace `yakcc query` with `yakcc resolve` | Breaks existing scripts. |
| Q3 API | New `@yakcc/discovery` package | No demonstrated circularity at v3 scope. Splitting adds a package boundary without resolving a real dependency problem. Revisit if a concrete circularity emerges (file DEC-V3-DISCOVERY-D2-002). |
| Q3 API | `findCandidates(query: QueryIntentCard)` naming | Shadows `findCandidatesByIntent` semantically; the name does not distinguish an intent-card from a multi-dimensional query. `findCandidatesByQuery` makes the surface difference explicit. |
| Q3 API | Structured guarantees/propertyTests in query | Requires the LLM to generate `{ id: string; description: string }` entries; id is meaningless at query time. Freeform strings are the right query-time interface. |
| Q4 iteration | Stateful session on the server | Creates a stateful service dependency with unclear lifecycle. The LLM already holds iteration context; no registry-side session needed. |
| Q5 thresholds | Fixed non-configurable thresholds | LLM callers may have context-specific confidence requirements. Thresholds should be tunable per-call; D5 provides the data for default calibration. |

---

## When to revisit

- **Path A CLI flag ceiling:** If the `yakcc query` flag count grows beyond ~12, evaluate a
  sub-command group (e.g. `yakcc query multi`) rather than continuing to add flags.
- **Query schema growth:** If `QueryIntentCard` needs fields beyond v3.1 scope (e.g. WASM
  execution constraints, federation-specific routing hints), file a D2 revision rather than
  silently extending the interface.
- **Confidence threshold calibration:** D5 quality measurement WI. Trigger conditions documented
  in Q5 above.
- **`@yakcc/discovery` package question:** If `WI-V3-DISCOVERY-IMPL-QUERY` hits a real circular
  dependency (e.g. per-dimension scoring needs a `@yakcc/shave` import), revisit package placement
  and file DEC-V3-DISCOVERY-D2-002.
- **`findCandidatesByIntent` deprecation:** Implementation WI (`WI-V3-DISCOVERY-IMPL-QUERY`)
  owns the runtime decision (deprecate, alias, or wrap). D2 constrains: no breaking changes
  without a documented migration path.
- **D3 composition rule:** Once D3 ships the ranking algorithm and normalization formula,
  `combinedScore`'s precise computation is pinned. Any change to the formula after D3 lands
  requires a D3 ADR revision.

---

## Implementation phase boundary

D2 commits the design only. No source files are modified by this ADR.

Follow-up implementation work items (named here for navigability; unblocked once D2 lands):

- **`WI-V3-DISCOVERY-IMPL-QUERY`** — Add `QueryIntentCard` type, `Candidate` type, and
  `Registry.findCandidatesByQuery(query, options)` to `@yakcc/registry`. Implement the
  per-dimension query planner: embed per non-absent dimension, run KNN per dimension, aggregate
  with weighted sum, apply `minScore` filter, apply cross-provider invariant check. Handle
  zero-vector dimension skip per D1's absent-dimension rule. Back-compat decision for
  `findCandidatesByIntent` made in this WI's implementation slice.

- **`WI-V3-DISCOVERY-IMPL-CLI`** — Extend `packages/cli/src/commands/query.ts` with the per-
  dimension flags, weight flags, `--query`, `--format`, `--min-score`, and `--auto-accept` flags
  described in Q2. The free-text positional path continues to call `findCandidatesByIntent` (or
  the back-compat wrapper) unchanged.

- **`WI-V3-DISCOVERY-IMPL-API`** (optional separate WI if API work is large enough) — Surface
  `findCandidatesByQuery` in any federation HTTP surface or WASM host link protocol that matures
  to v3.1.

Cross-reference: D1's "Implementation phase boundary" section also names `WI-V3-DISCOVERY-IMPL-QUERY`
and `WI-V3-DISCOVERY-IMPL-CLI` as the implementation owners. D2 confirms these assignments and
adds the implementation constraints above.

---

## References

- Issue #152 (this work item — V3-DISCOVERY-D2)
- Issue #151 (D1 — V3-DISCOVERY-D1)
- Issue #150 (parent initiative — WI-V3-DISCOVERY-SYSTEM)
- `DEC-V3-DISCOVERY-D1-001` (`MASTER_PLAN.md`) — Multi-dimensional embedding schema (D1)
- `DEC-V3-DISCOVERY-D2-001` (`MASTER_PLAN.md`) — This decision log entry
- `DEC-VECTOR-RETRIEVAL-001` (`packages/registry/src/index.ts`) — Public vector-search surface on Registry interface
- `DEC-VECTOR-RETRIEVAL-002` (`packages/registry/src/index.ts`) — Query-text derivation rule for `findCandidatesByIntent`
- `DEC-VECTOR-RETRIEVAL-003` (`packages/registry/src/index.ts`) — Structural rerank scoring formula
- `DEC-VECTOR-RETRIEVAL-004` (`packages/registry/src/index.ts`) — `IntentQuery` is a local structural type (circular-dep avoidance)
- `DEC-CLI-QUERY-001` (`packages/cli/src/commands/query.ts`) — `yakcc query` command — vector-search CLI surface
- `DEC-CLI-SEARCH-001` (`packages/cli/src/commands/search.ts`) — `yakcc search` command — structural linear-scan CLI surface
- `DEC-EMBED-010` (`MASTER_PLAN.md`) — Local embeddings via `transformers.js`, provider interface
- `DEC-CI-OFFLINE-001` (`MASTER_PLAN.md`) — Single canonical offline-embedding-provider authority
- `packages/contracts/src/spec-yak.ts` — `SpecYak` interface (optional v0-lift fields, lines 143–176)
- `packages/registry/src/index.ts` — `findCandidatesByIntent`, `IntentQuery`, `CandidateMatch`, `FindCandidatesOptions` (lines 254–464)
- `packages/cli/src/commands/query.ts` — Current `yakcc query` implementation (DEC-CLI-QUERY-001)
- `packages/cli/src/commands/search.ts` — Current `yakcc search` implementation (DEC-CLI-SEARCH-001)
