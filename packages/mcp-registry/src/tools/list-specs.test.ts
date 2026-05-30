/**
 * Tests for yakcc_list_specs tool.
 * Covers: happy path, empty list, HTTP error.
 * @mock-exempt: HttpClient is injected — no real network calls.
 */

import { describe, expect, it, vi } from "vitest";
import { HttpClient, HttpError } from "../http-client.js";
import { listSpecs } from "./list-specs.js";

function makeHttp(overrides: Partial<{ get: ReturnType<typeof vi.fn>; post: ReturnType<typeof vi.fn> }> = {}): HttpClient {
  return {
    get: overrides.get ?? vi.fn(),
    post: overrides.post ?? vi.fn(),
  } as unknown as HttpClient;
}

describe("yakcc_list_specs", () => {
  it("has correct name", () => {
    expect(listSpecs.name).toBe("yakcc_list_specs");
  });

  it("happy path: returns specs array from server", async () => {
    const specs = ["a".repeat(64), "b".repeat(64)];
    const getFn = vi.fn().mockResolvedValueOnce({ specs });
    const http = makeHttp({ get: getFn });
    const result = await listSpecs.handler({}, http);
    expect(result).toHaveLength(1);
    const parsed = JSON.parse(result[0]!.text) as { specs: string[] };
    expect(parsed.specs).toEqual(specs);
    expect(getFn).toHaveBeenCalledWith("v1/specs");
  });

  it("empty list: returns empty specs array", async () => {
    const getFn = vi.fn().mockResolvedValueOnce({ specs: [] });
    const http = makeHttp({ get: getFn });
    const result = await listSpecs.handler({}, http);
    const parsed = JSON.parse(result[0]!.text) as { specs: unknown[] };
    expect(parsed.specs).toEqual([]);
  });

  it("no args (undefined): still calls v1/specs", async () => {
    const getFn = vi.fn().mockResolvedValueOnce({ specs: [] });
    const http = makeHttp({ get: getFn });
    await listSpecs.handler(undefined, http);
    expect(getFn).toHaveBeenCalledWith("v1/specs");
  });

  it("HTTP error: surfaces error code as content (not throw)", async () => {
    const http = makeHttp({
      get: vi.fn().mockRejectedValueOnce(
        new HttpError({ status: 503, code: "service_unavailable", message: "Down" }),
      ),
    });
    const result = await listSpecs.handler({}, http);
    const parsed = JSON.parse(result[0]!.text) as { error: string; status: number };
    expect(parsed.error).toBe("service_unavailable");
    expect(parsed.status).toBe(503);
  });
});
