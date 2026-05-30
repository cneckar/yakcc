// @mock-exempt: fetch() is the external HTTP boundary to registry.yakcc.com.
//   Stubbing fetch is the correct pattern here — we are testing this module's
//   error-mapping, timeout, and URL-construction logic, not the network itself.
//   Using a real HTTP server for these unit tests would introduce network
//   flakiness; the integration test (src/__tests__/integration.test.ts) covers
//   the real wire-protocol path against a fake HTTP server bound to 127.0.0.1.
/**
 * Tests for http-client.ts (DEC-MCP-FETCH-ONE-CLIENT-006).
 *
 * Covers the Evaluation Contract items for http-client.test.ts:
 *   (a) YAKCC_REGISTRY_URL env override resolves correctly
 *   (b) default base URL is https://registry.yakcc.com
 *   (c) timeout aborts (AbortController fires)
 *   (d) non-200 maps to HttpError with structured fields
 *   (e) JSON parse failure on 200 surfaces as HttpError with code non_json_response
 *
 * Additional coverage:
 *   - GET happy path: returns parsed body
 *   - POST happy path: sends body + Content-Type, returns parsed response
 *   - 404: throws HttpError with status 404
 *   - 400 with { error: "invalid_wire", message: "..." }: throws with code "invalid_wire"
 *   - 503 with { error: { code, message } } shape: extracts nested code
 *   - Network error (fetch throws non-AbortError): throws HttpError code "network_error"
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_REGISTRY_URL,
  HttpClient,
  HttpError,
  createHttpClient,
} from "./http-client.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal Response-like object accepted by the stubbed fetch. */
function makeResponse(opts: {
  status: number;
  body?: unknown;
  ok?: boolean;
  statusText?: string;
}): Response {
  const { status, body, statusText = "" } = opts;
  const ok = opts.ok ?? (status >= 200 && status < 300);

  return {
    ok,
    status,
    statusText,
    json: async () => {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-return
      return body ?? null;
    },
  } as unknown as Response;
}

/** Build a Response whose .json() rejects (simulates malformed body). */
function makeBadJsonResponse(status: number): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: "OK",
    json: async () => {
      throw new SyntaxError("Unexpected token");
    },
  } as unknown as Response;
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("HttpClient", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    // Clean up env override between tests
    delete process.env.YAKCC_REGISTRY_URL;
  });

  // -------------------------------------------------------------------------
  // Base URL resolution
  // -------------------------------------------------------------------------

  describe("createHttpClient — base URL precedence", () => {
    it("(b) uses DEFAULT_REGISTRY_URL when no env or arg is provided", () => {
      delete process.env.YAKCC_REGISTRY_URL;
      const client = createHttpClient();
      // Access private opts via cast — acceptable in unit tests
      const opts = (client as unknown as { opts: { baseUrl: string } }).opts;
      expect(opts.baseUrl).toBe(DEFAULT_REGISTRY_URL);
      expect(DEFAULT_REGISTRY_URL).toBe("https://registry.yakcc.com");
    });

    it("(a) respects YAKCC_REGISTRY_URL env override over the default", () => {
      process.env.YAKCC_REGISTRY_URL = "http://localhost:9999";
      const client = createHttpClient();
      const opts = (client as unknown as { opts: { baseUrl: string } }).opts;
      expect(opts.baseUrl).toBe("http://localhost:9999");
    });

    it("explicit baseUrl arg takes precedence over YAKCC_REGISTRY_URL env", () => {
      process.env.YAKCC_REGISTRY_URL = "http://env-server:8080";
      const client = createHttpClient({ baseUrl: "http://explicit:7777" });
      const opts = (client as unknown as { opts: { baseUrl: string } }).opts;
      expect(opts.baseUrl).toBe("http://explicit:7777");
    });
  });

  // -------------------------------------------------------------------------
  // GET happy path
  // -------------------------------------------------------------------------

  describe("GET", () => {
    it("returns parsed body on 200", async () => {
      const payload = { id: "abc", name: "test-atom" };
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValueOnce(makeResponse({ status: 200, body: payload })),
      );

      const client = new HttpClient({ baseUrl: "https://registry.yakcc.com", timeoutMs: 5_000 });
      const result = await client.get<typeof payload>("v1/atoms/abc");
      expect(result).toEqual(payload);
    });

    it("sends GET to the correct URL (leading slash stripped from path)", async () => {
      const fetchMock = vi.fn().mockResolvedValueOnce(makeResponse({ status: 200, body: {} }));
      vi.stubGlobal("fetch", fetchMock);

      const client = new HttpClient({ baseUrl: "https://registry.yakcc.com", timeoutMs: 5_000 });
      await client.get("/v1/atoms/xyz");
      expect(fetchMock).toHaveBeenCalledWith(
        "https://registry.yakcc.com/v1/atoms/xyz",
        expect.objectContaining({ method: "GET" }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // POST happy path
  // -------------------------------------------------------------------------

  describe("POST", () => {
    it("sends body and Content-Type header, returns parsed response", async () => {
      const requestBody = { blockMerkleRoot: "deadbeef", specHash: "cafebabe" };
      const responseBody = { block_merkle_root: "deadbeef" };
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(makeResponse({ status: 200, body: responseBody }));
      vi.stubGlobal("fetch", fetchMock);

      const client = new HttpClient({ baseUrl: "https://registry.yakcc.com", timeoutMs: 5_000 });
      const result = await client.post<typeof responseBody>("v1/atoms", requestBody);

      expect(result).toEqual(responseBody);
      const [_url, init] = fetchMock.mock.calls[0] as [
        string,
        RequestInit & { headers: Record<string, string>; body: string },
      ];
      expect(init.method).toBe("POST");
      expect(init.headers["Content-Type"]).toBe("application/json");
      expect(JSON.parse(init.body)).toEqual(requestBody);
    });
  });

  // -------------------------------------------------------------------------
  // Non-2xx error mapping
  // -------------------------------------------------------------------------

  describe("non-2xx error mapping", () => {
    it("(d) throws HttpError with status 404 on not-found", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValueOnce(
          makeResponse({ status: 404, body: { error: "not_found", message: "Atom not found" } }),
        ),
      );

      const client = new HttpClient({ baseUrl: "https://registry.yakcc.com", timeoutMs: 5_000 });
      const err = await client.get("v1/atoms/missing").catch((e: unknown) => e);

      expect(err).toBeInstanceOf(HttpError);
      const httpErr = err as HttpError;
      expect(httpErr.status).toBe(404);
      expect(httpErr.code).toBe("not_found");
    });

    it("400 with flat { error: 'invalid_wire' } — throws with code 'invalid_wire'", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValueOnce(
          makeResponse({
            status: 400,
            body: { error: "invalid_wire", message: "Wire format rejected" },
          }),
        ),
      );

      const client = new HttpClient({ baseUrl: "https://registry.yakcc.com", timeoutMs: 5_000 });
      const err = await client.post("v1/atoms", {}).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(HttpError);
      const httpErr = err as HttpError;
      expect(httpErr.status).toBe(400);
      expect(httpErr.code).toBe("invalid_wire");
      expect(httpErr.message).toContain("Wire format rejected");
    });

    it("503 with nested { error: { code, message } } shape — extracts nested code", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValueOnce(
          makeResponse({
            status: 503,
            body: { error: { code: "worker_not_implemented", message: "Shave worker offline" } },
          }),
        ),
      );

      const client = new HttpClient({ baseUrl: "https://registry.yakcc.com", timeoutMs: 5_000 });
      const err = await client.post("v1/shaves", {}).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(HttpError);
      const httpErr = err as HttpError;
      expect(httpErr.status).toBe(503);
      expect(httpErr.code).toBe("worker_not_implemented");
    });

    it("non-2xx with no parseable code falls back to http_<status>", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValueOnce(makeResponse({ status: 500, body: { detail: "oops" } })),
      );

      const client = new HttpClient({ baseUrl: "https://registry.yakcc.com", timeoutMs: 5_000 });
      const err = await client.get("v1/atoms").catch((e: unknown) => e);

      expect(err).toBeInstanceOf(HttpError);
      expect((err as HttpError).code).toBe("http_500");
    });

    it("bodyJson is attached on non-2xx", async () => {
      const serverBody = { error: "rate_limited", message: "slow down" };
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValueOnce(makeResponse({ status: 429, body: serverBody })),
      );

      const client = new HttpClient({ baseUrl: "https://registry.yakcc.com", timeoutMs: 5_000 });
      const err = await client.get("v1/atoms").catch((e: unknown) => e);

      expect((err as HttpError).bodyJson).toEqual(serverBody);
    });
  });

  // -------------------------------------------------------------------------
  // JSON parse failures
  // -------------------------------------------------------------------------

  describe("JSON parse failures", () => {
    it("(e) 2xx non-JSON body throws HttpError with code non_json_response — not SyntaxError", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(makeBadJsonResponse(200)));

      const client = new HttpClient({ baseUrl: "https://registry.yakcc.com", timeoutMs: 5_000 });
      const err = await client.get("v1/atoms").catch((e: unknown) => e);

      expect(err).toBeInstanceOf(HttpError);
      const httpErr = err as HttpError;
      expect(httpErr.code).toBe("non_json_response");
      expect(httpErr.status).toBe(200);
    });
  });

  // -------------------------------------------------------------------------
  // Timeout
  // -------------------------------------------------------------------------

  describe("timeout", () => {
    it("(c) AbortController fires → throws HttpError with code 'timeout'", async () => {
      // fetch() returns a Promise that never resolves until the signal fires
      vi.stubGlobal(
        "fetch",
        vi.fn().mockImplementation((_url: string, init: RequestInit) => {
          return new Promise<Response>((_resolve, reject) => {
            const signal = init.signal as AbortSignal;
            signal.addEventListener("abort", () => {
              const abortErr = new Error("The operation was aborted");
              abortErr.name = "AbortError";
              reject(abortErr);
            });
          });
        }),
      );

      const client = new HttpClient({ baseUrl: "https://registry.yakcc.com", timeoutMs: 50 });
      const err = await client.get("v1/atoms").catch((e: unknown) => e);

      expect(err).toBeInstanceOf(HttpError);
      const httpErr = err as HttpError;
      expect(httpErr.code).toBe("timeout");
      expect(httpErr.status).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // Network errors
  // -------------------------------------------------------------------------

  describe("network errors", () => {
    it("fetch() throws non-AbortError → HttpError with code 'network_error'", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockRejectedValueOnce(new TypeError("Failed to fetch")),
      );

      const client = new HttpClient({ baseUrl: "https://registry.yakcc.com", timeoutMs: 5_000 });
      const err = await client.get("v1/atoms").catch((e: unknown) => e);

      expect(err).toBeInstanceOf(HttpError);
      const httpErr = err as HttpError;
      expect(httpErr.code).toBe("network_error");
      expect(httpErr.status).toBe(0);
    });
  });
});
