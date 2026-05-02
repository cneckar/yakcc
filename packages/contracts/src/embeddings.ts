// SPDX-License-Identifier: MIT
// @decision DEC-EMBED-010: Local embeddings via @xenova/transformers behind a
// provider interface. Status: decided (MASTER_PLAN.md DEC-EMBED-010)
// Rationale: Local-first matches v0's no-network stance. The provider interface
// allows hosted providers to swap in later without changing call sites.
// Model: Xenova/all-MiniLM-L6-v2 (384 dimensions, ~25MB quantized, MIT license).
// Lazy singleton load: the model is not loaded at import time; it loads on the
// first embed() call and is reused for all subsequent calls.

import type { ContractSpec } from "./index.js";
import { canonicalizeText } from "./canonicalize.js";

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

/**
 * Lazy singleton: holds the pipeline once loaded, null before first call.
 * Typed as unknown to avoid importing the full transformers.js type surface at
 * module level (which would trigger model loading).
 */
let pipelinePromise: Promise<unknown> | null = null;

/** Load (or return the cached) transformers.js feature-extraction pipeline. */
async function getPipeline(): Promise<unknown> {
  if (pipelinePromise === null) {
    // Dynamic import keeps the model loader out of the module graph until needed.
    // @decision DEC-EMBED-LAZY-001: Dynamic import for lazy pipeline init.
    // Status: decided (WI-002)
    // Rationale: Static import of @xenova/transformers triggers ONNX runtime
    // initialization at module load time, adding hundreds of ms to every cold
    // start even for callers that never embed. Dynamic import defers that cost
    // until the first embed() call.
    pipelinePromise = import("@xenova/transformers").then((mod) =>
      mod.pipeline("feature-extraction", LOCAL_MODEL_ID),
    );
  }
  return pipelinePromise;
}

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
 * Model: Xenova/all-MiniLM-L6-v2, 384 dimensions, MIT license.
 */
export function createLocalEmbeddingProvider(): EmbeddingProvider {
  return {
    dimension: LOCAL_DIMENSION,
    modelId: LOCAL_MODEL_ID,

    async embed(text: string): Promise<Float32Array> {
      const pipe = getPipeline() as Promise<
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
// Module-level default provider singleton
// ---------------------------------------------------------------------------

/** Module-level lazy singleton for the default local provider. */
let defaultProvider: EmbeddingProvider | null = null;

function getDefaultProvider(): EmbeddingProvider {
  if (defaultProvider === null) {
    defaultProvider = createLocalEmbeddingProvider();
  }
  return defaultProvider;
}

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
