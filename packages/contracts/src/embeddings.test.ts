import { describe, it, expect } from "vitest";
import {
  createLocalEmbeddingProvider,
  createOfflineEmbeddingProvider,
  generateEmbedding,
} from "./embeddings.js";
import type { ContractSpec } from "./index.js";

// ---------------------------------------------------------------------------
// Note on test duration
// ---------------------------------------------------------------------------
// These tests load the Xenova/all-MiniLM-L6-v2 ONNX model on first embed()
// call (~25MB download on a cold cache, instant on a warm cache). They are
// intentionally slow on a cold machine — the latency is a property of the
// production path and must not be hidden. Subsequent runs in the same process
// reuse the pipeline singleton and are fast.

const SAMPLE_SPEC: ContractSpec = {
  inputs: [{ name: "s", type: "string" }],
  outputs: [{ name: "result", type: "number[]" }],
  behavior: "Parse a JSON array of integers from a string.",
  guarantees: [{ id: "rejects-non-int", description: "Rejects non-integer values." }],
  errorConditions: [{ description: "Throws SyntaxError on malformed input.", errorType: "SyntaxError" }],
  nonFunctional: { purity: "pure", threadSafety: "safe" },
  propertyTests: [],
};

/** 2-minute timeout for tests that load the ONNX model. */
const MODEL_TIMEOUT = 120_000;

describe("EmbeddingProvider (local)", () => {
  describe("provider properties", () => {
    it("dimension is 384", () => {
      const provider = createLocalEmbeddingProvider();
      expect(provider.dimension).toBe(384);
    });

    it("modelId is non-empty and matches expected model", () => {
      const provider = createLocalEmbeddingProvider();
      expect(provider.modelId).toBe("Xenova/all-MiniLM-L6-v2");
    });
  });

  describe("embed output shape", () => {
    it("embed returns a Float32Array of length 384", { timeout: MODEL_TIMEOUT }, async () => {
      const provider = createLocalEmbeddingProvider();
      const vec = await provider.embed("hello world");
      expect(vec).toBeInstanceOf(Float32Array);
      expect(vec.length).toBe(384);
    });

    it(
      "embed returns non-zero vector for non-trivial input",
      { timeout: MODEL_TIMEOUT },
      async () => {
        const provider = createLocalEmbeddingProvider();
        const vec = await provider.embed("parse a list of integers");
        const allZero = Array.from(vec).every((v) => v === 0);
        expect(allZero).toBe(false);
      },
    );
  });

  describe("determinism (the critical v0 requirement)", () => {
    it(
      "two embed() calls on the same input return byte-equal Float32Arrays",
      { timeout: MODEL_TIMEOUT },
      async () => {
        const provider = createLocalEmbeddingProvider();
        const text = "parse a JSON array of integers";
        const vec1 = await provider.embed(text);
        const vec2 = await provider.embed(text);
        // Compare element by element for exact bit equality
        expect(vec1.length).toBe(vec2.length);
        for (let i = 0; i < vec1.length; i++) {
          // Use Object.is to distinguish +0/-0 and NaN
          expect(Object.is(vec1[i], vec2[i])).toBe(true);
        }
      },
    );

    it(
      "generateEmbedding with same spec returns byte-equal vectors on two calls",
      { timeout: MODEL_TIMEOUT },
      async () => {
        const vec1 = await generateEmbedding(SAMPLE_SPEC);
        const vec2 = await generateEmbedding(SAMPLE_SPEC);
        expect(vec1.length).toBe(384);
        expect(vec2.length).toBe(384);
        for (let i = 0; i < vec1.length; i++) {
          expect(Object.is(vec1[i], vec2[i])).toBe(true);
        }
      },
    );
  });

  describe("generateEmbedding integration", () => {
    it(
      "uses canonical text as input (different spec insertion order → same embedding)",
      { timeout: MODEL_TIMEOUT },
      async () => {
        const specA: ContractSpec = SAMPLE_SPEC;
        // Same data as SAMPLE_SPEC but properties inserted in a different order.
        // canonicalize() must normalize this so embeddings are identical.
        const specB: ContractSpec = {
          behavior: SAMPLE_SPEC.behavior,
          errorConditions: SAMPLE_SPEC.errorConditions,
          guarantees: SAMPLE_SPEC.guarantees,
          inputs: SAMPLE_SPEC.inputs,
          nonFunctional: SAMPLE_SPEC.nonFunctional,
          outputs: SAMPLE_SPEC.outputs,
          propertyTests: SAMPLE_SPEC.propertyTests,
        };
        const vecA = await generateEmbedding(specA);
        const vecB = await generateEmbedding(specB);
        // Both must produce the same embedding since canonicalize() normalizes order
        for (let i = 0; i < vecA.length; i++) {
          expect(Object.is(vecA[i], vecB[i])).toBe(true);
        }
      },
    );

    it(
      "different specs produce different embeddings",
      { timeout: MODEL_TIMEOUT },
      async () => {
        const specA = SAMPLE_SPEC;
        const specB: ContractSpec = {
          ...SAMPLE_SPEC,
          behavior: "Compute the SHA-256 hash of a byte array.",
        };
        const vecA = await generateEmbedding(specA);
        const vecB = await generateEmbedding(specB);
        // These should be semantically different embeddings
        const identical = Array.from(vecA).every((v, i) => Object.is(v, vecB[i]));
        expect(identical).toBe(false);
      },
    );

    it("custom provider is used when provided", { timeout: 5_000 }, async () => {
      let callCount = 0;
      const fakeProvider = {
        dimension: 3,
        modelId: "fake-model",
        async embed(_text: string): Promise<Float32Array> {
          callCount++;
          return new Float32Array([1.0, 2.0, 3.0]);
        },
      };
      const result = await generateEmbedding(SAMPLE_SPEC, fakeProvider);
      expect(callCount).toBe(1);
      expect(result).toEqual(new Float32Array([1.0, 2.0, 3.0]));
    });
  });
});

describe("EmbeddingProvider (offline / BLAKE3 stub)", () => {
  it("dimension is 384 and modelId identifies the offline provider", () => {
    const provider = createOfflineEmbeddingProvider();
    expect(provider.dimension).toBe(384);
    expect(provider.modelId).toBe("yakcc/offline-blake3-stub");
  });

  it("embed returns a Float32Array of length 384", async () => {
    const provider = createOfflineEmbeddingProvider();
    const vec = await provider.embed("hello world");
    expect(vec).toBeInstanceOf(Float32Array);
    expect(vec.length).toBe(384);
  });

  it("two embed() calls on the same input return byte-equal Float32Arrays", async () => {
    const provider = createOfflineEmbeddingProvider();
    const v1 = await provider.embed("Parse a JSON array of integers.");
    const v2 = await provider.embed("Parse a JSON array of integers.");
    expect(v1).toEqual(v2);
  });

  it("different inputs produce different vectors", async () => {
    const provider = createOfflineEmbeddingProvider();
    const v1 = await provider.embed("alpha");
    const v2 = await provider.embed("beta");
    let identical = true;
    for (let i = 0; i < v1.length; i++) {
      if (v1[i] !== v2[i]) {
        identical = false;
        break;
      }
    }
    expect(identical).toBe(false);
  });

  it("output vectors are L2-normalized (unit length)", async () => {
    const provider = createOfflineEmbeddingProvider();
    const vec = await provider.embed("normalize me");
    let norm = 0;
    for (let i = 0; i < vec.length; i++) {
      const v = vec[i] ?? 0;
      norm += v * v;
    }
    expect(Math.sqrt(norm)).toBeCloseTo(1.0, 5);
  });

  it("performs zero network I/O (synchronous-fast on first call)", async () => {
    const provider = createOfflineEmbeddingProvider();
    const start = Date.now();
    await provider.embed("first call");
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(500);
  });
});
