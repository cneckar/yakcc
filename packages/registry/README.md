# @yakcc/registry

The store for Yakcc contracts and their implementations.

## What this package provides

- **`Registry`** — the primary interface for all registry operations:
  - `storeBlock(triplet)` — persist a `BlockTriplet` (spec + impl + proof manifest + artifact bytes). The registry is monotonic; stored entries are never removed.
  - `getBlock(blockMerkleRoot)` — retrieve a stored block by its content-address, including artifact bytes.
  - `structuralMatch(spec)` — structured contract matching. Filters candidates by input/output type signature, error conditions, and non-functional properties. Returns the best `Match` or `null` if no conforming implementation exists.
  - `select(matches)` — picks the best match from a candidate set, preferring stricter contracts then better non-functional properties.
  - `close()` — releases all resources held by the registry.
- **`openRegistry(path)`** — opens (or creates) a registry at the given filesystem path backed by SQLite + sqlite-vec. Schema migrations run automatically on open.
- **`Match`** — a contract paired with a similarity score in [0, 1].
- **`Candidate`** — a `Match` plus the `Implementation` that satisfies it.
- **`BlockTripletRow`** — the persisted shape of a block:
  - `spec` — the `ContractSpec`
  - `impl` — source text of the implementation
  - `proofManifest` — per-atom property tests (non-empty since WI-016)
  - `artifacts: Map<string, Uint8Array>` — compiled artifact bytes (added in WI-022a; stored in the `block_artifacts` table)

## Persistence

The registry is backed by SQLite with the sqlite-vec extension for embedding storage. The schema is versioned; `openRegistry` runs migrations automatically.

Embeddings are generated and stored on every spec write using a provider interface (transformers.js local model by default, no API key required). This enables future similarity search without re-embedding on query.

Block identity is derived via `blockMerkleRoot()` over `(spec, impl, proofManifest, artifacts)` — the artifacts field is included in the Merkle root per the contracts canonicalization formula (WI-022a).

## Structural matching

`structuralMatch(spec)` is the live filtering pass. It covers:
- Input/output type signature compatibility
- Error condition coverage
- Non-functional property constraints (purity, thread safety, complexity bounds)

Selection among multiple matches uses strictness ordering followed by non-functional property scoring.

## What is not yet wired

- **No `findCandidatesByIntent(intent)` query API** — vector embeddings are stored but not queried at runtime. Similarity search over stored embeddings is planned as WI-025 (see `~/.claude/plans/v1-vision-wave-2.md`).
- **No federation publishing path** — the F1 read-only mirror (`@yakcc/federation`, WI-020) is reviewer-blocked pending WI-022b alignment of `blockMerkleRoot()` with the contracts formula.

## How callers consume this package

```ts
import { openRegistry } from "@yakcc/registry";
import type { Registry, BlockTripletRow } from "@yakcc/registry";

const registry = await openRegistry(".yakcc/registry.db");

// Store a block (spec + impl + proof manifest + artifact bytes)
const triplet: BlockTripletRow = {
  spec: myContractSpec,
  impl: "export function parseIntList(s: string): number[] { ... }",
  proofManifest: { property_tests: [{ description: "round-trips", ... }] },
  artifacts: new Map([["output.js", compiledBytes]]),
};
await registry.storeBlock(triplet);

// Retrieve a block by content-address
const retrieved = await registry.getBlock(blockMerkleRoot);

// Structural matching
const match = await registry.structuralMatch(spec);

// Clean up
await registry.close();
```

## License

This package is dedicated to the public domain under [The Unlicense](../../LICENSE).
