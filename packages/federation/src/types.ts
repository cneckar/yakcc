// SPDX-License-Identifier: MIT
// @decision DEC-NO-OWNERSHIP-011: No author, signer, owner, email, account,
// username, organization, session, or any person-shaped identifier anywhere
// in these types. The wire shape is a direct projection of BlockTripletRow,
// which itself carries no ownership fields by schema design.
// Status: decided (MASTER_PLAN.md DEC-NO-OWNERSHIP-011)
// Rationale: Cornerstone. The registry is a public-domain commons; federation
// mirrors content-addressed blocks, not identities.

// @decision DEC-V1-WAVE-1-SCOPE-001: F1 read-only mirror only.
// No F2 publishing, no auth, no signed manifests in v1 wave-1.
// Status: decided (MASTER_PLAN.md DEC-V1-WAVE-1-SCOPE-001)

// @decision DEC-TRIPLET-L0-ONLY-019: v0.6 ships L0 only. The wire transport
// carries the `level` field but the receiver rejects any level other than "L0".
// Status: decided (MASTER_PLAN.md DEC-TRIPLET-L0-ONLY-019)

import type { BlockMerkleRoot, SpecHash } from "@yakcc/contracts";

// ---------------------------------------------------------------------------
// Peer identity
// ---------------------------------------------------------------------------

/**
 * An opaque mirror-URL token identifying a remote peer.
 * v1 has no peer keypair — a peer is identified solely by its mirror URL.
 * Per FEDERATION_PROTOCOL.md §2 and DEC-V1-FEDERATION-PROTOCOL-001.
 */
export type RemotePeer = string;

// ---------------------------------------------------------------------------
// Wire shape returned by GET /v1/manifest
// ---------------------------------------------------------------------------

/**
 * The manifest root returned by a remote peer's GET /v1/manifest endpoint.
 * Entry point for mirror-client compatibility negotiation.
 *
 * FEDERATION_PROTOCOL.md §3 "GET /v1/manifest".
 * No ownership fields — DEC-NO-OWNERSHIP-011.
 */
export interface RemoteManifest {
  /** Always "v1" in v1 wave-1. */
  readonly protocolVersion: string;
  /**
   * Registry schema version. Must match the local SCHEMA_VERSION
   * (imported from @yakcc/registry). Mismatch → VersionMismatchError.
   */
  readonly schemaVersion: number;
  /** Total blocks served by this peer. */
  readonly blockCount: number;
  /**
   * BLAKE3-256(sorted_concat(every_BlockMerkleRoot_served)) as hex.
   * Advisory short-circuit: unchanged digest means no new blocks.
   */
  readonly rootsDigest: string;
  /** Always "blake3-256" in v1. */
  readonly rootsDigestAlgorithm: string;
  /** ISO-8601 timestamp of when this manifest was generated. */
  readonly servedAt: string;
}

// ---------------------------------------------------------------------------
// Wire shape returned by GET /v1/blocks
// ---------------------------------------------------------------------------

/**
 * A page of the remote peer's block catalog.
 * FEDERATION_PROTOCOL.md §3 "GET /v1/blocks".
 */
export interface CatalogPage {
  /** Block merkle roots in lexicographic sorted order. */
  readonly blocks: readonly BlockMerkleRoot[];
  /**
   * Cursor for the next page. Pass as `after=` on the next request.
   * null when the catalog is exhausted.
   */
  readonly nextCursor: BlockMerkleRoot | null;
}

// ---------------------------------------------------------------------------
// Mirror operation report
// ---------------------------------------------------------------------------

/**
 * Reason a block was rejected during a mirror operation.
 * Each reason maps to a distinct failure mode in FEDERATION_PROTOCOL.md §10.
 */
export type MirrorRejectionReason =
  | "integrity_failed" // blockMerkleRoot or specHash recomputation mismatch
  | "version_mismatch" // level or schemaVersion incompatibility
  | "manifest_invalid" // proofManifestJson failed validateProofManifestL0
  | "level_unsupported" // level !== "L0" (v1 wave-1 only accepts L0)
  | "transport_error"; // network / HTTP error during fetch

/**
 * A single block rejection entry in a MirrorReport.
 */
export interface MirrorRejection {
  readonly merkleRoot: BlockMerkleRoot;
  readonly reason: MirrorRejectionReason;
}

/**
 * Summary of a completed mirror operation.
 * Returned by mirrorRegistry() on both success and partial failure.
 *
 * FEDERATION_PROTOCOL.md §5 "Types".
 * No ownership fields — DEC-NO-OWNERSHIP-011.
 *
 * @decision DEC-MIRROR-REPORT-020: MirrorReport shape for Slice D v2.
 * Status: decided (WI-020 Dispatch D)
 * Rationale: The v2 mirror walks by spec→block hierarchy (listSpecs / listBlocks)
 * rather than a flat catalog page walk, so the report shape tracks specsWalked,
 * blocksConsidered, blocksInserted, and blocksSkipped to reflect idempotency.
 * Failures carry per-failure ISO-8601 timestamps for observability.
 */
export interface MirrorReport {
  /** The remote serve URL that was mirrored from. */
  readonly serveUrl: string;
  /** Schema version reported by the remote peer. */
  readonly schemaVersion: number;
  /** ISO-8601 timestamp when the mirror operation began. */
  readonly startedAt: string;
  /** ISO-8601 timestamp when the mirror operation completed. */
  readonly finishedAt: string;
  /** Number of distinct spec hashes walked on the remote. */
  readonly specsWalked: number;
  /** Total number of blocks examined across all specs. */
  readonly blocksConsidered: number;
  /** Number of blocks successfully fetched and inserted into the local registry. */
  readonly blocksInserted: number;
  /** Number of blocks already present in the local registry (idempotency skips). */
  readonly blocksSkipped: number;
  /**
   * Blocks that failed integrity checks or could not be fetched.
   * Mirror failures are loud, partial, and recoverable — FEDERATION_PROTOCOL.md §10.
   * Failures include per-failure ISO-8601 timestamps for observability.
   */
  readonly failures: ReadonlyArray<{
    readonly specHash: string;
    /** null when the block root could not be decoded from the wire. */
    readonly blockMerkleRoot: string | null;
    readonly reason: string;
    /** ISO-8601 timestamp of when this failure was recorded. */
    readonly at: string;
  }>;
}

// ---------------------------------------------------------------------------
// Transport interface
// ---------------------------------------------------------------------------

/**
 * The byte-fetch abstraction between the mirror logic and the network.
 *
 * v1 wave-1 ships one concrete implementation: createHttpTransport().
 * The interface is abstract enough to slot in libp2p/IPFS transports in v2
 * without rewriting the merge logic — FEDERATION_PROTOCOL.md §3 "Why HTTP+JSON".
 *
 * DEC-V1-FEDERATION-PROTOCOL-001: Transport choice is HTTP+JSON in v1;
 * the interface is the seam for future non-HTTP transports.
 *
 * @decision DEC-TRANSPORT-SCHEMA-VERSION-020: getSchemaVersion() is the first call
 * mirrorRegistry makes before inserting anything. If the remote schema version
 * exceeds the local SCHEMA_VERSION, mirrorRegistry throws SchemaVersionMismatchError
 * before touching the local registry. This is a hard abort, not a per-block failure.
 * Status: decided (WI-020 Dispatch D)
 *
 * @decision DEC-TRANSPORT-LIST-METHODS-020: listSpecs/listBlocks replace the flat
 * catalog-page walk used in the v1 mirror. The spec-then-blocks hierarchy maps more
 * cleanly onto the registry's own selectBlocks(specHash) authority and enables
 * per-spec idempotency checks. listBlocks is semantically identical to fetchSpec
 * but its name communicates intent at the call site inside mirrorRegistry.
 * Status: decided (WI-020 Dispatch D)
 */
export interface Transport {
  /**
   * Fetch the manifest from a remote peer.
   * Maps to GET /v1/manifest.
   */
  fetchManifest(remote: RemotePeer): Promise<RemoteManifest>;

  /**
   * Fetch one page of the remote peer's block catalog.
   * Maps to GET /v1/blocks?limit=<limit>&after=<after>.
   * after=null fetches the first page.
   */
  fetchCatalogPage(
    remote: RemotePeer,
    after: BlockMerkleRoot | null,
    limit: number,
  ): Promise<CatalogPage>;

  /**
   * Fetch a single block triplet by its merkle root.
   * Maps to GET /v1/block/<root>.
   * Returns the raw WireBlockTriplet (deserialization/integrity-check
   * is the caller's responsibility via deserializeWireBlockTriplet).
   */
  fetchBlock(remote: RemotePeer, root: BlockMerkleRoot): Promise<WireBlockTriplet>;

  /**
   * Fetch all block merkle roots the remote serves for a given spec hash.
   * Maps to GET /v1/spec/<specHash>.
   * Returns [] when the remote returns 404 (no blocks for that spec).
   */
  fetchSpec(remote: RemotePeer, specHash: SpecHash): Promise<readonly BlockMerkleRoot[]>;

  /**
   * Fetch the registry schema version from the remote peer.
   * Maps to GET /schema-version (via schemaVersionUrl() builder in transport.ts).
   *
   * mirrorRegistry calls this first, before inserting anything. A schema version
   * greater than the local SCHEMA_VERSION causes a SchemaVersionMismatchError abort.
   *
   * DEC-TRANSPORT-SCHEMA-VERSION-020.
   */
  getSchemaVersion(remote: RemotePeer): Promise<{ readonly schemaVersion: number }>;

  /**
   * List all distinct spec hashes served by the remote peer.
   * Maps to GET /v1/specs.
   * Returns an empty array when the remote serves no specs.
   *
   * DEC-TRANSPORT-LIST-METHODS-020.
   */
  listSpecs(remote: RemotePeer): Promise<readonly SpecHash[]>;

  /**
   * List all block merkle roots the remote serves for a given spec hash.
   * Maps to GET /v1/spec/<specHash> (same endpoint as fetchSpec).
   * Returns [] when the remote has no blocks for that spec.
   *
   * DEC-TRANSPORT-LIST-METHODS-020.
   */
  listBlocks(remote: RemotePeer, specHash: SpecHash): Promise<readonly BlockMerkleRoot[]>;
}

// ---------------------------------------------------------------------------
// Wire block triplet (JSON projection of BlockTripletRow with base64 bytes)
// ---------------------------------------------------------------------------

/**
 * The v1 wire shape for a block triplet.
 * A direct JSON projection of BlockTripletRow with binary fields base64-encoded.
 * FEDERATION_PROTOCOL.md §4.
 *
 * @decision DEC-V1-FEDERATION-WIRE-ARTIFACTS-002: artifactBytes is REQUIRED.
 * The wire integrity check calls @yakcc/contracts blockMerkleRoot() directly,
 * which folds artifact bytes into the proof root. The receiver decodes
 * artifactBytes, reconstructs Map<string, Uint8Array> in manifest declaration
 * order, and passes it to blockMerkleRoot(). Any wire that omits artifactBytes
 * will produce a different hash than the persisted BlockMerkleRoot and fail
 * the integrity gate.
 * Status: decided (MASTER_PLAN.md DEC-V1-FEDERATION-WIRE-ARTIFACTS-002)
 *
 * No ownership fields — DEC-NO-OWNERSHIP-011. The wire shape is derived from
 * BlockTripletRow which itself has no ownership columns by schema design.
 * Keys in artifactBytes are manifest-declared paths; they carry no author data.
 */
export interface WireBlockTriplet {
  readonly blockMerkleRoot: string; // hex(BlockMerkleRoot)
  readonly specHash: string; // hex(SpecHash)
  readonly specCanonicalBytes: string; // base64(Uint8Array)
  readonly implSource: string; // UTF-8 source text
  readonly proofManifestJson: string; // JSON text (already a string in the row)
  /**
   * Artifact bytes in manifest declaration order.
   * Keys are the artifact paths declared in proofManifestJson.artifacts[*].path.
   * Values are base64-encoded artifact bytes (one entry per declared artifact).
   *
   * Required for integrity: the receiver must reconstruct artifacts as
   * Map<string, Uint8Array> and pass to blockMerkleRoot() to verify the root.
   * DEC-V1-FEDERATION-WIRE-ARTIFACTS-002.
   */
  readonly artifactBytes: Record<string, string>; // { [path]: base64(bytes) }
  readonly level: "L0" | "L1" | "L2" | "L3";
  readonly createdAt: number; // epoch ms (peer-local; informational)
  readonly canonicalAstHash: string; // hex(CanonicalAstHash)
  readonly parentBlockRoot: string | null; // hex(BlockMerkleRoot) | null
}

// ---------------------------------------------------------------------------
// Error classes
// ---------------------------------------------------------------------------

/**
 * Thrown when a received WireBlockTriplet fails an integrity check.
 * Covers: blockMerkleRoot recomputation mismatch, specHash mismatch,
 * level=L1/L2/L3 rejection, proofManifestJson validation failure.
 *
 * FEDERATION_PROTOCOL.md §8 "Within the same BlockMerkleRoot".
 */
export class IntegrityError extends Error {
  readonly reason: MirrorRejectionReason;

  constructor(opts: { reason: MirrorRejectionReason; message?: string }) {
    super(opts.message ?? `Integrity check failed: ${opts.reason}`);
    this.name = "IntegrityError";
    this.reason = opts.reason;
  }
}

/**
 * Thrown when the remote peer's protocolVersion or schemaVersion is
 * incompatible with the local registry's expected versions.
 *
 * FEDERATION_PROTOCOL.md §3 "GET /v1/manifest" — schemaVersion mismatch is
 * a hard error; the client refuses to mirror.
 */
export class VersionMismatchError extends Error {
  constructor(message?: string) {
    super(message ?? "Protocol or schema version mismatch with remote peer");
    this.name = "VersionMismatchError";
  }
}

/**
 * Thrown when the remote peer's schemaVersion is greater than the local
 * registry's SCHEMA_VERSION. mirrorRegistry aborts before inserting anything.
 *
 * Distinct from VersionMismatchError to allow callers to differentiate a
 * schema-forward incompatibility (remote is newer) from a protocol mismatch.
 *
 * DEC-TRANSPORT-SCHEMA-VERSION-020, WI-020 Dispatch D.
 */
export class SchemaVersionMismatchError extends Error {
  /** The schema version reported by the remote peer. */
  readonly remoteSchemaVersion: number;
  /** The local SCHEMA_VERSION that the client supports. */
  readonly localSchemaVersion: number;

  constructor(opts: { remoteSchemaVersion: number; localSchemaVersion: number; message?: string }) {
    super(
      opts.message ??
        `Remote schema version ${opts.remoteSchemaVersion} exceeds local SCHEMA_VERSION ${opts.localSchemaVersion}; mirror aborted`,
    );
    this.name = "SchemaVersionMismatchError";
    this.remoteSchemaVersion = opts.remoteSchemaVersion;
    this.localSchemaVersion = opts.localSchemaVersion;
  }
}

/**
 * Thrown when an HTTP (or other transport) operation fails.
 * Carries the wire error code from the §3 error envelope when available.
 *
 * FEDERATION_PROTOCOL.md §3 "Errors".
 */
export class TransportError extends Error {
  /** Wire error code from { "error": "<code>", "message": "..." } envelope, or "internal_error". */
  readonly code: string;

  constructor(opts: { code: string; message?: string }) {
    super(opts.message ?? `Transport error: ${opts.code}`);
    this.name = "TransportError";
    this.code = opts.code;
  }
}
