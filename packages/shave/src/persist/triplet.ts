// @decision DEC-ATOM-PERSIST-001
// title: buildTriplet computes the full block identity for a novel atom at L0
// status: decided
// rationale:
//   - specFromIntent produces the SpecYak; specHash() derives its content address.
//   - impl is the raw source text (AtomLeaf.source). No normalization at L0 per
//     DEC-TRIPLET-IDENTITY-020: file bytes are the identity unit at L0; AST
//     normalization is deferred to L1+ where the totality pass normalizes anyway.
//   - ProofManifest at L0: a single "property_tests" artifact is populated from
//     the CorpusResult produced by extractCorpus() (WI-016). The artifact bytes
//     map carries the corpus bytes at the corpus path.
//   - Bootstrap fallback: when `options.bootstrap === true`, an empty-bytes
//     placeholder manifest is emitted instead of requiring a CorpusResult. This
//     is an explicit opt-in; the DEFAULT path requires a populated CorpusResult.
//     "WI-016 retirement of L0_BOOTSTRAP_MANIFEST as the silent default."
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
import type { CorpusResult } from "../corpus/types.js";
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

/**
 * Options for buildTriplet().
 */
export interface BuildTripletOptions {
  /**
   * When true, emit an empty-bytes placeholder manifest instead of requiring
   * a CorpusResult. This is an explicit opt-in for the bootstrap/migration path.
   *
   * DEFAULT is false — the normal production path requires a populated CorpusResult
   * via the `corpusResult` parameter.
   *
   * @decision DEC-ATOM-PERSIST-001 (WI-016): L0_BOOTSTRAP_MANIFEST is no longer the
   * silent default. Callers that still need the bootstrap path must pass bootstrap=true
   * explicitly. New callers should always provide a CorpusResult via extractCorpus().
   */
  readonly bootstrap?: boolean | undefined;
}

// ---------------------------------------------------------------------------
// Bootstrap L0 manifest constant (explicit opt-in only after WI-016)
// ---------------------------------------------------------------------------

/**
 * The placeholder path for the L0 bootstrap property-test artifact.
 *
 * Only used when `options.bootstrap === true`. The bootstrap path is an
 * explicit opt-in after WI-016; the default production path uses a populated
 * CorpusResult from extractCorpus().
 */
const L0_BOOTSTRAP_PATH = "property-tests.ts";

/** Empty bytes for the bootstrap property-test artifact. */
const EMPTY_BYTES = new Uint8Array(0);

/**
 * The L0 bootstrap ProofManifest (explicit opt-in only).
 *
 * Declared as a named export so tests can verify bootstrap manifests without
 * re-implementing the shape. Do NOT use as the default in production code.
 */
export const L0_BOOTSTRAP_MANIFEST: ProofManifest = {
  artifacts: [
    {
      kind: "property_tests",
      path: L0_BOOTSTRAP_PATH,
    },
  ],
} as const;

/** Artifact bytes map for the L0 bootstrap manifest. */
function makeBootstrapArtifacts(): Map<string, Uint8Array> {
  return new Map([[L0_BOOTSTRAP_PATH, EMPTY_BYTES]]);
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
 *   4. Build ProofManifest from the CorpusResult (WI-016) OR the bootstrap
 *      placeholder if `options.bootstrap === true`.
 *   5. Compute merkleRoot via blockMerkleRoot() from @yakcc/contracts.
 *
 * Throws TypeError if specFromIntent produces an invalid spec (validateSpecYak
 * is called inside specFromIntent).
 *
 * Throws Error if `corpusResult` is undefined and `options.bootstrap` is not
 * explicitly true — the caller must provide a CorpusResult or opt into bootstrap.
 *
 * @param intentCard       - The extracted intent card for this atom.
 * @param source           - The raw source text of the atom (AtomLeaf.source).
 * @param canonicalAstHash - The canonical AST hash of the atom source.
 *                           Used for specName uniqueness and stored on the row.
 * @param corpusResult     - The corpus extraction result (from extractCorpus()).
 *                           Required unless options.bootstrap === true.
 * @param options          - Optional configuration. Set bootstrap=true for the
 *                           empty-placeholder path (explicit opt-in only).
 */
export function buildTriplet(
  intentCard: IntentCard,
  source: string,
  canonicalAstHash: CanonicalAstHash,
  corpusResult?: CorpusResult | undefined,
  options?: BuildTripletOptions | undefined,
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

  // Step 4: build ProofManifest from CorpusResult or bootstrap placeholder.
  //
  // @decision DEC-ATOM-PERSIST-001 (WI-016):
  //   The default path requires a populated CorpusResult from extractCorpus().
  //   The bootstrap path (options.bootstrap === true) is an explicit opt-in.
  //   Passing neither throws — no silent fallback to empty bytes.
  let manifest: ProofManifest;
  let artifacts: Map<string, Uint8Array>;

  if (corpusResult !== undefined) {
    // Normal production path: use the extracted corpus.
    manifest = {
      artifacts: [
        {
          kind: "property_tests",
          path: corpusResult.path,
        },
      ],
    };
    artifacts = new Map([[corpusResult.path, corpusResult.bytes]]);
  } else if (options?.bootstrap === true) {
    // Explicit bootstrap opt-in: emit placeholder manifest with empty bytes.
    manifest = L0_BOOTSTRAP_MANIFEST;
    artifacts = makeBootstrapArtifacts();
  } else {
    throw new Error(
      "buildTriplet: corpusResult is required unless options.bootstrap === true. " +
        "Call extractCorpus() to produce a CorpusResult, or pass options.bootstrap=true " +
        "explicitly to use the empty-bytes placeholder (bootstrap/migration path only).",
    );
  }

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
