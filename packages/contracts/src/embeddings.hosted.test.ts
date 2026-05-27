// SPDX-License-Identifier: MIT
//
// @decision DEC-EMBED-HOSTED-PROVIDER-001 tests
// Unit tests for hosted embedding providers (OpenAI, Voyage, openai-compatible).
// All tests are offline — fetch is mocked or a local http server is used.
// No real API keys are required.

import * as http from "node:http";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  OPENAI_KNOWN_DIMENSIONS,
  VOYAGE_KNOWN_DIMENSIONS,
  createOpenAICompatibleEmbeddingProvider,
  createOpenAIEmbeddingProvider,
  createVoyageEmbeddingProvider,
  resolveEmbeddingProviderFromEnv,
} from "./embeddings.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a fake OpenAI-compatible response body for N texts. */
function fakeOpenAIResponse(count: number, dim: number): string {
  const data = Array.from({ length: count }, (_, i) => ({
    index: i,
    embedding: Array.from({ length: dim }, () => Math.random()),
  }));
  return JSON.stringify({ data, model: "test-model", usage: { prompt_tokens: 1, total_tokens: 1 } });
}

/** Build a mock fetch that returns a canned response. */
function makeMockFetch(status: number, body: string): typeof fetch {
  return vi.fn(async (_url, _init) => {
    return new Response(body, {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

// ---------------------------------------------------------------------------
// OpenAI provider — unit tests (mock fetch)
// ---------------------------------------------------------------------------

describe("createOpenAIEmbeddingProvider", () => {
  it("dimension defaults from OPENAI_KNOWN_DIMENSIONS for known models", () => {
    const provider = createOpenAIEmbeddingProvider({
      model: "text-embedding-ada-002",
      apiKey: "sk-test",
      _fetch: makeMockFetch(200, fakeOpenAIResponse(1, 1536)),
      _retryBaseMs: 0,
    });
    expect(provider.dimension).toBe(1536);
  });

  it("dimension respects explicit dimensions override", () => {
    const provider = createOpenAIEmbeddingProvider({
      model: "text-embedding-3-large",
      apiKey: "sk-test",
      dimensions: 384,
      _fetch: makeMockFetch(200, fakeOpenAIResponse(1, 384)),
      _retryBaseMs: 0,
    });
    expect(provider.dimension).toBe(384);
  });

  it("modelId encodes provider and model", () => {
    const provider = createOpenAIEmbeddingProvider({
      model: "text-embedding-3-large",
      apiKey: "sk-test",
      _fetch: makeMockFetch(200, fakeOpenAIResponse(1, 3072)),
      _retryBaseMs: 0,
    });
    expect(provider.modelId).toBe("openai/text-embedding-3-large");
  });

  it("modelId includes @dimension when dimensions is set", () => {
    const provider = createOpenAIEmbeddingProvider({
      model: "text-embedding-3-large",
      apiKey: "sk-test",
      dimensions: 384,
      _fetch: makeMockFetch(200, fakeOpenAIResponse(1, 384)),
      _retryBaseMs: 0,
    });
    expect(provider.modelId).toBe("openai/text-embedding-3-large@384");
  });

  it("embed() calls OpenAI API with correct URL, method, and Authorization header", async () => {
    const mockFetch = vi.fn(async () =>
      new Response(fakeOpenAIResponse(1, 1536), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    ) as unknown as typeof fetch;

    process.env.YAKCC_EMBEDDING_DISCLOSURE_ACK = "1";
    const provider = createOpenAIEmbeddingProvider({
      model: "text-embedding-ada-002",
      apiKey: "sk-mykey",
      _fetch: mockFetch,
      _retryBaseMs: 0,
    });

    await provider.embed("hello world");

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, init] = (mockFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(url).toBe("https://api.openai.com/v1/embeddings");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["Authorization"]).toBe("Bearer sk-mykey");
    delete process.env.YAKCC_EMBEDDING_DISCLOSURE_ACK;
  });

  it("embed() returns a Float32Array of correct length", async () => {
    process.env.YAKCC_EMBEDDING_DISCLOSURE_ACK = "1";
    const provider = createOpenAIEmbeddingProvider({
      model: "text-embedding-ada-002",
      apiKey: "sk-test",
      _fetch: makeMockFetch(200, fakeOpenAIResponse(1, 1536)),
      _retryBaseMs: 0,
    });

    const vec = await provider.embed("test");
    expect(vec).toBeInstanceOf(Float32Array);
    expect(vec.length).toBe(1536);
    delete process.env.YAKCC_EMBEDDING_DISCLOSURE_ACK;
  });

  it("batch() sends multiple texts in one request and returns correct count", async () => {
    process.env.YAKCC_EMBEDDING_DISCLOSURE_ACK = "1";
    const mockFetch = vi.fn(async () =>
      new Response(fakeOpenAIResponse(3, 1536), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    ) as unknown as typeof fetch;

    const provider = createOpenAIEmbeddingProvider({
      model: "text-embedding-ada-002",
      apiKey: "sk-test",
      _fetch: mockFetch,
      _retryBaseMs: 0,
    });

    const results = await provider.batch!(["a", "b", "c"]);
    expect(results).toHaveLength(3);
    expect(results[0]).toBeInstanceOf(Float32Array);
    // 3 texts in one request (batch size default is 64)
    expect(mockFetch).toHaveBeenCalledOnce();
    delete process.env.YAKCC_EMBEDDING_DISCLOSURE_ACK;
  });

  it("batch() chunks into multiple requests when texts exceed batchSize", async () => {
    process.env.YAKCC_EMBEDDING_DISCLOSURE_ACK = "1";
    const mockFetch = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as { input: string[] };
      const count = body.input.length;
      return new Response(fakeOpenAIResponse(count, 1536), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const provider = createOpenAIEmbeddingProvider({
      model: "text-embedding-ada-002",
      apiKey: "sk-test",
      batchSize: 2,
      _fetch: mockFetch,
      _retryBaseMs: 0,
    });

    const results = await provider.batch!(["a", "b", "c"]);
    expect(results).toHaveLength(3);
    // 3 texts / batchSize 2 = 2 requests
    expect(mockFetch).toHaveBeenCalledTimes(2);
    delete process.env.YAKCC_EMBEDDING_DISCLOSURE_ACK;
  });

  it("embed() throws on non-ok HTTP response", async () => {
    process.env.YAKCC_EMBEDDING_DISCLOSURE_ACK = "1";
    const provider = createOpenAIEmbeddingProvider({
      model: "text-embedding-ada-002",
      apiKey: "sk-bad",
      _fetch: makeMockFetch(401, '{"error":"invalid key"}'),
      _retryBaseMs: 0,
    });

    await expect(provider.embed("test")).rejects.toThrow(/401/);
    delete process.env.YAKCC_EMBEDDING_DISCLOSURE_ACK;
  });

  it("OPENAI_KNOWN_DIMENSIONS covers expected models", () => {
    expect(OPENAI_KNOWN_DIMENSIONS.has("text-embedding-ada-002")).toBe(true);
    expect(OPENAI_KNOWN_DIMENSIONS.has("text-embedding-3-large")).toBe(true);
    expect(OPENAI_KNOWN_DIMENSIONS.has("text-embedding-3-small")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Voyage provider — unit tests (mock fetch)
// ---------------------------------------------------------------------------

describe("createVoyageEmbeddingProvider", () => {
  it("dimension defaults from VOYAGE_KNOWN_DIMENSIONS for known models", () => {
    const provider = createVoyageEmbeddingProvider({
      model: "voyage-code-2",
      apiKey: "pa-test",
      _fetch: makeMockFetch(200, fakeOpenAIResponse(1, 1536)),
      _retryBaseMs: 0,
    });
    expect(provider.dimension).toBe(1536);
  });

  it("modelId encodes provider and model", () => {
    const provider = createVoyageEmbeddingProvider({
      model: "voyage-code-2",
      apiKey: "pa-test",
      _fetch: makeMockFetch(200, fakeOpenAIResponse(1, 1536)),
      _retryBaseMs: 0,
    });
    expect(provider.modelId).toBe("voyage/voyage-code-2");
  });

  it("embed() calls Voyage API with correct URL and Authorization header", async () => {
    process.env.YAKCC_EMBEDDING_DISCLOSURE_ACK = "1";
    const mockFetch = vi.fn(async () =>
      new Response(fakeOpenAIResponse(1, 1536), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    ) as unknown as typeof fetch;

    const provider = createVoyageEmbeddingProvider({
      model: "voyage-code-2",
      apiKey: "pa-mykey",
      _fetch: mockFetch,
      _retryBaseMs: 0,
    });

    await provider.embed("test");

    const [url, init] = (mockFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(url).toBe("https://api.voyageai.com/v1/embeddings");
    expect((init.headers as Record<string, string>)["Authorization"]).toBe("Bearer pa-mykey");
    delete process.env.YAKCC_EMBEDDING_DISCLOSURE_ACK;
  });

  it("VOYAGE_KNOWN_DIMENSIONS covers expected models", () => {
    expect(VOYAGE_KNOWN_DIMENSIONS.has("voyage-code-2")).toBe(true);
    expect(VOYAGE_KNOWN_DIMENSIONS.has("voyage-3")).toBe(true);
    expect(VOYAGE_KNOWN_DIMENSIONS.has("voyage-code-3")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// OpenAI-compatible provider — integration test with a local mock HTTP server
// ---------------------------------------------------------------------------

describe("createOpenAICompatibleEmbeddingProvider — local mock server", () => {
  let server: http.Server;
  let baseUrl: string;
  let lastRequestBody: unknown;

  beforeAll(async () => {
    await new Promise<void>((resolve) => {
      server = http.createServer((req, res) => {
        let body = "";
        req.on("data", (chunk: Buffer) => {
          body += chunk.toString();
        });
        req.on("end", () => {
          try {
            lastRequestBody = JSON.parse(body) as unknown;
            const reqBody = lastRequestBody as { input: string[] };
            const count = Array.isArray(reqBody.input) ? reqBody.input.length : 1;
            const responseBody = fakeOpenAIResponse(count, 768);
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(responseBody);
          } catch {
            res.writeHead(400);
            res.end("bad request");
          }
        });
      });
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address() as { port: number };
        baseUrl = `http://127.0.0.1:${addr.port}/v1`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  beforeEach(() => {
    process.env.YAKCC_EMBEDDING_DISCLOSURE_ACK = "1";
    lastRequestBody = undefined;
  });

  afterEach(() => {
    delete process.env.YAKCC_EMBEDDING_DISCLOSURE_ACK;
  });

  it("embed() sends a POST to /v1/embeddings and returns a Float32Array", async () => {
    const provider = createOpenAICompatibleEmbeddingProvider({
      baseUrl,
      model: "nomic-embed-text",
      dimension: 768,
    });

    const vec = await provider.embed("hello world");
    expect(vec).toBeInstanceOf(Float32Array);
    expect(vec.length).toBe(768);
  });

  it("embed() sends correct request body with model and input", async () => {
    const provider = createOpenAICompatibleEmbeddingProvider({
      baseUrl,
      model: "nomic-embed-text",
      dimension: 768,
    });

    await provider.embed("test text");

    const body = lastRequestBody as { input: string[]; model: string };
    expect(body.input).toEqual(["test text"]);
    expect(body.model).toBe("nomic-embed-text");
  });

  it("batch() sends multiple texts in one request", async () => {
    const provider = createOpenAICompatibleEmbeddingProvider({
      baseUrl,
      model: "nomic-embed-text",
      dimension: 768,
    });

    const results = await provider.batch!(["alpha", "beta", "gamma"]);
    expect(results).toHaveLength(3);
    expect((lastRequestBody as { input: string[] }).input).toEqual(["alpha", "beta", "gamma"]);
  });

  it("modelId encodes provider and model", () => {
    const provider = createOpenAICompatibleEmbeddingProvider({
      baseUrl,
      model: "nomic-embed-text",
      dimension: 768,
    });
    expect(provider.modelId).toBe("openai-compatible/nomic-embed-text");
  });

  it("dimension is set from config.dimension", () => {
    const provider = createOpenAICompatibleEmbeddingProvider({
      baseUrl,
      model: "nomic-embed-text",
      dimension: 768,
    });
    expect(provider.dimension).toBe(768);
  });

  it("sends Authorization header when apiKey is provided", async () => {
    let capturedHeaders: Record<string, string> = {};
    const localServer = http.createServer((req, res) => {
      capturedHeaders = req.headers as Record<string, string>;
      let body = "";
      req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
      req.on("end", () => {
        const reqBody = JSON.parse(body) as { input: string[] };
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(fakeOpenAIResponse(reqBody.input.length, 384));
      });
    });

    await new Promise<string>((resolve) => {
      localServer.listen(0, "127.0.0.1", () => {
        const addr = localServer.address() as { port: number };
        resolve(`http://127.0.0.1:${addr.port}/v1`);
      });
    }).then(async (url) => {
      const provider = createOpenAICompatibleEmbeddingProvider({
        baseUrl: url,
        model: "test-model",
        dimension: 384,
        apiKey: "my-local-key",
      });
      await provider.embed("test");
      expect(capturedHeaders.authorization).toBe("Bearer my-local-key");
    });

    await new Promise<void>((resolve) => localServer.close(() => resolve()));
  });
});

// ---------------------------------------------------------------------------
// resolveEmbeddingProviderFromEnv
// ---------------------------------------------------------------------------

describe("resolveEmbeddingProviderFromEnv", () => {
  afterEach(() => {
    delete process.env.YAKCC_EMBEDDING_PROVIDER;
    delete process.env.YAKCC_EMBEDDING_MODEL;
    delete process.env.OPENAI_API_KEY;
    delete process.env.VOYAGE_API_KEY;
    delete process.env.YAKCC_EMBEDDING_BASE_URL;
    delete process.env.YAKCC_EMBEDDING_DIMENSION;
    delete process.env.YAKCC_EMBEDDING_DIMENSIONS;
    delete process.env.YAKCC_EMBEDDING_DISCLOSURE_ACK;
  });

  it("returns null when YAKCC_EMBEDDING_PROVIDER is not set", () => {
    expect(resolveEmbeddingProviderFromEnv()).toBeNull();
  });

  it("returns null when YAKCC_EMBEDDING_PROVIDER=local", () => {
    process.env.YAKCC_EMBEDDING_PROVIDER = "local";
    expect(resolveEmbeddingProviderFromEnv()).toBeNull();
  });

  it("returns OpenAI provider when YAKCC_EMBEDDING_PROVIDER=openai", () => {
    process.env.YAKCC_EMBEDDING_PROVIDER = "openai";
    process.env.OPENAI_API_KEY = "sk-test";
    const provider = resolveEmbeddingProviderFromEnv();
    expect(provider).not.toBeNull();
    expect(provider!.modelId).toContain("openai/");
  });

  it("uses YAKCC_EMBEDDING_MODEL for openai provider", () => {
    process.env.YAKCC_EMBEDDING_PROVIDER = "openai";
    process.env.OPENAI_API_KEY = "sk-test";
    process.env.YAKCC_EMBEDDING_MODEL = "text-embedding-3-small";
    const provider = resolveEmbeddingProviderFromEnv();
    expect(provider!.modelId).toContain("text-embedding-3-small");
  });

  it("throws when openai provider has no OPENAI_API_KEY", () => {
    process.env.YAKCC_EMBEDDING_PROVIDER = "openai";
    expect(() => resolveEmbeddingProviderFromEnv()).toThrow(/OPENAI_API_KEY/);
  });

  it("returns Voyage provider when YAKCC_EMBEDDING_PROVIDER=voyage", () => {
    process.env.YAKCC_EMBEDDING_PROVIDER = "voyage";
    process.env.VOYAGE_API_KEY = "pa-test";
    const provider = resolveEmbeddingProviderFromEnv();
    expect(provider).not.toBeNull();
    expect(provider!.modelId).toContain("voyage/");
  });

  it("throws when voyage provider has no VOYAGE_API_KEY", () => {
    process.env.YAKCC_EMBEDDING_PROVIDER = "voyage";
    expect(() => resolveEmbeddingProviderFromEnv()).toThrow(/VOYAGE_API_KEY/);
  });

  it("returns openai-compatible provider when YAKCC_EMBEDDING_PROVIDER=openai-compatible", () => {
    process.env.YAKCC_EMBEDDING_PROVIDER = "openai-compatible";
    process.env.YAKCC_EMBEDDING_BASE_URL = "http://localhost:11434/v1";
    process.env.YAKCC_EMBEDDING_MODEL = "nomic-embed-text";
    process.env.YAKCC_EMBEDDING_DIMENSION = "768";
    const provider = resolveEmbeddingProviderFromEnv();
    expect(provider).not.toBeNull();
    expect(provider!.modelId).toContain("openai-compatible/nomic-embed-text");
    expect(provider!.dimension).toBe(768);
  });

  it("throws for openai-compatible when YAKCC_EMBEDDING_BASE_URL is missing", () => {
    process.env.YAKCC_EMBEDDING_PROVIDER = "openai-compatible";
    process.env.YAKCC_EMBEDDING_MODEL = "nomic-embed-text";
    process.env.YAKCC_EMBEDDING_DIMENSION = "768";
    expect(() => resolveEmbeddingProviderFromEnv()).toThrow(/YAKCC_EMBEDDING_BASE_URL/);
  });

  it("throws for openai-compatible when YAKCC_EMBEDDING_MODEL is missing", () => {
    process.env.YAKCC_EMBEDDING_PROVIDER = "openai-compatible";
    process.env.YAKCC_EMBEDDING_BASE_URL = "http://localhost:11434/v1";
    process.env.YAKCC_EMBEDDING_DIMENSION = "768";
    expect(() => resolveEmbeddingProviderFromEnv()).toThrow(/YAKCC_EMBEDDING_MODEL/);
  });

  it("throws for openai-compatible when YAKCC_EMBEDDING_DIMENSION is missing", () => {
    process.env.YAKCC_EMBEDDING_PROVIDER = "openai-compatible";
    process.env.YAKCC_EMBEDDING_BASE_URL = "http://localhost:11434/v1";
    process.env.YAKCC_EMBEDDING_MODEL = "nomic-embed-text";
    expect(() => resolveEmbeddingProviderFromEnv()).toThrow(/YAKCC_EMBEDDING_DIMENSION/);
  });

  it("throws for unknown provider kinds", () => {
    process.env.YAKCC_EMBEDDING_PROVIDER = "cohere";
    expect(() => resolveEmbeddingProviderFromEnv()).toThrow(/Unknown YAKCC_EMBEDDING_PROVIDER/);
  });
});
