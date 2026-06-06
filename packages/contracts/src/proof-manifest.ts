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

// ---------------------------------------------------------------------------
// L3 validator
// ---------------------------------------------------------------------------

// @decision DEC-PROOF-L3-VALIDATOR-001
// Title: L3 manifest validator — parallel function, not L0 relaxation
// Status: decided (closes #1080, Slice A of plans/proof-incentive-layer.md)
// Rationale:
//   DEC-TRIPLET-L0-ONLY-019 gates validateProofManifestL0 to property_tests /
//   property_spec only and explicitly defers L3 validators. This function is
//   that deferred L3 path: a standalone validator for manifests carrying
//   lean_proof / coq_proof artifacts. The L0 path is unchanged and continues
//   to enforce its own rules. L3 is a *parallel* validator, not a fork or
//   relaxation.
//
//   Accepted artifact kinds at L3:
//   - lean_proof  (required: checker field, e.g. "lean4@4.7.0")
//   - coq_proof   (required: checker field, e.g. "coq@8.20")
//   - property_tests / property_spec — L0 artifacts are allowed to coexist
//     with L3 artifacts in the same manifest (mixed L0+L3 is valid). The
//     manifest may carry the property-test evidence alongside the formal proof.
//
//   Rejected artifact kinds at L3 (deferred to their own validators):
//   - smt_cert (L2)
//   - fuzz_bounds_witness (L2)
//
//   On formal_spec: we do NOT add a new formal_spec ArtifactKind in this
//   slice. The L3 spec lemma lives inside (or alongside) the proof artifact
//   file and is referenced from within the Lean/Coq proof source. Adding
//   formal_spec as a separate kind would grow the enum without a concrete
//   consumer. If a separate formal_spec artifact is needed (e.g., for Merkle-
//   root coverage of the spec lemma independently of the proof), a future
//   slice can add it. The DEC annotation there must forward-reference this one.

/**
 * The set of artifact kinds that an L3 manifest may declare.
 *
 * lean_proof and coq_proof are the L3-specific kinds (require checker).
 * property_tests and property_spec may coexist with L3 artifacts.
 * smt_cert and fuzz_bounds_witness are L2 kinds and are explicitly rejected
 * here; their validators are separately deferred.
 */
const L3_ALLOWED_KINDS = new Set<ArtifactKind>(["lean_proof", "coq_proof", "property_tests", "property_spec"]);

/**
 * The L3-specific artifact kinds that require the `checker` field.
 */
const L3_FORMAL_KINDS = new Set<ArtifactKind>(["lean_proof", "coq_proof"]);

/**
 * The artifact kinds that belong to L1/L2 and must not appear in an L3 manifest.
 * Having these signals a mixed-tier manifest that this validator rejects cleanly.
 */
const L2_DEFERRED_KINDS = new Set<ArtifactKind>(["smt_cert", "fuzz_bounds_witness"]);

/**
 * Validate a path field for an L3 artifact.
 *
 * Rules:
 * - must be a non-empty string
 * - must be relative (must not start with "/")
 * - must not contain ".." traversal segments
 * - must start with "proof/" or be inside "proof/" when treated as relative
 *   to the block root. Paths that are bare filenames without a directory
 *   component are also accepted, as they resolve under proof/ by convention
 *   (the manifest itself lives in proof/).
 *
 * Returns undefined on success; a descriptive error string on failure.
 */
function validateL3ArtifactPath(path: string): string | undefined {
  if (path.length === 0) {
    return "path must be a non-empty string";
  }
  if (path.startsWith("/")) {
    return `path "${path}" must be relative (must not start with "/")`;
  }
  // Reject any path segment that is ".." — catches "../../etc/passwd" and "proof/../etc".
  const segments = path.split("/");
  if (segments.some((seg) => seg === "..")) {
    return `path "${path}" contains ".." traversal`;
  }
  // Paths must resolve under proof/. The manifest lives in proof/, so a bare
  // filename like "refinement.lean" is fine. Paths with a directory prefix
  // must start with "proof/".
  if (segments.length > 1 && !path.startsWith("proof/")) {
    return `path "${path}" must resolve under proof/ (either a bare filename or start with "proof/")`;
  }
  return undefined;
}

/**
 * Validate and narrow an unknown value to ProofManifest for L3 blocks.
 *
 * L3 validation rules:
 * 1. The value must be a non-null object with an "artifacts" array.
 * 2. The manifest must contain at least one L3 artifact (lean_proof or coq_proof).
 * 3. Every lean_proof / coq_proof artifact MUST have a non-empty "checker" field.
 * 4. Every artifact path must be non-empty, relative, contain no ".." traversal,
 *    and resolve under the proof/ directory.
 * 5. L2 artifact kinds (smt_cert, fuzz_bounds_witness) are explicitly rejected;
 *    their validators are deferred (DEC-TRIPLET-L0-ONLY-019).
 * 6. L0 artifact kinds (property_tests, property_spec) are allowed alongside
 *    L3 artifacts — mixed L0+L3 manifests are valid.
 *
 * Cross-reference: DEC-PROOF-L3-VALIDATOR-001, DEC-TRIPLET-L0-ONLY-019
 *
 * Throws a TypeError with a descriptive message on invalid input.
 */
export function validateProofManifestL3(value: unknown): ProofManifest {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("validateProofManifestL3: expected a non-null object");
  }

  const obj = value as Record<string, unknown>;

  if (!("artifacts" in obj) || obj.artifacts === undefined) {
    throw new TypeError('validateProofManifestL3: missing required field "artifacts"');
  }

  if (!Array.isArray(obj.artifacts)) {
    throw new TypeError('validateProofManifestL3: field "artifacts" must be an array');
  }

  const artifacts = obj.artifacts as unknown[];

  if (artifacts.length === 0) {
    throw new TypeError(
      "validateProofManifestL3: manifest must contain at least one artifact",
    );
  }

  let formalCount = 0;

  for (let i = 0; i < artifacts.length; i++) {
    const entry = artifacts[i];
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new TypeError(`validateProofManifestL3: artifacts[${i}] must be a non-null object`);
    }

    const artifact = entry as Record<string, unknown>;

    if (!("kind" in artifact) || artifact.kind === undefined) {
      throw new TypeError(`validateProofManifestL3: artifacts[${i}] missing required field "kind"`);
    }

    if (!("path" in artifact) || artifact.path === undefined) {
      throw new TypeError(`validateProofManifestL3: artifacts[${i}] missing required field "path"`);
    }

    if (typeof artifact.path !== "string") {
      throw new TypeError(`validateProofManifestL3: artifacts[${i}].path must be a string`);
    }

    const kind = artifact.kind as string;

    // Explicit rejection of L2-tier kinds: they belong to deferred validators.
    if (L2_DEFERRED_KINDS.has(kind as ArtifactKind)) {
      throw new TypeError(
        `validateProofManifestL3: artifacts[${i}].kind is "${kind}" — smt_cert and fuzz_bounds_witness are L2 kinds; use the L2 validator (deferred, DEC-TRIPLET-L0-ONLY-019). L3 manifests may only contain lean_proof, coq_proof, property_tests, or property_spec.`,
      );
    }

    // Reject any unknown kind not in the L3 allowed set.
    if (!L3_ALLOWED_KINDS.has(kind as ArtifactKind)) {
      throw new TypeError(
        `validateProofManifestL3: artifacts[${i}].kind is "${kind}" — unrecognized artifact kind`,
      );
    }

    // Validate path for all artifacts.
    const pathErr = validateL3ArtifactPath(artifact.path);
    if (pathErr !== undefined) {
      throw new TypeError(`validateProofManifestL3: artifacts[${i}].path: ${pathErr}`);
    }

    // L3 formal kinds require the checker field.
    if (L3_FORMAL_KINDS.has(kind as ArtifactKind)) {
      formalCount++;
      if (!("checker" in artifact) || artifact.checker === undefined) {
        throw new TypeError(
          `validateProofManifestL3: artifacts[${i}] (kind="${kind}") is missing the required "checker" field (e.g. "lean4@4.7.0" or "coq@8.20"). The checker version is part of the attestation identity — DEC-PROOF-L3-VALIDATOR-001.`,
        );
      }
      if (typeof artifact.checker !== "string" || artifact.checker.length === 0) {
        throw new TypeError(
          `validateProofManifestL3: artifacts[${i}].checker must be a non-empty string`,
        );
      }
    }
  }

  // The manifest must contain at least one L3 formal artifact.
  if (formalCount === 0) {
    throw new TypeError(
      "validateProofManifestL3: manifest must contain at least one lean_proof or coq_proof artifact",
    );
  }

  return obj as unknown as ProofManifest;
}
