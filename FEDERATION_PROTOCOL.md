# FEDERATION_PROTOCOL.md — v1 Wave-1 F1 Read-Only Mirror

> The wire-format and behavioral specification for the v1 wave-1 F1 read-only
> federation mirror. Companion to `FEDERATION.md` (which owns the trust/scale
> axis F0..F4 and the strategic framing). This document is the implementation
> contract that `@yakcc/federation` (WI-020) and the v1 federation demo
> (WI-021) are built against.
>
> **Scope:** F1 read-only mirror only. F2 attestation publishing, F3 ZK
> supply-chain proofs, and F4 economic primitives are out of scope per
> `DEC-V1-WAVE-1-SCOPE-001`. This document explicitly names the v2 surface
> for each deferred concern so the v1 implementation does not pre-empt those
> decisions.

---

## 1. Protocol overview

### What F1 does

A peer **B** running yakcc with `@yakcc/federation` installed configures one
or more **remote peer URLs**. Calling `yakcc federation mirror <remote-url>`
performs a **content-addressed pull** of every block on the remote that is
not yet present in the local registry. After a successful mirror, B's local
registry contains a superset of the blocks it had before, and B can run
`yakcc compile` against those new blocks without further network access.

The pull is by `BlockMerkleRoot`. Triplets are content-addressed: a block's
`spec.yak`, `impl.ts`, and `proof/manifest.json` together produce a single
`BlockMerkleRoot` (`@yakcc/contracts` `blockMerkleRoot()`). Two peers cannot
disagree on what bytes a `BlockMerkleRoot` names — by construction.

### What F1 does not do

- **No publishing.** B never sends blocks to A. The wire is one-way at F1.
  Publishing is F2 and is an explicit v2 surface.
- **No attestation publishing.** B does not sign anything. Attestations
  written by A's local verifier are part of the triplet's
  `proof/manifest.json` and travel inside the triplet, but B does not
  countersign them or attach its own attestation. F2 introduces
  `verifier-citizen` keypairs and signature propagation
  (`FEDERATION.md` "Attestation protocol" lifecycle step 2 at F2).
- **No trust filtering at pull time.** B mirrors everything A is willing
  to serve. Trust filtering happens at **selection time**, not at mirror
  time, per `FEDERATION.md` `DEC-FED-006` (the per-caller trust list is
  sovereign). v1 wave-1 ships without selection-time trust list logic;
  pulled blocks all become selectable. The trust list surface is a
  follow-on, not a v1 wave-1 deliverable.
- **No transport encryption beyond TLS.** Wire confidentiality is
  delegated to HTTPS. There is no application-layer encryption.
- **No identity attestation for the remote peer.** A peer URL is whatever
  the operator configured. v1 trust in the remote is **nominal** — see
  §6 "Trust model".
- **No discovery protocol.** Peer URLs are configured by the operator.
  Peer-to-peer gossip, DHT lookup, or DNS-based discovery are v2 concerns.
- **No gossip / fan-out.** B pulls from A. B does not relay A's blocks
  to a third peer. Each pair of peers is its own one-way edge.

### Why F1 first

Per `DEC-V1-WAVE-1-SCOPE-001`, wave-1 isolates federation against an
already-substantiated L0 substrate (WI-016 + WI-017). F1 is the smallest
slice of federation that proves the cross-machine round-trip invariant: a
block that compiled on A compiles byte-identically on B after a mirror.
Adding publishing, signatures, or trust filtering before that invariant is
proven would entangle independent risk surfaces.

---

## 2. Identity model

### Block identity

`BlockMerkleRoot`. Defined in `@yakcc/contracts`
(`packages/contracts/src/merkle.ts`). The Merkle root is computed over the
canonical bytes of the spec, the impl source, and the proof manifest. Two
peers with the same triplet bytes derive the same `BlockMerkleRoot`. Two
peers with different bytes derive different roots — there is no scenario in
which "the same block" disagrees on content.

### Spec identity

`SpecHash`. Defined in `@yakcc/contracts`. The hash of the canonicalized
`spec.yak`. Multiple blocks may share a `SpecHash` (multiple implementations
of the same contract); the registry's `selectBlocks(specHash)` returns all
of them.

### Peer identity

A peer is identified by **its mirror URL**. The mirror URL is treated as an
opaque addressing token, not as an identity attestation. Specifically:

- v1 has **no peer keypair**. A peer URL is not signed.
- v1 has **no peer name registry**. Two operators serving identical content
  at different URLs are indistinguishable to the protocol.
- v1 has **no peer reputation surface**. Reputation is a v2 concern that
  layers on F2 attestation publishing.

The operator configuring `yakcc federation mirror <url>` is asserting trust
in whatever bytes that URL serves. This is the entire v1 trust model on the
peer-identity dimension.

`@decision: DEC-V1-FEDERATION-PROTOCOL-001` (recorded in `MASTER_PLAN.md`)
captures the identity-model choice: blocks are identified by their content-
addressed `BlockMerkleRoot`; specs by `SpecHash`; peers by mirror URL only.
No peer keypair, no peer name registry. Peer-keyed identity is a v2 surface.

---

## 3. Wire format and transport

### Transport: HTTP + JSON over HTTPS

`@yakcc/federation` speaks HTTP/1.1 or HTTP/2 with JSON bodies. Production
deployments serve over HTTPS; the demo path may use HTTP for localhost-only
two-process round-trips.

**Why HTTP+JSON:**

- Minimal new infrastructure. Every yakcc developer has a working HTTP
  client and server. Static-file hosting is sufficient for the read-only
  case (a peer can serve an exported registry as static files behind any
  HTTP server, no yakcc-specific daemon required).
- Content-addressed semantics map cleanly onto URL paths: a block at
  `/v1/block/<merkleRoot>` is genuinely that block, and HTTP caching
  proxies cache it correctly because the URL never names different bytes.
- Future libp2p/IPFS/CAS transports can layer underneath without changing
  the merge logic; the transport interface (`Transport` in §5) abstracts
  the byte-fetch layer from the registry-merge layer.

**What HTTP+JSON is not:**

- Not optimized for high throughput. A million-block mirror over HTTP/1.1
  is bandwidth-bound, not protocol-bound, but the round-trip overhead per
  request matters. v1 wave-1 ships with HTTP/2 multiplexing as the
  default; bulk-transfer optimizations (range queries, archive endpoints)
  are post-v1.
- Not a long-lived session. Each request is independent. There is no
  WebSocket, no streaming RPC, no persistent gossip channel.

### Endpoints

A peer running F1 read-only mirror exposes these HTTP GET endpoints. All
responses are content-typed JSON unless noted.

#### `GET /v1/manifest`

Returns the **manifest root**: a JSON object naming the protocol version,
the schema version of the underlying registry, and a digest over the set of
served `BlockMerkleRoot`s. This is the entry point a mirror client hits
first to negotiate compatibility.

```
GET /v1/manifest

200 OK
Content-Type: application/json

{
  "protocolVersion": "v1",
  "schemaVersion": 5,
  "blockCount": 1234,
  "rootsDigest": "<hex>",
  "rootsDigestAlgorithm": "blake3-256",
  "servedAt": "2026-04-30T12:00:00Z"
}
```

`rootsDigest` is `BLAKE3-256(sorted_concat(every_BlockMerkleRoot_served))`.
Its purpose is opportunistic short-circuit: if a client has previously
mirrored from this peer and the digest is unchanged, the client may skip
the catalog enumeration. v1 wave-1 implementations may treat this as
advisory; correctness does not depend on it.

`schemaVersion` matches the registry schema version (`SCHEMA_VERSION` in
`@yakcc/registry`). v1 wave-1 ships against schema version 5 (current,
updated by WI-022 which added the `block_artifacts` table).
A version mismatch is a hard error: the client refuses to mirror.

#### `GET /v1/blocks`

Returns the catalog: every `BlockMerkleRoot` the peer is serving, in
canonical sorted order (lexicographic over the hex representation). The
response is paginated.

```
GET /v1/blocks?limit=1000&after=<merkleRootCursor>

200 OK
Content-Type: application/json

{
  "blocks": ["<merkleRoot1>", "<merkleRoot2>", ...],
  "nextCursor": "<merkleRoot1000>" | null
}
```

When `nextCursor` is null, the catalog is exhausted. When non-null, the
client passes it as `after=` on the next request to resume.

The catalog endpoint enables a client to compute `remote_set − local_set`
without downloading every block. Sorted iteration plus an `after` cursor
gives the client an efficient set-difference walk.

#### `GET /v1/block/<merkleRoot>`

Returns the full triplet row keyed by `BlockMerkleRoot`. The body is the
JSON-serialized triplet shape (see §4 "Wire shape").

```
GET /v1/block/abc123...

200 OK
Content-Type: application/json

{
  "blockMerkleRoot": "abc123...",
  "specHash": "...",
  "specCanonicalBytes": "<base64>",
  "implSource": "...",
  "proofManifestJson": "...",
  "artifactBytes": {
    "property_tests/cases.cbor": "<base64>"
  },
  "level": "L0",
  "createdAt": 1714...,
  "canonicalAstHash": "...",
  "parentBlockRoot": "..." | null
}
```

A `404` indicates the peer does not serve that block. This is a normal
condition (the catalog is the source of truth for what is served), not an
error.

#### `GET /v1/spec/<specHash>`

Returns the list of `BlockMerkleRoot`s the peer serves for a given
`SpecHash`. This is the selector-index pull: "find me an implementation of
this contract, on the remote."

```
GET /v1/spec/def456...

200 OK
Content-Type: application/json

{
  "specHash": "def456...",
  "blockMerkleRoots": ["abc123...", "..."]
}
```

A `404` indicates the peer has no blocks satisfying that spec. v1 clients
typically use this endpoint when the local registry has a `SpecHash` but no
satisfying block; the bulk-mirror path uses the catalog instead.

### Errors

Any non-2xx response without a JSON `{ "error": "<code>", "message": "..." }`
body is a protocol violation and the client treats the peer as unhealthy
for the rest of the operation. v1 error codes:

- `not_found` — the named block or spec is not served by this peer.
- `version_mismatch` — `schemaVersion` or `protocolVersion` is incompatible.
- `rate_limited` — the peer is shedding load; the client should back off.
- `internal_error` — the peer encountered an unexpected condition.

---

## 4. Wire shape (the triplet on the network)

The v1 wire shape is a **direct JSON projection of `BlockTripletRow`**
(defined in `@yakcc/registry` `index.ts`), with binary fields base64-
encoded. There is no parallel wire schema and no transformation layer:
what a peer stores is what a peer serves.

```
WireBlockTriplet = {
  blockMerkleRoot: string,         // hex(BlockMerkleRoot)
  specHash:        string,         // hex(SpecHash)
  specCanonicalBytes: string,      // base64(Uint8Array)
  implSource:      string,         // UTF-8 source text
  proofManifestJson: string,       // JSON text (already a string in the row)
  artifactBytes:   Record<string, string>,
                                   // path -> base64(Uint8Array); one entry per
                                   // path declared in proofManifestJson.artifacts.
                                   // Required by the contracts blockMerkleRoot()
                                   // formula (DEC-V1-FEDERATION-WIRE-ARTIFACTS-002).
  level:           "L0"|"L1"|"L2"|"L3",
  createdAt:       number,         // epoch ms (peer-local; informational)
  canonicalAstHash: string,        // hex(CanonicalAstHash)
  parentBlockRoot: string | null,  // hex(BlockMerkleRoot) | null
}
```

### Artifact bytes on the wire

The receiver's `blockMerkleRoot` recomputation MUST equal the
`@yakcc/contracts` `blockMerkleRoot()` formula byte-for-byte
(DEC-TRIPLET-IDENTITY-020), which folds artifact bytes into the proof
root:

```
proof_root        = BLAKE3(
                      canonicalize(manifest.json)
                      || BLAKE3(artifact[0].bytes)
                      || BLAKE3(artifact[1].bytes)
                      || ...  [in manifest declaration order]
                    )
block_merkle_root = BLAKE3(spec_hash || impl_hash || proof_root)
```

Every artifact path declared in `proofManifestJson.artifacts[*].path` MUST
appear as a key in `artifactBytes` with a base64-encoded `Uint8Array`
value. Missing or extra keys are an integrity failure. The receiver
decodes `artifactBytes`, reconstructs a `Map<string, Uint8Array>`, and
calls `@yakcc/contracts` `blockMerkleRoot({ spec, implSource, manifest,
artifacts })` directly (no parallel reimplementation of the formula).

This makes the wire shape strictly larger than the registry row: the
sender pulls artifact bytes from `BlockTripletRow.artifacts` (added by
WI-022), base64-encodes them per path, and emits them inline. The
receiver decodes them and stores them through `Registry.storeBlock`
which writes both the `blocks` row and the matching `block_artifacts`
rows.

**Why inline (not a separate endpoint):** v1 wave-1 corpora are
KB-scale (one `property_tests` artifact per atom). Inline keeps the
wire single-roundtrip, keeps HTTP caching keyed on `BlockMerkleRoot`
correct (the artifacts are part of the block's identity), and avoids
introducing a fifth endpoint. A separate `/v1/artifacts/<path>`
endpoint is a v1-wave-2 surface if measurement shows the inline payload
is too large; that change requires a new DEC entry per
DEC-V1-FEDERATION-WIRE-ARTIFACTS-002.

**No-ownership preservation:** `artifactBytes` is keyed by the manifest's
declared artifact paths. Paths come from the manifest, which itself
carries no ownership data. The wire shape adds bytes, not identity
fields. DEC-NO-OWNERSHIP-011 holds.

### Field-by-field semantics on the wire

- **`blockMerkleRoot`** — the integrity check. The receiver MUST recompute
  `blockMerkleRoot(triplet)` from the received `specCanonicalBytes`,
  `implSource`, and `proofManifestJson`, and reject any triplet whose
  recomputed root does not match the `blockMerkleRoot` field. This is
  non-negotiable: it is what makes the trust model work despite peer-
  identity being nominal (§6).
- **`specHash`** — the selector index. The receiver MUST recompute
  `specHash(specCanonicalBytes)` and reject any triplet whose recomputed
  `specHash` does not match. Two integrity checks (root + spec hash) are
  cheap and they fail loudly when bytes are corrupted in transit.
- **`specCanonicalBytes`** — the *canonicalized* spec bytes. The receiver
  does not re-canonicalize on read; it stores these bytes verbatim. Two
  peers that disagree on canonicalization disagree on `specHash`, which
  surfaces as integrity-check failure on the receiver, not as silent
  divergence. This is the §11 invariant.
- **`implSource`** — the impl.ts text. UTF-8. Stored verbatim.
- **`proofManifestJson`** — the proof manifest, as JSON text. Stored
  verbatim. The L0 manifest schema is enforced by
  `@yakcc/contracts` `validateProofManifestL0()`; v1 wave-1 ingests only
  L0 manifests because v1 wave-1 ships only L0 substantiation
  (`DEC-TRIPLET-L0-ONLY-019`). A mirror receiving an L1+ manifest from a
  remote MUST refuse to ingest it (the local validator would have already
  rejected it; F1 ingest piggybacks on the same validator).
- **`level`** — declared verification level. v1 accepts only `"L0"`. Any
  other value triggers a `version_mismatch`-style rejection.
- **`createdAt`** — peer-local insertion time. **Informational only.**
  The mirror receiver does not adopt the remote's `createdAt` as its own;
  it stamps `createdAt = Date.now()` at local insertion time. Two peers
  with different clocks do not produce divergent `BlockMerkleRoot`s
  because `createdAt` is not in the merkle root computation.
- **`canonicalAstHash`** — recomputable from `implSource`. The receiver
  MAY recompute and verify; v1 implementations SHOULD verify (it is cheap
  and catches a class of malicious-peer attacks where the index is
  corrupted but the impl is plausible).
- **`parentBlockRoot`** — populated by WI-017. Travels in the triplet
  by construction: it is part of `BlockTripletRow`. There is no separate
  lineage-transfer endpoint. If A's atom-persist set `parentBlockRoot =
  X`, then B's mirrored copy carries `parentBlockRoot = X`. This is one of
  WI-021's acceptance criteria (b).
- **`artifactBytes`** — the artifact bytes map (added by WI-022,
  `DEC-V1-FEDERATION-WIRE-ARTIFACTS-002`). Each entry corresponds to one
  path declared in `proofManifestJson.artifacts[*].path`, in declaration
  order. The receiver MUST decode each base64 value back to `Uint8Array`,
  reconstruct a `Map<string, Uint8Array>` in declaration order, and pass
  it to `@yakcc/contracts` `blockMerkleRoot({ spec, implSource, manifest,
  artifacts })` to verify the received `blockMerkleRoot`. Missing or extra
  keys relative to the manifest are an integrity failure. An empty
  `artifactBytes` object (`{}`) is valid for blocks whose manifest
  declares zero artifacts; the receiver hydrates it as `new Map()`.
  Pre-WI-022 blocks that were persisted before this field existed have no
  `block_artifacts` rows in the registry and hydrate locally as
  `new Map()` — they are NOT federation-eligible by construction: the
  wire integrity gate will reject them at the receiver because the
  recomputed root will not match (the sender included zero artifact bytes
  in the root, which is only consistent if the manifest also declares
  zero artifacts). Operators wishing to federate pre-WI-022 blocks must
  re-persist them through the WI-022 path with explicit artifact bytes.
  No ownership-shaped keys or values — `DEC-NO-OWNERSHIP-011`.

### Property-test corpora (WI-016 artifact)

The property-test corpus generated by WI-016 lives **inside
`proofManifestJson`** as part of the L0 proof manifest's
`property_tests` array. It is not a separate wire field. The corpus
survives cross-peer transfer because the `proofManifestJson` string is a
single field that travels verbatim. This is the §11 invariant for the
WI-016 artifact (and matches WI-021 acceptance criterion (a) — manifest
equality is the test).

---

## 5. Public API surface (for WI-020)

`@yakcc/federation` exports the following public surface. WI-020
implements these against the wire defined above.

### Types

```
type RemotePeer = string;  // an opaque mirror-URL token

interface MirrorReport {
  readonly remoteUrl: RemotePeer;
  readonly remoteManifestDigest: string;
  readonly blocksFetched: number;
  readonly blocksAlreadyPresent: number;
  readonly blocksRejected: ReadonlyArray<{
    readonly merkleRoot: BlockMerkleRoot;
    readonly reason: "integrity_failed" | "version_mismatch" |
                     "manifest_invalid" | "level_unsupported" |
                     "transport_error";
  }>;
  readonly startedAt: string;     // ISO-8601
  readonly completedAt: string;   // ISO-8601
}

interface Transport {
  // The byte-fetch primitive. HTTP+JSON in v1; libp2p/IPFS in v2.
  fetchManifest(remote: RemotePeer): Promise<RemoteManifest>;
  fetchCatalogPage(remote: RemotePeer, after: BlockMerkleRoot | null,
                   limit: number): Promise<CatalogPage>;
  fetchBlock(remote: RemotePeer, root: BlockMerkleRoot):
                   Promise<WireBlockTriplet>;
  fetchSpec(remote: RemotePeer, specHash: SpecHash):
                   Promise<readonly BlockMerkleRoot[]>;
}
```

### Functions

```
// Content-addressed pull of a single block.
// Verifies integrity. Throws on integrity failure.
pullBlock(remote: RemotePeer, root: BlockMerkleRoot,
          opts?: { transport?: Transport }):
  Promise<BlockTripletRow>;

// Selector-index pull: "what does the remote serve for this spec?"
pullSpec(remote: RemotePeer, specHash: SpecHash,
         opts?: { transport?: Transport }):
  Promise<readonly BlockMerkleRoot[]>;

// Bulk pull: every block on `remote` whose BlockMerkleRoot is not in `local`.
// Returns a MirrorReport summarizing what happened.
mirrorRegistry(remote: RemotePeer, local: Registry,
               opts?: { transport?: Transport;
                        concurrency?: number;     // default 8
                        signal?: AbortSignal }):
  Promise<MirrorReport>;

// The default HTTP+JSON transport. Exported so callers can wrap it
// (logging, retry, metrics) or replace it (for tests / future libp2p path).
createHttpTransport(opts?: { fetch?: typeof fetch }): Transport;
```

### CLI verbs (in `@yakcc/cli`, wired to `@yakcc/federation`)

```
yakcc federation mirror <remote-url>
    Bulk-pull every block on <remote-url> not yet in the local registry.
    Prints a MirrorReport summary on completion.

yakcc federation pull-block <remote-url> <merkle-root>
    Pull a single block by merkle root. Used for diagnostics.

yakcc federation pull-spec <remote-url> <spec-hash>
    List the merkle roots a remote serves for a given spec hash.
```

### Server side (also in `@yakcc/federation`, optional)

A peer that wishes to *be* a mirror source runs an HTTP server. v1 ships
a minimal implementation:

```
serveRegistry(local: Registry,
              opts: { port: number; bindAddress?: string }):
  Promise<{ url: string; close(): Promise<void> }>;
```

This is sufficient for the WI-021 demo's two-process round-trip path.
Production deployments may wrap their registry behind any HTTPS server
that exposes the §3 endpoints; the canonical implementation is
illustrative, not prescriptive.

---

## 6. Trust model (v1: nominal)

### What v1 trusts

- **The bytes the operator points at.** When an operator runs
  `yakcc federation mirror https://A.example/`, they are asserting trust
  in whatever bytes `https://A.example/` serves. The protocol does not
  cross-check that assertion against any other authority.
- **Content-addressed integrity.** Every fetched triplet is hash-checked
  against its own `BlockMerkleRoot` and `SpecHash`. The receiver fails
  loudly on any byte-level corruption between the remote's claim and the
  bytes received, so a man-in-the-middle who modifies the wire fails the
  integrity check.
- **TLS chain validation.** HTTPS enforces transport-level integrity and
  confidentiality between client and the URL the operator named. v1 does
  not pin certificates; standard system trust roots apply.

### What v1 does not address

These threats are out of scope for v1 and are documented here so v2 can
address each one explicitly:

| Threat | v1 behavior | v2 surface |
|---|---|---|
| Malicious peer serves syntactically-valid but semantically-wrong blocks | Mirror succeeds; block becomes selectable. Selection-time trust list (DEC-FED-006) is the eventual answer. | F2+ trust list configuration; per-caller filtering at selection. |
| Malicious peer serves blocks claiming higher verification level than they meet | Caught in part by L0-only ingest in v1 (any L1+ manifest is rejected at validation). At v1.x when L1+ ships, a peer claiming L2 attestations is taken at its word — F2 attestation signatures fix this. | F2 verifier-citizen signatures bind level claims to a verifier keypair. |
| Peer impersonation (DNS hijack, route hijack) | TLS chain validation catches certificate-mismatch; a successful hijack with a valid certificate is not detected. | F2+ peer keypairs allow operator-configured public-key pinning. |
| Replay / staleness | v1 does not detect that a peer is serving a frozen old snapshot. Pull is idempotent over content, so this manifests as "peer has fewer blocks than expected", not as wrong blocks. | F2+ signed manifests with `validUntil` clocks. |
| Coercion of pinners (in IPFS-DA mode at F3) | Not applicable to v1 (no DA layer). | F3+ cryptoeconomic DA fallback. |
| Author identity exposure | None — the cornerstone forbids author identity in any wire field (§7). The protocol carries no field that could leak it. | n/a — this remains forbidden at every F-level. |

The v1 trust model is **deliberately minimal** because v1 wave-1's job is
to prove the cross-machine round-trip invariant, not to ship the trust
infrastructure. Layering trust onto an unproven round-trip would entangle
two independent risk surfaces.

`@decision: DEC-V1-FEDERATION-PROTOCOL-001` (`MASTER_PLAN.md`) captures
the trust-model choice: nominal trust in the operator-named URL, plus
content-addressed integrity per fetched triplet. Signed manifests, peer
keypairs, and signature-based attestation propagation are deferred to v2
under the F2+ initiative.

---

## 7. No-ownership invariant on the wire

`DEC-NO-OWNERSHIP-011` is preserved by construction. The wire shape (§4)
includes **no** field that names an author, a submitter, an email, an
account, a username, a session, an organization, or any other
person-shaped identifier. This is enforced by deriving `WireBlockTriplet`
directly from `BlockTripletRow`, which itself has no ownership fields by
schema design.

WI-021 acceptance criterion (e) tests this: B never sees A's local file
paths or any author identity after a mirror. The implementation strategy
is "the wire shape has no field that could leak it"; no runtime filter is
needed.

The license gate (`DEC-LICENSE-WIRING-002`) is **local to the publishing
peer**. A peer who refuses to shave a GPL source never produces a triplet
for it; the federation pull on a downstream mirror simply never sees it.
There is no federation-level license filter because there cannot be one
that respects content-addressed integrity (a downstream mirror cannot
re-derive license metadata from `BlockMerkleRoot` alone). This is by
design: license enforcement is upstream, at the boundary between the user
and `yakcc shave`.

---

## 8. Conflict semantics

### Within the same `BlockMerkleRoot`

By content addressing: **two honest peers cannot disagree on what a
`BlockMerkleRoot` names**. If they disagree, exactly one of:

1. The wire was corrupted (caught by integrity check on receive).
2. One peer is malicious / faulty and serving wrong bytes (caught by
   integrity check on receive).
3. The two peers are running incompatible canonicalization
   implementations and produce different `BlockMerkleRoot`s for what they
   each consider the same triplet (caught by `schemaVersion` /
   `protocolVersion` mismatch — they will not even be talking the same
   protocol if the canonicalization disagrees, see §11).

Cases 1 and 2 surface as `integrity_failed` in `MirrorReport.blocksRejected`;
the receiver does not store the corrupt block. Case 3 is impossible within
a fixed (`protocolVersion`, `schemaVersion`) tuple by definition.

### Within the same `SpecHash`

Multiple `BlockMerkleRoot`s can share a `SpecHash`: distinct
implementations of the same contract. The registry is **monotonic** by
schema design (`@yakcc/registry` `Registry` interface, `storeBlock` is
idempotent and append-only). A mirror that pulls two blocks with the same
`SpecHash` stores both; selection time is when one is preferred over the
other. There is no "winning" block at the registry level; the registry's
job is to remember every block, and the selector's job is to rank them
per spec call.

This is what `FEDERATION.md` "Mirror sync semantics" implicitly required;
this document is the explicit version.

### When the receiver already has the block

`storeBlock` is idempotent: storing a `BlockMerkleRoot` that is already
present is a no-op. A repeated mirror is safe and converges to the same
state. The mirror implementation may short-circuit by checking
`getBlock(merkleRoot)` before fetching, and SHOULD do so to avoid
unnecessary wire round-trips, but correctness does not depend on it.

---

## 9. Discovery

v1 discovery is **operator-configured URLs**. There is no automatic
discovery layer. Three concrete configuration paths:

- **CLI flag.** `yakcc federation mirror https://A.example/`
- **Per-call API.** `mirrorRegistry("https://A.example/", local)`
- **Configuration file.** A future enhancement; a `.yakcc/peers.json`
  list is a reasonable shape but not required by v1 wave-1.

Out of scope for v1:

- DNS-based discovery (`_yakcc._tcp` SRV records, etc.)
- DHT lookup
- Gossip / peer-exchange (a peer telling its caller about other peers)
- BitTorrent-style trackers

These are v2 concerns. Deferring discovery to v2 is consistent with v1's
"prove the round-trip first" stance: a single configured URL is enough to
demonstrate the cross-machine invariant.

---

## 10. Failure modes

| Failure | v1 behavior |
|---|---|
| Network partition mid-mirror | The `mirrorRegistry` call rejects with the underlying transport error; the registry is left in whatever partial state was reached. Re-running the mirror resumes (idempotent storeBlock + catalog cursor). The `MirrorReport` from a partial run reports `blocksFetched` so far and the transport error per rejected fetch. |
| Stale remote manifest | The client sees the manifest, fetches the catalog, gets the (stale) block set. v1 does not detect staleness. The pull is correct over the snapshot the remote happens to be serving, even if a fresher snapshot exists upstream of the remote. |
| Remote returns corrupted bytes | `pullBlock`/`mirrorRegistry` throws / records `integrity_failed`. The block is not stored. The mirror continues with subsequent blocks (the caller's `MirrorReport.blocksRejected` records the failure for inspection). |
| Remote returns 404 for a block named in the catalog | Treated as `integrity_failed` for that block; recorded in `MirrorReport.blocksRejected` with `reason="not_found"`. Catalog/block consistency is the remote's responsibility. |
| Remote returns `version_mismatch` | The mirror aborts at manifest negotiation. No partial state. |
| Local registry write fails (disk full, permission denied) | The mirror aborts with the underlying registry error. Whatever was already stored remains stored (storeBlock is its own atomic boundary). |
| Concurrent mirror calls on the same local registry | Serialized by SQLite's transaction model. Two `mirrorRegistry` calls running at once each see consistent local state but may do duplicate `getBlock` checks; correctness holds, performance suffers. v1 does not lock the registry across the whole mirror — a future enhancement may add a registry-level mirror lock. |
| Local registry has a block at a higher schema version than remote | `version_mismatch` at manifest negotiation. v1 does not migrate blocks across schema versions; the operator must upgrade both sides. |
| Local registry has a block under L1+ that the remote does not have at all | v1 wave-1 only handles L0 anyway. A v1.x release that adds L1+ ingest would treat L1+ blocks the remote lacks as "remote does not serve them"; nothing happens, the local L1+ block stays put. |

The general principle: **mirror failures are loud, partial, and recoverable
by re-running**. v1 does not silently swallow errors and does not
interrupt the caller's program for a single bad block; it records the
failure in `MirrorReport.blocksRejected` and continues.

---

## 11. The cross-machine canonicalization invariant

This is the load-bearing invariant that makes F1 work without trust.

**Invariant:** `BlockMerkleRoot` is a pure function of canonical triplet
bytes. Two peers running the same `@yakcc/contracts` version, given the
same triplet, derive the same `BlockMerkleRoot`. Two peers running
different `@yakcc/contracts` versions are barred from speaking the
protocol (manifest `schemaVersion` mismatch).

**Why it matters:** every other property of the protocol — integrity
checking, conflict-freedom, idempotent merge, no-ownership preservation —
reduces to this invariant. If `BlockMerkleRoot` is not stable across
peers, content addressing fails, and the F1 read-only mirror cannot make
any of its claims.

**How it is enforced:**

1. `@yakcc/contracts` `canonicalize()` is a pure function of input bytes.
2. `blockMerkleRoot(triplet)` is a pure function of the canonicalized
   spec bytes plus the impl source plus the canonicalized proof manifest
   plus the per-artifact bytes in manifest-declared order
   (DEC-TRIPLET-IDENTITY-020). The wire's `artifactBytes` field carries
   those per-artifact bytes verbatim
   (DEC-V1-FEDERATION-WIRE-ARTIFACTS-002 / §4 "Artifact bytes on the
   wire") so the receiver can recompute the same value the sender
   computed at persist time.
3. `schemaVersion` and `protocolVersion` in the manifest endpoint
   prevent two incompatible canonicalization implementations from
   speaking the protocol at all.

**What can break it:**

- A non-deterministic canonicalization implementation. Caught by the
  existing canonicalization invariant tests in `@yakcc/contracts`; not a
  v1 federation concern beyond "trust the existing tests."
- Locale-dependent string handling, time-dependent serialization, or
  random insertion order. None of these exist in `@yakcc/contracts`
  today. v1 federation does not introduce any new such surface.

WI-021 acceptance criterion (c) is the cross-machine validation of this
invariant: `yakcc compile`'s emitted TS module is byte-identical on A and
B after a mirror. That byte-identical compile is exactly what the
invariant promises.

---

## 12. Out of scope (v2 surfaces, named explicitly)

These are deferred to v2 (or later). Named here so the v1 implementation
does not reach for any of them:

- **F2 attestation publishing.** Per-caller verifier identity, signed
  attestation tuples, attestation propagation. v2 surface; introduces the
  `signer` and `signature` fields documented in `FEDERATION.md`
  "Attestation protocol".
- **F3 ZK supply-chain proofs.** Deferred per `FEDERATION.md` §"ZK
  supply-chain proofs"; requires the chain layer.
- **F4 economic primitives.** Bounties, Proof-of-Fuzz, Stake-to-Refine,
  L3 economic premium. Deferred per `FEDERATION.md` §"Economic mechanics
  (F4 only)".
- **Authentication of the client.** v1 servers are open. A peer that
  wants to limit who can mirror it is on its own (HTTP basic auth in
  front of the server, IP allowlists, etc.) — v1 does not specify a
  client-auth surface.
- **Authorization.** Per-block access controls. Out of scope; the v1
  contract is "every block is publicly mirrorable."
- **Signed manifests.** Manifest endpoint returns plain JSON. v2 may
  add an `Ed25519` signature block over the manifest.
- **Gossip / peer exchange.** A peer learning about other peers. v2.
- **Bulk archive endpoints.** A `GET /v1/archive` returning a pack file
  of every block. Performance optimization deferred until measurable.
- **Range queries.** "Give me every block whose `BlockMerkleRoot` starts
  with prefix X." Performance optimization deferred until measurable.
- **Delta encoding.** "Give me every block since timestamp T." v1 ships
  set-difference via the catalog cursor; delta-by-time is a performance
  enhancement, not a correctness requirement.
- **Cross-version migration.** Schema-version 5 talks to schema-version 5
  and nothing else. A future v1.1 with schema-version 6+ will need a
  migration story; not v1 wave-1's job.
- **Non-HTTP transports.** libp2p, IPFS, custom binary. The `Transport`
  interface (§5) makes these slot-in possible without rewriting the
  merge logic, but no non-HTTP transport ships in v1 wave-1.

Each of the above is a real surface that some real deployment will want
eventually. v1 wave-1 ships none of them, on purpose, to keep the round-
trip slice small enough to verify against the WI-021 demo.

---

## 13. Acceptance for WI-020 implementation

The protocol described above is the public contract WI-020 must implement.
Concretely, WI-020's Evaluation Contract derives from this document by:

- **Required public surface** (every entry in §5 must be exported from
  `@yakcc/federation`'s package entry):
  - Types: `RemotePeer`, `MirrorReport`, `Transport`, `WireBlockTriplet`,
    `RemoteManifest`, `CatalogPage`.
  - Functions: `pullBlock`, `pullSpec`, `mirrorRegistry`,
    `createHttpTransport`, `serveRegistry`.
- **Required wire compliance:** the JSON shape in §4 is what the HTTP
  server emits and what the HTTP client accepts; round-trip tests on
  every triplet in the WI-021 corpus produce byte-identical
  `BlockTripletRow` values on both sides.
- **Required integrity checks** on receive: `BlockMerkleRoot` and
  `SpecHash` recomputation, `level` validation (L0 only in v1 wave-1),
  proof manifest L0 validation
  (`@yakcc/contracts` `validateProofManifestL0`).
- **Required absence of forbidden surfaces:** no F2 publishing endpoint;
  no signature fields on the wire; no author/submitter fields anywhere;
  no license-bypass surface; no parallel canonicalizer.
- **Required CLI integration:** `yakcc federation mirror`,
  `yakcc federation pull-block`, `yakcc federation pull-spec` wired in
  `@yakcc/cli`.
- **Required tests:** in-process two-registry round-trip; cross-process
  two-registry round-trip via local HTTP; verify byte-identical triplet
  shape; verify `MirrorReport` shape on success and on partial failure.

The WI-021 demo (v1 federation acceptance) consumes WI-020's surface
unchanged; this protocol document is the contract between the two work
items, and changes to it after WI-020 lands require a new DEC entry.

---

## 14. Decision log (this document)

This document is the v1 wave-1 protocol contract. The single load-bearing
DEC entry it introduces is `DEC-V1-FEDERATION-PROTOCOL-001` in
`MASTER_PLAN.md`, which captures the four protocol-level choices:

1. **Transport: HTTP+JSON over HTTPS** with an abstract `Transport`
   interface so future libp2p/IPFS transports slot in without changing
   the merge logic.
2. **Identity: content-addressed.** Blocks by `BlockMerkleRoot`; specs
   by `SpecHash`; peers by mirror URL only (no peer keypair in v1).
3. **Trust: nominal.** v1 trusts whatever the operator points at; every
   fetched triplet is integrity-checked against its own `BlockMerkleRoot`
   and `SpecHash`. F2 attestation publishing and signed manifests are v2.
4. **Sync direction: pull-only, read-only.** B pulls from A; B never
   pushes. Publishing (F2) is v2.

The detailed wire format, endpoint shapes, and failure semantics in this
document are derivable from those four choices plus the existing
`@yakcc/contracts` and `@yakcc/registry` shapes; they are not separate
DEC entries because they are mechanical consequences of the four above.

Forward references:

- `FEDERATION.md` `DEC-FED-001..DEC-FED-007` — the strategic axis.
- `MASTER_PLAN.md` `DEC-V1-WAVE-1-SCOPE-001` — what v1 wave-1 ships.
- `MASTER_PLAN.md` `DEC-NO-OWNERSHIP-011` — preserved on the wire by §7.
- `MASTER_PLAN.md` `DEC-LICENSE-WIRING-002` — license gate is upstream;
  no federation-level license filter (§7).
- `MASTER_PLAN.md` `DEC-TRIPLET-L0-ONLY-019` — v1 wave-1 ingests L0 only.
- `VERIFICATION.md` triplet identity — the foundation §11 builds on.
