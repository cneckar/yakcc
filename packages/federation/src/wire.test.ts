/**
 * Wire format tests for @yakcc/federation (WI-020 v2, Slice A).
 *
 * This is the v2 acceptance test suite. The critical v2 invariant is that
 * blockMerkleRoot integrity uses @yakcc/contracts blockMerkleRoot() with a
 * populated artifacts Map — artifact bytes fold into proof_root. The v1 bug
 * was computing BLAKE3(proofManifestJson) only (omitting artifact bytes),
 * which produced a divergent hash for any block that actually had artifacts.
 *
 * Test coverage per Evaluation Contract:
 *   (1) byte-identical round-trip with real artifacts Map (compound-interaction test)
 *   (2) tampered blockMerkleRoot → integrity_failed
 *   (3) tampered specHash → integrity_failed
 *   (4) tampered single artifact byte → integrity_failed  [v2 acceptance test]
 *   (5) tampered artifactBytes key set → manifest_invalid
 *   (6) level=L1/L2/L3 → level_unsupported
 *   (7) non-L0 manifest → manifest_invalid
 *   (8) no-ownership invariant (DEC-NO-OWNERSHIP-011)
 *   (9) "no parallel merkle helper" assertion: wire.ts imports blockMerkleRoot
 *       from @yakcc/contracts and does NOT contain a local BLAKE3(proofManifestJson)
 *       formula.
 *
 * Compound-interaction test: the round-trip test exercises the full production
 * sequence — serialize (local outgoing) → JSON stringify/parse (wire transit)
 * → deserialize (remote incoming with all integrity checks including artifacts).
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { blockMerkleRoot, canonicalize, specHash, validateProofManifestL0 } from "@yakcc/contracts";
import type { BlockMerkleRoot, CanonicalAstHash, LocalTriplet, SpecHash, SpecYak } from "@yakcc/contracts";
import type { BlockTripletRow } from "@yakcc/registry";
import { IntegrityError } from "./types.js";
import { deserializeWireBlockTriplet, serializeWireBlockTriplet } from "./wire.js";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const TEXT_ENCODER = new TextEncoder();

/**
 * A minimal valid SpecYak object for use in test fixtures.
 * All blockMerkleRoot() calls in tests go through @yakcc/contracts — which
 * canonicalizes this spec internally — so fixtures built here stay consistent.
 */
const TEST_SPEC: SpecYak = {
  name: "testFn",
  inputs: [{ name: "x", type: "string" }],
  outputs: [{ name: "r", type: "number" }],
  preconditions: [],
  postconditions: [],
  invariants: [],
  effects: [],
  level: "L0",
};

const TEST_IMPL_SOURCE = 'export function testFn(x: string): number { return parseInt(x, 10); }';

/**
 * Minimal valid L0 proofManifestJson — exactly one property_tests artifact.
 */
const VALID_PROOF_MANIFEST_JSON =
  '{"artifacts":[{"kind":"property_tests","path":"tests.fast-check.ts"}]}';

const VALID_PROOF_MANIFEST = validateProofManifestL0(JSON.parse(VALID_PROOF_MANIFEST_JSON));

/**
 * The artifact bytes that go with VALID_PROOF_MANIFEST.
 * Key must match the manifest path exactly.
 */
const TEST_ARTIFACT_BYTES = TEXT_ENCODER.encode(
  "import fc from 'fast-check';\nfc.assert(fc.property(fc.string(), (s) => typeof testFn(s) === 'number'));",
);

const TEST_ARTIFACTS = new Map<string, Uint8Array>([
  ["tests.fast-check.ts", TEST_ARTIFACT_BYTES],
]);

/**
 * Build a BlockTripletRow using @yakcc/contracts blockMerkleRoot() — the
 * single authority for the block identity formula (DEC-CONTRACTS-AUTHORITY-001).
 * The row is internally consistent: its blockMerkleRoot matches what the
 * contracts formula computes for the given fields.
 */
function makeRow(overrides: Partial<BlockTripletRow> = {}): BlockTripletRow {
  const overridesAny = overrides as Record<string, unknown>;
  const spec = (overridesAny["spec"] as SpecYak | undefined) ?? TEST_SPEC;
  const implSource = overrides.implSource ?? TEST_IMPL_SOURCE;
  // `manifest` is not a field of BlockTripletRow; it drives proofManifestJson and the hash.
  const manifest = (overridesAny["manifest"] as LocalTriplet["manifest"] | undefined) ?? VALID_PROOF_MANIFEST;
  // BlockTripletRow.artifacts is ReadonlyMap; blockMerkleRoot accepts Map — cast is safe.
  const artifacts = (overrides.artifacts as Map<string, Uint8Array> | undefined) ?? TEST_ARTIFACTS;

  // canonicalize() produces the bytes blockMerkleRoot() uses internally for spec_hash.
  const specCanonicalBytes = canonicalize(spec as unknown as Parameters<typeof canonicalize>[0]);
  // Compute the authoritative merkle root via @yakcc/contracts.
  const merkleRoot = blockMerkleRoot({ spec, implSource, manifest, artifacts });

  // Compute specHash via @yakcc/contracts — the single authority (DEC-CONTRACTS-AUTHORITY-001).
  const specHashHex = specHash(spec) as SpecHash;

  const proofManifestJson = overrides.proofManifestJson ?? JSON.stringify(manifest);

  const base: BlockTripletRow = {
    blockMerkleRoot: merkleRoot,
    specHash: specHashHex,
    specCanonicalBytes,
    implSource,
    proofManifestJson,
    level: "L0",
    createdAt: 1_714_000_000_000,
    canonicalAstHash: "a".repeat(64) as CanonicalAstHash,
    parentBlockRoot: null,
    artifacts,
  };

  // Apply remaining overrides (excluding fields we already handled above).
  const { spec: _s, implSource: _i, manifest: _m, artifacts: _a, ...rest } = overridesAny;
  return { ...base, ...(rest as Partial<BlockTripletRow>) };
}

/**
 * Simulate a full wire transit: serialize → JSON.stringify → JSON.parse.
 * This exercises the same serialization path a remote peer would see.
 */
function wireTransit(row: BlockTripletRow): unknown {
  const wire = serializeWireBlockTriplet(row);
  return JSON.parse(JSON.stringify(wire));
}

// ---------------------------------------------------------------------------
// (1) Byte-identical round-trip with real artifacts Map (compound-interaction test)
// ---------------------------------------------------------------------------

describe("serializeWireBlockTriplet / deserializeWireBlockTriplet — round-trip", () => {
  it("serialize then deserialize produces byte-identical fields (with real artifacts)", () => {
    const row = makeRow();
    const received = wireTransit(row);
    const recovered = deserializeWireBlockTriplet(received);

    expect(recovered.blockMerkleRoot).toBe(row.blockMerkleRoot);
    expect(recovered.specHash).toBe(row.specHash);
    expect(recovered.implSource).toBe(row.implSource);
    expect(recovered.proofManifestJson).toBe(row.proofManifestJson);
    expect(recovered.level).toBe("L0");
    expect(recovered.canonicalAstHash).toBe(row.canonicalAstHash);
    expect(recovered.createdAt).toBe(row.createdAt);
    expect(recovered.parentBlockRoot).toBeNull();

    // specCanonicalBytes: byte-level equality
    expect(recovered.specCanonicalBytes).toBeInstanceOf(Uint8Array);
    expect(recovered.specCanonicalBytes).toHaveLength(row.specCanonicalBytes.length);
    expect(Buffer.from(recovered.specCanonicalBytes).toString("base64")).toBe(
      Buffer.from(row.specCanonicalBytes).toString("base64"),
    );

    // artifacts Map: reconstructed correctly
    expect(recovered.artifacts).toBeInstanceOf(Map);
    expect(recovered.artifacts.size).toBe(row.artifacts.size);
    for (const [path, bytes] of row.artifacts) {
      expect(recovered.artifacts.has(path)).toBe(true);
      const recoveredBytes = recovered.artifacts.get(path);
      expect(recoveredBytes).toBeInstanceOf(Uint8Array);
      expect(Buffer.from(recoveredBytes!).toString("base64")).toBe(
        Buffer.from(bytes).toString("base64"),
      );
    }
  });

  it("round-trip with non-null parentBlockRoot preserves lineage", () => {
    const parentRoot = "b".repeat(64) as BlockMerkleRoot;
    const row = makeRow({ parentBlockRoot: parentRoot });
    const recovered = deserializeWireBlockTriplet(wireTransit(row));
    expect(recovered.parentBlockRoot).toBe(parentRoot);
  });

  it("round-trip is deterministic across multiple calls", () => {
    const row = makeRow();
    const r1 = deserializeWireBlockTriplet(wireTransit(row));
    const r2 = deserializeWireBlockTriplet(wireTransit(row));
    expect(r1.blockMerkleRoot).toBe(r2.blockMerkleRoot);
    expect(r1.specHash).toBe(r2.specHash);
    expect(r1.implSource).toBe(r2.implSource);
  });

  it("serializeWireBlockTriplet maps undefined parentBlockRoot to null", () => {
    // Pass via cast so exactOptionalPropertyTypes allows undefined in the override.
    const row = makeRow({ parentBlockRoot: undefined as unknown as null });
    const wire = serializeWireBlockTriplet(row);
    expect(wire.parentBlockRoot).toBeNull();
  });

  it("artifactBytes entries in serialized wire match the artifacts Map", () => {
    const row = makeRow();
    const wire = serializeWireBlockTriplet(row);
    expect(typeof wire.artifactBytes).toBe("object");
    expect(Object.keys(wire.artifactBytes)).toHaveLength(row.artifacts.size);
    for (const [path, bytes] of row.artifacts) {
      expect(wire.artifactBytes[path]).toBe(Buffer.from(bytes).toString("base64"));
    }
  });
});

// ---------------------------------------------------------------------------
// (2) Tampered blockMerkleRoot → integrity_failed
// ---------------------------------------------------------------------------

describe("deserializeWireBlockTriplet — tampered blockMerkleRoot", () => {
  it("throws IntegrityError with reason='integrity_failed' when blockMerkleRoot is tampered", () => {
    const row = makeRow();
    const wire = serializeWireBlockTriplet(row);
    const tampered = { ...wire, blockMerkleRoot: "f".repeat(64) };
    expect(() => deserializeWireBlockTriplet(JSON.parse(JSON.stringify(tampered)))).toThrow(IntegrityError);
    try {
      deserializeWireBlockTriplet(JSON.parse(JSON.stringify(tampered)));
    } catch (err) {
      expect(err).toBeInstanceOf(IntegrityError);
      expect((err as IntegrityError).reason).toBe("integrity_failed");
    }
  });

  it("single-character flip in blockMerkleRoot still triggers integrity_failed", () => {
    const row = makeRow();
    const wire = serializeWireBlockTriplet(row);
    const flipped =
      wire.blockMerkleRoot[0] === "a"
        ? `b${wire.blockMerkleRoot.slice(1)}`
        : `a${wire.blockMerkleRoot.slice(1)}`;
    const tampered = { ...wire, blockMerkleRoot: flipped };
    expect(() => deserializeWireBlockTriplet(JSON.parse(JSON.stringify(tampered)))).toThrow(IntegrityError);
  });
});

// ---------------------------------------------------------------------------
// (3) Tampered specHash → integrity_failed
// ---------------------------------------------------------------------------

describe("deserializeWireBlockTriplet — tampered specHash", () => {
  it("throws IntegrityError with reason='integrity_failed' when specHash is tampered", () => {
    const row = makeRow();
    const wire = serializeWireBlockTriplet(row);
    const tampered = { ...wire, specHash: "e".repeat(64) };
    try {
      deserializeWireBlockTriplet(JSON.parse(JSON.stringify(tampered)));
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(IntegrityError);
      expect((err as IntegrityError).reason).toBe("integrity_failed");
    }
  });
});

// ---------------------------------------------------------------------------
// (4) Tampered single artifact byte → integrity_failed  [v2 acceptance test]
//
// This is the test that PROVES v2 is correct: artifact bytes fold into
// blockMerkleRoot via proof_root. Any single-byte mutation in an artifact
// must produce a different blockMerkleRoot and fail the integrity gate.
// The v1 bug (BLAKE3(proofManifestJson) only) would NOT catch this tampering.
// ---------------------------------------------------------------------------

describe("deserializeWireBlockTriplet — tampered artifact bytes (v2 acceptance test)", () => {
  it("single tampered byte in an artifact fails integrity_failed", () => {
    const row = makeRow();
    const wire = serializeWireBlockTriplet(row);

    // Decode the artifact bytes, flip one byte, re-encode.
    const artifactPath = Object.keys(wire.artifactBytes)[0]!;
    const originalBytes = Buffer.from(wire.artifactBytes[artifactPath]!, "base64");
    const tampered_buf = Buffer.from(originalBytes);
    tampered_buf[0] = tampered_buf[0]! ^ 0xff; // flip all bits in first byte
    const tamperedArtifactBytes = {
      ...wire.artifactBytes,
      [artifactPath]: tampered_buf.toString("base64"),
    };
    const tampered = { ...wire, artifactBytes: tamperedArtifactBytes };

    try {
      deserializeWireBlockTriplet(JSON.parse(JSON.stringify(tampered)));
      throw new Error("should have thrown — v1 bug would have passed this; v2 must fail it");
    } catch (err) {
      expect(err).toBeInstanceOf(IntegrityError);
      expect((err as IntegrityError).reason).toBe("integrity_failed");
    }
  });

  it("completely replaced artifact bytes for an existing key fails integrity_failed", () => {
    const row = makeRow();
    const wire = serializeWireBlockTriplet(row);
    const artifactPath = Object.keys(wire.artifactBytes)[0]!;
    const replacedArtifactBytes = {
      ...wire.artifactBytes,
      [artifactPath]: Buffer.from("completely different bytes").toString("base64"),
    };
    const tampered = { ...wire, artifactBytes: replacedArtifactBytes };

    try {
      deserializeWireBlockTriplet(JSON.parse(JSON.stringify(tampered)));
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(IntegrityError);
      expect((err as IntegrityError).reason).toBe("integrity_failed");
    }
  });
});

// ---------------------------------------------------------------------------
// (5) Tampered artifactBytes key set → manifest_invalid
// ---------------------------------------------------------------------------

describe("deserializeWireBlockTriplet — artifactBytes key set mismatch", () => {
  it("extra key in artifactBytes → manifest_invalid (artifact_key_mismatch)", () => {
    const row = makeRow();
    const wire = serializeWireBlockTriplet(row);
    // Add an extra key not declared in the manifest
    const tampered = {
      ...wire,
      artifactBytes: {
        ...wire.artifactBytes,
        "extra-file.ts": Buffer.from("extra").toString("base64"),
      },
    };
    try {
      deserializeWireBlockTriplet(JSON.parse(JSON.stringify(tampered)));
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(IntegrityError);
      expect((err as IntegrityError).reason).toBe("manifest_invalid");
    }
  });

  it("missing key in artifactBytes → manifest_invalid (artifact_key_mismatch)", () => {
    const row = makeRow();
    const wire = serializeWireBlockTriplet(row);
    // Remove all artifactBytes entries (manifest declares one artifact)
    const tampered = { ...wire, artifactBytes: {} };
    try {
      deserializeWireBlockTriplet(JSON.parse(JSON.stringify(tampered)));
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(IntegrityError);
      expect((err as IntegrityError).reason).toBe("manifest_invalid");
    }
  });

  it("renamed key in artifactBytes → manifest_invalid", () => {
    const row = makeRow();
    const wire = serializeWireBlockTriplet(row);
    const originalPath = Object.keys(wire.artifactBytes)[0]!;
    const origVal = wire.artifactBytes[originalPath]!;
    // Rename the key — same bytes but wrong path
    const { [originalPath]: _removed, ...rest } = wire.artifactBytes;
    const tampered = {
      ...wire,
      artifactBytes: { ...rest, "wrong-path.ts": origVal },
    };
    try {
      deserializeWireBlockTriplet(JSON.parse(JSON.stringify(tampered)));
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(IntegrityError);
      expect((err as IntegrityError).reason).toBe("manifest_invalid");
    }
  });
});

// ---------------------------------------------------------------------------
// (6) level=L1/L2/L3 → level_unsupported (DEC-TRIPLET-L0-ONLY-019)
// ---------------------------------------------------------------------------

describe("deserializeWireBlockTriplet — level_unsupported", () => {
  for (const level of ["L1", "L2", "L3"] as const) {
    it(`rejects level="${level}" with IntegrityError reason='level_unsupported'`, () => {
      const row = makeRow();
      const wire = serializeWireBlockTriplet(row);
      const tampered = { ...wire, level };
      try {
        deserializeWireBlockTriplet(JSON.parse(JSON.stringify(tampered)));
        throw new Error("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(IntegrityError);
        expect((err as IntegrityError).reason).toBe("level_unsupported");
      }
    });
  }

  it("rejects a completely unknown level with level_unsupported", () => {
    const row = makeRow();
    const wire = serializeWireBlockTriplet(row);
    const tampered = { ...wire, level: "L99" };
    try {
      deserializeWireBlockTriplet(JSON.parse(JSON.stringify(tampered)));
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(IntegrityError);
      expect((err as IntegrityError).reason).toBe("level_unsupported");
    }
  });
});

// ---------------------------------------------------------------------------
// (7) Non-L0 manifest → manifest_invalid
// ---------------------------------------------------------------------------

describe("deserializeWireBlockTriplet — manifest_invalid", () => {
  it("rejects a manifest with smt_cert artifact (L2 only) with manifest_invalid", () => {
    // Build a row with an L2 manifest and correctly computed merkle root for it.
    const badManifest = { artifacts: [{ kind: "smt_cert" as const, path: "refinement.smt2", theory: ["bv64"] }] };
    const badManifestJson = JSON.stringify(badManifest);
    // We need a row whose blockMerkleRoot matches the bad manifest — but since
    // validateProofManifestL0 will reject before we reach the merkle check, any
    // root that passes the specHash check is sufficient to reach step 5.
    // The simplest approach: re-build using @yakcc/contracts with the bad manifest.
    // But blockMerkleRoot() in @yakcc/contracts accepts any ProofManifest structure —
    // it doesn't validate artifact kinds. So we can compute a consistent root.
    const spec = TEST_SPEC;
    const implSource = TEST_IMPL_SOURCE;
    const badArtifacts = new Map<string, Uint8Array>([
      ["refinement.smt2", TEXT_ENCODER.encode("(assert (= 1 1))")],
    ]);
    const badRoot = blockMerkleRoot({
      spec,
      implSource,
      manifest: badManifest as unknown as LocalTriplet["manifest"],
      artifacts: badArtifacts,
    });
    const specBytes = canonicalize(spec as unknown as Parameters<typeof canonicalize>[0]);
    // Compute specHash via @yakcc/contracts — DEC-CONTRACTS-AUTHORITY-001.
    const specHashHex = specHash(spec) as SpecHash;

    const row: BlockTripletRow = {
      blockMerkleRoot: badRoot,
      specHash: specHashHex,
      specCanonicalBytes: specBytes,
      implSource,
      proofManifestJson: badManifestJson,
      level: "L0",
      createdAt: 1_000,
      canonicalAstHash: "0".repeat(64) as CanonicalAstHash,
      parentBlockRoot: null,
      artifacts: badArtifacts,
    };

    const wire = serializeWireBlockTriplet(row);
    try {
      deserializeWireBlockTriplet(JSON.parse(JSON.stringify(wire)));
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(IntegrityError);
      expect((err as IntegrityError).reason).toBe("manifest_invalid");
    }
  });

  it("rejects invalid JSON in proofManifestJson with manifest_invalid", () => {
    const row = makeRow();
    const wire = serializeWireBlockTriplet(row);
    const tampered = { ...wire, proofManifestJson: "not valid json {{" };
    try {
      deserializeWireBlockTriplet(JSON.parse(JSON.stringify(tampered)));
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(IntegrityError);
      expect((err as IntegrityError).reason).toBe("manifest_invalid");
    }
  });

  it("rejects a manifest with no artifacts with manifest_invalid", () => {
    const row = makeRow();
    const wire = serializeWireBlockTriplet(row);
    const tampered = { ...wire, proofManifestJson: '{"artifacts":[]}' };
    try {
      deserializeWireBlockTriplet(JSON.parse(JSON.stringify(tampered)));
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(IntegrityError);
      expect((err as IntegrityError).reason).toBe("manifest_invalid");
    }
  });
});

// ---------------------------------------------------------------------------
// (8) No-ownership invariant (DEC-NO-OWNERSHIP-011)
// ---------------------------------------------------------------------------

describe("DEC-NO-OWNERSHIP-011 — no ownership fields on wire", () => {
  it("serialized WireBlockTriplet keys are disjoint from the ownership field set", () => {
    const OWNERSHIP_FIELDS = new Set([
      "author",
      "authorEmail",
      "signer",
      "signature",
      "owner",
      "account",
      "username",
      "organization",
      "sessionId",
      "submitter",
      "files",
      "paths",
    ]);

    const row = makeRow();
    const wire = serializeWireBlockTriplet(row);
    const wireKeys = new Set(Object.keys(wire));

    const intersection = [...wireKeys].filter((k) => OWNERSHIP_FIELDS.has(k));
    expect(intersection).toHaveLength(0);
  });

  it("wire object has exactly the expected fields (no extras)", () => {
    const EXPECTED_WIRE_FIELDS = new Set([
      "blockMerkleRoot",
      "specHash",
      "specCanonicalBytes",
      "implSource",
      "proofManifestJson",
      "artifactBytes",
      "level",
      "createdAt",
      "canonicalAstHash",
      "parentBlockRoot",
    ]);

    const row = makeRow();
    const wire = serializeWireBlockTriplet(row);
    const wireKeys = new Set(Object.keys(wire));

    const extras = [...wireKeys].filter((k) => !EXPECTED_WIRE_FIELDS.has(k));
    expect(extras).toHaveLength(0);

    const missing = [...EXPECTED_WIRE_FIELDS].filter((k) => !wireKeys.has(k));
    expect(missing).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// (9) "No parallel merkle helper" assertion
//
// DEC-V1-FEDERATION-WIRE-ARTIFACTS-002: wire.ts must import blockMerkleRoot
// from @yakcc/contracts and must NOT contain any local BLAKE3(proofManifestJson)
// formula. This test reads the source and asserts the structural invariant.
// ---------------------------------------------------------------------------

describe("DEC-V1-FEDERATION-WIRE-ARTIFACTS-002 — no parallel merkle helper", () => {
  it("wire.ts imports blockMerkleRoot from @yakcc/contracts", () => {
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const wireSrc = readFileSync(resolve(__dirname, "wire.ts"), "utf-8");

    // Must import blockMerkleRoot from contracts
    expect(wireSrc).toMatch(/import\s*\{[^}]*blockMerkleRoot[^}]*\}\s*from\s*["']@yakcc\/contracts["']/);
  });

  it("wire.ts does NOT contain a local BLAKE3(proofManifestJson) computation", () => {
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const wireSrc = readFileSync(resolve(__dirname, "wire.ts"), "utf-8");

    // The v1 bug pattern: blake3(TEXT_ENCODER.encode(proofManifestJson)) or similar
    // local computation that bypasses the contracts formula.
    // We check that no blockMerkleRoot-like function is defined locally that takes
    // only (specBytes, implSource, manifestJson) — i.e. omitting an artifacts param.
    expect(wireSrc).not.toMatch(/blockMerkleRootFromRow/);
    // Must not contain a local merkle function that takes proofManifestJson as a raw string
    // and hashes it directly — the tell is blake3(...encode(proofManifestJson)) as a
    // standalone proofRoot computation without artifacts involvement.
    expect(wireSrc).not.toMatch(/blake3\s*\([^)]*proofManifestJson[^)]*\)/);
  });

  it("wire.ts calls blockMerkleRoot with artifacts parameter", () => {
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const wireSrc = readFileSync(resolve(__dirname, "wire.ts"), "utf-8");

    // The blockMerkleRoot({ ... artifacts ... }) call must be present
    expect(wireSrc).toMatch(/blockMerkleRoot\s*\(\s*\{/);
    expect(wireSrc).toMatch(/artifacts[,\s]/);
  });
});

// ---------------------------------------------------------------------------
// Structural validation — shape errors
// ---------------------------------------------------------------------------

describe("deserializeWireBlockTriplet — structural validation", () => {
  it("rejects null", () => {
    expect(() => deserializeWireBlockTriplet(null)).toThrow(TypeError);
  });

  it("rejects an array", () => {
    expect(() => deserializeWireBlockTriplet([])).toThrow(TypeError);
  });

  it("rejects a string", () => {
    expect(() => deserializeWireBlockTriplet("not an object")).toThrow(TypeError);
  });

  it("rejects an object missing blockMerkleRoot", () => {
    const row = makeRow();
    const wire = serializeWireBlockTriplet(row);
    const { blockMerkleRoot: _dropped, ...rest } = wire;
    expect(() => deserializeWireBlockTriplet(rest)).toThrow(TypeError);
  });

  it("rejects an object missing specCanonicalBytes", () => {
    const row = makeRow();
    const wire = serializeWireBlockTriplet(row);
    const { specCanonicalBytes: _dropped, ...rest } = wire;
    expect(() => deserializeWireBlockTriplet(rest)).toThrow(TypeError);
  });

  it("rejects an object missing artifactBytes", () => {
    const row = makeRow();
    const wire = serializeWireBlockTriplet(row);
    const { artifactBytes: _dropped, ...rest } = wire;
    expect(() => deserializeWireBlockTriplet(rest)).toThrow(TypeError);
  });

  it("rejects artifactBytes as an array (not a plain object)", () => {
    const row = makeRow();
    const wire = serializeWireBlockTriplet(row);
    const tampered = { ...wire, artifactBytes: ["not", "a", "record"] };
    expect(() => deserializeWireBlockTriplet(tampered)).toThrow(TypeError);
  });

  it("rejects a non-number createdAt", () => {
    const row = makeRow();
    const wire = serializeWireBlockTriplet(row);
    const tampered = { ...wire, createdAt: "not a number" };
    expect(() => deserializeWireBlockTriplet(tampered)).toThrow(TypeError);
  });

  it("rejects undefined parentBlockRoot (must be string or null)", () => {
    const row = makeRow();
    const wire = serializeWireBlockTriplet(row);
    const tampered = { ...wire, parentBlockRoot: undefined };
    expect(() => deserializeWireBlockTriplet(tampered)).toThrow(TypeError);
  });
});

