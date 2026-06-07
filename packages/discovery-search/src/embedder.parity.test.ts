// SPDX-License-Identifier: Apache-2.0
/**
 * embedder.parity.test.ts — byte-parity + shape/normalization contract tests.
 *
 * TWO TEST GROUPS:
 *
 * 1. DETERMINISTIC (always run, no model needed):
 *    - createBrowserEmbedder() returns an object satisfying the BrowserEmbedder
 *      interface (modelId, dimension, embed method present).
 *    - LOCAL_EMBED_MODEL_ID matches the authority constant in
 *      @yakcc/contracts/src/embeddings.ts (LOCAL_MODEL_ID = "Xenova/bge-small-en-v1.5").
 *    - LOCAL_EMBED_DIMENSION = 384 matches contracts/src/embeddings.ts (LOCAL_DIMENSION).
 *    - The embed() return type is a Float32Array of the declared dimension.
 *      (Verified with the live model; see group 2. In CI without a model, we
 *       verify the interface shape only.)
 *
 * 2. MODEL PARITY (gated by YAKCC_EMBED_E2E=1 — requires bge-small-en-v1.5 cached):
 *    - createBrowserEmbedder().embed(text) produces a Float32Array byte-identical
 *      to createLocalEmbeddingProvider().embed(text) for the same input text.
 *    - The result is L2-normalized (||v|| ≈ 1.0 within Float32 precision).
 *    - Same text embedded twice returns byte-identical results (determinism).
 *
 * Gating pattern: describe.skipIf(!process.env.YAKCC_EMBED_E2E)
 * This mirrors the YAKCC_RUST_E2E pattern in bench/B1-latency/shave-rust.
 * Run locally: YAKCC_EMBED_E2E=1 pnpm --filter @yakcc/discovery-search test
 *
 * @decision DEC-1117-AUTHORITY-001 — browser embedder must be byte-identical to contracts
 * @decision DEC-1117-PLACEMENT-001 — browser entry must have no node-only deps
 */

import { createLocalEmbeddingProvider } from "@yakcc/contracts";
import { describe, expect, it } from "vitest";
import { LOCAL_EMBED_DIMENSION, LOCAL_EMBED_MODEL_ID, createBrowserEmbedder } from "./embedder.js";

// ---------------------------------------------------------------------------
// Authority constants from contracts — must match kit constants.
// These are the values defined in packages/contracts/src/embeddings.ts.
// ---------------------------------------------------------------------------

/** Source authority value (LOCAL_MODEL_ID in contracts/src/embeddings.ts). */
const AUTHORITY_MODEL_ID = "Xenova/bge-small-en-v1.5";

/** Source authority value (LOCAL_DIMENSION in contracts/src/embeddings.ts). */
const AUTHORITY_DIMENSION = 384;

// ---------------------------------------------------------------------------
// Group 1: Deterministic (no model required)
// ---------------------------------------------------------------------------

describe("BrowserEmbedder interface shape (deterministic, CI-safe)", () => {
  it("createBrowserEmbedder() returns an object with the BrowserEmbedder interface", () => {
    const embedder = createBrowserEmbedder();
    expect(typeof embedder.modelId).toBe("string");
    expect(typeof embedder.dimension).toBe("number");
    expect(typeof embedder.embed).toBe("function");
  });

  it("LOCAL_EMBED_MODEL_ID matches the authority constant in @yakcc/contracts", () => {
    // DEC-1117-AUTHORITY-001: kit constant must equal contracts constant.
    // If this drifts, browser and server produce vectors in different spaces.
    expect(LOCAL_EMBED_MODEL_ID).toBe(AUTHORITY_MODEL_ID);
  });

  it("LOCAL_EMBED_DIMENSION matches the authority constant in @yakcc/contracts", () => {
    expect(LOCAL_EMBED_DIMENSION).toBe(AUTHORITY_DIMENSION);
  });

  it("createBrowserEmbedder() defaults to the authority model id", () => {
    const embedder = createBrowserEmbedder();
    expect(embedder.modelId).toBe(AUTHORITY_MODEL_ID);
  });

  it("createBrowserEmbedder() defaults to the authority dimension", () => {
    const embedder = createBrowserEmbedder();
    expect(embedder.dimension).toBe(AUTHORITY_DIMENSION);
  });

  it("createLocalEmbeddingProvider() (contracts) defaults to the same model id", () => {
    // Both embedders must start from the same model id.
    const provider = createLocalEmbeddingProvider();
    expect(provider.modelId).toBe(AUTHORITY_MODEL_ID);
  });

  it("createLocalEmbeddingProvider() (contracts) defaults to the same dimension", () => {
    const provider = createLocalEmbeddingProvider();
    expect(provider.dimension).toBe(AUTHORITY_DIMENSION);
  });
});

// ---------------------------------------------------------------------------
// Group 2: Real-model parity (gated by YAKCC_EMBED_E2E=1)
//
// To run: YAKCC_EMBED_E2E=1 pnpm --filter @yakcc/discovery-search test
// Requires: Xenova/bge-small-en-v1.5 cached by transformers.js (either in
//   ~/.cache/huggingface/ or the node_modules/.cache/transformers.js path).
//   The model is ~25MB quantized and is downloaded automatically on first use.
// ---------------------------------------------------------------------------

describe.skipIf(!process.env.YAKCC_EMBED_E2E)(
  "byte-parity with createLocalEmbeddingProvider (YAKCC_EMBED_E2E=1 required)",
  () => {
    // Sample texts that cover different token lengths and content types.
    const PARITY_TEXTS = [
      "hello world",
      "function add(a: number, b: number): number { return a + b; }",
      "The quick brown fox jumps over the lazy dog",
      "yakcc mcp registry atom discovery search",
      "", // empty string (edge case)
    ];

    it("browser embedder returns a Float32Array of the declared dimension", async () => {
      const embedder = createBrowserEmbedder();
      const vec = await embedder.embed("test input");
      expect(vec).toBeInstanceOf(Float32Array);
      expect(vec.length).toBe(AUTHORITY_DIMENSION);
    }, 60_000);

    it("contracts provider returns a Float32Array of the declared dimension", async () => {
      const provider = createLocalEmbeddingProvider();
      const vec = await provider.embed("test input");
      expect(vec).toBeInstanceOf(Float32Array);
      expect(vec.length).toBe(AUTHORITY_DIMENSION);
    }, 60_000);

    it("output vector is L2-normalized (||v|| ≈ 1.0)", async () => {
      const embedder = createBrowserEmbedder();
      const vec = await embedder.embed("normalization test");
      let norm = 0;
      for (let i = 0; i < vec.length; i++) {
        const v = vec[i] ?? 0;
        norm += v * v;
      }
      norm = Math.sqrt(norm);
      // Float32 precision: norm should be within 1e-5 of 1.0
      expect(norm).toBeCloseTo(1.0, 4);
    }, 60_000);

    it("same text embedded twice by browser embedder returns byte-identical vectors", async () => {
      const embedder = createBrowserEmbedder();
      const v1 = await embedder.embed("determinism check");
      const v2 = await embedder.embed("determinism check");
      expect(v1.length).toBe(v2.length);
      for (let i = 0; i < v1.length; i++) {
        expect(v1[i]).toBe(v2[i]);
      }
    }, 60_000);

    for (const text of PARITY_TEXTS) {
      it(`byte-parity for text: ${JSON.stringify(text.slice(0, 40))}${text.length > 40 ? "..." : ""}`, async () => {
        const browserEmbedder = createBrowserEmbedder();
        const contractsProvider = createLocalEmbeddingProvider();

        const [browserVec, contractsVec] = await Promise.all([
          browserEmbedder.embed(text),
          contractsProvider.embed(text),
        ]);

        // Both must be the same dimension.
        expect(browserVec.length).toBe(contractsVec.length);
        expect(browserVec.length).toBe(AUTHORITY_DIMENSION);

        // Byte-identical (element-wise equality for Float32Array).
        // transformers.js is deterministic given the same model, pooling, and normalize flag.
        // Any divergence means a formula drift or model id mismatch.
        for (let i = 0; i < browserVec.length; i++) {
          expect(browserVec[i]).toBe(contractsVec[i]);
        }
      }, 120_000);
    }
  },
);
