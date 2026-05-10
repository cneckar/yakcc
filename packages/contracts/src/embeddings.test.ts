import { describe, expect, it } from "vitest";
import {
  createLocalEmbeddingProvider,
  createOfflineEmbeddingProvider,
  generateEmbedding,
} from "./embeddings.js";
import type { ContractSpec } from "./index.js";

const SAMPLE_SPEC: ContractSpec = {
  inputs: [{ name: "s", type: "string" }],
  outputs: [{ name: "result", type: "number[]" }],
  behavior: "Parse a JSON array of integers from a string.",
  guarantees: [{ id: "rejects-non-int", description: "Rejects non-integer values." }],
  errorConditions: [
    { description: "Throws SyntaxError on malformed input.", errorType: "SyntaxError" },
  ],
  nonFunctional: { purity: "pure", threadSafety: "safe" },
  propertyTests: [],
};

// ---------------------------------------------------------------------------
// Opt-in network flag: YAKCC_NETWORK_TESTS=1 enables local-provider smoke test.
// In CI and sandboxed environments this env var is absent, so those tests skip.
// ---------------------------------------------------------------------------
const runNetworkTests = process.env.YAKCC_NETWORK_TESTS === "1";

/** 2-minute timeout for the network smoke test that loads the ONNX model. */
const MODEL_TIMEOUT = 120_000;

// ---------------------------------------------------------------------------
// Local provider — static metadata (no embed() call, no network I/O)
// ---------------------------------------------------------------------------

describe("EmbeddingProvider (local) — static metadata", () => {
  it("dimension is 384", () => {
    const provider = createLocalEmbeddingProvider();
    expect(provider.dimension).toBe(384);
  });

  it("modelId is non-empty and matches expected model", () => {
    const provider = createLocalEmbeddingProvider();
    expect(provider.modelId).toBe("Xenova/all-MiniLM-L6-v2");
  });
});

// ---------------------------------------------------------------------------
// Local provider — network smoke (opt-in: YAKCC_NETWORK_TESTS=1)
//
// Loads the Xenova/all-MiniLM-L6-v2 ONNX model (~25 MB on cold cache).
// Skipped by default so CI and sandboxed runs stay offline-tolerant.
// ---------------------------------------------------------------------------

describe.skipIf(!runNetworkTests)(
  "EmbeddingProvider (local) — network smoke (YAKCC_NETWORK_TESTS=1)",
  () => {
    it(
      "embed returns a non-zero Float32Array of length 384",
      { timeout: MODEL_TIMEOUT },
      async () => {
        const provider = createLocalEmbeddingProvider();
        const vec = await provider.embed("hello world");
        expect(vec).toBeInstanceOf(Float32Array);
        expect(vec.length).toBe(384);
        const allZero = Array.from(vec).every((v) => v === 0);
        expect(allZero).toBe(false);
      },
    );
  },
);

// ---------------------------------------------------------------------------
// generateEmbedding integration — uses offline provider (no network I/O)
// ---------------------------------------------------------------------------

describe("generateEmbedding integration", () => {
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

  it("generateEmbedding with same spec returns byte-equal vectors on two calls", async () => {
    const provider = createOfflineEmbeddingProvider();
    const vec1 = await generateEmbedding(SAMPLE_SPEC, provider);
    const vec2 = await generateEmbedding(SAMPLE_SPEC, provider);
    expect(vec1.length).toBe(384);
    expect(vec2.length).toBe(384);
    for (let i = 0; i < vec1.length; i++) {
      expect(Object.is(vec1[i], vec2[i])).toBe(true);
    }
  });

  it("uses canonical text as input (different spec insertion order → same embedding)", async () => {
    const provider = createOfflineEmbeddingProvider();
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
    const vecA = await generateEmbedding(specA, provider);
    const vecB = await generateEmbedding(specB, provider);
    for (let i = 0; i < vecA.length; i++) {
      expect(Object.is(vecA[i], vecB[i])).toBe(true);
    }
  });

  it("different specs produce different embeddings", async () => {
    const provider = createOfflineEmbeddingProvider();
    const specA = SAMPLE_SPEC;
    const specB: ContractSpec = {
      ...SAMPLE_SPEC,
      behavior: "Compute the SHA-256 hash of a byte array.",
    };
    const vecA = await generateEmbedding(specA, provider);
    const vecB = await generateEmbedding(specB, provider);
    const identical = Array.from(vecA).every((v, i) => Object.is(v, vecB[i]));
    expect(identical).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Offline provider (BLAKE3 stub) — all tests are network-free
// ---------------------------------------------------------------------------

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
