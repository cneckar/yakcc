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
      { transport },
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
      { transport },
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
      { transport },
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
      { transport },
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
      { noBlock: true },
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
