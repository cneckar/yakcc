// SPDX-License-Identifier: MIT
// @decision DEC-V2-PROPTEST-PATH-A-001: hand-authored property-test corpus for
// @yakcc/shave persist/triplet.ts atoms. Two-file pattern: this file
// (.props.ts) is vitest-free and holds the corpus; the sibling .props.test.ts
// is the vitest harness.
// Status: accepted (WI-V2-07-PREFLIGHT L3c)
// Rationale: See tmp/wi-v2-07-preflight-layer-plan.md — the corpus file must be
// runtime-independent so L10 can hash it as a manifest artifact.
//
// Atoms covered (named exports from triplet.ts):
//   buildTriplet (BT1.1)           — builds the full BuiltTriplet for a novel atom.
//   L0_BOOTSTRAP_MANIFEST (BT1.2)  — the placeholder manifest constant (bootstrap opt-in).
//   makeBootstrapArtifacts (BT1.3) — produces the empty-bytes artifact Map for bootstrap.
//
// Private helpers tested transitively via buildTriplet():
//   (no named private helpers — specFromIntent is delegated to spec-from-intent.ts)
//
// Properties covered:
//   - buildTriplet returns all required BuiltTriplet fields for any well-formed input.
//   - buildTriplet impl field equals the raw source string.
//   - buildTriplet spec.level is always "L0".
//   - buildTriplet merkleRoot is non-empty for any input.
//   - buildTriplet is deterministic: identical inputs yield identical merkleRoot and specHash.
//   - buildTriplet distinct-source yields distinct merkleRoot (content-addressed identity).
//   - buildTriplet distinct-hash yields distinct merkleRoot (hash suffix in specName).
//   - buildTriplet with bootstrap=true does not require a CorpusResult.
//   - buildTriplet without corpusResult and without bootstrap=true throws.
//   - buildTriplet manifest.artifacts[0].kind === "property_tests" for corpus path.
//   - buildTriplet artifacts Map contains the corpus bytes at the corpus path.
//   - makeBootstrapArtifacts returns a Map with exactly one entry (empty bytes).
//   - L0_BOOTSTRAP_MANIFEST has exactly one artifact with kind "property_tests".
//
// Deferred atoms:
//   - specHash content-address correctness: covered by @yakcc/contracts invariants.
//   - validateSpecYak integration: covered by spec-from-intent.props.ts compound test.

// ---------------------------------------------------------------------------
// Property-test corpus for persist/triplet.ts
// ---------------------------------------------------------------------------

import type { CanonicalAstHash } from "@yakcc/contracts";
import * as fc from "fast-check";
import type { CorpusResult } from "../corpus/types.js";
import type { IntentCard } from "../intent/types.js";
import { L0_BOOTSTRAP_MANIFEST, buildTriplet, makeBootstrapArtifacts } from "./triplet.js";

// ---------------------------------------------------------------------------
// Shared arbitraries
// ---------------------------------------------------------------------------

/** Non-empty string with no leading/trailing whitespace. */
const nonEmptyStr: fc.Arbitrary<string> = fc
  .string({ minLength: 1, maxLength: 40 })
  .filter((s) => s.trim().length > 0);

/** 64-char hex string suitable for a CanonicalAstHash. */
const hexHash64: fc.Arbitrary<string> = fc
  .array(fc.integer({ min: 0, max: 15 }), { minLength: 64, maxLength: 64 })
  .map((nibbles) => nibbles.map((n) => n.toString(16)).join(""));

/** Well-formed IntentCard for property testing. */
const intentCardArb: fc.Arbitrary<IntentCard> = fc.record({
  schemaVersion: fc.constant(1 as const),
  behavior: nonEmptyStr,
  inputs: fc.array(
    fc.record({
      name: nonEmptyStr,
      typeHint: nonEmptyStr,
      description: fc.string({ minLength: 0, maxLength: 40 }),
    }),
    { minLength: 0, maxLength: 2 },
  ),
  outputs: fc.array(
    fc.record({
      name: nonEmptyStr,
      typeHint: nonEmptyStr,
      description: fc.string({ minLength: 0, maxLength: 40 }),
    }),
    { minLength: 0, maxLength: 2 },
  ),
  preconditions: fc.array(nonEmptyStr, { minLength: 0, maxLength: 2 }),
  postconditions: fc.array(nonEmptyStr, { minLength: 0, maxLength: 2 }),
  notes: fc.array(fc.string(), { minLength: 0, maxLength: 2 }),
  modelVersion: nonEmptyStr,
  promptVersion: nonEmptyStr,
  sourceHash: hexHash64,
  extractedAt: fc.constant("2024-01-01T00:00:00.000Z"),
});

/** Source text for an atom (non-empty string). */
const sourceArb: fc.Arbitrary<string> = fc.string({ minLength: 1, maxLength: 200 });

/** Arbitrary CorpusResult with deterministic bytes. */
const corpusResultArb: fc.Arbitrary<CorpusResult> = fc
  .tuple(nonEmptyStr, nonEmptyStr)
  .map(([content, pathStem]) => {
    const encoder = new TextEncoder();
    const bytes = encoder.encode(content);
    return {
      source: "upstream-test" as const,
      bytes,
      path: `${pathStem}.fast-check.ts`,
      contentHash: "aaaa1234",
    };
  });

// ---------------------------------------------------------------------------
// BT1.1: buildTriplet — returns all required BuiltTriplet fields
// ---------------------------------------------------------------------------

/**
 * prop_buildTriplet_has_all_required_fields
 *
 * For any well-formed IntentCard + source + hash + CorpusResult, buildTriplet
 * returns an object with all required BuiltTriplet fields present and non-null.
 *
 * Invariant (BT1.1): BuiltTriplet is the canonical intermediate value between
 * intent extraction and registry persistence. All six fields must be present
 * for callers to construct a BlockTripletRow without re-derivation.
 */
export const prop_buildTriplet_has_all_required_fields = fc.property(
  intentCardArb,
  sourceArb,
  hexHash64,
  corpusResultArb,
  (intentCard, source, hash, corpus) => {
    const t = buildTriplet(intentCard, source, hash as CanonicalAstHash, corpus);
    return (
      t.spec !== undefined &&
      t.specHash !== undefined &&
      t.specCanonicalBytes instanceof Uint8Array &&
      typeof t.impl === "string" &&
      t.manifest !== undefined &&
      typeof t.merkleRoot === "string" &&
      t.artifacts instanceof Map
    );
  },
);

// ---------------------------------------------------------------------------
// BT1.1: buildTriplet — impl equals the raw source string
// ---------------------------------------------------------------------------

/**
 * prop_buildTriplet_impl_equals_source
 *
 * buildTriplet().impl is always exactly equal to the source string passed in.
 *
 * Invariant (BT1.1, DEC-TRIPLET-IDENTITY-020): file bytes are the identity
 * unit at L0 — no normalization, no trimming. The impl field must round-trip
 * the source verbatim so blockMerkleRoot() uses the caller's exact bytes.
 */
export const prop_buildTriplet_impl_equals_source = fc.property(
  intentCardArb,
  sourceArb,
  hexHash64,
  corpusResultArb,
  (intentCard, source, hash, corpus) => {
    const t = buildTriplet(intentCard, source, hash as CanonicalAstHash, corpus);
    return t.impl === source;
  },
);

// ---------------------------------------------------------------------------
// BT1.1: buildTriplet — spec.level is always "L0"
// ---------------------------------------------------------------------------

/**
 * prop_buildTriplet_spec_level_is_L0
 *
 * The SpecYak embedded in the returned BuiltTriplet always has level === "L0".
 *
 * Invariant (BT1.1, DEC-TRIPLET-L0-ONLY-019): specFromIntent hard-codes "L0";
 * buildTriplet inherits it. L1/L2/L3 upgrades require a separate path.
 */
export const prop_buildTriplet_spec_level_is_L0 = fc.property(
  intentCardArb,
  sourceArb,
  hexHash64,
  corpusResultArb,
  (intentCard, source, hash, corpus) => {
    const t = buildTriplet(intentCard, source, hash as CanonicalAstHash, corpus);
    return t.spec.level === "L0";
  },
);

// ---------------------------------------------------------------------------
// BT1.1: buildTriplet — merkleRoot is a non-empty string
// ---------------------------------------------------------------------------

/**
 * prop_buildTriplet_merkle_root_is_non_empty
 *
 * The BlockMerkleRoot returned by buildTriplet is always a non-empty string.
 *
 * Invariant (BT1.1): blockMerkleRoot() from @yakcc/contracts always returns a
 * hex-encoded BLAKE3-256 digest. An empty string would indicate a computation
 * failure, which contracts does not produce on well-formed input.
 */
export const prop_buildTriplet_merkle_root_is_non_empty = fc.property(
  intentCardArb,
  sourceArb,
  hexHash64,
  corpusResultArb,
  (intentCard, source, hash, corpus) => {
    const t = buildTriplet(intentCard, source, hash as CanonicalAstHash, corpus);
    return typeof t.merkleRoot === "string" && t.merkleRoot.length > 0;
  },
);

// ---------------------------------------------------------------------------
// BT1.1: buildTriplet — determinism
// ---------------------------------------------------------------------------

/**
 * prop_buildTriplet_is_deterministic
 *
 * Two calls to buildTriplet() with identical inputs produce identical
 * merkleRoot and specHash values.
 *
 * Invariant (BT1.1, DEC-ATOM-PERSIST-001): the content address derivation is
 * pure — specFromIntent, specHash, and blockMerkleRoot are all deterministic.
 * No timestamps or random bytes enter the computation.
 */
export const prop_buildTriplet_is_deterministic = fc.property(
  intentCardArb,
  sourceArb,
  hexHash64,
  corpusResultArb,
  (intentCard, source, hash, corpus) => {
    const t1 = buildTriplet(intentCard, source, hash as CanonicalAstHash, corpus);
    const t2 = buildTriplet(intentCard, source, hash as CanonicalAstHash, corpus);
    return t1.merkleRoot === t2.merkleRoot && t1.specHash === t2.specHash;
  },
);

// ---------------------------------------------------------------------------
// BT1.1: buildTriplet — distinct source yields distinct merkleRoot
// ---------------------------------------------------------------------------

/**
 * prop_buildTriplet_distinct_source_yields_distinct_merkle_root
 *
 * Two calls with distinct source strings (all other args equal) produce
 * distinct merkleRoots.
 *
 * Invariant (BT1.1, DEC-TRIPLET-IDENTITY-020): impl is part of the Merkle
 * input. Changing the source bytes changes the block identity. This is the
 * fundamental content-addressing guarantee.
 */
export const prop_buildTriplet_distinct_source_yields_distinct_merkle_root = fc.property(
  fc.tuple(nonEmptyStr, nonEmptyStr).filter(([a, b]) => a !== b),
  intentCardArb,
  hexHash64,
  corpusResultArb,
  ([sourceA, sourceB], intentCard, hash, corpus) => {
    const t1 = buildTriplet(intentCard, sourceA, hash as CanonicalAstHash, corpus);
    const t2 = buildTriplet(intentCard, sourceB, hash as CanonicalAstHash, corpus);
    return t1.merkleRoot !== t2.merkleRoot;
  },
);

// ---------------------------------------------------------------------------
// BT1.1: buildTriplet — distinct hash yields distinct merkleRoot
// ---------------------------------------------------------------------------

/**
 * prop_buildTriplet_distinct_hash_yields_distinct_merkle_root
 *
 * Two calls with distinct canonicalAstHash values (all other args equal) produce
 * distinct merkleRoots.
 *
 * Invariant (BT1.1): the canonicalAstHash feeds into specFromIntent's name slug
 * (last 6 hex chars), which changes the SpecYak, which changes specCanonicalBytes,
 * which changes blockMerkleRoot. Two atoms with the same source but different
 * content addresses get distinct block identities.
 */
export const prop_buildTriplet_distinct_hash_yields_distinct_merkle_root = fc.property(
  fc.tuple(hexHash64, hexHash64).filter(([a, b]) => a !== b),
  intentCardArb,
  sourceArb,
  corpusResultArb,
  ([hashA, hashB], intentCard, source, corpus) => {
    const t1 = buildTriplet(intentCard, source, hashA as CanonicalAstHash, corpus);
    const t2 = buildTriplet(intentCard, source, hashB as CanonicalAstHash, corpus);
    return t1.merkleRoot !== t2.merkleRoot;
  },
);

// ---------------------------------------------------------------------------
// BT1.1: buildTriplet — manifest.artifacts[0].kind is "property_tests"
// ---------------------------------------------------------------------------

/**
 * prop_buildTriplet_manifest_artifact_kind_is_property_tests
 *
 * The ProofManifest in the returned BuiltTriplet always has exactly one
 * artifact with kind === "property_tests".
 *
 * Invariant (BT1.1, DEC-ATOM-PERSIST-001): L0 manifests carry exactly one
 * artifact — the property-test corpus. validateProofManifestL0 enforces this
 * shape at the contracts layer; buildTriplet must produce it consistently.
 */
export const prop_buildTriplet_manifest_artifact_kind_is_property_tests = fc.property(
  intentCardArb,
  sourceArb,
  hexHash64,
  corpusResultArb,
  (intentCard, source, hash, corpus) => {
    const t = buildTriplet(intentCard, source, hash as CanonicalAstHash, corpus);
    return t.manifest.artifacts.length === 1 && t.manifest.artifacts[0]?.kind === "property_tests";
  },
);

// ---------------------------------------------------------------------------
// BT1.1: buildTriplet — artifacts Map contains corpus bytes at corpus path
// ---------------------------------------------------------------------------

/**
 * prop_buildTriplet_artifacts_map_contains_corpus_bytes
 *
 * The artifacts Map in the returned BuiltTriplet contains the corpus bytes at
 * the corpus path declared in the manifest.
 *
 * Invariant (BT1.1, DEC-V1-FEDERATION-WIRE-ARTIFACTS-002): the SAME Map used
 * for blockMerkleRoot() is forwarded via BuiltTriplet.artifacts. Callers must
 * not reconstruct or copy it; this property verifies the bytes are accessible.
 */
export const prop_buildTriplet_artifacts_map_contains_corpus_bytes = fc.property(
  intentCardArb,
  sourceArb,
  hexHash64,
  corpusResultArb,
  (intentCard, source, hash, corpus) => {
    const t = buildTriplet(intentCard, source, hash as CanonicalAstHash, corpus);
    const path = t.manifest.artifacts[0]?.path ?? "";
    const stored = t.artifacts.get(path);
    return stored !== undefined && stored === corpus.bytes;
  },
);

// ---------------------------------------------------------------------------
// BT1.1: buildTriplet — bootstrap opt-in does not require CorpusResult
// ---------------------------------------------------------------------------

/**
 * prop_buildTriplet_bootstrap_does_not_require_corpus
 *
 * When options.bootstrap === true, buildTriplet succeeds without a CorpusResult.
 *
 * Invariant (BT1.1, DEC-ATOM-PERSIST-001): the bootstrap path is an explicit
 * opt-in for migration/test scenarios. It must not throw when corpusResult is
 * undefined. The produced triplet carries L0_BOOTSTRAP_MANIFEST.
 */
export const prop_buildTriplet_bootstrap_does_not_require_corpus = fc.property(
  intentCardArb,
  sourceArb,
  hexHash64,
  (intentCard, source, hash) => {
    try {
      const t = buildTriplet(intentCard, source, hash as CanonicalAstHash, undefined, {
        bootstrap: true,
      });
      return typeof t.merkleRoot === "string" && t.merkleRoot.length > 0;
    } catch {
      return false;
    }
  },
);

// ---------------------------------------------------------------------------
// BT1.1: buildTriplet — throws without corpusResult and without bootstrap
// ---------------------------------------------------------------------------

/**
 * prop_buildTriplet_throws_without_corpus_and_without_bootstrap
 *
 * When corpusResult is undefined and options.bootstrap is falsy, buildTriplet
 * throws an Error (no silent fallback after WI-016).
 *
 * Invariant (BT1.1, DEC-ATOM-PERSIST-001): "WI-016 retirement of
 * L0_BOOTSTRAP_MANIFEST as the silent default." Callers must supply a corpus
 * result or opt into bootstrap explicitly. Silently emitting empty bytes is
 * forbidden — the error here is the loudest possible failure.
 */
export const prop_buildTriplet_throws_without_corpus_and_without_bootstrap = fc.property(
  intentCardArb,
  sourceArb,
  hexHash64,
  (intentCard, source, hash) => {
    try {
      buildTriplet(intentCard, source, hash as CanonicalAstHash, undefined);
      return false; // should have thrown
    } catch {
      return true;
    }
  },
);

// ---------------------------------------------------------------------------
// BT1.2: L0_BOOTSTRAP_MANIFEST — has exactly one artifact with kind "property_tests"
// ---------------------------------------------------------------------------

/**
 * prop_L0_bootstrap_manifest_shape
 *
 * L0_BOOTSTRAP_MANIFEST has exactly one artifact entry with kind === "property_tests".
 *
 * Invariant (BT1.2): the bootstrap manifest constant is the canonical placeholder
 * for bootstrap/migration scenarios. Its shape is validated here so callers that
 * inspect it get a typed guarantee rather than relying on prose documentation.
 */
export const prop_L0_bootstrap_manifest_shape = fc.property(fc.constant(null), () => {
  return (
    Array.isArray(L0_BOOTSTRAP_MANIFEST.artifacts) &&
    L0_BOOTSTRAP_MANIFEST.artifacts.length === 1 &&
    L0_BOOTSTRAP_MANIFEST.artifacts[0]?.kind === "property_tests"
  );
});

// ---------------------------------------------------------------------------
// BT1.3: makeBootstrapArtifacts — returns a Map with exactly one entry (empty bytes)
// ---------------------------------------------------------------------------

/**
 * prop_makeBootstrapArtifacts_has_one_empty_entry
 *
 * makeBootstrapArtifacts() returns a Map with exactly one entry, whose value
 * is an empty Uint8Array (zero length).
 *
 * Invariant (BT1.3, DEC-ATOM-PERSIST-001): the bootstrap artifact placeholder
 * uses empty bytes as the corpus content. The single-entry Map matches the
 * single artifact declared in L0_BOOTSTRAP_MANIFEST. Callers must forward this
 * Map to BlockTripletRow.artifacts unchanged (DEC-V1-FEDERATION-WIRE-ARTIFACTS-002).
 */
export const prop_makeBootstrapArtifacts_has_one_empty_entry = fc.property(
  fc.constant(null),
  () => {
    const m = makeBootstrapArtifacts();
    const entries = [...m.entries()];
    return (
      entries.length === 1 &&
      entries[0] !== undefined &&
      entries[0][1] instanceof Uint8Array &&
      entries[0][1].length === 0
    );
  },
);

// ---------------------------------------------------------------------------
// Compound interaction: buildTriplet → blockMerkleRoot (end-to-end)
//
// Production sequence: IntentCard + source + hash + CorpusResult → buildTriplet()
// → specFromIntent() → specHash() → blockMerkleRoot() → BuiltTriplet.
// This crosses spec derivation, content-address hashing, and manifest wiring.
// ---------------------------------------------------------------------------

/**
 * prop_buildTriplet_compound_content_address_stability
 *
 * The merkleRoot produced by buildTriplet() is stable under re-computation:
 * given the same inputs, the second call produces an equal merkleRoot. Furthermore,
 * the artifacts Map path matches the manifest-declared path (end-to-end wiring check).
 *
 * This is the canonical compound-interaction property crossing:
 *   IntentCard + source + hash + CorpusResult
 *   → buildTriplet() → specFromIntent() + specHash() + blockMerkleRoot()
 *   → BuiltTriplet with consistent merkleRoot + artifacts path alignment
 *
 * Invariant (BT1.1, DEC-V1-FEDERATION-WIRE-ARTIFACTS-002 + DEC-TRIPLET-IDENTITY-020):
 * the SAME Map used for blockMerkleRoot() is forwarded in BuiltTriplet.artifacts,
 * and its key is the corpus path from the manifest. Both must hold simultaneously
 * for the federation wire contract to be satisfied.
 */
export const prop_buildTriplet_compound_content_address_stability = fc.property(
  intentCardArb,
  sourceArb,
  hexHash64,
  corpusResultArb,
  (intentCard, source, hash, corpus) => {
    const t1 = buildTriplet(intentCard, source, hash as CanonicalAstHash, corpus);
    const t2 = buildTriplet(intentCard, source, hash as CanonicalAstHash, corpus);

    // Merkle root must be stable across calls.
    if (t1.merkleRoot !== t2.merkleRoot) return false;

    // Artifacts Map must contain an entry at the path declared in the manifest.
    const path = t1.manifest.artifacts[0]?.path ?? "";
    if (!t1.artifacts.has(path)) return false;

    // The path in the artifacts Map must be the same as the manifest path.
    return [...t1.artifacts.keys()].includes(path);
  },
);
