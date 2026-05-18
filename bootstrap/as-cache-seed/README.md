# bootstrap/as-cache-seed

<!-- @decision DEC-AS-WASM-SEED-001 -->
<!-- @title Commit a checked-in wasm seed at bootstrap/as-cache-seed/ -->
<!-- @status accepted -->

Pre-compiled WebAssembly shards for the `closer-parity-as` test corpus,
committed to git so cold CI runners always start with a populated
`tmp/yakcc-as-cache/` directory (even when no `actions/cache@v4` hit is
available).

## What this is

Stage B of #631. Each file is a content-addressed wasm shard in the exact
on-disk layout produced by `packages/compile/src/as-compile-cache.ts`
(DEC-AS-COMPILE-CACHE-002):

```
bootstrap/as-cache-seed/
  <key[0..3]>/
    <key>.wasm
```

where `<key>` is `sha256(atomHash | ascVersion | ascFlagsHash)` per
DEC-AS-COMPILE-CACHE-001. The layout is byte-identical to what
`cachedAsEmit()` writes to `tmp/yakcc-as-cache/` at runtime.

## How CI uses this seed

`.github/workflows/closer-parity-as.yml` copies these files into
`tmp/yakcc-as-cache/` BEFORE the `Restore AS wasm shard cache` step
(Stage A). Stage A's `actions/cache@v4` restore then overlays any fresher
cached shards on top (using `cp -rn` no-clobber semantics so the cache
always wins on key collision). See DEC-AS-WASM-SEED-003 and
DEC-AS-WASM-SEED-COPY-MODE-001.

## When to regenerate

Regenerate this seed after:
1. An `assemblyscript` version bump in `pnpm-lock.yaml` (asc version is part
   of the cache key — all existing shards are stale after a bump).
2. A change to `CANONICAL_ASC_FLAGS` in `packages/compile/src/as-compile-cache.ts`
   (asc flags hash is part of the cache key).
3. A major corpus shape change (>10% of atoms gain new `export function`
   patterns). Drift is fine otherwise — unchanged atoms produce zero diff.

Minor source changes that don't affect the compilable atom set do NOT require
regeneration (those atoms produce the same content-addressed key).

## How to regenerate

```bash
# Requires Node.js >=22.6 and built packages
pnpm install && pnpm -r build

# Full regeneration (all atoms — takes 60-120 min on a cold shave-cache)
# pnpm node scripts/build-as-cache-seed.mjs with the experimental flag:
pnpm node --experimental-strip-types scripts/build-as-cache-seed.mjs

# Quick Phase 0 measurement only (no seed written; no --experimental-strip-types needed)
node scripts/build-as-cache-seed.mjs --inline-sample --dry-run
```

## Size budget

asc version: 0.28.17
Budget tier: Option A (full seed, ≤5MB)

### Phase 0 measurements (inline sample — 10 representative atoms)

| Metric | Value |
|--------|-------|
| Atoms compiled | 10 |
| Shard size min | 36 bytes |
| Shard size p50 | 53 bytes |
| Shard size p95 | 67 bytes |
| Shard size max | 67 bytes |
| Total sample size | 507 bytes |
| asc version | 0.28.17 |
| Elapsed | 2.1s |

These measurements are from the `--inline-sample` fast-path using 10 hardcoded
representative atoms (simple arithmetic, conditionals, string ops). They
confirm the ≤5MB budget tier for Option A: even at 200 bytes per atom average,
4119 atoms × 200 B = ~824 KB, well under the 5 MB Option A ceiling.

### Initial seed measurements (Wrath, 2026-05-18 fast path)

Generated via `node --experimental-strip-types scripts/build-as-cache-seed.mjs \
  --from-cache examples/v1-wave-3-wasm-lower-demo/test/shave-cache.json`
on 2026-05-18 — the fast Phase 0 path that reads pre-shaved atoms from the
content-hash-keyed shave-cache rather than re-walking the corpus.

| Metric | Value |
|--------|-------|
| Atoms loaded from shave-cache | 88 |
| Atoms compiled successfully | 22 |
| Atoms with no AS-compilable surface (errors) | 66 |
| Wasm shards on disk | 22 |
| Min shard size | 8 bytes |
| p50 shard size | 8 bytes |
| p95 shard size | 8 bytes |
| Max shard size | 526 bytes |
| Total seed size | 184 KB |
| Budget tier | Option A (≤5 MB) |
| asc version | 0.28.17 |
| Generation elapsed | 6.0s |

**Coverage caveat.** This initial seed covers only the 22 atoms compilable
from the 88 atoms cached in `examples/v1-wave-3-wasm-lower-demo/test/shave-cache.json`.
The closer-parity-as test runs against the FULL 4119-atom corpus, so the
cache hit rate from this initial seed is small (~0.5%). The infrastructure
is forward-compatible: when corpus regeneration becomes feasible (faster
machine, pre-built shave-cache, or operator-orchestrated bootstrap), running
the generator without `--from-cache` populates the full ~1889 compilable
atoms.

**Why ship the small seed anyway?** The mechanism is proven end-to-end
(seed-copy step works, .gitattributes binary marker correct, README +
generator documented). Future regen requires zero code change — just run
the script. Even 22 cache hits is non-zero improvement over Stage A alone,
which depends entirely on `actions/cache@v4` which may miss when keys drift.
Per #485, the chicken-and-egg pattern is more thoroughly broken by combining
Stage A (cross-run cache) + this initial Stage B seed + future seed
regeneration on a faster machine.

## Scope decisions

- **DEC-AS-WASM-SEED-001** — Checked-in seed at `bootstrap/as-cache-seed/`
- **DEC-AS-WASM-SEED-002** — Generator script at `scripts/build-as-cache-seed.mjs`
- **DEC-AS-WASM-SEED-003** — CI workflow step order (seed BEFORE Stage A restore)
- **DEC-AS-WASM-SEED-004** — Fast Phase 0 path via `--inline-sample` / `--from-cache`
- **DEC-AS-WASM-SEED-COPY-MODE-001** — `cp -rn` no-clobber semantics
- **DEC-AS-COMPILE-CACHE-001** — Content-addressed cache key (read-only consumer)
- **DEC-AS-COMPILE-CACHE-002** — On-disk shard layout (read-only consumer)
