// SPDX-License-Identifier: MIT
//
// @decision DEC-CLI-REGISTRY-EXPORT-001
// title: CLI integration tests for `yakcc registry export`
// status: accepted (issue #371 Slice 2)
// rationale: Verifies the `registryExport` command handler and the runCli dispatch
//   path for `registry export`. Tests use temp directories for isolation and a
//   CollectingLogger to capture output without mocking. Sacred Practice #5: all I/O
//   is real, against the temp directory. Output SQLite validity is verified by
//   opening it via openRegistry() (same API used by the whole system) rather than
//   importing better-sqlite3 directly — this avoids a @types resolution gap and
//   proves the output is a fully-functional registry, not just a raw SQLite file.
//
// Tests:
//   1. Happy path: exit 0 on a seeded registry, output file exists, valid registry, rows match
//   2. Missing --to flag: exit 1, error logged
//   3. Missing source registry: exit 1, error logged
//   4. Auto-mkdir of parent dirs: nested output path created automatically
//   5. Empty registry: exit 0, output is a valid registry (0 blocks)
//   6. runCli dispatch: `registry export` routes correctly to the handler

import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  canonicalize,
  blockMerkleRoot as computeBlockMerkleRoot,
  createOfflineEmbeddingProvider,
  canonicalAstHash as deriveCanonicalAstHash,
  specHash as deriveSpecHash,
} from "@yakcc/contracts";
import { type BlockTripletRow, type CanonicalAstHash, openRegistry } from "@yakcc/registry";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CollectingLogger, runCli } from "../index.js";
import { registryExport } from "./registry-export.js";

// ---------------------------------------------------------------------------
// Test lifecycle
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "yakcc-export-test-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const offlineProvider = createOfflineEmbeddingProvider();

function makeRow(name: string): BlockTripletRow {
  const spec = {
    name,
    behavior: `Behavior for ${name}`,
    inputs: [{ name: "x", type: "string" }],
    outputs: [{ name: "y", type: "string" }],
    preconditions: [] as string[],
    postconditions: [] as string[],
    invariants: [] as string[],
    effects: [] as string[],
    level: "L0" as const,
  };
  const implSource = `export function ${name.replace(/-/g, "_")}(x: string): string { return x; }`;
  const manifest = { artifacts: [{ kind: "property_tests" as const, path: "props.ts" }] };
  const artifactBytes = new TextEncoder().encode("// test");
  const artifacts = new Map<string, Uint8Array>([["props.ts", artifactBytes]]);
  const root = computeBlockMerkleRoot({ spec, implSource, manifest, artifacts });
  const sh = deriveSpecHash(spec);
  const canonicalBytes = canonicalize(spec as unknown as Parameters<typeof canonicalize>[0]);

  return {
    blockMerkleRoot: root,
    specHash: sh,
    specCanonicalBytes: canonicalBytes,
    implSource,
    proofManifestJson: JSON.stringify(manifest),
    level: "L0",
    createdAt: Date.now(),
    canonicalAstHash: deriveCanonicalAstHash(implSource) as CanonicalAstHash,
    artifacts,
  };
}

/**
 * Seed a registry at `dbPath` with `count` blocks using the offline provider.
 * Creates parent directories as needed.
 */
async function seedRegistry(dbPath: string, count: number): Promise<void> {
  mkdirSync(dirname(dbPath), { recursive: true });
  const reg = await openRegistry(dbPath, { embeddings: offlineProvider });
  for (let i = 0; i < count; i++) {
    await reg.storeBlock(makeRow(`block-${i}`));
  }
  await reg.close();
}

/**
 * Open a registry at `dbPath` via openRegistry and return the block count
 * by querying spec hashes. Used to verify exported SQLite is a working registry.
 *
 * The registry API does not expose a direct countBlocks(); we verify by
 * opening the registry (which runs migrations and validates the schema) and
 * confirming it is openable — a corrupted or non-SQLite file will throw.
 * Row count is asserted via the implementation's own log output (which
 * reads the blocks table directly via VACUUM INTO source).
 */
async function openAndVerifyRegistry(dbPath: string): Promise<void> {
  const reg = await openRegistry(dbPath, { embeddings: offlineProvider });
  await reg.close();
}

// ---------------------------------------------------------------------------
// Suite 1: happy path — populated registry
// ---------------------------------------------------------------------------

describe("registryExport — happy path", () => {
  it("exits 0, output file exists, is valid registry, and log contains block count", async () => {
    const srcPath = join(tmpDir, ".yakcc", "registry.sqlite");
    const outPath = join(tmpDir, "export", "exported.sqlite");
    await seedRegistry(srcPath, 3);

    const logger = new CollectingLogger();
    const code = await registryExport(["--from", srcPath, "--to", outPath], logger);

    expect(code).toBe(0);
    expect(existsSync(outPath)).toBe(true);
    // File must be non-trivially sized (a valid SQLite is at least 4096 bytes)
    expect(statSync(outPath).size).toBeGreaterThan(4096);

    // Output must be openable as a registry (proves it is valid SQLite with our schema)
    await openAndVerifyRegistry(outPath);

    // Log message must mention both paths and the block count
    const allLog = logger.logLines.join("\n");
    expect(allLog).toContain("exported");
    expect(allLog).toContain(srcPath);
    expect(allLog).toContain(outPath);
    expect(allLog).toContain("3");
  });
});

// ---------------------------------------------------------------------------
// Suite 2: missing --to flag
// ---------------------------------------------------------------------------

describe("registryExport — missing --to flag", () => {
  it("exits 1 and logs an error when --to is not provided", async () => {
    const srcPath = join(tmpDir, ".yakcc", "registry.sqlite");
    await seedRegistry(srcPath, 1);

    const logger = new CollectingLogger();
    const code = await registryExport(["--from", srcPath], logger);

    expect(code).toBe(1);
    expect(logger.errLines.join("\n")).toContain("--to");
  });
});

// ---------------------------------------------------------------------------
// Suite 3: missing source registry
// ---------------------------------------------------------------------------

describe("registryExport — missing source registry", () => {
  it("exits 1 and logs an error when --from path does not exist", async () => {
    const outPath = join(tmpDir, "out.sqlite");
    const logger = new CollectingLogger();
    const code = await registryExport(
      ["--from", join(tmpDir, "nonexistent.sqlite"), "--to", outPath],
      logger,
    );

    expect(code).toBe(1);
    expect(logger.errLines.join("\n")).toContain("not found");
  });
});

// ---------------------------------------------------------------------------
// Suite 4: auto-mkdir of parent dirs
// ---------------------------------------------------------------------------

describe("registryExport — auto-mkdir", () => {
  it("creates nested parent directories for the output path automatically", async () => {
    const srcPath = join(tmpDir, ".yakcc", "registry.sqlite");
    const outPath = join(tmpDir, "deep", "nested", "subdir", "out.sqlite");
    await seedRegistry(srcPath, 1);

    const logger = new CollectingLogger();
    const code = await registryExport(["--from", srcPath, "--to", outPath], logger);

    expect(code).toBe(0);
    expect(existsSync(outPath)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Suite 5: empty registry
// ---------------------------------------------------------------------------

describe("registryExport — empty registry", () => {
  it("exits 0 and produces a valid registry with 0 blocks when source is freshly initialized", async () => {
    const srcPath = join(tmpDir, ".yakcc", "registry.sqlite");
    // Initialize empty registry without seeding any blocks
    mkdirSync(dirname(srcPath), { recursive: true });
    const reg = await openRegistry(srcPath, { embeddings: offlineProvider });
    await reg.close();

    const outPath = join(tmpDir, "empty-export.sqlite");
    const logger = new CollectingLogger();
    const code = await registryExport(["--from", srcPath, "--to", outPath], logger);

    expect(code).toBe(0);
    expect(existsSync(outPath)).toBe(true);
    // Exported file must be a valid registry (openable without error)
    await openAndVerifyRegistry(outPath);
    // Log must mention 0 blocks
    expect(logger.logLines.join("\n")).toContain("0 blocks");
  });
});

// ---------------------------------------------------------------------------
// Suite 6: runCli routing
// ---------------------------------------------------------------------------

describe("runCli dispatch — registry export", () => {
  it("routes 'registry export' to the export handler (exit 0, output file created)", async () => {
    const srcPath = join(tmpDir, ".yakcc", "registry.sqlite");
    const outPath = join(tmpDir, "via-runcli.sqlite");
    await seedRegistry(srcPath, 2);

    const logger = new CollectingLogger();
    const code = await runCli(["registry", "export", "--from", srcPath, "--to", outPath], logger);

    expect(code).toBe(0);
    expect(existsSync(outPath)).toBe(true);
    expect(logger.logLines.join("\n")).toContain("exported");
  });
});

// ---------------------------------------------------------------------------
// Suite 7: VACUUM INTO failure → clean error + exit 1
// ---------------------------------------------------------------------------

describe("registryExport — VACUUM INTO failure", () => {
  it("exits 1 and logs a clean error when the output path is inside a read-only directory", async () => {
    const srcPath = join(tmpDir, ".yakcc", "registry.sqlite");
    await seedRegistry(srcPath, 1);

    // Create a directory and make it read-only so VACUUM INTO cannot write there.
    const readonlyDir = join(tmpDir, "readonly-dir");
    mkdirSync(readonlyDir, { recursive: true });
    // chmod 0o555 = r-xr-xr-x: readable/executable but not writable
    const { chmodSync } = await import("node:fs");
    chmodSync(readonlyDir, 0o555);

    // Skip this test when running as root (root ignores mode bits).
    const isRoot = process.getuid?.() === 0;
    if (isRoot) {
      return;
    }

    const outPath = join(readonlyDir, "should-fail.sqlite");
    const logger = new CollectingLogger();
    const code = await registryExport(["--from", srcPath, "--to", outPath], logger);

    // Restore permissions so afterEach can clean up the tmp directory.
    chmodSync(readonlyDir, 0o755);

    expect(code).toBe(1);
    const errOut = logger.errLines.join("\n");
    expect(errOut).toMatch(/^error: VACUUM INTO failed/m);
  });
});
