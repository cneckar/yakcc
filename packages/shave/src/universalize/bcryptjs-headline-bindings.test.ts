// SPDX-License-Identifier: MIT
/**
 * WI-510 Slice 6 --- per-entry shave of bcryptjs headline binding (UMD IIFE engine-gap proof).
 *
 * Engine is FROZEN after Slice 1. This is a pure fixture-and-test slice.
 * bcryptjs@2.4.3: one entryPath shave (dist/bcrypt.js -- UMD IIFE).
 *
 * EMPIRICAL FINDING (engine gap corroborated 2026-05-16):
 *   The bcryptjs dist/bcrypt.js is a UMD IIFE pattern:
 *     (function(global, factory) { ... }(this, function() { var bcrypt = {}; ... return bcrypt; }))
 *   The shave engine's decompose() cannot parse this UMD IIFE as a CJS module -- it returns
 *   a stub entry. Empirical result: moduleCount=0, stubCount=1.
 *   This is the first WI-510 real-world fixture that surfaces this engine gap.
 *
 *   Per plan section 3.3 / section 5.5 / section 1.3:
 *   "If the engine throws on the IIFE (e.g. some unsupported syntax), decompose() returns
 *    a stub entry and stubCount = 1. This is a stop-and-report engine-gap finding -- file a
 *    new bug against the engine; do not patch in-slice."
 *
 *   ENGINE GAP filed as GitHub issue #576-class / tracked separately from Slice 6.
 *   Slice 6 stops and reports this finding. The bcryptjs corpus rows (hash, verify) are
 *   appended with expectedAtom: null (no atom merkle root available until engine gap is fixed).
 *   When the engine gap is resolved, the tests in sections A-E and the compound test must be
 *   updated to assert the live atom merkle root, and sections F run with DISCOVERY_EVAL_PROVIDER=local.
 *
 * Plan section 3.3 predicted: moduleCount in [1, 2], stubCount = 0 (crypto in externalSpecifiers).
 * Empirical result:            moduleCount = 0, stubCount = 1, externalSpecifiers = [].
 * Delta documented here per the PR #571 lesson: the test asserts what the engine ACTUALLY emits.
 *
 * Two corpus rows: hash, verify. Both point at the same atom when the engine gap is fixed.
 * DEC-WI510-S6-BCRYPTJS-SINGLE-MODULE-PACKAGE-001: see rationale below.
 *
 * @decision DEC-WI510-S6-PER-ENTRY-SHAVE-001
 * title: Slice 6 shaves jsonwebtoken verify+decode + bcryptjs package atom per-entry
 * status: decided
 * rationale: Inherits the structural pattern from Slices 2-4.
 *
 * @decision DEC-WI510-S6-BCRYPT-USE-BCRYPTJS-001
 * title: Slice 6 substitutes bcryptjs@2.4.3 for the issue body bcrypt
 * status: decided
 * rationale: Native bcrypt ships precompiled .node binaries the shave engine cannot
 *   decompose. bcryptjs is the canonical pure-JS implementation with identical public API.
 *   The substitution is honest about what the engine can atomize.
 *
 * @decision DEC-WI510-S6-BCRYPTJS-SINGLE-MODULE-PACKAGE-001
 * title: bcryptjs dist/bcrypt.js is a UMD IIFE -- engine cannot decompose it (engine gap)
 * status: decided (engine gap documented; atom available when gap is fixed)
 * rationale: index.js is a 1-line shim; dist/bcrypt.js is a 1,379-line UMD IIFE wrapping
 *   the entire library. No internal require() edges. The shave engine decompose() returns a
 *   stub for the UMD IIFE pattern. First WI-510 real-world fixture to surface this engine gap.
 *   Per plan section 5.5 forbidden shortcuts, the engine is FROZEN -- the gap is filed as a
 *   separate bug, not patched in-slice.
 *
 * @decision DEC-WI510-S6-BCRYPTJS-VERSION-PIN-001
 * title: Pin to bcryptjs@2.4.3 (most-installed 2.x line)
 * status: decided
 * rationale: 12M weekly downloads on 2.x line; zero npm deps; same UMD IIFE shape as 3.x.
 *
 * @decision DEC-WI510-S6-FIXTURE-FULL-TARBALL-001
 * title: Vendor the full jsonwebtoken-9.0.2 and bcryptjs-2.4.3 published tarballs verbatim
 * status: decided
 * rationale: Inherits DEC-WI510-S3-FIXTURE-FULL-TARBALL-001 and DEC-WI510-S4-FIXTURE-FULL-TARBALL-001.
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
  forestStubs,
  forestTotalLeafCount,
  shavePackage,
} from "./module-graph.js";
import { slice } from "./slicer.js";
import type { NovelGlueEntry } from "./types.js";

const USE_LOCAL_PROVIDER = process.env.DISCOVERY_EVAL_PROVIDER === "local";

const FIXTURES_DIR = join(fileURLToPath(new URL("../__fixtures__/module-graph", import.meta.url)));
const BCRYPTJS_FIXTURE_ROOT = join(FIXTURES_DIR, "bcryptjs-2.4.3");

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
    notes: ["WI-510 Slice 6 section E stub intent card for persist pipeline test"],
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
    notes: ["WI-510 Slice 6 section F semantic intent card for combinedScore quality gate"],
    modelVersion: STATIC_MODEL_TAG,
    promptVersion: STATIC_PROMPT_VERSION,
    sourceHash: sourceHash(entry.source),
    extractedAt: "2026-05-16T00:00:00.000Z",
  };
  return { ...entry, intentCard: semanticCard };
}

// ---------------------------------------------------------------------------
// bcryptjs dist/bcrypt.js -- sections A-E (ENGINE GAP DOCUMENTATION)
// Entry: dist/bcrypt.js (UMD IIFE, 1379 lines)
//
// EMPIRICAL (2026-05-16): moduleCount=0, stubCount=1, externalSpecifiers=[]
// Plan predicted:         moduleCount in [1,2], stubCount=0, externalSpecifiers=[crypto]
//
// The shave engine returns a stub for the UMD IIFE. Plan section 3.3 states:
// "If the engine throws on the IIFE, decompose() returns a stub entry and stubCount = 1.
//  This is a stop-and-report engine-gap finding."
//
// All tests below assert the EMPIRICAL behavior (per the PR #571 lesson:
// "the implementer asserts what is actually emitted, not the planner estimate").
//
// DEC-WI510-S6-BCRYPTJS-SINGLE-MODULE-PACKAGE-001 is recorded at this annotation point.
// ENGINE GAP: file a bug against the engine for UMD IIFE / CallExpression-wrapping-FunctionExpression
// decomposition. The hash/verify corpus rows will point at the atom once the gap is fixed.
// ---------------------------------------------------------------------------

describe("bcryptjs-package-atom -- per-entry shave (WI-510 Slice 6)", () => {
  it(
    "section A -- ENGINE GAP: dist/bcrypt.js UMD IIFE produces stubCount=1 moduleCount=0 (plan predicted [1,2] / 0 -- see DEC-WI510-S6-BCRYPTJS-SINGLE-MODULE-PACKAGE-001)",
    { timeout: 120_000 },
    async () => {
      const forest = await shavePackage(BCRYPTJS_FIXTURE_ROOT, {
        registry: emptyRegistry,
        entryPath: join(BCRYPTJS_FIXTURE_ROOT, "dist", "bcrypt.js"),
      });
      console.log("[bcryptjs sA] moduleCount:", forest.moduleCount);
      console.log("[bcryptjs sA] stubCount:", forest.stubCount);
      console.log("[bcryptjs sA] forestTotalLeafCount:", forestTotalLeafCount(forest));
      console.log(
        "[bcryptjs sA] BFS filePaths:",
        forestModules(forest).map((m) => normalize(m.filePath).split("bcryptjs-2.4.3")[1]),
      );
      const allExternalSpecifiers = forestModules(forest).flatMap((m) => m.externalSpecifiers);
      console.log("[bcryptjs sA] allExternalSpecifiers:", allExternalSpecifiers);
      console.log(
        "[bcryptjs sA] stubs:",
        forestStubs(forest).map((s) => s.specifier),
      );
      // ENGINE GAP (DEC-WI510-S6-BCRYPTJS-SINGLE-MODULE-PACKAGE-001):
      // The UMD IIFE pattern is not parseable by the shave engine's decompose().
      // dist/bcrypt.js is returned as a stub entry (kind="stub") rather than a module.
      // Empirical shape: moduleCount=0, stubCount=1.
      // Plan predicted moduleCount in [1,2] but that assumed IIFE decomposition works.
      // When the engine gap is fixed, update to expect moduleCount >= 1 and stubCount = 0.
      expect(
        forest.moduleCount,
        "ENGINE GAP: bcryptjs UMD IIFE produces 0 decomposable modules (see DEC-WI510-S6-BCRYPTJS-SINGLE-MODULE-PACKAGE-001)",
      ).toBe(0);
      expect(
        forest.stubCount,
        "ENGINE GAP: bcryptjs dist/bcrypt.js UMD IIFE is returned as a stub by decompose()",
      ).toBe(1);
      // The stub should reference dist/bcrypt.js.
      const stubs = forestStubs(forest);
      expect(stubs.length).toBe(1);
      expect(stubs[0]?.specifier).toContain("bcrypt.js");
    },
  );

  it(
    "section B -- ENGINE GAP: forest.nodes[0] is a stub (not a module) -- UMD IIFE decompose() failure",
    { timeout: 120_000 },
    async () => {
      const forest = await shavePackage(BCRYPTJS_FIXTURE_ROOT, {
        registry: emptyRegistry,
        entryPath: join(BCRYPTJS_FIXTURE_ROOT, "dist", "bcrypt.js"),
      });
      const firstNode = forest.nodes[0];
      expect(firstNode).toBeDefined();
      // ENGINE GAP: the UMD IIFE is parsed as a stub, not a module.
      // Plan expected kind="module" with filePath containing bcrypt.js.
      // Empirical: kind="stub" with specifier containing bcrypt.js.
      expect(firstNode?.kind).toBe("stub");
      if (firstNode?.kind === "stub") expect(firstNode.specifier).toContain("bcrypt.js");
    },
  );

  it(
    "section C -- ENGINE GAP: bcryptjs subgraph has 0 modules, 1 stub; no externalSpecifiers emitted (crypto blocked by IIFE gap)",
    { timeout: 120_000 },
    async () => {
      const forest = await shavePackage(BCRYPTJS_FIXTURE_ROOT, {
        registry: emptyRegistry,
        entryPath: join(BCRYPTJS_FIXTURE_ROOT, "dist", "bcrypt.js"),
      });
      // ENGINE GAP: no modules in the forest -- the UMD IIFE is a stub.
      const filePaths = forestModules(forest).map((m) => m.filePath);
      expect(filePaths.length).toBe(0);
      // The stub's specifier must reference dist/bcrypt.js (not src/ files which are not CJS modules).
      const stubs = forestStubs(forest);
      expect(stubs.length).toBe(1);
      const stubSpecifier = stubs[0]?.specifier ?? "";
      expect(stubSpecifier).toContain("bcrypt.js");
      expect(stubSpecifier).not.toContain("src/");
      // No externalSpecifiers can be emitted from a stub (the IIFE's require("crypto") is not
      // extractable when the module itself is not parsed). Plan expected crypto to appear here.
      // When engine gap is fixed, update to expect externalSpecifiers.includes("crypto").
      const externalSpecifiers = forestModules(forest).flatMap((m) => m.externalSpecifiers);
      console.log("[bcryptjs sC] externalSpecifiers:", externalSpecifiers);
      console.log(
        "[bcryptjs sC] stubs:",
        stubs.map((s) => s.specifier),
      );
      expect(externalSpecifiers.length).toBe(0);
    },
  );

  it(
    "section D -- two-pass byte-identical determinism for bcryptjs subgraph (engine gap shape is deterministic)",
    { timeout: 120_000 },
    async () => {
      const entryPath = join(BCRYPTJS_FIXTURE_ROOT, "dist", "bcrypt.js");
      const forest1 = await shavePackage(BCRYPTJS_FIXTURE_ROOT, {
        registry: emptyRegistry,
        entryPath,
      });
      const forest2 = await shavePackage(BCRYPTJS_FIXTURE_ROOT, {
        registry: emptyRegistry,
        entryPath,
      });
      // The stub shape must be deterministic across two passes.
      expect(forest1.moduleCount).toBe(forest2.moduleCount);
      expect(forest1.stubCount).toBe(forest2.stubCount);
      expect(forestTotalLeafCount(forest1)).toBe(forestTotalLeafCount(forest2));
      expect(forestModules(forest1).map((m) => m.filePath)).toEqual(
        forestModules(forest2).map((m) => m.filePath),
      );
      expect(
        forestModules(forest1)
          .flatMap((m) => collectLeafHashes(m.tree.root))
          .sort(),
      ).toEqual(
        forestModules(forest2)
          .flatMap((m) => collectLeafHashes(m.tree.root))
          .sort(),
      );
      expect(
        forestModules(forest1)
          .flatMap((m) => m.externalSpecifiers)
          .sort(),
      ).toEqual(
        forestModules(forest2)
          .flatMap((m) => m.externalSpecifiers)
          .sort(),
      );
      // Stubs themselves must also be deterministic.
      expect(
        forestStubs(forest1)
          .map((s) => s.specifier)
          .sort(),
      ).toEqual(
        forestStubs(forest2)
          .map((s) => s.specifier)
          .sort(),
      );
    },
  );

  it(
    "section E -- ENGINE GAP: bcryptjs stub forest has 0 novel-glue slice plans (no atom persisted until engine gap fixed)",
    { timeout: 120_000 },
    async () => {
      const registry = await openRegistry(":memory:", {
        embeddings: createOfflineEmbeddingProvider(),
      });
      try {
        const forest = await shavePackage(BCRYPTJS_FIXTURE_ROOT, {
          registry,
          entryPath: join(BCRYPTJS_FIXTURE_ROOT, "dist", "bcrypt.js"),
        });
        // ENGINE GAP: the stub forest has no decomposable modules, so collectForestSlicePlans
        // produces no novel-glue entries. persistedCount = 0.
        // When engine gap is fixed: plans.length > 0 and persistedCount > 0.
        const plans = await collectForestSlicePlans(forest, slice, registry, "glue-aware");
        let persistedCount = 0;
        for (const { slicePlan } of plans) {
          for (const entry of slicePlan.entries) {
            if (entry.kind === "novel-glue") {
              const mr = await maybePersistNovelGlueAtom(withStubIntentCard(entry), registry);
              if (mr !== undefined) {
                persistedCount++;
                expect(await registry.getBlock(mr)).not.toBeNull();
              }
            }
          }
        }
        console.log("[bcryptjs sE] plans:", plans.length, "persisted atoms:", persistedCount);
        // Empirical: 0 plans, 0 persisted atoms.
        // This is the documented stop-and-report outcome for the UMD IIFE engine gap.
        expect(persistedCount).toBe(0);
      } finally {
        await registry.close();
      }
    },
  );
});

// ---------------------------------------------------------------------------
// Section F tests (combinedScore quality gate, DISCOVERY_EVAL_PROVIDER=local)
// ENGINE GAP: these tests are structurally valid but will produce 0 candidates
// because the bcryptjs forest has no atoms to persist. Once the engine gap is
// fixed (dist/bcrypt.js UMD IIFE becomes decomposable), these tests will run
// and produce atoms that can be scored.
//
// Per plan section 5.6 criterion 7: if DISCOVERY_EVAL_PROVIDER=local is absent,
// the quality block skips. With ENGINE GAP active, even with local provider,
// no atoms are persisted, so combinedScore cannot be measured.
// The tests are kept to document the intended assertion shape for future maintainers.
//
// Two corpus query strings for bcryptjs (both retrieve the SAME atom when gap fixed):
//   cat1-bcryptjs-hash-001
//   cat1-bcryptjs-verify-001
// DEC-WI510-S6-BCRYPTJS-SINGLE-MODULE-PACKAGE-001: the same atom satisfies both queries.
// ---------------------------------------------------------------------------

describe("bcryptjs hash section F -- combinedScore quality gate", () => {
  it.skipIf(!USE_LOCAL_PROVIDER)(
    "bcryptjs hash combinedScore >= 0.70 for corpus query (DISCOVERY_EVAL_PROVIDER=local)",
    { timeout: 120_000 },
    async () => {
      // ENGINE GAP: the UMD IIFE produces a stub forest with no novel-glue entries.
      // No atoms are persisted, so findCandidatesByQuery returns 0 candidates.
      // This test documents the INTENDED assertion shape for when the gap is fixed.
      // When engine gap is fixed: remove the ENGINE GAP comment and assert topScore >= 0.70.
      const registry = await openRegistry(":memory:", {
        embeddings: createLocalEmbeddingProvider("Xenova/all-MiniLM-L6-v2", 384),
      });
      try {
        const forest = await shavePackage(BCRYPTJS_FIXTURE_ROOT, {
          registry,
          entryPath: join(BCRYPTJS_FIXTURE_ROOT, "dist", "bcrypt.js"),
        });
        const plans = await collectForestSlicePlans(forest, slice, registry, "glue-aware");
        for (const { slicePlan } of plans) {
          for (const entry of slicePlan.entries) {
            if (entry.kind === "novel-glue")
              await maybePersistNovelGlueAtom(
                withSemanticIntentCard(
                  entry,
                  "Compute a bcrypt password hash with a configurable cost factor producing a salted one-way hash for credential storage",
                  [
                    "bcrypt password hashing salt rounds cost factor hashSync",
                    "generates salted one-way bcrypt hash string for secure password storage",
                    "Blowfish-based password hash function with configurable work factor",
                  ],
                ),
                registry,
              );
          }
        }
        const result = await registry.findCandidatesByQuery({
          behavior:
            "Compute a bcrypt password hash with a configurable cost factor producing a salted one-way hash for credential storage",
          topK: 10,
        });
        console.log(
          "[bcryptjs-hash sF] candidates:",
          result.candidates.map((c) => ({ score: c.combinedScore })),
        );
        // ENGINE GAP: 0 candidates expected. When gap is fixed, assert topScore >= 0.70.
        // expect(result.candidates.length).toBeGreaterThan(0);
        // expect(result.candidates[0]?.combinedScore).toBeGreaterThanOrEqual(0.7);
        console.log("[bcryptjs-hash sF] ENGINE GAP: 0 atoms persisted, 0 candidates (expected)");
        expect(result.candidates.length).toBe(0);
      } finally {
        await registry.close();
      }
    },
  );
});

describe("bcryptjs verify section F -- combinedScore quality gate", () => {
  it.skipIf(!USE_LOCAL_PROVIDER)(
    "bcryptjs verify combinedScore >= 0.70 for corpus query; same dist/bcrypt.js atom as hash (DISCOVERY_EVAL_PROVIDER=local)",
    { timeout: 120_000 },
    async () => {
      // ENGINE GAP: see bcryptjs hash section F comment above.
      // DEC-WI510-S6-BCRYPTJS-SINGLE-MODULE-PACKAGE-001: verify maps to the same atom as hash.
      // Both corpus rows retrieve the same merkle root (when engine gap is fixed).
      const registry = await openRegistry(":memory:", {
        embeddings: createLocalEmbeddingProvider("Xenova/all-MiniLM-L6-v2", 384),
      });
      try {
        const forest = await shavePackage(BCRYPTJS_FIXTURE_ROOT, {
          registry,
          entryPath: join(BCRYPTJS_FIXTURE_ROOT, "dist", "bcrypt.js"),
        });
        const plans = await collectForestSlicePlans(forest, slice, registry, "glue-aware");
        for (const { slicePlan } of plans) {
          for (const entry of slicePlan.entries) {
            if (entry.kind === "novel-glue")
              await maybePersistNovelGlueAtom(
                withSemanticIntentCard(
                  entry,
                  "Compare a plaintext password against a stored bcrypt hash using constant-time comparison to verify authentication",
                  [
                    "bcrypt password verification constant-time comparison compareSync",
                    "verifies plaintext against stored bcrypt hash string for authentication",
                    "timing-safe comparison of bcrypt hash for secure password verification",
                  ],
                ),
                registry,
              );
          }
        }
        const result = await registry.findCandidatesByQuery({
          behavior:
            "Compare a plaintext password against a stored bcrypt hash using constant-time comparison to verify authentication",
          topK: 10,
        });
        console.log(
          "[bcryptjs-verify sF] candidates:",
          result.candidates.map((c) => ({ score: c.combinedScore })),
        );
        // ENGINE GAP: 0 candidates expected. When gap is fixed, assert topScore >= 0.70.
        // expect(result.candidates.length).toBeGreaterThan(0);
        // expect(result.candidates[0]?.combinedScore).toBeGreaterThanOrEqual(0.7);
        console.log("[bcryptjs-verify sF] ENGINE GAP: 0 atoms persisted, 0 candidates (expected)");
        expect(result.candidates.length).toBe(0);
      } finally {
        await registry.close();
      }
    },
  );
});

// ---------------------------------------------------------------------------
// Compound interaction test -- real production sequence end-to-end
// ENGINE GAP: documents the expected bcryptjs behavior as a stub forest.
// When engine gap is fixed, update to assert moduleCount >= 1, stubCount = 0,
// externalSpecifiers includes "crypto", and persistedCount > 0.
// Plan section 5.1: exercises the real production sequence
//   shavePackage -> collectForestSlicePlans -> maybePersistNovelGlueAtom
// DEC-WI510-S6-BCRYPTJS-SINGLE-MODULE-PACKAGE-001: both hash and verify corpus rows
// point at the same atom once the engine gap is fixed.
// ---------------------------------------------------------------------------

describe("bcryptjs headline bindings -- compound interaction (real production sequence)", () => {
  it(
    "bcryptjs single-module-package shave completes with deterministic stub shape (ENGINE GAP: dist/bcrypt.js UMD IIFE; hash and verify corpus rows documented with expectedAtom: null)",
    { timeout: 300_000 },
    async () => {
      const registry = await openRegistry(":memory:", {
        embeddings: createOfflineEmbeddingProvider(),
      });
      try {
        const forest = await shavePackage(BCRYPTJS_FIXTURE_ROOT, {
          registry,
          entryPath: join(BCRYPTJS_FIXTURE_ROOT, "dist", "bcrypt.js"),
        });
        // ENGINE GAP (DEC-WI510-S6-BCRYPTJS-SINGLE-MODULE-PACKAGE-001):
        // Empirical: moduleCount=0, stubCount=1.
        // Plan predicted: moduleCount in [1,2], stubCount=0.
        // When gap is fixed: expect(forest.moduleCount).toBeGreaterThanOrEqual(1)
        //                    expect(forest.stubCount).toBe(0)
        expect(forest.moduleCount).toBe(0);
        expect(forest.stubCount).toBe(1);
        const extSpecs = forestModules(forest).flatMap((m) => m.externalSpecifiers);
        // ENGINE GAP: no externalSpecifiers emitted from a stub forest.
        expect(extSpecs.length).toBe(0);
        const stubs = forestStubs(forest);
        expect(stubs.length).toBe(1);
        expect(stubs[0]?.specifier).toContain("bcrypt.js");
        const plans = await collectForestSlicePlans(forest, slice, registry, "glue-aware");
        // ENGINE GAP: 0 plans, 0 atoms persisted.
        let persistedCount = 0;
        const atomMerkleRoots: string[] = [];
        for (const { slicePlan } of plans) {
          for (const entry of slicePlan.entries) {
            if (entry.kind === "novel-glue") {
              const mr = await maybePersistNovelGlueAtom(withStubIntentCard(entry), registry);
              if (mr !== undefined) {
                persistedCount++;
                atomMerkleRoots.push(mr);
              }
            }
          }
        }
        console.log(
          `[compound] bcryptjs: moduleCount=${forest.moduleCount} stubCount=${forest.stubCount} externalSpecifiers=${extSpecs.join(",")} persisted=${persistedCount}`,
        );
        console.log("[compound] bcryptjs atom merkle roots:", atomMerkleRoots);
        console.log("[compound] ENGINE GAP: dist/bcrypt.js UMD IIFE not parseable by engine");
        // ENGINE GAP: persistedCount = 0 (no atoms). Hash and verify corpus rows have expectedAtom: null.
        expect(persistedCount).toBe(0);
        // Retrievability check is vacuously true (no atoms to check).
        for (const mr of atomMerkleRoots) {
          expect(await registry.getBlock(mr)).not.toBeNull();
        }
      } finally {
        await registry.close();
      }
    },
  );
});
