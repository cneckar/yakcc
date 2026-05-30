/**
 * Tests for yakcc_submit_atom tool.
 * Covers: happy path, bad input (missing/wrong fields), 400 error codes,
 * 413 PAYLOAD_TOO_LARGE, deduped response.
 * @mock-exempt: HttpClient is injected — no real network calls.
 */

import { describe, expect, it, vi } from "vitest";
import { HttpClient, HttpError } from "../http-client.js";
import { submitAtom } from "./submit-atom.js";

const VALID_BLOCK = {
  specHash: "a".repeat(64),
  specCanonicalBytes: "aGVsbG8=",
  blockMerkleRoot: "b".repeat(64),
  implSource: "pypi:requests:2.31.0",
};

function makeHttp(overrides: Partial<{ get: ReturnType<typeof vi.fn>; post: ReturnType<typeof vi.fn> }> = {}): HttpClient {
  return {
    get: overrides.get ?? vi.fn(),
    post: overrides.post ?? vi.fn(),
  } as unknown as HttpClient;
}

describe("yakcc_submit_atom", () => {
  it("has correct name", () => {
    expect(submitAtom.name).toBe("yakcc_submit_atom");
  });

  it("happy path: returns accepted, hash, deduped from server", async () => {
    const serverResp = { accepted: true, hash: "b".repeat(64), deduped: false };
    const postFn = vi.fn().mockResolvedValueOnce(serverResp);
    const http = makeHttp({ post: postFn });
    const result = await submitAtom.handler({ block: VALID_BLOCK }, http);
    expect(result).toHaveLength(1);
    const parsed = JSON.parse(result[0]!.text) as typeof serverResp;
    expect(parsed.accepted).toBe(true);
    expect(parsed.hash).toBe("b".repeat(64));
    expect(parsed.deduped).toBe(false);
    expect(postFn).toHaveBeenCalledWith("v1/blocks/submit", VALID_BLOCK);
  });

  it("deduped response: returns deduped=true", async () => {
    const serverResp = { accepted: true, hash: "b".repeat(64), deduped: true };
    const postFn = vi.fn().mockResolvedValueOnce(serverResp);
    const http = makeHttp({ post: postFn });
    const result = await submitAtom.handler({ block: VALID_BLOCK }, http);
    const parsed = JSON.parse(result[0]!.text) as typeof serverResp;
    expect(parsed.deduped).toBe(true);
  });

  it("bad input: missing block field returns error content", async () => {
    const http = makeHttp({ post: vi.fn() });
    const result = await submitAtom.handler({}, http);
    const parsed = JSON.parse(result[0]!.text) as { error: string };
    expect(parsed.error).toBe("invalid_input");
  });

  it("bad input: block missing specHash returns error content", async () => {
    const { specHash: _, ...rest } = VALID_BLOCK;
    const http = makeHttp({ post: vi.fn() });
    const result = await submitAtom.handler({ block: rest }, http);
    const parsed = JSON.parse(result[0]!.text) as { error: string; message: string };
    expect(parsed.error).toBe("invalid_input");
    expect(parsed.message).toContain("specHash");
  });

  it("bad input: block with non-string implSource returns error content", async () => {
    const http = makeHttp({ post: vi.fn() });
    const result = await submitAtom.handler({ block: { ...VALID_BLOCK, implSource: 42 } }, http);
    const parsed = JSON.parse(result[0]!.text) as { error: string };
    expect(parsed.error).toBe("invalid_input");
  });

  it("400 invalid_wire: surfaces server error code", async () => {
    const http = makeHttp({
      post: vi.fn().mockRejectedValueOnce(
        new HttpError({ status: 400, code: "invalid_wire", message: "Wire format rejected" }),
      ),
    });
    const result = await submitAtom.handler({ block: VALID_BLOCK }, http);
    const parsed = JSON.parse(result[0]!.text) as { error: string; status: number };
    expect(parsed.error).toBe("invalid_wire");
    expect(parsed.status).toBe(400);
  });

  it("400 integrity_failed: surfaces server error code", async () => {
    const http = makeHttp({
      post: vi.fn().mockRejectedValueOnce(
        new HttpError({ status: 400, code: "integrity_failed", message: "Hash mismatch" }),
      ),
    });
    const result = await submitAtom.handler({ block: VALID_BLOCK }, http);
    const parsed = JSON.parse(result[0]!.text) as { error: string };
    expect(parsed.error).toBe("integrity_failed");
  });

  it("413: surfaces PAYLOAD_TOO_LARGE content", async () => {
    const http = makeHttp({
      post: vi.fn().mockRejectedValueOnce(
        new HttpError({ status: 413, code: "payload_too_large", message: "Too big" }),
      ),
    });
    const result = await submitAtom.handler({ block: VALID_BLOCK }, http);
    const parsed = JSON.parse(result[0]!.text) as { error: string };
    expect(parsed.error).toBe("PAYLOAD_TOO_LARGE");
  });
});
