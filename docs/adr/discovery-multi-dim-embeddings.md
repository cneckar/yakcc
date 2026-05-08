# DEC-V3-DISCOVERY-D1-001 — Multi-dimensional embedding schema for atom discovery

**Status:** Accepted (D1 design phase; implementation deferred to v3 implementation initiative)
**Date:** 2026-05-08
**Issue:** https://github.com/cneckar/yakcc/issues/151
**Initiative:** WI-V3-DISCOVERY-SYSTEM (D1 of 6)

---

## Context

Today's `createLocalEmbeddingProvider` (model: `Xenova/all-MiniLM-L6-v2`, 384 dimensions,
defined in `packages/contracts/src/embeddings.ts`) embeds the *whole canonicalized SpecYak
as one string* before storing it in `contract_embeddings` (the `vec0` virtual table in
`packages/registry/src/schema.ts`, migration 2, `SCHEMA_VERSION=6`).

A query like "find atoms with this BEHAVIOR" and a query like "find atoms with these
GUARANTEES" produce roughly-similar vectors from a single-vector representation because both
draw from the same pooled embedding. V3-DISCOVERY-SYSTEM (#150 parent initiative) requires
per-dimension precision so that LLM-facing atom discovery can weight different semantic axes
independently. DEC-EMBED-010 established the provider interface and local-first stance; this
decision extends that infrastructure to a multi-dimensional shape without replacing it.

---

## Boundary with DEC-VERIFY-010

DEC-VERIFY-010 (L1+ behavioral embedding via sandbox execution) is **orthogonal** to this
decision. The distinction is:

- **D1 (this ADR):** Embeds *declared* IntentCard text — what the spec *says* the atom does.
  Source: SpecYak optional fields (`behavior`, `guarantees`, etc.). Derivation: text → embedding
  at atom-registration time. These are L0 *textual* embeddings.
- **DEC-VERIFY-010:** Embeds *executed* sandbox traces — what the atom *actually does* on
  synthetic inputs. Source: sandbox execution results. Derivation: trace → embedding at
  verification time. These are L1+ *behavioral* embeddings.

They serve different query shapes (declared semantics vs runtime behavior) and may both be
present per atom in v3.1. D1 does not preclude DEC-VERIFY-010. The multi-column `vec0` storage
shape (Q4 below) is designed to accommodate additional embedding columns — including L1+
behavioral embedding columns from DEC-VERIFY-010 — alongside the 5 declared-semantic columns
described here. A future v3.1 WI adding DEC-VERIFY-010 columns to migration 7 requires no
architectural change to the D1 schema; it extends the same `vec0` virtual table with new
`FLOAT[384]` columns.

---

## Decision

### Q1: Dimensions — which SpecYak fields get separately embedded?

**Decision:** 5 vectors per atom:

| Column name | SpecYak source | Concatenation rule |
|---|---|---|
| `embedding_behavior` | `spec.behavior` | Embed the string directly |
| `embedding_guarantees` | `spec.guarantees[*].description` + `spec.preconditions` + `spec.postconditions` + `spec.invariants` | Join all assertion strings with `\n` (preconditions → postconditions → invariants → guarantee descriptions) |
| `embedding_error_conditions` | `spec.errorConditions[*].description` | Join descriptions with `\n` |
| `embedding_non_functional` | `spec.nonFunctional` | Serialize to `"purity: {p} | threadSafety: {t} | time: {tm} | space: {sp}"` |
| `embedding_property_tests` | `spec.propertyTests[*].description` | Join descriptions with `\n` |

**Excluded from embedding — structural, not semantic:**

- `signature` (`inputs`, `outputs`): type shapes belong to type-unification at query time, not
  to similarity search. Query "find atoms with this input/output shape" should use type algebra,
  not cosine similarity on embedded type-hint strings.

**Preconditions / postconditions / invariants folded into guarantees (v1):**

These required SpecYak fields encode the contract's assertion structure. For v1 they fold into
the `embedding_guarantees` vector (concatenation order stated above) rather than forming a
separate sixth `assertions` vector. The folding rationale: (a) these fields constitute the same
semantic claim as `guarantees` — what the atom promises to hold; (b) separating them would add
a sixth dimension without a proven query-quality gain; (c) D5's measurement methodology will
surface whether a separate assertions vector improves recall. Trigger to revisit: D5 reports a
query category that cannot be answered well from the combined guarantees+assertions vector.

**Absent-dimension fallback (planner calibration a):**

All 5 source dimensions are *optional* on `SpecYak` (per `packages/contracts/src/spec-yak.ts`,
lines 143–176). New specs are not required to populate them. An absent or empty source field
yields a **zero vector** for that dimension (all floats set to 0.0) stored in the corresponding
`FLOAT[384]` column. A NULL marker column (separate boolean or sentinel) allows query-time
filtering: similarity scoring MUST skip zero-vector dimensions in per-dimension cosine similarity
to avoid false rank inflation from zero-vector matches. D2 (query language) inherits this
constraint and must document how zero-vector dimensions are handled in its query planner.

### Q2: Model — one model or per-dimension models?

**Decision:** Same `Xenova/all-MiniLM-L6-v2` model for all 5 dimensions (DEC-EMBED-010 provider,
384 dimensions, deterministic ONNX runtime, MIT license).

**Rationale:**

- Zero new model dependencies and zero new download surface (offline BLAKE3 fallback in
  `createOfflineEmbeddingProvider()` extends naturally to multi-dimensional calls by hashing
  per-dimension input streams independently).
- The existing `EmbeddingProvider` interface (`{ dimension, modelId, embed(text): Float32Array }`)
  in `packages/contracts/src/embeddings.ts` needs no breaking change — only an additive
  multi-dimensional caller that calls `embed()` once per non-absent dimension.
- Determinism guarantee: same SpecYak → same 5 vectors, byte-for-byte, across runs (modulo
  the existing ONNX backend determinism caveat in the current single-vector implementation).

**Deferral note:** Per-dimension models (e.g. a code-trained model for `embedding_property_tests`,
a natural-language model for `embedding_behavior`) are deferred to v3.1. Trigger: D5 reports that
one dimension's recall is significantly below the others when the same model is used across all.

### Q3: Generation pipeline — how are embeddings produced at atom-time?

**Decision:** Auto-from-IntentCard primary; opt-in LLM-derived enrichment as a secondary
annotation pass.

**Auto-from-IntentCard (primary):**
The `storeBlock` path in `packages/registry/src/storage.ts` calls `generateEmbedding(spec, provider)`
unconditionally on every insert (line 233 as of SCHEMA_VERSION=6). The multi-dim implementation
extends this to `generateMultiDimEmbedding(spec, provider)` → one `Float32Array` per dimension,
stored in the 5 `embedding_*` columns. This preserves the v0.6 invariant: "spec.yak in,
BlockMerkleRoot out, no human in the loop after authoring."

**Opt-in LLM-derived enrichment (secondary):**
For high-value atoms where the auto-derived texts are sparse or low-quality, an optional LLM
annotation pass can produce richer per-dimension input texts. These flow through the same
`generateMultiDimEmbedding()` path — the multi-dim provider does not distinguish auto-derived
from LLM-derived text. The annotation pass lives *outside* the `storeBlock` inner loop and is
triggered explicitly (CLI verb or offline enrichment job), not at every insert.

**Manual annotation:** Deferred indefinitely. The authoring friction is not justified at the
current corpus size (1,773 atoms).

**Open question deferred to D2/D3:** Composition rule for primary auto-derived and opt-in LLM
texts when both are present for the same dimension. Options: concatenation, separate sub-vectors,
weighted average. Each has different recall behavior. D2 (query language) or D3 (LLM-enrichment
pipeline) MUST resolve this before the LLM-enrichment pass is implemented.

### Q4: Storage shape — multi-column vs multi-row sqlite-vec?

**Decision:** Multi-column `sqlite-vec` `vec0` virtual table — one `FLOAT[384]` column per
dimension, keyed on `spec_hash TEXT PRIMARY KEY` (preserving the existing schema semantics).

**Multi-column shape:**
```sql
CREATE VIRTUAL TABLE contract_embeddings USING vec0(
  spec_hash         TEXT PRIMARY KEY,
  embedding_behavior          FLOAT[384],
  embedding_guarantees        FLOAT[384],
  embedding_error_conditions  FLOAT[384],
  embedding_non_functional    FLOAT[384],
  embedding_property_tests    FLOAT[384]
);
```

**Rationale:**
- Single-row read per spec_hash lookup (no JOIN or GROUP BY needed).
- Multi-column `vec0` is the natural extension of the current single-column `vec0` shape (migration
  2). The implementation phase MUST verify multi-column `FLOAT[N]` support against the installed
  `sqlite-vec` version in `packages/registry/package.json` before finalizing migration 7.
- Preserves the existing `spec_hash PK` semantics: two blocks sharing a spec share embeddings
  (DEC-TRIPLET-IDENTITY-020, `packages/contracts/src/spec-yak.ts`).

**sqlite-vec `vec0` does NOT support `ALTER TABLE ADD COLUMN` (planner calibration b):**
Migration 7 must be a **clean re-create** — drop the existing `contract_embeddings` virtual table
and recreate it with all 5 embedding columns plus the original `embedding` column removed. The
migration shape:
1. Read all existing `(spec_hash, embedding)` rows from the current single-column table.
2. Drop `contract_embeddings`.
3. Recreate `contract_embeddings` with the 5-column shape.
4. Repopulate: re-embed each spec to generate all 5 dimension vectors (lazy repopulation pass).
   Atoms with absent SpecYak optional fields get zero vectors in the corresponding columns.

This mirrors migration 2's pattern (`drop if exists + create`). The re-embedding sweep is
tractable at 1,773 atoms with the local `Xenova/all-MiniLM-L6-v2` provider (~10 min on a laptop)
or seconds with the offline BLAKE3 provider (DEC-CI-OFFLINE-001). CI gates MUST use the offline
provider per DEC-CI-OFFLINE-001.

**Multi-row alternative (rejected for v1):**
Multi-row (`spec_hash, dimension_name, embedding`) would allow `ALTER TABLE ADD COLUMN` at the
cost of JOIN overhead, GROUP BY complexity, and a schema mismatch with the single-row query
semantics D2 will need. Defer to v3.x only if dimension count exceeds ~10.

### Q5: Per-dimension dimensionality — 384-dim or reduced?

**Decision:** 384 dimensions per dimension vector (unchanged from `LOCAL_DIMENSION = 384`).
PCA reduction deferred until 1M+ atoms.

**Capacity analysis:**

| Scale | Atoms | Per-atom (5 × 384 floats × 4 bytes) | Total |
|---|---|---|---|
| Today | 1,773 | 7.68 KB | ~13.6 MB |
| Medium | 100K | 7.68 KB | ~768 MB |
| Large | 1M | 7.68 KB | ~7.68 GB |

At today's corpus size and up to ~100K atoms this is manageable with no compression. PCA-to-128
changes the embedding semantics in a way that breaks cross-version comparability (a block
registered at 384-dim and a block registered at 128-dim would need a migration step to stay
comparable). Deferring keeps the implementation simple and the comparability invariant intact.

Trigger to revisit: corpus reaches 1M atoms AND query latency is measurably impacted by the
1,920-float per-atom load.

---

## Alternatives considered

| Question | Rejected alternative | Rejection rationale |
|---|---|---|
| Q1 dimensions | Embed `signature` (inputs/outputs types) | Type shapes are structural — type-unification at query time is the right tool, not cosine similarity on embedded type-hint strings. |
| Q1 dimensions | Add a sixth `assertions` vector (`preconditions` + `postconditions` + `invariants`) | No proven query-quality gain over folding into `guarantees`. D5 measurement defers the split-vs-fold decision to evidence, not speculation. |
| Q2 model | Per-dimension models (code-tuned for property tests, NL-tuned for behavior) | Zero-dependency / zero-download-surface gain at current corpus size does not justify the model-management overhead. Defer to v3.1 on evidence from D5. |
| Q3 generation | Manual annotation primary | Authoring friction breaks the v0.6 "no human in the loop after authoring" invariant. |
| Q4 storage | Multi-row `(spec_hash, dimension_name, embedding)` | JOIN/GROUP BY overhead; mismatched query semantics vs D2's planned per-dimension similarity API; not justified at current dimension count. |
| Q5 dimensionality | PCA-to-128 reduction | Breaks cross-version comparability; not justified until 1M+ atoms. |

---

## When to revisit

- **Per-dimension models (v3.1 trigger):** D5 reports that one embedding dimension's recall is
  significantly below the others when the same `Xenova/all-MiniLM-L6-v2` is used across all.
- **Multi-row storage (v3.x trigger):** Dimension count grows beyond ~10. Multi-row + JOIN/GROUP
  BY becomes more maintainable than a 10+ column `vec0` declaration.
- **PCA reduction:** Corpus reaches 1M+ atoms AND per-atom storage or query latency becomes a
  measurable bottleneck.
- **Sixth `assertions` vector:** D5 measurement surfaces a query category that cannot be
  answered well from the combined `guarantees` + `preconditions` + `postconditions` + `invariants`
  vector. File a v3.1 follow-up to split rather than assuming the split is needed.
- **DEC-VERIFY-010 integration:** When the L1+ behavioral embedding is implemented, extend
  migration 7's `vec0` declaration with a `behavioral_embedding FLOAT[384]` column. No
  architectural change required to D1's multi-column shape.

---

## Implementation phase boundary

D1 commits the design. No source files are touched by this ADR. The implementation phase
(separate WIs, after D6 migration-design WI) will:

- `WI-V3-DISCOVERY-IMPL-EMBEDDINGS` — Extend `packages/contracts/src/embeddings.ts` with
  `generateMultiDimEmbedding(spec: SpecYak, provider: EmbeddingProvider): Promise<MultiDimEmbedding>`,
  where `MultiDimEmbedding` maps each of the 5 dimension names to a `Float32Array | null` (null
  = zero-vector sentinel for absent dimensions).
- `WI-V3-DISCOVERY-IMPL-INDEX` — Author migration 7 in `packages/registry/src/schema.ts`:
  clean re-create of `contract_embeddings` with the 5-column `vec0` shape. Owned by D6's
  migration WI; this WI must first verify multi-column `FLOAT[384]` support in the installed
  `sqlite-vec` version.
- `WI-V3-DISCOVERY-IMPL-STORAGE` — Update `storeBlock` in `packages/registry/src/storage.ts`
  to call `generateMultiDimEmbedding()` and write all 5 embedding columns.
- `WI-V3-DISCOVERY-IMPL-QUERY` — D2's owner once D2 ships. Implement per-dimension similarity
  query planner; handle zero-vector dimension skip.
- `WI-V3-DISCOVERY-IMPL-CLI` — Surface multi-vector query in `packages/cli/`.
- `WI-V3-DISCOVERY-IMPL-EVAL` — D5's owner once D5 ships. Measure per-dimension recall;
  populate the per-dimension-models and assertions-vector revisit triggers above.

None of these land in D1. D1 ships the design only.

---

## References

- Issue #151 (this work item — V3-DISCOVERY-D1)
- Issue #150 (parent initiative — WI-V3-DISCOVERY-SYSTEM)
- `DEC-V3-DISCOVERY-D1-001` (this decision; logged in `MASTER_PLAN.md` Decision Log)
- `DEC-EMBED-010` (`MASTER_PLAN.md`) — Local embeddings via `transformers.js` behind a provider interface
- `DEC-VERIFY-010` (`VERIFICATION.md`) — L1+ behavioral embedding via sandbox execution (orthogonal)
- `DEC-CI-OFFLINE-001` (`MASTER_PLAN.md`) — Offline embedding provider authority
- `DEC-TRIPLET-IDENTITY-020` (`MASTER_PLAN.md`) — `spec_hash` PK semantics
- `packages/contracts/src/embeddings.ts` — Current single-vector `EmbeddingProvider` implementation
- `packages/contracts/src/spec-yak.ts` — `SpecYak` interface with optional dimension fields (lines 143–176)
- `packages/registry/src/schema.ts` — Current `contract_embeddings` `vec0` shape (`SCHEMA_VERSION=6`, migration 2)
