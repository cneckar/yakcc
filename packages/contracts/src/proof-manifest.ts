// SPDX-License-Identifier: MIT
// @decision DEC-TRIPLET-L0-ONLY-019: The proof/manifest.json schema accepts
// smt_cert / lean_proof / coq_proof artifact kinds at the type level, but the
// L0 manifest validator (validateProofManifestL0) rejects any artifact kind
// other than "property_tests". L1/L2/L3 validators are deferred.
// Status: decided (MASTER_PLAN.md)
// Rationale: v0.6 ships L0 only; the schema must be expressive for future levels
// but the L0 enforcement point is explicit and named so future levels add a new
// validator rather than loosening this one.

// ---------------------------------------------------------------------------
// ProofManifest types
// ---------------------------------------------------------------------------

/**
 * The artifact kinds the proof/manifest.json schema recognizes.
 *
 * - property_tests: a fast-check property-test corpus (required at L0).
 * - smt_cert: an SMT-solver certificate (valid at L2+; schema-valid at L0 but
 *   rejected by validateProofManifestL0).
 * - lean_proof: a Lean proof artifact (valid at L3+; schema-valid at L0 but
 *   rejected by validateProofManifestL0).
 * - coq_proof: a Coq proof artifact (valid at L3+; schema-valid at L0 but
 *   rejected by validateProofManifestL0).
 * - fuzz_bounds_witness: a bounded fuzzing result artifact (valid at L2+;
 *   schema-valid at L0 but rejected by validateProofManifestL0).
 */
export type ArtifactKind =
  | "property_tests"
  | "property_spec"
  | "smt_cert"
  | "lean_proof"
  | "coq_proof"
  | "fuzz_bounds_witness";

/**
 * Generator tag for property_spec artifacts. The PropertySpec schema is
 * language-neutral (DEC-POLYGLOT-PROOF-IR-001); the generator field records
 * which TS emitter (and which downstream Python/Go/Rust emitters) were used
 * to derive the per-language property test files from this spec.
 *
 * Today only `fast-check-v3` is recognized; future emitters can extend this
 * union without changing the schema version.
 */
export type PropertySpecGenerator = "fast-check-v3";

/**
 * Optional per-block status tag for property-spec completeness.
 *
 * - "manual-required": static analysis could not reconstruct a PropertySpec
 *   from the existing tests.fast-check.ts; a human must author proof/properties.json
 * - "auto-generated": the PropertySpec was derived automatically
 *
 * Atoms without a property_spec artifact are valid; this field annotates the
 * GAP rather than enforcing one.
 */
export type ProofSpecStatus = "manual-required" | "auto-generated";

/**
 * One artifact entry in the proof/manifest.json.
 *
 * The path is relative to the proof/ directory. Each artifact kind has a
 * registered checker in the registry's verifier set. The manifest is part of
 * the BlockMerkleRoot, so attestations cover not just the proof bytes but
 * the declaration of what kind of proof it is.
 */
export interface ProofArtifact {
  /** The kind of artifact and which checker to invoke. */
  readonly kind: ArtifactKind;
  /** Path to the artifact file, relative to the proof/ directory. */
  readonly path: string;
  /**
   * For smt_cert artifacts: the SMT theory tags used in this certificate.
   * Optional for other kinds.
   */
  readonly theory?: readonly string[] | undefined;
  /**
   * For lean_proof / coq_proof artifacts: the checker version used.
   * E.g. "lean4@4.7.0". Optional for other kinds.
   */
  readonly checker?: string | undefined;
  /**
   * For property_spec artifacts: which generator/emitter scheme the spec is
   * compatible with. E.g. "fast-check-v3". Optional for other kinds.
   */
  readonly generator?: PropertySpecGenerator | undefined;
}

/**
 * The proof/manifest.json schema.
 *
 * The manifest declares which verification artifacts are present in proof/
 * and which checker each invokes. The order of artifacts in this array is
 * the stable order used when computing proof_root in blockMerkleRoot():
 *   proof_root = BLAKE3(canonicalize(manifest.json) || concat(BLAKE3(artifact_bytes_in_manifest_order)))
 *
 * The manifest itself is included in the Merkle derivation so that changing
 * the manifest (e.g. adding an artifact declaration) changes the block identity,
 * even if no artifact bytes changed.
 */
export interface ProofManifest {
  /**
   * Ordered list of verification artifacts in this block's proof/ directory.
   * The order determines the artifact byte concatenation order in proof_root.
   */
  readonly artifacts: readonly ProofArtifact[];
  /**
   * Optional annotation indicating whether a property_spec artifact is
   * expected for this atom. Atoms without a property_spec are valid; this
   * field signals the gap so future tooling can prioritize backfill.
   * See ProofSpecStatus for allowed values.
   */
  readonly proof_spec_status?: ProofSpecStatus | undefined;
}

// ---------------------------------------------------------------------------
// Validators
// ---------------------------------------------------------------------------

/**
 * Validate and narrow an unknown value to ProofManifest for L0 blocks.
 *
 * L0 validation rules:
 * 1. The value must be a non-null object with an "artifacts" array.
 * 2. The "artifacts" array must contain exactly one entry with kind "property_tests".
 * 3. All other artifact kinds (smt_cert, lean_proof, coq_proof, fuzz_bounds_witness)
 *    are schema-valid at the type level but rejected by this L0-specific validator.
 *    L1+/L2+/L3+ validators are deferred (DEC-TRIPLET-L0-ONLY-019).
 * 4. Each artifact entry must have a non-empty "path" string.
 *
 * Throws a TypeError with a descriptive message on invalid input.
 */
export function validateProofManifestL0(value: unknown): ProofManifest {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("validateProofManifestL0: expected a non-null object");
  }

  const obj = value as Record<string, unknown>;

  if (!("artifacts" in obj) || obj.artifacts === undefined) {
    throw new TypeError('validateProofManifestL0: missing required field "artifacts"');
  }

  if (!Array.isArray(obj.artifacts)) {
    throw new TypeError('validateProofManifestL0: field "artifacts" must be an array');
  }

  const artifacts = obj.artifacts as unknown[];

  if (artifacts.length === 0) {
    throw new TypeError(
      "validateProofManifestL0: L0 manifest must contain at least one artifact; " +
        'expected exactly one "property_tests" entry',
    );
  }

  // Validate each artifact entry and enforce L0 artifact-kind constraint.
  let propertyTestsCount = 0;
  for (let i = 0; i < artifacts.length; i++) {
    const entry = artifacts[i];
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new TypeError(`validateProofManifestL0: artifacts[${i}] must be a non-null object`);
    }

    const artifact = entry as Record<string, unknown>;

    if (!("kind" in artifact) || artifact.kind === undefined) {
      throw new TypeError(`validateProofManifestL0: artifacts[${i}] missing required field "kind"`);
    }

    if (!("path" in artifact) || artifact.path === undefined) {
      throw new TypeError(`validateProofManifestL0: artifacts[${i}] missing required field "path"`);
    }

    if (typeof artifact.path !== "string" || artifact.path.length === 0) {
      throw new TypeError(
        `validateProofManifestL0: artifacts[${i}].path must be a non-empty string`,
      );
    }

    const kind = artifact.kind;

    // L0 enforcement: property_tests is required; property_spec is allowed as
    // an optional sibling (DEC-POLYGLOT-PROOF-IR-001 — single source of truth
    // for cross-language property emission). All other kinds are deferred to
    // L1+/L2+/L3+ validators (DEC-TRIPLET-L0-ONLY-019).
    if (kind === "property_tests") {
      propertyTestsCount++;
    } else if (kind === "property_spec") {
      // Allowed but not counted — property_spec is optional at L0.
    } else {
      throw new TypeError(
        `validateProofManifestL0: artifacts[${i}].kind is "${String(kind)}" — only "property_tests" and "property_spec" are allowed at L0. smt_cert, lean_proof, coq_proof, and fuzz_bounds_witness are schema-valid types but require L2+/L3+ validators (DEC-TRIPLET-L0-ONLY-019).`,
      );
    }
  }

  // L0 requires exactly one property_tests artifact.
  if (propertyTestsCount !== 1) {
    throw new TypeError(
      `validateProofManifestL0: L0 manifest must declare exactly one "property_tests" artifact; found ${propertyTestsCount}`,
    );
  }

  return obj as unknown as ProofManifest;
}
