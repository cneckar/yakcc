/**
 * Tests for yakcc_search_atoms tool.
 * Covers: happy path, bad input, HTTP error mapping.
 * @mock-exempt: HttpClient is injected — no real network calls.
 */

import { describe, expect, it, vi } from "vitest";
import { HttpClient, HttpError } from "../http-client.js";
import { searchAtoms } from "./search-atoms.js";

function makeHttp(overrides: Partial<{ get: ReturnType<typeof vi.fn>; post: ReturnType<typeof vi.fn> }> = {}): HttpClient {
  return {
    get: overrides.get ?? vi.fn(),
    post: overrides.post ?? vi.fn(),
  } as unknown as HttpClient;
}

describe("yakcc_search_atoms", () => {
  it("has correct name and non-empty description", () => {
    expect(searchAtoms.name).toBe("yakcc_search_atoms");
    expect(searchAtoms.description.length).toBeGreaterThan(0);
  });

  it("happy path: returns roots and nextCursor from server response", async () => {
    const roots = ["a".repeat(64), "b".repeat(64)];
    const http = makeHttp({ get: vi.fn().mockResolvedValueOnce({ roots, nextCursor: "tok123" }) });
    const result = await searchAtoms.handler({}, http);
    expect(result).toHaveLength(1);
    const parsed = JSON.parse(result[0]!.text) as { roots: string[]; nextCursor: string };
    expect(parsed.roots).toEqual(roots);
    expect(parsed.nextCursor).toBe("tok123");
  });

  it("passes limit and cursor as query params", async () => {
    const getFn = vi.fn().mockResolvedValueOnce({ roots: [], nextCursor: null });
    const http = makeHttp({ get: getFn });
    await searchAtoms.handler({ limit: 10, cursor: "abc" }, http);
    expect(getFn).toHaveBeenCalledWith("v1/blocks?limit=10&after=abc");
  });

  it("omits query params when not provided", async () => {
    const getFn = vi.fn().mockResolvedValueOnce({ roots: [] });
    const http = makeHttp({ get: getFn });
    await searchAtoms.handler({}, http);
    expect(getFn).toHaveBeenCalledWith("v1/blocks");
  });

  it("bad input: limit out of range returns error content (not throw)", async () => {
    const http = makeHttp({ get: vi.fn() });
    const result = await searchAtoms.handler({ limit: 9999 }, http);
    const parsed = JSON.parse(result[0]!.text) as { error: string };
    expect(parsed.error).toBe("invalid_input");
  });

  it("bad input: limit is a non-integer returns error content", async () => {
    const http = makeHttp({ get: vi.fn() });
    const result = await searchAtoms.handler({ limit: 1.5 }, http);
    const parsed = JSON.parse(result[0]!.text) as { error: string };
    expect(parsed.error).toBe("invalid_input");
  });

  it("bad input: cursor is not a string returns error content", async () => {
    const http = makeHttp({ get: vi.fn() });
    const result = await searchAtoms.handler({ cursor: 42 }, http);
    const parsed = JSON.parse(result[0]!.text) as { error: string };
    expect(parsed.error).toBe("invalid_input");
  });

  it("HTTP error: surfaces error code and status as content (not throw)", async () => {
    const http = makeHttp({
      get: vi.fn().mockRejectedValueOnce(
        new HttpError({ status: 503, code: "service_unavailable", message: "Down" }),
      ),
    });
    const result = await searchAtoms.handler({}, http);
    const parsed = JSON.parse(result[0]!.text) as { error: string; status: number };
    expect(parsed.error).toBe("service_unavailable");
    expect(parsed.status).toBe(503);
  });

  it("null args treated as no-arg call (valid)", async () => {
    const getFn = vi.fn().mockResolvedValueOnce({ roots: [] });
    const http = makeHttp({ get: getFn });
    const result = await searchAtoms.handler(null, http);
    const parsed = JSON.parse(result[0]!.text) as { roots: unknown[] };
    expect(Array.isArray(parsed.roots)).toBe(true);
  });
});
