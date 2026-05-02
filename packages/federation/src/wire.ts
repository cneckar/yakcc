// SPDX-License-Identifier: MIT
// @decision DEC-WIRE-FORMAT-020: Wire serialization/deserialization for BlockTripletRow.
// Status: decided (WI-020 Dispatch B, FEDERATION_PROTOCOL.md §4)
// Title: Wire format — serialize/deserialize + integrity gate
// Rationale:
//   The v1 wire shape is a direct JSON projection of BlockTripletRow with binary
//   fields base64-encoded (FEDERATION_PROTOCOL.md §4). Deserialization performs ALL
//   integrity checks before returning — no "best-effort" deserialization.
//   Integrity checks:
//     1. Structural shape validation
//     2. base64 decode of specCanonicalBytes → Uint8Array
//     3. base64 decode of each artifactBytes entry → Map<string, Uint8Array>
//     4. level === 'L0' enforced (DEC-TRIPLET-L0-ONLY-019)
//     5. validateProofManifestL0(JSON.parse(proofManifestJson)) (DEC-TRIPLET-L0-ONLY-019)
//     6. artifactBytes key set matches manifest artifact paths (no extras, no missing)
//     7. Recompute specHash(specCanonicalBytes) → compare (FEDERATION_PROTOCOL.md §4)
//     8. Recompute blockMerkleRoot({spec, implSource, manifest, artifacts}) via
//        @yakcc/contracts → compare (FEDERATION_PROTOCOL.md §4)
//        This is the v2 fix: artifact bytes fold into the proof root.
//
// @decision DEC-V1-FEDERATION-WIRE-ARTIFACTS-002: artifactBytes is REQUIRED on the wire.
// The integrity check calls @yakcc/contracts blockMerkleRoot() directly — NO local
// merkle helper inside @yakcc/federation. The receiver decodes artifactBytes,
// reconstructs Map<string, Uint8Array> in manifest declaration order, and passes it
// to blockMerkleRoot(). Any wire that omits artifactBytes will produce a different
// hash than the persisted BlockMerkleRoot and fail the integrity gate.
// Status: decided (MASTER_PLAN.md DEC-V1-FEDERATION-WIRE-ARTIFACTS-002)
//
// @decision DEC-NO-OWNERSHIP-011: No ownership fields on the wire.
// Status: decided (MASTER_PLAN.md DEC-NO-OWNERSHIP-011)
// Rationale: The wire shape is derived from BlockTripletRow which has no ownership
// columns by schema design. Test enumerates wire keys and asserts disjoint from
// ownership field set.
//
// @decision DEC-TRIPLET-L0-ONLY-019: level === 'L0' enforced at deserialization.
// Status: decided (MASTER_PLAN.md DEC-TRIPLET-L0-ONLY-019)
// Rationale: v1 wave-1 ships L0 only. Any L1/L2/L3 block is rejected with
// IntegrityError({ reason: 'level_unsupported' }).
//
// @decision DEC-CONTRACTS-AUTHORITY-001: @yakcc/contracts is the single authority for
// the block identity formula. All callers — registry, federation wire, tests — must
// call blockMerkleRoot() from @yakcc/contracts rather than re-implementing the formula.
// Status: decided (MASTER_PLAN.md DEC-CONTRACTS-AUTHORITY-001)

import { blockMerkleRoot, specHash, validateProofManifestL0 } from "@yakcc/contracts";
import type {
  BlockMerkleRoot,
  CanonicalAstHash,
  ProofManifest,
  SpecHash,
  SpecYak,
} from "@yakcc/contracts";
import type { BlockTripletRow } from "@yakcc/registry";
import { IntegrityError } from "./types.js";
import type { WireBlockTriplet } from "./types.js";

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

/**
 * Serialize a BlockTripletRow to the v1 wire shape (WireBlockTriplet).
 *
 * Pure projection:
 *   - base64-encodes specCanonicalBytes
 *   - base64-encodes each entry in the artifacts Map → artifactBytes Record
 *     (keys are manifest-declared paths; values are base64(bytes))
 *   - all other fields pass through verbatim
 *   - parentBlockRoot null/undefined → null
 *
 * Does NOT recompute or validate blockMerkleRoot — the row is taken as trusted
 * local state. Integrity verification happens at deserialization (the receiver's
 * responsibility per FEDERATION_PROTOCOL.md §4).
 *
 * Artifact key order: follows Map iteration order, which matches the order
 * entries were inserted into the Map. Callers building rows from
 * blockMerkleRoot() ensure Map keys match manifest declaration order.
 *
 * No ownership fields in the output — DEC-NO-OWNERSHIP-011.
 */
export function serializeWireBlockTriplet(row: BlockTripletRow): WireBlockTriplet {
  // Encode each artifact: Map<string, Uint8Array> → Record<string, string (base64)>
  const artifactBytes: Record<string, string> = {};
  for (const [path, bytes] of row.artifacts) {
    artifactBytes[path] = Buffer.from(bytes).toString("base64");
  }

  return {
    blockMerkleRoot: row.blockMerkleRoot,
    specHash: row.specHash,
    specCanonicalBytes: Buffer.from(row.specCanonicalBytes).toString("base64"),
    implSource: row.implSource,
    proofManifestJson: row.proofManifestJson,
    artifactBytes,
    level: row.level,
    createdAt: row.createdAt,
    canonicalAstHash: row.canonicalAstHash,
    parentBlockRoot: row.parentBlockRoot ?? null,
  };
}

// ---------------------------------------------------------------------------
// Deserialization + integrity gate
// ---------------------------------------------------------------------------

/**
 * Deserialize and integrity-check a WireBlockTriplet, returning a BlockTripletRow.
 *
 * ALL integrity checks run before returning. A partial-but-corrupt triplet is
 * never returned; callers either get a fully-validated row or an IntegrityError.
 *
 * Checks performed (in order):
 *   1. Structural shape validation — rejects non-objects, missing or wrong-typed fields.
 *      artifactBytes must be a non-null plain object (Record<string, string>).
 *   2. base64 decode of specCanonicalBytes → Uint8Array.
 *   3. base64 decode of each artifactBytes value → Map<string, Uint8Array>.
 *   4. level === 'L0' — else IntegrityError({ reason: 'level_unsupported' })
 *      per DEC-TRIPLET-L0-ONLY-019.
 *   5. validateProofManifestL0(JSON.parse(proofManifestJson)) — else
 *      IntegrityError({ reason: 'manifest_invalid' }).
 *   6. artifactBytes key set == manifest.artifacts[*].path set (no extras, no missing)
 *      — else IntegrityError({ reason: 'manifest_invalid' }) (artifact_key_mismatch sub-reason).
 *   7. Parse specCanonicalBytes as JSON → SpecYak, call specHash(parsedSpec) via
 *      @yakcc/contracts and compare to wire.specHash
 *      — else IntegrityError({ reason: 'integrity_failed' }).
 *   8. Recompute blockMerkleRoot({spec, implSource, manifest, artifacts}) via @yakcc/contracts
 *      with the reconstructed artifacts Map (in manifest declaration order) and compare to
 *      wire.blockMerkleRoot — else IntegrityError({ reason: 'integrity_failed' }).
 *      DEC-V1-FEDERATION-WIRE-ARTIFACTS-002, DEC-CONTRACTS-AUTHORITY-001.
 *
 * Reconstructed artifacts Map: keys inserted in manifest declaration order (the order
 * that blockMerkleRoot() iterates to build proof_root).
 *
 * The returned BlockTripletRow uses Date.now() as createdAt only if the wire's
 * createdAt is <= 0 (the sentinel value). Otherwise the wire's createdAt is
 * preserved for round-trip fidelity.
 *
 * @throws IntegrityError for any integrity or validation failure.
 * @throws TypeError for structural shape violations.
 */
export function deserializeWireBlockTriplet(value: unknown): BlockTripletRow {
  // ---------------------------------------------------------------------------
  // Step 1: Structural shape validation
  // ---------------------------------------------------------------------------
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("deserializeWireBlockTriplet: expected a non-null JSON object");
  }

  const w = value as Record<string, unknown>;

  // Required non-empty string fields
  const stringFields = [
    "blockMerkleRoot",
    "specHash",
    "specCanonicalBytes",
    "implSource",
    "proofManifestJson",
    "level",
    "canonicalAstHash",
  ] as const;

  for (const field of stringFields) {
    if (typeof w[field] !== "string" || (w[field] as string).length === 0) {
      throw new TypeError(
        `deserializeWireBlockTriplet: field "${field}" must be a non-empty string; got ${typeof w[field]}`,
      );
    }
  }

  // createdAt: number
  if (typeof w.createdAt !== "number") {
    throw new TypeError(
      `deserializeWireBlockTriplet: field "createdAt" must be a number; got ${typeof w.createdAt}`,
    );
  }

  // parentBlockRoot: string | null (null is allowed; undefined is not)
  if (w.parentBlockRoot !== null && typeof w.parentBlockRoot !== "string") {
    throw new TypeError(
      `deserializeWireBlockTriplet: field "parentBlockRoot" must be a string or null; got ${typeof w.parentBlockRoot}`,
    );
  }

  // artifactBytes: non-null plain object (not array)
  if (
    w.artifactBytes === null ||
    w.artifactBytes === undefined ||
    typeof w.artifactBytes !== "object" ||
    Array.isArray(w.artifactBytes)
  ) {
    throw new TypeError(
      `deserializeWireBlockTriplet: field "artifactBytes" must be a non-null plain object; got ${w.artifactBytes === null ? "null" : typeof w.artifactBytes}`,
    );
  }

  const wireBlockMerkleRoot = w.blockMerkleRoot as string;
  const wireSpecHash = w.specHash as string;
  const wireSpecCanonicalBytesB64 = w.specCanonicalBytes as string;
  const wireImplSource = w.implSource as string;
  const wireProofManifestJson = w.proofManifestJson as string;
  const wireLevel = w.level as string;
  const wireCreatedAt = w.createdAt as number;
  const wireCanonicalAstHash = w.canonicalAstHash as string;
  const wireParentBlockRoot = w.parentBlockRoot as string | null;
  const wireArtifactBytes = w.artifactBytes as Record<string, unknown>;

  // Validate level is a known value before the L0 check (better error for unknown vs. unsupported).
  const KNOWN_LEVELS = new Set(["L0", "L1", "L2", "L3"]);
  if (!KNOWN_LEVELS.has(wireLevel)) {
    throw new IntegrityError({
      reason: "level_unsupported",
      message: `deserializeWireBlockTriplet: unknown level "${wireLevel}"; expected one of "L0","L1","L2","L3"`,
    });
  }

  // Validate each artifactBytes value is a non-empty string (valid base64)
  for (const [path, b64val] of Object.entries(wireArtifactBytes)) {
    if (typeof b64val !== "string") {
      throw new TypeError(
        `deserializeWireBlockTriplet: artifactBytes["${path}"] must be a base64 string; got ${typeof b64val}`,
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Step 2: base64 decode of specCanonicalBytes
  // ---------------------------------------------------------------------------
  let specCanonicalBytes: Uint8Array;
  try {
    const buf = Buffer.from(wireSpecCanonicalBytesB64, "base64");
    if (buf.length === 0) {
      throw new RangeError("decoded to zero bytes");
    }
    specCanonicalBytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  } catch (err) {
    throw new TypeError(
      `deserializeWireBlockTriplet: specCanonicalBytes is not valid base64: ${String(err)}`,
    );
  }

  // ---------------------------------------------------------------------------
  // Step 3: base64 decode of each artifactBytes value
  // ---------------------------------------------------------------------------
  // Decoded into a staging Map keyed by path — order of manifest declaration
  // is not yet enforced here; that comes in step 6 after manifest parsing.
  const artifactBytesDecoded = new Map<string, Uint8Array>();
  for (const [path, b64val] of Object.entries(wireArtifactBytes)) {
    try {
      const buf = Buffer.from(b64val as string, "base64");
      artifactBytesDecoded.set(path, new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
    } catch (err) {
      throw new TypeError(
        `deserializeWireBlockTriplet: artifactBytes["${path}"] is not valid base64: ${String(err)}`,
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Step 4: level === 'L0' check (DEC-TRIPLET-L0-ONLY-019)
  // ---------------------------------------------------------------------------
  if (wireLevel !== "L0") {
    throw new IntegrityError({
      reason: "level_unsupported",
      message: `deserializeWireBlockTriplet: level "${wireLevel}" is not supported in v1 wave-1 (only "L0" is accepted, per DEC-TRIPLET-L0-ONLY-019)`,
    });
  }

  // ---------------------------------------------------------------------------
  // Step 5: validateProofManifestL0
  // ---------------------------------------------------------------------------
  let proofManifest: ProofManifest;
  try {
    const parsed = JSON.parse(wireProofManifestJson) as unknown;
    proofManifest = validateProofManifestL0(parsed);
  } catch (err) {
    // Re-throw IntegrityError as-is (from validateProofManifestL0 wrapped below),
    // but JSON.parse SyntaxError → IntegrityError(manifest_invalid).
    if (err instanceof SyntaxError) {
      throw new IntegrityError({
        reason: "manifest_invalid",
        message: `deserializeWireBlockTriplet: proofManifestJson is not valid JSON: ${String(err)}`,
      });
    }
    throw new IntegrityError({
      reason: "manifest_invalid",
      message: `deserializeWireBlockTriplet: proofManifestJson failed L0 validation: ${String(err)}`,
    });
  }

  // ---------------------------------------------------------------------------
  // Step 6: artifactBytes key set == manifest artifact paths
  // ---------------------------------------------------------------------------
  // The manifest declares the artifact paths in declaration order. The wire's
  // artifactBytes must contain exactly those keys — no extras, no missing.
  const manifestPaths = proofManifest.artifacts.map((a) => a.path);
  const wireArtifactPaths = new Set(Object.keys(wireArtifactBytes));
  const manifestPathSet = new Set(manifestPaths);

  const missingFromWire = manifestPaths.filter((p) => !wireArtifactPaths.has(p));
  const extraInWire = [...wireArtifactPaths].filter((p) => !manifestPathSet.has(p));

  if (missingFromWire.length > 0 || extraInWire.length > 0) {
    throw new IntegrityError({
      reason: "manifest_invalid",
      message: `deserializeWireBlockTriplet: artifactBytes key mismatch — missing: [${missingFromWire.join(", ")}], extra: [${extraInWire.join(", ")}]`,
    });
  }

  // Reconstruct artifacts Map in manifest declaration order (required by blockMerkleRoot()).
  // The key set equality check above guarantees every manifestPaths entry is present in
  // artifactBytesDecoded; the fallback to new Uint8Array(0) is unreachable dead code that
  // satisfies the type checker without a forbidden non-null assertion.
  const artifacts = new Map<string, Uint8Array>();
  for (const path of manifestPaths) {
    artifacts.set(path, artifactBytesDecoded.get(path) ?? new Uint8Array(0));
  }

  // ---------------------------------------------------------------------------
  // Steps 7 + 8: Parse specCanonicalBytes once, then recompute both specHash
  // and blockMerkleRoot via @yakcc/contracts and compare.
  //
  // DEC-CONTRACTS-AUTHORITY-001: @yakcc/contracts is the single authority for
  // the block identity formula. NO direct blake3 calls in wire.ts.
  //
  // DEC-V1-FEDERATION-WIRE-ARTIFACTS-002: blockMerkleRoot() is called with the
  // reconstructed artifacts Map so artifact bytes fold into proof_root. Any
  // single-byte mutation in an artifact will produce a different root.
  //
  // The `spec` parameter expected by specHash() and blockMerkleRoot() is SpecYak.
  // We have pre-canonicalized bytes on the wire, so we parse them as JSON to
  // recover the SpecYak object. blockMerkleRoot() internally calls canonicalize(spec)
  // again — the round-trip invariant guarantees the result matches the original
  // bytes when they were produced by canonicalize(spec.yak).
  // ---------------------------------------------------------------------------
  let parsedSpec: SpecYak;
  let computedBlockMerkleRoot: BlockMerkleRoot;
  try {
    const specJsonText = new TextDecoder().decode(specCanonicalBytes);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    parsedSpec = JSON.parse(specJsonText) as unknown as SpecYak;
  } catch (err) {
    throw new IntegrityError({
      reason: "integrity_failed",
      message: `deserializeWireBlockTriplet: specCanonicalBytes is not valid JSON: ${String(err)}`,
    });
  }

  // Step 7: recompute specHash via @yakcc/contracts and compare.
  const computedSpecHash = specHash(parsedSpec);
  if (computedSpecHash !== wireSpecHash) {
    throw new IntegrityError({
      reason: "integrity_failed",
      message: `deserializeWireBlockTriplet: specHash mismatch — wire has "${wireSpecHash}", computed "${computedSpecHash}"`,
    });
  }

  // Step 8: recompute blockMerkleRoot via @yakcc/contracts and compare.
  try {
    computedBlockMerkleRoot = blockMerkleRoot({
      spec: parsedSpec,
      implSource: wireImplSource,
      manifest: proofManifest,
      artifacts,
    });
  } catch (err) {
    // blockMerkleRoot() throws if an artifact declared in the manifest is
    // missing from the artifacts Map — should not happen after step 6, but
    // treated as integrity_failed defensively.
    if (err instanceof IntegrityError) {
      throw err;
    }
    throw new IntegrityError({
      reason: "integrity_failed",
      message: `deserializeWireBlockTriplet: blockMerkleRoot recomputation failed: ${String(err)}`,
    });
  }

  if (computedBlockMerkleRoot !== wireBlockMerkleRoot) {
    throw new IntegrityError({
      reason: "integrity_failed",
      message: `deserializeWireBlockTriplet: blockMerkleRoot mismatch — wire has "${wireBlockMerkleRoot}", computed "${computedBlockMerkleRoot}"`,
    });
  }

  // ---------------------------------------------------------------------------
  // All checks passed — return the validated BlockTripletRow
  // ---------------------------------------------------------------------------
  return {
    blockMerkleRoot: wireBlockMerkleRoot as BlockMerkleRoot,
    specHash: wireSpecHash as SpecHash,
    specCanonicalBytes,
    implSource: wireImplSource,
    proofManifestJson: wireProofManifestJson,
    level: wireLevel as "L0",
    createdAt: wireCreatedAt > 0 ? wireCreatedAt : Date.now(),
    canonicalAstHash: wireCanonicalAstHash as CanonicalAstHash,
    parentBlockRoot: wireParentBlockRoot as BlockMerkleRoot | null,
    artifacts,
  };
}
