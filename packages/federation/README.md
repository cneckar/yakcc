# @yakcc/federation

F1 read-only content-addressed block mirror for Yakcc registries.

## What this package provides

`@yakcc/federation` implements the F1 read-only mirror tier of the Yakcc trust
axis (`FEDERATION.md` F0..F4). Two machines A and B each hold a local `Registry`.
A serves its blocks over HTTP; B pulls individual blocks or mirrors the full
catalog. Every transferred block is integrity-checked by recomputing its
`BlockMerkleRoot` via `@yakcc/contracts`'s `blockMerkleRoot()` — the same formula
that produced the identity on A. No F2+ capabilities (block submission, dispute
adjudication, trust lists, authentication) are included in this package. See
`FEDERATION.md` for the F2..F4 roadmap.

The end-to-end v1 federation demo landed in WI-021 (`d9cb449`) with a full
acceptance test suite at `examples/v1-federation-demo/test/acceptance.test.ts`
proving cross-machine byte-identical compile.

## Public API

### Wire serialization

| Export | Description |
|--------|-------------|
| `serializeWireBlockTriplet(row)` | Serialize a `BlockTripletRow` into a `WireBlockTriplet` for transmission. Artifact bytes are base64-encoded. |
| `deserializeWireBlockTriplet(wire)` | Deserialize and integrity-check a received `WireBlockTriplet`. Throws `IntegrityError` when the recomputed `BlockMerkleRoot` does not match the claimed root. |

### HTTP transport

| Export | Description |
|--------|-------------|
| `createHttpTransport(options?)` | Create the default HTTP `Transport` for production use. |
| `HttpTransportOptions` | Options type for `createHttpTransport`. |

### Pull primitives

| Export | Description |
|--------|-------------|
| `pullBlock(remote, merkleRoot, options?)` | Fetch a single block by `BlockMerkleRoot` from a remote peer. Integrity-checks the received wire triplet before returning. Throws `IntegrityError` on mismatch. |
| `pullSpec(remote, specHash, options?)` | Fetch all blocks satisfying a `SpecHash` from a remote peer. Returns an array of integrity-checked `BlockTripletRow` values. |
| `PullOptions` | Options type for `pullBlock` / `pullSpec`. Accepts a `transport` field for test injection. |

### Mirror

| Export | Description |
|--------|-------------|
| `mirrorRegistry(remote, localRegistry, transport)` | Pull all blocks from a remote registry into the local registry. Fetches the remote catalog (`/v1/specs`), pulls all missing blocks, and stores them idempotently via `localRegistry.storeBlock`. Returns a `MirrorReport`. |
| `MirrorOptions` | Options type for `mirrorRegistry`. |

### Serve

| Export | Description |
|--------|-------------|
| `serveRegistry(registry, options?)` | Start a read-only HTTP server exposing the F1 federation wire protocol (WI-020). Returns a `ServeHandle` with `url` and `close()`. |
| `ServeHandle` | Handle type returned by `serveRegistry`. Fields: `url: string`, `close(): Promise<void>`. |
| `ServeOptions` | Options type for `serveRegistry`. Fields: `port` (default 0 = OS-assigned), `host` (default `"127.0.0.1"`). |

### Error classes

| Export | Description |
|--------|-------------|
| `IntegrityError` | Thrown when a received wire block's recomputed `BlockMerkleRoot` does not match the claimed root. |
| `VersionMismatchError` | Thrown on HTTP-level version negotiation failure. |
| `SchemaVersionMismatchError` | Thrown when the remote registry's schema version is incompatible with the local schema version. |
| `TransportError` | Thrown on network-level transport failures (DNS, connection refused, timeout). |

### Public types

`RemotePeer`, `RemoteManifest`, `CatalogPage`, `MirrorRejectionReason`,
`MirrorRejection`, `MirrorReport`, `Transport`, `WireBlockTriplet`.

## Wire shape

Blocks are transferred as `WireBlockTriplet` over HTTP+JSON
(`DEC-V1-FEDERATION-PROTOCOL-001`):

- **Identity**: content-addressed by `BlockMerkleRoot`.
- **Spec selector**: blocks can also be located by `SpecHash` via `pullSpec`.
- **Artifact bytes**: carried as `Record<string, string>` (base64-encoded,
  keyed by manifest-declared path). This is required — the `artifactBytes` field
  is not optional — because the contracts formula folds artifact bytes into the
  `BlockMerkleRoot`; omitting them would cause the recomputed root to diverge
  (`DEC-V1-FEDERATION-WIRE-ARTIFACTS-002`).

## What is preserved cross-machine

The v1 invariant: every transferred block is **byte-identical A→B**. Specifically:

- `parent_block_root` (WI-017) — decomposition lineage is carried verbatim.
- `property_tests` artifacts (WI-016) — proof manifests travel with the block.
- All triplet bytes participate in the `BlockMerkleRoot` derivation, so the
  integrity check catches any corruption or truncation in transit.

## What is NOT included

- Local file paths — blocks carry no source file reference on the wire.
- Author identity — `DEC-NO-OWNERSHIP-011` is enforced end-to-end; no identity
  fields exist anywhere in the wire format or registry schema.
- License-refused source — the license gate runs in `@yakcc/shave` before any
  block is persisted locally; refused source is never stored, never served.
- F2+ capabilities — no push API, no dispute mechanism, no trust list, no
  authentication. Pull-only. See `FEDERATION.md` for the full axis.

## CLI usage

```sh
# Server side: serve the local registry on port 4040
yakcc federation serve --registry .yakcc/registry.db --port 4040

# Client: mirror all blocks from a remote peer
yakcc federation mirror --remote http://peer-a:4040 --registry .yakcc/registry.db

# Client: pull a single block and persist it (WI-030)
yakcc federation pull --remote http://peer-a:4040 \
  --root <blockMerkleRoot> \
  --registry .yakcc/registry.db
```

See `packages/cli/README.md` for the full `yakcc federation` subcommand table.

## Example

```ts
import { serveRegistry, mirrorRegistry, createHttpTransport } from "@yakcc/federation";
import { openRegistry } from "@yakcc/registry";

// Server side (machine A)
const registryA = await openRegistry("registry-a.db");
const handle = await serveRegistry(registryA, { port: 4040 });
console.log(`serving at ${handle.url}`);
// ... handle.close() on shutdown

// Client side (machine B)
const registryB = await openRegistry("registry-b.db");
const transport = createHttpTransport();
const report = await mirrorRegistry("http://machine-a:4040", registryB, transport);
console.log(`mirrored ${report.pulled} blocks, ${report.failures.length} failures`);
await registryB.close();
```

## Cross-references

- `FEDERATION_PROTOCOL.md` — full wire protocol specification
- `FEDERATION.md` — F0..F4 trust/scale axis
- `@yakcc/registry` — `Registry` interface consumed by `mirrorRegistry` and `serveRegistry`
- `@yakcc/contracts` — `blockMerkleRoot()` used for wire integrity checking
- `DEC-V1-FEDERATION-PROTOCOL-001` — HTTP+JSON transport, content-addressed identity
- `DEC-V1-FEDERATION-WIRE-ARTIFACTS-002` — required `artifactBytes` in wire format

## License

This package is dedicated to the public domain under [The Unlicense](../../LICENSE).
