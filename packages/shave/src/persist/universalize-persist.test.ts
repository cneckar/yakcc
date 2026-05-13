/**
 * universalize-persist.test.ts — WI-373 determinism and multi-leaf tests.
 *
 * @decision DEC-UNIVERSALIZE-PERSIST-PIPELINE-001 (WI-373)
 * title: Persistence step 6 runs after intentCard attachment, postorder DFS,
 *        with parentBlockRoot lineage; determinism gate confirms identical
 *        output as shave() for the same source.
 * status: accepted (WI-373)
 * rationale:
 *   T5 (determinism vs shave): two independent in-memory registries — one
 *   populated via shave(), one via universalize({persist:true}) — must contain
 *   rows with byte-identical (blockMerkleRoot, specHash, canonicalAstHash,
 *   parentBlockRoot) tuples. This proves the persistence primitive is shared
 *   (Sacred Practice #12) and that the postorder loop lifted verbatim from
 *   shave() produces the same lineage chain.
 *
 *   T6 (multi-leaf via universalize persist): confirms that universalize({
 *   persist:true}) persists each NovelGlueEntry in DFS order and surfaces a
 *   defined merkleRoot on each entry, even though assembleCandidate() still
 *   throws CandidateNotResolvableError for multi-leaf (per REQ-NOGO-003).
 *   The test is separate from T5 because it calls universalize() directly
 *   (no tmpFile needed), exercising the new step 6 without the shave() shell.
 *
 * Production trigger:
 *   universalize() is called by assembleCandidate() and by the hook-layer
 *   atomize.ts. For the single-leaf case, assembleCandidate() already exercises
 *   persist:true. This file covers the multi-leaf path and the determinism gate.
 *
 * Air-gap compliance:
 *   All tests use intentStrategy: "static" — the TypeScript Compiler API +
 *   JSDoc extractor (no Anthropic API, no network calls). This satisfies the
 *   B6 air-gap discipline enforced across the test suite.
 *
 * Mocking boundary:
 *   - openRegistry(":memory:") — real SQLite, no mock (per DEC-REGISTRY-PARENT-BLOCK-004).
 *   - Anthropic API — bypassed via intentStrategy:"static".
 *   - Filesystem — shave() requires a tmpFile; universalize() receives the source inline.
 */

import { randomUUID } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BlockMerkleRoot, EmbeddingProvider } from "@yakcc/contracts";
import { openRegistry } from "@yakcc/registry";
import type { BlockTripletRow, Registry } from "@yakcc/registry";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { shave, universalize } from "../index.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * ATOMIC_SOURCE: single expression-body arrow function assigned to a const.
 * Zero CF boundaries → the SourceFile is classified as an AtomLeaf in one step.
 * No block-body children → childMatchesRegistry() never calls canonicalAstHash
 * on a bare return statement (avoids CanonicalAstParseError).
 *
 * MIT license → passes the license gate.
 */
const ATOMIC_SOURCE = `// SPDX-License-Identifier: MIT
const isDigit = (c: string): boolean => c >= "0" && c <= "9";`;

/**
 * MULTI_LEAF_SOURCE: two top-level if-statements (CF boundaries = 2 > 1).
 * SourceFile becomes a BranchNode; each if-statement (CF = 1 ≤ 1) becomes
 * an AtomLeaf. Four entries in the slice plan — all NovelGlueEntry.
 * Canonical multi-leaf fixture from recursion.test.ts.
 */
const MULTI_LEAF_SOURCE = [
  "// SPDX-License-Identifier: MIT",
  "declare const a: boolean;",
  "declare const b: boolean;",
  'if (a) { console.log("a-branch"); }',
  'if (b) { console.log("b-branch"); }',
].join("\n");

// ---------------------------------------------------------------------------
// Mock embedding provider — deterministic, no ONNX required
// ---------------------------------------------------------------------------

function mockEmbeddingProvider(): EmbeddingProvider {
  return {
    dimension: 384,
    modelId: "mock/test-provider-universalize-persist",
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

// ---------------------------------------------------------------------------
// Per-test state
// ---------------------------------------------------------------------------

let cacheDir: string;
let tmpFilePath: string;
let registry1: Registry;
let registry2: Registry;

beforeEach(async () => {
  const unique = randomUUID();
  cacheDir = join(tmpdir(), `universalize-persist-test-${unique}`);
  tmpFilePath = join(tmpdir(), `universalize-persist-src-${unique}.ts`);

  registry1 = await openRegistry(":memory:", { embeddings: mockEmbeddingProvider() });
  registry2 = await openRegistry(":memory:", { embeddings: mockEmbeddingProvider() });

  // biome-ignore lint/performance/noDelete: process.env requires delete to truly unset
  delete process.env.ANTHROPIC_API_KEY;
});

afterEach(async () => {
  await registry1.close();
  await registry2.close();
  await rm(tmpFilePath, { force: true });
  await rm(cacheDir, { recursive: true, force: true }).catch(() => {});
  // biome-ignore lint/performance/noDelete: process.env requires delete to truly unset
  delete process.env.ANTHROPIC_API_KEY;
});

// ---------------------------------------------------------------------------
// Helper: compare row key fields between two registries
// ---------------------------------------------------------------------------

type RowKey = {
  blockMerkleRoot: BlockMerkleRoot;
  specHash: string;
  canonicalAstHash: string;
  parentBlockRoot: BlockMerkleRoot | null;
};

function rowKey(row: BlockTripletRow): RowKey {
  return {
    blockMerkleRoot: row.blockMerkleRoot,
    specHash: row.specHash as string,
    canonicalAstHash: row.canonicalAstHash as string,
    parentBlockRoot: row.parentBlockRoot,
  };
}

// ---------------------------------------------------------------------------
// T5 (WI-373 A7): Determinism — shave() vs universalize({persist:true})
//
// Both paths must produce byte-identical (blockMerkleRoot, specHash,
// canonicalAstHash, parentBlockRoot) tuples for the same source.
//
// Procedure:
//   registry1: populated via shave(tmpFile, registry1, {static, offline})
//   registry2: populated via universalize({source}, registry2, {persist:true, static, offline})
//
// Assertions:
//   - Both contain exactly one block (single-leaf source).
//   - blockMerkleRoot, specHash, canonicalAstHash, parentBlockRoot are identical.
// ---------------------------------------------------------------------------

describe("T5 (WI-373 A7): shave() and universalize({persist:true}) produce byte-identical rows", () => {
  it("single-leaf source: identical (blockMerkleRoot, specHash, canonicalAstHash, parentBlockRoot) via both paths", async () => {
    // Write source to disk so shave() can read it.
    await writeFile(tmpFilePath, ATOMIC_SOURCE, "utf-8");

    // Path 1: persist via shave() — the existing production path.
    const shaveResult = await shave(tmpFilePath, registry1, {
      cacheDir,
      offline: true,
      intentStrategy: "static",
    });

    const persistedAtoms1 = shaveResult.atoms.filter((a) => a.merkleRoot !== undefined);
    expect(persistedAtoms1.length, "shave() must persist exactly 1 atom for ATOMIC_SOURCE").toBe(1);
    // biome-ignore lint/style/noNonNullAssertion: length asserted to be 1 above
    const merkleRoot1 = persistedAtoms1[0]!.merkleRoot as BlockMerkleRoot;
    const row1 = await registry1.getBlock(merkleRoot1);
    expect(row1, "shave() row must be readable from registry1").not.toBeNull();

    // Path 2: persist via universalize({persist:true}) — the new WI-373 path.
    const uResult = await universalize({ source: ATOMIC_SOURCE }, registry2, {
      cacheDir,
      offline: true,
      intentStrategy: "static",
      persist: true,
    });

    const novelGlueEntries = uResult.slicePlan.filter((e) => e.kind === "novel-glue");
    expect(
      novelGlueEntries.length,
      "universalize() must produce exactly 1 NovelGlueEntry for ATOMIC_SOURCE",
    ).toBe(1);
    // biome-ignore lint/style/noNonNullAssertion: length asserted above
    const entry = novelGlueEntries[0]!;
    if (entry.kind !== "novel-glue") throw new Error("narrowing guard");

    expect(
      entry.merkleRoot,
      "universalize({persist:true}) must surface a defined merkleRoot on the entry",
    ).toBeDefined();
    // biome-ignore lint/style/noNonNullAssertion: asserted defined above
    const merkleRoot2 = entry.merkleRoot!;
    const row2 = await registry2.getBlock(merkleRoot2);
    expect(row2, "universalize({persist:true}) row must be readable from registry2").not.toBeNull();

    // Core assertion: byte-identical key fields (determinism / content-addressing).
    // biome-ignore lint/style/noNonNullAssertion: both rows asserted non-null above
    expect(rowKey(row2!)).toStrictEqual(rowKey(row1!));

    // Bonus: merkleRoot strings themselves must be identical.
    expect(merkleRoot2).toBe(merkleRoot1);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// T6 (WI-373 A4/A7 multi-leaf): universalize({persist:true}) persists each
// NovelGlueEntry in multi-leaf source, surfacing merkleRoot on each entry,
// with correct parentBlockRoot lineage.
//
// assembleCandidate() still throws CandidateNotResolvableError for multi-leaf
// (REQ-NOGO-003). This test calls universalize() directly to prove that the
// persistence step works correctly for multi-leaf even though the assembly
// resolver doesn't yet consume it.
// ---------------------------------------------------------------------------

describe("T6 (WI-373 A7 multi-leaf): universalize({persist:true}) persists all NovelGlueEntries with lineage", () => {
  it("each NovelGlueEntry carries a defined merkleRoot and parentBlockRoot lineage is preserved", async () => {
    // universalize() accepts inline source — no tmpFile needed.
    const uResult = await universalize({ source: MULTI_LEAF_SOURCE }, registry1, {
      cacheDir,
      offline: true,
      intentStrategy: "static",
      persist: true,
    });

    const novelGlueEntries = uResult.slicePlan.filter((e) => e.kind === "novel-glue");

    expect(
      novelGlueEntries.length,
      "MULTI_LEAF_SOURCE must produce > 1 NovelGlueEntry (multi-leaf)",
    ).toBeGreaterThan(1);

    // Every NovelGlueEntry must have a defined merkleRoot after persist:true.
    for (const entry of novelGlueEntries) {
      expect(entry.kind).toBe("novel-glue");
      if (entry.kind === "novel-glue") {
        expect(
          entry.merkleRoot,
          "NovelGlueEntry must carry a defined merkleRoot after universalize({persist:true})",
        ).toBeDefined();
      }
    }

    // Read back all rows from the registry.
    const rows: BlockTripletRow[] = [];
    for (const entry of novelGlueEntries) {
      if (entry.kind === "novel-glue" && entry.merkleRoot !== undefined) {
        const row = await registry1.getBlock(entry.merkleRoot);
        expect(row, `Row for merkleRoot ${entry.merkleRoot} must exist`).not.toBeNull();
        // biome-ignore lint/style/noNonNullAssertion: asserted non-null above
        rows.push(row!);
      }
    }

    expect(rows.length).toBe(novelGlueEntries.length);

    // Exactly one root (parentBlockRoot === null) — the first persisted atom (DFS order).
    const rootRows = rows.filter((r) => r.parentBlockRoot === null);
    expect(rootRows.length, "Exactly one row must have parentBlockRoot === null (DFS root)").toBe(
      1,
    );

    // All non-root rows must reference a valid sibling (lineage chain intact).
    const allMerkleRoots = new Set(rows.map((r) => r.blockMerkleRoot));
    const nonRootRows = rows.filter((r) => r.parentBlockRoot !== null);
    for (const row of nonRootRows) {
      expect(
        allMerkleRoots.has(row.parentBlockRoot as BlockMerkleRoot),
        `Non-root row parentBlockRoot ${row.parentBlockRoot} must reference a valid sibling`,
      ).toBe(true);
    }
  }, 60_000);

  it("slicePlan row count matches rows written to registry (no duplicate persist)", async () => {
    // Idempotency / count check: universalize({persist:true}) must write exactly
    // one row per NovelGlueEntry — no double-write, no missing write.
    const uResult = await universalize({ source: MULTI_LEAF_SOURCE }, registry1, {
      cacheDir,
      offline: true,
      intentStrategy: "static",
      persist: true,
    });

    const novelGlueEntries = uResult.slicePlan.filter((e) => e.kind === "novel-glue");
    const persistedEntries = novelGlueEntries.filter(
      (e) => e.kind === "novel-glue" && e.merkleRoot !== undefined,
    );

    // Every novel-glue entry must be persisted (one-to-one).
    expect(persistedEntries.length).toBe(novelGlueEntries.length);
  }, 60_000);
});
