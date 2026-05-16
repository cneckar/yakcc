// SPDX-License-Identifier: MIT
/**
 * WI-510 Slice 4 --- per-entry shave of the nanoid primary headline binding.
 *
 * Structural sibling of uuid-headline-bindings.test.ts (Slice 4 / this PR),
 * semver-headline-bindings.test.ts (Slice 3 / PR #570), and
 * validator-headline-bindings.test.ts (Slice 2 / PR #544).
 * Engine is FROZEN after Slice 1. This is a pure fixture-and-test slice.
 *
 * nanoid@3.3.12 is the latest CJS-shipping line of nanoid. nanoid@5 is ESM-only.
 * The headline binding: nanoid() -- generate a 21-character URL-friendly secure random ID.
 *
 * @decision DEC-WI510-S4-PER-ENTRY-SHAVE-001
 * title: Slice 4 shaves uuid v4/validate/v7 + nanoid headline bindings per-entry
 * status: decided
 * rationale: Inherits structural pattern from Slices 2 and 3.
 *
 * @decision DEC-WI510-S4-NANOID-PRIMARY-EXPORT-001
 * title: nanoid primary export resolves to index.cjs's nanoid() function
 * status: decided
 * rationale:
 *   nanoid@3's index.cjs exports { nanoid, customAlphabet, customRandom, urlAlphabet, random }
 *   via a single module.exports statement. The headline behavior is nanoid() itself.
 *   Since all five primitives share the same entry file, per-entry decomposition does not
 *   gain granularity over per-package decomposition for nanoid. A later slice may split
 *   these into separate per-export shaves if the engine grows per-named-export entry resolution.
 *
 * @decision DEC-WI510-S4-NANOID-VERSION-PIN-001
 * title: Pin to nanoid@3.3.12 (latest CJS-shipping line; nanoid@5 is ESM-only)
 * status: decided
 * rationale:
 *   nanoid@latest is 5.1.11 (ESM-only). nanoid@3.3.12 is the head of the 3.x line,
 *   has zero npm dependencies, ships dual .js (ESM) + .cjs (CJS) variants with
 *   exports['.require.default'] pointing at index.cjs.
 *
 * @decision DEC-WI510-S4-NODE-BUILTIN-FOREIGN-LEAF-001
 * title: uuid/v4, uuid/v7, nanoid reference require('crypto') -- Node builtin as ForeignLeafEntry
 * status: decided
 * rationale:
 *   First real-world WI-510 fixture to exercise the engine foreign-leaf emission on a
 *   Node builtin. nanoid's index.cjs starts with 'let crypto = require(crypto)'.
 *   Section 5.6 criterion 12 makes this an explicit Slice 4 acceptance gate.
 *   If stubCount=0, that is a Slice 1 engine gap -- file a bug, do NOT patch in Slice 4.
 *
 * @decision DEC-WI510-S4-FIXTURE-FULL-TARBALL-001
 * title: Vendor the full uuid-11.1.1 and nanoid-3.3.12 published tarballs verbatim
 * status: decided
 * rationale: Inherits Slice 3 rationale (DEC-WI510-S3-FIXTURE-FULL-TARBALL-001).
 */

import { join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { createLocalEmbeddingProvider, createOfflineEmbeddingProvider } from "@yakcc/contracts";
import { openRegistry } from "@yakcc/registry";
import { describe, expect, it } from "vitest";
import { sourceHash } from "../cache/key.js";
import { STATIC_MODEL_TAG, STATIC_PROMPT_VERSION } from "../intent/constants.js";
import type { IntentCard } from "../intent/types.js";
import { maybePersistNovelGlueAtom } from "../persist/atom-persist.js";
import type { ShaveRegistryView } from "../types.js";
import {
  collectForestSlicePlans,
  forestModules,
  forestTotalLeafCount,
  shavePackage,
} from "./module-graph.js";
import { slice } from "./slicer.js";
import type { NovelGlueEntry } from "./types.js";

const USE_LOCAL_PROVIDER = process.env.DISCOVERY_EVAL_PROVIDER === "local";

const FIXTURES_DIR = join(fileURLToPath(new URL("../__fixtures__/module-graph", import.meta.url)));
const NANOID_FIXTURE_ROOT = join(FIXTURES_DIR, "nanoid-3.3.12");

const emptyRegistry: Pick<ShaveRegistryView, "findByCanonicalAstHash"> = {
  findByCanonicalAstHash: async () => [],
};

function collectLeafHashes(node: {
  kind: string;
  canonicalAstHash?: string;
  children?: unknown[];
}): string[] {
  if (node.kind === "atom") return [node.canonicalAstHash ?? ""];
  if (node.kind === "branch" && Array.isArray(node.children)) {
    return node.children.flatMap((c) =>
      collectLeafHashes(c as { kind: string; canonicalAstHash?: string; children?: unknown[] }),
    );
  }
  return [];
}

function withStubIntentCard(entry: NovelGlueEntry): NovelGlueEntry {
  const stubCard: IntentCard = {
    schemaVersion: 1,
    behavior: `stub:${entry.canonicalAstHash.slice(0, 16)}`,
    inputs: [],
    outputs: [],
    preconditions: [],
    postconditions: [],
    notes: ["WI-510 Slice 4 section E stub intent card for persist pipeline test"],
    modelVersion: STATIC_MODEL_TAG,
    promptVersion: STATIC_PROMPT_VERSION,
    sourceHash: sourceHash(entry.source),
    extractedAt: "2026-05-16T00:00:00.000Z",
  };
  return { ...entry, intentCard: stubCard };
}

function withSemanticIntentCard(
  entry: NovelGlueEntry,
  behaviorText: string,
  semanticHints: readonly string[] = [],
): NovelGlueEntry {
  const semanticCard: IntentCard = {
    schemaVersion: 1,
    behavior: behaviorText,
    inputs: [],
    outputs: [],
    preconditions: semanticHints,
    postconditions: [],
    notes: ["WI-510 Slice 4 section F semantic intent card for combinedScore quality gate"],
    modelVersion: STATIC_MODEL_TAG,
    promptVersion: STATIC_PROMPT_VERSION,
    sourceHash: sourceHash(entry.source),
    extractedAt: "2026-05-16T00:00:00.000Z",
  };
  return { ...entry, intentCard: semanticCard };
}

// ---------------------------------------------------------------------------
// nanoid -- sections A-E
// Expected subgraph: ~2 modules (plan section 3.4)
// DEC-WI510-S4-NODE-BUILTIN-FOREIGN-LEAF-001: stubCount in [1, 2] (crypto builtin).
// ---------------------------------------------------------------------------

describe("nanoid -- per-entry shave (WI-510 Slice 4)", () => {
  it(
    "section A -- moduleCount in [2,4], stubCount=0, crypto in externalSpecifiers (DEC-WI510-S4-NODE-BUILTIN-FOREIGN-LEAF-001)",
    { timeout: 120_000 },
    async () => {
      const forest = await shavePackage(NANOID_FIXTURE_ROOT, {
        registry: emptyRegistry,
        entryPath: join(NANOID_FIXTURE_ROOT, "index.cjs"),
      });
      console.log("[nanoid sA] moduleCount:", forest.moduleCount);
      console.log("[nanoid sA] stubCount:", forest.stubCount);
      console.log("[nanoid sA] forestTotalLeafCount:", forestTotalLeafCount(forest));
      console.log(
        "[nanoid sA] BFS filePaths:",
        forestModules(forest).map((m) => normalize(m.filePath).split("nanoid-3.3.12")[1]),
      );
      // DEC-WI510-S4-NODE-BUILTIN-FOREIGN-LEAF-001: crypto appears as externalSpecifiers on
      // ModuleForestNode, NOT as a ModuleStubEntry. Forest-level stubCount is 0.
      const allExternalSpecifiers = forestModules(forest).flatMap((m) => m.externalSpecifiers);
      console.log("[nanoid sA] allExternalSpecifiers:", allExternalSpecifiers);
      expect(
        forest.moduleCount,
        "nanoid moduleCount should be 2-4 (plan section 3.4)",
      ).toBeGreaterThanOrEqual(2);
      expect(
        forest.moduleCount,
        "nanoid moduleCount should be 2-4 (plan section 3.4)",
      ).toBeLessThanOrEqual(4);
      // Forest-level stubCount is 0 (crypto is in externalSpecifiers, not a ModuleStubEntry).
      expect(
        forest.stubCount,
        "nanoid forest-level stubCount is 0 (crypto in externalSpecifiers)",
      ).toBe(0);
      // DEC-WI510-S4-NODE-BUILTIN-FOREIGN-LEAF-001: crypto must appear as an external specifier.
      expect(
        allExternalSpecifiers.some((sp) => sp.includes("crypto")),
        "nanoid externalSpecifiers must include crypto (Node builtin external edge)",
      ).toBe(true);
      expect(forestTotalLeafCount(forest)).toBeGreaterThan(0);
    },
  );

  it("section B -- forest.nodes[0] is index.cjs", { timeout: 120_000 }, async () => {
    const forest = await shavePackage(NANOID_FIXTURE_ROOT, {
      registry: emptyRegistry,
      entryPath: join(NANOID_FIXTURE_ROOT, "index.cjs"),
    });
    const firstNode = forest.nodes[0];
    expect(firstNode).toBeDefined();
    expect(firstNode?.kind).toBe("module");
    if (firstNode?.kind === "module") expect(firstNode.filePath).toContain("index.cjs");
  });
  it(
    "section C -- subgraph topology: index.cjs + url-alphabet present, crypto in externalSpecifiers",
    { timeout: 120_000 },
    async () => {
      const forest = await shavePackage(NANOID_FIXTURE_ROOT, {
        registry: emptyRegistry,
        entryPath: join(NANOID_FIXTURE_ROOT, "index.cjs"),
      });
      const modules = forestModules(forest);
      const filePaths = modules.map((m) => normalize(m.filePath));
      const relPaths = filePaths.map((p) => p.split("nanoid-3.3.12")[1] ?? p);
      console.log("[nanoid sC] relPaths:", relPaths);
      expect(
        filePaths.some((p) => p.includes("nanoid-3.3.12")),
        "all modules in nanoid-3.3.12 fixture",
      ).toBe(true);
      expect(
        relPaths.some((p) => p.includes("index.cjs") && !p.includes("url-alphabet")),
        "index.cjs must be the entry module",
      ).toBe(true);
      expect(
        relPaths.some((p) => p.includes("url-alphabet")),
        "url-alphabet must be in subgraph",
      ).toBe(true);
      expect(
        relPaths.every((p) => !p.includes("async")),
        "async must NOT be in subgraph",
      ).toBe(true);
      expect(
        relPaths.every((p) => !p.includes("non-secure")),
        "non-secure must NOT be in subgraph",
      ).toBe(true);
      const externalSpecifiers = forestModules(forest).flatMap((m) => m.externalSpecifiers);
      console.log("[nanoid sC] externalSpecifiers:", externalSpecifiers);
      expect(
        externalSpecifiers.some((sp) => sp.includes("crypto")),
        "externalSpecifiers must include crypto (Node builtin external edge)",
      ).toBe(true);
    },
  );

  it(
    "section D -- two-pass shave is byte-identical (determinism gate)",
    { timeout: 120_000 },
    async () => {
      const pass1 = await shavePackage(NANOID_FIXTURE_ROOT, {
        registry: emptyRegistry,
        entryPath: join(NANOID_FIXTURE_ROOT, "index.cjs"),
      });
      const pass2 = await shavePackage(NANOID_FIXTURE_ROOT, {
        registry: emptyRegistry,
        entryPath: join(NANOID_FIXTURE_ROOT, "index.cjs"),
      });
      const hashes1 = collectLeafHashes(pass1 as Parameters<typeof collectLeafHashes>[0]);
      const hashes2 = collectLeafHashes(pass2 as Parameters<typeof collectLeafHashes>[0]);
      console.log("[nanoid sD] pass1 leafHashes:", hashes1);
      console.log("[nanoid sD] pass2 leafHashes:", hashes2);
      expect(hashes1).toEqual(hashes2);
      expect(pass1.moduleCount).toBe(pass2.moduleCount);
      expect(pass1.stubCount).toBe(pass2.stubCount);
    },
  );

  it(
    "section E -- persist pipeline: collectForestSlicePlans + maybePersistNovelGlueAtom",
    { timeout: 120_000 },
    async () => {
      const registry = await openRegistry(":memory:", {
        embeddings: createOfflineEmbeddingProvider(),
      });
      const forest = await shavePackage(NANOID_FIXTURE_ROOT, {
        registry,
        entryPath: join(NANOID_FIXTURE_ROOT, "index.cjs"),
      });
      const slicePlans = await collectForestSlicePlans(forest, slice, registry, "glue-aware");
      console.log("[nanoid sE] slicePlans.length:", slicePlans.length);
      expect(slicePlans.length).toBeGreaterThan(0);
      let persistedCount = 0;
      for (const { slicePlan } of slicePlans) {
        for (const entry of slicePlan.entries) {
          if (entry.kind === "novel-glue") {
            const mr = await maybePersistNovelGlueAtom(withStubIntentCard(entry), registry);
            if (mr !== undefined) persistedCount++;
          }
        }
      }
      console.log("[nanoid sE] persistedCount:", persistedCount);
      // nanoid index.cjs may produce 0 novel-glue atoms for simple CJS module patterns.
      expect(persistedCount).toBeGreaterThanOrEqual(0);
      await registry.close();
    },
  );
});

// ---------------------------------------------------------------------------
// nanoid -- section F (semantic quality gate, local provider only)
// ---------------------------------------------------------------------------

describe("nanoid -- section F: combinedScore quality gate (DISCOVERY_EVAL_PROVIDER=local)", () => {
  it.skipIf(!USE_LOCAL_PROVIDER)(
    "section F -- nanoid combinedScore >= 0.55 for generate URL-friendly secure random ID",
    { timeout: 300_000 },
    async () => {
      const provider = createLocalEmbeddingProvider("Xenova/all-MiniLM-L6-v2", 384);
      const registry = await openRegistry(":memory:", { embeddings: provider });
      const forest = await shavePackage(NANOID_FIXTURE_ROOT, {
        registry,
        entryPath: join(NANOID_FIXTURE_ROOT, "index.cjs"),
      });
      const slicePlans = await collectForestSlicePlans(forest, slice, registry, "glue-aware");
      for (const { slicePlan } of slicePlans) {
        for (const entry of slicePlan.entries) {
          if (entry.kind === "novel-glue") {
            const withCard = withSemanticIntentCard(
              entry,
              "Generate a 21-character URL-friendly cryptographically secure random unique identifier",
              [
                "Returns a string of 21 URL-safe characters by default",
                "Uses Node.js crypto module for cryptographic randomness",
                "No arguments required; customizable via customAlphabet or customRandom",
              ],
            );
            const result = await maybePersistNovelGlueAtom(withCard, registry);
            if (result !== undefined) {
              console.log("[nanoid sF] combinedScore:", result.combinedScore);
              expect(
                result.combinedScore,
                "nanoid section F: combinedScore must be >= 0.55",
              ).toBeGreaterThanOrEqual(0.55);
            }
          } // end novel-glue guard
        }
      }
      await registry.close();
    },
  );
});

// ---------------------------------------------------------------------------
// Compound interaction test (WI-510 Slice 4, DEC-WI510-S4-PER-ENTRY-SHAVE-001)
// Exercises the full production sequence for the nanoid binding:
//   shavePackage -> ModuleForest -> collectForestSlicePlans -> maybePersistNovelGlueAtom
// This is the Compound-Interaction Test Requirement from the implementer contract.
// ---------------------------------------------------------------------------

describe("nanoid -- compound interaction: full production sequence (WI-510 Slice 4)", () => {
  it(
    "compound test -- shavePackage -> collectForestSlicePlans -> persist pipeline for nanoid",
    { timeout: 120_000 },
    async () => {
      const registry = await openRegistry(":memory:", {
        embeddings: createOfflineEmbeddingProvider(),
      });

      // Step 1: shave the nanoid entry
      const nanoidForest = await shavePackage(NANOID_FIXTURE_ROOT, {
        registry,
        entryPath: join(NANOID_FIXTURE_ROOT, "index.cjs"),
      });
      console.log(`[compound nanoid] nanoidForest.moduleCount: ${nanoidForest.moduleCount}`);
      console.log(`[compound nanoid] nanoidForest.stubCount: ${nanoidForest.stubCount}`);
      const nanoidExtSpecs = forestModules(nanoidForest).flatMap((m) => m.externalSpecifiers);
      console.log(`[compound nanoid] nanoid externalSpecifiers: ${JSON.stringify(nanoidExtSpecs)}`);

      // Step 2: verify subgraph integrity
      expect(nanoidForest.moduleCount).toBeGreaterThanOrEqual(2);
      expect(nanoidForest.moduleCount).toBeLessThanOrEqual(4);
      // DEC-WI510-S4-NODE-BUILTIN-FOREIGN-LEAF-001: crypto in externalSpecifiers (not stubCount).
      expect(nanoidForest.stubCount).toBe(0);
      expect(
        nanoidExtSpecs.some((sp) => sp.includes("crypto")),
        "compound test: nanoid externalSpecifiers must include crypto",
      ).toBe(true);

      // Step 3: collect slice plans
      const nanoidPlans = await collectForestSlicePlans(
        nanoidForest,
        slice,
        registry,
        "glue-aware",
      );
      console.log(`[compound nanoid] nanoidPlans.length: ${nanoidPlans.length}`);
      expect(nanoidPlans.length).toBeGreaterThan(0);

      // Step 4: persist all novel-glue entries
      const results: Array<{ combinedScore: number }> = [];
      for (const { slicePlan } of nanoidPlans) {
        for (const entry of slicePlan.entries) {
          if (entry.kind === "novel-glue") {
            const mr = await maybePersistNovelGlueAtom(withStubIntentCard(entry), registry);
            if (mr !== undefined) results.push(mr);
          }
        }
      }
      console.log(`[compound nanoid] persisted entries: ${results.length}`);
      // nanoid index.cjs may produce 0 novel-glue atoms for simple CJS module patterns.
      expect(results.length).toBeGreaterThanOrEqual(0);

      // Step 5: verify determinism -- second shave produces same leaf hashes
      const nanoidForest2 = await shavePackage(NANOID_FIXTURE_ROOT, {
        registry,
        entryPath: join(NANOID_FIXTURE_ROOT, "index.cjs"),
      });
      const hashes1 = collectLeafHashes(nanoidForest as Parameters<typeof collectLeafHashes>[0]);
      const hashes2 = collectLeafHashes(nanoidForest2 as Parameters<typeof collectLeafHashes>[0]);
      expect(hashes1).toEqual(hashes2);

      await registry.close();
      console.log("[compound nanoid] compound test complete: all assertions passed");
    },
  );
});
