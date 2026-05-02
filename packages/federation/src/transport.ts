// SPDX-License-Identifier: MIT
// @decision DEC-HTTP-TRANSPORT-URL-020: Pure URL builders for federation endpoints.
// Status: decided (WI-020 Dispatch C, FEDERATION_PROTOCOL.md §3)
// Title: Transport URL builders — no fetch dependency, pure string construction
// Rationale:
//   Isolating URL construction into pure functions makes them independently testable
//   and keeps http-transport.ts focused on network I/O. The builders accept a
//   RemotePeer (opaque mirror URL string) and produce the canonical endpoint URLs
//   defined in FEDERATION_PROTOCOL.md §3. Trailing slashes on the peer URL are
//   handled by normalizing once at construction time.
//
// @decision DEC-V1-FEDERATION-PROTOCOL-001: HTTP+JSON over HTTPS; peers identified by mirror URL.
// Status: decided (MASTER_PLAN.md DEC-V1-FEDERATION-PROTOCOL-001)
//
// @decision DEC-NO-OWNERSHIP-011: No ownership fields on the wire.
// Status: decided (MASTER_PLAN.md DEC-NO-OWNERSHIP-011)
// Rationale: URL builders carry only content-addressed identifiers (BlockMerkleRoot,
// SpecHash) and pagination parameters. No person-shaped identifiers appear anywhere.

import type { BlockMerkleRoot, SpecHash } from "@yakcc/contracts";
import type { RemotePeer } from "./types.js";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Normalize a peer URL by stripping any trailing slash.
 * All endpoint paths start with "/v1/..." so the join is always unambiguous.
 */
function normalizeBase(remote: RemotePeer): string {
  return remote.endsWith("/") ? remote.slice(0, -1) : remote;
}

// ---------------------------------------------------------------------------
// URL builders
// ---------------------------------------------------------------------------

/**
 * Build the URL for GET /v1/manifest.
 *
 * Entry point for mirror-client compatibility negotiation.
 * FEDERATION_PROTOCOL.md §3 "GET /v1/manifest".
 */
export function manifestUrl(remote: RemotePeer): string {
  return `${normalizeBase(remote)}/v1/manifest`;
}

/**
 * Build the URL for GET /v1/blocks with pagination query params.
 *
 * @param remote  - The remote peer mirror URL.
 * @param limit   - Maximum number of roots per page.
 * @param after   - Cursor from the previous page's nextCursor, or null for the first page.
 *
 * FEDERATION_PROTOCOL.md §3 "GET /v1/blocks".
 */
export function blocksUrl(
  remote: RemotePeer,
  limit: number,
  after: BlockMerkleRoot | null,
): string {
  const base = `${normalizeBase(remote)}/v1/blocks?limit=${encodeURIComponent(limit)}`;
  if (after !== null) {
    return `${base}&after=${encodeURIComponent(after)}`;
  }
  return base;
}

/**
 * Build the URL for GET /v1/block/<root>.
 *
 * Returns the full triplet row keyed by BlockMerkleRoot.
 * FEDERATION_PROTOCOL.md §3 "GET /v1/block/<merkleRoot>".
 */
export function blockUrl(remote: RemotePeer, root: BlockMerkleRoot): string {
  return `${normalizeBase(remote)}/v1/block/${encodeURIComponent(root)}`;
}

/**
 * Build the URL for GET /v1/spec/<specHash>.
 *
 * Returns the list of BlockMerkleRoots the peer serves for a given SpecHash.
 * FEDERATION_PROTOCOL.md §3 "GET /v1/spec/<specHash>".
 */
export function specUrl(remote: RemotePeer, specHash: SpecHash): string {
  return `${normalizeBase(remote)}/v1/spec/${encodeURIComponent(specHash)}`;
}

/**
 * Build the URL for GET /schema-version.
 *
 * Returns `{ schemaVersion: number }` from the remote peer.
 * mirrorRegistry calls this first, before inserting anything, to abort early
 * if the remote schema version is incompatible (DEC-TRANSPORT-SCHEMA-VERSION-020).
 *
 * Note: No /v1/ prefix — this is a top-level negotiation endpoint, independent
 * of the v1 protocol version. It must be reachable even if the protocol version
 * is unknown or mismatched.
 */
export function schemaVersionUrl(remote: RemotePeer): string {
  return `${normalizeBase(remote)}/schema-version`;
}

/**
 * Build the URL for GET /v1/specs.
 *
 * Returns the list of all SpecHashes served by the remote peer.
 * DEC-TRANSPORT-LIST-METHODS-020.
 */
export function specsUrl(remote: RemotePeer): string {
  return `${normalizeBase(remote)}/v1/specs`;
}
