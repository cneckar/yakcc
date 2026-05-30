/**
 * Tests for yakcc_get_atom tool.
 * Covers: happy path, bad input (invalid root), 404, other HTTP errors.
 * @mock-exempt: HttpClient is injected — no real network calls.
 */

import { describe, expect, it, vi } from "vitest";
import { HttpClient, HttpError } from "../http-client.js";
import { getAtom } from "./get-atom.js";

const VALID_ROOT = "c".repeat(64);

function makeHttp(overrides: Partial<{ get: ReturnType<typeof vi.fn>; post: ReturnType<typeof vi.fn> }> = {}): HttpClient {
  return {
    get: overrides.get ?? vi.fn(),
    post: overrides.post ?? vi.fn(),
  } as unknown as HttpClient;
}

describe("yakcc_get_atom", () => {
  it("has correct name", () => {
    expect(getAtom.name).toBe("yakcc_get_atom");
  });

  it("happy path: returns the raw WireBlockTriplet JSON", async () => {
    const triplet = {
      specHash: "a".repeat(64),
      specCanonicalBytes: "bytes",
      blockMerkleRoot: VALID_ROOT,
      implSource: "pypi:requests:2.31.0",
    };
    const getFn = vi.fn().mockResolvedValueOnce(triplet);
    const http = makeHttp({ get: getFn });
    const result = await getAtom.handler({ root: VALID_ROOT }, http);
    expect(result).toHaveLength(1);
    const parsed = JSON.parse(result[0]!.text);
    expect(parsed).toEqual(triplet);
    expect(getFn).toHaveBeenCalledWith(`v1/block/${VALID_ROOT}`);
  });

  it("bad input: missing root returns error content", async () => {
    const http = makeHttp({ get: vi.fn() });
    const result = await getAtom.handler({}, http);
    const parsed = JSON.parse(result[0]!.text) as { error: string };
    expect(parsed.error).toBe("invalid_input");
  });

  it("bad input: root too short returns error content", async () => {
    const http = makeHttp({ get: vi.fn() });
    const result = await getAtom.handler({ root: "abc" }, http);
    const parsed = JSON.parse(result[0]!.text) as { error: string };
    expect(parsed.error).toBe("invalid_input");
  });

  it("bad input: uppercase root returns error content", async () => {
    const http = makeHttp({ get: vi.fn() });
    const result = await getAtom.handler({ root: "A".repeat(64) }, http);
    const parsed = JSON.parse(result[0]!.text) as { error: string };
    expect(parsed.error).toBe("invalid_input");
  });

  it("404: returns structured not_found content", async () => {
    const http = makeHttp({
      get: vi.fn().mockRejectedValueOnce(
        new HttpError({ status: 404, code: "not_found", message: "Not found" }),
      ),
    });
    const result = await getAtom.handler({ root: VALID_ROOT }, http);
    const parsed = JSON.parse(result[0]!.text) as { error: string };
    expect(parsed.error).toBe("not_found");
  });

  it("other HTTP error: surfaces error code and status", async () => {
    const http = makeHttp({
      get: vi.fn().mockRejectedValueOnce(
        new HttpError({ status: 500, code: "internal_error", message: "Server error" }),
      ),
    });
    const result = await getAtom.handler({ root: VALID_ROOT }, http);
    const parsed = JSON.parse(result[0]!.text) as { error: string; status: number };
    expect(parsed.error).toBe("internal_error");
    expect(parsed.status).toBe(500);
  });
});
