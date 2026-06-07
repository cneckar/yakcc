// SPDX-License-Identifier: Apache-2.0
// @decision DEC-1117-AUTHORITY-001
// @title Kit re-exposes the canonical embedder; it does NOT fork it
// @status decided (MASTER_PLAN.md 2026-06-06)
// @rationale
//   The browser embedder MUST produce byte-identical Float32 vectors to
//   createLocalEmbeddingProvider() in @yakcc/contracts/src/embeddings.ts.
//   Both call the transformers.js pipeline with pooling:"mean", normalize:true
//   and the identical model id LOCAL_EMBED_MODEL_ID. Any divergence (different
//   model, pooling, or normalize flag) produces vectors that disagree with the
//   server's stored embeddings, breaking in-browser search quality.
//   The byte-parity test in embedder.parity.test.ts enforces this invariant.
//
// @decision DEC-1117-PLACEMENT-001
//   Browser-clean constraint: this file imports ONLY @xenova/transformers
//   (dynamic import) and has zero node-only deps. The pipeline factory is
//   structurally identical to makePipelineLoader() in contracts/src/embeddings.ts.

// ---------------------------------------------------------------------------
// Model constants
// ---------------------------------------------------------------------------

/**
 * Production bge-small model id used for all semantic embeddings.
 *
 * AUTHORITY NOTE (DEC-1117-AUTHORITY-001 / DEC-EMBED-MODEL-DEFAULT-002):
 * This constant mirrors LOCAL_MODEL_ID in @yakcc/contracts/src/embeddings.ts.
 * It is re-declared here (not re-exported from contracts) to avoid importing
 * the contracts barrel, which transitively pulls ts-morph into the browser
 * bundle (DEC-1117-PLACEMENT-001). The value MUST stay in sync with
 * contracts/src/embeddings.ts; the byte-parity test enforces this.
 */
export const LOCAL_EMBED_MODEL_ID = "Xenova/bge-small-en-v1.5";

/** Output dimension for the production model. */
export const LOCAL_EMBED_DIMENSION = 384;

// ---------------------------------------------------------------------------
// Pipeline factory
// ---------------------------------------------------------------------------

/** The output shape from transformers.js feature-extraction pipeline. */
interface TransformerOutput {
  data: Float32Array;
}

/**
 * Create a lazy pipeline loader closure for the given model.
 *
 * Identical pattern to makePipelineLoader() in contracts/src/embeddings.ts
 * (DEC-EMBED-SINGLETON-CLOSURE-001 / DEC-EMBED-LAZY-001).
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

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Browser embedder handle returned by createBrowserEmbedder(). */
export interface BrowserEmbedder {
  /** Model id the embedder was created with. */
  readonly modelId: string;
  /** Output vector dimension (384 for bge-small-en-v1.5). */
  readonly dimension: number;
  /**
   * Embed a text string and return a Float32Array of length `dimension`.
   *
   * Deterministic: same input → byte-identical output for the same model and
   * transformers.js backend (DEC-1117-AUTHORITY-001 parity guarantee).
   */
  embed(text: string): Promise<Float32Array>;
}

/**
 * Create a browser-safe embedder backed by the bge-small-en-v1.5
 * transformers.js pipeline.
 *
 * Model loading is lazy: the ONNX model is fetched on the first embed() call.
 * Subsequent calls reuse the same in-memory pipeline (closure singleton).
 *
 * **Browser env config:** transformers.js reads `env.allowRemoteModels` and
 * `env.allowLocalModels`. In a browser, remote model fetching is on by default.
 * Pin those env flags BEFORE calling embed() if you need air-gap or custom cache:
 * ```ts
 * import { env } from "@xenova/transformers";
 * env.allowRemoteModels = false;
 * env.localModelPath = "/models/";
 * ```
 *
 * **Byte-parity:** vectors produced here are element-wise equal to those from
 * `createLocalEmbeddingProvider()` in @yakcc/contracts for the same input text
 * and default model id (enforced by embedder.parity.test.ts).
 *
 * @param modelId   - Model id. Defaults to LOCAL_EMBED_MODEL_ID.
 * @param dimension - Vector dimension. Defaults to LOCAL_EMBED_DIMENSION.
 */
export function createBrowserEmbedder(
  modelId: string = LOCAL_EMBED_MODEL_ID,
  dimension: number = LOCAL_EMBED_DIMENSION,
): BrowserEmbedder {
  const getLoader = makePipelineLoader(modelId);

  return {
    modelId,
    dimension,

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
