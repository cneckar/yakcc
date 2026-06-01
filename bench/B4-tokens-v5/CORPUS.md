# B4-v5 Corpus Registry

**Path:** `bench/B4-tokens-v5/corpus/registry.sqlite`

## What it is

A committed corpus registry for the B4-v5 benchmark containing 6 atoms —
one per task — built offline from the task reference implementations.

The registry is committed here (not in `tmp/`) so it survives cleanup cycles.

## How it was built

Built by `bench/B4-tokens-v5/harness/build-corpus-offline.mjs` (no API key,
no Anthropic calls). The script:

1. Reads `bench/B4-tokens-v5/tasks.json` (6 tasks: crc32c, utf8-codec,
   base32-rfc4648, lru-ttl-cache, semver-range, ring-buffer).
2. For each task: reads its `reference_impl` TypeScript file, constructs a
   SpecYak with `behavior` set to the task's description (from tasks.json),
   computes the BlockMerkleRoot from spec + impl + bootstrap proof manifest,
   and stores the block via `registry.storeBlock()`.
3. Uses `createLocalEmbeddingProvider` (Xenova/bge-small-en-v1.5, 384-dim)
   for embedding — the same provider as the production `yakcc_resolve` query
   path. Provider parity ensures query and storage vectors are comparable.

The `behavior` field in each SpecYak matches the task description text used
by `probe-v5.mjs`'s intent queries. This alignment is what produces high
cosine similarity between the stored atom spec and the probe's query vector.

## How to rebuild

```sh
# From the repo root (or worktree root):
node bench/B4-tokens-v5/harness/build-corpus-offline.mjs
```

No `ANTHROPIC_API_KEY` is required. The script is idempotent (removes the
existing registry before rebuilding).

The Xenova/bge-small-en-v1.5 model must be locally cached. It is cached in
the pnpm node_modules on first use. In a worktree, symlink the main repo's
cache:
```sh
ln -s <main-repo>/node_modules/.pnpm/@xenova+transformers@X.Y.Z/node_modules/@xenova/transformers/.cache \
      <worktree>/node_modules/.pnpm/@xenova+transformers@X.Y.Z/node_modules/@xenova/transformers/.cache
```

## Probe results

Probed with `YAKCC_REGISTRY_PATH=bench/B4-tokens-v5/corpus/registry.sqlite node bench/B4-tokens-v5/harness/probe-v5.mjs`:

```
task_id          tier              top1    gap     n   >=0.92  >=0.85
------------------------------------------------------------------------
crc32c           auto_accept      0.9311  0.1254    6     1      1
utf8-codec       auto_accept      0.9087  0.0550    6     0      2
base32-rfc4648   auto_accept      0.9560  0.1017    6     1      2
lru-ttl-cache    auto_accept      0.9682  0.1293    6     1      1
semver-range     auto_accept      0.9319  0.1327    6     1      1
ring-buffer      auto_accept      0.9493  0.1038    6     1      1
------------------------------------------------------------------------
```

All 6 tasks resolve to `auto_accept`. ZERO Anthropic API calls made.

## Consuming in phase2-v5

Set `YAKCC_REGISTRY_PATH` to the absolute path of this registry when running
`phase2-v5.mjs`:

```sh
export YAKCC_REGISTRY_PATH=$(pwd)/bench/B4-tokens-v5/corpus/registry.sqlite
node bench/B4-tokens-v5/harness/phase2-v5.mjs
```

## Files

| File | Status | Purpose |
|------|--------|---------|
| `corpus/registry.sqlite` | committed | the corpus registry |
| `corpus/registry.sqlite-wal` | gitignored | SQLite WAL journal (transient) |
| `corpus/registry.sqlite-shm` | gitignored | SQLite SHM journal (transient) |
| `corpus/intent-cache/` | gitignored | build-time intent cache (regenerated on rebuild) |
