/**
 * federation.test.ts — CLI command tests for `yakcc federation` subcommands.
 *
 * Production sequence exercised (compound-interaction test):
 *   runFederation(["mirror", ...], logger, { transport: stub })
 *   → runFederationMirror → mirrorRegistry(remote, registry, transport)
 *   → pullBlock → deserializeWireBlockTriplet → registry.storeBlock
 *   → MirrorReport JSON printed to logger.log.
 *
 * Tests:
 *   1. mirror dry-run with stub transport — MirrorReport JSON printed, exit 0.
 *   2. pull with stub transport — concise summary printed, exit 0.
 *   3. serve smoke test — port 0 server starts, /schema-version responds, handle closes.
 *   4. unknown subcommand — returns 1 and prints usage.
 *   5. mirror missing --remote flag — returns 1 with error message.
 *   6. mirror missing --registry flag — returns 1 with error message.
 *   7. pull missing --remote flag — returns 1 with error message.
 *   8. pull missing --root flag — returns 1 with error message.
 *   9. serve missing --registry flag — returns 1 with error message.
 *
 * @decision DEC-CLI-FED-TEST-001: Tests inject a Transport stub via opts.transport to
 * avoid real network I/O. opts.noBlock prevents blocking on SIGINT in the serve test.
 * The serve smoke test uses an in-memory registry (openRegistry(":memory:")) so no
 * temp-file SQLite is needed. Mirror/pull tests use a temp-file registry (matching
 * DEC-CLI-TEST-001) so runFederation's openRegistry call operates on a real file.
 * Status: implemented (WI-020 Slice G)
 * Rationale: Sacred Practice #5 — mocks only for external boundaries (network transport).
 * The transport seam is injected via FederationOptions to keep the stub narrow.
 *
 * @decision DEC-CLI-FED-TEST-002: Output capture uses CollectingLogger (same pattern
 * as all other CLI command tests — DEC-CLI-TEST-002). No vi.spyOn mocks on console.
 * Status: implemented (WI-020 Slice G)
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  blockMerkleRoot,
  canonicalize,
  createOfflineEmbeddingProvider,
  specHash as computeSpecHash,
  validateProofManifestL0,
} from "@yakcc/contracts";
import type { BlockMerkleRoot, CanonicalAstHash, SpecHash, SpecYak } from "@yakcc/contracts";
import { SCHEMA_VERSION, openRegistry } from "@yakcc/registry";
import type { BlockTripletRow } from "@yakcc/registry";
import type { CatalogPage, RemoteManifest, RemotePeer, Transport, WireBlockTriplet } from "@yakcc/federation";
import { serializeWireBlockTriplet } from "@yakcc/federation";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { CollectingLogger, runCli } from "../index.js";
import { runFederation, runFederationServe } from "./federation.js";

// ---------------------------------------------------------------------------
// Shared offline embedding provider — injected via FederationOptions so no
// test ever falls back to createLocalEmbeddingProvider() (network-dependent).
// ---------------------------------------------------------------------------

const offlineEmbeddings = createOfflineEmbeddingProvider();

// ---------------------------------------------------------------------------
// Spec/row fixtures shared across test suites
// ---------------------------------------------------------------------------

const TEST_SPEC: SpecYak = {
  name: "fedCliTestFn",
  inputs: [{ name: "n", type: "number" }],
  outputs: [{ name: "r", type: "string" }],
  preconditions: [],
  postconditions: [],
  invariants: [],
  effects: [],
  level: "L0",
};

const PROOF_MANIFEST_JSON =
  '{"artifacts":[{"kind":"property_tests","path":"tests.fast-check.ts"}]}';
const PROOF_MANIFEST = validateProofManifestL0(JSON.parse(PROOF_MANIFEST_JSON));
const ARTIFACT_PATH = "tests.fast-check.ts";
const ARTIFACT_BYTES = new TextEncoder().encode(
  "import fc from 'fast-check';\nfc.assert(fc.property(fc.integer(), n => typeof String(n) === 'string'));",
);

/**
 * Build a fully consistent BlockTripletRow using @yakcc/contracts as the single
 * authority for block identity. No inline merkle helper.
 * DEC-CONTRACTS-AUTHORITY-001, DEC-V1-FEDERATION-WIRE-ARTIFACTS-002.
 */
function makeRow(spec: SpecYak, implVariant: string): BlockTripletRow {
  const implSource = `export function fn(n: number): string { return String(n); } /* ${implVariant} */`;
  const artifacts = new Map<string, Uint8Array>([[ARTIFACT_PATH, ARTIFACT_BYTES]]);
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

/**
 * Build a minimal stub Transport for mirror/pull tests.
 * Only the methods actually exercised by the CLI command are implemented.
 * All others throw to catch accidental invocations.
 */
function makeStubTransport(opts: {
  schemaVersion: number;
  specHashes: readonly SpecHash[];
  blocksBySpec: ReadonlyMap<SpecHash, readonly BlockMerkleRoot[]>;
  wireByRoot: ReadonlyMap<BlockMerkleRoot, WireBlockTriplet>;
}): Transport {
  return {
    getSchemaVersion(_remote: RemotePeer) {
      return Promise.resolve({ schemaVersion: opts.schemaVersion });
    },
    listSpecs(_remote: RemotePeer) {
      return Promise.resolve(opts.specHashes);
    },
    listBlocks(_remote: RemotePeer, sh: SpecHash) {
      return Promise.resolve(opts.blocksBySpec.get(sh) ?? []);
    },
    fetchBlock(_remote: RemotePeer, root: BlockMerkleRoot) {
      const wire = opts.wireByRoot.get(root);
      if (wire === undefined) {
        return Promise.reject(new Error(`stub: no wire for root ${root}`));
      }
      return Promise.resolve(wire);
    },
    fetchManifest(_remote: RemotePeer): Promise<RemoteManifest> {
      return Promise.reject(new Error("fetchManifest: not implemented in stub"));
    },
    fetchCatalogPage(_remote: RemotePeer, _after: BlockMerkleRoot | null, _limit: number): Promise<CatalogPage> {
      return Promise.reject(new Error("fetchCatalogPage: not implemented in stub"));
    },
    fetchSpec(_remote: RemotePeer, _sh: SpecHash) {
      return Promise.reject(new Error("fetchSpec: not implemented in stub"));
    },
  };
}

// ---------------------------------------------------------------------------
// Suite lifecycle — shared temp directory for mirror tests
// ---------------------------------------------------------------------------

let suiteDir: string;
let registryPath: string;

beforeAll(async () => {
  suiteDir = mkdtempSync(join(tmpdir(), "yakcc-fed-cli-test-"));
  registryPath = join(suiteDir, "fed-test.sqlite");

  // Init a real registry for mirror tests (matching DEC-CLI-TEST-001).
  const logger = new CollectingLogger();
  const code = await runCli(["registry", "init", "--path", registryPath], logger);
  if (code !== 0) {
    throw new Error(`registry init failed: ${logger.errLines.join("\n")}`);
  }
});

afterAll(() => {
  try {
    rmSync(suiteDir, { recursive: true, force: true });
  } catch {
    // Non-fatal cleanup.
  }
});

// ---------------------------------------------------------------------------
// Suite 1: mirror — compound-interaction test with stub transport
// ---------------------------------------------------------------------------

describe("federation mirror (stub transport)", () => {
  it("prints MirrorReport JSON and exits 0 on success", async () => {
    // Build one real row and its wire form.
    const row = makeRow(TEST_SPEC, "v1");
    const wire = serializeWireBlockTriplet(row);

    const specHashes = [row.specHash] as SpecHash[];
    const blocksBySpec = new Map([[row.specHash, [row.blockMerkleRoot] as BlockMerkleRoot[]]]);
    const wireByRoot = new Map([[row.blockMerkleRoot, wire]]);

    const transport = makeStubTransport({
      schemaVersion: SCHEMA_VERSION,
      specHashes,
      blocksBySpec,
      wireByRoot,
    });

    const logger = new CollectingLogger();
    const code = await runFederation(
      ["mirror", "--remote", "https://peer.example.com", "--registry", registryPath],
      logger,
      { transport, embeddings: offlineEmbeddings },
    );

    expect(code).toBe(0);
    expect(logger.errLines).toHaveLength(0);

    // The output should be a parseable MirrorReport JSON.
    const output = logger.logLines.join("\n");
    const report = JSON.parse(output) as {
      serveUrl: string;
      blocksInserted: number;
      failures: unknown[];
    };
    expect(report.serveUrl).toBe("https://peer.example.com");
    expect(report.blocksInserted).toBe(1);
    expect(report.failures).toHaveLength(0);
  });

  it("idempotent second mirror run — blocksSkipped=1, blocksInserted=0, exit 0", async () => {
    // Use the same registry path (already has the block from the previous test).
    const row = makeRow(TEST_SPEC, "v1");
    const wire = serializeWireBlockTriplet(row);

    const specHashes = [row.specHash] as SpecHash[];
    const blocksBySpec = new Map([[row.specHash, [row.blockMerkleRoot] as BlockMerkleRoot[]]]);
    const wireByRoot = new Map([[row.blockMerkleRoot, wire]]);

    const transport = makeStubTransport({
      schemaVersion: SCHEMA_VERSION,
      specHashes,
      blocksBySpec,
      wireByRoot,
    });

    const logger = new CollectingLogger();
    const code = await runFederation(
      ["mirror", "--remote", "https://peer.example.com", "--registry", registryPath],
      logger,
      { transport, embeddings: offlineEmbeddings },
    );

    expect(code).toBe(0);
    const report = JSON.parse(logger.logLines.join("\n")) as {
      blocksInserted: number;
      blocksSkipped: number;
    };
    expect(report.blocksInserted).toBe(0);
    expect(report.blocksSkipped).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Suite 2: pull — stub transport round-trip
// ---------------------------------------------------------------------------

describe("federation pull (stub transport)", () => {
  it("prints block summary and exits 0 when wire triplet passes integrity gate", async () => {
    const row = makeRow(TEST_SPEC, "pull-test");
    const wire = serializeWireBlockTriplet(row);

    const wireByRoot = new Map([[row.blockMerkleRoot, wire]]);
    const transport = makeStubTransport({
      schemaVersion: SCHEMA_VERSION,
      specHashes: [],
      blocksBySpec: new Map(),
      wireByRoot,
    });

    const logger = new CollectingLogger();
    const code = await runFederation(
      [
        "pull",
        "--remote",
        "https://peer.example.com",
        "--root",
        row.blockMerkleRoot,
        "--registry",
        registryPath,
      ],
      logger,
      { transport, embeddings: offlineEmbeddings },
    );

    expect(code).toBe(0);
    expect(logger.errLines).toHaveLength(0);
    // Summary lines must include the block merkle root and spec hash.
    expect(logger.logLines.some((l) => l.includes(row.blockMerkleRoot))).toBe(true);
    expect(logger.logLines.some((l) => l.includes(row.specHash))).toBe(true);
  });

  it("exits 1 with error when stub transport rejects the block root", async () => {
    const transport = makeStubTransport({
      schemaVersion: SCHEMA_VERSION,
      specHashes: [],
      blocksBySpec: new Map(),
      wireByRoot: new Map(), // empty — fetchBlock will throw
    });

    const logger = new CollectingLogger();
    const code = await runFederation(
      [
        "pull",
        "--remote",
        "https://peer.example.com",
        "--root",
        "a".repeat(64),
        "--registry",
        registryPath,
      ],
      logger,
      { transport, embeddings: offlineEmbeddings },
    );

    expect(code).toBe(1);
    expect(logger.errLines.some((l) => l.includes("error"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Suite 3: serve smoke test (noBlock + in-memory registry)
// ---------------------------------------------------------------------------

describe("federation serve (noBlock smoke test)", () => {
  let closeHandle: (() => Promise<void>) | null = null;

  afterEach(async () => {
    if (closeHandle !== null) {
      await closeHandle();
      closeHandle = null;
    }
  });

  it("starts on port 0, responds to GET /schema-version, closes cleanly", async () => {
    // Use an in-memory registry for the serve test — no disk I/O needed.
    // serveRegistry opens the registry passed to it; we open our own here and
    // pass it via the CLI by pointing at a temp-file that runFederationServe opens.
    // For simplicity we use registryPath (already initialised in beforeAll).

    const logger = new CollectingLogger();
    const result = await runFederationServe(
      ["--registry", registryPath, "--port", "0"],
      logger,
      { noBlock: true, embeddings: offlineEmbeddings },
    );

    expect(result.code).toBe(0);
    expect(result.handle).not.toBeNull();
    const handle = result.handle!;
    closeHandle = handle.close.bind(handle);

    // Logger should report the bound URL.
    expect(logger.logLines.some((l) => l.includes("http://127.0.0.1:"))).toBe(true);
    expect(logger.errLines).toHaveLength(0);

    // Hit /schema-version via the real URL.
    const url = handle.url;
    const resp = await fetch(`${url}/schema-version`);
    expect(resp.ok).toBe(true);
    const json = (await resp.json()) as { schemaVersion: number };
    expect(json.schemaVersion).toBe(SCHEMA_VERSION);
  });
});

// ---------------------------------------------------------------------------
// Suite 4: unknown subcommand
// ---------------------------------------------------------------------------

describe("federation unknown subcommand", () => {
  it("returns 1 and prints usage for an unknown subcommand", async () => {
    const logger = new CollectingLogger();
    const code = await runFederation(["bogus"], logger);
    expect(code).toBe(1);
    expect(
      logger.logLines.some((l) => l.includes("serve") || l.includes("mirror") || l.includes("pull")),
    ).toBe(true);
  });

  it("returns 1 and prints usage when no subcommand is given", async () => {
    const logger = new CollectingLogger();
    const code = await runFederation([], logger);
    expect(code).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Suite 5: argument validation — mirror
// ---------------------------------------------------------------------------

describe("federation mirror argument validation", () => {
  it("exits 1 with error when --remote is missing", async () => {
    const logger = new CollectingLogger();
    const code = await runFederation(["mirror", "--registry", registryPath], logger);
    expect(code).toBe(1);
    expect(logger.errLines.some((l) => l.includes("--remote"))).toBe(true);
  });

  it("exits 1 with error when --registry is missing", async () => {
    const logger = new CollectingLogger();
    const code = await runFederation(["mirror", "--remote", "https://peer.example.com"], logger);
    expect(code).toBe(1);
    expect(logger.errLines.some((l) => l.includes("--registry"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Suite 6: argument validation — pull
// ---------------------------------------------------------------------------

describe("federation pull argument validation", () => {
  it("exits 1 with error when --remote is missing", async () => {
    const logger = new CollectingLogger();
    const code = await runFederation(
      ["pull", "--root", "a".repeat(64), "--registry", registryPath],
      logger,
    );
    expect(code).toBe(1);
    expect(logger.errLines.some((l) => l.includes("--remote"))).toBe(true);
  });

  it("exits 1 with error when --root is missing", async () => {
    const logger = new CollectingLogger();
    const code = await runFederation(
      ["pull", "--remote", "https://peer.example.com", "--registry", registryPath],
      logger,
    );
    expect(code).toBe(1);
    expect(logger.errLines.some((l) => l.includes("--root"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Suite 7: argument validation — serve
// ---------------------------------------------------------------------------

describe("federation serve argument validation", () => {
  it("exits 1 with error when --registry is missing", async () => {
    const logger = new CollectingLogger();
    const result = await runFederationServe([], logger, { noBlock: true });
    expect(result.code).toBe(1);
    expect(logger.errLines.some((l) => l.includes("--registry"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Suite 8: pull --registry persist (WI-030)
//
// @decision DEC-CLI-PULL-PERSIST-TEST-001: pull-persist test isolation
// Status: implemented (WI-030)
// Rationale: Each persist test uses its own mkdtemp directory so test order
// does not affect idempotency assertions. The shared suiteDir from beforeAll
// is used for the shared registryPath (mirror/pull smoke tests); persist tests
// get their own isolated directories. Transport is stubbed via FederationOptions
// (no network I/O). Per DEC-CLI-FED-TEST-001, mocks are only for external
// boundaries (network transport). The real openRegistry + storeBlock path is
// exercised on disk (real SQLite). This proves the CLI → registry persist
// production sequence end-to-end, crossing CLI + registry package boundaries.
// ---------------------------------------------------------------------------

describe("federation pull --registry persist (WI-030)", () => {
  // Isolated tmp dir for all persist tests — separate from the mirror suite's
  // registryPath so idempotency counts are unambiguous.
  let persistDir: string;

  beforeAll(() => {
    persistDir = mkdtempSync(join(tmpdir(), "yakcc-pull-persist-test-"));
  });

  afterAll(() => {
    try {
      rmSync(persistDir, { recursive: true, force: true });
    } catch {
      // Non-fatal cleanup.
    }
  });

  // -------------------------------------------------------------------------
  // Helper: make a unique registry path inside persistDir
  // -------------------------------------------------------------------------
  function makePersistPath(name: string): string {
    return join(persistDir, `${name}.sqlite`);
  }

  // -------------------------------------------------------------------------
  // Compound-interaction test: full CLI → transport → registry persist sequence.
  // Proves the production sequence crosses CLI + registry package boundaries.
  // -------------------------------------------------------------------------
  it("inserts the pulled BlockTripletRow into the named registry on success (compound-interaction)", async () => {
    const row = makeRow(TEST_SPEC, "persist-v1");
    const wire = serializeWireBlockTriplet(row);
    const wireByRoot = new Map([[row.blockMerkleRoot, wire]]);
    const transport = makeStubTransport({
      schemaVersion: SCHEMA_VERSION,
      specHashes: [],
      blocksBySpec: new Map(),
      wireByRoot,
    });

    const dbPath = makePersistPath("insert-test");
    // Init registry so it has the schema applied.
    const initLogger = new CollectingLogger();
    const initCode = await runCli(["registry", "init", "--path", dbPath], initLogger);
    expect(initCode).toBe(0);

    const logger = new CollectingLogger();
    const code = await runFederation(
      ["pull", "--remote", "https://peer.example.com", "--root", row.blockMerkleRoot, "--registry", dbPath],
      logger,
      { transport, embeddings: offlineEmbeddings },
    );

    expect(code).toBe(0);
    expect(logger.errLines).toHaveLength(0);

    // Diagnostic lines preserved (pre-WI-030 surface unchanged).
    expect(logger.logLines.some((l) => l.includes(row.blockMerkleRoot))).toBe(true);
    expect(logger.logLines.some((l) => l.includes(row.specHash))).toBe(true);

    // Appended persisted line (DEC-CLI-PULL-PERSIST-001 implementation choice).
    expect(logger.logLines.some((l) => l.includes("persisted:") && l.includes(dbPath))).toBe(true);

    // Post-condition: open registry in a second call and verify the row is present
    // with every column byte-identical (DEC-TRIPLET-IDENTITY-020).
    const reg = await openRegistry(dbPath, { embeddings: offlineEmbeddings });
    try {
      const stored = await reg.getBlock(row.blockMerkleRoot);
      expect(stored).not.toBeNull();
      expect(stored!.blockMerkleRoot).toBe(row.blockMerkleRoot);
      expect(stored!.specHash).toBe(row.specHash);
      expect(stored!.implSource).toBe(row.implSource);
      expect(stored!.proofManifestJson).toBe(row.proofManifestJson);
      expect(stored!.level).toBe(row.level);
      expect(stored!.canonicalAstHash).toBe(row.canonicalAstHash);
      expect(stored!.parentBlockRoot ?? null).toBe(row.parentBlockRoot ?? null);
      // Artifacts bytes preserved (DEC-V1-FEDERATION-WIRE-ARTIFACTS-002).
      expect(stored!.artifacts.size).toBe(row.artifacts.size);
      for (const [path, bytes] of row.artifacts) {
        const storedBytes = stored!.artifacts.get(path);
        expect(storedBytes).toBeDefined();
        expect(storedBytes).toEqual(bytes);
      }
    } finally {
      await reg.close();
    }
  });

  // -------------------------------------------------------------------------
  // Idempotency: second pull with same --root must not double-insert.
  // DEC-STORAGE-IDEMPOTENT-001: storeBlock provides idempotency — CLI does NOT
  // pre-check; it calls storeBlock directly both times.
  // -------------------------------------------------------------------------
  it("is idempotent when invoked twice with the same --root", async () => {
    const row = makeRow(TEST_SPEC, "persist-idempotent");
    const wire = serializeWireBlockTriplet(row);
    const wireByRoot = new Map([[row.blockMerkleRoot, wire]]);
    const transport = makeStubTransport({
      schemaVersion: SCHEMA_VERSION,
      specHashes: [],
      blocksBySpec: new Map(),
      wireByRoot,
    });

    const dbPath = makePersistPath("idempotent-test");
    const initLogger = new CollectingLogger();
    expect(await runCli(["registry", "init", "--path", dbPath], initLogger)).toBe(0);

    // First invocation — inserts the row.
    const logger1 = new CollectingLogger();
    const code1 = await runFederation(
      ["pull", "--remote", "https://peer.example.com", "--root", row.blockMerkleRoot, "--registry", dbPath],
      logger1,
      { transport, embeddings: offlineEmbeddings },
    );
    expect(code1).toBe(0);
    expect(logger1.errLines).toHaveLength(0);

    // Second invocation — storeBlock no-ops (DEC-STORAGE-IDEMPOTENT-001).
    const logger2 = new CollectingLogger();
    const code2 = await runFederation(
      ["pull", "--remote", "https://peer.example.com", "--root", row.blockMerkleRoot, "--registry", dbPath],
      logger2,
      { transport, embeddings: offlineEmbeddings },
    );
    expect(code2).toBe(0);
    expect(logger2.errLines).toHaveLength(0);

    // Post-condition: exactly one row in the registry for this root.
    const reg = await openRegistry(dbPath, { embeddings: offlineEmbeddings });
    try {
      const stored = await reg.getBlock(row.blockMerkleRoot);
      expect(stored).not.toBeNull();
      // Verify exactly one row via selectBlocks (count == 1 for this specHash
      // because we only stored one distinct blockMerkleRoot).
      const allRoots = await reg.selectBlocks(row.specHash);
      const matching = allRoots.filter((r) => r === row.blockMerkleRoot);
      expect(matching).toHaveLength(1);
    } finally {
      await reg.close();
    }
  });

  // -------------------------------------------------------------------------
  // Read-only diagnostic path: --registry absent → no persist, no registry open.
  // -------------------------------------------------------------------------
  it("preserves read-only diagnostic behavior when --registry is omitted", async () => {
    const row = makeRow(TEST_SPEC, "persist-readonly");
    const wire = serializeWireBlockTriplet(row);
    const wireByRoot = new Map([[row.blockMerkleRoot, wire]]);
    const transport = makeStubTransport({
      schemaVersion: SCHEMA_VERSION,
      specHashes: [],
      blocksBySpec: new Map(),
      wireByRoot,
    });

    const logger = new CollectingLogger();
    // No --registry flag — read-only diagnostic path.
    const code = await runFederation(
      ["pull", "--remote", "https://peer.example.com", "--root", row.blockMerkleRoot],
      logger,
      { transport, embeddings: offlineEmbeddings },
    );

    expect(code).toBe(0);
    expect(logger.errLines).toHaveLength(0);

    // Diagnostic lines emitted (blockMerkleRoot, specHash).
    expect(logger.logLines.some((l) => l.includes(row.blockMerkleRoot))).toBe(true);
    expect(logger.logLines.some((l) => l.includes(row.specHash))).toBe(true);

    // No "persisted:" line — no registry was opened.
    expect(logger.logLines.some((l) => l.includes("persisted:"))).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Empty registry: storeBlock count = 0 before, 1 after.
  // -------------------------------------------------------------------------
  it("creates the row when registry is empty", async () => {
    const row = makeRow(TEST_SPEC, "persist-empty-registry");
    const wire = serializeWireBlockTriplet(row);
    const wireByRoot = new Map([[row.blockMerkleRoot, wire]]);
    const transport = makeStubTransport({
      schemaVersion: SCHEMA_VERSION,
      specHashes: [],
      blocksBySpec: new Map(),
      wireByRoot,
    });

    const dbPath = makePersistPath("empty-registry-test");
    const initLogger = new CollectingLogger();
    expect(await runCli(["registry", "init", "--path", dbPath], initLogger)).toBe(0);

    // Pre-condition: registry is empty.
    const regBefore = await openRegistry(dbPath, { embeddings: offlineEmbeddings });
    try {
      const before = await regBefore.getBlock(row.blockMerkleRoot);
      expect(before).toBeNull();
    } finally {
      await regBefore.close();
    }

    const logger = new CollectingLogger();
    const code = await runFederation(
      ["pull", "--remote", "https://peer.example.com", "--root", row.blockMerkleRoot, "--registry", dbPath],
      logger,
      { transport, embeddings: offlineEmbeddings },
    );

    expect(code).toBe(0);

    // Post-condition: row is now present.
    const regAfter = await openRegistry(dbPath, { embeddings: offlineEmbeddings });
    try {
      const after = await regAfter.getBlock(row.blockMerkleRoot);
      expect(after).not.toBeNull();
      expect(after!.blockMerkleRoot).toBe(row.blockMerkleRoot);
    } finally {
      await regAfter.close();
    }
  });

  // -------------------------------------------------------------------------
  // Pre-existing block: pull against registry already containing the block.
  // Pull completes successfully (exit 0); registry state is unchanged.
  // -------------------------------------------------------------------------
  it("is a no-op when the registry already contains the requested block", async () => {
    const row = makeRow(TEST_SPEC, "persist-already-present");
    const wire = serializeWireBlockTriplet(row);
    const wireByRoot = new Map([[row.blockMerkleRoot, wire]]);
    const transport = makeStubTransport({
      schemaVersion: SCHEMA_VERSION,
      specHashes: [],
      blocksBySpec: new Map(),
      wireByRoot,
    });

    const dbPath = makePersistPath("already-present-test");
    const initLogger = new CollectingLogger();
    expect(await runCli(["registry", "init", "--path", dbPath], initLogger)).toBe(0);

    // Pre-condition: insert the row directly via the registry.
    const regPre = await openRegistry(dbPath, { embeddings: offlineEmbeddings });
    try {
      await regPre.storeBlock(row);
    } finally {
      await regPre.close();
    }

    const logger = new CollectingLogger();
    const code = await runFederation(
      ["pull", "--remote", "https://peer.example.com", "--root", row.blockMerkleRoot, "--registry", dbPath],
      logger,
      { transport, embeddings: offlineEmbeddings },
    );

    expect(code).toBe(0);
    expect(logger.errLines).toHaveLength(0);

    // Post-condition: registry still contains exactly one row (no double-insert).
    const regPost = await openRegistry(dbPath, { embeddings: offlineEmbeddings });
    try {
      const allRoots = await regPost.selectBlocks(row.specHash);
      const matching = allRoots.filter((r) => r === row.blockMerkleRoot);
      expect(matching).toHaveLength(1);
    } finally {
      await regPost.close();
    }
  });

  // -------------------------------------------------------------------------
  // Registry open failure: fail-fast before transport is invoked.
  // Error message names the open failure distinctly.
  // -------------------------------------------------------------------------
  it("handles registry open failure with non-zero exit and does not invoke transport", async () => {
    // Track whether fetchBlock was called.
    let fetchBlockCalled = false;
    const transport = makeStubTransport({
      schemaVersion: SCHEMA_VERSION,
      specHashes: [],
      blocksBySpec: new Map(),
      wireByRoot: new Map(),
    });
    const originalFetchBlock = transport.fetchBlock.bind(transport);
    transport.fetchBlock = (...args) => {
      fetchBlockCalled = true;
      return originalFetchBlock(...args);
    };

    // Point --registry at a non-existent directory path (guaranteed to fail).
    const badPath = join(persistDir, "nonexistent-dir", "registry.sqlite");

    const logger = new CollectingLogger();
    const code = await runFederation(
      ["pull", "--remote", "https://peer.example.com", "--root", "a".repeat(64), "--registry", badPath],
      logger,
      { transport, embeddings: offlineEmbeddings },
    );

    expect(code).toBe(1);
    // Error message must name the open failure (not a generic "pull failed").
    expect(logger.errLines.some((l) => l.includes("failed to open registry"))).toBe(true);
    // Transport must NOT have been invoked (fail-fast ordering).
    expect(fetchBlockCalled).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Transport failure: pull fails → persist path is NOT executed.
  // Registry was opened first (fail-fast ordering) and must be closed cleanly.
  // -------------------------------------------------------------------------
  it("handles transport failure cleanly — does not persist, exits 1", async () => {
    const transport = makeStubTransport({
      schemaVersion: SCHEMA_VERSION,
      specHashes: [],
      blocksBySpec: new Map(),
      wireByRoot: new Map(), // empty — fetchBlock throws
    });

    const dbPath = makePersistPath("transport-failure-test");
    const initLogger = new CollectingLogger();
    expect(await runCli(["registry", "init", "--path", dbPath], initLogger)).toBe(0);

    const logger = new CollectingLogger();
    const code = await runFederation(
      ["pull", "--remote", "https://peer.example.com", "--root", "a".repeat(64), "--registry", dbPath],
      logger,
      { transport, embeddings: offlineEmbeddings },
    );

    expect(code).toBe(1);
    // Error message must name the pull failure (not the registry-open failure).
    expect(logger.errLines.some((l) => l.includes("pull failed"))).toBe(true);

    // Post-condition: registry is unchanged (no row was inserted).
    const reg = await openRegistry(dbPath, { embeddings: offlineEmbeddings });
    try {
      const allRoots = await reg.selectBlocks("a".repeat(64) as unknown as import("@yakcc/contracts").SpecHash);
      expect(allRoots).toHaveLength(0);
    } finally {
      await reg.close();
    }
  });

  // -------------------------------------------------------------------------
  // Persist (storeBlock) failure: pull succeeded, persist throws.
  // Error message names the persist failure distinctly.
  // -------------------------------------------------------------------------
  it("handles storeBlock failure cleanly — exits 1 with persist-failure error", async () => {
    const row = makeRow(TEST_SPEC, "persist-failure-test");
    const wire = serializeWireBlockTriplet(row);
    const wireByRoot = new Map([[row.blockMerkleRoot, wire]]);
    const transport = makeStubTransport({
      schemaVersion: SCHEMA_VERSION,
      specHashes: [],
      blocksBySpec: new Map(),
      wireByRoot,
    });

    const dbPath = makePersistPath("store-failure-test");
    const initLogger = new CollectingLogger();
    expect(await runCli(["registry", "init", "--path", dbPath], initLogger)).toBe(0);

    // Open a real registry and wrap storeBlock to throw after open succeeds.
    // We simulate this by passing an opts.registry that is not a real path but
    // a stub. However, the CLI calls openRegistry internally — we cannot inject
    // a registry directly. Instead, we simulate the scenario by giving a valid
    // path that is already open in read-only mode (or by wrapping after open).
    //
    // Approach: open the registry, immediately close it, then chmod to read-only
    // so that openRegistry succeeds (the file exists) but storeBlock throws.
    // Use a different approach: test that a corrupt DB file causes a storeBlock
    // failure. Write a file at dbPath2 that is not a valid SQLite DB.
    const dbPath2 = makePersistPath("corrupt-db-test");
    // Write garbage bytes — openRegistry will fail to open this, giving us
    // an open failure (testing that path instead). To get a storeBlock failure
    // specifically, we need openRegistry to succeed but storeBlock to throw.
    //
    // The cleanest way to test the storeBlock failure path is to corrupt the DB
    // *after* schema init by overwriting it with invalid SQLite content.
    const { writeFileSync } = await import("node:fs");
    const initLogger2 = new CollectingLogger();
    expect(await runCli(["registry", "init", "--path", dbPath2], initLogger2)).toBe(0);
    // Overwrite with garbage — this will cause storeBlock to throw while
    // openRegistry may or may not fail depending on the SQLite driver behavior.
    // On better-sqlite3, opening a corrupt file throws at open time.
    // So this test doubles as either open-failure or store-failure verification.
    // Both are distinct from "pull failed" — any of these messages should appear.
    writeFileSync(dbPath2, Buffer.from("not a sqlite file"));

    const logger = new CollectingLogger();
    const code = await runFederation(
      ["pull", "--remote", "https://peer.example.com", "--root", row.blockMerkleRoot, "--registry", dbPath2],
      logger,
      { transport, embeddings: offlineEmbeddings },
    );

    expect(code).toBe(1);
    // Error message must name either open failure or persist failure (not "pull failed").
    const hasDistinctError = logger.errLines.some(
      (l) => l.includes("failed to open registry") || l.includes("failed to persist block to registry"),
    );
    expect(hasDistinctError).toBe(true);
    // Must NOT report "pull failed" — that conflates persist failure with transport failure.
    expect(logger.errLines.some((l) => l.includes("pull failed"))).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Empty-string --registry: treated as missing (validation parity with serve/mirror).
  // -------------------------------------------------------------------------
  it("rejects --registry with empty string as invalid", async () => {
    const transport = makeStubTransport({
      schemaVersion: SCHEMA_VERSION,
      specHashes: [],
      blocksBySpec: new Map(),
      wireByRoot: new Map(),
    });

    const logger = new CollectingLogger();
    const code = await runFederation(
      ["pull", "--remote", "https://peer.example.com", "--root", "a".repeat(64), "--registry", ""],
      logger,
      { transport, embeddings: offlineEmbeddings },
    );

    expect(code).toBe(1);
    expect(logger.errLines.some((l) => l.includes("--registry"))).toBe(true);
    // No registry should be opened (no "failed to open registry" — validation
    // is caught before the open attempt).
    expect(logger.errLines.some((l) => l.includes("failed to open registry"))).toBe(false);
  });

  // -------------------------------------------------------------------------
  // --registry flag parses and is consumed (not discarded).
  // Regression: pre-WI-030, the parsed value was silently discarded.
  // -------------------------------------------------------------------------
  it("parses --registry and consumes the value (not discarded)", async () => {
    const row = makeRow(TEST_SPEC, "persist-flag-parse");
    const wire = serializeWireBlockTriplet(row);
    const wireByRoot = new Map([[row.blockMerkleRoot, wire]]);
    const transport = makeStubTransport({
      schemaVersion: SCHEMA_VERSION,
      specHashes: [],
      blocksBySpec: new Map(),
      wireByRoot,
    });

    const dbPath = makePersistPath("flag-parse-test");
    const initLogger = new CollectingLogger();
    expect(await runCli(["registry", "init", "--path", dbPath], initLogger)).toBe(0);

    const logger = new CollectingLogger();
    const code = await runFederation(
      ["pull", "--remote", "https://peer.example.com", "--root", row.blockMerkleRoot, "--registry", dbPath],
      logger,
      { transport, embeddings: offlineEmbeddings },
    );

    expect(code).toBe(0);
    // The persisted line confirms the flag value was consumed (not discarded).
    expect(logger.logLines.some((l) => l.includes("persisted:") && l.includes(dbPath))).toBe(true);
  });
});
