# WI-1117 Slice 2 — `export-atom-index` CLI (atoms.json + embeddings index + model stamp)

**Workflow:** `1117-slice2-atom-exporter` · branch `feature/1117-slice2-atom-exporter` (base main `47ba986`, includes #1119 + #1129)
**Issue:** #1117 — *feat(discovery): browser-consumable semantic-search kit + atom-index/embeddings exporter* (Slice 1 = `@yakcc/discovery-search`, landed #1121/#1129; this is Slice 2)
**Consumer:** yakforge atom-explorer frontend (SEPARATE repo). yakcc ships the exporter + tests only — NOT a website build step.

---

## 1. Problem

The atom-explorer must run the *same* semantic search the LLM uses: embed a query with `bge-small-en-v1.5` (384-dim) client-side and cosine-rank against atom contract embeddings, in the browser, via the Slice-1 kit (`rankCandidates`). To do that without shipping `better-sqlite3`/`sqlite-vec`/`ts-morph` to the browser, yakcc must emit a **static, dependency-free data bundle** from the registry corpus:

- a per-atom **card** (atoms.json) the explorer renders, and
- an **embeddings index** (raw 384-dim vectors) the explorer cosine-ranks.

Both must carry a **model-id/provider stamp** so the client provably embeds queries with the same model id the index was built with (honors `DEC-V3-IMPL-QUERY-002` / provider-consistency guard). Fail loud, no silent skips, deterministic output.

### Challenge to the requirement (scope correction)

The issue lists card fields "name, signature, behavior, level, purity/thread-safety/complexity, deps/reuse counts, license, root." Verification of the bootstrap corpus (`bootstrap/yakcc.registry.sqlite`, schema-confirmed) shows:

- **`license` and `root` do not exist** in the registry schema. The `blocks` table has no license/root column; `proof_manifest_json` carries only `artifacts`. → **Excluded from the first cut** (DEC-1117-S2-CARD-002). Not inventing data the corpus doesn't hold. Recorded as a NICE follow-up if a license/root authority is later added to the registry.
- **The atom unit of identity is the spec, not the block.** Embeddings are keyed by `spec_hash` (vec0 PK). The corpus has **4904 blocks but 4829 distinct `spec_hash`** — multiple implementations share one contract. The KNN read path (`storage.ts` ~678) already returns `spec_hash`. **0 specs lack an embedding.** → atoms.json is **one card per `spec_hash`** (4829 cards), embeddings index is keyed by `spec_hash`, vector count == card count == 4829. This matches the registry's own search identity and the Slice-1 kit (which ranks a flat vector array and maps `index → atom`).

### Goals (measurable)

- A node-only `yakcc export-atom-index --out <dir>` command emits, from the bootstrap corpus by default:
  - `atoms.json` — exactly 4829 cards (one per distinct `spec_hash`), schema in §4.
  - `embeddings.json` — exactly 4829 vectors, each `number[384]`, aligned to atoms.json order, keyed by `spec_hash`; carries the model stamp.
- Model stamp present and equal to the stored `registry_meta.embedding_model_id` (`Xenova/bge-small-en-v1.5`) and `embedding_dimension` (`384`).
- Deterministic: two runs over the same corpus produce byte-identical files; stable ordering = `ORDER BY spec_hash` (ASC).
- Pure-Node vitest tests green on the bootstrap corpus + a minimal fixture; full-workspace `pnpm -r build` + `pnpm lint` + `pnpm typecheck` green; no node-dep leak into the browser path.

### Non-goals

- No yakforge frontend code; no website build wiring (consumer is a separate repo).
- No `license`/`root` fields (not in corpus — DEC-1117-S2-CARD-002).
- No new browser-path exports to `@yakcc/discovery-search` (its node-dep-isolation invariant must stay green). If a pure re-export is genuinely needed it is the only allowed touch, and must remain browser-safe.
- No re-embedding, no registry mutation: exporter is **read-only** over the corpus.

### Dominant constraints

- `better-sqlite3`/`sqlite-vec` are node-only and pnpm-isolated to `@yakcc/registry`. The exporter is node-only (fine); its JSON output is dependency-free.
- vec0 stores vectors opaquely; raw read-back is the key technical risk (resolved in §3).

---

## 2. Architecture — exporter as a CLI command

**Chosen:** a CLI command `packages/cli/src/commands/export-atom-index.ts` exposing `export async function exportAtomIndex(argv, logger): Promise<number>`, registered in the `packages/cli/src/index.ts` dispatch switch as top-level command `export-atom-index` (sibling of `seed`, `emit-atom`, `stats`). Rejected an `.mjs` script: a CLI command is vitest-testable, consistent with `seed-yakcc.ts`, and reuses the proven corpus-resolution + registry-open path. (DEC-1117-S2-EXPORTER-001)

**Two output files, not one bundle** (`atoms.json` + `embeddings.json`): the card metadata (small, human-diffable, frontend renders eagerly) and the vector index (large, ~4829×384 floats, frontend may lazy-load/stream) have different size/lifecycle profiles; splitting lets the explorer fetch cards first and vectors on demand. Both share the same `specHash` ordering so the explorer zips them by index. (DEC-1117-S2-EXPORTER-002)

**Default `--out`:** `tmp/atom-index/` (repo-tmp per Sacred Practice #3; never `/tmp`). `--corpus <path>` overrides the source registry (defaults to `findBootstrapSqlite()`); `--out <dir>` overrides destination. `mkdirSync(out, { recursive: true })`; fail loud if corpus missing (mirror `seed-yakcc` ENOENT handling and `generate-benchmark-svgs.mjs` fail-loud precedent).

**Corpus open path (reuse, do not re-derive):**
- `findBootstrapSqlite()` — copy the walk-up resolver pattern from `seed-yakcc.ts` (~141) (or factor a shared helper; copying is acceptable for the first cut to avoid touching seed-yakcc's scope).
- `openRegistry(path, { embeddings: createLocalEmbeddingProvider() })` — open with the local provider so the stored model id matches and the `DEC-EMBED-REGISTRY-META-001` mismatch guard passes (precedent DEC-1123-SEED-BGE-NATIVE-001).
- `registry.getStoredEmbeddingModelId()` / `getStoredEmbeddingDimension()` — read the stamp.
- `registry.exportManifest()` → `getBlock(blockMerkleRoot)` — hydrate blocks; **collapse to one card per `spec_hash`** picking the first block per spec under a deterministic tie-break (lowest `blockMerkleRoot` lexicographically), so a spec with multiple impls yields one stable card.
- New `registry.exportAllEmbeddings()` (see §3) → `{ specHash, vector: number[384] }[]`, joined to cards by `specHash`. Assert every card's `specHash` has exactly one vector and vice versa (fail loud on any mismatch — forbidden shortcut: silent drop).

### State-Authority Map (integration surfaces)

| Domain | Canonical authority | Exporter relationship |
|---|---|---|
| Block triplets / card fields | `blocks` table via `RegistryImpl.exportManifest` + `getBlock` (`storage.ts`) | read-only |
| Spec card fields | `JSON.parse(block.specCanonicalBytes) as SpecYak` (precedent storage.ts ~270/302) | read-only parse |
| Embedding vectors | `contract_embeddings` vec0 table; read-back via **new** `exportAllEmbeddings()` | read-only, new authority method |
| Model stamp | `registry_meta` via `getStoredEmbeddingModelId/Dimension` | read-only |
| Reuse / test / runtime counts | `block_occurrences`, `test_history`, `runtime_exposure` tables | read-only (NICE, §4) |
| Output artifacts | `--out` dir (default `tmp/atom-index/`) | write-only, exporter-owned |
| Browser scoring contract | `@yakcc/discovery-search` `rankCandidates(Float32Array[])` | output must slot in; NOT imported by exporter |

No parallel authority is created: card fields, vectors, and stamp all flow from the single `Registry` opened once.

---

## 3. RESOLVED — vec0 raw vector read-back (the key technical risk)

**Verified on the live bootstrap DB** (node + the registry's own `better-sqlite3`/`sqlite-vec`):
```
SELECT spec_hash, vec_to_json(embedding) AS j FROM contract_embeddings ORDER BY spec_hash
```
returns `j` = a JSON array of **384 floats** for **all 4829 rows**, deterministic across runs. No shadow-table (`*_vector_chunks00`) parsing is required. `vec_to_json` is provided by `sqlite-vec`, which `openRegistry` already loads via `sqliteVec.load(db)` (storage.ts ~2268).

**Authority decision — DEC-1117-S2-VECREAD-001 (chosen: option a, add a registry method).**
Add to `RegistryImpl` (`packages/registry/src/storage.ts`) and the `Registry` interface (`packages/registry/src/index.ts`):
```ts
exportAllEmbeddings(): Promise<ReadonlyArray<{ specHash: SpecHash; vector: number[] }>>;
```
Implementation: `assertOpen()`, then `this.db.prepare("SELECT spec_hash, vec_to_json(embedding) AS j FROM contract_embeddings ORDER BY spec_hash").all()`, `JSON.parse` each `j`, assert `vector.length === LOCAL_DIMENSION` per row (fail loud otherwise — corruption tripwire, do not weaken). Returns ASC-by-spec_hash for stable ordering.

**Why a registry method, not a second sqlite handle in the CLI (rejected option b):**
- `serializeEmbedding` (the write-side vector codec) already lives in `storage.ts`; its read-side inverse belongs in the same authority — Single Source of Truth (Sacred Practice #12). Option (b) would open a *second* `better-sqlite3` handle and re-call `sqliteVec.load` in the CLI, creating a parallel embedding-read authority that can silently diverge from the registry's open path (model-stamp guard, vec0 load order).
- The raw `db` handle + loaded `sqlite-vec` already exist inside `RegistryImpl`; exposing a typed accessor is the minimal, encapsulated surface. The exporter then needs **zero** direct sqlite/vec0 knowledge.

**Architecture-bundle obligation (CLAUDE.md):** this is an authority-surface change, so it ships in one bundle: (1) the `storage.ts` method + `index.ts` interface line, (2) an invariant test asserting count == `contract_embeddings` rowcount, every vector length == 384, and ordering == ASC `spec_hash` (added in registry's test suite), (3) this plan doc as the decision record. No old path is superseded (this is net-new read-back), so there is nothing to delete — noted explicitly.

---

## 4. atoms.json + embeddings.json schema (exact)

### `atoms.json`
```jsonc
{
  "schemaVersion": 1,
  "model": { "id": "Xenova/bge-small-en-v1.5", "dimension": 384 },  // == stored registry_meta
  "corpus": { "atomCount": 4829, "source": "bootstrap/yakcc.registry.sqlite" },
  "atoms": [
    {
      "specHash": "string",            // identity key; ASC-sorted; matches embeddings.json
      "blockMerkleRoot": "string",     // representative block (lowest BMR for the spec)
      "name": "string",                // SpecYak.name
      "signature": {                   // SpecYak.inputs/outputs
        "inputs":  [{ "name": "string", "type": "string" }],
        "outputs": [{ "name": "string", "type": "string" }]
      },
      "behavior": "string | null",     // SpecYak.behavior (optional in SpecYak)
      "level": "L0|L1|L2|L3",          // blocks.level
      "nonFunctional": {               // SpecYak.nonFunctional
        "purity": "pure|io|stateful|nondeterministic",
        "threadSafety": "safe|unsafe|sequential",
        "time":  "string | null",
        "space": "string | null"
      },
      "source": { "pkg": "string | null", "file": "string | null" }  // blocks.source_pkg/source_file
    }
  ]
}
```
**MUST fields (first cut, all corpus-backed & verified):** `specHash`, `blockMerkleRoot`, `name`, `signature`, `behavior`, `level`, `nonFunctional.{purity,threadSafety,time,space}`, `source.{pkg,file}`.

**NICE (deferred, DEC-1117-S2-CARD-001):** derived counts — `reuseCount` (`block_occurrences` rows for the spec's blocks), `passingTestRuns` (`test_history`), `runtime.{requestsSeen,lastSeen}` (`runtime_exposure`). These require extra per-spec aggregation queries; gated behind `--with-counts` in a follow-up to keep the first cut tight. If added, they are additive object fields (schemaVersion stays 1 if optional, bumps to 2 if always-present).

**EXCLUDED (DEC-1117-S2-CARD-002):** `license`, `root` — not present in the registry schema. Do not synthesize.

`behavior` is `SpecYak.behavior` which is `string | undefined` — emit `null` when absent (never drop the key; stable shape).

### `embeddings.json`
```jsonc
{
  "schemaVersion": 1,
  "model": { "id": "Xenova/bge-small-en-v1.5", "dimension": 384 },
  "count": 4829,
  "vectors": [
    { "specHash": "string", "vector": [/* 384 floats */] }
  ]
}
```
**Vector format & Slice-1 fit:** `vector` is a plain `number[384]` JSON array (dependency-free; the explorer constructs `Float32Array` per the kit). `vectors` is ASC-sorted by `specHash`, **identical order to `atoms.json.atoms`**, so the explorer zips by index: `rankCandidates(queryVec, vectors.map(v => Float32Array.from(v.vector)))` returns `RankedResult.index` → `atoms[index]`. Vectors are bge-small L2-normalized (kit's `(1+sim)/2` simplification holds). The kit does NOT vec0 — it linear-scans, so raw per-atom vectors keyed by identity are exactly what's needed.

---

## 5. Determinism guarantee

- Ordering: every emitted list is `ORDER BY spec_hash ASC`. Cards and vectors share this order → index-aligned.
- Representative-block tie-break: for a spec with N blocks, pick the lexicographically-lowest `blockMerkleRoot` (stable, content-addressed).
- JSON serialization: `JSON.stringify(obj, null, 2)` with object keys constructed in fixed declaration order (TS object literal order is preserved). Numbers come straight from `vec_to_json` (no re-rounding).
- No timestamps, no run-ids, no map-iteration-order dependence in output.
- Test asserts byte-identity across two runs (§6 T3).

---

## 6. Test plan (pure-Node vitest, no network)

Test file `packages/cli/src/commands/export-atom-index.test.ts` (mirror `seed-yakcc.test.ts` / `bootstrap.bge-roundtrip.test.ts`):

- **T1 (bootstrap corpus shape):** run exporter against `findBootstrapSqlite()` into a tmp dir; assert `atoms.json.atoms.length === embeddings.json.count === 4829`; every card has all MUST fields with correct types; `level ∈ {L0..L3}`; `nonFunctional.purity/threadSafety` in their enums.
- **T2 (model stamp):** `atoms.json.model.id === embeddings.json.model.id === await registry.getStoredEmbeddingModelId()` (`Xenova/bge-small-en-v1.5`); `dimension === 384 === getStoredEmbeddingDimension()`.
- **T3 (dims + determinism):** every `vectors[i].vector.length === 384`; run exporter twice → both `atoms.json` and `embeddings.json` byte-identical (`readFileSync` string equality).
- **T4 (alignment):** for all i, `atoms[i].specHash === vectors[i].specHash`; set of specHashes in atoms == set in embeddings (no orphan either way) — fail-loud join verified.
- **T5 (Slice-1 fit, kit consumed read-only in test):** uses a test-local `rankCandidatesInline` (DEC-1117-S2-TEST-002) whose score formula `(1+sim)/2` is algebraically identical to the production path in `@yakcc/discovery-search`, and whose band labels/thresholds mirror production `assignScoreBand` verbatim (strong/confident/weak/poor at 0.85/0.70/0.50). Importing `rankCandidates` directly from `@yakcc/discovery-search` is deliberately avoided to keep the node-only CLI test free of browser-side package coupling. A dedicated cross-package slot-in test importing the real `rankCandidates` is a future enhancement. Assert `ranked[0].index` maps back to its own `specHash` (self-match top-1) and `RankedResult` shape is honored.
- **T6 (fixture / fail-loud):** a minimal fixture registry (offline provider) with a couple atoms — assert exporter emits the right count; and assert it throws loudly (non-zero exit) when `--corpus` points at a missing file (no silent empty output).

Registry invariant test (in `packages/registry`, bundle for DEC-1117-S2-VECREAD-001): `exportAllEmbeddings()` returns rowcount == `SELECT count(*) FROM contract_embeddings`, every vector length 384, ordering strictly ASC by specHash.

---

## 7. @decision annotations to emit in code

- `DEC-1117-S2-EXPORTER-001` — CLI command (not .mjs) for vitest-testability + corpus-path reuse.
- `DEC-1117-S2-EXPORTER-002` — two files (atoms.json + embeddings.json), shared specHash ordering.
- `DEC-1117-S2-VECREAD-001` — `registry.exportAllEmbeddings()` via `vec_to_json`; registry-owned read-back, not a CLI-side second sqlite handle (Single Source of Truth + architecture-bundle).
- `DEC-1117-S2-CARD-001` — MUST card fields from SpecYak+row; derived counts deferred behind `--with-counts`.
- `DEC-1117-S2-CARD-002` — `license`/`root` excluded (absent from registry schema; do not synthesize).
- `DEC-1117-S2-IDENTITY-001` — atom unit = `spec_hash` (4829), representative block = lowest BMR; matches vec0/KNN identity.

---

## 8. Waves

Single implementer slice (all items are one tightly-coupled change; no internal parallelism needed):
1. **W1 (M):** add `exportAllEmbeddings()` to `storage.ts` + `Registry` interface in `index.ts` + registry invariant test. Gate: none (auto-verified by tests). Deps: none.
2. **W2 (M):** `export-atom-index.ts` command + register in CLI `index.ts` + `export-atom-index.test.ts`. Gate: review. Deps: W1.

Critical path W1 → W2. Max width 1. Both land in the same PR (#1117 Slice 2).
