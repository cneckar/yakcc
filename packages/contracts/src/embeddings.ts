// SPDX-License-Identifier: MIT
// @decision DEC-EMBED-010: Local embeddings via @xenova/transformers behind a
// provider interface. Status: decided (MASTER_PLAN.md DEC-EMBED-010)
// Rationale: Local-first matches v0's no-network stance. The provider interface
// allows hosted providers to swap in later without changing call sites.
// Model: Xenova/all-MiniLM-L6-v2 (384 dimensions, ~25MB quantized, MIT license).
// Lazy singleton load: the model is not loaded at import time; it loads on the
// first embed() call and is reused for all subsequent calls.

import { blake3 } from "@noble/hashes/blake3.js";
import { canonicalizeText } from "./canonicalize.js";
import type { ContractSpec } from "./index.js";

// ---------------------------------------------------------------------------
// Provider interface
// ---------------------------------------------------------------------------

/**
 * A provider that converts a text string into a fixed-dimension embedding vector.
 *
 * Implementations must be deterministic: identical inputs must produce
 * byte-identical Float32Array outputs (modulo platform floating-point, but
 * transformers.js with the same ONNX model and same backend is deterministic).
 */
export interface EmbeddingProvider {
  /** Dimensionality of vectors produced by this provider. */
  readonly dimension: number;
  /** Stable identifier for the model/configuration, e.g. "Xenova/all-MiniLM-L6-v2". */
  readonly modelId: string;
  /**
   * Embed a text string and return a Float32Array of length `dimension`.
   * Must be deterministic: same input → same output, byte-for-byte.
   */
  embed(text: string): Promise<Float32Array>;
}

// ---------------------------------------------------------------------------
// Local provider (transformers.js)
// ---------------------------------------------------------------------------

/** Model identifier used by the local provider. */
const LOCAL_MODEL_ID = "Xenova/all-MiniLM-L6-v2";
/** Expected output dimension for all-MiniLM-L6-v2. */
const LOCAL_DIMENSION = 384;

// @decision DEC-EMBED-SINGLETON-CLOSURE-001: Pipeline singleton via closure, not module-level let.
// Status: decided (WI-V2-02)
// Rationale: A module-level `let pipelinePromise` violates the no-mutable-globals strict-subset
// rule, which forbids top-level `let`/`var` declarations. Moving the mutable cell into a closure
// (via an IIFE-style factory that returns a getter function) satisfies the rule: the `let` lives
// inside a function scope, not at module scope. Runtime behaviour is byte-identical — the
// pipeline is still loaded lazily on first embed() call and cached for all subsequent calls.

// @decision DEC-EMBED-CUSTOM-MODEL-001: Per-model pipeline factory via makePipelineLoader.
// Status: decided (WI-V3-DISCOVERY-D5-EMBED-MODEL-EXPERIMENT, issue #326)
// Rationale: createLocalEmbeddingProvider now accepts an optional modelId to support embedding
// model swaps for benchmarking (DISCOVERY_EMBED_MODEL env var). Non-default model IDs get
// per-instance pipeline closures via makePipelineLoader; the default model still uses the
// module-level singleton to preserve DEC-EMBED-SINGLETON-CLOSURE-001 semantics for production.

/**
 * Create a lazy pipeline loader closure for the given model.
 *
 * @decision DEC-EMBED-LAZY-001: Dynamic import for lazy pipeline init.
 * Status: decided (WI-002)
 * Rationale: Static import triggers ONNX runtime at module load; dynamic defers to first use.
 */
function makePipelineLoader(modelId: string): () => Promise<unknown> {
  let pipelinePromise: Promise<unknown> | null = null;
  return (): Promise<unknown> => {
    if (pipelinePromise === null) {
      pipelinePromise = import("@xenova/transformers").then((mod) =>
        mod.pipeline("feature-extraction", modelId),
      );
    }
    return pipelinePromise;
  };
}

/** Module-level singleton pipeline for the default model (DEC-EMBED-SINGLETON-CLOSURE-001). */
const getPipeline: () => Promise<unknown> = makePipelineLoader(LOCAL_MODEL_ID);

/**
 * The output shape from transformers.js feature-extraction pipeline.
 * transformers.js returns a Tensor-like object; we access .data for the flat
 * Float32Array.
 */
interface TransformerOutput {
  data: Float32Array;
}

/**
 * Create a local EmbeddingProvider backed by transformers.js.
 *
 * The model is loaded lazily on first embed() call. Subsequent calls reuse the
 * same in-memory pipeline. Two calls with the same input text will return
 * byte-equal Float32Arrays.
 *
 * Default: Xenova/all-MiniLM-L6-v2, 384 dimensions, MIT license.
 *
 * Custom model support (DEC-EMBED-CUSTOM-MODEL-001): pass a different modelId
 * and the corresponding dimension to benchmark alternative models via the
 * DISCOVERY_EMBED_MODEL env var. The schema is currently fixed at FLOAT[384];
 * 768-dim models require a schema migration before they can be benchmarked.
 * Per-instance pipeline closures are used for non-default models.
 */
export function createLocalEmbeddingProvider(
  modelId: string = LOCAL_MODEL_ID,
  dimension: number = LOCAL_DIMENSION,
): EmbeddingProvider {
  // Default model reuses the module-level singleton (DEC-EMBED-SINGLETON-CLOSURE-001).
  // Custom models get a fresh per-instance closure so they don't share pipeline state.
  const getLoader: () => Promise<unknown> =
    modelId === LOCAL_MODEL_ID ? getPipeline : makePipelineLoader(modelId);

  return {
    dimension,
    modelId,

    async embed(text: string): Promise<Float32Array> {
      const pipe = getLoader() as Promise<
        (
          text: string,
          options: { pooling: string; normalize: boolean },
        ) => Promise<TransformerOutput>
      >;
      const extractor = await pipe;
      const output = await extractor(text, {
        pooling: "mean",
        normalize: true,
      });
      return new Float32Array(output.data);
    },
  };
}

// ---------------------------------------------------------------------------
// Offline provider (deterministic, network-free)
// ---------------------------------------------------------------------------

/** Model identifier used by the offline deterministic provider. */
const OFFLINE_MODEL_ID = "yakcc/offline-blake3-stub";
/** Dimension matches the local provider so the registry schema (DEC-EMBED-010) is unchanged. */
const OFFLINE_DIMENSION = 384;
/** 32 bytes per BLAKE3 output × 12 chained hashes = 384 dims. */
const OFFLINE_HASH_BLOCKS = 12;

// @decision DEC-EMBED-OFFLINE-PROVIDER-001
// @title Offline embedding provider for bootstrap and other no-network paths
// @status accepted
// @rationale `yakcc bootstrap` (DEC-V2-BOOT-NO-AI-CORPUS-001) is contractually
//   network-free, but the registry's storeBlock pipeline always generates an
//   embedding before insert. The local transformers.js provider downloads the
//   tokenizer from HuggingFace on first call, breaking offline-by-design paths.
//   This deterministic BLAKE3-derived provider satisfies the EmbeddingProvider
//   contract with zero network I/O. Vectors are L2-normalized so cosine
//   distance still behaves; semantic quality is intentionally absent — these
//   embeddings exist only because the schema requires a vector column, not
//   because bootstrap performs intent search. Same input → same vector,
//   byte-for-byte (BLAKE3 is deterministic).

/**
 * Create an offline EmbeddingProvider that produces deterministic vectors
 * via BLAKE3 hashing. No network I/O, no model downloads.
 *
 * Use this provider for bootstrap, CI, sandboxed test runs, and any other
 * code path that must remain network-free. The vectors are not semantically
 * meaningful (similar texts do not produce nearby vectors); they exist only
 * to satisfy the registry's vector-column schema. For semantic search, use
 * `createLocalEmbeddingProvider()` instead.
 *
 * Determinism: identical text inputs produce byte-identical Float32Array
 * outputs across machines, runs, and platforms.
 */
export function createOfflineEmbeddingProvider(): EmbeddingProvider {
  return {
    dimension: OFFLINE_DIMENSION,
    modelId: OFFLINE_MODEL_ID,

    async embed(text: string): Promise<Float32Array> {
      const encoder = new TextEncoder();
      const vec = new Float32Array(OFFLINE_DIMENSION);
      for (let block = 0; block < OFFLINE_HASH_BLOCKS; block++) {
        const hash = blake3(encoder.encode(`${text}|${block}`));
        for (let i = 0; i < 32; i++) {
          const byte = hash[i] ?? 0;
          vec[block * 32 + i] = (byte - 128) / 128;
        }
      }
      let norm = 0;
      for (let i = 0; i < OFFLINE_DIMENSION; i++) {
        const v = vec[i] ?? 0;
        norm += v * v;
      }
      norm = Math.sqrt(norm);
      if (norm > 0) {
        for (let i = 0; i < OFFLINE_DIMENSION; i++) {
          const v = vec[i] ?? 0;
          vec[i] = v / norm;
        }
      }
      return vec;
    },
  };
}

// ---------------------------------------------------------------------------
// Module-level default provider singleton
// ---------------------------------------------------------------------------

// @decision DEC-EMBED-SINGLETON-CLOSURE-002: Default-provider singleton via closure, not module-level let.
// Status: decided (WI-V2-02)
// Rationale: Same motivation as DEC-EMBED-SINGLETON-CLOSURE-001 — module-level `let` violates
// no-mutable-globals. The mutable cell is moved into a closure so the `let` lives inside a
// function scope. Runtime behaviour is byte-identical: the provider is created once on the first
// call to generateEmbedding() that omits an explicit provider, and reused for all subsequent calls.
const getDefaultProvider: () => EmbeddingProvider = (() => {
  let defaultProvider: EmbeddingProvider | null = null;
  return (): EmbeddingProvider => {
    if (defaultProvider === null) {
      defaultProvider = createLocalEmbeddingProvider();
    }
    return defaultProvider;
  };
})();

// ---------------------------------------------------------------------------
// Convenience export
// ---------------------------------------------------------------------------

/**
 * Generate a vector embedding for a ContractSpec.
 *
 * The embedding is produced by converting the spec to its canonical text form
 * (key-sorted JSON) and then embedding that text via the given provider.
 * If no provider is supplied, the module-level local provider is used.
 *
 * The result is a Float32Array of length `provider.dimension`.
 * The embedding is deterministic: the same spec and the same provider always
 * return the same vector.
 */
export async function generateEmbedding(
  spec: ContractSpec,
  provider?: EmbeddingProvider,
): Promise<Float32Array> {
  const p = provider ?? getDefaultProvider();
  const text = canonicalizeText(spec);
  return p.embed(text);
}
