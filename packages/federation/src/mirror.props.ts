// SPDX-License-Identifier: MIT
// @decision DEC-V2-PROPTEST-PATH-A-003: hand-authored property-test corpus for
// @yakcc/federation mirror.ts atoms. Two-file pattern: this file (.props.ts) is
// vitest-free and holds the corpus; the sibling .props.test.ts is the vitest harness.
// Status: accepted (WI-87-fill-federation)
// Rationale: Same two-file pattern as pull.props.ts — corpus is runtime-independent
// so it can be hashed as a manifest artifact by future tooling.

// ---------------------------------------------------------------------------
// Property-test corpus for federation/src/mirror.ts atoms
//
// Atom covered (1 exported function):
//   mirrorRegistry (A4.1) — orchestrates the spec→block mirror walk
//
// Properties exercised (7):
//   1. Schema-version gate: remote > local → SchemaVersionMismatchError, no rows inserted
//   2. Schema-version gate: remote == local → proceeds without error
//   3. Idempotency: already-present blocks are skipped (blocksSkipped increments)
//   4. Empty remote (no specs) → report with zero counts
//   5. Partial failure resilience: single block error → failure captured, walk continues
//   6. Report fields are well-formed (startedAt ≤ finishedAt, correct serveUrl, etc.)
//   7. Compound-interaction: full walk through inject transport + stub registry inserts
//
// All properties inject stub Transport and Registry to stay pure and IO-free.
// The schema-version gate is DEC-TRANSPORT-SCHEMA-VERSION-020.
// Partial failure resilience is FEDERATION_PROTOCOL.md §10.
// ---------------------------------------------------------------------------

import { blockMerkleRoot, canonicalize, specHash, validateProofManifestL0 } from "@yakcc/contracts";
import type {
  BlockMerkleRoot,
  CanonicalAstHash,
  LocalTriplet,
  SpecHash,
  SpecYak,
} from "@yakcc/contracts";
import type { BlockTripletRow, Registry } from "@yakcc/registry";
import { SCHEMA_VERSION } from "@yakcc/registry";
import * as fc from "fast-check";
import { mirrorRegistry } from "./mirror.js";
import { serializeWireBlockTriplet } from "./wire.js";
import type { MirrorReport, RemotePeer, Transport, WireBlockTriplet } from "./types.js";
import { SchemaVersionMismatchError, TransportError } from "./types.js";

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const TEST_SPEC: SpecYak = {
  name: "mirrorProp",
  inputs: [{ name: "x", type: "boolean" }],
  outputs: [{ name: "r", type: "string" }],
  preconditions: [],
  postconditions: [],
  invariants: [],
  effects: [],
  level: "L0",
};

const TEST_IMPL_SOURCE = "export function mirrorProp(x: boolean): string { return String(x); }";

const VALID_MANIFEST = validateProofManifestL0(
  JSON.parse('{"artifacts":[{"kind":"property_tests","path":"mirrorProp.fc.ts"}]}'),
);

const TEXT_ENCODER = new TextEncoder();

const TEST_ARTIFACT_BYTES = TEXT_ENCODER.encode(
  "import fc from 'fast-check';\nfc.assert(fc.property(fc.boolean(), (b) => typeof mirrorProp(b) === 'string'));",
);

const TEST_ARTIFACTS = new Map<string, Uint8Array>([["mirrorProp.fc.ts", TEST_ARTIFACT_BYTES]]);

/**
 * Build an internally-consistent BlockTripletRow using @yakcc/contracts as the
 * single authority for hash computation (DEC-CONTRACTS-AUTHORITY-001).
 */
function makeRow(tag: string = ""): BlockTripletRow {
  const implSource = tag
    ? `export function mirrorProp_${tag}(x: boolean): string { return String(x); }`
    : TEST_IMPL_SOURCE;

  const specCanonicalBytes = canonicalize(TEST_SPEC as unknown as Parameters<typeof canonicalize>[0]);
  const merkleRoot = blockMerkleRoot({
    spec: TEST_SPEC,
    implSource,
    manifest: VALID_MANIFEST,
    artifacts: TEST_ARTIFACTS,
  });
  const specHashHex = specHash(TEST_SPEC) as SpecHash;

  return {
    blockMerkleRoot: merkleRoot,
    specHash: specHashHex,
    specCanonicalBytes,
    implSource,
    proofManifestJson: JSON.stringify(VALID_MANIFEST),
    level: "L0",
    createdAt: 1_714_000_000_000,
    canonicalAstHash: "d".repeat(64) as CanonicalAstHash,
    parentBlockRoot: null,
    artifacts: TEST_ARTIFACTS,
  };
}

/**
 * Build a stub Transport that serves a fixed set of specs+blocks from
 * pre-serialized WireBlockTriplet values.
 *
 * The transport produces valid WireBlockTriplets (serialized from a real row)
 * so that pullBlock → deserializeWireBlockTriplet succeeds.
 */
function makeTransport(opts: {
  schemaVersion?: number;
  specHashes?: SpecHash[];
  blocksBySpec?: Map<SpecHash, BlockMerkleRoot[]>;
  wireByRoot?: Map<BlockMerkleRoot, WireBlockTriplet>;
  failOnRoot?: BlockMerkleRoot;
}): Transport {
  const schemaVersion = opts.schemaVersion ?? SCHEMA_VERSION;
  const specHashes = opts.specHashes ?? [];
  const blocksBySpec = opts.blocksBySpec ?? new Map();
  const wireByRoot = opts.wireByRoot ?? new Map();
  const failOnRoot = opts.failOnRoot ?? null;

  return {
    getSchemaVersion: (_remote) => Promise.resolve({ schemaVersion }),
    listSpecs: (_remote) => Promise.resolve(specHashes),
    listBlocks: (_remote, sh) => Promise.resolve(blocksBySpec.get(sh) ?? []),
    fetchBlock: (_remote, root) => {
      if (failOnRoot !== null && root === failOnRoot) {
        return Promise.reject(new TransportError({ code: "network_error", message: "stub fail" }));
      }
      const wire = wireByRoot.get(root);
      if (wire === undefined) {
        return Promise.reject(new TransportError({ code: "not_found" }));
      }
      return Promise.resolve(wire);
    },
    fetchSpec: (_remote, _sh) => Promise.resolve([]),
    fetchManifest: (_remote) =>
      Promise.reject(new TransportError({ code: "not_implemented" })),
    fetchCatalogPage: (_remote, _after, _limit) =>
      Promise.reject(new TransportError({ code: "not_implemented" })),
  };
}

/**
 * Build a stub Registry that tracks stored blocks in memory.
 * getBlock returns null for unknown roots (simulates empty local DB).
 * getBlock returns a row for pre-seeded "existing" roots (simulates idempotency check).
 */
function makeRegistry(existingRoots: Set<BlockMerkleRoot> = new Set()): Registry & {
  stored: BlockTripletRow[];
} {
  const stored: BlockTripletRow[] = [];
  return {
    stored,
    getBlock: (root: BlockMerkleRoot) =>
      Promise.resolve(existingRoots.has(root) ? makeRow(`existing_${root.slice(0, 8)}`) : null),
    storeBlock: (row: BlockTripletRow) => {
      stored.push(row);
      return Promise.resolve();
    },
    // Remaining Registry methods not exercised by mirrorRegistry:
    selectBlocks: (_sh: SpecHash) => Promise.resolve([]),
    getSpec: (_sh: SpecHash) => Promise.resolve(null),
    listSpecs: () => Promise.resolve([]),
    getAllBlocks: () => Promise.resolve([]),
  } as unknown as Registry & { stored: BlockTripletRow[] };
}

// Arbitrary for a RemotePeer URL string.
const remotePeerArb: fc.Arbitrary<RemotePeer> = fc.constantFrom(
  "http://127.0.0.1:9001",
  "http://peer-b.example.com",
);

// ---------------------------------------------------------------------------
// A4.1: mirrorRegistry — properties
// ---------------------------------------------------------------------------

/**
 * prop_schema_version_gate_rejects_newer_remote
 *
 * When remote schemaVersion > local SCHEMA_VERSION, mirrorRegistry throws
 * SchemaVersionMismatchError before inserting any rows.
 *
 * Invariant (DEC-TRANSPORT-SCHEMA-VERSION-020): the schema-version check is the
 * FIRST operation; no registry writes occur before it.
 */
export const prop_schema_version_gate_rejects_newer_remote = fc.asyncProperty(
  remotePeerArb,
  fc.integer({ min: 1, max: 9 }),
  async (remote, excess) => {
    const remoteVersion = SCHEMA_VERSION + excess;
    const transport = makeTransport({ schemaVersion: remoteVersion });
    const registry = makeRegistry();

    try {
      await mirrorRegistry(remote, registry as unknown as import("@yakcc/registry").Registry, transport);
      return false; // must have thrown
    } catch (err) {
      if (!(err instanceof SchemaVersionMismatchError)) return false;
      // No rows must have been written.
      return registry.stored.length === 0;
    }
  },
);

/**
 * prop_schema_version_gate_accepts_equal_version
 *
 * When remote schemaVersion === local SCHEMA_VERSION, mirrorRegistry does NOT throw
 * SchemaVersionMismatchError. With an empty remote (no specs), it returns a valid
 * MirrorReport with zero counts.
 *
 * Invariant: equal version is acceptable — the gate only blocks strictly greater.
 */
export const prop_schema_version_gate_accepts_equal_version = fc.asyncProperty(
  remotePeerArb,
  async (remote) => {
    const transport = makeTransport({ schemaVersion: SCHEMA_VERSION });
    const registry = makeRegistry();

    const report = await mirrorRegistry(
      remote,
      registry as unknown as import("@yakcc/registry").Registry,
      transport,
    );

    return (
      report.specsWalked === 0 &&
      report.blocksConsidered === 0 &&
      report.blocksInserted === 0 &&
      report.failures.length === 0
    );
  },
);

/**
 * prop_idempotency_skips_existing_blocks
 *
 * When a block root is already present in the local registry, mirrorRegistry
 * increments blocksSkipped and does NOT call storeBlock for that root.
 *
 * Invariant: mirrorRegistry performs a getBlock() check before every storeBlock().
 * Duplicate pulls must be safe to run multiple times.
 */
export const prop_idempotency_skips_existing_blocks = fc.asyncProperty(
  remotePeerArb,
  async (remote) => {
    const row = makeRow("idempotent");
    const root = row.blockMerkleRoot;
    const sh = row.specHash;
    const wire = serializeWireBlockTriplet(row);

    const transport = makeTransport({
      specHashes: [sh],
      blocksBySpec: new Map([[sh, [root]]]),
      wireByRoot: new Map([[root, wire]]),
    });

    // Pre-seed the registry so the block looks "already present".
    const existingRoots = new Set<BlockMerkleRoot>([root]);
    const registry = makeRegistry(existingRoots);

    const report = await mirrorRegistry(
      remote,
      registry as unknown as import("@yakcc/registry").Registry,
      transport,
    );

    // blocksSkipped == 1, inserted == 0, nothing stored.
    return (
      report.blocksConsidered === 1 &&
      report.blocksSkipped === 1 &&
      report.blocksInserted === 0 &&
      registry.stored.length === 0
    );
  },
);

/**
 * prop_partial_failure_resilience
 *
 * When the transport throws TransportError for one block but succeeds for another,
 * mirrorRegistry captures the failure in report.failures and continues inserting
 * the successful block — the walk is not aborted.
 *
 * Invariant (FEDERATION_PROTOCOL.md §10): partial failure resilience — individual
 * block failures are loud (captured) but recoverable (walk continues).
 */
export const prop_partial_failure_resilience = fc.asyncProperty(
  remotePeerArb,
  async (remote) => {
    const goodRow = makeRow("good");
    const failRow = makeRow("fail");

    const goodRoot = goodRow.blockMerkleRoot;
    const failRoot = failRow.blockMerkleRoot;
    const sh = goodRow.specHash; // use goodRow's specHash for both (same spec)
    const goodWire = serializeWireBlockTriplet(goodRow);

    // Both roots belong to the same spec in the transport.
    const transport = makeTransport({
      specHashes: [sh],
      blocksBySpec: new Map([[sh, [goodRoot, failRoot]]]),
      wireByRoot: new Map([[goodRoot, goodWire]]),
      failOnRoot: failRoot,
    });

    const registry = makeRegistry();

    const report = await mirrorRegistry(
      remote,
      registry as unknown as import("@yakcc/registry").Registry,
      transport,
    );

    return (
      report.blocksConsidered === 2 &&
      report.blocksInserted === 1 &&
      report.failures.length === 1 &&
      registry.stored.length === 1
    );
  },
);

/**
 * prop_report_fields_well_formed
 *
 * The MirrorReport returned by a successful (empty remote) mirror run must have:
 *   - serveUrl === the remote peer passed in
 *   - schemaVersion === local SCHEMA_VERSION
 *   - startedAt and finishedAt are ISO-8601 strings
 *   - finishedAt >= startedAt (time flows forward)
 *
 * Invariant: the report is a faithful record of what happened.
 */
export const prop_report_fields_well_formed = fc.asyncProperty(
  remotePeerArb,
  async (remote) => {
    const clock = (() => {
      let t = 1_700_000_000_000;
      return () => {
        const d = new Date(t);
        t += 10;
        return d;
      };
    })();

    const transport = makeTransport({ schemaVersion: SCHEMA_VERSION });
    const registry = makeRegistry();

    const report: MirrorReport = await mirrorRegistry(
      remote,
      registry as unknown as import("@yakcc/registry").Registry,
      transport,
      { clock },
    );

    if (report.serveUrl !== remote) return false;
    if (report.schemaVersion !== SCHEMA_VERSION) return false;
    if (typeof report.startedAt !== "string") return false;
    if (typeof report.finishedAt !== "string") return false;
    // finishedAt >= startedAt — clock is monotonic in our stub.
    return report.finishedAt >= report.startedAt;
  },
);

/**
 * prop_full_walk_compound_interaction
 *
 * Compound-interaction test: a full mirror walk through transport → registry.
 * Remote has 1 spec with 1 block. mirrorRegistry should:
 *   - call getSchemaVersion → proceed (matching version)
 *   - call listSpecs → get one spec hash
 *   - call listBlocks for that spec → get one block root
 *   - call getBlock (idempotency check) → null (not present)
 *   - call fetchBlock (via pullBlock) → valid WireBlockTriplet
 *   - call storeBlock → row inserted
 *   - return report with blocksInserted === 1
 *
 * This is the production sequence end-to-end.
 */
export const prop_full_walk_compound_interaction = fc.asyncProperty(
  remotePeerArb,
  async (remote) => {
    const row = makeRow("compound");
    const root = row.blockMerkleRoot;
    const sh = row.specHash;
    const wire = serializeWireBlockTriplet(row);

    const transport = makeTransport({
      schemaVersion: SCHEMA_VERSION,
      specHashes: [sh],
      blocksBySpec: new Map([[sh, [root]]]),
      wireByRoot: new Map([[root, wire]]),
    });

    const registry = makeRegistry();

    const report = await mirrorRegistry(
      remote,
      registry as unknown as import("@yakcc/registry").Registry,
      transport,
    );

    return (
      report.specsWalked === 1 &&
      report.blocksConsidered === 1 &&
      report.blocksInserted === 1 &&
      report.blocksSkipped === 0 &&
      report.failures.length === 0 &&
      registry.stored.length === 1 &&
      registry.stored[0]?.blockMerkleRoot === root
    );
  },
);
