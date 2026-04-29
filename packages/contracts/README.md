# @yakcc/contracts

The shape of a Yakcc contract. This package is the shared vocabulary for the
entire monorepo: every other package imports its types from here.

## What this package provides

- **`ContractSpec`** — the structured behavioral specification of a basic block.
  Declares input/output types, behavioral guarantees, error conditions, and
  non-functional properties (time/space complexity, purity, thread safety).
- **`ContractId`** — a branded string carrying the content-address (hash) of a
  canonicalized `ContractSpec`. Two specs that canonicalize identically share
  an id; two distinct specs have distinct ids.
- **`Contract`** — an id paired with its spec and attached verification evidence.
  The id is immutable; the evidence is mutable metadata that improves over time.
- **`ProposalResult`** — the discriminated union returned by `proposeContract`.
  Either the proposal matched an existing contract (`status: "matched"`) or was
  accepted as a new one (`status: "accepted"`).
- **`canonicalize(spec)`** — deterministic JSON serialization with sorted keys.
  This is the canonical form that content-addressing hashes.
- **`contractId(spec)`** — derives the `ContractId` from a spec. v0 uses an
  FNV-style structural hash over the canonical form; WI-002 replaces this with
  BLAKE3 once the hash dependency is locked.
- **`generateEmbedding(spec)`** — returns a 384-dimensional `Float32Array`
  representing the spec for vector search. v0 returns a zero vector; WI-002
  wires this to `transformers.js`.
- **`proposeContract(spec)`** — submits a proposal and returns a `ProposalResult`.
  v0 always accepts (returns `{status: "accepted", id}`); WI-003 connects this
  to the live registry.

## What this package does not do (yet)

- **No BLAKE3 hashing** — WI-002 replaces the FNV facade with a real hash.
- **No live embeddings** — WI-002 wires `transformers.js`; v0 returns zero vectors.
- **No registry connection** — `proposeContract` is a facade; WI-003 connects it.
- **No strictness inference** — strictness ordering is contributor-declared in v0;
  automated inference is a v0.5+ concern.

## How callers consume this package

```ts
import type { ContractSpec, ContractId } from "@yakcc/contracts";
import { contractId, canonicalize, proposeContract } from "@yakcc/contracts";

const spec: ContractSpec = {
  inputs: [{ name: "s", type: "string" }],
  outputs: [{ name: "result", type: "number[]" }],
  behavior: "Parse a JSON array of integers with no other types or escapes.",
  guarantees: [],
  errorConditions: ["Throws on malformed input"],
  nonFunctional: { purity: "pure", threadSafety: "safe" },
  propertyTests: [],
};

const id = contractId(spec); // stable content-address
const result = await proposeContract(spec); // { status: "accepted", id }
```

## License

This package is dedicated to the public domain under [The Unlicense](../../LICENSE).
