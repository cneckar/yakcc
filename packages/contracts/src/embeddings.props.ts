// SPDX-License-Identifier: MIT
// @decision DEC-V2-PROPTEST-PATH-A-001: hand-authored property-test corpus for
// @yakcc/contracts atoms. Two-file pattern: this file (.props.ts) is vitest-free
// and holds the corpus; the sibling .props.test.ts is the vitest harness.
// Status: accepted (WI-V2-06 L1)
// Rationale: See tmp/wi-v2-06-layer-plan.md — the corpus file must be
// runtime-independent so L10 can hash it as a manifest artifact.
//
// Property-test corpus for embeddings.ts atoms.
// Atoms covered:
//   A1.8  createLocalEmbeddingProvider
//   A1.9  createOfflineEmbeddingProvider
//   A1.10 generateEmbedding
//
// Design note: createLocalEmbeddingProvider().embed() downloads the Xenova
// ONNX model on first call (~25 MB). Property tests for that path are guarded
// behind the YAKCC_NETWORK_TESTS env flag (matching the existing
// embeddings.test.ts pattern) and only exercise static metadata properties
// without network I/O in the default (CI/offline) run.
//
// The offline provider is fully exercised because it has zero I/O dependencies.
// Async predicates use fc.asyncProperty (not fc.property) so fc.assert awaits them.

import * as fc from "fast-check";
import { canonicalizeText } from "./canonicalize.js";
import { contractSpecArb } from "./canonicalize.props.js";
import {
  createLocalEmbeddingProvider,
  createOfflineEmbeddingProvider,
  generateEmbedding,
} from "./embeddings.js";

/** Whether network-dependent tests are enabled. */
const NETWORK_ENABLED = process.env.YAKCC_NETWORK_TESTS === "1";

// ---------------------------------------------------------------------------
// A1.8: createLocalEmbeddingProvider — static metadata properties
// (network-free: no embed() call)
// ---------------------------------------------------------------------------

/**
 * prop_localEmbeddingProvider_deterministic
 *
 * Two providers created by createLocalEmbeddingProvider() agree on dimension
 * and modelId — the factory is idempotent for static metadata.
 * Invariant: the factory returns consistent metadata without I/O.
 *
 * Note: embed() determinism requires network access and is covered in the
 * network-guarded section below.
 */
export const prop_localEmbeddingProvider_deterministic = fc.property(fc.constant(undefined), () => {
  const p1 = createLocalEmbeddingProvider();
  const p2 = createLocalEmbeddingProvider();
  return p1.dimension === p2.dimension && p1.modelId === p2.modelId;
});

/**
 * prop_localEmbeddingProvider_dimension_constant
 *
 * The local provider's dimension property is always 384.
 * Invariant: Xenova/all-MiniLM-L6-v2 always produces 384-dimensional vectors.
 */
export const prop_localEmbeddingProvider_dimension_constant = fc.property(
  fc.constant(undefined),
  () => {
    return createLocalEmbeddingProvider().dimension === 384;
  },
);

/**
 * prop_localEmbeddingProvider_normalized
 *
 * The local provider's embed() returns L2-normalized vectors when network is
 * available (YAKCC_NETWORK_TESTS=1). Skipped (returns true) in offline mode.
 * Invariant: Xenova pipeline is invoked with { normalize: true }.
 */
export const prop_localEmbeddingProvider_normalized = fc.asyncProperty(
  fc.string({ minLength: 1, maxLength: 64 }),
  async (text) => {
    if (!NETWORK_ENABLED) return true; // skip in offline mode
    const provider = createLocalEmbeddingProvider();
    const vec = await provider.embed(text);
    let norm = 0;
    for (let i = 0; i < vec.length; i++) {
      const v = vec[i] ?? 0;
      norm += v * v;
    }
    norm = Math.sqrt(norm);
    return Math.abs(norm - 1.0) < 1e-3;
  },
);

/**
 * prop_localEmbeddingProvider_distinct_inputs_distinct_outputs
 *
 * For two distinct non-empty strings, the local provider produces distinct
 * embedding vectors (requires network). Skipped (returns true) in offline mode.
 * Invariant: semantically different inputs produce different embeddings.
 */
export const prop_localEmbeddingProvider_distinct_inputs_distinct_outputs = fc.asyncProperty(
  fc.string({ minLength: 1, maxLength: 32 }),
  fc.string({ minLength: 1, maxLength: 32 }),
  async (a, b) => {
    if (!NETWORK_ENABLED) return true; // skip in offline mode
    if (a === b) return true; // identical inputs: skip
    const provider = createLocalEmbeddingProvider();
    const [va, vb] = await Promise.all([provider.embed(a), provider.embed(b)]);
    for (let i = 0; i < va.length; i++) {
      if (va[i] !== vb[i]) return true;
    }
    return false;
  },
);

// ---------------------------------------------------------------------------
// A1.9: createOfflineEmbeddingProvider — fully exercised (no network)
// ---------------------------------------------------------------------------

/**
 * prop_offlineEmbeddingProvider_deterministic
 *
 * For every string, two consecutive embed() calls on the offline provider
 * return byte-equal Float32Arrays.
 * Invariant: the offline BLAKE3-based provider is deterministic.
 */
export const prop_offlineEmbeddingProvider_deterministic = fc.asyncProperty(
  fc.string({ maxLength: 64 }),
  async (text) => {
    const provider = createOfflineEmbeddingProvider();
    const v1 = await provider.embed(text);
    const v2 = await provider.embed(text);
    if (v1.length !== v2.length) return false;
    for (let i = 0; i < v1.length; i++) {
      if (v1[i] !== v2[i]) return false;
    }
    return true;
  },
);

/**
 * prop_offlineEmbeddingProvider_dimension_constant
 *
 * The offline provider's dimension property is always 384, and every embed()
 * call returns a Float32Array of exactly that length.
 * Invariant: dimension is a static contract; embed() always honors it.
 */
export const prop_offlineEmbeddingProvider_dimension_constant = fc.asyncProperty(
  fc.string({ maxLength: 64 }),
  async (text) => {
    const provider = createOfflineEmbeddingProvider();
    const vec = await provider.embed(text);
    return provider.dimension === 384 && vec.length === provider.dimension;
  },
);

/**
 * prop_offlineEmbeddingProvider_normalized
 *
 * Every vector returned by the offline provider has an L2-norm within [1-ε, 1+ε].
 * Invariant: the offline provider normalizes its output (per source code: divides
 * each element by the norm before returning).
 */
export const prop_offlineEmbeddingProvider_normalized = fc.asyncProperty(
  fc.string({ maxLength: 64 }),
  async (text) => {
    const provider = createOfflineEmbeddingProvider();
    const vec = await provider.embed(text);
    let norm = 0;
    for (let i = 0; i < vec.length; i++) {
      const v = vec[i] ?? 0;
      norm += v * v;
    }
    norm = Math.sqrt(norm);
    // Accept L2-norm in [1-1e-5, 1+1e-5].
    return norm > 0.5 && Math.abs(norm - 1.0) < 1e-5;
  },
);

// ---------------------------------------------------------------------------
// A1.10: generateEmbedding — composition and delegation
// ---------------------------------------------------------------------------

/**
 * prop_generateEmbedding_default_provider_offline
 *
 * generateEmbedding(spec, offlineProvider) produces the same result as
 * offlineProvider.embed(canonicalizeText(spec)).
 * Invariant: generateEmbedding canonicalizes the spec and delegates to embed().
 *
 * Note: the default provider (when none is passed) is the local provider, which
 * requires network. This property verifies the composition law using the offline
 * provider explicitly, which is network-free and always runs.
 */
export const prop_generateEmbedding_default_provider_offline = fc.asyncProperty(
  contractSpecArb,
  async (spec) => {
    const offlineProvider = createOfflineEmbeddingProvider();
    const fromGenerate = await generateEmbedding(spec, offlineProvider);
    const fromProvider = await offlineProvider.embed(canonicalizeText(spec));
    if (fromGenerate.length !== fromProvider.length) return false;
    for (let i = 0; i < fromGenerate.length; i++) {
      if (fromGenerate[i] !== fromProvider[i]) return false;
    }
    return true;
  },
);

/**
 * prop_generateEmbedding_explicit_provider_delegates
 *
 * For any ContractSpec and the offline provider, generateEmbedding(spec, provider)
 * equals provider.embed(canonicalizeText(spec)).
 * Invariant: generateEmbedding is a pure facade over canonicalizeText + embed().
 */
export const prop_generateEmbedding_explicit_provider_delegates = fc.asyncProperty(
  contractSpecArb,
  async (spec) => {
    const offlineProvider = createOfflineEmbeddingProvider();
    const fromGenerate = await generateEmbedding(spec, offlineProvider);
    const fromDirect = await offlineProvider.embed(canonicalizeText(spec));
    if (fromGenerate.length !== fromDirect.length) return false;
    for (let i = 0; i < fromGenerate.length; i++) {
      if (fromGenerate[i] !== fromDirect[i]) return false;
    }
    return true;
  },
);
