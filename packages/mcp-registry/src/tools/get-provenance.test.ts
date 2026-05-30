/**
 * Tests for yakcc_get_provenance tool.
 * Covers: happy path, bad input (invalid root), 404, other HTTP errors.
 * @mock-exempt: HttpClient is injected — no real network calls.
 */

import { describe, expect, it, vi } from "vitest";
import { HttpClient, HttpError } from "../http-client.js";
import { getProvenance } from "./get-provenance.js";

const VALID_ROOT = "e".repeat(64);

function makeHttp(overrides: Partial<{ get: ReturnType<typeof vi.fn>; post: ReturnType<typeof vi.fn> }> = {}): HttpClient {
  return {
    get: overrides.get ?? vi.fn(),
    post: overrides.post ?? vi.fn(),
  } as unknown as HttpClient;
}

describe("yakcc_get_provenance", () => {
  it("has correct name", () => {
    expect(getProvenance.name).toBe("yakcc_get_provenance");
  });

  it("happy path: returns provenance record from server", async () => {
    const provenanceRecord = {
      root: VALID_ROOT,
      sources: [
        { source: "pypi", name: "requests", version: "2.31.0" },
        { source: "github", owner: "psf", repo: "requests", ref: "v2.31.0" },
      ],
    };
    const getFn = vi.fn().mockResolvedValueOnce(provenanceRecord);
    const http = makeHttp({ get: getFn });
    const result = await getProvenance.handler({ root: VALID_ROOT }, http);
    expect(result).toHaveLength(1);
    const parsed = JSON.parse(result[0]!.text);
    expect(parsed).toEqual(provenanceRecord);
    expect(getFn).toHaveBeenCalledWith(`v1/blocks/${VALID_ROOT}/sources`);
  });

  it("bad input: missing root returns error content", async () => {
    const http = makeHttp({ get: vi.fn() });
    const result = await getProvenance.handler({}, http);
    const parsed = JSON.parse(result[0]!.text) as { error: string };
    expect(parsed.error).toBe("invalid_input");
  });

  it("bad input: root too short returns error content", async () => {
    const http = makeHttp({ get: vi.fn() });
    const result = await getProvenance.handler({ root: "abc" }, http);
    const parsed = JSON.parse(result[0]!.text) as { error: string };
    expect(parsed.error).toBe("invalid_input");
  });

  it("bad input: uppercase hex root returns error content", async () => {
    const http = makeHttp({ get: vi.fn() });
    const result = await getProvenance.handler({ root: "E".repeat(64) }, http);
    const parsed = JSON.parse(result[0]!.text) as { error: string };
    expect(parsed.error).toBe("invalid_input");
  });

  it("bad input: non-string root returns error content", async () => {
    const http = makeHttp({ get: vi.fn() });
    const result = await getProvenance.handler({ root: 42 }, http);
    const parsed = JSON.parse(result[0]!.text) as { error: string };
    expect(parsed.error).toBe("invalid_input");
  });

  it("404: returns not_found content", async () => {
    const http = makeHttp({
      get: vi.fn().mockRejectedValueOnce(
        new HttpError({ status: 404, code: "not_found", message: "Not found" }),
      ),
    });
    const result = await getProvenance.handler({ root: VALID_ROOT }, http);
    const parsed = JSON.parse(result[0]!.text) as { error: string };
    expect(parsed.error).toBe("not_found");
  });

  it("other HTTP error: surfaces code and status as content", async () => {
    const http = makeHttp({
      get: vi.fn().mockRejectedValueOnce(
        new HttpError({ status: 500, code: "internal_error", message: "Server error" }),
      ),
    });
    const result = await getProvenance.handler({ root: VALID_ROOT }, http);
    const parsed = JSON.parse(result[0]!.text) as { error: string; status: number };
    expect(parsed.error).toBe("internal_error");
    expect(parsed.status).toBe(500);
  });
});
