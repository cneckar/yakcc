/**
 * multi-leaf-persist.test.ts — End-to-end multi-leaf intent wiring + lineage test.
 *
 * @decision DEC-UNIVERSALIZE-MULTI-LEAF-INTENT-001
 * title: Per-leaf extractIntent call (strategy: "static") for multi-leaf trees
 * status: accepted (WI-031)
 * rationale:
 *   Strategy (a) chosen: call extractIntent per novel-glue entry in the multi-leaf
 *   branch of universalize(), using strategy: "static" so no LLM round-trip occurs
 *   in tests or offline environments. The static path (WI-023 default) means each
 *   per-leaf call is cheap (no API), produces semantically faithful cards derived
 *   from the actual leaf source (JSDoc + signature), and participates in the same
 *   seedIntentCache / offline discipline as single-leaf plans.
 *
 *   Strategy (b) rejected: cloning the root card and overriding per-leaf fields
 *   produces semantically-questionable cards (wrong behavior text, wrong inputs)
 *   and introduces a parallel mechanism that violates the no-duplicate-logic
 *   principle. It also does not exercise the real extractIntent path, so test
 *   coverage would be thinner.
 *
 * Production trigger:
 *   universalize() is called by shave() for each source file. When the slicer
 *   produces a multi-leaf plan (e.g. a SourceFile with >1 CF boundaries that
 *   decomposes into multiple top-level statement atoms), the WI-031 multi-leaf
 *   branch of universalize() calls extractIntent per novel-glue entry to populate
 *   intentCard. shave()'s postorder for-loop (index.ts:586-606) then persists each
 *   novel-glue entry with the correct parentBlockRoot, building the full lineage
 *   chain:
 *     entry[0] → parentBlockRoot=null (first entry in DFS)
 *     entry[1] → parentBlockRoot=entry[0].blockMerkleRoot
 *     ...etc
 *
 * Real production sequence exercised here:
 *   shave(tmpFile, registry, { offline: true, intentStrategy: "static" })
 *     → universalize() → multi-leaf branch (per-leaf extractIntent via static path)
 *     → maybePersistNovelGlueAtom x N
 *     → registry.getBlock x N (readback + lineage assertions)
 *
 * Multi-leaf source fixture:
 *   A source with multiple top-level if-statements (total CF boundaries > default
 *   maxControlFlowBoundaries=1) forces the SourceFile to be a BranchNode, and each
 *   individual if-statement (1 CF boundary ≤ 1) becomes an AtomLeaf. This is the
 *   canonical multi-leaf pattern from recursion.test.ts. The slicer emits all
 *   top-level statement atoms as NovelGlueEntry (none in the registry).
 *
 * Why openRegistry(":memory:") (real SQLite):
 *   The WI spec is explicit: "Tests use openRegistry(':memory:') so the
 *   parent_block_root assertion exercises actual persistence." Mocking storeBlock
 *   would prove nothing about the DB column write — the real round-trip is required.
 *
 * Offline-tolerance:
 *   strategy: "static" is always offline-safe (TypeScript Compiler API + JSDoc
 *   extractor, no network). No seedIntentCache() call is needed for the static
 *   path; the extractor produces cards directly from the source fragment without
 *   a cache round-trip.
 *
 * Mocking boundary:
 *   openRegistry(:memory:) is the only real external boundary.
 *   Anthropic API is bypassed via strategy: "static" (no network needed).
 *   Corpus extraction uses the default sources (a)+(b) only (no cache dir for (c)).
 */

import { rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { BlockMerkleRoot } from "@yakcc/contracts";
import { openRegistry } from "@yakcc/registry";
import type { BlockTripletRow, Registry } from "@yakcc/registry";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { shave } from "../index.js";

// ---------------------------------------------------------------------------
// Mock embedding provider (deterministic, no ONNX)
// ---------------------------------------------------------------------------

function mockEmbeddingProvider() {
  return {
    dimension: 384,
    modelId: "mock/test-provider",
    async embed(text: string): Promise<Float32Array> {
      const vec = new Float32Array(384);
      for (let i = 0; i < 384; i++) {
        const charCode = text.charCodeAt(i % text.length) / 128;
        vec[i] = charCode + i * 0.001;
      }
      let norm = 0;
      for (const v of vec) norm += v * v;
      const scale = norm > 0 ? 1 / Math.sqrt(norm) : 1;
      for (let i = 0; i < vec.length; i++) {
        const val = vec[i];
        if (val !== undefined) vec[i] = (val as number) * scale;
      }
      return vec;
    },
  };
}

// ---------------------------------------------------------------------------
// Multi-leaf source fixture
//
// This source has two top-level if-statements (total CF boundaries = 2,
// which exceeds the default maxControlFlowBoundaries=1). The decomposer
// classifies the SourceFile as a BranchNode and recurses: each individual
// if-statement (1 CF boundary ≤ 1) becomes an AtomLeaf. The declare
// statements (0 CF boundaries) also become AtomLeafs.
//
// Result: leafCount > 1, slicePlan.entries.length > 1, all NovelGlueEntry
// (nothing in the registry). This reliably exercises the multi-leaf branch
// in universalize() and shave()'s postorder lineage loop.
//
// Pattern confirmed by recursion.test.ts (line 95-116): the canonical test
// for "branch root with 2 atom children" uses exactly this shape.
// ---------------------------------------------------------------------------

const MULTI_LEAF_SOURCE = [
  "// SPDX-License-Identifier: MIT",
  "declare const a: boolean;",
  "declare const b: boolean;",
  'if (a) { console.log("a-branch"); }',
  'if (b) { console.log("b-branch"); }',
].join("\n");

// ---------------------------------------------------------------------------
// Per-test state
// ---------------------------------------------------------------------------

let cacheDir: string;
let tmpFilePath: string;
let registry: Registry;

beforeEach(async () => {
  const unique = randomUUID();
  cacheDir = join(tmpdir(), `multi-leaf-test-${unique}`);
  tmpFilePath = join(tmpdir(), `multi-leaf-src-${unique}.ts`);

  // Write the multi-leaf source to a temp file (shave() reads from disk).
  await writeFile(tmpFilePath, MULTI_LEAF_SOURCE, "utf-8");

  // Open a fresh in-memory SQLite registry for each test.
  registry = await openRegistry(":memory:", {
    embeddings: mockEmbeddingProvider(),
  });

  // Remove API key to guarantee no live LLM calls can be made.
  // biome-ignore lint/performance/noDelete: process.env requires delete to truly unset (= undefined coerces to "undefined" string)
  delete process.env.ANTHROPIC_API_KEY;
});

afterEach(async () => {
  await registry.close();
  await rm(tmpFilePath, { force: true });
  await rm(cacheDir, { recursive: true, force: true }).catch(() => {});
  // biome-ignore lint/performance/noDelete: process.env requires delete to truly unset (= undefined coerces to "undefined" string)
  delete process.env.ANTHROPIC_API_KEY;
});

// ---------------------------------------------------------------------------
// Test suite: WI-031 multi-leaf intent wiring + lineage
// ---------------------------------------------------------------------------

describe("WI-031: multi-leaf intentCard attachment + lineage (openRegistry :memory:)", () => {
  it(
    "shave() persists > 1 BlockTripletRow with valid parent_block_root lineage chain",
    async () => {
      // strategy: "static" is offline-safe — no seedIntentCache() needed.
      const result = await shave(tmpFilePath, registry, {
        cacheDir,
        offline: true,
        // strategy: "static" is the default per DEC-INTENT-STRATEGY-001; explicit here for clarity.
        intentStrategy: "static",
      });

      // ---- Assert > 1 atoms persisted ----
      const persistedAtoms = result.atoms.filter((a) => a.merkleRoot !== undefined);
      expect(
        persistedAtoms.length,
        "Expected > 1 atoms persisted for multi-leaf source",
      ).toBeGreaterThan(1);

      // ---- Readback all rows from registry ----
      const allRows: BlockTripletRow[] = [];
      for (const atom of result.atoms) {
        if (atom.merkleRoot !== undefined) {
          const row = await registry.getBlock(atom.merkleRoot);
          expect(row, `Expected row for merkleRoot ${atom.merkleRoot}`).not.toBeNull();
          allRows.push(row!);
        }
      }

      expect(
        allRows.length,
        "Row count must match persisted atom count",
      ).toBe(persistedAtoms.length);

      // ---- Assert exactly one root (parentBlockRoot === null) ----
      const rootRows = allRows.filter((r) => r.parentBlockRoot === null);
      expect(
        rootRows.length,
        "Exactly one row must have parentBlockRoot === null (the root)",
      ).toBe(1);

      // ---- Assert all non-root rows have parentBlockRoot pointing to a valid merkle root ----
      const allMerkleRoots = new Set(allRows.map((r) => r.blockMerkleRoot));
      const nonRootRows = allRows.filter((r) => r.parentBlockRoot !== null);

      expect(
        nonRootRows.length,
        "Non-root rows must exist (lineage chain must be populated)",
      ).toBeGreaterThan(0);

      for (const row of nonRootRows) {
        expect(
          allMerkleRoots.has(row.parentBlockRoot as BlockMerkleRoot),
          `Non-root row parentBlockRoot ${row.parentBlockRoot} must reference a valid sibling row`,
        ).toBe(true);
      }
    },
    30_000,
  );

  it(
    "shave() is deterministic: two independent shave calls produce byte-identical merkle roots",
    async () => {
      // Determinism proof: run shave() against two separate fresh in-memory registries.
      // Each registry starts empty so both calls go through the novel-glue persist path.
      // The resulting merkle roots must be byte-identical (content-address determinism).
      //
      // Why separate registries rather than two calls on the same registry:
      //   A second call against a populated registry finds all blocks already stored and
      //   emits PointerEntry items (slicer deduplicates against registry). PointerEntry
      //   carries no merkleRoot on the ShavedAtomStub. To assert determinism we need both
      //   runs to independently persist from scratch — hence two fresh in-memory registries.
      const registry2 = await openRegistry(":memory:", {
        embeddings: mockEmbeddingProvider(),
      });

      try {
        // First shave: uses the beforeEach registry (fresh, empty).
        const result1 = await shave(tmpFilePath, registry, {
          cacheDir,
          offline: true,
          intentStrategy: "static",
        });

        const merkleRoots1 = result1.atoms
          .filter((a) => a.merkleRoot !== undefined)
          .map((a) => a.merkleRoot as BlockMerkleRoot)
          .sort();

        expect(
          merkleRoots1.length,
          "First shave must produce > 1 persisted atoms",
        ).toBeGreaterThan(1);

        // Second shave: uses a second fresh registry — independent from the first.
        const result2 = await shave(tmpFilePath, registry2, {
          cacheDir,
          offline: true,
          intentStrategy: "static",
        });

        const merkleRoots2 = result2.atoms
          .filter((a) => a.merkleRoot !== undefined)
          .map((a) => a.merkleRoot as BlockMerkleRoot)
          .sort();

        // Same number of atoms.
        expect(
          merkleRoots2.length,
          "Second shave must produce same number of persisted atoms as first",
        ).toBe(merkleRoots1.length);

        // Byte-identical merkle roots (content-address determinism).
        expect(
          merkleRoots2,
          "Second shave must produce byte-identical merkle roots (determinism)",
        ).toEqual(merkleRoots1);
      } finally {
        await registry2.close();
      }
    },
    30_000,
  );
});
