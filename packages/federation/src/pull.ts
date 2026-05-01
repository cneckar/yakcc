// @decision DEC-PULL-020: pullBlock and pullSpec primitives for federation F1 mirror.
// Status: decided (WI-020 Dispatch C, MASTER_PLAN.md)
// Title: pull.ts — transport-agnostic block/spec fetch with mandatory integrity gate
// Rationale:
//   pullBlock is the primary consumer-facing entry point for fetching a single block.
//   It MUST route every fetched WireBlockTriplet through deserializeWireBlockTriplet,
//   which performs the full integrity gate (shape validation, L0-only, specHash
//   recomputation, blockMerkleRoot recomputation via @yakcc/contracts with the
//   reconstructed artifacts Map). Callers never receive an unverified row. This is
//   an authority invariant per DEC-V1-FEDERATION-WIRE-ARTIFACTS-002: the artifact
//   bytes fold into the proof root, so the integrity gate also covers artifact tampering.
//
//   pullSpec wraps transport.fetchSpec and translates the TransportError(code='not_found')
//   sentinel into an empty array per FEDERATION_PROTOCOL.md §3. Other TransportErrors
//   propagate unchanged so callers can distinguish network failures from
//   "no blocks for this spec".
//
//   Default transport: createHttpTransport() is lazily imported from ./http-transport.js
//   only when opts.transport is not supplied. This avoids initialising the HTTP transport
//   module (which captures globalThis.fetch at construction time) on every module load
//   in test environments.
//
// @decision DEC-V1-FEDERATION-WIRE-ARTIFACTS-002: artifactBytes is REQUIRED on the wire.
// The integrity gate in deserializeWireBlockTriplet calls @yakcc/contracts blockMerkleRoot()
// directly with the reconstructed artifacts Map. Any single-byte mutation in an artifact
// causes a root mismatch and throws IntegrityError. pullBlock routes through this gate
// unconditionally.
// Status: decided (MASTER_PLAN.md DEC-V1-FEDERATION-WIRE-ARTIFACTS-002)
//
// @decision DEC-NO-OWNERSHIP-011: No ownership fields.
// Status: decided (MASTER_PLAN.md DEC-NO-OWNERSHIP-011)
//
// @decision DEC-V1-WAVE-1-SCOPE-001: F1 read-only mirror only.
// Status: decided (MASTER_PLAN.md DEC-V1-WAVE-1-SCOPE-001)

import type { BlockMerkleRoot, SpecHash } from "@yakcc/contracts";
import type { BlockTripletRow } from "@yakcc/registry";
import { TransportError } from "./types.js";
import type { RemotePeer, Transport } from "./types.js";
import { deserializeWireBlockTriplet } from "./wire.js";

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/**
 * Options shared by pullBlock and pullSpec.
 *
 * Providing opts.transport bypasses the lazy-loaded default HTTP transport.
 * Use this in tests to inject a stub Transport without touching the network.
 *
 * Per DEC-PULL-020: the default transport is createHttpTransport() resolved
 * lazily to prevent module-load-time fetch initialisation in test envs.
 */
export interface PullOptions {
  /** Transport implementation. Defaults to createHttpTransport(). */
  transport?: Transport;
}

// ---------------------------------------------------------------------------
// Lazy default transport
// ---------------------------------------------------------------------------

/**
 * Resolve the transport from opts or fall back to the lazily-imported default.
 *
 * The dynamic import of ./http-transport.js is intentional: it defers the
 * capture of globalThis.fetch to the first actual pull call, not module load.
 * This is important in test environments where global fetch may not be set up
 * at import time.
 */
async function resolveTransport(opts?: PullOptions): Promise<Transport> {
  if (opts?.transport !== undefined) {
    return opts.transport;
  }
  // Dynamic import so the HTTP transport module (and its globalThis.fetch
  // capture) is only loaded when actually needed.
  const { createHttpTransport } = await import("./http-transport.js");
  return createHttpTransport();
}

// ---------------------------------------------------------------------------
// pullBlock
// ---------------------------------------------------------------------------

/**
 * Fetch and verify a single block triplet from a remote peer.
 *
 * Production sequence:
 *   1. Resolve transport (injected or default HTTP).
 *   2. Call transport.fetchBlock(remote, root) → WireBlockTriplet.
 *   3. Call deserializeWireBlockTriplet(wire) — performs ALL integrity checks,
 *      including artifact bytes reconstruction and blockMerkleRoot recomputation
 *      via @yakcc/contracts with the full artifacts Map.
 *   4. Return the fully-validated BlockTripletRow (with artifacts Map populated).
 *
 * Authority invariant (DEC-PULL-020, DEC-V1-FEDERATION-WIRE-ARTIFACTS-002):
 * every WireBlockTriplet received from the network MUST pass through
 * deserializeWireBlockTriplet before being returned. There is no shortcut path
 * that trusts the wire value without verification. Artifact tampering is caught
 * because blockMerkleRoot() folds artifact bytes into the proof root.
 *
 * @param remote - The mirror URL of the remote peer.
 * @param root   - The BlockMerkleRoot to fetch.
 * @param opts   - Optional: inject a Transport for test isolation.
 * @returns A fully integrity-checked BlockTripletRow with artifacts Map populated.
 * @throws IntegrityError if any integrity check fails (including artifact tampering).
 * @throws TransportError if the transport layer fails.
 */
export async function pullBlock(
  remote: RemotePeer,
  root: BlockMerkleRoot,
  opts?: PullOptions,
): Promise<BlockTripletRow> {
  const transport = await resolveTransport(opts);
  const wire = await transport.fetchBlock(remote, root);
  // Authority invariant: deserializeWireBlockTriplet is the integrity gate.
  // This call is mandatory. No inline trust-and-return shortcut.
  // The returned row has artifacts Map populated (DEC-V1-FEDERATION-WIRE-ARTIFACTS-002).
  return deserializeWireBlockTriplet(wire);
}

// ---------------------------------------------------------------------------
// pullSpec
// ---------------------------------------------------------------------------

/**
 * Fetch all BlockMerkleRoots a remote peer serves for a given SpecHash.
 *
 * Per FEDERATION_PROTOCOL.md §3: a 404 from the remote is a normal response
 * meaning the peer has no blocks for this spec. This translates to `[]`.
 * All other TransportErrors propagate unchanged.
 *
 * @param remote   - The mirror URL of the remote peer.
 * @param specHash - The SpecHash to look up.
 * @param opts     - Optional: inject a Transport for test isolation.
 * @returns An array of BlockMerkleRoots (empty if the remote has none for this spec).
 * @throws TransportError for any transport failure other than not_found.
 */
export async function pullSpec(
  remote: RemotePeer,
  specHash: SpecHash,
  opts?: PullOptions,
): Promise<readonly BlockMerkleRoot[]> {
  const transport = await resolveTransport(opts);
  try {
    return await transport.fetchSpec(remote, specHash);
  } catch (err) {
    // TransportError with code='not_found' → normal 404 → return empty array.
    // Per FEDERATION_PROTOCOL.md §3 and the dispatch contract §"What to build".
    if (err instanceof TransportError && err.code === "not_found") {
      return [];
    }
    // All other errors (network failure, server error, etc.) propagate.
    throw err;
  }
}
