// @decision DEC-ATOM-PERSIST-001
// title: buildTriplet computes the full block identity for a novel atom at L0
// status: decided
// rationale:
//   - specFromIntent produces the SpecYak; specHash() derives its content address.
//   - impl is the raw source text (AtomLeaf.source). No normalization at L0 per
//     DEC-TRIPLET-IDENTITY-020: file bytes are the identity unit at L0; AST
//     normalization is deferred to L1+ where the totality pass normalizes anyway.
//   - ProofManifest at L0 bootstrap: a single "property_tests" artifact with a
//     placeholder path ("property-tests.ts") and empty bytes is emitted. This
//     satisfies the L0 manifest validator (validateProofManifestL0 requires
//     exactly one "property_tests" artifact). The artifact bytes map carries an
//     empty Uint8Array for that path. The property-test corpus is WI-013-03.
//   - blockMerkleRoot() from @yakcc/contracts is the canonical identity derivation.
//     We do not re-implement the Merkle logic here.

import {
  blockMerkleRoot,
  canonicalize,
  specHash as deriveSpecHash,
  validateSpecYak,
} from "@yakcc/contracts";
import type { BlockMerkleRoot, ProofManifest, SpecHash, SpecYak } from "@yakcc/contracts";
import type { CanonicalAstHash } from "@yakcc/contracts";
import type { IntentCard } from "../intent/types.js";
import { specFromIntent } from "./spec-from-intent.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * The full block triplet computed for a novel atom.
 *
 * This is an intermediate value: callers feed it into a BlockTripletRow for
 * registry storage. It is not the same as @yakcc/contracts BlockTriplet —
 * that type carries an `artifacts` Map required by blockMerkleRoot(); this
 * type carries the pre-computed `merkleRoot` so callers don't need to
 * manage the artifacts Map again.
 */
export interface BuiltTriplet {
  readonly spec: SpecYak;
  readonly specHash: SpecHash;
  readonly specCanonicalBytes: Uint8Array;
  readonly impl: string;
  readonly manifest: ProofManifest;
  readonly merkleRoot: BlockMerkleRoot;
}

// ---------------------------------------------------------------------------
// Bootstrap L0 manifest constant
// ---------------------------------------------------------------------------

/**
 * The placeholder path for the L0 property-test artifact.
 *
 * At L0 bootstrap the corpus is empty. We declare one artifact entry so that:
 *   1. validateProofManifestL0 is satisfied (requires exactly one
 *      "property_tests" artifact with a non-empty path).
 *   2. blockMerkleRoot() can compute proof_root (it needs the artifact bytes
 *      for each declared artifact; we supply empty bytes).
 *
 * The property-test corpus is populated by WI-013-03.
 */
const L0_PROPERTY_TESTS_PATH = "property-tests.ts";

/** Empty bytes for the bootstrap property-test artifact. */
const EMPTY_BYTES = new Uint8Array(0);

/**
 * The L0 bootstrap ProofManifest.
 *
 * Declares one "property_tests" artifact at the placeholder path.
 * validateProofManifestL0 accepts this as a valid L0 manifest.
 * The artifact bytes map must carry `L0_PROPERTY_TESTS_PATH → EMPTY_BYTES`.
 */
const L0_BOOTSTRAP_MANIFEST: ProofManifest = {
  artifacts: [
    {
      kind: "property_tests",
      path: L0_PROPERTY_TESTS_PATH,
    },
  ],
} as const;

/** Artifact bytes map for the L0 bootstrap manifest. */
function makeBootstrapArtifacts(): Map<string, Uint8Array> {
  return new Map([[L0_PROPERTY_TESTS_PATH, EMPTY_BYTES]]);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build a BuiltTriplet for a novel atom.
 *
 * Steps:
 *   1. Derive SpecYak from the intent card via specFromIntent().
 *   2. Compute specHash = BLAKE3(canonicalize(spec)).
 *   3. impl is the raw source text.
 *   4. Build L0 bootstrap ProofManifest (one "property_tests" artifact,
 *      empty bytes). WI-013-03 populates the real corpus.
 *   5. Compute merkleRoot via blockMerkleRoot() from @yakcc/contracts.
 *
 * Throws TypeError if specFromIntent produces an invalid spec (validateSpecYak
 * is called inside specFromIntent).
 *
 * @param intentCard       - The extracted intent card for this atom.
 * @param source           - The raw source text of the atom (AtomLeaf.source).
 * @param canonicalAstHash - The canonical AST hash of the atom source.
 *                           Used for specName uniqueness and stored on the row.
 */
export function buildTriplet(
  intentCard: IntentCard,
  source: string,
  canonicalAstHash: CanonicalAstHash,
): BuiltTriplet {
  // Step 1: derive SpecYak from the intent card.
  const spec = specFromIntent(intentCard, canonicalAstHash);

  // Paranoia: validate again (specFromIntent already calls validateSpecYak, but
  // TypeScript loses the narrowing through the return type and re-validation here
  // is a zero-cost safety net).
  validateSpecYak(spec);

  // Step 2: compute spec hash and canonical bytes.
  const specCanonicalBytes = canonicalize(spec as unknown as Parameters<typeof canonicalize>[0]);
  const specHashValue = deriveSpecHash(spec);

  // Step 3: impl is the raw source text.
  const impl = source;

  // Step 4: build L0 bootstrap ProofManifest.
  const manifest = L0_BOOTSTRAP_MANIFEST;
  const artifacts = makeBootstrapArtifacts();

  // Step 5: compute BlockMerkleRoot via the canonical derivation in @yakcc/contracts.
  const merkleRoot = blockMerkleRoot({
    spec,
    implSource: impl,
    manifest,
    artifacts,
  });

  return {
    spec,
    specHash: specHashValue,
    specCanonicalBytes,
    impl,
    manifest,
    merkleRoot,
  };
}
