/**
 * Tests for yakcc_request_shave tool.
 * Covers: happy paths (pypi/npm/github), bad input, 400 error codes,
 * 429 with retryAfter extraction.
 * @mock-exempt: HttpClient is injected — no real network calls.
 */

import { describe, expect, it, vi } from "vitest";
import { HttpClient, HttpError } from "../http-client.js";
import { requestShave } from "./request-shave.js";

function makeHttp(overrides: Partial<{ get: ReturnType<typeof vi.fn>; post: ReturnType<typeof vi.fn> }> = {}): HttpClient {
  return {
    get: overrides.get ?? vi.fn(),
    post: overrides.post ?? vi.fn(),
  } as unknown as HttpClient;
}

const PYPI_COORD = { source: "pypi", name: "requests", version: "2.31.0" };
const NPM_COORD = { source: "npm", name: "lodash", version: "4.17.21" };
const GITHUB_COORD = { source: "github", owner: "psf", repo: "requests", ref: "v2.31.0" };

describe("yakcc_request_shave", () => {
  it("has correct name", () => {
    expect(requestShave.name).toBe("yakcc_request_shave");
  });

  it("happy path pypi: returns id and status", async () => {
    const postFn = vi.fn().mockResolvedValueOnce({ id: "uuid-1234", status: "pending" });
    const http = makeHttp({ post: postFn });
    const result = await requestShave.handler({ coord: PYPI_COORD }, http);
    const parsed = JSON.parse(result[0]!.text) as { id: string; status: string };
    expect(parsed.id).toBe("uuid-1234");
    expect(parsed.status).toBe("pending");
    expect(postFn).toHaveBeenCalledWith("v1/shave-requests", PYPI_COORD);
  });

  it("happy path npm: posts correct coord shape", async () => {
    const postFn = vi.fn().mockResolvedValueOnce({ id: "uuid-5678", status: "queued" });
    const http = makeHttp({ post: postFn });
    await requestShave.handler({ coord: NPM_COORD }, http);
    expect(postFn).toHaveBeenCalledWith("v1/shave-requests", NPM_COORD);
  });

  it("happy path github: posts correct coord shape", async () => {
    const postFn = vi.fn().mockResolvedValueOnce({ id: "uuid-9999", status: "queued" });
    const http = makeHttp({ post: postFn });
    const result = await requestShave.handler({ coord: GITHUB_COORD }, http);
    const parsed = JSON.parse(result[0]!.text) as { id: string };
    expect(parsed.id).toBe("uuid-9999");
  });

  it("bad input: missing coord returns error content", async () => {
    const http = makeHttp({ post: vi.fn() });
    const result = await requestShave.handler({}, http);
    const parsed = JSON.parse(result[0]!.text) as { error: string };
    expect(parsed.error).toBe("invalid_input");
  });

  it("bad input: unknown source returns error content", async () => {
    const http = makeHttp({ post: vi.fn() });
    const result = await requestShave.handler({ coord: { source: "cargo", name: "serde", version: "1.0" } }, http);
    const parsed = JSON.parse(result[0]!.text) as { error: string };
    expect(parsed.error).toBe("invalid_input");
  });

  it("bad input: pypi with empty name returns error content", async () => {
    const http = makeHttp({ post: vi.fn() });
    const result = await requestShave.handler({ coord: { source: "pypi", name: "", version: "1.0" } }, http);
    const parsed = JSON.parse(result[0]!.text) as { error: string };
    expect(parsed.error).toBe("invalid_input");
  });

  it("400 unsupported_source: surfaces server error code", async () => {
    const http = makeHttp({
      post: vi.fn().mockRejectedValueOnce(
        new HttpError({ status: 400, code: "unsupported_source", message: "Not supported" }),
      ),
    });
    const result = await requestShave.handler({ coord: PYPI_COORD }, http);
    const parsed = JSON.parse(result[0]!.text) as { error: string; status: number };
    expect(parsed.error).toBe("unsupported_source");
    expect(parsed.status).toBe(400);
  });

  it("400 bad_coordinate: surfaces server error code", async () => {
    const http = makeHttp({
      post: vi.fn().mockRejectedValueOnce(
        new HttpError({ status: 400, code: "bad_coordinate", message: "Invalid" }),
      ),
    });
    const result = await requestShave.handler({ coord: PYPI_COORD }, http);
    const parsed = JSON.parse(result[0]!.text) as { error: string };
    expect(parsed.error).toBe("bad_coordinate");
  });

  it("429 coord_in_failure_cooldown: surfaces retryAfter from body", async () => {
    const http = makeHttp({
      post: vi.fn().mockRejectedValueOnce(
        new HttpError({
          status: 429,
          code: "coord_in_failure_cooldown",
          message: "Cooldown active",
          bodyJson: { retryAfter: 300 },
        }),
      ),
    });
    const result = await requestShave.handler({ coord: PYPI_COORD }, http);
    const parsed = JSON.parse(result[0]!.text) as { error: string; retryAfter: number };
    expect(parsed.error).toBe("coord_in_failure_cooldown");
    expect(parsed.retryAfter).toBe(300);
  });

  it("429 ip_rate_limited: surfaces error without retryAfter when absent", async () => {
    const http = makeHttp({
      post: vi.fn().mockRejectedValueOnce(
        new HttpError({
          status: 429,
          code: "ip_rate_limited",
          message: "Too many requests",
          bodyJson: {},
        }),
      ),
    });
    const result = await requestShave.handler({ coord: PYPI_COORD }, http);
    const parsed = JSON.parse(result[0]!.text) as { error: string; retryAfter?: number };
    expect(parsed.error).toBe("ip_rate_limited");
    expect(parsed.retryAfter).toBeUndefined();
  });
});
