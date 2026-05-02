/**
 * Round-trip compound integration test for the federation mirror loop (WI-020 v2 Slice F).
 *
 * @decision DEC-ROUND-TRIP-020: Slice F compound-interaction test strategy.
 * Status: decided (WI-020 Dispatch F)
 * Title: Real HTTP server + real registry + mirrorRegistry = byte-identical round-trip.
 * Rationale:
 *   This is the compound-interaction test: exercises the full production sequence across
 *   multiple internal components in one test:
 *     registryA.storeBlock → serveRegistry (HTTP) → createHttpTransport →
 *     mirrorRegistry → pullBlock → deserializeWireBlockTriplet → registryB.storeBlock
 *
 *   Fixtures are built via @yakcc/contracts blockMerkleRoot() — the single canonical
 *   authority for block identity (DEC-CONTRACTS-AUTHORITY-001). No parallel merkle helper,
 *   no direct @noble/hashes import.
 *
 *   Row equality: byte-identical comparison on all BlockTripletRow fields including
 *   specCanonicalBytes (via base64), artifacts Map (per key, per byte), and all scalar
 *   fields. This proves the federation wire preserves row integrity end-to-end.
 *
 *   DEC-V1-FEDERATION-WIRE-ARTIFACTS-002: artifact bytes fold into blockMerkleRoot via
 *   the wire protocol — the round-trip proves they survive serialization intact.
 *   DEC-SERVE-SPECS-ENUMERATION-020 (closed by WI-026): Registry.enumerateSpecs() is now
 *   a first-class native method. serveRegistry calls registry.enumerateSpecs() directly.
 *   The former tracking-wrapper enumerateSpecs callback is removed (Sacred Practice #12).
 *
 * Scope: one new file — federation/src/round-trip.test.ts only (Slice F).
 * Forbidden: no new merkle helpers, no serve.ts edits, no shave source edits.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  blockMerkleRoot,
  canonicalize,
  specHash as computeSpecHash,
  validateProofManifestL0,
} from "@yakcc/contracts";
import type { BlockMerkleRoot, CanonicalAstHash, SpecHash, SpecYak } from "@yakcc/contracts";
import { openRegistry } from "@yakcc/registry";
import type { BlockTripletRow, Registry } from "@yakcc/registry";
import { createHttpTransport } from "./http-transport.js";
import { mirrorRegistry } from "./mirror.js";
import { serveRegistry } from "./serve.js";
import type { ServeHandle } from "./serve.js";
import type { MirrorReport } from "./types.js";

// ---------------------------------------------------------------------------
// Stub embedding provider — avoids loading transformers.js model in tests
// ---------------------------------------------------------------------------

const ZERO_EMBEDDINGS = {
  dimension: 384,
  modelId: "test-stub",
  async embed(_text: string): Promise<Float32Array> {
    return new Float32Array(384);
  },
};

// ---------------------------------------------------------------------------
// Fixture specs — three distinct SpecYak objects for multi-spec test
// ---------------------------------------------------------------------------

const SPEC_A: SpecYak = {
  name: "roundTripSpecA",
  inputs: [{ name: "n", type: "number" }],
  outputs: [{ name: "r", type: "string" }],
  preconditions: ["n is finite"],
  postconditions: ["r is a string representation of n"],
  invariants: [],
  effects: [],
  level: "L0",
};

const SPEC_B: SpecYak = {
  name: "roundTripSpecB",
  inputs: [{ name: "xs", type: "number[]" }],
  outputs: [{ name: "sum", type: "number" }],
  preconditions: ["xs is non-empty"],
  postconditions: ["sum equals the arithmetic total of xs"],
  invariants: [],
  effects: [],
  level: "L0",
};

// A third spec variant for multi-triplet tests under SPEC_A
const SPEC_C: SpecYak = {
  name: "roundTripSpecC",
  inputs: [{ name: "x", type: "number" }, { name: "y", type: "number" }],
  outputs: [{ name: "product", type: "number" }],
  preconditions: [],
  postconditions: ["product equals x * y"],
  invariants: [],
  effects: [],
  level: "L0",
};

// ---------------------------------------------------------------------------
// Shared fixture constants
// ---------------------------------------------------------------------------

const PROOF_MANIFEST_JSON =
  '{"artifacts":[{"kind":"property_tests","path":"tests.fast-check.ts"}]}';
const PROOF_MANIFEST = validateProofManifestL0(JSON.parse(PROOF_MANIFEST_JSON));
const ARTIFACT_PATH = "tests.fast-check.ts";

// Distinct canonical AST hashes for each fixture variant.
const HASH_A = "aabbccdd" + "a".repeat(56) as CanonicalAstHash;
const HASH_B = "bbccddee" + "b".repeat(56) as CanonicalAstHash;
const HASH_C = "ccddeeaa" + "c".repeat(56) as CanonicalAstHash;

// ---------------------------------------------------------------------------
// Fixture builder
//
// Builds a fully consistent BlockTripletRow via @yakcc/contracts blockMerkleRoot().
// No hand-computed roots; no inline merkle helper.
// DEC-CONTRACTS-AUTHORITY-001, DEC-V1-FEDERATION-WIRE-ARTIFACTS-002.
// ---------------------------------------------------------------------------

function makeRow(
  spec: SpecYak,
  implVariant: string,
  artifactContent: string,
  canonicalAstHash: CanonicalAstHash,
): BlockTripletRow {
  const implSource = `export function fn(): unknown { return null; } /* variant=${implVariant} */`;
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
    canonicalAstHash,
    parentBlockRoot: null,
    artifacts,
  };
}

// ---------------------------------------------------------------------------
// TrackedRegistry — thin Registry wrapper for convenient block insertion in tests
//
// WI-026 closure: Registry.enumerateSpecs() is now a first-class method on the
// Registry interface. serveRegistry calls registry.enumerateSpecs() directly.
// The former specHashSet tracking and enumerateSpecs() method are removed
// (Sacred Practice #12 — no parallel authorities).
// ---------------------------------------------------------------------------

interface TrackedRegistry {
  readonly registry: Registry;
  store(row: BlockTripletRow): Promise<void>;
  close(): Promise<void>;
}

async function openTrackedRegistry(): Promise<TrackedRegistry> {
  const reg = await openRegistry(":memory:", { embeddings: ZERO_EMBEDDINGS });

  return {
    registry: reg,
    async store(row: BlockTripletRow): Promise<void> {
      await reg.storeBlock(row);
    },
    close(): Promise<void> {
      return reg.close();
    },
  };
}

// ---------------------------------------------------------------------------
// Byte-identical equality helpers
// ---------------------------------------------------------------------------

/**
 * Assert that two BlockTripletRows are byte-identical on every field.
 *
 * This is the core assertion that proves the federation round-trip preserves
 * row integrity end-to-end. Fields compared:
 *   - blockMerkleRoot (string)
 *   - specHash (string)
 *   - specCanonicalBytes (Uint8Array — compared via base64)
 *   - implSource (string)
 *   - proofManifestJson (string)
 *   - level (string)
 *   - createdAt (number)
 *   - canonicalAstHash (string)
 *   - parentBlockRoot (string | null | undefined)
 *   - artifacts (Map<string, Uint8Array> — compared key-by-key, byte-by-byte)
 *
 * @decision DEC-ROUND-TRIP-020: byte-identical equality is the acceptance criterion.
 * Status: decided (WI-020 Dispatch F)
 */
function assertRowsEqual(label: string, actual: BlockTripletRow | null, expected: BlockTripletRow): void {
  expect(actual, `${label}: row must be non-null in registryB`).not.toBeNull();
  if (actual === null) return; // type guard (assertion above would throw first)

  expect(actual.blockMerkleRoot, `${label}: blockMerkleRoot`).toBe(expected.blockMerkleRoot);
  expect(actual.specHash, `${label}: specHash`).toBe(expected.specHash);
  expect(actual.implSource, `${label}: implSource`).toBe(expected.implSource);
  expect(actual.proofManifestJson, `${label}: proofManifestJson`).toBe(expected.proofManifestJson);
  expect(actual.level, `${label}: level`).toBe(expected.level);
  expect(actual.createdAt, `${label}: createdAt`).toBe(expected.createdAt);
  expect(actual.canonicalAstHash, `${label}: canonicalAstHash`).toBe(expected.canonicalAstHash);
  expect(actual.parentBlockRoot, `${label}: parentBlockRoot`).toBe(expected.parentBlockRoot ?? null);

  // specCanonicalBytes — compare via base64 to avoid Uint8Array reference equality traps.
  const actualB64 = Buffer.from(actual.specCanonicalBytes).toString("base64");
  const expectedB64 = Buffer.from(expected.specCanonicalBytes).toString("base64");
  expect(actualB64, `${label}: specCanonicalBytes (base64)`).toBe(expectedB64);

  // artifacts Map — same key set, same byte content per key.
  expect(actual.artifacts.size, `${label}: artifacts.size`).toBe(expected.artifacts.size);
  for (const [path, expectedBytes] of expected.artifacts) {
    expect(actual.artifacts.has(path), `${label}: artifacts has key "${path}"`).toBe(true);
    const actualBytes = actual.artifacts.get(path)!;
    const actualArtB64 = Buffer.from(actualBytes).toString("base64");
    const expectedArtB64 = Buffer.from(expectedBytes).toString("base64");
    expect(actualArtB64, `${label}: artifacts["${path}"] bytes (base64)`).toBe(expectedArtB64);
  }
}

// ---------------------------------------------------------------------------
// Transcript writer
//
// Writes tmp/wi-020-v2-evidence/round-trip-transcript.txt with a human-readable
// summary of the mirror operation. Called after assertions pass.
// ---------------------------------------------------------------------------

async function writeTranscript(
  rows: readonly BlockTripletRow[],
  report: MirrorReport,
): Promise<string> {
  // Resolve to the worktree root (two levels up from packages/federation).
  // process.cwd() during vitest is the package dir (packages/federation).
  // The canonical evidence location per Sacred Practice #3 is tmp/ at the
  // worktree root, NOT a package-local tmp/ directory.
  const worktreeRoot = join(process.cwd(), "..", "..");
  const evidenceDir = join(worktreeRoot, "tmp", "wi-020-v2-evidence");
  await mkdir(evidenceDir, { recursive: true });

  const transcriptPath = join(evidenceDir, "round-trip-transcript.txt");

  const lines: string[] = [
    `# WI-020 v2 Federation Round-Trip Transcript`,
    ``,
    `## Summary`,
    `Triplets seeded into registryA: ${rows.length}`,
    `blocksInserted:   ${report.blocksInserted}`,
    `blocksSkipped:    ${report.blocksSkipped}`,
    `failures:         ${report.failures.length}`,
    `specsWalked:      ${report.specsWalked}`,
    `blocksConsidered: ${report.blocksConsidered}`,
    ``,
    `## Triplet Details`,
  ];

  for (const row of rows) {
    lines.push(`  blockMerkleRoot:  ${row.blockMerkleRoot}`);
    lines.push(`  specHash:         ${row.specHash}`);
    lines.push(`  level:            ${row.level}`);
    lines.push(`  parentBlockRoot:  ${row.parentBlockRoot ?? "null"}`);
    lines.push(`  artifactCount:    ${row.artifacts.size}`);
    lines.push(``);
  }

  lines.push(`## MirrorReport (JSON)`);
  lines.push(JSON.stringify(report, null, 2));
  lines.push(``);

  await writeFile(transcriptPath, lines.join("\n"), "utf-8");
  return transcriptPath;
}

// ---------------------------------------------------------------------------
// (1) Single-triplet round-trip
//
// Seed registryA with 1 row, mirror to registryB, verify byte-identical equality.
//
// This is a unit of the compound-interaction test: the full production sequence
// crosses transport, pullBlock (wire integrity gate), and registry.storeBlock
// in one test without stubs.
// ---------------------------------------------------------------------------

describe("federation round-trip — single-triplet (compound-interaction)", () => {
  it("mirrors 1 block from registryA HTTP server to registryB byte-identically", async () => {
    const trackedA = await openTrackedRegistry();
    const registryB = await openRegistry(":memory:", { embeddings: ZERO_EMBEDDINGS });
    let handle: ServeHandle | undefined;

    try {
      // Step 1: build one real BlockTripletRow and store it in registryA.
      const row = makeRow(SPEC_A, "impl-v1", "// fast-check property test for single-triplet", HASH_A);
      await trackedA.store(row);

      // Step 2: start the HTTP server backed by registryA.
      handle = await serveRegistry(trackedA.registry, {
        port: 0,
        host: "127.0.0.1",
      });

      // Step 3: mirror from the HTTP server into registryB.
      const transport = createHttpTransport();
      const report = await mirrorRegistry(handle.url, registryB, transport);

      // Step 4: assert MirrorReport counts.
      expect(report.specsWalked).toBe(1);
      expect(report.blocksConsidered).toBe(1);
      expect(report.blocksInserted).toBe(1);
      expect(report.blocksSkipped).toBe(0);
      expect(report.failures).toHaveLength(0);

      // Step 5: fetch the row from registryB and verify byte-identical equality.
      const mirrored = await registryB.getBlock(row.blockMerkleRoot);
      assertRowsEqual("single-triplet", mirrored, row);
    } finally {
      await handle?.close();
      await trackedA.close();
      await registryB.close();
    }
  });
});

// ---------------------------------------------------------------------------
// (2) Multi-triplet round-trip
//
// Seed registryA with 3 rows across 2 distinct specHashes. Mirror to registryB.
// Verify: all 3 land byte-identical, specsWalked === 2, blocksInserted === 3.
//
// This is the required compound-interaction test: exercises the full production
// sequence end-to-end across multiple internal components:
//   trackedA.store (×3) → serveRegistry (HTTP, port:0) → createHttpTransport →
//   mirrorRegistry → pullBlock (wire integrity) → registryB.storeBlock (×3) →
//   MirrorReport verification → getBlock (×3) → byte-identical comparison
//
// DEC-ROUND-TRIP-020: transcript is captured after assertions pass.
// ---------------------------------------------------------------------------

describe("federation round-trip — multi-triplet (required compound-interaction)", () => {
  it("mirrors 3 blocks across 2 specs byte-identically; report: specsWalked=2, blocksInserted=3", async () => {
    const trackedA = await openTrackedRegistry();
    const registryB = await openRegistry(":memory:", { embeddings: ZERO_EMBEDDINGS });
    let handle: ServeHandle | undefined;

    try {
      // Step 1: build 3 rows across 2 specHashes.
      //   specHash(SPEC_A): rows rowA1, rowA2  (2 blocks under the same spec)
      //   specHash(SPEC_B): row  rowB1          (1 block)
      const rowA1 = makeRow(SPEC_A, "spec-a-v1", "// property tests for SPEC_A variant 1", HASH_A);
      const rowA2 = makeRow(SPEC_A, "spec-a-v2", "// property tests for SPEC_A variant 2", HASH_B);
      const rowB1 = makeRow(SPEC_B, "spec-b-v1", "// property tests for SPEC_B variant 1", HASH_C);

      await trackedA.store(rowA1);
      await trackedA.store(rowA2);
      await trackedA.store(rowB1);

      const allRows: readonly BlockTripletRow[] = [rowA1, rowA2, rowB1];

      // Step 2: start the HTTP server backed by registryA.
      handle = await serveRegistry(trackedA.registry, {
        port: 0,
        host: "127.0.0.1",
      });

      // Step 3: mirror from the HTTP server into registryB.
      const transport = createHttpTransport();
      const report = await mirrorRegistry(handle.url, registryB, transport);

      // Step 4: assert MirrorReport counts.
      expect(report.specsWalked).toBe(2);
      expect(report.blocksConsidered).toBe(3);
      expect(report.blocksInserted).toBe(3);
      expect(report.blocksSkipped).toBe(0);
      expect(report.failures).toHaveLength(0);

      // Step 5: verify byte-identical equality for each of the 3 rows.
      const mirroredA1 = await registryB.getBlock(rowA1.blockMerkleRoot);
      const mirroredA2 = await registryB.getBlock(rowA2.blockMerkleRoot);
      const mirroredB1 = await registryB.getBlock(rowB1.blockMerkleRoot);

      assertRowsEqual("rowA1", mirroredA1, rowA1);
      assertRowsEqual("rowA2", mirroredA2, rowA2);
      assertRowsEqual("rowB1", mirroredB1, rowB1);

      // Step 6: capture transcript (after assertions pass).
      const transcriptPath = await writeTranscript(allRows, report);

      // Sanity: transcript file was written.
      expect(transcriptPath).toMatch(/round-trip-transcript\.txt$/);
    } finally {
      await handle?.close();
      await trackedA.close();
      await registryB.close();
    }
  });
});
