import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createLocalEmbeddingProvider,
  createOfflineEmbeddingProvider,
  createOpenAICompatibleEmbeddingProvider,
  createOpenAIEmbeddingProvider,
  createVoyageEmbeddingProvider,
  generateEmbedding,
  resolveEmbeddingProviderFromEnv,
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
    // Per DEC-EMBED-MODEL-DEFAULT-002 (PR #336, 2026-05-11): default swapped
    // from all-MiniLM-L6-v2 to bge-small-en-v1.5 based on operator-run
    // benchmark hitting M2=70% target. Update assertion when default changes.
    const provider = createLocalEmbeddingProvider();
    expect(provider.modelId).toBe("Xenova/bge-small-en-v1.5");
  });
});

// ---------------------------------------------------------------------------
// Local provider — network smoke (opt-in: YAKCC_NETWORK_TESTS=1)
//
// Loads the Xenova/bge-small-en-v1.5 ONNX model (~25 MB on cold cache).
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

// ---------------------------------------------------------------------------
// Hosted providers — unit tests with mock fetch (no real network I/O)
// ---------------------------------------------------------------------------

describe("createOpenAIEmbeddingProvider — unit (mock fetch)", () => {
  it("modelId includes provider kind and model name", () => {
    const provider = createOpenAIEmbeddingProvider({
      model: "text-embedding-3-large",
      apiKey: "sk-test",
    });
    expect(provider.modelId).toContain("openai/");
    expect(provider.modelId).toContain("text-embedding-3-large");
  });

  it("dimension defaults to 3072 for text-embedding-3-large", () => {
    const provider = createOpenAIEmbeddingProvider({
      model: "text-embedding-3-large",
      apiKey: "sk-test",
    });
    expect(provider.dimension).toBe(3072);
  });

  it("dimension uses provided dimensions param", () => {
    const provider = createOpenAIEmbeddingProvider({
      model: "text-embedding-3-large",
      apiKey: "sk-test",
      dimensions: 384,
    });
    expect(provider.dimension).toBe(384);
    expect(provider.modelId).toContain("@384");
  });

  it("embed() calls fetch with correct URL and auth header", async () => {
    const fakeFetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        data: [{ index: 0, embedding: new Array(3072).fill(0.1) }],
      }),
    });
    const provider = createOpenAIEmbeddingProvider({
      model: "text-embedding-3-large",
      apiKey: "sk-test-key",
      _fetch: fakeFetch as typeof fetch,
    });

    const vec = await provider.embed("hello world");
    expect(vec).toBeInstanceOf(Float32Array);
    expect(vec.length).toBe(3072);
    expect(fakeFetch).toHaveBeenCalledOnce();
    const [url, init] = fakeFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.openai.com/v1/embeddings");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer sk-test-key");
  });

  it("batch() sends all texts in a single request per batch", async () => {
    const fakeFetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        data: [
          { index: 0, embedding: new Array(1536).fill(0.1) },
          { index: 1, embedding: new Array(1536).fill(0.2) },
        ],
      }),
    });
    const provider = createOpenAIEmbeddingProvider({
      model: "text-embedding-ada-002",
      apiKey: "sk-test",
      _fetch: fakeFetch as typeof fetch,
    });

    const vecs = await provider.batch!(["text one", "text two"]);
    expect(vecs).toHaveLength(2);
    expect(vecs[0]).toBeInstanceOf(Float32Array);
    expect(fakeFetch).toHaveBeenCalledOnce();
  });

  it("embed() retries on 429 and succeeds on second attempt", async () => {
    const fakeFetch = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 429, text: async () => "rate limited" })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ data: [{ index: 0, embedding: new Array(1536).fill(0.3) }] }),
      });
    const provider = createOpenAIEmbeddingProvider({
      model: "text-embedding-ada-002",
      apiKey: "sk-test",
      _fetch: fakeFetch as typeof fetch,
      _retryBaseMs: 1,
    });

    const vec = await provider.embed("retry test");
    expect(vec).toBeInstanceOf(Float32Array);
    expect(fakeFetch).toHaveBeenCalledTimes(2);
  });
});

describe("createVoyageEmbeddingProvider — unit (mock fetch)", () => {
  it("modelId is voyage/<model>", () => {
    const provider = createVoyageEmbeddingProvider({ model: "voyage-code-2", apiKey: "pa-test" });
    expect(provider.modelId).toBe("voyage/voyage-code-2");
  });

  it("dimension defaults to 1536 for voyage-code-2", () => {
    const provider = createVoyageEmbeddingProvider({ model: "voyage-code-2", apiKey: "pa-test" });
    expect(provider.dimension).toBe(1536);
  });

  it("embed() calls Voyage API endpoint", async () => {
    const fakeFetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ data: [{ index: 0, embedding: new Array(1536).fill(0.5) }] }),
    });
    const provider = createVoyageEmbeddingProvider({
      model: "voyage-code-2",
      apiKey: "pa-test",
      _fetch: fakeFetch as typeof fetch,
    });

    const vec = await provider.embed("some code");
    expect(vec).toBeInstanceOf(Float32Array);
    const [url] = fakeFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.voyageai.com/v1/embeddings");
  });
});

describe("createOpenAICompatibleEmbeddingProvider — unit (mock fetch)", () => {
  it("modelId is openai-compatible/<model>", () => {
    const provider = createOpenAICompatibleEmbeddingProvider({
      baseUrl: "http://localhost:11434/v1",
      model: "nomic-embed-text",
      dimension: 768,
    });
    expect(provider.modelId).toBe("openai-compatible/nomic-embed-text");
  });

  it("uses the provided dimension", () => {
    const provider = createOpenAICompatibleEmbeddingProvider({
      baseUrl: "http://localhost:11434/v1",
      model: "nomic-embed-text",
      dimension: 768,
    });
    expect(provider.dimension).toBe(768);
  });

  it("embed() calls the custom baseUrl", async () => {
    const fakeFetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ data: [{ index: 0, embedding: new Array(768).fill(0.1) }] }),
    });
    const provider = createOpenAICompatibleEmbeddingProvider({
      baseUrl: "http://localhost:11434/v1",
      model: "nomic-embed-text",
      dimension: 768,
      _fetch: fakeFetch as typeof fetch,
    });

    await provider.embed("test");
    const [url] = fakeFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://localhost:11434/v1/embeddings");
  });

  it("omits Authorization header when no apiKey", async () => {
    const fakeFetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ data: [{ index: 0, embedding: new Array(768).fill(0.1) }] }),
    });
    const provider = createOpenAICompatibleEmbeddingProvider({
      baseUrl: "http://localhost:11434/v1",
      model: "nomic-embed-text",
      dimension: 768,
      _fetch: fakeFetch as typeof fetch,
    });

    await provider.embed("no auth");
    const [, init] = fakeFetch.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// resolveEmbeddingProviderFromEnv — unit tests (no network I/O)
// ---------------------------------------------------------------------------

describe("resolveEmbeddingProviderFromEnv", () => {
  it("returns null when YAKCC_EMBEDDING_PROVIDER is not set", () => {
    const prev = process.env.YAKCC_EMBEDDING_PROVIDER;
    delete process.env.YAKCC_EMBEDDING_PROVIDER;
    try {
      expect(resolveEmbeddingProviderFromEnv()).toBeNull();
    } finally {
      if (prev !== undefined) process.env.YAKCC_EMBEDDING_PROVIDER = prev;
    }
  });

  it("returns null when YAKCC_EMBEDDING_PROVIDER=local", () => {
    const prev = process.env.YAKCC_EMBEDDING_PROVIDER;
    process.env.YAKCC_EMBEDDING_PROVIDER = "local";
    try {
      expect(resolveEmbeddingProviderFromEnv()).toBeNull();
    } finally {
      if (prev !== undefined) process.env.YAKCC_EMBEDDING_PROVIDER = prev;
      else delete process.env.YAKCC_EMBEDDING_PROVIDER;
    }
  });

  it("returns an openai provider when YAKCC_EMBEDDING_PROVIDER=openai", () => {
    const saved = {
      YAKCC_EMBEDDING_PROVIDER: process.env.YAKCC_EMBEDDING_PROVIDER,
      OPENAI_API_KEY: process.env.OPENAI_API_KEY,
      YAKCC_EMBEDDING_MODEL: process.env.YAKCC_EMBEDDING_MODEL,
    };
    process.env.YAKCC_EMBEDDING_PROVIDER = "openai";
    process.env.OPENAI_API_KEY = "sk-test";
    process.env.YAKCC_EMBEDDING_MODEL = "text-embedding-3-small";
    try {
      const provider = resolveEmbeddingProviderFromEnv();
      expect(provider).not.toBeNull();
      expect(provider?.modelId).toContain("openai/");
      expect(provider?.modelId).toContain("text-embedding-3-small");
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v !== undefined) process.env[k] = v;
        else delete process.env[k];
      }
    }
  });

  it("throws when YAKCC_EMBEDDING_PROVIDER=openai and OPENAI_API_KEY is missing", () => {
    const savedProvider = process.env.YAKCC_EMBEDDING_PROVIDER;
    const savedKey = process.env.OPENAI_API_KEY;
    process.env.YAKCC_EMBEDDING_PROVIDER = "openai";
    delete process.env.OPENAI_API_KEY;
    try {
      expect(() => resolveEmbeddingProviderFromEnv()).toThrow(/OPENAI_API_KEY/);
    } finally {
      if (savedProvider !== undefined) process.env.YAKCC_EMBEDDING_PROVIDER = savedProvider;
      else delete process.env.YAKCC_EMBEDDING_PROVIDER;
      if (savedKey !== undefined) process.env.OPENAI_API_KEY = savedKey;
    }
  });

  it("throws on unknown provider kind", () => {
    const prev = process.env.YAKCC_EMBEDDING_PROVIDER;
    process.env.YAKCC_EMBEDDING_PROVIDER = "unknown-provider";
    try {
      expect(() => resolveEmbeddingProviderFromEnv()).toThrow(/Unknown YAKCC_EMBEDDING_PROVIDER/);
    } finally {
      if (prev !== undefined) process.env.YAKCC_EMBEDDING_PROVIDER = prev;
      else delete process.env.YAKCC_EMBEDDING_PROVIDER;
    }
  });
});

// ---------------------------------------------------------------------------
// createLocalEmbeddingProvider — conditional offline pin (DEC-1123-CONDITIONAL-OFFLINE-PIN-001)
//
// These tests verify the air-gap mode behavior WITHOUT making a real 25MB download.
// Strategy:
//   1. Pin-blocks-fetch test: redirects env.cacheDir to a fresh empty tmpdir so the
//      model is guaranteed absent, then creates an airgapped provider and calls embed().
//      Expects a throw containing "bge model not cached".
//   2. Online-path-unaffected test: creates a provider with airgapped:false and asserts
//      that env.allowRemoteModels is NOT forcibly set to false, proving the online dev
//      first-run path is unaffected by the conditional pin.
// ---------------------------------------------------------------------------

describe("createLocalEmbeddingProvider — conditional offline pin (DEC-1123-CONDITIONAL-OFFLINE-PIN-001)", () => {
  // Restore env after each test to avoid cross-contamination.
  let savedCacheDir: string | undefined;
  let savedAllowRemoteModels: boolean | undefined;
  let tempDir: string | undefined;

  afterEach(async () => {
    // Restore @xenova/transformers env state modified by these tests.
    const mod = await import("@xenova/transformers");
    if (savedCacheDir !== undefined) {
      mod.env.cacheDir = savedCacheDir;
      savedCacheDir = undefined;
    }
    if (savedAllowRemoteModels !== undefined) {
      mod.env.allowRemoteModels = savedAllowRemoteModels;
      savedAllowRemoteModels = undefined;
    }
    if (tempDir !== undefined) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  it(
    "pin blocks fetch + fails loud: airgapped:true with empty cache dir throws 'bge model not cached'",
    { timeout: 15_000 },
    async () => {
      // Redirect the xenova cache to a fresh empty directory so the model is absent.
      const mod = await import("@xenova/transformers");
      savedCacheDir = mod.env.cacheDir as string | undefined;
      savedAllowRemoteModels = mod.env.allowRemoteModels as boolean | undefined;
      tempDir = mkdtempSync(`${tmpdir()}/yakcc-test-airgap-`);
      mod.env.cacheDir = tempDir;

      // Create a provider with explicit airgapped:true.
      // This uses a per-instance loader (NOT the module singleton) so the env pin
      // is applied fresh inside this loader's pipeline call.
      const provider = createLocalEmbeddingProvider(undefined, undefined, { airgapped: true });

      // embed() must throw — model is absent under the pin.
      await expect(provider.embed("test air-gap pin")).rejects.toThrow("bge model not cached");
    },
  );

  it("online path unaffected: airgapped:false does NOT set allowRemoteModels=false", async () => {
    const mod = await import("@xenova/transformers");
    savedAllowRemoteModels = mod.env.allowRemoteModels as boolean | undefined;

    // Reset to default (true) before the test.
    mod.env.allowRemoteModels = true;

    // Construct an online provider (airgapped:false). This should NOT touch
    // allowRemoteModels. Note: the pipeline is lazy — it only fires on embed().
    // We do NOT call embed() here (that would download the model in CI).
    // Instead we assert that construction alone does not pin env.
    createLocalEmbeddingProvider(undefined, undefined, { airgapped: false });

    // allowRemoteModels should still be true — the pin was NOT applied.
    expect(mod.env.allowRemoteModels).toBe(true);
  });
});
