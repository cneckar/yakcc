/**
 * storage.wal.test.ts — WAL mode + vec0 virtual table compatibility test.
 *
 * These tests use a real on-disk database (not :memory:) to verify that:
 *   1. openRegistry sets WAL journal mode and busy_timeout correctly.
 *   2. vec0 vector inserts and KNN queries work correctly in WAL mode.
 *
 * A fresh temp directory is created per test and cleaned up on teardown.
 *
 * @decision DEC-WAL-VEC0-COMPAT-001
 * @title WAL mode is compatible with sqlite-vec vec0 virtual tables
 * @status verified (WI-777 — SQLite concurrency hardening)
 * @rationale sqlite-vec's vec0 vtable uses a standard rowid-keyed backing table;
 *   WAL mode applies to the entire DB file (all tables including vtables).
 *   The vec0 extension author confirms WAL compatibility. This test provides
 *   ongoing regression coverage for the WAL + vec0 combination.
 */

import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type EmbeddingProvider,
  type ProofManifest,
  type SpecYak,
  blockMerkleRoot,
  canonicalize,
  canonicalAstHash as deriveCanonicalAstHash,
  specHash as deriveSpecHash,
} from "@yakcc/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BlockTripletRow, Registry } from "./index.js";
import { openRegistry } from "./storage.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockProvider(): EmbeddingProvider {
  return {
    dimension: 384,
    modelId: "mock/wal-test",
    async embed(text: string): Promise<Float32Array> {
      const vec = new Float32Array(384);
      for (let i = 0; i < 384; i++) {
        vec[i] = text.charCodeAt(i % text.length) / 128 + i * 0.001;
      }
      let norm = 0;
      for (const v of vec) norm += v * v;
      const scale = norm > 0 ? 1 / Math.sqrt(norm) : 1;
      for (let i = 0; i < vec.length; i++) {
        const val = vec[i];
        if (val !== undefined) vec[i] = val * scale;
      }
      return vec;
    },
  };
}

function makeSpec(behavior = "parse integer from string"): SpecYak {
  return {
    name: "parse",
    inputs: [{ name: "s", type: "string" }],
    outputs: [{ name: "n", type: "number" }],
    preconditions: [],
    postconditions: [],
    invariants: [],
    effects: [],
    level: "L0",
    behavior,
  };
}

function makeBlock(spec: SpecYak, implSource: string): BlockTripletRow {
  const manifest: ProofManifest = { artifacts: [{ kind: "property_tests", path: "tests.ts" }] };
  const artifactBytes = new TextEncoder().encode("// property tests");
  const artifacts = new Map<string, Uint8Array>([["tests.ts", artifactBytes]]);
  const root = blockMerkleRoot({ spec, implSource, manifest, artifacts });
  const sh = deriveSpecHash(spec);
  const cb = canonicalize(spec as unknown as Parameters<typeof canonicalize>[0]);
  return {
    blockMerkleRoot: root,
    specHash: sh,
    specCanonicalBytes: cb,
    implSource,
    proofManifestJson: JSON.stringify(manifest),
    level: "L0",
    createdAt: Date.now(),
    canonicalAstHash: deriveCanonicalAstHash(implSource) as ReturnType<
      typeof deriveCanonicalAstHash
    >,
    artifacts,
  };
}

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

let testDir: string;
let registryPath: string;
let registry: Registry;

beforeEach(async () => {
  testDir = join(tmpdir(), `yakcc-wal-test-${process.pid}-${Date.now()}`);
  mkdirSync(testDir, { recursive: true });
  registryPath = join(testDir, "registry.sqlite");
  registry = await openRegistry(registryPath, { embeddings: mockProvider() });
});

afterEach(async () => {
  await registry.close();
  rmSync(testDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("WAL mode + vec0 compatibility", () => {
  it("stores a block and retrieves it via vector search in WAL mode", async () => {
    const spec = makeSpec("parse integer from string");
    const implSource = "export function parse(s: string): number { return parseInt(s, 10); }";
    const row = makeBlock(spec, implSource);

    await registry.storeBlock(row);

    // Vector search via findCandidatesByIntent.
    const candidates = await registry.findCandidatesByIntent(
      {
        behavior: "parse integer from string",
        inputs: [{ name: "s", typeHint: "string" }],
        outputs: [{ name: "n", typeHint: "number" }],
      },
      { k: 5 },
    );

    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates[0]?.block.blockMerkleRoot).toBe(row.blockMerkleRoot);
  });

  it("supports multiple blocks and returns top KNN results in WAL mode", async () => {
    const spec1 = makeSpec("parse integer from string");
    const spec2 = makeSpec("format a number to string");

    const row1 = makeBlock(
      spec1,
      "export function parse(s: string): number { return parseInt(s, 10); }",
    );
    const row2 = makeBlock(
      spec2,
      "export function format(n: number): string { return n.toString(); }",
    );

    await registry.storeBlock(row1);
    await registry.storeBlock(row2);

    const candidates = await registry.findCandidatesByIntent(
      {
        behavior: "parse integer from string",
        inputs: [{ name: "s", typeHint: "string" }],
        outputs: [{ name: "n", typeHint: "number" }],
      },
      { k: 5 },
    );

    expect(candidates.length).toBe(2);
    // The "parse" spec should rank closer to the query than "format".
    expect(candidates[0]?.block.blockMerkleRoot).toBe(row1.blockMerkleRoot);
  });

  it("verifies WAL journal mode is set on disk registries", async () => {
    // Use better-sqlite3 directly to inspect the pragma.
    const Database = (await import("better-sqlite3")).default;
    const db = new Database(registryPath);
    const row = db.pragma("journal_mode", { simple: true }) as string;
    db.close();
    expect(row).toBe("wal");
  });

  it("verifies busy_timeout is set", async () => {
    const Database = (await import("better-sqlite3")).default;
    const db = new Database(registryPath);
    const timeout = db.pragma("busy_timeout", { simple: true }) as number;
    db.close();
    expect(timeout).toBe(5000);
  });
});
