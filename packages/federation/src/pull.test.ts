/**
 * Tests for pullBlock and pullSpec (WI-020 v2 Slice C).
 *
 * Test coverage per Evaluation Contract:
 *   (1) pullBlock — success path: stub transport returns valid wire triplet with
 *       artifacts → BlockTripletRow with artifacts Map byte-identical round-trip.
 *       This is the compound-interaction test: exercises the full production sequence
 *       transport.fetchBlock → deserializeWireBlockTriplet (full integrity gate
 *       including blockMerkleRoot recomputation via @yakcc/contracts with the
 *       reconstructed artifacts Map) → returned BlockTripletRow.
 *   (2) pullBlock — corrupted blockMerkleRoot → IntegrityError(reason='integrity_failed')
 *   (3) pullBlock — corrupted artifact bytes → IntegrityError(reason='integrity_failed')
 *       [v2 acceptance test: DEC-V1-FEDERATION-WIRE-ARTIFACTS-002]
 *   (4) pullSpec — TransportError(code='not_found') → returns []
 *   (5) pullSpec — success path: stub returns roots → propagated unchanged
 *
 * All tests use handwritten stub Transport objects — no real network I/O.
 * opts.transport is always injected; the default HTTP transport is never loaded.
 *
 * Fixture rows are built using @yakcc/contracts blockMerkleRoot() directly —
 * no blockMerkleRootFromRow or any wire-only merkle helper (DEC-CONTRACTS-AUTHORITY-001,
 * DEC-V1-FEDERATION-WIRE-ARTIFACTS-002, forbidden shortcuts in dispatch contract).
 */

import { blockMerkleRoot, canonicalize, specHash, validateProofManifestL0 } from "@yakcc/contracts";
import type { BlockMerkleRoot, CanonicalAstHash, SpecHash, SpecYak } from "@yakcc/contracts";
import type { BlockTripletRow } from "@yakcc/registry";
import { describe, expect, it } from "vitest";
import { pullBlock, pullSpec } from "./pull.js";
import { IntegrityError, TransportError } from "./types.js";
import type { CatalogPage, RemoteManifest, Transport, WireBlockTriplet } from "./types.js";
import { serializeWireBlockTriplet } from "./wire.js";

// ---------------------------------------------------------------------------
// Constants and fixtures
// ---------------------------------------------------------------------------

const REMOTE = "https://peer.example.com";

/**
 * A minimal valid SpecYak object for use in test fixtures.
 * All blockMerkleRoot() calls go through @yakcc/contracts — no local formula.
 */
const TEST_SPEC: SpecYak = {
  name: "pullFn",
  inputs: [{ name: "n", type: "number" }],
  outputs: [{ name: "r", type: "string" }],
  preconditions: [],
  postconditions: [],
  invariants: [],
  effects: [],
  level: "L0",
};

const TEST_IMPL_SOURCE = "export function pullFn(n: number): string { return String(n); }";

/**
 * Minimal valid L0 proofManifestJson — exactly one property_tests artifact.
 * Keys in artifactBytes match the path declared here.
 */
const VALID_PROOF_MANIFEST_JSON =
  '{"artifacts":[{"kind":"property_tests","path":"tests.fast-check.ts"}]}';

const VALID_PROOF_MANIFEST = validateProofManifestL0(JSON.parse(VALID_PROOF_MANIFEST_JSON));

const TEXT_ENCODER = new TextEncoder();

/**
 * The artifact bytes that go with VALID_PROOF_MANIFEST.
 * Key must match the manifest path exactly ("tests.fast-check.ts").
 *
 * v2: every fixture row carries a real artifacts Map. The blockMerkleRoot()
 * formula folds these bytes into the proof root, so any mutation produces a
 * different root and fails the integrity gate.
 */
const TEST_ARTIFACT_BYTES = TEXT_ENCODER.encode(
  "import fc from 'fast-check';\n" +
    "fc.assert(fc.property(fc.integer(), (n) => typeof pullFn(n) === 'string'));",
);

const TEST_ARTIFACTS = new Map<string, Uint8Array>([["tests.fast-check.ts", TEST_ARTIFACT_BYTES]]);

// ---------------------------------------------------------------------------
// Fixture builder
// ---------------------------------------------------------------------------

/**
 * Build a BlockTripletRow with internally consistent hashes using
 * @yakcc/contracts blockMerkleRoot() — the single authority for the block
 * identity formula (DEC-CONTRACTS-AUTHORITY-001).
 *
 * The row is fully v2-shaped: artifacts Map is populated and the blockMerkleRoot
 * was computed with those artifact bytes folded in.
 *
 * No blockMerkleRootFromRow or any wire-only merkle helper is used here.
 */
function makeConsistentRow(overrides: Partial<BlockTripletRow> = {}): BlockTripletRow {
  const spec: SpecYak = TEST_SPEC;
  const implSource = overrides.implSource ?? TEST_IMPL_SOURCE;
  const manifest = VALID_PROOF_MANIFEST;
  // BlockTripletRow.artifacts is ReadonlyMap; blockMerkleRoot accepts Map — cast is safe.
  const artifacts = (overrides.artifacts as Map<string, Uint8Array> | undefined) ?? TEST_ARTIFACTS;

  // canonicalize() returns the same bytes blockMerkleRoot() uses internally.
  const specCanonicalBytes = canonicalize(spec as unknown as Parameters<typeof canonicalize>[0]);

  // Compute the authoritative merkle root via @yakcc/contracts — with artifacts.
  const merkleRoot = blockMerkleRoot({ spec, implSource, manifest, artifacts });

  // Compute specHash via @yakcc/contracts (single authority).
  const specHashHex = specHash(spec) as SpecHash;

  const base: BlockTripletRow = {
    blockMerkleRoot: merkleRoot,
    specHash: specHashHex,
    specCanonicalBytes,
    implSource,
    proofManifestJson: VALID_PROOF_MANIFEST_JSON,
    level: "L0",
    createdAt: 1_714_000_000_000,
    canonicalAstHash: "a".repeat(64) as CanonicalAstHash,
    parentBlockRoot: null,
    artifacts,
  };

  // Apply remaining overrides (excluding spec/manifest/artifacts which drive the hash).
  const { artifacts: _a, implSource: _i, ...rest } = overrides;
  return { ...base, ...(rest as Partial<BlockTripletRow>) };
}

// ---------------------------------------------------------------------------
// Stub Transport helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal handwritten Transport stub.
 * Unimplemented methods throw to catch accidental invocations.
 */
function makeStubTransport(opts: {
  fetchBlockResult?: WireBlockTriplet | (() => Promise<WireBlockTriplet>);
  fetchSpecResult?: readonly BlockMerkleRoot[] | (() => Promise<readonly BlockMerkleRoot[]>);
}): Transport {
  return {
    fetchManifest(_remote: string): Promise<RemoteManifest> {
      throw new Error("stubTransport: fetchManifest not expected in this test");
    },
    fetchCatalogPage(
      _remote: string,
      _after: BlockMerkleRoot | null,
      _limit: number,
    ): Promise<CatalogPage> {
      throw new Error("stubTransport: fetchCatalogPage not expected in this test");
    },
    async fetchBlock(_remote: string, _root: BlockMerkleRoot): Promise<WireBlockTriplet> {
      if (opts.fetchBlockResult === undefined) {
        throw new Error("stubTransport: fetchBlock not expected in this test");
      }
      return typeof opts.fetchBlockResult === "function"
        ? opts.fetchBlockResult()
        : opts.fetchBlockResult;
    },
    async fetchSpec(_remote: string, _specHash: SpecHash): Promise<readonly BlockMerkleRoot[]> {
      if (opts.fetchSpecResult === undefined) {
        throw new Error("stubTransport: fetchSpec not expected in this test");
      }
      return typeof opts.fetchSpecResult === "function"
        ? opts.fetchSpecResult()
        : opts.fetchSpecResult;
    },
    getSchemaVersion(_remote: string): Promise<{ readonly schemaVersion: number }> {
      throw new Error("stubTransport: getSchemaVersion not expected in this test");
    },
    listSpecs(_remote: string): Promise<readonly SpecHash[]> {
      throw new Error("stubTransport: listSpecs not expected in this test");
    },
    listBlocks(_remote: string, _specHash: SpecHash): Promise<readonly BlockMerkleRoot[]> {
      throw new Error("stubTransport: listBlocks not expected in this test");
    },
  };
}

/**
 * Build a Transport stub where fetchSpec throws a TransportError with a given code.
 */
function makeThrowingSpecTransport(code: string): Transport {
  return makeStubTransport({
    fetchSpecResult: async () => {
      throw new TransportError({ code, message: `stub: ${code}` });
    },
  });
}

// ---------------------------------------------------------------------------
// (1) pullBlock — success path (Compound-Interaction test)
//
// This is the compound-interaction test: exercises the full production sequence
// across Transport boundary and wire deserialization boundary:
//   stubTransport.fetchBlock → serializeWireBlockTriplet (sender side) →
//   deserializeWireBlockTriplet (receiver side, full integrity gate) →
//   BlockTripletRow with artifacts Map populated.
//
// Verifies that the artifacts Map round-trips end-to-end (byte-identical).
// DEC-V1-FEDERATION-WIRE-ARTIFACTS-002.
// ---------------------------------------------------------------------------

describe("pullBlock — success path (compound-interaction)", () => {
  it("fetches a valid wire triplet and returns the hydrated BlockTripletRow with artifacts Map", async () => {
    const row = makeConsistentRow();
    // Sender serializes; receiver must reconstruct identically.
    const wire = serializeWireBlockTriplet(row);
    const transport = makeStubTransport({ fetchBlockResult: wire });

    const result = await pullBlock(REMOTE, row.blockMerkleRoot, { transport });

    // Identity fields
    expect(result.blockMerkleRoot).toBe(row.blockMerkleRoot);
    expect(result.specHash).toBe(row.specHash);
    expect(result.level).toBe("L0");
    expect(result.implSource).toBe(row.implSource);
    expect(result.proofManifestJson).toBe(row.proofManifestJson);
    expect(result.canonicalAstHash).toBe(row.canonicalAstHash);
    expect(result.createdAt).toBe(row.createdAt);
    expect(result.parentBlockRoot).toBeNull();

    // specCanonicalBytes: byte-level equality
    expect(result.specCanonicalBytes).toBeInstanceOf(Uint8Array);
    expect(result.specCanonicalBytes).toHaveLength(row.specCanonicalBytes.length);
    expect(Buffer.from(result.specCanonicalBytes).toString("base64")).toBe(
      Buffer.from(row.specCanonicalBytes).toString("base64"),
    );

    // artifacts Map: byte-identical round-trip (v2 acceptance criterion)
    expect(result.artifacts).toBeInstanceOf(Map);
    expect(result.artifacts.size).toBe(row.artifacts.size);
    for (const [path, bytes] of row.artifacts) {
      expect(result.artifacts.has(path)).toBe(true);
      const recoveredBytes = result.artifacts.get(path);
      expect(recoveredBytes).toBeInstanceOf(Uint8Array);
      // biome-ignore lint/style/noNonNullAssertion: Map.get guarded by has() assertion above
      expect(Buffer.from(recoveredBytes!).toString("base64")).toBe(
        Buffer.from(bytes).toString("base64"),
      );
    }
  });

  it("returns a BlockTripletRow with the correct canonicalAstHash from the wire", async () => {
    const row = makeConsistentRow({
      canonicalAstHash: "f".repeat(64) as CanonicalAstHash,
    });
    const wire = serializeWireBlockTriplet(row);
    const transport = makeStubTransport({ fetchBlockResult: wire });

    const result = await pullBlock(REMOTE, row.blockMerkleRoot, { transport });

    expect(result.canonicalAstHash).toBe("f".repeat(64));
  });

  it("preserves non-null parentBlockRoot through the round-trip", async () => {
    const parentRoot = "b".repeat(64) as BlockMerkleRoot;
    const row = makeConsistentRow({ parentBlockRoot: parentRoot });
    const wire = serializeWireBlockTriplet(row);
    const transport = makeStubTransport({ fetchBlockResult: wire });

    const result = await pullBlock(REMOTE, row.blockMerkleRoot, { transport });

    expect(result.parentBlockRoot).toBe(parentRoot);
  });
});

// ---------------------------------------------------------------------------
// (2) pullBlock — corrupted blockMerkleRoot → IntegrityError(integrity_failed)
//
// Authority invariant: pullBlock MUST funnel through deserializeWireBlockTriplet.
// Even if the transport returns a structurally valid WireBlockTriplet, a tampered
// blockMerkleRoot must be caught and rejected.
// ---------------------------------------------------------------------------

describe("pullBlock — corrupted blockMerkleRoot rejected by integrity gate", () => {
  it("throws IntegrityError(reason='integrity_failed') when blockMerkleRoot is tampered", async () => {
    const row = makeConsistentRow();
    const wire = serializeWireBlockTriplet(row);
    // Tamper the merkle root on the wire — the row itself is valid but the wire is corrupt.
    const tamperedWire: WireBlockTriplet = {
      ...wire,
      blockMerkleRoot: "0".repeat(64),
    };
    const transport = makeStubTransport({ fetchBlockResult: tamperedWire });

    await expect(pullBlock(REMOTE, row.blockMerkleRoot, { transport })).rejects.toSatisfy(
      (err: unknown) => err instanceof IntegrityError && err.reason === "integrity_failed",
    );
  });
});

// ---------------------------------------------------------------------------
// (3) pullBlock — corrupted artifact bytes → IntegrityError(integrity_failed)
//
// v2 acceptance test (DEC-V1-FEDERATION-WIRE-ARTIFACTS-002): artifact bytes
// fold into blockMerkleRoot via @yakcc/contracts. A single-byte mutation in
// any artifactBytes value causes the recomputed root to diverge from the wire
// blockMerkleRoot field. pullBlock must catch this as integrity_failed.
//
// This closes the gap that motivated the v2 remediation: the v1 wire
// computed blockMerkleRoot from proofManifestJson alone (omitting artifact
// bytes), so tampered artifact bytes passed the integrity gate. v2 folds
// artifact bytes into the proof root, so any tampering is now detected.
// ---------------------------------------------------------------------------

describe("pullBlock — corrupted artifact bytes rejected by integrity gate (v2 acceptance)", () => {
  it("throws IntegrityError(reason='integrity_failed') when artifactBytes are tampered", async () => {
    const row = makeConsistentRow();
    const wire = serializeWireBlockTriplet(row);

    // Corrupt one byte of the artifact's base64 value.
    // Decode, flip a byte, re-encode — the blockMerkleRoot check must now diverge.
    // biome-ignore lint/style/noNonNullAssertion: key known present (makeRow always adds this artifact)
    const originalB64 = wire.artifactBytes["tests.fast-check.ts"]!;
    const decoded = Buffer.from(originalB64, "base64");
    // Flip one byte in the middle of the content.
    const byteIndex = Math.floor(decoded.length / 2);
    // biome-ignore lint/style/noNonNullAssertion: Buffer index access for byte mutation
    decoded[byteIndex]! ^= 0xff;
    const corruptedB64 = decoded.toString("base64");

    const tamperedWire: WireBlockTriplet = {
      ...wire,
      artifactBytes: {
        ...wire.artifactBytes,
        "tests.fast-check.ts": corruptedB64,
      },
    };
    const transport = makeStubTransport({ fetchBlockResult: tamperedWire });

    await expect(pullBlock(REMOTE, row.blockMerkleRoot, { transport })).rejects.toSatisfy(
      (err: unknown) => err instanceof IntegrityError && err.reason === "integrity_failed",
    );
  });
});

// ---------------------------------------------------------------------------
// (4) pullSpec — TransportError(code='not_found') → returns []
//
// FEDERATION_PROTOCOL.md §3: 404 is a normal response meaning the peer has
// no blocks for this spec. pullSpec translates not_found → [].
// ---------------------------------------------------------------------------

describe("pullSpec — not_found TransportError → returns []", () => {
  it("returns an empty array when the transport throws TransportError(code='not_found')", async () => {
    const transport = makeThrowingSpecTransport("not_found");
    const specHashHex = "c".repeat(64) as SpecHash;

    const result = await pullSpec(REMOTE, specHashHex, { transport });

    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// (5) pullSpec — success path
// ---------------------------------------------------------------------------

describe("pullSpec — success path", () => {
  it("returns the BlockMerkleRoots from the remote for a given SpecHash", async () => {
    const rootA = "a".repeat(64) as BlockMerkleRoot;
    const rootB = "b".repeat(64) as BlockMerkleRoot;
    const transport = makeStubTransport({ fetchSpecResult: [rootA, rootB] });
    const specHashHex = "c".repeat(64) as SpecHash;

    const result = await pullSpec(REMOTE, specHashHex, { transport });

    expect(result).toEqual([rootA, rootB]);
  });

  it("returns an empty array when the transport returns [] (peer has no blocks for spec)", async () => {
    const transport = makeStubTransport({ fetchSpecResult: [] });
    const specHashHex = "c".repeat(64) as SpecHash;

    const result = await pullSpec(REMOTE, specHashHex, { transport });

    expect(result).toEqual([]);
  });

  it("re-throws TransportError(code='internal_error') without swallowing it", async () => {
    const transport = makeThrowingSpecTransport("internal_error");
    const specHashHex = "c".repeat(64) as SpecHash;

    await expect(pullSpec(REMOTE, specHashHex, { transport })).rejects.toSatisfy(
      (err: unknown) => err instanceof TransportError && err.code === "internal_error",
    );
  });

  it("re-throws TransportError(code='rate_limited') without swallowing it", async () => {
    const transport = makeThrowingSpecTransport("rate_limited");
    const specHashHex = "c".repeat(64) as SpecHash;

    await expect(pullSpec(REMOTE, specHashHex, { transport })).rejects.toSatisfy(
      (err: unknown) => err instanceof TransportError && err.code === "rate_limited",
    );
  });
});
