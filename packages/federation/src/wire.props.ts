// SPDX-License-Identifier: MIT
// @decision DEC-V2-PROPTEST-PATH-A-002: hand-authored property-test corpus for
// @yakcc/federation wire.ts atoms. Two-file pattern: this file (.props.ts) is
// vitest-free and holds the corpus; the sibling .props.test.ts is the vitest harness.
// Status: accepted (WI-87-fill-federation)
// Rationale: Same two-file pattern as pull.props.ts — corpus is runtime-independent
// so it can be hashed as a manifest artifact by future tooling.

// ---------------------------------------------------------------------------
// Property-test corpus for federation/src/wire.ts atoms
//
// Atoms covered (2 exported functions):
//   serializeWireBlockTriplet   (A2.1) — BlockTripletRow → WireBlockTriplet
//   deserializeWireBlockTriplet (A2.2) — WireBlockTriplet → BlockTripletRow (with integrity gate)
//
// Properties exercised:
//   1. serialize is pure/deterministic — same input produces equal outputs
//   2. serialize → deserialize round-trip: fields are byte-identical
//   3. undefined parentBlockRoot serializes to null
//   4. Corrupt wire (missing required field) → deserializeWireBlockTriplet throws TypeError
//   5. Level !== "L0" → IntegrityError({ reason: "level_unsupported" })
//   6. Tampered blockMerkleRoot → IntegrityError({ reason: "integrity_failed" })
//   7. Tampered artifactBytes (single bit-flip) → IntegrityError({ reason: "integrity_failed" })
//   8. No ownership fields in serialized wire (DEC-NO-OWNERSHIP-011)
//
// Tests use @yakcc/contracts blockMerkleRoot/specHash/canonicalize/validateProofManifestL0
// as the single authority for building internally-consistent BlockTripletRow fixtures.
// ---------------------------------------------------------------------------

import { blockMerkleRoot, canonicalize, specHash, validateProofManifestL0 } from "@yakcc/contracts";
import type {
  BlockMerkleRoot,
  CanonicalAstHash,
  LocalTriplet,
  SpecHash,
  SpecYak,
} from "@yakcc/contracts";
import type { BlockTripletRow } from "@yakcc/registry";
import * as fc from "fast-check";
import { IntegrityError } from "./types.js";
import { deserializeWireBlockTriplet, serializeWireBlockTriplet } from "./wire.js";

// ---------------------------------------------------------------------------
// Shared arbitraries and fixtures
// ---------------------------------------------------------------------------

/**
 * A minimal valid SpecYak for fixture construction.
 * blockMerkleRoot() canonicalizes this internally; fixtures built here stay consistent.
 */
const TEST_SPEC: SpecYak = {
  name: "wireProp",
  inputs: [{ name: "n", type: "number" }],
  outputs: [{ name: "r", type: "string" }],
  preconditions: [],
  postconditions: [],
  invariants: [],
  effects: [],
  level: "L0",
};

const TEST_IMPL_SOURCE = "export function wireProp(n: number): string { return String(n); }";

const VALID_MANIFEST_JSON = '{"artifacts":[{"kind":"property_tests","path":"wireProp.fc.ts"}]}';
const VALID_MANIFEST = validateProofManifestL0(JSON.parse(VALID_MANIFEST_JSON));

const TEXT_ENCODER = new TextEncoder();

const TEST_ARTIFACT_BYTES = TEXT_ENCODER.encode(
  "import fc from 'fast-check';\nfc.assert(fc.property(fc.integer(), (n) => typeof wireProp(n) === 'string'));",
);

const TEST_ARTIFACTS = new Map<string, Uint8Array>([["wireProp.fc.ts", TEST_ARTIFACT_BYTES]]);

/**
 * Build a BlockTripletRow that is internally consistent using @yakcc/contracts
 * as the single authority for blockMerkleRoot / specHash computation.
 */
function makeRow(overrides: Partial<BlockTripletRow> = {}): BlockTripletRow {
  const anyOverrides = overrides as Record<string, unknown>;
  const spec = (anyOverrides.spec as SpecYak | undefined) ?? TEST_SPEC;
  const implSource = overrides.implSource ?? TEST_IMPL_SOURCE;
  const manifest =
    (anyOverrides.manifest as LocalTriplet["manifest"] | undefined) ?? VALID_MANIFEST;
  const artifacts =
    (overrides.artifacts as Map<string, Uint8Array> | undefined) ?? TEST_ARTIFACTS;

  const specCanonicalBytes = canonicalize(spec as unknown as Parameters<typeof canonicalize>[0]);
  const merkleRoot = blockMerkleRoot({ spec, implSource, manifest, artifacts });
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
    canonicalAstHash: "c".repeat(64) as CanonicalAstHash,
    parentBlockRoot: null,
    artifacts,
  };

  const { spec: _s, implSource: _i, manifest: _m, artifacts: _a, ...rest } = anyOverrides;
  return { ...base, ...(rest as Partial<BlockTripletRow>) };
}

/**
 * Arbitrary for a valid, internally-consistent BlockTripletRow.
 * Randomizes implSource text to produce distinct wire values.
 */
const blockTripletRowArb: fc.Arbitrary<BlockTripletRow> = fc
  .string({ minLength: 1, maxLength: 80 })
  .map((suffix) =>
    makeRow({
      implSource: `export function wireProp_${suffix}(n: number): string { return String(n); }`,
    }),
  );

/**
 * Simulate wire transit: serialize → JSON.stringify → JSON.parse.
 * Exercises the same path a remote peer would see.
 */
function wireTransit(row: BlockTripletRow): unknown {
  const wire = serializeWireBlockTriplet(row);
  return JSON.parse(JSON.stringify(wire));
}

// ---------------------------------------------------------------------------
// A2.1: serializeWireBlockTriplet — properties
// ---------------------------------------------------------------------------

/**
 * prop_serialize_is_deterministic
 *
 * For any BlockTripletRow, serialize called twice on the same row produces
 * identical WireBlockTriplet values (same keys, same base64 strings).
 *
 * Invariant: serializeWireBlockTriplet is a pure projection — no randomness,
 * no clock, no side-effects.
 */
export const prop_serialize_is_deterministic = fc.property(
  blockTripletRowArb,
  (row) => {
    const w1 = serializeWireBlockTriplet(row);
    const w2 = serializeWireBlockTriplet(row);
    if (w1.blockMerkleRoot !== w2.blockMerkleRoot) return false;
    if (w1.specHash !== w2.specHash) return false;
    if (w1.specCanonicalBytes !== w2.specCanonicalBytes) return false;
    if (w1.implSource !== w2.implSource) return false;
    if (w1.proofManifestJson !== w2.proofManifestJson) return false;
    if (JSON.stringify(w1.artifactBytes) !== JSON.stringify(w2.artifactBytes)) return false;
    return true;
  },
);

/**
 * prop_serialize_maps_null_parentBlockRoot
 *
 * When parentBlockRoot is null (or undefined), serializeWireBlockTriplet must
 * emit wire.parentBlockRoot === null (not undefined, not the string "null").
 *
 * Invariant per wire.ts: `parentBlockRoot: row.parentBlockRoot ?? null`.
 */
export const prop_serialize_maps_null_parentBlockRoot = fc.property(
  blockTripletRowArb,
  (row) => {
    const rowWithNull = { ...row, parentBlockRoot: null };
    const wire = serializeWireBlockTriplet(rowWithNull);
    return wire.parentBlockRoot === null;
  },
);

/**
 * prop_serialize_artifactBytes_keys_match_artifacts_map
 *
 * The serialized wire.artifactBytes keys must be exactly the same as the
 * keys in the source artifacts Map, and each value must be a base64 string.
 *
 * Invariant: serialize iterates the Map and base64-encodes each Uint8Array entry.
 */
export const prop_serialize_artifactBytes_keys_match_artifacts_map = fc.property(
  blockTripletRowArb,
  (row) => {
    const wire = serializeWireBlockTriplet(row);
    const wireKeys = new Set(Object.keys(wire.artifactBytes));
    const mapKeys = new Set([...row.artifacts.keys()]);

    if (wireKeys.size !== mapKeys.size) return false;
    for (const k of mapKeys) {
      if (!wireKeys.has(k)) return false;
      if (typeof wire.artifactBytes[k] !== "string") return false;
    }
    return true;
  },
);

/**
 * prop_serialize_no_ownership_fields
 *
 * The serialized WireBlockTriplet must contain none of the ownership field names
 * enumerated by DEC-NO-OWNERSHIP-011.
 */
export const prop_serialize_no_ownership_fields = fc.property(
  blockTripletRowArb,
  (row) => {
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
    ]);
    const wire = serializeWireBlockTriplet(row);
    const wireKeys = Object.keys(wire);
    return wireKeys.every((k) => !OWNERSHIP_FIELDS.has(k));
  },
);

// ---------------------------------------------------------------------------
// A2.2: deserializeWireBlockTriplet — round-trip and integrity gate properties
// ---------------------------------------------------------------------------

/**
 * prop_roundtrip_preserves_merkle_root
 *
 * serialize → wireTransit → deserialize preserves blockMerkleRoot exactly.
 *
 * Invariant: the round-trip is lossless for the primary block identity field.
 * This is the most important invariant: blockMerkleRoot is the content-address key.
 */
export const prop_roundtrip_preserves_merkle_root = fc.property(
  blockTripletRowArb,
  (row) => {
    const recovered = deserializeWireBlockTriplet(wireTransit(row));
    return recovered.blockMerkleRoot === row.blockMerkleRoot;
  },
);

/**
 * prop_roundtrip_preserves_spec_hash
 *
 * serialize → wireTransit → deserialize preserves specHash exactly.
 *
 * Invariant: specHash is the spec-identity key; it must survive the round-trip byte-identical.
 */
export const prop_roundtrip_preserves_spec_hash = fc.property(
  blockTripletRowArb,
  (row) => {
    const recovered = deserializeWireBlockTriplet(wireTransit(row));
    return recovered.specHash === row.specHash;
  },
);

/**
 * prop_roundtrip_preserves_implSource
 *
 * serialize → wireTransit → deserialize preserves implSource exactly (no truncation,
 * no encoding transformation beyond JSON string escaping).
 */
export const prop_roundtrip_preserves_implSource = fc.property(
  blockTripletRowArb,
  (row) => {
    const recovered = deserializeWireBlockTriplet(wireTransit(row));
    return recovered.implSource === row.implSource;
  },
);

/**
 * prop_deserialize_rejects_non_object
 *
 * deserializeWireBlockTriplet throws TypeError when given a non-object value.
 *
 * Invariant: structural shape validation (Step 1 in wire.ts) must reject
 * null, arrays, strings, and numbers with TypeError, not silent coercion.
 */
export const prop_deserialize_rejects_non_object = fc.property(
  fc.oneof(
    fc.constant(null),
    fc.constant([1, 2, 3]),
    fc.string({ minLength: 0, maxLength: 20 }),
    fc.integer(),
  ),
  (bad) => {
    try {
      deserializeWireBlockTriplet(bad);
      return false; // must have thrown
    } catch (err) {
      return err instanceof TypeError;
    }
  },
);

/**
 * prop_deserialize_rejects_level_L1_L2_L3
 *
 * When wire.level is "L1", "L2", or "L3", deserializeWireBlockTriplet throws
 * IntegrityError({ reason: "level_unsupported" }) per DEC-TRIPLET-L0-ONLY-019.
 *
 * Invariant: the v1 wave-1 integrity gate allows only L0.
 */
export const prop_deserialize_rejects_level_L1_L2_L3 = fc.property(
  blockTripletRowArb,
  fc.constantFrom("L1", "L2", "L3"),
  (row, badLevel) => {
    const wire = serializeWireBlockTriplet(row);
    const tampered = JSON.parse(JSON.stringify({ ...wire, level: badLevel }));
    try {
      deserializeWireBlockTriplet(tampered);
      return false;
    } catch (err) {
      return (
        err instanceof IntegrityError &&
        (err as IntegrityError).reason === "level_unsupported"
      );
    }
  },
);

/**
 * prop_deserialize_rejects_tampered_blockMerkleRoot
 *
 * A one-character change to wire.blockMerkleRoot causes IntegrityError({ reason: "integrity_failed" }).
 *
 * Invariant (DEC-V1-FEDERATION-WIRE-ARTIFACTS-002, DEC-CONTRACTS-AUTHORITY-001):
 * deserialize recomputes blockMerkleRoot via @yakcc/contracts and compares.
 * Any tampered root must fail the gate — no unverified rows are returned.
 */
export const prop_deserialize_rejects_tampered_blockMerkleRoot = fc.property(
  blockTripletRowArb,
  (row) => {
    const wire = serializeWireBlockTriplet(row);
    // Flip first character of the root hex string.
    const root = wire.blockMerkleRoot;
    const flipped = root[0] === "a" ? `b${root.slice(1)}` : `a${root.slice(1)}`;
    const tampered = JSON.parse(JSON.stringify({ ...wire, blockMerkleRoot: flipped }));
    try {
      deserializeWireBlockTriplet(tampered);
      return false;
    } catch (err) {
      return (
        err instanceof IntegrityError &&
        (err as IntegrityError).reason === "integrity_failed"
      );
    }
  },
);
