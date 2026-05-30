/**
 * Tests for yakcc_get_spec tool.
 * Covers: happy path, bad input, 404, other HTTP errors.
 * @mock-exempt: HttpClient is injected — no real network calls.
 */

import { describe, expect, it, vi } from "vitest";
import { HttpClient, HttpError } from "../http-client.js";
import { getSpec } from "./get-spec.js";

const VALID_HASH = "d".repeat(64);

function makeHttp(overrides: Partial<{ get: ReturnType<typeof vi.fn>; post: ReturnType<typeof vi.fn> }> = {}): HttpClient {
  return {
    get: overrides.get ?? vi.fn(),
    post: overrides.post ?? vi.fn(),
  } as unknown as HttpClient;
}

describe("yakcc_get_spec", () => {
  it("has correct name", () => {
    expect(getSpec.name).toBe("yakcc_get_spec");
  });

  it("happy path: returns spec details from server", async () => {
    const specData = { specHash: VALID_HASH, name: "test-spec", version: "1.0" };
    const getFn = vi.fn().mockResolvedValueOnce(specData);
    const http = makeHttp({ get: getFn });
    const result = await getSpec.handler({ specHash: VALID_HASH }, http);
    expect(result).toHaveLength(1);
    const parsed = JSON.parse(result[0]!.text);
    expect(parsed).toEqual(specData);
    expect(getFn).toHaveBeenCalledWith(`v1/spec/${VALID_HASH}`);
  });

  it("bad input: missing specHash returns error content", async () => {
    const http = makeHttp({ get: vi.fn() });
    const result = await getSpec.handler({}, http);
    const parsed = JSON.parse(result[0]!.text) as { error: string };
    expect(parsed.error).toBe("invalid_input");
  });

  it("bad input: invalid hash format returns error content", async () => {
    const http = makeHttp({ get: vi.fn() });
    const result = await getSpec.handler({ specHash: "not-a-hash" }, http);
    const parsed = JSON.parse(result[0]!.text) as { error: string };
    expect(parsed.error).toBe("invalid_input");
  });

  it("bad input: uppercase hash returns error content", async () => {
    const http = makeHttp({ get: vi.fn() });
    const result = await getSpec.handler({ specHash: "D".repeat(64) }, http);
    const parsed = JSON.parse(result[0]!.text) as { error: string };
    expect(parsed.error).toBe("invalid_input");
  });

  it("404: returns not_found content", async () => {
    const http = makeHttp({
      get: vi.fn().mockRejectedValueOnce(
        new HttpError({ status: 404, code: "not_found", message: "Not found" }),
      ),
    });
    const result = await getSpec.handler({ specHash: VALID_HASH }, http);
    const parsed = JSON.parse(result[0]!.text) as { error: string };
    expect(parsed.error).toBe("not_found");
  });

  it("other HTTP error: surfaces code and status", async () => {
    const http = makeHttp({
      get: vi.fn().mockRejectedValueOnce(
        new HttpError({ status: 500, code: "internal_error", message: "Oops" }),
      ),
    });
    const result = await getSpec.handler({ specHash: VALID_HASH }, http);
    const parsed = JSON.parse(result[0]!.text) as { error: string; status: number };
    expect(parsed.error).toBe("internal_error");
    expect(parsed.status).toBe(500);
  });
});
