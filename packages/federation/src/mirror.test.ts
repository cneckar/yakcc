/**
 * Tests for mirrorRegistry (WI-020 v2 Slice D).
 *
 * @decision DEC-MIRROR-TEST-020: Test strategy for mirrorRegistry.
 * Status: decided (WI-020 Dispatch D)
 * Title: Stub Transport + in-memory registry for deterministic mirror tests.
 * Rationale:
 *   mirrorRegistry's correctness is tested via a stub Transport (no network I/O)
 *   and an in-memory registry (openRegistry(":memory:")). Real BlockTripletRow
 *   fixtures are constructed using @yakcc/contracts directly so that artifact bytes
 *   fold into blockMerkleRoot — the v2 acceptance criterion for
 *   DEC-V1-FEDERATION-WIRE-ARTIFACTS-002.
 *
 *   Test cases cover:
 *   (1) Empty source → zeros report, ISO-8601 timestamps present.
 *   (2) Happy path: 2 specs × 2 blocks each → 4 inserts, no failures.
 *   (3) Idempotency: second mirror run → 0 inserted, 4 skipped, no failures.
 *   (4) Integrity failure on one block → 3 inserted, 1 failure, walk continues.
 *   (5) Schema-version mismatch → SchemaVersionMismatchError thrown, 0 rows in registry.
 *   (6) ISO-8601 assertion: all timestamps in the happy-path report match the pattern.
 *
 *   The compound-interaction test (test 2) exercises the full production sequence:
 *   stub transport → mirrorRegistry → pullBlock → deserializeWireBlockTriplet →
 *   registry.storeBlock → MirrorReport. This crosses transport, wire-integrity,
 *   and storage boundaries in one test.
 *
 * No new merkle helper introduced; no direct @noble/hashes import.
 * DEC-V1-FEDERATION-WIRE-ARTIFACTS-002, DEC-CONTRACTS-AUTHORITY-001.
 */

import { blockMerkleRoot, canonicalize, specHash, validateProofManifestL0 } from "@yakcc/contracts";
import type { BlockMerkleRoot, CanonicalAstHash, SpecHash, SpecYak } from "@yakcc/contracts";
import { openRegistry } from "@yakcc/registry";
import type { BlockTripletRow } from "@yakcc/registry";
import { describe, expect, it } from "vitest";
import { mirrorRegistry } from "./mirror.js";
import { SchemaVersionMismatchError } from "./types.js";
import type {
  CatalogPage,
  RemoteManifest,
  RemotePeer,
  Transport,
  WireBlockTriplet,
} from "./types.js";
import { serializeWireBlockTriplet } from "./wire.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const REMOTE: RemotePeer = "https://peer.example.com";

// ISO-8601 UTC timestamp pattern (with optional fractional seconds).
const ISO8601_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

// ---------------------------------------------------------------------------
// Spec fixtures
// ---------------------------------------------------------------------------

/**
 * Two minimal SpecYak objects for constructing fixture rows.
 * Distinct specs produce distinct specHash values and thus appear under
 * different spec hash buckets in the mirror walk.
 */
const SPEC_A: SpecYak = {
  name: "toString",
  inputs: [{ name: "n", type: "number" }],
  outputs: [{ name: "r", type: "string" }],
  preconditions: [],
  postconditions: [],
  invariants: [],
  effects: [],
  level: "L0",
};

const SPEC_B: SpecYak = {
  name: "double",
  inputs: [{ name: "x", type: "number" }],
  outputs: [{ name: "y", type: "number" }],
  preconditions: [],
  postconditions: [],
  invariants: [],
  effects: [],
  level: "L0",
};

/**
 * A minimal valid L0 proof manifest — exactly one property_tests artifact.
 */
const PROOF_MANIFEST_JSON =
  '{"artifacts":[{"kind":"property_tests","path":"tests.fast-check.ts"}]}';
const PROOF_MANIFEST = validateProofManifestL0(JSON.parse(PROOF_MANIFEST_JSON));
const ARTIFACT_PATH = "tests.fast-check.ts";
const ARTIFACT_BYTES_A = new TextEncoder().encode(
  "import fc from 'fast-check';\nfc.assert(fc.property(fc.integer(), n => typeof String(n) === 'string'));",
);
const ARTIFACT_BYTES_B = new TextEncoder().encode(
  "import fc from 'fast-check';\nfc.assert(fc.property(fc.integer(), x => x * 2 === x + x));",
);

// ---------------------------------------------------------------------------
// Fixture builder
// ---------------------------------------------------------------------------

/**
 * Build a fully consistent BlockTripletRow using @yakcc/contracts blockMerkleRoot()
 * as the single authority for block identity.
 *
 * No inline merkle helper; no direct @noble/hashes import.
 * DEC-CONTRACTS-AUTHORITY-001, DEC-V1-FEDERATION-WIRE-ARTIFACTS-002.
 */
function makeRow(
  spec: SpecYak,
  implSource: string,
  artifactBytes: Uint8Array,
  discriminator?: string,
): BlockTripletRow {
  const artifacts = new Map<string, Uint8Array>([[ARTIFACT_PATH, artifactBytes]]);
  const specCanonicalBytes = canonicalize(spec as unknown as Parameters<typeof canonicalize>[0]);
  const specHashHex = specHash(spec) as SpecHash;
  const merkleRoot = blockMerkleRoot({
    spec,
    implSource,
    manifest: PROOF_MANIFEST,
    artifacts,
  });

  return {
    blockMerkleRoot: merkleRoot,
    specHash: specHashHex,
    specCanonicalBytes,
    implSource: discriminator !== undefined ? `${implSource} /* ${discriminator} */` : implSource,
    proofManifestJson: PROOF_MANIFEST_JSON,
    level: "L0",
    createdAt: 1_714_000_000_000,
    canonicalAstHash: "a".repeat(64) as CanonicalAstHash,
    parentBlockRoot: null,
    artifacts,
  };
}

/**
 * Build a row where the implSource is varied by a discriminator so that
 * different blocks under the same spec produce distinct merkle roots.
 */
function makeRowVariant(
  spec: SpecYak,
  artifactBytes: Uint8Array,
  variant: string,
): BlockTripletRow {
  const implSource = `export function fn(n: number): unknown { return n; } /* v=${variant} */`;
  const artifacts = new Map<string, Uint8Array>([[ARTIFACT_PATH, artifactBytes]]);
  const specCanonicalBytes = canonicalize(spec as unknown as Parameters<typeof canonicalize>[0]);
  const specHashHex = specHash(spec) as SpecHash;
  const merkleRoot = blockMerkleRoot({
    spec,
    implSource,
    manifest: PROOF_MANIFEST,
    artifacts,
  });

  return {
    blockMerkleRoot: merkleRoot,
    specHash: specHashHex,
    specCanonicalBytes,
    implSource,
    proofManifestJson: PROOF_MANIFEST_JSON,
    level: "L0",
    createdAt: 1_714_000_000_000,
    canonicalAstHash: "a".repeat(64) as CanonicalAstHash,
    parentBlockRoot: null,
    artifacts,
  };
}

// ---------------------------------------------------------------------------
// Stub Transport builder
// ---------------------------------------------------------------------------

/**
 * Stub Transport for mirror tests.
 *
 * The stub maps:
 *   - getSchemaVersion → returns a configurable { schemaVersion }
 *   - listSpecs → returns a list of spec hashes
 *   - listBlocks(specHash) → returns block roots for that spec
 *   - fetchBlock(root) → returns the wire triplet for that root (or throws)
 *
 * Unimplemented methods throw to catch accidental invocations.
 */
function makeStubTransport(opts: {
  schemaVersion: number;
  specHashes: readonly SpecHash[];
  blocksBySpec: ReadonlyMap<SpecHash, readonly BlockMerkleRoot[]>;
  wireByRoot: ReadonlyMap<BlockMerkleRoot, WireBlockTriplet | (() => Promise<WireBlockTriplet>)>;
}): Transport {
  return {
    getSchemaVersion(_remote: RemotePeer): Promise<{ readonly schemaVersion: number }> {
      return Promise.resolve({ schemaVersion: opts.schemaVersion });
    },

    listSpecs(_remote: RemotePeer): Promise<readonly SpecHash[]> {
      return Promise.resolve(opts.specHashes);
    },

    listBlocks(_remote: RemotePeer, specHashKey: SpecHash): Promise<readonly BlockMerkleRoot[]> {
      return Promise.resolve(opts.blocksBySpec.get(specHashKey) ?? []);
    },

    async fetchBlock(_remote: RemotePeer, root: BlockMerkleRoot): Promise<WireBlockTriplet> {
      const entry = opts.wireByRoot.get(root);
      if (entry === undefined) {
        throw new Error(`stubTransport: fetchBlock called with unknown root ${root}`);
      }
      return typeof entry === "function" ? entry() : entry;
    },

    // Unimplemented — not used by mirrorRegistry.
    fetchManifest(_remote: RemotePeer): Promise<RemoteManifest> {
      throw new Error("stubTransport: fetchManifest not expected in mirror tests");
    },
    fetchCatalogPage(
      _remote: RemotePeer,
      _after: BlockMerkleRoot | null,
      _limit: number,
    ): Promise<CatalogPage> {
      throw new Error("stubTransport: fetchCatalogPage not expected in mirror tests");
    },
    fetchSpec(_remote: RemotePeer, _specHashKey: SpecHash): Promise<readonly BlockMerkleRoot[]> {
      throw new Error("stubTransport: fetchSpec not expected in mirror tests");
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers to build the stub topology for 2 specs × 2 blocks each
// ---------------------------------------------------------------------------

/**
 * Build the 4-row fixture set: specA → [rowA1, rowA2], specB → [rowB1, rowB2].
 * Used across happy-path and idempotency tests.
 */
function buildHappyPathFixture() {
  const rowA1 = makeRowVariant(SPEC_A, ARTIFACT_BYTES_A, "a1");
  const rowA2 = makeRowVariant(SPEC_A, ARTIFACT_BYTES_B, "a2");
  const rowB1 = makeRowVariant(SPEC_B, ARTIFACT_BYTES_A, "b1");
  const rowB2 = makeRowVariant(SPEC_B, ARTIFACT_BYTES_B, "b2");

  const specHashA = rowA1.specHash;
  const specHashB = rowB1.specHash;

  const specHashes: SpecHash[] = [specHashA, specHashB];
  const blocksBySpec = new Map<SpecHash, readonly BlockMerkleRoot[]>([
    [specHashA, [rowA1.blockMerkleRoot, rowA2.blockMerkleRoot]],
    [specHashB, [rowB1.blockMerkleRoot, rowB2.blockMerkleRoot]],
  ]);
  const wireByRoot = new Map<BlockMerkleRoot, WireBlockTriplet>([
    [rowA1.blockMerkleRoot, serializeWireBlockTriplet(rowA1)],
    [rowA2.blockMerkleRoot, serializeWireBlockTriplet(rowA2)],
    [rowB1.blockMerkleRoot, serializeWireBlockTriplet(rowB1)],
    [rowB2.blockMerkleRoot, serializeWireBlockTriplet(rowB2)],
  ]);

  return { rows: [rowA1, rowA2, rowB1, rowB2], specHashes, blocksBySpec, wireByRoot };
}

// ---------------------------------------------------------------------------
// Test helpers: embedding provider stub
// ---------------------------------------------------------------------------

/**
 * A no-op embedding provider so openRegistry(":memory:") doesn't need the
 * local transformers.js model loaded. Returns a fixed 384-element zero vector.
 */
const ZERO_EMBEDDINGS = {
  dimension: 384,
  modelId: "test/zero-embeddings",
  async embed(_text: string): Promise<Float32Array> {
    return new Float32Array(384);
  },
};

// ---------------------------------------------------------------------------
// (1) Empty source test
// ---------------------------------------------------------------------------

describe("mirrorRegistry — empty source", () => {
  it("returns a zero-count report with ISO-8601 timestamps when listSpecs returns []", async () => {
    const registry = await openRegistry(":memory:", { embeddings: ZERO_EMBEDDINGS });

    const transport = makeStubTransport({
      schemaVersion: 5, // matches local SCHEMA_VERSION
      specHashes: [],
      blocksBySpec: new Map(),
      wireByRoot: new Map(),
    });

    let tick = 0;
    const basetime = new Date("2024-05-01T00:00:00.000Z");
    const clock = () => new Date(basetime.getTime() + tick++ * 1000);

    const report = await mirrorRegistry(REMOTE, registry, transport, { clock });

    await registry.close();

    expect(report.serveUrl).toBe(REMOTE);
    expect(report.schemaVersion).toBe(5);
    expect(report.specsWalked).toBe(0);
    expect(report.blocksConsidered).toBe(0);
    expect(report.blocksInserted).toBe(0);
    expect(report.blocksSkipped).toBe(0);
    expect(report.failures).toHaveLength(0);

    // Timestamps must be ISO-8601.
    expect(report.startedAt).toMatch(ISO8601_PATTERN);
    expect(report.finishedAt).toMatch(ISO8601_PATTERN);
  });
});

// ---------------------------------------------------------------------------
// (2) Happy path: 2 specs × 2 blocks each (Compound-Interaction test)
//
// This is the compound-interaction test: exercises the full production sequence
// across transport, pullBlock (wire integrity gate), and registry.storeBlock
// boundaries in a single test:
//   stub transport → mirrorRegistry → pullBlock → deserializeWireBlockTriplet →
//   registry.storeBlock → MirrorReport with blocksInserted: 4, failures: [].
//
// DEC-V1-FEDERATION-WIRE-ARTIFACTS-002: artifact bytes fold into proof root via
// pullBlock → deserializeWireBlockTriplet → @yakcc/contracts.blockMerkleRoot.
// ---------------------------------------------------------------------------

describe("mirrorRegistry — happy path: 2 specs × 2 blocks (compound-interaction)", () => {
  it("inserts 4 blocks, reports blocksInserted: 4, blocksSkipped: 0, failures: []", async () => {
    const registry = await openRegistry(":memory:", { embeddings: ZERO_EMBEDDINGS });
    const { specHashes, blocksBySpec, wireByRoot } = buildHappyPathFixture();

    const transport = makeStubTransport({
      schemaVersion: 5,
      specHashes,
      blocksBySpec,
      wireByRoot,
    });

    const report = await mirrorRegistry(REMOTE, registry, transport);

    await registry.close();

    expect(report.specsWalked).toBe(2);
    expect(report.blocksConsidered).toBe(4);
    expect(report.blocksInserted).toBe(4);
    expect(report.blocksSkipped).toBe(0);
    expect(report.failures).toHaveLength(0);
    expect(report.schemaVersion).toBe(5);
    expect(report.serveUrl).toBe(REMOTE);
    expect(report.startedAt).toMatch(ISO8601_PATTERN);
    expect(report.finishedAt).toMatch(ISO8601_PATTERN);
  });
});

// ---------------------------------------------------------------------------
// (3) Idempotency test
//
// Run mirror twice. The second run must report blocksInserted: 0, blocksSkipped: 4,
// failures: [] because all rows are already present in the local registry.
// ---------------------------------------------------------------------------

describe("mirrorRegistry — idempotency", () => {
  it("second run reports blocksInserted: 0, blocksSkipped: 4, no failures", async () => {
    const registry = await openRegistry(":memory:", { embeddings: ZERO_EMBEDDINGS });
    const { specHashes, blocksBySpec, wireByRoot } = buildHappyPathFixture();

    const transport = makeStubTransport({
      schemaVersion: 5,
      specHashes,
      blocksBySpec,
      wireByRoot,
    });

    // First run: populates the registry.
    const firstReport = await mirrorRegistry(REMOTE, registry, transport);
    expect(firstReport.blocksInserted).toBe(4);
    expect(firstReport.blocksSkipped).toBe(0);

    // Second run: all rows already present.
    const secondReport = await mirrorRegistry(REMOTE, registry, transport);

    await registry.close();

    expect(secondReport.blocksInserted).toBe(0);
    expect(secondReport.blocksSkipped).toBe(4);
    expect(secondReport.failures).toHaveLength(0);
    expect(secondReport.specsWalked).toBe(2);
    expect(secondReport.blocksConsidered).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// (4) Integrity failure on one block
//
// One block's wire triplet has a tampered proofManifestJson so that pullBlock
// throws IntegrityError. The other 3 blocks still mirror; blocksInserted: 3.
// The tampered block appears in failures[].
// ---------------------------------------------------------------------------

describe("mirrorRegistry — integrity failure on one block", () => {
  it("captures the failing block in failures[], still inserts the other 3", async () => {
    const registry = await openRegistry(":memory:", { embeddings: ZERO_EMBEDDINGS });
    const { rows, specHashes, blocksBySpec } = buildHappyPathFixture();

    const [rowA1, rowA2, rowB1, rowB2] = rows as [
      BlockTripletRow,
      BlockTripletRow,
      BlockTripletRow,
      BlockTripletRow,
    ];

    // Build a wire version of rowA2 with a tampered proofManifestJson.
    // The manifest will fail validateProofManifestL0 because it has no artifacts.
    // This causes deserializeWireBlockTriplet to throw IntegrityError(manifest_invalid).
    const tamperedWireA2: WireBlockTriplet = {
      ...serializeWireBlockTriplet(rowA2),
      proofManifestJson: '{"artifacts":[]}', // empty artifacts — invalid L0
    };

    const wireByRoot = new Map<BlockMerkleRoot, WireBlockTriplet>([
      [rowA1.blockMerkleRoot, serializeWireBlockTriplet(rowA1)],
      [rowA2.blockMerkleRoot, tamperedWireA2], // this one will fail
      [rowB1.blockMerkleRoot, serializeWireBlockTriplet(rowB1)],
      [rowB2.blockMerkleRoot, serializeWireBlockTriplet(rowB2)],
    ]);

    const transport = makeStubTransport({
      schemaVersion: 5,
      specHashes,
      blocksBySpec,
      wireByRoot,
    });

    const report = await mirrorRegistry(REMOTE, registry, transport);

    await registry.close();

    // 3 blocks succeed, 1 fails.
    expect(report.blocksConsidered).toBe(4);
    expect(report.blocksInserted).toBe(3);
    expect(report.blocksSkipped).toBe(0);
    expect(report.specsWalked).toBe(2);

    // Exactly one failure.
    expect(report.failures).toHaveLength(1);
    const failure = report.failures[0];
    expect(failure).toBeDefined();
    expect(failure?.blockMerkleRoot).toBe(rowA2.blockMerkleRoot);
    expect(failure?.specHash).toBe(rowA2.specHash);
    expect(typeof failure?.reason).toBe("string");
    expect(failure?.reason.length).toBeGreaterThan(0);
    expect(failure?.at).toMatch(ISO8601_PATTERN);
  });
});

// ---------------------------------------------------------------------------
// (5) Schema-version mismatch
//
// Remote reports schemaVersion: 999. mirrorRegistry must throw
// SchemaVersionMismatchError BEFORE inserting any rows.
// ---------------------------------------------------------------------------

describe("mirrorRegistry — schema-version mismatch", () => {
  it("throws SchemaVersionMismatchError and inserts zero rows when remote version > local", async () => {
    const registry = await openRegistry(":memory:", { embeddings: ZERO_EMBEDDINGS });

    // Build a small fixture — these rows must NOT end up in the registry.
    const row = makeRowVariant(SPEC_A, ARTIFACT_BYTES_A, "v1");
    const specHashA = row.specHash;
    const wireByRoot = new Map<BlockMerkleRoot, WireBlockTriplet>([
      [row.blockMerkleRoot, serializeWireBlockTriplet(row)],
    ]);

    const transport = makeStubTransport({
      schemaVersion: 999, // remote is way ahead — must abort
      specHashes: [specHashA],
      blocksBySpec: new Map([[specHashA, [row.blockMerkleRoot]]]),
      wireByRoot,
    });

    await expect(mirrorRegistry(REMOTE, registry, transport)).rejects.toBeInstanceOf(
      SchemaVersionMismatchError,
    );

    // Verify the local registry has zero rows — no insertion should have happened.
    const blocks = await registry.selectBlocks(specHashA);
    expect(blocks).toHaveLength(0);

    await registry.close();
  });

  it("SchemaVersionMismatchError carries the correct remote and local schema versions", async () => {
    const registry = await openRegistry(":memory:", { embeddings: ZERO_EMBEDDINGS });

    const transport = makeStubTransport({
      schemaVersion: 999,
      specHashes: [],
      blocksBySpec: new Map(),
      wireByRoot: new Map(),
    });

    let caughtError: unknown;
    try {
      await mirrorRegistry(REMOTE, registry, transport);
    } catch (err) {
      caughtError = err;
    }

    await registry.close();

    expect(caughtError).toBeInstanceOf(SchemaVersionMismatchError);
    const err = caughtError as SchemaVersionMismatchError;
    expect(err.remoteSchemaVersion).toBe(999);
    expect(err.localSchemaVersion).toBe(8); // local SCHEMA_VERSION (bumped to 8 in WI-V2-WORKSPACE-PLUMBING-GLUE-CAPTURE #333)
  });
});

// ---------------------------------------------------------------------------
// (6) ISO-8601 assertion on happy-path timestamps
// ---------------------------------------------------------------------------

describe("mirrorRegistry — ISO-8601 timestamps", () => {
  it("all timestamps in the happy-path report match the ISO-8601 UTC pattern", async () => {
    const registry = await openRegistry(":memory:", { embeddings: ZERO_EMBEDDINGS });
    const { specHashes, blocksBySpec, wireByRoot } = buildHappyPathFixture();

    const transport = makeStubTransport({
      schemaVersion: 5,
      specHashes,
      blocksBySpec,
      wireByRoot,
    });

    const report = await mirrorRegistry(REMOTE, registry, transport);
    await registry.close();

    expect(report.startedAt).toMatch(ISO8601_PATTERN);
    expect(report.finishedAt).toMatch(ISO8601_PATTERN);
    // No failure timestamps in the happy path — check the pattern holds for
    // any failure entries that might exist (should be zero here).
    for (const failure of report.failures) {
      expect(failure.at).toMatch(ISO8601_PATTERN);
    }
  });

  it("clock override produces deterministic ISO-8601 timestamps in the report", async () => {
    const registry = await openRegistry(":memory:", { embeddings: ZERO_EMBEDDINGS });

    const transport = makeStubTransport({
      schemaVersion: 5,
      specHashes: [],
      blocksBySpec: new Map(),
      wireByRoot: new Map(),
    });

    const fixedDate = new Date("2024-01-15T12:00:00.000Z");
    const clock = () => fixedDate;

    const report = await mirrorRegistry(REMOTE, registry, transport, { clock });
    await registry.close();

    expect(report.startedAt).toBe("2024-01-15T12:00:00.000Z");
    expect(report.finishedAt).toBe("2024-01-15T12:00:00.000Z");
    expect(report.startedAt).toMatch(ISO8601_PATTERN);
    expect(report.finishedAt).toMatch(ISO8601_PATTERN);
  });
});
