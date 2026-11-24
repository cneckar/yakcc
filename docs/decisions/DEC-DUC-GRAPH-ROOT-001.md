# DEC-DUC-GRAPH-ROOT-001: a block's root commits to its graph

**Status:** Decided. Encoding, functions and receiver check are done; registry and bootstrap migration are in #1291, after the lock.
**Date:** 2026-11-24
**Issue:** https://github.com/cneckar/yakcc/issues/1306
**Parent:** #1292 (format lock)
**Supersedes, for DUC atoms:** DEC-TRIPLET-IDENTITY-020's `impl_hash` (the bytes of `impl.ts`)

---

## Context

A block's root was `BLAKE3(spec_hash ‖ impl_hash ‖ proof_root)`, with `impl_hash` the bytes of the
`impl.ts` text. The graph is stored beside the block, keyed by its identity, and joined to the root
only by a mapping row. The lifter is not frozen, so the same text can lift to different valid graphs.
Nothing tied a root to one graph: a graph could be swapped under a root, and the root did not verify
what runs.

The graph identity left out three things:
- **The links,** which say which contract each reference calls (left out by decision 2B, so that
  equal structures share an identity). Swapping a link changes what runs.
- **The format version.**
- **A common hash:** identity used SHA-256, while yakcc's other content addresses use BLAKE3.

## Decision

    graph_identity = BLAKE3(canonical structure)          (was SHA-256)
    links_hash     = BLAKE3(canonical JSON of the sorted links: reason, symbol, module, target spec)
    graph_root     = BLAKE3("yakcc-duc-graph" ‖ u32be format_version ‖ graph_identity ‖ links_hash)
    block_root     = BLAKE3(spec_hash ‖ graph_root ‖ proof_root)

- **`graph_identity`** stays the structural key: equal structures with different links share it,
  and search and dedup use it. The root is what verification uses.
- **The TypeScript text** is a lowering of the graph (a cache), not part of the root. Its provenance
  (source text, file, offset) is an attestation keyed by root.
- **Foreign blocks** keep their own encoding.

`graphRoot(identity, links, formatVersion)` and `ducBlockRoot(specHash, graphRoot, proofRoot)` are in
`@yakcc/duc`. `packGraph` returns `root` beside `identity`.

**At a federation receiver,** a shared implementation carries its `root`. The receiver recomputes
the identity from the structure it decodes, then the root from that identity, the links it was
sent and the format version, and refuses a mismatch (check 3, integrity).

## Evidence

- `graph-root.test.ts` changes one thing at a time and checks the root:
  - the same graph lifted again gives the same root;
  - each of these changes it: one node's label, one link's target (with the identity unchanged),
    the format version, the contract, the proof.
- `duc-submission.test.ts`: the receiver refuses a wrong root, and a link swapped under an unchanged
  structure.

## Consequences

- Every graph identity changes value: BLAKE3, not SHA-256. The format is not locked, and no stored
  database is rewritten.
- **The migration is #1291's, after the lock.** It covers the registry's `duc_implementations`
  (keyed by root), the bootstrap manifest and the two-pass harness, which store and compare roots.
  Every root changes there. Until then the registry keeps DEC-TRIPLET-IDENTITY-020's roots for its
  blocks.
