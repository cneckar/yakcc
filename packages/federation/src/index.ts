// @decision DEC-V1-FEDERATION-PROTOCOL-001: HTTP+JSON transport, content-addressed
// block identity (BlockMerkleRoot + SpecHash), nominal peer trust (mirror URL only),
// pull-only read-only sync direction.
// Status: decided (MASTER_PLAN.md DEC-V1-FEDERATION-PROTOCOL-001)
// Contract document: FEDERATION_PROTOCOL.md
// Rationale: Minimal new infrastructure; maps cleanly onto content-addressed URLs;
// Transport interface seam allows future libp2p/IPFS without rewriting merge logic.
//
// @decision DEC-V1-FEDERATION-WIRE-ARTIFACTS-002: WireBlockTriplet.artifactBytes
// is required (Record<string, string>, base64-encoded). The wire integrity check
// must call @yakcc/contracts blockMerkleRoot() directly — NO parallel merkle helper
// inside @yakcc/federation. artifactBytes carries the bytes the contracts formula
// folds into the proof root; without them the recomputed root diverges from the
// persisted BlockMerkleRoot.
// Status: decided (MASTER_PLAN.md DEC-V1-FEDERATION-WIRE-ARTIFACTS-002)
//
// Barrel export strategy: Slice 0 exports types only. Runtime function exports
// (serializeWireBlockTriplet, deserializeWireBlockTriplet, pullBlock, pullSpec,
// mirrorRegistry, createHttpTransport, serveRegistry) are added in subsequent
// slices A–F as their owning modules land. This avoids typecheck failures from
// forwarding to modules that don't yet exist.

// ---------------------------------------------------------------------------
// Types (Slice 0 — complete public type surface)
// ---------------------------------------------------------------------------

export type {
  RemotePeer,
  RemoteManifest,
  CatalogPage,
  MirrorRejectionReason,
  MirrorRejection,
  MirrorReport,
  Transport,
  WireBlockTriplet,
} from "./types.js";

export {
  IntegrityError,
  VersionMismatchError,
  SchemaVersionMismatchError,
  TransportError,
} from "./types.js";

// ---------------------------------------------------------------------------
// Wire serialization (Slice A)
// ---------------------------------------------------------------------------

export { serializeWireBlockTriplet, deserializeWireBlockTriplet } from "./wire.js";

// ---------------------------------------------------------------------------
// HTTP transport (Slice B)
// ---------------------------------------------------------------------------

export { createHttpTransport } from "./http-transport.js";
export type { HttpTransportOptions } from "./http-transport.js";

// ---------------------------------------------------------------------------
// Pull primitives (Slice C)
// ---------------------------------------------------------------------------

export { pullBlock, pullSpec } from "./pull.js";
export type { PullOptions } from "./pull.js";

// ---------------------------------------------------------------------------
// Mirror (Slice D)
// ---------------------------------------------------------------------------

export { mirrorRegistry } from "./mirror.js";
export type { MirrorOptions } from "./mirror.js";

// ---------------------------------------------------------------------------
// Serve (Slice E)
// ---------------------------------------------------------------------------

export { serveRegistry } from "./serve.js";
export type { ServeHandle, ServeOptions } from "./serve.js";
