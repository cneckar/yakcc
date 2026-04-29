# @yakcc/registry

The store for Yakcc contracts and their implementations.

## What this package provides

- **`Registry`** — the primary interface for all registry operations:
  - `search(spec, k)` — vector search returning up to `k` candidate matches
    for a given contract spec.
  - `match(spec)` — structured contract matching returning the best `Match`
    or `null` if no conforming implementation exists.
  - `store(contract, impl)` — stores a contract and its implementation. The
    registry is monotonic; stored entries are never removed.
  - `select(matches)` — picks the best match from a candidate set, preferring
    stricter contracts then better non-functional properties.
  - `getProvenance(id)` — retrieves provenance metadata for a contract id.
  - `close()` — releases all resources held by the registry.
- **`openRegistry(path)`** — opens (or creates) a registry at the given
  filesystem path. v0 returns an in-memory implementation; WI-003 wires this
  to SQLite + sqlite-vec.
- **`Match`** — a contract paired with a similarity score in [0, 1].
- **`Candidate`** — a `Match` plus the `Implementation` that satisfies it.
- **`Provenance`** — metadata describing the test history and runtime exposure
  of implementations registered under a contract id. Carries no author identity
  or signature fields (DEC-NO-OWNERSHIP-011).
- **`Implementation`** — the source text of a basic block, its content-address
  (`blockId`), and the `ContractId` it satisfies.

## What this package does not do (yet)

- **No SQLite persistence** — WI-003 replaces the in-memory facade with a
  real SQLite + sqlite-vec backend.
- **No vector similarity search** — WI-003 wires embeddings into the search
  path; v0 `search` returns an empty array.
- **No structured contract matching** — WI-003 implements the filtering pass;
  v0 `match` always returns `null`.
- **No strictness-aware selection** — WI-003 implements selection; v0 `select`
  returns the first element of the input array.
- **No federation** — registry is single-machine in v0; federation is a v1
  concern.

## How callers consume this package

```ts
import { openRegistry } from "@yakcc/registry";
import type { Registry, Candidate } from "@yakcc/registry";

const registry = await openRegistry(".yakcc/registry.db");

// Store a contract + implementation
await registry.store(contract, {
  source: "export function parseIntList(s: string): number[] { ... }",
  blockId: "bid:deadbeef",
  contractId: contract.id,
});

// Search for candidates
const candidates: Candidate[] = await registry.search(spec, 5);

// Clean up
await registry.close();
```

## License

This package is dedicated to the public domain under [The Unlicense](../../LICENSE).
