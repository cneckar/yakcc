/**
 * HTTP transport tests for @yakcc/federation (WI-020 v2, Slice B).
 *
 * Test coverage per Evaluation Contract:
 *   (1) fetchManifest — happy path (200 OK, returns RemoteManifest)
 *   (2) fetchCatalogPage — happy path first page (no cursor)
 *   (3) fetchCatalogPage — happy path paginated (with cursor)
 *   (4) fetchBlock — happy path (200 OK, returns WireBlockTriplet)
 *   (5) fetchSpec — happy path (200 OK, returns BlockMerkleRoot[])
 *   (6) fetchSpec — 404 returns empty array (normal: peer has no blocks for spec)
 *   (7) Error envelope passthrough — non-2xx with { error, message } → TransportError
 *   (8) Non-2xx without valid envelope → TransportError({ code: 'internal_error' })
 *   (9) Non-2xx with non-JSON body → TransportError({ code: 'internal_error' })
 *   (10) URL construction — correct endpoints and query params are called
 *   (11) Compound-interaction: catalog cursor pagination flow (first page → cursor → second page)
 *
 * All tests use injected stub fetch — no real network I/O.
 * No @anthropic SDK, no undici/axios. Only built-in fetch (stubbed via injection).
 *
 * Production sequence modeled: createHttpTransport(opts) → method(remote, ...) →
 *   URL builder → fetch(url) → readJsonResponse → typed domain object.
 *
 * WireBlockTriplet fixture includes artifactBytes (Record<string, string>) per
 * DEC-V1-FEDERATION-WIRE-ARTIFACTS-002. The http-transport layer does NOT verify
 * integrity — it returns the raw wire shape for the caller to validate via
 * deserializeWireBlockTriplet. Tests here confirm the transport passes the wire
 * shape through faithfully.
 */

import type { BlockMerkleRoot, SpecHash } from "@yakcc/contracts";
import { describe, expect, it, vi } from "vitest";
import { createHttpTransport } from "./http-transport.js";
import { TransportError } from "./types.js";
import type { CatalogPage, RemoteManifest, WireBlockTriplet } from "./types.js";

// ---------------------------------------------------------------------------
// Stub fetch helpers
// ---------------------------------------------------------------------------

/**
 * Build a stub fetch function that returns a 200 OK with the given JSON body.
 * Captures every URL it is called with so tests can assert correct URL construction.
 */
function stubOk(body: unknown): { fetch: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const stubFetch = vi.fn(async (input: Parameters<typeof fetch>[0], _init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push(url);
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { fetch: stubFetch, calls };
}

/**
 * Build a stub fetch that returns a given HTTP status with an optional JSON body.
 */
function stubStatus(status: number, body?: unknown): { fetch: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const stubFetch = vi.fn(async (input: Parameters<typeof fetch>[0], _init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push(url);
    if (body !== undefined) {
      return new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response("", { status });
  }) as unknown as typeof fetch;
  return { fetch: stubFetch, calls };
}

/**
 * Build a stub fetch that returns a non-JSON body on non-2xx status.
 */
function stubNonJsonError(status: number, text: string): { fetch: typeof fetch } {
  const stubFetch = vi.fn(async () => {
    return new Response(text, {
      status,
      headers: { "Content-Type": "text/plain" },
    });
  }) as unknown as typeof fetch;
  return { fetch: stubFetch };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const REMOTE = "https://peer.example.com";
const REMOTE_TRAILING = "https://peer.example.com/";

const MANIFEST_FIXTURE: RemoteManifest = {
  protocolVersion: "v1",
  schemaVersion: 4,
  blockCount: 42,
  rootsDigest: "a".repeat(64),
  rootsDigestAlgorithm: "blake3-256",
  servedAt: "2026-04-30T12:00:00Z",
};

const ROOT_A = "a".repeat(64) as BlockMerkleRoot;
const ROOT_B = "b".repeat(64) as BlockMerkleRoot;
const SPEC_HASH = "c".repeat(64) as SpecHash;

const CATALOG_PAGE_FIXTURE: CatalogPage = {
  blocks: [ROOT_A],
  nextCursor: ROOT_B,
};

/**
 * Minimal WireBlockTriplet fixture for transport-layer tests.
 *
 * The http-transport layer does NOT perform integrity checks — it returns the
 * raw wire shape. Tests here assert the transport faithfully passes the body
 * through without mutation. The artifactBytes field is included per
 * DEC-V1-FEDERATION-WIRE-ARTIFACTS-002 (required on the v2 wire), but the
 * actual base64 content is opaque to the transport — it is validated by
 * deserializeWireBlockTriplet (wire.ts), not here.
 */
const WIRE_TRIPLET_FIXTURE: WireBlockTriplet = {
  blockMerkleRoot: ROOT_A,
  specHash: SPEC_HASH,
  specCanonicalBytes: Buffer.from(
    '{"inputs":[{"name":"x","type":"string"}],"output":"string"}',
  ).toString("base64"),
  implSource: "export const x = (s: string) => s;",
  proofManifestJson: '{"artifacts":[{"kind":"property_tests","path":"tests.ts"}]}',
  artifactBytes: { "tests.ts": Buffer.from("// test content").toString("base64") },
  level: "L0",
  createdAt: 1_714_000_000_000,
  canonicalAstHash: "d".repeat(64),
  parentBlockRoot: null,
};

// ---------------------------------------------------------------------------
// (1) fetchManifest — happy path
// ---------------------------------------------------------------------------

describe("createHttpTransport — fetchManifest", () => {
  it("returns the parsed RemoteManifest on 200 OK", async () => {
    const { fetch: stubFetch } = stubOk(MANIFEST_FIXTURE);
    const transport = createHttpTransport({ fetch: stubFetch });
    const manifest = await transport.fetchManifest(REMOTE);
    expect(manifest).toEqual(MANIFEST_FIXTURE);
  });

  it("calls the correct /v1/manifest URL", async () => {
    const { fetch: stubFetch, calls } = stubOk(MANIFEST_FIXTURE);
    const transport = createHttpTransport({ fetch: stubFetch });
    await transport.fetchManifest(REMOTE);
    expect(calls[0]).toBe("https://peer.example.com/v1/manifest");
  });

  it("strips trailing slash from peer URL", async () => {
    const { fetch: stubFetch, calls } = stubOk(MANIFEST_FIXTURE);
    const transport = createHttpTransport({ fetch: stubFetch });
    await transport.fetchManifest(REMOTE_TRAILING);
    expect(calls[0]).toBe("https://peer.example.com/v1/manifest");
  });
});

// ---------------------------------------------------------------------------
// (2) fetchCatalogPage — happy path, first page (no cursor)
// ---------------------------------------------------------------------------

describe("createHttpTransport — fetchCatalogPage", () => {
  it("returns the parsed CatalogPage on 200 OK (first page, no cursor)", async () => {
    const { fetch: stubFetch } = stubOk(CATALOG_PAGE_FIXTURE);
    const transport = createHttpTransport({ fetch: stubFetch });
    const page = await transport.fetchCatalogPage(REMOTE, null, 1000);
    expect(page).toEqual(CATALOG_PAGE_FIXTURE);
  });

  it("calls /v1/blocks?limit=1000 when after=null", async () => {
    const { fetch: stubFetch, calls } = stubOk(CATALOG_PAGE_FIXTURE);
    const transport = createHttpTransport({ fetch: stubFetch });
    await transport.fetchCatalogPage(REMOTE, null, 1000);
    expect(calls[0]).toContain("/v1/blocks");
    expect(calls[0]).toContain("limit=1000");
    expect(calls[0]).not.toContain("after=");
  });

  // (3) Paginated — with cursor
  it("includes after= cursor when provided", async () => {
    const { fetch: stubFetch, calls } = stubOk(CATALOG_PAGE_FIXTURE);
    const transport = createHttpTransport({ fetch: stubFetch });
    await transport.fetchCatalogPage(REMOTE, ROOT_A, 500);
    expect(calls[0]).toContain("after=");
    expect(calls[0]).toContain(ROOT_A);
    expect(calls[0]).toContain("limit=500");
  });

  it("returns page with null nextCursor when catalog is exhausted", async () => {
    const lastPage: CatalogPage = { blocks: [ROOT_B], nextCursor: null };
    const { fetch: stubFetch } = stubOk(lastPage);
    const transport = createHttpTransport({ fetch: stubFetch });
    const page = await transport.fetchCatalogPage(REMOTE, ROOT_A, 1000);
    expect(page.nextCursor).toBeNull();
    expect(page.blocks).toEqual([ROOT_B]);
  });
});

// ---------------------------------------------------------------------------
// (4) fetchBlock — happy path
// ---------------------------------------------------------------------------

describe("createHttpTransport — fetchBlock", () => {
  it("returns the parsed WireBlockTriplet on 200 OK", async () => {
    const { fetch: stubFetch } = stubOk(WIRE_TRIPLET_FIXTURE);
    const transport = createHttpTransport({ fetch: stubFetch });
    const block = await transport.fetchBlock(REMOTE, ROOT_A);
    expect(block).toEqual(WIRE_TRIPLET_FIXTURE);
  });

  it("calls /v1/block/<root> with the correct root", async () => {
    const { fetch: stubFetch, calls } = stubOk(WIRE_TRIPLET_FIXTURE);
    const transport = createHttpTransport({ fetch: stubFetch });
    await transport.fetchBlock(REMOTE, ROOT_A);
    expect(calls[0]).toBe(`https://peer.example.com/v1/block/${ROOT_A}`);
  });

  it("passes artifactBytes through without modification (transport is not the integrity gate)", async () => {
    const { fetch: stubFetch } = stubOk(WIRE_TRIPLET_FIXTURE);
    const transport = createHttpTransport({ fetch: stubFetch });
    const block = await transport.fetchBlock(REMOTE, ROOT_A);
    expect(block.artifactBytes).toEqual(WIRE_TRIPLET_FIXTURE.artifactBytes);
  });
});

// ---------------------------------------------------------------------------
// (5) fetchSpec — happy path
// ---------------------------------------------------------------------------

describe("createHttpTransport — fetchSpec", () => {
  it("returns BlockMerkleRoot[] from the wire envelope on 200 OK", async () => {
    const wireEnvelope = {
      specHash: SPEC_HASH,
      blockMerkleRoots: [ROOT_A, ROOT_B],
    };
    const { fetch: stubFetch } = stubOk(wireEnvelope);
    const transport = createHttpTransport({ fetch: stubFetch });
    const roots = await transport.fetchSpec(REMOTE, SPEC_HASH);
    expect(roots).toEqual([ROOT_A, ROOT_B]);
  });

  it("calls /v1/spec/<specHash> with the correct hash", async () => {
    const wireEnvelope = { specHash: SPEC_HASH, blockMerkleRoots: [ROOT_A] };
    const { fetch: stubFetch, calls } = stubOk(wireEnvelope);
    const transport = createHttpTransport({ fetch: stubFetch });
    await transport.fetchSpec(REMOTE, SPEC_HASH);
    expect(calls[0]).toBe(`https://peer.example.com/v1/spec/${SPEC_HASH}`);
  });

  // (6) fetchSpec 404 → empty array
  it("returns [] on 404 (peer has no blocks for spec — normal per FEDERATION_PROTOCOL.md §3)", async () => {
    const { fetch: stubFetch } = stubStatus(404, { error: "not_found", message: "no blocks" });
    const transport = createHttpTransport({ fetch: stubFetch });
    const roots = await transport.fetchSpec(REMOTE, SPEC_HASH);
    expect(roots).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// (7) Error envelope passthrough
// ---------------------------------------------------------------------------

describe("createHttpTransport — error envelope passthrough", () => {
  it("throws TransportError with wire code on non-2xx with { error, message } envelope", async () => {
    const envelope = { error: "rate_limited", message: "slow down" };
    const { fetch: stubFetch } = stubStatus(429, envelope);
    const transport = createHttpTransport({ fetch: stubFetch });

    await expect(transport.fetchManifest(REMOTE)).rejects.toBeInstanceOf(TransportError);

    try {
      await transport.fetchManifest(REMOTE);
    } catch (err) {
      expect(err).toBeInstanceOf(TransportError);
      expect((err as TransportError).code).toBe("rate_limited");
      expect((err as TransportError).message).toContain("slow down");
    }
  });

  it("preserves the wire error code 'version_mismatch'", async () => {
    const { fetch: stubFetch } = stubStatus(400, {
      error: "version_mismatch",
      message: "schemaVersion 3 is incompatible",
    });
    const transport = createHttpTransport({ fetch: stubFetch });

    try {
      await transport.fetchManifest(REMOTE);
    } catch (err) {
      expect(err).toBeInstanceOf(TransportError);
      expect((err as TransportError).code).toBe("version_mismatch");
    }
  });

  it("preserves the wire error code 'not_found' for fetchBlock 404", async () => {
    const { fetch: stubFetch } = stubStatus(404, { error: "not_found", message: "no such block" });
    const transport = createHttpTransport({ fetch: stubFetch });

    try {
      await transport.fetchBlock(REMOTE, ROOT_A);
    } catch (err) {
      expect(err).toBeInstanceOf(TransportError);
      expect((err as TransportError).code).toBe("not_found");
    }
  });

  it("preserves the wire error code 'internal_error'", async () => {
    const { fetch: stubFetch } = stubStatus(500, { error: "internal_error", message: "oops" });
    const transport = createHttpTransport({ fetch: stubFetch });

    try {
      await transport.fetchManifest(REMOTE);
    } catch (err) {
      expect(err).toBeInstanceOf(TransportError);
      expect((err as TransportError).code).toBe("internal_error");
    }
  });
});

// ---------------------------------------------------------------------------
// (8) Non-2xx without valid envelope → internal_error
// ---------------------------------------------------------------------------

describe("createHttpTransport — non-2xx without valid error envelope", () => {
  it("throws TransportError(code='internal_error') when JSON body has no 'error' field", async () => {
    const { fetch: stubFetch } = stubStatus(503, { something: "wrong" });
    const transport = createHttpTransport({ fetch: stubFetch });

    try {
      await transport.fetchManifest(REMOTE);
    } catch (err) {
      expect(err).toBeInstanceOf(TransportError);
      expect((err as TransportError).code).toBe("internal_error");
    }
  });

  it("throws TransportError(code='internal_error') for non-2xx with empty JSON object", async () => {
    const { fetch: stubFetch } = stubStatus(502, {});
    const transport = createHttpTransport({ fetch: stubFetch });

    try {
      await transport.fetchManifest(REMOTE);
    } catch (err) {
      expect(err).toBeInstanceOf(TransportError);
      expect((err as TransportError).code).toBe("internal_error");
    }
  });
});

// ---------------------------------------------------------------------------
// (9) Non-2xx with non-JSON body → internal_error
// ---------------------------------------------------------------------------

describe("createHttpTransport — non-2xx with non-JSON body", () => {
  it("throws TransportError(code='internal_error') when body cannot be parsed as JSON", async () => {
    const { fetch: stubFetch } = stubNonJsonError(500, "<html>Internal Server Error</html>");
    const transport = createHttpTransport({ fetch: stubFetch });

    try {
      await transport.fetchManifest(REMOTE);
    } catch (err) {
      expect(err).toBeInstanceOf(TransportError);
      expect((err as TransportError).code).toBe("internal_error");
    }
  });
});

// ---------------------------------------------------------------------------
// (11) Compound-interaction: catalog cursor pagination flow
// ---------------------------------------------------------------------------

describe("createHttpTransport — compound interaction: full catalog pagination flow", () => {
  /**
   * This test exercises the real production sequence for catalog enumeration:
   *
   *   1. Caller fetches first page (after=null)
   *      → server returns { blocks: [ROOT_A], nextCursor: ROOT_B }
   *   2. Caller fetches second page using ROOT_B as cursor (after=ROOT_B)
   *      → server returns { blocks: [ROOT_B], nextCursor: null }
   *   3. Caller sees nextCursor=null → pagination complete.
   *
   * Exercises URL builder, fetch dispatch, JSON parse, and CatalogPage shape
   * across two sequential method calls, mirroring how mirrorRegistry drives
   * the transport in production.
   */
  it("two-page pagination flow produces correct URLs and correct data per page", async () => {
    const page1: CatalogPage = { blocks: [ROOT_A], nextCursor: ROOT_B };
    const page2: CatalogPage = { blocks: [ROOT_B], nextCursor: null };

    let callCount = 0;
    const capturedUrls: string[] = [];
    const stubFetch = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      capturedUrls.push(url);
      const body = callCount === 0 ? page1 : page2;
      callCount++;
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const transport = createHttpTransport({ fetch: stubFetch });

    // Page 1: no cursor
    const result1 = await transport.fetchCatalogPage(REMOTE, null, 1000);
    expect(result1.blocks).toEqual([ROOT_A]);
    expect(result1.nextCursor).toBe(ROOT_B);
    expect(capturedUrls[0]).toContain("/v1/blocks");
    expect(capturedUrls[0]).not.toContain("after=");

    // Page 2: cursor from page 1
    const result2 = await transport.fetchCatalogPage(REMOTE, result1.nextCursor, 1000);
    expect(result2.blocks).toEqual([ROOT_B]);
    expect(result2.nextCursor).toBeNull();
    expect(capturedUrls[1]).toContain("after=");
    expect(capturedUrls[1]).toContain(ROOT_B);

    // Both calls hit the same /v1/blocks endpoint
    expect(capturedUrls).toHaveLength(2);
    expect(capturedUrls[0]).toMatch(/\/v1\/blocks\?/);
    expect(capturedUrls[1]).toMatch(/\/v1\/blocks\?/);
  });
});

// ---------------------------------------------------------------------------
// (12) getSchemaVersion — GET /schema-version
// DEC-TRANSPORT-SCHEMA-VERSION-020: first call mirrorRegistry makes; aborts
// if remote schema version > local SCHEMA_VERSION.
// ---------------------------------------------------------------------------

describe("createHttpTransport — getSchemaVersion", () => {
  it("parses { schemaVersion } and calls the correct /schema-version URL", async () => {
    const schemaVersionBody = { schemaVersion: 5 };
    const { fetch: stubFetch, calls } = stubOk(schemaVersionBody);
    const transport = createHttpTransport({ fetch: stubFetch });

    const result = await transport.getSchemaVersion("https://peer.example.com");

    expect(result.schemaVersion).toBe(5);
    expect(calls[0]).toBe("https://peer.example.com/schema-version");
  });
});

// ---------------------------------------------------------------------------
// (10) URL construction — URL builders emit correct paths (smoke tests)
// ---------------------------------------------------------------------------

describe("createHttpTransport — URL construction (smoke tests)", () => {
  it("fetchManifest hits /v1/manifest", async () => {
    const { fetch: stubFetch, calls } = stubOk(MANIFEST_FIXTURE);
    await createHttpTransport({ fetch: stubFetch }).fetchManifest("https://a.example");
    expect(calls[0]).toBe("https://a.example/v1/manifest");
  });

  it("fetchBlock hits /v1/block/<root>", async () => {
    const { fetch: stubFetch, calls } = stubOk(WIRE_TRIPLET_FIXTURE);
    await createHttpTransport({ fetch: stubFetch }).fetchBlock("https://a.example", ROOT_A);
    expect(calls[0]).toBe(`https://a.example/v1/block/${ROOT_A}`);
  });

  it("fetchSpec hits /v1/spec/<specHash>", async () => {
    const envelope = { specHash: SPEC_HASH, blockMerkleRoots: [] };
    const { fetch: stubFetch, calls } = stubOk(envelope);
    await createHttpTransport({ fetch: stubFetch }).fetchSpec("https://a.example", SPEC_HASH);
    expect(calls[0]).toBe(`https://a.example/v1/spec/${SPEC_HASH}`);
  });
});
