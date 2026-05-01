# @yakcc/contracts

The shape of a Yakcc contract. This package is the shared vocabulary for the
entire monorepo: every other package imports its types from here.

## What this package provides

- **`ContractSpec`** — the structured behavioral specification of a basic block.
  Declares input/output types, behavioral guarantees, error conditions, and
  non-functional properties (time/space complexity, purity, thread safety).
- **`ContractId`** — a branded string carrying the content-address (BLAKE3-256 hash)
  of a canonicalized `ContractSpec`. Two specs that canonicalize identically share
  an id; two distinct specs have distinct ids.
- **`Contract`** — an id paired with its spec and attached verification evidence.
  The id is immutable; the evidence is mutable metadata that improves over time.
- **`ProposalResult`** — the discriminated union returned by `proposeContract`.
  Either the proposal matched an existing contract (`status: "matched"`) or was
  accepted as a new one (`status: "accepted"`).
- **`BlockTripletRow`** — the canonical persisted shape of a block:
  - `spec: ContractSpec`
  - `impl: string` — source text of the implementation
  - `proofManifest: ProofManifest` — per-atom property tests (non-empty since WI-016)
  - `artifacts: Map<string, Uint8Array>` — compiled artifact bytes (added in WI-022a)
- **`canonicalize(spec)`** — deterministic JSON serialization with sorted keys.
  This is the canonical form that content-addressing hashes.
- **`specHash(spec)`** — BLAKE3-256 hash of the canonical spec form. Live.
- **`blockMerkleRoot(triplet)`** — BLAKE3-256 Merkle root over `(spec, impl, proofManifest, artifacts)`.
  The `artifacts` field is included in the root (WI-022a). This is the stable
  content-address used throughout the registry and compile pipeline.
- **`generateEmbedding(spec)`** — returns a 384-dimensional `Float32Array`
  representing the spec for vector search. Uses transformers.js local model by
  default; no API key required.
- **`proposeContract(spec)`** — submits a proposal and returns a `ProposalResult`.
  Connects to the live registry.

## Canonicalization rules

The canonicalization rules are locked. Any change to `canonicalize()` would
invalidate all existing content-addresses, so the schema is stable. The
`artifacts` field participates in the Merkle root but not in the spec hash —
two blocks with identical specs but different compiled artifacts have the same
`ContractId` but different `blockMerkleRoot` values.

## How callers consume this package

```ts
import type { ContractSpec, ContractId, BlockTripletRow } from "@yakcc/contracts";
import { specHash, blockMerkleRoot, canonicalize, proposeContract } from "@yakcc/contracts";

const spec: ContractSpec = {
  inputs: [{ name: "s", type: "string" }],
  outputs: [{ name: "result", type: "number[]" }],
  behavior: "Parse a JSON array of integers with no other types or escapes.",
  guarantees: [],
  errorConditions: ["Throws on malformed input"],
  nonFunctional: { purity: "pure", threadSafety: "safe" },
  propertyTests: [],
};

const id = specHash(spec);           // BLAKE3-256 content-address of spec alone
const result = await proposeContract(spec); // { status: "accepted", id }

const triplet: BlockTripletRow = { spec, impl: "...", proofManifest: { ... }, artifacts: new Map() };
const root = blockMerkleRoot(triplet); // Merkle root over all four fields
```

## License

This package is dedicated to the public domain under [The Unlicense](../../LICENSE).
