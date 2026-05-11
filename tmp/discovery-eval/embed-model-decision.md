# Embedding Model Experiment — Decision Document

**WI:** WI-V3-DISCOVERY-D5-EMBED-MODEL-EXPERIMENT (issue #326)
**Decision ID:** DEC-V3-DISCOVERY-D5-EMBED-MODEL-EXPERIMENT-001
**Date:** 2026-05-11
**Status:** PENDING_RUNS — infrastructure delivered; actual benchmark runs blocked (see below)

---

## Context

Post-#322 (D3 filter strictness fix), the discovery pipeline sits at:

| Metric | Current | Target |
|--------|---------|--------|
| M2 (P@1) | 62.5% | **70%** ← 7.5pt gap |
| M3 (R@10) | 92.5% | 90% ✅ |
| M4 (MRR) | 0.742 | 0.70 ✅ |

This WI investigates whether a different embedding model can close the 7.5pt M2 gap
without schema changes, per DEC-V3-INITIATIVE-002-DISPOSITION's decision branch:
> "If 60-70%: file narrow follow-up (corpus coverage OR embedding model experiment)."

---

## Schema Dimension Constraint (Critical Discovery)

**Finding:** The SQLite `vec0` schema is hardcoded to `FLOAT[384]` in
`packages/registry/src/schema.ts:218`. Any model with output dimension ≠ 384
cannot be tested against the existing bootstrap registry without first performing
a `vec0` drop-and-recreate migration.

**Implication:** The scope of this WI is limited to **384-dim models only**. Larger
models such as `Xenova/all-mpnet-base-v2` (768-dim) require a separate schema
migration WI (see `DEC-V3-DISCOVERY-D6-001` migration protocol).

---

## Infrastructure Delivered

The following code changes were landed in this WI:

### 1. `createLocalEmbeddingProvider(modelId?, dimension?)` — parametric factory

`packages/contracts/src/embeddings.ts`:
- `createLocalEmbeddingProvider()` now accepts optional `modelId: string` and
  `dimension: number` parameters
- Default: `Xenova/all-MiniLM-L6-v2`, 384-dim (backwards-compatible)
- Custom models use per-instance pipeline closures (DEC-EMBED-CUSTOM-MODEL-001)
- Module-level singleton preserved for default model (DEC-EMBED-SINGLETON-CLOSURE-001)

### 2. `DISCOVERY_EMBED_MODEL` / `DISCOVERY_EMBED_DIM` env vars

`packages/registry/src/discovery-eval-full-corpus.test.ts`:
- `DISCOVERY_EMBED_MODEL=<model-id>` selects the model (default: `Xenova/all-MiniLM-L6-v2`)
- `DISCOVERY_EMBED_DIM=<dim>` sets the expected dimension (default: 384, warns on invalid)
- Model flows through `createLocalEmbeddingProvider()` and into `embeddingProvider.modelId`
- Artifact output already uses `embeddingProvider.modelId` for the provider field

**Usage:**
```sh
DISCOVERY_EVAL_PROVIDER=local \
DISCOVERY_EMBED_MODEL=Xenova/bge-small-en-v1.5 \
DISCOVERY_EMBED_DIM=384 \
pnpm --filter @yakcc/registry test -- src/discovery-eval-full-corpus.test.ts
```

---

## Candidate Model Inventory (384-dim, offline-capable, MIT/Apache)

| Model ID | Dim | License | Family | Priority | Notes |
|---|---|---|---|---|---|
| `Xenova/all-MiniLM-L6-v2` | 384 | MIT | MiniLM | — | **Current baseline** |
| `Xenova/bge-small-en-v1.5` | 384 | MIT | BGE | **HIGH** | Dense-retrieval specialist; MTEB retrieval > MiniLM |
| `Xenova/e5-small-v2` | 384 | MIT | E5 | **HIGH** | Strong MTEB retrieval; needs `"query: "` prefix |
| `Xenova/all-MiniLM-L12-v2` | 384 | MIT | MiniLM | MEDIUM | 12-layer; +1-3pt over L6 on general tasks |
| `Xenova/paraphrase-MiniLM-L6-v2` | 384 | MIT | MiniLM | LOW | Paraphrase-tuned; unclear gain for code-spec retrieval |

**Out of scope (dimension > 384, need schema migration):**
- `Xenova/all-mpnet-base-v2` (768-dim, MIT): would need FLOAT[384]→FLOAT[768] migration

---

## Actual Benchmark Runs: BLOCKED

**Blocker:** HuggingFace model downloads require network access to `huggingface.co`.
The FuckGoblin cloud sandbox has this host in a network blocklist (`403 Host not in allowlist`).
No model files are pre-cached in the environment (`~/.cache/xenova/` absent).

The full-corpus eval harness requires:
1. `bootstrap/yakcc.registry.sqlite` (generated successfully during this run)
2. Network access to load the semantic embedding model on first call

Without model downloads, `DISCOVERY_EVAL_PROVIDER=local` fails at the `reembedRegistry`
step with `Error: Forbidden access to file: "https://huggingface.co/..."`.

**Infrastructure is complete and tested.** Actual benchmark runs must be performed in an
environment with HuggingFace access. The comparison JSON at
`tmp/discovery-eval/embed-model-comparison-2026-05-11.json` lists all candidates with
`run_status: "NOT_RUN"` pending those runs.

---

## Recommended Run Order

Once HuggingFace access is available:

1. **`Xenova/bge-small-en-v1.5`** (highest priority):
   ```sh
   DISCOVERY_EVAL_PROVIDER=local DISCOVERY_EMBED_MODEL=Xenova/bge-small-en-v1.5 \
   DISCOVERY_EMBED_DIM=384 DISCOVERY_EVAL_REPORT=1 \
   pnpm --filter @yakcc/registry test -- src/discovery-eval-full-corpus.test.ts
   ```

2. **`Xenova/e5-small-v2`** (second priority; note the `"query: "` prefix requirement):
   Requires a thin wrapper in `createLocalEmbeddingProvider` that prepends `"query: "` to
   the query text but NOT the stored-atom text. This asymmetry is intentional for E5.
   Alternatively: test without the prefix first to see baseline gap.

3. **`Xenova/all-MiniLM-L12-v2`** (quick check; same family, minimal code risk):
   ```sh
   DISCOVERY_EVAL_PROVIDER=local DISCOVERY_EMBED_MODEL=Xenova/all-MiniLM-L12-v2 \
   DISCOVERY_EMBED_DIM=384 DISCOVERY_EVAL_REPORT=1 \
   pnpm --filter @yakcc/registry test -- src/discovery-eval-full-corpus.test.ts
   ```

---

## Decision Branch Outcomes

| Benchmark Outcome | Action |
|---|---|
| Any 384-dim model achieves M2 ≥ 70% | Swap default in `packages/contracts/src/embeddings.ts`; update `LOCAL_MODEL_ID` and `LOCAL_DIMENSION`; re-bootstrap; close DEC-V3-INITIATIVE-002 |
| Best 384-dim model achieves M2 65-69% | Promising; file `WI-V3-CORPUS-FIELD-COVERAGE-EXPAND` as supplementary lever |
| All 384-dim models ≤ 62.5% | Keep current; file `WI-V3-CORPUS-FIELD-COVERAGE-EXPAND` |
| Need > 384-dim to close gap | File `WI-V3-DISCOVERY-D6-DIM-MIGRATION` (schema migration for 768-dim) |

---

## Decision Log Entry

`DEC-V3-DISCOVERY-D5-EMBED-MODEL-EXPERIMENT-001`:
**Status:** pending-runs (infrastructure complete; benchmark environment blocked)
**Candidate:** `Xenova/bge-small-en-v1.5` is the recommended first-run candidate
**Schema constraint:** 384-dim models only without migration; 768-dim deferred
**Code:** `createLocalEmbeddingProvider(modelId?, dimension?)` + `DISCOVERY_EMBED_MODEL` env var landed
