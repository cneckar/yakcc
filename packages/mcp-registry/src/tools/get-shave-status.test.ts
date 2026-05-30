/**
 * Tests for yakcc_get_shave_status tool.
 * Covers: happy path, bad input (non-UUID), 404, other HTTP errors.
 * @mock-exempt: HttpClient is injected — no real network calls.
 */

import { describe, expect, it, vi } from "vitest";
import { HttpClient, HttpError } from "../http-client.js";
import { getShaveStatus } from "./get-shave-status.js";

const VALID_UUID = "123e4567-e89b-12d3-a456-426614174000";

function makeHttp(overrides: Partial<{ get: ReturnType<typeof vi.fn>; post: ReturnType<typeof vi.fn> }> = {}): HttpClient {
  return {
    get: overrides.get ?? vi.fn(),
    post: overrides.post ?? vi.fn(),
  } as unknown as HttpClient;
}

describe("yakcc_get_shave_status", () => {
  it("has correct name", () => {
    expect(getShaveStatus.name).toBe("yakcc_get_shave_status");
  });

  it("happy path: returns full status record from server", async () => {
    const statusRecord = {
      id: VALID_UUID,
      status: "completed",
      atomHashes: ["a".repeat(64)],
      blockMerkleRoots: ["b".repeat(64)],
    };
    const getFn = vi.fn().mockResolvedValueOnce(statusRecord);
    const http = makeHttp({ get: getFn });
    const result = await getShaveStatus.handler({ id: VALID_UUID }, http);
    expect(result).toHaveLength(1);
    const parsed = JSON.parse(result[0]!.text);
    expect(parsed).toEqual(statusRecord);
    expect(getFn).toHaveBeenCalledWith(`v1/shave-requests/${VALID_UUID}`);
  });

  it("status record with error field: passes through as-is", async () => {
    const statusRecord = {
      id: VALID_UUID,
      status: "failed",
      atomHashes: [],
      blockMerkleRoots: [],
      error: "package_not_found",
    };
    const getFn = vi.fn().mockResolvedValueOnce(statusRecord);
    const http = makeHttp({ get: getFn });
    const result = await getShaveStatus.handler({ id: VALID_UUID }, http);
    const parsed = JSON.parse(result[0]!.text) as typeof statusRecord;
    expect(parsed.error).toBe("package_not_found");
  });

  it("bad input: missing id returns error content", async () => {
    const http = makeHttp({ get: vi.fn() });
    const result = await getShaveStatus.handler({}, http);
    const parsed = JSON.parse(result[0]!.text) as { error: string };
    expect(parsed.error).toBe("invalid_input");
  });

  it("bad input: non-string id returns error content", async () => {
    const http = makeHttp({ get: vi.fn() });
    const result = await getShaveStatus.handler({ id: 12345 }, http);
    const parsed = JSON.parse(result[0]!.text) as { error: string };
    expect(parsed.error).toBe("invalid_input");
  });

  it("bad input: non-UUID string returns error content", async () => {
    const http = makeHttp({ get: vi.fn() });
    const result = await getShaveStatus.handler({ id: "not-a-uuid" }, http);
    const parsed = JSON.parse(result[0]!.text) as { error: string };
    expect(parsed.error).toBe("invalid_input");
  });

  it("404: returns not_found content", async () => {
    const http = makeHttp({
      get: vi.fn().mockRejectedValueOnce(
        new HttpError({ status: 404, code: "not_found", message: "Not found" }),
      ),
    });
    const result = await getShaveStatus.handler({ id: VALID_UUID }, http);
    const parsed = JSON.parse(result[0]!.text) as { error: string };
    expect(parsed.error).toBe("not_found");
  });

  it("other HTTP error: surfaces code and status", async () => {
    const http = makeHttp({
      get: vi.fn().mockRejectedValueOnce(
        new HttpError({ status: 500, code: "internal_error", message: "Server error" }),
      ),
    });
    const result = await getShaveStatus.handler({ id: VALID_UUID }, http);
    const parsed = JSON.parse(result[0]!.text) as { error: string; status: number };
    expect(parsed.error).toBe("internal_error");
    expect(parsed.status).toBe(500);
  });
});
