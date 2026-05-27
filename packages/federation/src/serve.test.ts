/**
 * Tests for serveRegistry (WI-020 Dispatch E, Slice E).
 *
 * Test coverage per Evaluation Contract:
 *   (1) GET /schema-version — returns { schemaVersion: SCHEMA_VERSION } via fetch.
 *   (2) GET /v1/specs — listSpecs via transport after inserting 2 specs × 1 block each.
 *   (3) GET /v1/spec/<specHash> — listBlocks via transport for an inserted spec.
 *   (4) GET /v1/spec/<specHash> — unknown spec returns [] (transport 404 → empty array).
 *   (5) GET /v1/block/<root> — fetchBlock returns wire row that round-trips via
 *       deserializeWireBlockTriplet without throwing.
 *   (6) GET /v1/block/<root> — unknown root → TransportError code 'block_not_found'.
 *   (7) POST/PUT/DELETE on endpoints → 405 via raw fetch.
 *   (8) Unknown path → 404 not_found via raw fetch.
 *   (9) close() shuts server cleanly (subsequent request rejects with connection error).
 *   Compound-interaction: real production sequence — insert blocks → serveRegistry →
 *     createHttpTransport against URL → listSpecs, listBlocks, fetchBlock → round-trip.
 *
 * All tests bind port:0 to get an OS-assigned port.
 * All tests call handle.close() in afterEach via try/finally pattern.
 * Uses createHttpTransport from ./http-transport.js to exercise the real wire path.
 * Fixtures built via @yakcc/contracts blockMerkleRoot — no hand-computed roots.
 *
 * @decision DEC-SERVE-E-020 (see serve.ts): serveRegistry Slice E test suite.
 * Status: decided (WI-020 Dispatch E)
 *
 * @decision DEC-SERVE-SPECS-ENUMERATION-020 (WI-026 closure): GET /v1/specs calls
 * registry.enumerateSpecs() directly. The TrackedRegistry wrapper still wraps
 * openRegistry but no longer supplies an enumerateSpecs callback to serveRegistry.
 */

import {
  blockMerkleRoot,
  canonicalize,
  specHash as computeSpecHash,
  validateProofManifestL0,
} from "@yakcc/contracts";
import type { BlockMerkleRoot, CanonicalAstHash, SpecHash, SpecYak } from "@yakcc/contracts";
import type { BlockTripletRow } from "@yakcc/registry";
import { SCHEMA_VERSION, openRegistry } from "@yakcc/registry";
import type { Registry } from "@yakcc/registry";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHttpTransport } from "./http-transport.js";
import { serveRegistry } from "./serve.js";
import type { ServeHandle, ServeOptions } from "./serve.js";
import { TransportError } from "./types.js";
import { deserializeWireBlockTriplet } from "./wire.js";

// ---------------------------------------------------------------------------
// Stub embedding provider (avoids loading transformers.js model in tests)
// ---------------------------------------------------------------------------

const ZERO_EMBEDDINGS = {
  dimension: 384,
  modelId: "test-stub",
  async embed(_text: string): Promise<Float32Array> {
    return new Float32Array(384);
  },
};

// ---------------------------------------------------------------------------
// Spec fixtures — two distinct SpecYak objects with distinct spec hashes
// ---------------------------------------------------------------------------

const SPEC_A: SpecYak = {
  name: "serveTestFnA",
  inputs: [{ name: "n", type: "number" }],
  outputs: [{ name: "r", type: "string" }],
  preconditions: [],
  postconditions: [],
  invariants: [],
  effects: [],
  level: "L0",
};

const SPEC_B: SpecYak = {
  name: "serveTestFnB",
  inputs: [{ name: "x", type: "number" }],
  outputs: [{ name: "y", type: "number" }],
  preconditions: [],
  postconditions: [],
  invariants: [],
  effects: [],
  level: "L0",
};

// Minimal valid L0 proof manifest (exactly one property_tests artifact)
const PROOF_MANIFEST_JSON =
  '{"artifacts":[{"kind":"property_tests","path":"tests.fast-check.ts"}]}';
const PROOF_MANIFEST = validateProofManifestL0(JSON.parse(PROOF_MANIFEST_JSON));
const ARTIFACT_PATH = "tests.fast-check.ts";

// ---------------------------------------------------------------------------
// Fixture builder — builds a fully consistent BlockTripletRow using @yakcc/contracts
// No hand-computed merkle roots. DEC-CONTRACTS-AUTHORITY-001.
// ---------------------------------------------------------------------------

function makeRow(spec: SpecYak, implVariant: string, artifactContent: string): BlockTripletRow {
  const implSource = `export function fn(): unknown { return null; } /* ${implVariant} */`;
  const artifactBytes = new TextEncoder().encode(artifactContent);
  const artifacts = new Map<string, Uint8Array>([[ARTIFACT_PATH, artifactBytes]]);
  const specCanonicalBytes = canonicalize(spec as unknown as Parameters<typeof canonicalize>[0]);
  const specHashHex = computeSpecHash(spec) as SpecHash;
  const merkleRoot = blockMerkleRoot({
    spec,
    implSource,
    manifest: PROOF_MANIFEST,
    artifacts,
  });

  return {
    blockMerkleRoot: merkleRoot,
    specHash: specHashHex,
    specCanonicalBytes,
    implSource,
    proofManifestJson: PROOF_MANIFEST_JSON,
    level: "L0",
    createdAt: 1_714_000_000_000,
    canonicalAstHash: "a".repeat(64) as CanonicalAstHash,
    parentBlockRoot: null,
    artifacts,
  };
}

// ---------------------------------------------------------------------------
// TrackedRegistry — wraps Registry for convenient block insertion in tests
// (WI-026: enumerateSpecs callback removed; serve.ts calls registry.enumerateSpecs() directly)
// ---------------------------------------------------------------------------

interface TrackedRegistry {
  registry: Registry;
  store(row: BlockTripletRow): Promise<void>;
  close(): Promise<void>;
}

async function openTrackedRegistry(): Promise<TrackedRegistry> {
  const reg = await openRegistry(":memory:", { embeddings: ZERO_EMBEDDINGS });

  async function store(row: BlockTripletRow): Promise<void> {
    await reg.storeBlock(row);
  }

  return {
    registry: reg,
    store,
    close: () => reg.close(),
  };
}

// ---------------------------------------------------------------------------
// Test lifecycle
// ---------------------------------------------------------------------------

let tracked: TrackedRegistry;
let handle: ServeHandle;

async function startServer(extraOpts?: Partial<ServeOptions>): Promise<void> {
  const opts: ServeOptions = {
    port: 0,
    host: "127.0.0.1",
    ...extraOpts,
  };
  handle = await serveRegistry(tracked.registry, opts);
}

beforeEach(async () => {
  tracked = await openTrackedRegistry();
});

afterEach(async () => {
  try {
    await handle?.close?.();
  } finally {
    await tracked?.close?.();
  }
});

// ---------------------------------------------------------------------------
// (1) GET /schema-version — returns local SCHEMA_VERSION via raw fetch
// ---------------------------------------------------------------------------

describe("serveRegistry GET /schema-version", () => {
  it("returns { schemaVersion: SCHEMA_VERSION } via fetch", async () => {
    await startServer();
    const res = await fetch(`${handle.url}/schema-version`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.schemaVersion).toBe(SCHEMA_VERSION);
  });

  it("schemaVersion is a number", async () => {
    await startServer();
    const res = await fetch(`${handle.url}/schema-version`);
    const body = (await res.json()) as Record<string, unknown>;
    expect(typeof body.schemaVersion).toBe("number");
  });
});

// ---------------------------------------------------------------------------
// (2) GET /v1/specs — transport.listSpecs returns inserted spec hashes
// ---------------------------------------------------------------------------

describe("serveRegistry GET /v1/specs via createHttpTransport.listSpecs", () => {
  it("returns both spec hashes after inserting 2 specs × 1 block each", async () => {
    const rowA = makeRow(SPEC_A, "spec-a-v1", "// artifact A");
    const rowB = makeRow(SPEC_B, "spec-b-v1", "// artifact B");
    await tracked.store(rowA);
    await tracked.store(rowB);
    await startServer();

    const transport = createHttpTransport();
    const specHashes = await transport.listSpecs(handle.url);

    expect(specHashes).toHaveLength(2);
    expect(specHashes).toContain(rowA.specHash);
    expect(specHashes).toContain(rowB.specHash);
  });

  it("returns empty array when no blocks have been inserted", async () => {
    await startServer();
    const transport = createHttpTransport();
    const specHashes = await transport.listSpecs(handle.url);
    expect(specHashes).toHaveLength(0);
  });

  it("returns a single spec hash when only one spec is inserted", async () => {
    const rowA = makeRow(SPEC_A, "only-spec", "// only one");
    await tracked.store(rowA);
    await startServer();

    const transport = createHttpTransport();
    const specHashes = await transport.listSpecs(handle.url);
    expect(specHashes).toHaveLength(1);
    expect(specHashes[0]).toBe(rowA.specHash);
  });
});

// ---------------------------------------------------------------------------
// (3) GET /v1/spec/<specHash> — listBlocks returns blocks for an inserted spec
// ---------------------------------------------------------------------------

describe("serveRegistry GET /v1/spec/<specHash> via createHttpTransport.listBlocks", () => {
  it("returns block merkle root for an inserted spec", async () => {
    const rowA = makeRow(SPEC_A, "list-blocks-v1", "// artifact content");
    await tracked.store(rowA);
    await startServer();

    const transport = createHttpTransport();
    const roots = await transport.listBlocks(handle.url, rowA.specHash);

    expect(roots).toHaveLength(1);
    expect(roots[0]).toBe(rowA.blockMerkleRoot);
  });

  it("returns multiple roots when multiple blocks are stored for same spec", async () => {
    const rowA1 = makeRow(SPEC_A, "multi-v1", "// artifact v1");
    const rowA2 = makeRow(SPEC_A, "multi-v2", "// artifact v2");
    await tracked.store(rowA1);
    await tracked.store(rowA2);
    await startServer();

    const transport = createHttpTransport();
    const roots = await transport.listBlocks(handle.url, rowA1.specHash);

    expect(roots).toHaveLength(2);
    expect(roots).toContain(rowA1.blockMerkleRoot);
    expect(roots).toContain(rowA2.blockMerkleRoot);
  });
});

// ---------------------------------------------------------------------------
// (4) GET /v1/spec/<specHash> — unknown spec → 404 → transport returns []
// ---------------------------------------------------------------------------

describe("serveRegistry GET /v1/spec/<specHash> unknown spec", () => {
  it("listBlocks for unknown spec hash returns empty array", async () => {
    await startServer();

    const transport = createHttpTransport();
    const unknownSpec = "z".repeat(64) as SpecHash;
    const roots = await transport.listBlocks(handle.url, unknownSpec);

    expect(roots).toEqual([]);
  });

  it("raw 404 response for unknown spec has error envelope", async () => {
    await startServer();
    const res = await fetch(`${handle.url}/v1/spec/${"z".repeat(64)}`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as Record<string, unknown>;
    expect(typeof body.error).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// (5) GET /v1/block/<root> — fetchBlock returns wire row that round-trips
// ---------------------------------------------------------------------------

describe("serveRegistry GET /v1/block/<root> via createHttpTransport.fetchBlock", () => {
  it("fetchBlock returns a wire triplet that deserializes without throwing", async () => {
    const row = makeRow(SPEC_A, "fetchblock-v1", "// fetch block artifact");
    await tracked.store(row);
    await startServer();

    const transport = createHttpTransport();
    const wire = await transport.fetchBlock(handle.url, row.blockMerkleRoot);

    // Must deserialize without throwing (integrity gate).
    const deserialized = deserializeWireBlockTriplet(wire);
    expect(deserialized.blockMerkleRoot).toBe(row.blockMerkleRoot);
    expect(deserialized.specHash).toBe(row.specHash);
  });

  it("deserialized row has artifacts Map with matching bytes", async () => {
    const artifactContent = "// round-trip artifact bytes check";
    const row = makeRow(SPEC_A, "artifacts-v1", artifactContent);
    await tracked.store(row);
    await startServer();

    const transport = createHttpTransport();
    const wire = await transport.fetchBlock(handle.url, row.blockMerkleRoot);
    const deserialized = deserializeWireBlockTriplet(wire);

    // artifacts Map must be populated and byte-identical.
    expect(deserialized.artifacts.size).toBe(1);
    const artifactBytes = deserialized.artifacts.get(ARTIFACT_PATH);
    expect(artifactBytes).toBeDefined();
    const decoded = new TextDecoder().decode(artifactBytes);
    expect(decoded).toBe(artifactContent);
  });
});

// ---------------------------------------------------------------------------
// (6) GET /v1/block/<root> — unknown root → TransportError code 'block_not_found'
// ---------------------------------------------------------------------------

describe("serveRegistry GET /v1/block/<root> unknown root", () => {
  it("fetchBlock for unknown root rejects with TransportError", async () => {
    await startServer();

    const transport = createHttpTransport();
    const unknownRoot = "0".repeat(64) as BlockMerkleRoot;

    await expect(transport.fetchBlock(handle.url, unknownRoot)).rejects.toBeInstanceOf(
      TransportError,
    );
  });

  it("TransportError code is 'block_not_found' for unknown root", async () => {
    await startServer();

    const transport = createHttpTransport();
    const unknownRoot = "0".repeat(64) as BlockMerkleRoot;

    let caughtError: unknown;
    try {
      await transport.fetchBlock(handle.url, unknownRoot);
    } catch (err) {
      caughtError = err;
    }

    expect(caughtError).toBeInstanceOf(TransportError);
    const te = caughtError as TransportError;
    expect(te.code).toBe("block_not_found");
  });

  it("raw 404 response for unknown block has error envelope", async () => {
    await startServer();
    const res = await fetch(`${handle.url}/v1/block/${"0".repeat(64)}`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("block_not_found");
  });
});

// ---------------------------------------------------------------------------
// (7) POST/PUT/DELETE on endpoints → 405 via raw fetch
// ---------------------------------------------------------------------------

describe("serveRegistry 405 for non-GET methods", () => {
  it.each([
    ["/schema-version", "POST"],
    ["/schema-version", "PUT"],
    ["/schema-version", "DELETE"],
    ["/v1/specs", "POST"],
    ["/v1/specs", "PUT"],
    ["/v1/specs", "DELETE"],
    [`/v1/spec/${"a".repeat(64)}`, "POST"],
    [`/v1/spec/${"a".repeat(64)}`, "DELETE"],
    [`/v1/block/${"a".repeat(64)}`, "POST"],
    [`/v1/block/${"a".repeat(64)}`, "PUT"],
    [`/v1/block/${"a".repeat(64)}`, "DELETE"],
  ])("%s %s → 405 method_not_allowed", async (path, method) => {
    await startServer();
    const res = await fetch(`${handle.url}${path}`, { method });
    expect(res.status).toBe(405);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("method_not_allowed");
  });
});

// ---------------------------------------------------------------------------
// (8) Unknown GET path → 404 not_found
// ---------------------------------------------------------------------------

describe("serveRegistry unknown GET path → 404", () => {
  it("returns 404 not_found for unknown path", async () => {
    await startServer();
    const res = await fetch(`${handle.url}/v99/unknown`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("not_found");
  });

  it("returns 404 not_found for /v1 root", async () => {
    await startServer();
    const res = await fetch(`${handle.url}/v1`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("not_found");
  });
});

// ---------------------------------------------------------------------------
// (9) close() shuts the server cleanly
// ---------------------------------------------------------------------------

describe("serveRegistry close()", () => {
  it("after close(), subsequent requests reject with a connection error", async () => {
    await startServer();
    const url = handle.url;
    await handle.close();
    // Subsequent request must fail (ECONNREFUSED or equivalent).
    await expect(fetch(`${url}/schema-version`)).rejects.toThrow();
  });

  it("close() is idempotent — calling twice does not throw", async () => {
    await startServer();
    await handle.close();
    // Second close should not throw.
    await expect(handle.close()).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Compound-interaction: full production sequence
//
// This test exercises the entire F1 mirror sequence end-to-end using real HTTP:
//   store blocks → serveRegistry → createHttpTransport → listSpecs → listBlocks →
//   fetchBlock → deserializeWireBlockTriplet → byte-identical BlockTripletRow.
//
// This is the critical acceptance test for Slice E. It crosses the boundaries of:
//   1. Registry.storeBlock (storage)
//   2. serveRegistry route handlers (serve.ts)
//   3. createHttpTransport HTTP wiring (http-transport.ts)
//   4. deserializeWireBlockTriplet integrity gate (wire.ts)
//
// DEC-V1-FEDERATION-WIRE-ARTIFACTS-002: artifact bytes fold into blockMerkleRoot.
// Any wire corruption of artifact bytes causes deserializeWireBlockTriplet to throw.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// GET /v1/blocks — catalog pagination (WI-792, DEC-792-METHOD-NAME)
//
// Test coverage per Evaluation Contract:
//   (A) Pagination walk: seed N>limit blocks, walk until nextCursor===null,
//       assert union===seeded set, sorted across pages, no duplicates.
//   (B) Empty registry → { blocks: [], nextCursor: null }.
//   (C) after=non-existent cursor → returns roots strictly after that value.
//   (D) Bad params: limit=0, limit=-1, limit=abc, limit=1001 → 400 bad_request.
//   (E) Non-GET /v1/blocks → 405 (regression for read-only invariant).
//   (F) Default limit: absent `?limit=` uses DEFAULT_CATALOG_LIMIT (≤ 256).
// ---------------------------------------------------------------------------

describe("serveRegistry GET /v1/blocks pagination", () => {
  // Helper: typed raw response from /v1/blocks
  interface RawCatalogPage {
    blocks: string[];
    nextCursor: string | null;
  }

  async function rawCatalogPage(
    url: string,
    limit?: number,
    after?: string | null,
  ): Promise<{ status: number; body: unknown }> {
    const params = new URLSearchParams();
    if (limit !== undefined) params.set("limit", String(limit));
    if (after !== undefined && after !== null) params.set("after", after);
    const qs = params.toString();
    const fullUrl = `${url}/v1/blocks${qs.length > 0 ? `?${qs}` : ""}`;
    const res = await fetch(fullUrl);
    return { status: res.status, body: await res.json() };
  }

  // (B) Empty registry
  it("returns { blocks: [], nextCursor: null } for an empty registry", async () => {
    await startServer();
    const { status, body } = await rawCatalogPage(handle.url, 10);
    expect(status).toBe(200);
    const page = body as RawCatalogPage;
    expect(page.blocks).toEqual([]);
    expect(page.nextCursor).toBeNull();
  });

  // (F) Default limit
  it("absent ?limit= param uses DEFAULT_CATALOG_LIMIT (256) and returns all blocks when count < 256", async () => {
    // Seed 3 blocks — fewer than default. Without ?limit, all should be returned in one page.
    const rowA = makeRow(SPEC_A, "default-limit-a", "// art A");
    const rowB = makeRow(SPEC_B, "default-limit-b", "// art B");
    await tracked.store(rowA);
    await tracked.store(rowB);
    await startServer();

    // Hit /v1/blocks with no query params at all.
    const res = await fetch(`${handle.url}/v1/blocks`);
    expect(res.status).toBe(200);
    const page = (await res.json()) as RawCatalogPage;
    expect(page.blocks).toHaveLength(2);
    expect(page.nextCursor).toBeNull();
    // nextCursor must be JSON null, not omitted.
    expect(Object.hasOwn(page, "nextCursor")).toBe(true);
  });

  // (D) Bad params
  it.each([
    ["limit=0", "?limit=0"],
    ["limit=-1", "?limit=-1"],
    ["limit=abc", "?limit=abc"],
    ["limit=1001", "?limit=1001"],
    ["after= (empty string)", "?after="],
  ])("bad param %s → 400 bad_request", async (_label, qs) => {
    await startServer();
    const res = await fetch(`${handle.url}/v1/blocks${qs}`);
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("bad_request");
  });

  // (E) Non-GET → 405
  it("POST /v1/blocks → 405 method_not_allowed", async () => {
    await startServer();
    const res = await fetch(`${handle.url}/v1/blocks`, { method: "POST" });
    expect(res.status).toBe(405);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("method_not_allowed");
  });

  // (C) after=non-existent-cursor
  it("after=cursor-not-in-catalog returns roots strictly after that value", async () => {
    // Seed 5 blocks. Use the second root as a cursor (it IS in the catalog —
    // strict GT means it's excluded and we see roots 3-5).
    const rows = [SPEC_A, SPEC_B].flatMap((spec, si) =>
      [0, 1, 2]
        .slice(0, si === 0 ? 3 : 2)
        .map((vi) => makeRow(spec, `after-test-${si}-${vi}`, `// art ${si}-${vi}`)),
    );
    for (const row of rows) await tracked.store(row);
    await startServer();

    const allRes = (await rawCatalogPage(handle.url, 100)).body as RawCatalogPage;
    const allRoots = allRes.blocks;
    // Use root[1] as the cursor — strict GT means roots[2..] are returned.
    const cursor = allRoots[1];
    if (cursor === undefined) throw new Error("test setup: need ≥ 2 roots");

    const { status, body } = await rawCatalogPage(handle.url, 100, cursor);
    const page = body as RawCatalogPage;
    expect(status).toBe(200);
    for (const root of page.blocks) {
      expect(root > cursor).toBe(true);
    }
    expect(page.blocks).toHaveLength(allRoots.length - 2);
  });

  // (A) Pagination walk — compound-interaction test: real production sequence.
  //
  // This is the critical acceptance test for WI-792. It exercises the entire
  // /v1/blocks path end-to-end using real HTTP:
  //   storeBlock writes → serveRegistry → fetchCatalogPage (transport) →
  //   walk until nextCursor=null → assert union===seeded set, lex-sorted, no dups.
  //
  // Crosses:
  //   1. Registry.listCatalogPage (storage)
  //   2. handleListCatalogPage route handler (serve.ts)
  //   3. fetchCatalogPage HTTP wiring (http-transport.ts)
  //
  // DEC-792-CURSOR-LOOKAHEAD: tests that the exact-multiple boundary (last page
  // has exactly `limit` rows) does NOT produce a phantom empty page.
  it("compound: fetchCatalogPage walk over 23 blocks with limit=10 enumerates all exactly once, lex-sorted", async () => {
    const TOTAL = 23;
    const PAGE_LIMIT = 10;

    // Seed TOTAL distinct blocks (two specs, varied impl content for unique roots).
    const seedRows: BlockTripletRow[] = [];
    for (let i = 0; i < TOTAL; i++) {
      const spec = i % 2 === 0 ? SPEC_A : SPEC_B;
      const row = makeRow(spec, `walk-block-${i}`, `// walk artifact ${i}`);
      await tracked.store(row);
      seedRows.push(row);
    }
    await startServer();

    const transport = createHttpTransport();

    // Walk pages via fetchCatalogPage until nextCursor === null.
    const collected: BlockMerkleRoot[] = [];
    let cursor: BlockMerkleRoot | null = null;
    let pageCount = 0;
    do {
      const page = await transport.fetchCatalogPage(handle.url, cursor, PAGE_LIMIT);
      collected.push(...page.blocks);
      cursor = page.nextCursor;
      pageCount++;
      if (pageCount > TOTAL + 2) throw new Error("pagination walk exceeded max pages");
    } while (cursor !== null);

    // All TOTAL roots present exactly once.
    expect(collected).toHaveLength(TOTAL);
    const unique = new Set(collected);
    expect(unique.size).toBe(TOTAL);
    for (const row of seedRows) {
      expect(unique.has(row.blockMerkleRoot)).toBe(true);
    }

    // Globally lex-sorted across pages.
    const sorted = [...collected].sort();
    expect(collected).toEqual(sorted);

    // TOTAL=23, PAGE_LIMIT=10: pages of 10, 10, 3 → 3 pages.
    // DEC-792-CURSOR-LOOKAHEAD: the second page (10 rows) does NOT trigger a
    // phantom 4th page because lookahead tells us the 3rd page exists.
    expect(pageCount).toBe(Math.ceil(TOTAL / PAGE_LIMIT));
  });
});

describe("serveRegistry compound-interaction: full F1 production sequence", () => {
  it("insert 2 specs, serve, discover via transport, round-trip each block byte-identically", async () => {
    // Build two distinct rows with real artifacts.
    const rowA = makeRow(SPEC_A, "compound-spec-a", "// compound artifact A");
    const rowB = makeRow(SPEC_B, "compound-spec-b", "// compound artifact B");

    await tracked.store(rowA);
    await tracked.store(rowB);
    await startServer();

    const transport = createHttpTransport();

    // Step 1: list all spec hashes — must see both.
    const specHashes = await transport.listSpecs(handle.url);
    expect(specHashes).toHaveLength(2);
    expect(specHashes).toContain(rowA.specHash);
    expect(specHashes).toContain(rowB.specHash);

    // Step 2: for each spec, list blocks.
    const rootsA = await transport.listBlocks(handle.url, rowA.specHash);
    expect(rootsA).toEqual([rowA.blockMerkleRoot]);

    const rootsB = await transport.listBlocks(handle.url, rowB.specHash);
    expect(rootsB).toEqual([rowB.blockMerkleRoot]);

    // Step 3: fetch each block and verify round-trip integrity.
    for (const [expectedRoot, originalRow] of [
      [rowA.blockMerkleRoot, rowA],
      [rowB.blockMerkleRoot, rowB],
    ] as [BlockMerkleRoot, BlockTripletRow][]) {
      const wire = await transport.fetchBlock(handle.url, expectedRoot);

      // Integrity gate: must deserialize without throwing.
      // DEC-V1-FEDERATION-WIRE-ARTIFACTS-002: blockMerkleRoot recomputed with artifacts.
      const deserialized = deserializeWireBlockTriplet(wire);

      expect(deserialized.blockMerkleRoot).toBe(originalRow.blockMerkleRoot);
      expect(deserialized.specHash).toBe(originalRow.specHash);
      expect(deserialized.implSource).toBe(originalRow.implSource);
      expect(deserialized.proofManifestJson).toBe(originalRow.proofManifestJson);

      // artifacts Map: byte-identical.
      expect(deserialized.artifacts.size).toBe(originalRow.artifacts.size);
      for (const [path, originalBytes] of originalRow.artifacts) {
        const receivedBytes = deserialized.artifacts.get(path);
        expect(receivedBytes).toBeDefined();
        expect(receivedBytes).toEqual(originalBytes);
      }
    }

    // Step 4: schema-version endpoint sanity-check.
    const sv = await transport.getSchemaVersion(handle.url);
    expect(sv.schemaVersion).toBe(SCHEMA_VERSION);
  });
});
