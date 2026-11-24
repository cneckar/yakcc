# DEC-DUC-REGISTRY-001: the registry and the wire in the DUC atom form

**Status:** Decided. The schema and the wire are in place. Regenerating the bootstrap registry is the lock's last step (#1292).
**Date:** 2026-11-24
**Issue:** https://github.com/cneckar/yakcc/issues/1291
**Builds on:**
- DEC-DUC-FORMAT-001 (the format);
- DEC-DUC-GRAPH-ROOT-001 (roots);
- DEC-DUC-TRUST-MODEL-001 (the receiver's checks).

---

## Registry (schema 19)

Migration 19 replaces the provisional tables of migrations 17 and 18. A database that had them drops them; their rows were all re-derivable by a shave. A fresh database never creates them.

| Table | Key | Holds |
|---|---|---|
| `duc_graphs` | graph identity | the structure, once per identity, and its format version |
| `duc_implementations` | (spec hash, graph root) | the identity, the format and lifter versions, the DUC block root, the block triplet it was shaved as, the trust level, the evidence, the base set, the TypeScript cache |
| `duc_links` | (graph root, reason, symbol, module) | what each reference calls, by contract. Indexed by target |
| `duc_annotations` | (spec hash, graph root) | origin annotations |
| `duc_signatures` | graph identity | the retrieval signature and its vector (#1280) |
| `duc_contracts` | spec hash | the contract of an implementation received without a block |
| `duc_modules` | module root | a module record (#1290), as canonical JSON |

- **An implementation is keyed by its root,** not its identity. The same structure linked two ways is two implementations.
- **Links belong to the root** that commits to them.
- **The trust level is what a receiver gave:** `claimed`, `conforming` or `corroborated`. A shaved implementation has none.

**`impl_source` stays,** as the block triplet's own text. It is not part of the DUC block root (DEC-DUC-GRAPH-ROOT-001). For a DUC atom, the graph is authoritative and the emitted TypeScript is its `ts_cache`.

## Reading a registry without writing it

Opening a registry migrates it in place. `openRegistrySnapshot` opens a temporary copy and removes it on close. Every reader of a registry that is a source uses it, so the committed `bootstrap/yakcc.registry.sqlite` is never written:
- `yakcc seed --yakcc`;
- the full-corpus discovery evaluation;
- the init probe;
- the self-shave integration test.

## The wire (DEC-DUC-WIRE-001, DEC-DUC-RECEIVE-001)

**Wire form.** A DUC implementation travels as a `SharedImplementation` in JSON, with the structure in base64. The decoder checks shape only.

**Receiving.** A registry receives through the receiver's checks alone (`receiveDucSubmission`). The store they consult is the registry:
- the contracts it has implementations or blocks of;
- the stored graphs and evidence of the contracts the batch names.

What is not refused is stored with the trust level it reached, its evidence, base set and contract. Module records are stored by root.

**Routes** (`serve`):

| Route | Returns |
|---|---|
| `GET /v1/duc/specs` | the contracts with DUC implementations |
| `GET /v1/duc/spec/<specHash>` | that contract's graph roots |
| `GET /v1/duc/impl/<specHash>/<root>` | one implementation, in wire form |
| `GET /v1/duc/module/<root>` | one module record |
| `POST /v1/duc/submit` | the verdict: which check refused what, and why |

**Client.** `createDucClient(url)` lists, fetches and submits. `mirrorDuc(client, registry)` receives every implementation it lacks as one batch, so links between them close. `yakcc federation mirror` runs it after the block mirror.

**Schema version.** `GET /schema-version` serves 19. A mirror refuses a peer with a newer schema, as before.

**Block triplets.** Their routes stay, for registries that hold blocks.

## Evidence

- **Registry:**
  - `duc-implementations.test.ts`: by root; one structure with two roots; attached fields kept unless given anew; a trust level outside the three refused; contracts and module records; migration from a database with the provisional tables.
  - The full registry suite passes.
- **Federation:** `duc-roundtrip.test.ts`, over HTTP:
  - receive;
  - serve and mirror, the second mirror fetching nothing;
  - a tampered root refused and not stored;
  - evidence the graph does not compute refused;
  - a module record served;
  - a malformed submission answered 400.
- **Shave persist:** stores the root and the DUC block root, and the test recomputes both.
- **The committed bootstrap registry:** byte-identical (same MD5) after the registry, compile and CLI seed and init suites.

## Left for the lock (#1292)

Set the format version to 3, then regenerate `bootstrap/yakcc.registry.sqlite` from a full shave at schema 19. Record the lifter version, the format version and the embedding model stamp.
