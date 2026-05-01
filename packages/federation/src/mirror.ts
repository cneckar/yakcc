// @decision DEC-MIRROR-REPORT-020: mirrorRegistry orchestrates the Slice D mirror walk.
// Status: decided (WI-020 Dispatch D, MASTER_PLAN.md)
// Title: mirror.ts — spec-hierarchy mirror with idempotency and partial-failure resilience
// Rationale:
//   The v2 mirror walks by spec→block hierarchy (listSpecs → listBlocks) rather than
//   a flat catalog page walk. This maps cleanly onto the registry's selectBlocks(specHash)
//   authority and enables per-spec idempotency checks via registry.getBlock(merkleRoot).
//
//   Schema-version gate: getSchemaVersion() is called FIRST, before any insert. If the
//   remote schema version exceeds the local SCHEMA_VERSION, mirrorRegistry throws
//   SchemaVersionMismatchError immediately — no rows are touched (DEC-TRANSPORT-SCHEMA-VERSION-020).
//
//   Integrity gate: every block goes through pullBlock → deserializeWireBlockTriplet.
//   No inline merkle helper; @yakcc/contracts is the single authority for block identity
//   (DEC-V1-FEDERATION-WIRE-ARTIFACTS-002, DEC-CONTRACTS-AUTHORITY-001).
//
//   Partial failure resilience: a failure on any single block is captured in
//   MirrorReport.failures and the walk continues. The operation is never aborted
//   mid-run except for the schema-version hard abort (FEDERATION_PROTOCOL.md §10).
//
// @decision DEC-V1-FEDERATION-WIRE-ARTIFACTS-002: NO new merkle helper inside federation.
// Status: decided (MASTER_PLAN.md)
// Rationale: Integrity is handled entirely by pullBlock → deserializeWireBlockTriplet →
// @yakcc/contracts.blockMerkleRoot. No direct @noble/hashes import; no blockMerkleRootFromRow.
//
// @decision DEC-NO-OWNERSHIP-011: No ownership fields anywhere.
// Status: decided (MASTER_PLAN.md DEC-NO-OWNERSHIP-011)
//
// @decision DEC-V1-WAVE-1-SCOPE-001: F1 read-only mirror only.
// Status: decided (MASTER_PLAN.md DEC-V1-WAVE-1-SCOPE-001)

import type { SpecHash } from "@yakcc/contracts";
import type { Registry } from "@yakcc/registry";
import { SCHEMA_VERSION } from "@yakcc/registry";
import { pullBlock } from "./pull.js";
import type { MirrorReport, RemotePeer, Transport } from "./types.js";
import { SchemaVersionMismatchError } from "./types.js";

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/**
 * Options for mirrorRegistry.
 */
export interface MirrorOptions {
  /**
   * Optional clock override for deterministic tests.
   * Default: () => new Date()
   *
   * Injecting this makes timestamp assertions in tests deterministic without
   * mocking global Date.
   */
  readonly clock?: () => Date;
}

// ---------------------------------------------------------------------------
// mirrorRegistry
// ---------------------------------------------------------------------------

/**
 * Mirror all blocks from a remote peer's registry into the local registry.
 *
 * Production sequence (DEC-MIRROR-REPORT-020):
 *   1. Capture startedAt = clock().toISOString().
 *   2. getSchemaVersion(serveUrl): if remote > local SCHEMA_VERSION → throw
 *      SchemaVersionMismatchError IMMEDIATELY. No rows touched.
 *   3. listSpecs(serveUrl): for each spec hash,
 *      listBlocks(serveUrl, specHash): for each block merkle root,
 *        - increment blocksConsidered.
 *        - idempotency check: if registry.getBlock(root) returns non-null → skip, increment blocksSkipped.
 *        - pullBlock(serveUrl, root, { transport }): integrity gate via deserializeWireBlockTriplet.
 *        - registry.storeBlock(row): persist.
 *        - increment blocksInserted.
 *        - on any error: push failure entry, continue.
 *      - increment specsWalked after each spec (success or partial failure).
 *   4. Capture finishedAt = clock().toISOString().
 *   5. Return MirrorReport.
 *
 * Authority invariants:
 *   - Integrity: pullBlock → deserializeWireBlockTriplet → @yakcc/contracts blockMerkleRoot().
 *     No new merkle helper in this file (DEC-V1-FEDERATION-WIRE-ARTIFACTS-002).
 *   - No ownership fields (DEC-NO-OWNERSHIP-011).
 *   - No F2 publishing (DEC-V1-WAVE-1-SCOPE-001).
 *
 * @param serveUrl  - The remote peer's mirror URL (RemotePeer).
 * @param registry  - The local registry to mirror blocks into.
 * @param transport - The Transport implementation for all remote calls.
 * @param options   - Optional: clock override for deterministic timestamps in tests.
 * @returns         A MirrorReport describing the completed mirror operation.
 * @throws SchemaVersionMismatchError if the remote schema version exceeds SCHEMA_VERSION.
 */
export async function mirrorRegistry(
  serveUrl: RemotePeer,
  registry: Registry,
  transport: Transport,
  options?: MirrorOptions,
): Promise<MirrorReport> {
  const clock = options?.clock ?? (() => new Date());

  // Step 1: capture start time.
  const startedAt = clock().toISOString();

  // Step 2: schema-version gate — MUST run before any insert.
  // Per DEC-TRANSPORT-SCHEMA-VERSION-020: if remote schemaVersion > local SCHEMA_VERSION,
  // throw immediately. No rows are written before this check.
  const { schemaVersion: remoteSchemaVersion } = await transport.getSchemaVersion(serveUrl);
  if (remoteSchemaVersion > SCHEMA_VERSION) {
    throw new SchemaVersionMismatchError({
      remoteSchemaVersion,
      localSchemaVersion: SCHEMA_VERSION,
    });
  }

  // Step 3: walk specs → blocks.
  let specsWalked = 0;
  let blocksConsidered = 0;
  let blocksInserted = 0;
  let blocksSkipped = 0;
  const failures: Array<{
    readonly specHash: string;
    readonly blockMerkleRoot: string | null;
    readonly reason: string;
    readonly at: string;
  }> = [];

  const specHashes = await transport.listSpecs(serveUrl);

  for (const specHash of specHashes as SpecHash[]) {
    const blockRoots = await transport.listBlocks(serveUrl, specHash);

    for (const blockRoot of blockRoots) {
      blocksConsidered++;

      try {
        // Idempotency check: if the row already exists, skip it.
        // registry.getBlock() returns null when the block is not present.
        const existing = await registry.getBlock(blockRoot);
        if (existing !== null) {
          blocksSkipped++;
          continue;
        }

        // Pull and integrity-check via pullBlock → deserializeWireBlockTriplet.
        // This is the authority path — no inline merkle computation here.
        // DEC-V1-FEDERATION-WIRE-ARTIFACTS-002, DEC-CONTRACTS-AUTHORITY-001.
        const row = await pullBlock(serveUrl, blockRoot, { transport });

        // Insert into the local registry.
        await registry.storeBlock(row);
        blocksInserted++;
      } catch (err: unknown) {
        // Per FEDERATION_PROTOCOL.md §10: individual block failures are loud,
        // partial, and recoverable. Capture and continue — do not abort the walk.
        const reason =
          err instanceof Error ? err.message : typeof err === "string" ? err : "unknown error";

        failures.push({
          specHash,
          blockMerkleRoot: blockRoot,
          reason,
          at: clock().toISOString(),
        });
      }
    }

    // specsWalked increments after each spec finishes (success or partial failure).
    specsWalked++;
  }

  // Step 4: capture finish time.
  const finishedAt = clock().toISOString();

  // Step 5: return the report.
  return {
    serveUrl,
    schemaVersion: remoteSchemaVersion,
    startedAt,
    finishedAt,
    specsWalked,
    blocksConsidered,
    blocksInserted,
    blocksSkipped,
    failures,
  };
}
