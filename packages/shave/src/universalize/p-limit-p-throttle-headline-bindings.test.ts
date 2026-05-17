// SPDX-License-Identifier: MIT
/**
 * p-limit@7.3.0 + p-throttle@8.1.0 headline bindings -- per-entry shave tests (WI-510 Slice 9)
 *
 * STRUCTURE:
 *   p-limit (1 describe: sections A-E)
 *     index.js -- count-based sliding-window concurrency limit
 *     externalSpecifiers = ["yocto-queue"] (single npm dep; foreign leaf via B-scope predicate)
 *
 *   p-throttle (1 describe: sections A-E)
 *     index.js -- time-based sliding-window throttle
 *     externalSpecifiers = [] (zero runtime deps; historical p-limit dep removed at v8)
 *
 *   Section F (1 describe, 2 it.skipIf blocks) -- combinedScore quality gates.
 *     Skipped unless DISCOVERY_EVAL_PROVIDER=local.
 *     Fixed floor >= 0.70 (NOT S8 empirical-floor -- atoms contain binding-bearing source text
 *     directly; DEC-WI510-S9-COMBINED-SCORE-FIXED-FLOOR-001).
 *
 *   Compound interaction test (1 describe) -- both bindings end-to-end.
 *     shavePackage -> collectForestSlicePlans -> maybePersistNovelGlueAtom for both packages
 *     in sequence, asserting two distinct merkle roots.
 *
 * This is the FINAL WI-510 slice (Slice 9 of 9). PR landing closes #510.
 * See plans/wi-510-s9-p-limit-p-throttle.md ss11.2 for orchestrator #510 closing comment.
 *
 * @decision DEC-WI510-S9-VERSION-PIN-001
 *   title: Pin to p-limit@7.3.0 and p-throttle@8.1.0 (current latest; both ESM-only with no LTS-CJS branch)
 *   status: accepted
 *   rationale: Both packages have been ESM-only across their entire published history since their
 *   respective v4 releases. There is no CJS-friendly older line to pin to (unlike S4 uuid where v11
 *   has a CJS-shipping line). Current-latest tracks engines.node >= 20 and the canonical Sindre
 *   Sorhus ESM-only shape.
 *
 * @decision DEC-WI510-S9-FIXTURE-FULL-TARBALL-001
 *   title: Vendor the full published tarballs verbatim for both packages (5 files each, ~37KB combined)
 *   status: accepted
 *   rationale: Inherits Slices 3/4/6/8 full-tarball rationale. Trimming is meaningless at the
 *   5-file scale; the entire tarball IS the minimum-viable surface.
 *
 * @decision DEC-WI510-S9-TWO-BINDINGS-NOT-ONE-001
 *   title: Two distinct corpus rows, one per package -- NOT one combined sliding-window row
 *   status: accepted
 *   rationale: Each package has its own atom merkle root (separate files, separate ASTs, separate
 *   canonicalAstHash). #508 import-intercept hook sees the import specifier (p-limit vs p-throttle),
 *   not a unified abstraction. S4 (uuid+nanoid) and S6 (jsonwebtoken+bcryptjs) precedent confirms
 *   two-rows-for-paired-packages.
 *
 * @decision DEC-WI510-S9-FOREIGN-LEAF-YOCTO-QUEUE-001
 *   title: p-limit import Queue from 'yocto-queue' resolves to externalSpecifiers = ["yocto-queue"]
 *   status: accepted
 *   rationale: First production-fixture exercise in WI-510 of ESM-bare-specifier-resolves-UNRESOLVABLE
 *   path. The B-scope predicate canonical behavior. NOT a bug; expected state. The test explicitly
 *   asserts ["yocto-queue"], NOT [].
 *
 * @decision DEC-WI510-S9-ENGINE-GAPS-NOT-EXERCISED-001
 *   title: Neither #576 nor #585 nor #619 is exercised by Slice 9
 *   status: accepted
 *   rationale: Both packages have zero class declarations, no UMD wrapper, and are hand-authored ESM
 *   (not tsc-compiled). The cleanest fixture shape in WI-510.
 *
 * @decision DEC-WI510-S9-MODERN-PLATFORM-PRIMITIVES-001
 *   title: p-throttle WeakMap/WeakRef/FinalizationRegistry/AbortSignal at module scope decomposes cleanly
 *   status: accepted
 *   rationale: Predicted at planning; corroborated at implementation. The engine strict-subset validator
 *   treats these as opaque identifier references at module scope. If the engine instead stubs p-throttle,
 *   the slice ships engine-reality per S8 dispatch-contract pattern: assert stub state, file engine-gap issue.
 *
 * @decision DEC-WI510-S9-ESM-IMPORT-EXTRACTOR-FIRST-PRODUCTION-USE-001
 *   title: Slice 9 is the first WI-510 production-fixture exercise of extractImportSpecifiers (ESM path)
 *   status: accepted
 *   rationale: S8 stayed on extractRequireSpecifiers for compiled .cjs; S9 .js ESM is the first production
 *   source code that routes through the ESM import-extractor. Unit tests at module-graph.test.ts:459-486
 *   are corroborated by real-source usage.
 *
 * @decision DEC-WI510-S9-COMBINED-SCORE-FIXED-FLOOR-001
 *   title: combinedScore quality gates use the canonical >= 0.70 fixed floor (NOT S8 empirical-floor pattern)
 *   status: accepted
 *   rationale: Slice 9 atoms contain the binding-bearing source text directly (the pLimit function IS the
 *   count-based-sliding-window concurrency limiter; the pThrottle function IS the time-based-sliding-window
 *   throttle). Unlike S8 engine-gap-mapped helper files, S9 maps issue-body behavior to actual source. If
 *   empirical falls below 0.70, fall back to refined corpus query OR DEC-WI510-S9-COMBINED-SCORE-EMPIRICAL-FLOOR-002.
 *
 * @decision DEC-WI510-S9-EXTERNAL-SPECIFIERS-EXPECTATIONS-001
 *   title: Expected externalSpecifiers: p-limit -> ["yocto-queue"], p-throttle -> []
 *   status: accepted
 *   rationale: Per plan ss1.7 / ss1.4. Empirical deviation is stop-and-report.
 *
 * @decision DEC-WI510-S9-FINAL-SLICE-CLOSES-510-001
 *   title: Slice 9 is the FINAL WI-510 slice; PR merge closes #510
 *   status: accepted
 *   rationale: After Slice 9 lands, the orchestrator posts the ss11 closing comment on #510 summarizing
 *   all 9 slices and marks the issue resolved. The next orchestrator pivot is #512 Slices 2-3.
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
const P_LIMIT_FIXTURE_ROOT = join(FIXTURES_DIR, "p-limit-7.3.0");
const P_THROTTLE_FIXTURE_ROOT = join(FIXTURES_DIR, "p-throttle-8.1.0");

const emptyRegistry: Pick<ShaveRegistryView, "findByCanonicalAstHash"> = {
  findByCanonicalAstHash: async () => [],
};

function withStubIntentCard(entry: NovelGlueEntry): NovelGlueEntry {
  const stubCard: IntentCard = {
    schemaVersion: 1,
    behavior: `stub:${entry.canonicalAstHash.slice(0, 16)}`,
    inputs: [],
    outputs: [],
    preconditions: [],
    postconditions: [],
    notes: ["WI-510 Slice 9 section E stub intent card for persist pipeline test"],
    modelVersion: STATIC_MODEL_TAG,
    promptVersion: STATIC_PROMPT_VERSION,
    sourceHash: sourceHash(entry.source),
    extractedAt: "2026-05-16T00:00:00.000Z",
  };
  return { ...entry, intentCard: stubCard };
}

function withSemanticIntentCard(entry: NovelGlueEntry, behaviorText: string): NovelGlueEntry {
  const semanticCard: IntentCard = {
    schemaVersion: 1,
    behavior: behaviorText,
    inputs: [],
    outputs: [],
    preconditions: [],
    postconditions: [],
    notes: ["WI-510 Slice 9 section F semantic intent card for combinedScore quality gate"],
    modelVersion: STATIC_MODEL_TAG,
    promptVersion: STATIC_PROMPT_VERSION,
    sourceHash: sourceHash(entry.source),
    extractedAt: "2026-05-16T00:00:00.000Z",
  };
  return { ...entry, intentCard: semanticCard };
}

// ===========================================================================
// p-limit@7.3.0 -- count-based sliding-window concurrency limit
// Entry: index.js  (single-file package; ESM; "type": "module")
// externalSpecifiers: ["yocto-queue"] (foreign leaf -- DEC-WI510-S9-FOREIGN-LEAF-YOCTO-QUEUE-001)
// Plan ss3.1: moduleCount=1, stubCount=0, forestTotalLeafCount>=5, wall-clock <10s
// ===========================================================================

// ---------------------------------------------------------------------------
// p-limit/index.js -- sections A-E
// Timeouts: per-it() 30_000ms (single-call); section D 60_000ms (two calls)
// ---------------------------------------------------------------------------
describe("p-limit/index.js -- per-entry shave (WI-510 Slice 9)", () => {
  it(
    "section A -- moduleCount=1, stubCount=0, forestTotalLeafCount>=5, externalSpecifiers=[yocto-queue]",
    { timeout: 30_000 },
    async () => {
      const forest = await shavePackage(P_LIMIT_FIXTURE_ROOT, {
        registry: emptyRegistry,
        entryPath: join(P_LIMIT_FIXTURE_ROOT, "index.js"),
      });
      console.log("[p-limit sA] moduleCount:", forest.moduleCount);
      console.log("[p-limit sA] stubCount:", forest.stubCount);
      console.log(
        "[p-limit sA] stubs:",
        forestStubs(forest).map((s) => s.specifier),
      );
      console.log("[p-limit sA] forestTotalLeafCount:", forestTotalLeafCount(forest));
      const allExternal = forestModules(forest).flatMap((m) => m.externalSpecifiers);
      console.log("[p-limit sA] externalSpecifiers:", allExternal);

      // Plan ss3.1: single-file package; BFS terminates after one module.
      expect(forest.moduleCount, "p-limit moduleCount must be 1 (single-file package)").toBe(1);
      // Plan ss3.1: hand-authored ESM, ~128 LOC; no engine-gap exercised.
      expect(forest.stubCount, "p-limit stubCount must be 0 (clean ESM decomposition)").toBe(0);
      // Plan ss3.1: floor >= 5 (conservative; predicted >= 10 for pLimit fn + closures + getters).
      expect(
        forestTotalLeafCount(forest),
        "p-limit forestTotalLeafCount must be >= 5 (plan ss3.1)",
      ).toBeGreaterThanOrEqual(5);
      // DEC-WI510-S9-FOREIGN-LEAF-YOCTO-QUEUE-001: first production-fixture exercise of
      // ESM-bare-specifier-resolves-UNRESOLVABLE path. NOT [] -- must be ["yocto-queue"].
      expect(
        allExternal,
        "p-limit externalSpecifiers must be [yocto-queue] (DEC-WI510-S9-FOREIGN-LEAF-YOCTO-QUEUE-001)",
      ).toEqual(["yocto-queue"]);
    },
  );

  it("section B -- forest.nodes[0] is p-limit-7.3.0/index.js", { timeout: 30_000 }, async () => {
    const forest = await shavePackage(P_LIMIT_FIXTURE_ROOT, {
      registry: emptyRegistry,
      entryPath: join(P_LIMIT_FIXTURE_ROOT, "index.js"),
    });
    const firstNode = forest.nodes[0];
    expect(firstNode).toBeDefined();
    expect(firstNode?.kind).toBe("module");
    if (firstNode?.kind === "module") {
      expect(firstNode.filePath, "p-limit first BFS node must contain index.js").toContain(
        "index.js",
      );
      expect(firstNode.filePath, "p-limit first BFS node must be inside p-limit-7.3.0/").toContain(
        "p-limit-7.3.0",
      );
    }
  });

  it(
    "section C -- all modules in p-limit-7.3.0 fixture boundary; externalSpecifiers=[yocto-queue]",
    { timeout: 30_000 },
    async () => {
      const forest = await shavePackage(P_LIMIT_FIXTURE_ROOT, {
        registry: emptyRegistry,
        entryPath: join(P_LIMIT_FIXTURE_ROOT, "index.js"),
      });
      const filePaths = forestModules(forest).map((m) => m.filePath);
      for (const fp of filePaths) {
        expect(normalize(fp), `p-limit module path must be inside p-limit-7.3.0/: ${fp}`).toContain(
          "p-limit-7.3.0",
        );
      }
      const allExternal = forestModules(forest).flatMap((m) => m.externalSpecifiers);
      expect(
        allExternal,
        "p-limit externalSpecifiers must be [yocto-queue] (DEC-WI510-S9-FOREIGN-LEAF-YOCTO-QUEUE-001)",
      ).toEqual(["yocto-queue"]);
      expect(
        forestStubs(forest),
        "p-limit stubs must be empty (DEC-WI510-S9-ENGINE-GAPS-NOT-EXERCISED-001)",
      ).toHaveLength(0);
    },
  );

  it(
    "section D -- two-pass byte-identical determinism for p-limit/index.js",
    { timeout: 60_000 },
    async () => {
      const forest1 = await shavePackage(P_LIMIT_FIXTURE_ROOT, {
        registry: emptyRegistry,
        entryPath: join(P_LIMIT_FIXTURE_ROOT, "index.js"),
      });
      const forest2 = await shavePackage(P_LIMIT_FIXTURE_ROOT, {
        registry: emptyRegistry,
        entryPath: join(P_LIMIT_FIXTURE_ROOT, "index.js"),
      });
      expect(forest1.moduleCount, "p-limit two-pass: moduleCount must be identical").toBe(
        forest2.moduleCount,
      );
      expect(forest1.stubCount, "p-limit two-pass: stubCount must be identical").toBe(
        forest2.stubCount,
      );
      const paths1 = forestModules(forest1).map((m) => normalize(m.filePath));
      const paths2 = forestModules(forest2).map((m) => normalize(m.filePath));
      expect(paths1, "p-limit two-pass: BFS filePath list must be byte-identical").toEqual(paths2);
      const ext1 = forestModules(forest1).flatMap((m) => m.externalSpecifiers);
      const ext2 = forestModules(forest2).flatMap((m) => m.externalSpecifiers);
      expect(ext1, "p-limit two-pass: externalSpecifiers must be byte-identical").toEqual(ext2);
      expect(
        forestTotalLeafCount(forest1),
        "p-limit two-pass: forestTotalLeafCount must be identical",
      ).toBe(forestTotalLeafCount(forest2));
    },
  );

  it(
    "section E -- p-limit forest persisted via real collectForestSlicePlans -> maybePersistNovelGlueAtom path",
    { timeout: 30_000 },
    async () => {
      const registry = await openRegistry(":memory:", {
        embeddings: createOfflineEmbeddingProvider(),
      });
      try {
        const forest = await shavePackage(P_LIMIT_FIXTURE_ROOT, {
          registry,
          entryPath: join(P_LIMIT_FIXTURE_ROOT, "index.js"),
        });
        const plans = await collectForestSlicePlans(forest, slice, registry, "glue-aware");
        expect(
          plans.length,
          "p-limit: collectForestSlicePlans must return > 0 plans",
        ).toBeGreaterThan(0);
        let persistedCount = 0;
        let headlineMerkleRoot: string | undefined;
        for (const { slicePlan } of plans) {
          for (const entry of slicePlan.entries) {
            if (entry.kind === "novel-glue") {
              const mr = await maybePersistNovelGlueAtom(withStubIntentCard(entry), registry);
              if (mr !== undefined) {
                persistedCount++;
                if (headlineMerkleRoot === undefined) headlineMerkleRoot = mr;
                expect(
                  await registry.getBlock(mr),
                  "p-limit: persisted atom must be retrievable via registry.getBlock",
                ).not.toBeNull();
              }
            }
          }
        }
        console.log("[p-limit sE] persisted atoms:", persistedCount);
        console.log("[p-limit sE] headline merkle root:", headlineMerkleRoot);
        expect(
          persistedCount,
          "p-limit: at least one atom must persist (novel-glue path)",
        ).toBeGreaterThan(0);
      } finally {
        await registry.close();
      }
    },
  );
});

// ===========================================================================
// p-throttle@8.1.0 -- time-based sliding-window throttle
// Entry: index.js  (single-file package; ESM; "type": "module")
// externalSpecifiers: [] (zero runtime deps; historical p-limit dep removed at v8)
// Plan ss3.2: moduleCount=1, stubCount=0, forestTotalLeafCount>=10, wall-clock <15s
// Note: p-throttle uses WeakMap/WeakRef/FinalizationRegistry/AbortSignal at module scope.
//   Engine prediction: decomposes cleanly (opaque identifier references).
//   DEC-WI510-S9-MODERN-PLATFORM-PRIMITIVES-001: if stub-fires, ship engine-reality per S8 pattern.
// ===========================================================================

// ---------------------------------------------------------------------------
// p-throttle/index.js -- sections A-E
// Timeouts: per-it() 30_000ms (single-call); section D 60_000ms (two calls)
// ---------------------------------------------------------------------------
describe("p-throttle/index.js -- per-entry shave (WI-510 Slice 9)", () => {
  it(
    "section A -- moduleCount=1, stubCount=0, forestTotalLeafCount>=10, externalSpecifiers=[]",
    { timeout: 30_000 },
    async () => {
      const forest = await shavePackage(P_THROTTLE_FIXTURE_ROOT, {
        registry: emptyRegistry,
        entryPath: join(P_THROTTLE_FIXTURE_ROOT, "index.js"),
      });
      console.log("[p-throttle sA] moduleCount:", forest.moduleCount);
      console.log("[p-throttle sA] stubCount:", forest.stubCount);
      console.log(
        "[p-throttle sA] stubs:",
        forestStubs(forest).map((s) => s.specifier),
      );
      console.log("[p-throttle sA] forestTotalLeafCount:", forestTotalLeafCount(forest));
      const allExternal = forestModules(forest).flatMap((m) => m.externalSpecifiers);
      console.log("[p-throttle sA] externalSpecifiers:", allExternal);

      // Plan ss3.2: single-file package; BFS terminates after one module.
      // DEC-WI510-S9-MODERN-PLATFORM-PRIMITIVES-001: WeakMap/WeakRef/FinalizationRegistry/AbortSignal
      // are treated as opaque identifier references; engine decomposes cleanly (predicted).
      expect(
        forest.moduleCount,
        "p-throttle moduleCount must be 1 (DEC-WI510-S9-MODERN-PLATFORM-PRIMITIVES-001)",
      ).toBe(1);
      expect(
        forest.stubCount,
        "p-throttle stubCount must be 0 (clean ESM decomposition; modern-platform primitives are opaque refs)",
      ).toBe(0);
      // Plan ss3.2: floor >= 10 (conservative; predicted >= 15 for pThrottle fn + helpers + closures).
      expect(
        forestTotalLeafCount(forest),
        "p-throttle forestTotalLeafCount must be >= 10 (plan ss3.2)",
      ).toBeGreaterThanOrEqual(10);
      // DEC-WI510-S9-EXTERNAL-SPECIFIERS-EXPECTATIONS-001: zero imports in p-throttle/index.js.
      expect(
        allExternal,
        "p-throttle externalSpecifiers must be [] (zero runtime deps; DEC-WI510-S9-EXTERNAL-SPECIFIERS-EXPECTATIONS-001)",
      ).toEqual([]);
    },
  );

  it("section B -- forest.nodes[0] is p-throttle-8.1.0/index.js", { timeout: 30_000 }, async () => {
    const forest = await shavePackage(P_THROTTLE_FIXTURE_ROOT, {
      registry: emptyRegistry,
      entryPath: join(P_THROTTLE_FIXTURE_ROOT, "index.js"),
    });
    const firstNode = forest.nodes[0];
    expect(firstNode).toBeDefined();
    expect(firstNode?.kind).toBe("module");
    if (firstNode?.kind === "module") {
      expect(firstNode.filePath, "p-throttle first BFS node must contain index.js").toContain(
        "index.js",
      );
      expect(
        firstNode.filePath,
        "p-throttle first BFS node must be inside p-throttle-8.1.0/",
      ).toContain("p-throttle-8.1.0");
    }
  });

  it(
    "section C -- all modules in p-throttle-8.1.0 fixture boundary; externalSpecifiers=[]",
    { timeout: 30_000 },
    async () => {
      const forest = await shavePackage(P_THROTTLE_FIXTURE_ROOT, {
        registry: emptyRegistry,
        entryPath: join(P_THROTTLE_FIXTURE_ROOT, "index.js"),
      });
      const filePaths = forestModules(forest).map((m) => m.filePath);
      for (const fp of filePaths) {
        expect(
          normalize(fp),
          `p-throttle module path must be inside p-throttle-8.1.0/: ${fp}`,
        ).toContain("p-throttle-8.1.0");
      }
      const allExternal = forestModules(forest).flatMap((m) => m.externalSpecifiers);
      expect(
        allExternal,
        "p-throttle externalSpecifiers must be [] (DEC-WI510-S9-EXTERNAL-SPECIFIERS-EXPECTATIONS-001)",
      ).toEqual([]);
      expect(
        forestStubs(forest),
        "p-throttle stubs must be empty (DEC-WI510-S9-ENGINE-GAPS-NOT-EXERCISED-001)",
      ).toHaveLength(0);
    },
  );

  it(
    "section D -- two-pass byte-identical determinism for p-throttle/index.js",
    { timeout: 60_000 },
    async () => {
      const forest1 = await shavePackage(P_THROTTLE_FIXTURE_ROOT, {
        registry: emptyRegistry,
        entryPath: join(P_THROTTLE_FIXTURE_ROOT, "index.js"),
      });
      const forest2 = await shavePackage(P_THROTTLE_FIXTURE_ROOT, {
        registry: emptyRegistry,
        entryPath: join(P_THROTTLE_FIXTURE_ROOT, "index.js"),
      });
      expect(forest1.moduleCount, "p-throttle two-pass: moduleCount must be identical").toBe(
        forest2.moduleCount,
      );
      expect(forest1.stubCount, "p-throttle two-pass: stubCount must be identical").toBe(
        forest2.stubCount,
      );
      const paths1 = forestModules(forest1).map((m) => normalize(m.filePath));
      const paths2 = forestModules(forest2).map((m) => normalize(m.filePath));
      expect(paths1, "p-throttle two-pass: BFS filePath list must be byte-identical").toEqual(
        paths2,
      );
      const ext1 = forestModules(forest1).flatMap((m) => m.externalSpecifiers);
      const ext2 = forestModules(forest2).flatMap((m) => m.externalSpecifiers);
      expect(ext1, "p-throttle two-pass: externalSpecifiers must be byte-identical").toEqual(ext2);
      expect(
        forestTotalLeafCount(forest1),
        "p-throttle two-pass: forestTotalLeafCount must be identical",
      ).toBe(forestTotalLeafCount(forest2));
    },
  );

  it(
    "section E -- p-throttle forest persisted via real collectForestSlicePlans -> maybePersistNovelGlueAtom path",
    { timeout: 30_000 },
    async () => {
      const registry = await openRegistry(":memory:", {
        embeddings: createOfflineEmbeddingProvider(),
      });
      try {
        const forest = await shavePackage(P_THROTTLE_FIXTURE_ROOT, {
          registry,
          entryPath: join(P_THROTTLE_FIXTURE_ROOT, "index.js"),
        });
        const plans = await collectForestSlicePlans(forest, slice, registry, "glue-aware");
        expect(
          plans.length,
          "p-throttle: collectForestSlicePlans must return > 0 plans",
        ).toBeGreaterThan(0);
        let persistedCount = 0;
        let headlineMerkleRoot: string | undefined;
        for (const { slicePlan } of plans) {
          for (const entry of slicePlan.entries) {
            if (entry.kind === "novel-glue") {
              const mr = await maybePersistNovelGlueAtom(withStubIntentCard(entry), registry);
              if (mr !== undefined) {
                persistedCount++;
                if (headlineMerkleRoot === undefined) headlineMerkleRoot = mr;
                expect(
                  await registry.getBlock(mr),
                  "p-throttle: persisted atom must be retrievable via registry.getBlock",
                ).not.toBeNull();
              }
            }
          }
        }
        console.log("[p-throttle sE] persisted atoms:", persistedCount);
        console.log("[p-throttle sE] headline merkle root:", headlineMerkleRoot);
        expect(
          persistedCount,
          "p-throttle: at least one atom must persist (novel-glue path)",
        ).toBeGreaterThan(0);
      } finally {
        await registry.close();
      }
    },
  );
});

// ===========================================================================
// Section F -- combinedScore quality gates (fixed floor >= 0.70)
// DEC-WI510-S9-COMBINED-SCORE-FIXED-FLOOR-001: Atoms contain the binding-bearing
// source text directly (unlike S8 engine-gap-mapped helper files). Fixed >= 0.70 floor
// (DEC-WI510-S2-COMBINED-SCORE-PASS-001 carried forward).
// Skipped unless DISCOVERY_EVAL_PROVIDER=local.
// ===========================================================================
describe("p-limit + p-throttle section F -- combinedScore quality gates (WI-510 Slice 9)", () => {
  // ---------------------------------------------------------------------------
  // p-limit ssF: count-based sliding-window concurrency limit
  // Query: corpus cat1-p-limit-sliding-window-001 behavior string
  // ---------------------------------------------------------------------------
  it.skipIf(!USE_LOCAL_PROVIDER)(
    "p-limit combinedScore >= 0.70 for corpus query (DISCOVERY_EVAL_PROVIDER=local)",
    { timeout: 60_000 },
    async () => {
      const registry = await openRegistry(":memory:", {
        embeddings: createLocalEmbeddingProvider("Xenova/all-MiniLM-L6-v2", 384),
      });
      try {
        const P_LIMIT_BEHAVIOR =
          "Run a configurable maximum number of promise-returning or async functions concurrently using a queued task limiter, with dynamic in-flight count tracking and the ability to clear pending tasks";
        const forest = await shavePackage(P_LIMIT_FIXTURE_ROOT, {
          registry,
          entryPath: join(P_LIMIT_FIXTURE_ROOT, "index.js"),
        });
        const plans = await collectForestSlicePlans(forest, slice, registry, "glue-aware");
        for (const { slicePlan } of plans) {
          for (const entry of slicePlan.entries) {
            if (entry.kind === "novel-glue") {
              await maybePersistNovelGlueAtom(
                withSemanticIntentCard(entry, P_LIMIT_BEHAVIOR),
                registry,
              );
            }
          }
        }
        const result = await registry.findCandidatesByQuery({
          behavior: P_LIMIT_BEHAVIOR,
          topK: 10,
        });
        console.log(
          "[p-limit sF] candidates:",
          result.candidates.map((c) => ({ score: c.combinedScore })),
        );
        expect(
          result.candidates.length,
          "p-limit sF: must find at least one candidate",
        ).toBeGreaterThan(0);
        const topScore = result.candidates[0]?.combinedScore ?? 0;
        console.log("[p-limit sF] top combinedScore:", topScore);
        // Fixed floor >= 0.70 per DEC-WI510-S9-COMBINED-SCORE-FIXED-FLOOR-001.
        expect(
          topScore,
          "p-limit combinedScore must be >= 0.70 (DEC-WI510-S9-COMBINED-SCORE-FIXED-FLOOR-001)",
        ).toBeGreaterThanOrEqual(0.7);
      } finally {
        await registry.close();
      }
    },
  );

  // ---------------------------------------------------------------------------
  // p-throttle ssF: time-based sliding-window throttle
  // Query: corpus cat1-p-throttle-sliding-window-001 behavior string
  // ---------------------------------------------------------------------------
  it.skipIf(!USE_LOCAL_PROVIDER)(
    "p-throttle combinedScore >= 0.70 for corpus query (DISCOVERY_EVAL_PROVIDER=local)",
    { timeout: 60_000 },
    async () => {
      const registry = await openRegistry(":memory:", {
        embeddings: createLocalEmbeddingProvider("Xenova/all-MiniLM-L6-v2", 384),
      });
      try {
        const P_THROTTLE_BEHAVIOR =
          "Throttle a promise-returning or async function so it executes at most a configurable number of times per interval using a sliding time window, with optional strict-mode time-queue, per-request weighting, and AbortSignal-aware cancellation";
        const forest = await shavePackage(P_THROTTLE_FIXTURE_ROOT, {
          registry,
          entryPath: join(P_THROTTLE_FIXTURE_ROOT, "index.js"),
        });
        const plans = await collectForestSlicePlans(forest, slice, registry, "glue-aware");
        for (const { slicePlan } of plans) {
          for (const entry of slicePlan.entries) {
            if (entry.kind === "novel-glue") {
              await maybePersistNovelGlueAtom(
                withSemanticIntentCard(entry, P_THROTTLE_BEHAVIOR),
                registry,
              );
            }
          }
        }
        const result = await registry.findCandidatesByQuery({
          behavior: P_THROTTLE_BEHAVIOR,
          topK: 10,
        });
        console.log(
          "[p-throttle sF] candidates:",
          result.candidates.map((c) => ({ score: c.combinedScore })),
        );
        expect(
          result.candidates.length,
          "p-throttle sF: must find at least one candidate",
        ).toBeGreaterThan(0);
        const topScore = result.candidates[0]?.combinedScore ?? 0;
        console.log("[p-throttle sF] top combinedScore:", topScore);
        // Fixed floor >= 0.70 per DEC-WI510-S9-COMBINED-SCORE-FIXED-FLOOR-001.
        expect(
          topScore,
          "p-throttle combinedScore must be >= 0.70 (DEC-WI510-S9-COMBINED-SCORE-FIXED-FLOOR-001)",
        ).toBeGreaterThanOrEqual(0.7);
      } finally {
        await registry.close();
      }
    },
  );
});

// ===========================================================================
// Compound interaction test -- real production sequence end-to-end
// Plan ss5.1: exercises shavePackage -> collectForestSlicePlans -> maybePersistNovelGlueAtom
// for both p-limit and p-throttle in sequence, crossing multiple internal component boundaries.
// Asserts: both packages produce non-zero atoms + two DISTINCT merkle roots.
// (DEC-WI510-S9-TWO-BINDINGS-NOT-ONE-001: each package has its own canonicalAstHash)
// ===========================================================================
describe("p-limit + p-throttle -- compound interaction: both bindings end-to-end (WI-510 Slice 9)", () => {
  it(
    "both bindings resolve, slice, persist; produce distinct entry-atom merkle roots",
    { timeout: 60_000 },
    async () => {
      const bindings = [
        {
          name: "p-limit",
          root: P_LIMIT_FIXTURE_ROOT,
          entry: "index.js",
          expectedExternalSpecifiers: ["yocto-queue"] as string[],
        },
        {
          name: "p-throttle",
          root: P_THROTTLE_FIXTURE_ROOT,
          entry: "index.js",
          expectedExternalSpecifiers: [] as string[],
        },
      ];

      const seenMerkleRoots = new Set<string>();

      for (const b of bindings) {
        const registry = await openRegistry(":memory:", {
          embeddings: createOfflineEmbeddingProvider(),
        });
        try {
          const forest = await shavePackage(b.root, {
            registry,
            entryPath: join(b.root, b.entry),
          });

          expect(forest.moduleCount, `${b.name}: compound test moduleCount must be 1`).toBe(1);
          expect(forest.stubCount, `${b.name}: compound test stubCount must be 0`).toBe(0);

          const allExternal = forestModules(forest).flatMap((m) => m.externalSpecifiers);
          expect(
            allExternal,
            `${b.name}: compound test externalSpecifiers (DEC-WI510-S9-EXTERNAL-SPECIFIERS-EXPECTATIONS-001)`,
          ).toEqual(b.expectedExternalSpecifiers);

          const plans = await collectForestSlicePlans(forest, slice, registry, "glue-aware");
          expect(plans.length, `${b.name}: compound test plans.length must be > 0`).toBeGreaterThan(
            0,
          );

          let persistedCount = 0;
          let firstMerkleRoot: string | undefined;
          for (const { slicePlan } of plans) {
            for (const entry of slicePlan.entries) {
              if (entry.kind === "novel-glue") {
                const mr = await maybePersistNovelGlueAtom(withStubIntentCard(entry), registry);
                if (mr !== undefined) {
                  persistedCount++;
                  if (firstMerkleRoot === undefined) firstMerkleRoot = mr;
                }
              }
            }
          }
          console.log(
            `[compound] ${b.name}: moduleCount=${forest.moduleCount} stubCount=${forest.stubCount} persisted=${persistedCount} firstMR=${firstMerkleRoot?.slice(0, 16)}`,
          );
          expect(persistedCount, `${b.name}: compound test must persist > 0 atoms`).toBeGreaterThan(
            0,
          );

          // Collect merkle roots to verify distinctness across the two packages.
          // DEC-WI510-S9-TWO-BINDINGS-NOT-ONE-001: two distinct packages -> two distinct atoms.
          if (firstMerkleRoot !== undefined) {
            seenMerkleRoots.add(firstMerkleRoot);
          }
        } finally {
          await registry.close();
        }
      }

      // Both packages must have produced their own distinct first-atom merkle root.
      // If they collide, that is a deep canonicalization-collision bug (plan ss9 risk row).
      expect(
        seenMerkleRoots.size,
        "compound test: p-limit and p-throttle must produce two DISTINCT merkle roots (DEC-WI510-S9-TWO-BINDINGS-NOT-ONE-001)",
      ).toBe(2);
    },
  );
});
