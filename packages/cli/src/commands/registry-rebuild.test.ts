// SPDX-License-Identifier: MIT
//
// @decision DEC-EMBED-MODEL-MIGRATION-001
// title: CLI integration tests for `yakcc registry rebuild`
// status: accepted (issue #338, WI-EMBED-MODEL-MIGRATION-PATH)
// rationale: Verifies the `registryRebuild` command handler and the runCli dispatch
//   path for `registry rebuild`. Tests use temp directories for isolation, the
//   offline embedding provider (no ONNX/network), and a CollectingLogger to capture
//   output without mocking. Sacred Practice #5: no mocks on fs internals — all I/O
//   is real, against the temp directory.
//
// Tests:
//   1. Basic rebuild: exit 0 on a seeded registry, log message names path + block count
//   2. Idempotent: second invocation exit 0, same block count
//   3. --path flag: routes to the specified path
//   4. runCli dispatch: `registry rebuild` routes correctly
//   5. Empty registry: exit 0 with 0 blocks rebuilt

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
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
import { registryRebuild } from "./registry-rebuild.js";

// ---------------------------------------------------------------------------
// Test lifecycle
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "yakcc-registry-rebuild-test-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const offlineProvider = createOfflineEmbeddingProvider();

function makeRow(name: string, impl?: string): BlockTripletRow {
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
  const implSource =
    impl ?? `export function ${name.replace(/-/g, "_")}(x: string): string { return x; }`;
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

// ---------------------------------------------------------------------------
// Suite 1: basic rebuild
// ---------------------------------------------------------------------------

describe("registryRebuild — basic rebuild", () => {
  it("exits 0 on a seeded registry and emits a log message naming the path and block count", async () => {
    const dbPath = join(tmpDir, ".yakcc", "registry.sqlite");
    await seedRegistry(dbPath, 3);

    const logger = new CollectingLogger();
    const code = await registryRebuild(["--path", dbPath], logger, { embeddings: offlineProvider });

    expect(code).toBe(0);

    const allLog = logger.logLines.join("\n");
    expect(allLog).toContain(dbPath);
    expect(allLog).toContain("3");
    expect(allLog).toContain(offlineProvider.modelId);
  });

  it("exits 0 on empty registry (0 blocks rebuilt)", async () => {
    const dbPath = join(tmpDir, ".yakcc", "registry.sqlite");
    // Open to initialize (creates schema), then close without seeding
    mkdirSync(dirname(dbPath), { recursive: true });
    const reg = await openRegistry(dbPath, { embeddings: offlineProvider });
    await reg.close();

    const logger = new CollectingLogger();
    const code = await registryRebuild(["--path", dbPath], logger, { embeddings: offlineProvider });

    expect(code).toBe(0);
    const allLog = logger.logLines.join("\n");
    expect(allLog).toContain("0");
  });
});

// ---------------------------------------------------------------------------
// Suite 2: idempotency
// ---------------------------------------------------------------------------

describe("registryRebuild — idempotent", () => {
  it("running twice exits 0 both times and emits the same block count", async () => {
    const dbPath = join(tmpDir, ".yakcc", "registry.sqlite");
    await seedRegistry(dbPath, 2);

    const logger1 = new CollectingLogger();
    const code1 = await registryRebuild(["--path", dbPath], logger1, {
      embeddings: offlineProvider,
    });
    expect(code1).toBe(0);

    const logger2 = new CollectingLogger();
    const code2 = await registryRebuild(["--path", dbPath], logger2, {
      embeddings: offlineProvider,
    });
    expect(code2).toBe(0);

    // Both runs should report the same block count
    const log1 = logger1.logLines.join("\n");
    const log2 = logger2.logLines.join("\n");
    expect(log1).toContain("2");
    expect(log2).toContain("2");
  });
});

// ---------------------------------------------------------------------------
// Suite 3: --path flag
// ---------------------------------------------------------------------------

describe("registryRebuild — --path flag", () => {
  it("reads from the specified --path", async () => {
    const customPath = join(tmpDir, "custom", "my-registry.sqlite");
    await seedRegistry(customPath, 1);

    const logger = new CollectingLogger();
    const code = await registryRebuild(["--path", customPath], logger, {
      embeddings: offlineProvider,
    });

    expect(code).toBe(0);
    const allLog = logger.logLines.join("\n");
    expect(allLog).toContain(customPath);
  });
});

// ---------------------------------------------------------------------------
// Suite 4: runCli dispatch
// ---------------------------------------------------------------------------

describe("runCli dispatch — registry rebuild", () => {
  it("routes 'registry rebuild' to the rebuild handler (exit 0)", async () => {
    const dbPath = join(tmpDir, ".yakcc", "registry.sqlite");
    await seedRegistry(dbPath, 2);

    const logger = new CollectingLogger();
    const code = await runCli(["registry", "rebuild", "--path", dbPath], logger, {
      embeddings: offlineProvider,
    });

    expect(code).toBe(0);
    const allLog = logger.logLines.join("\n");
    expect(allLog).toContain("rebuilt");
  });
});
