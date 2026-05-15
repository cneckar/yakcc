// SPDX-License-Identifier: MIT
/**
 * WI-510 Slice 2 --- per-entry shave of four validator headline bindings.
 *
 * @decision DEC-WI510-S2-PER-ENTRY-SHAVE-001
 * title: Slice 2 shaves the four headline bindings per-entry, not the whole package
 * status: decided
 * rationale:
 *   Operator-adjudicated 2026-05-14: the previous whole-package approach (commit f9c93f0)
 *   produced moduleCount=113, leafCount=1987, ran for 44 minutes, forced testTimeout=3_600_000.
 *   Per-entry shaving bounds each test to a 2-10-module transitive subgraph (plan section 3).
 *
 * @decision DEC-WI510-S2-PATH-A-CONFIRMED-001
 * title: shavePackage existing entryPath option suffices; no engine API change
 * status: decided
 * rationale: ShavePackageOptions.entryPath at line 170, consumed at line 260.
 *
 * @decision DEC-WI510-S2-PER-ENTRY-ISOLATION-001
 * title: Each headline is shaved by its own shavePackage call; no shared multi-binding beforeAll
 * status: decided
 * rationale: Per-entry isolation is the structural defense against the abandoned slice failure mode.
 *
 * @decision DEC-WI510-S2-NO-TIMEOUT-RAISE-001
 * title: vitest.config.ts stays at testTimeout=30_000; abandoned 3_600_000 raise is the symptom
 * status: decided
 * rationale: Per-it() overrides up to 120s permitted with comment. Above 120s = stop+report.
 *
 * @decision DEC-WI510-S2-VENDORED-FIXTURE-CARRYOVER-001
 * title: Re-use the abandoned slices vendored Babel-CJS tarball verbatim
 * status: decided
 * rationale: Full validator-13.15.35/ from commit f9c93f0 carried byte-for-byte.
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
const VALIDATOR_FIXTURE_ROOT = join(FIXTURES_DIR, "validator-13.15.35");

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

/**
 * Attach a minimal stub IntentCard to a NovelGlueEntry so it can flow through
 * maybePersistNovelGlueAtom without being skipped.
 *
 * The intentCard is required by persistNovelGlueAtom (lines 148-151 of atom-persist.ts).
 * In production, it is attached by universalize() via extractIntent(strategy:"static").
 * In §E tests we create a deterministic stub so the persist pipeline is exercised
 * without a live extractIntent call.
 */
function withStubIntentCard(entry: NovelGlueEntry): NovelGlueEntry {
  const stubCard: IntentCard = {
    schemaVersion: 1,
    behavior: `stub:${entry.canonicalAstHash.slice(0, 16)}`,
    inputs: [],
    outputs: [],
    preconditions: [],
    postconditions: [],
    notes: ["WI-510 Slice 2 §E stub intent card for persist pipeline test"],
    modelVersion: STATIC_MODEL_TAG,
    promptVersion: STATIC_PROMPT_VERSION,
    sourceHash: sourceHash(entry.source),
    extractedAt: "2026-05-15T00:00:00.000Z",
  };
  return { ...entry, intentCard: stubCard };
}

// isEmail section A-F: isEmail
// Expected subgraph: plan section 3 estimates

describe("validator isEmail -- per-entry shave (WI-510 Slice 2)", () => {
  it(
    "section A -- moduleCount in [7,12], stubCount=0, forestTotalLeafCount>0 for isEmail subgraph",
    { timeout: 120_000 },
    async () => {
      const forest = await shavePackage(VALIDATOR_FIXTURE_ROOT, {
        registry: emptyRegistry,
        entryPath: join(VALIDATOR_FIXTURE_ROOT, "lib", "isEmail.js"),
      });
      console.log("[isEmail sA] moduleCount:", forest.moduleCount);
      console.log("[isEmail sA] stubCount:", forest.stubCount);
      console.log("[isEmail sA] forestTotalLeafCount:", forestTotalLeafCount(forest));
      console.log(
        "[isEmail sA] BFS filePaths:",
        forestModules(forest).map((m) => normalize(m.filePath).split("validator-13.15.35")[1]),
      );
      expect(forest.moduleCount, "isEmail moduleCount should be 7-12").toBeGreaterThanOrEqual(7);
      expect(forest.moduleCount, "isEmail moduleCount should be 7-12").toBeLessThanOrEqual(12);
      expect(forest.stubCount).toBe(0);
      expect(forestTotalLeafCount(forest)).toBeGreaterThan(0);
    },
  );

  it("section B -- forest.nodes[0] is isEmail.js", { timeout: 120_000 }, async () => {
    const forest = await shavePackage(VALIDATOR_FIXTURE_ROOT, {
      registry: emptyRegistry,
      entryPath: join(VALIDATOR_FIXTURE_ROOT, "lib", "isEmail.js"),
    });
    const firstNode = forest.nodes[0];
    expect(firstNode).toBeDefined();
    expect(firstNode?.kind).toBe("module");
    if (firstNode?.kind === "module") expect(firstNode.filePath).toContain("isEmail.js");
  });

  it(
    "section C -- subgraph contains only transitively-reachable modules; no unrelated validators",
    { timeout: 120_000 },
    async () => {
      const forest = await shavePackage(VALIDATOR_FIXTURE_ROOT, {
        registry: emptyRegistry,
        entryPath: join(VALIDATOR_FIXTURE_ROOT, "lib", "isEmail.js"),
      });
      const filePaths = forestModules(forest).map((m) => m.filePath);
      for (const fp of filePaths) expect(fp).toContain("validator-13.15.35");
      expect(filePaths.some((p) => p.includes("isEmail.js"))).toBe(true);
      expect(filePaths.some((p) => p.includes("util") && p.includes("assertString"))).toBe(true);
      const unrelated = ["isCreditCard", "isJSON", "isFloat", "isInt", "isDate", "isHexadecimal"];
      for (const u of unrelated) {
        expect(
          filePaths.every((p) => !p.includes(u)),
          `${u} must NOT be in isEmail subgraph`,
        ).toBe(true);
      }
      expect(forestStubs(forest).length).toBe(0);
    },
  );

  it(
    "section D -- two-pass byte-identical determinism for isEmail subgraph",
    { timeout: 120_000 },
    async () => {
      const entryPath = join(VALIDATOR_FIXTURE_ROOT, "lib", "isEmail.js");
      const forest1 = await shavePackage(VALIDATOR_FIXTURE_ROOT, {
        registry: emptyRegistry,
        entryPath,
      });
      const forest2 = await shavePackage(VALIDATOR_FIXTURE_ROOT, {
        registry: emptyRegistry,
        entryPath,
      });
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
    },
  );

  it(
    "section E -- isEmail forest persisted via real collectForestSlicePlans -> maybePersistNovelGlueAtom path",
    { timeout: 120_000 },
    async () => {
      const registry = await openRegistry(":memory:", {
        embeddings: createOfflineEmbeddingProvider(),
      });
      try {
        const forest = await shavePackage(VALIDATOR_FIXTURE_ROOT, {
          registry,
          entryPath: join(VALIDATOR_FIXTURE_ROOT, "lib", "isEmail.js"),
        });
        const plans = await collectForestSlicePlans(forest, slice, registry, "glue-aware");
        expect(plans.length).toBeGreaterThan(0);
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
        console.log("[isEmail sE] persisted atoms:", persistedCount);
        expect(persistedCount).toBeGreaterThan(0);
      } finally {
        await registry.close();
      }
    },
  );
});

// isEmail section A-F: isURL
// Expected subgraph: plan section 3 estimates

describe("validator isURL -- per-entry shave (WI-510 Slice 2)", () => {
  it(
    "section A -- moduleCount in [6,12], stubCount=0, forestTotalLeafCount>0 for isURL subgraph",
    { timeout: 120_000 },
    async () => {
      const forest = await shavePackage(VALIDATOR_FIXTURE_ROOT, {
        registry: emptyRegistry,
        entryPath: join(VALIDATOR_FIXTURE_ROOT, "lib", "isURL.js"),
      });
      console.log("[isURL sA] moduleCount:", forest.moduleCount);
      console.log("[isURL sA] stubCount:", forest.stubCount);
      console.log("[isURL sA] forestTotalLeafCount:", forestTotalLeafCount(forest));
      console.log(
        "[isURL sA] BFS filePaths:",
        forestModules(forest).map((m) => normalize(m.filePath).split("validator-13.15.35")[1]),
      );
      expect(forest.moduleCount, "isURL moduleCount should be 6-12").toBeGreaterThanOrEqual(6);
      expect(forest.moduleCount, "isURL moduleCount should be 6-12").toBeLessThanOrEqual(12);
      expect(forest.stubCount).toBe(0);
      expect(forestTotalLeafCount(forest)).toBeGreaterThan(0);
    },
  );

  it("section B -- forest.nodes[0] is isURL.js", { timeout: 120_000 }, async () => {
    const forest = await shavePackage(VALIDATOR_FIXTURE_ROOT, {
      registry: emptyRegistry,
      entryPath: join(VALIDATOR_FIXTURE_ROOT, "lib", "isURL.js"),
    });
    const firstNode = forest.nodes[0];
    expect(firstNode).toBeDefined();
    expect(firstNode?.kind).toBe("module");
    if (firstNode?.kind === "module") expect(firstNode.filePath).toContain("isURL.js");
  });

  it(
    "section C -- subgraph contains only transitively-reachable modules; no unrelated validators",
    { timeout: 120_000 },
    async () => {
      const forest = await shavePackage(VALIDATOR_FIXTURE_ROOT, {
        registry: emptyRegistry,
        entryPath: join(VALIDATOR_FIXTURE_ROOT, "lib", "isURL.js"),
      });
      const filePaths = forestModules(forest).map((m) => m.filePath);
      for (const fp of filePaths) expect(fp).toContain("validator-13.15.35");
      expect(filePaths.some((p) => p.includes("isURL.js"))).toBe(true);
      expect(filePaths.some((p) => p.includes("util") && p.includes("assertString"))).toBe(true);
      // isURL does NOT pull isByteLength (plan section 3.2 distinguishes this from isEmail)
      expect(
        filePaths.every((p) => !p.includes("isByteLength")),
        "isByteLength must NOT be in isURL subgraph",
      ).toBe(true);
      const unrelated = ["isCreditCard", "isJSON", "isFloat", "isInt", "isDate", "isEmail.js"];
      for (const u of unrelated) {
        expect(
          filePaths.every((p) => !p.includes(u)),
          `${u} must NOT be in isURL subgraph`,
        ).toBe(true);
      }
      expect(forestStubs(forest).length).toBe(0);
    },
  );

  it(
    "section D -- two-pass byte-identical determinism for isURL subgraph",
    { timeout: 120_000 },
    async () => {
      const entryPath = join(VALIDATOR_FIXTURE_ROOT, "lib", "isURL.js");
      const forest1 = await shavePackage(VALIDATOR_FIXTURE_ROOT, {
        registry: emptyRegistry,
        entryPath,
      });
      const forest2 = await shavePackage(VALIDATOR_FIXTURE_ROOT, {
        registry: emptyRegistry,
        entryPath,
      });
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
    },
  );

  it(
    "section E -- isURL forest persisted via real collectForestSlicePlans -> maybePersistNovelGlueAtom path",
    { timeout: 120_000 },
    async () => {
      const registry = await openRegistry(":memory:", {
        embeddings: createOfflineEmbeddingProvider(),
      });
      try {
        const forest = await shavePackage(VALIDATOR_FIXTURE_ROOT, {
          registry,
          entryPath: join(VALIDATOR_FIXTURE_ROOT, "lib", "isURL.js"),
        });
        const plans = await collectForestSlicePlans(forest, slice, registry, "glue-aware");
        expect(plans.length).toBeGreaterThan(0);
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
        console.log("[isURL sE] persisted atoms:", persistedCount);
        expect(persistedCount).toBeGreaterThan(0);
      } finally {
        await registry.close();
      }
    },
  );
});

// isEmail section A-F: isUUID
// Expected subgraph: plan section 3 estimates

describe("validator isUUID -- per-entry shave (WI-510 Slice 2)", () => {
  it(
    "section A -- moduleCount in [1,4], stubCount=0, forestTotalLeafCount>0 for isUUID subgraph",
    { timeout: 120_000 },
    async () => {
      const forest = await shavePackage(VALIDATOR_FIXTURE_ROOT, {
        registry: emptyRegistry,
        entryPath: join(VALIDATOR_FIXTURE_ROOT, "lib", "isUUID.js"),
      });
      console.log("[isUUID sA] moduleCount:", forest.moduleCount);
      console.log("[isUUID sA] stubCount:", forest.stubCount);
      console.log("[isUUID sA] forestTotalLeafCount:", forestTotalLeafCount(forest));
      console.log(
        "[isUUID sA] BFS filePaths:",
        forestModules(forest).map((m) => normalize(m.filePath).split("validator-13.15.35")[1]),
      );
      expect(forest.moduleCount, "isUUID moduleCount should be 1-4").toBeGreaterThanOrEqual(1);
      expect(forest.moduleCount, "isUUID moduleCount should be 1-4").toBeLessThanOrEqual(4);
      expect(forest.stubCount).toBe(0);
      expect(forestTotalLeafCount(forest)).toBeGreaterThan(0);
    },
  );

  it("section B -- forest.nodes[0] is isUUID.js", { timeout: 120_000 }, async () => {
    const forest = await shavePackage(VALIDATOR_FIXTURE_ROOT, {
      registry: emptyRegistry,
      entryPath: join(VALIDATOR_FIXTURE_ROOT, "lib", "isUUID.js"),
    });
    const firstNode = forest.nodes[0];
    expect(firstNode).toBeDefined();
    expect(firstNode?.kind).toBe("module");
    if (firstNode?.kind === "module") expect(firstNode.filePath).toContain("isUUID.js");
  });

  it(
    "section C -- subgraph contains only transitively-reachable modules; no unrelated validators",
    { timeout: 120_000 },
    async () => {
      const forest = await shavePackage(VALIDATOR_FIXTURE_ROOT, {
        registry: emptyRegistry,
        entryPath: join(VALIDATOR_FIXTURE_ROOT, "lib", "isUUID.js"),
      });
      const filePaths = forestModules(forest).map((m) => m.filePath);
      for (const fp of filePaths) expect(fp).toContain("validator-13.15.35");
      expect(filePaths.some((p) => p.includes("isUUID.js"))).toBe(true);
      expect(filePaths.some((p) => p.includes("util") && p.includes("assertString"))).toBe(true);
      const mustNotContain = [
        "isFQDN",
        "isIP",
        "isByteLength",
        "isURL",
        "isEmail",
        "isAlphanumeric",
        "isCreditCard",
      ];
      for (const name of mustNotContain) {
        expect(
          filePaths.every((p) => !p.includes(name)),
          `${name} must NOT be in isUUID subgraph`,
        ).toBe(true);
      }
      expect(forestStubs(forest).length).toBe(0);
    },
  );

  it(
    "section D -- two-pass byte-identical determinism for isUUID subgraph",
    { timeout: 120_000 },
    async () => {
      const entryPath = join(VALIDATOR_FIXTURE_ROOT, "lib", "isUUID.js");
      const forest1 = await shavePackage(VALIDATOR_FIXTURE_ROOT, {
        registry: emptyRegistry,
        entryPath,
      });
      const forest2 = await shavePackage(VALIDATOR_FIXTURE_ROOT, {
        registry: emptyRegistry,
        entryPath,
      });
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
    },
  );

  it(
    "section E -- isUUID forest persisted via real collectForestSlicePlans -> maybePersistNovelGlueAtom path",
    { timeout: 120_000 },
    async () => {
      const registry = await openRegistry(":memory:", {
        embeddings: createOfflineEmbeddingProvider(),
      });
      try {
        const forest = await shavePackage(VALIDATOR_FIXTURE_ROOT, {
          registry,
          entryPath: join(VALIDATOR_FIXTURE_ROOT, "lib", "isUUID.js"),
        });
        const plans = await collectForestSlicePlans(forest, slice, registry, "glue-aware");
        expect(plans.length).toBeGreaterThan(0);
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
        console.log("[isUUID sE] persisted atoms:", persistedCount);
        expect(persistedCount).toBeGreaterThan(0);
      } finally {
        await registry.close();
      }
    },
  );
});

// isEmail section A-F: isAlphanumeric
// Expected subgraph: plan section 3 estimates

describe("validator isAlphanumeric -- per-entry shave (WI-510 Slice 2)", () => {
  it(
    "section A -- moduleCount in [2,5], stubCount=0, forestTotalLeafCount>0 for isAlphanumeric subgraph",
    { timeout: 120_000 },
    async () => {
      const forest = await shavePackage(VALIDATOR_FIXTURE_ROOT, {
        registry: emptyRegistry,
        entryPath: join(VALIDATOR_FIXTURE_ROOT, "lib", "isAlphanumeric.js"),
      });
      console.log("[isAlphanumeric sA] moduleCount:", forest.moduleCount);
      console.log("[isAlphanumeric sA] stubCount:", forest.stubCount);
      console.log("[isAlphanumeric sA] forestTotalLeafCount:", forestTotalLeafCount(forest));
      console.log(
        "[isAlphanumeric sA] BFS filePaths:",
        forestModules(forest).map((m) => normalize(m.filePath).split("validator-13.15.35")[1]),
      );
      expect(forest.moduleCount, "isAlphanumeric moduleCount should be 2-5").toBeGreaterThanOrEqual(
        2,
      );
      expect(forest.moduleCount, "isAlphanumeric moduleCount should be 2-5").toBeLessThanOrEqual(5);
      expect(forest.stubCount).toBe(0);
      expect(forestTotalLeafCount(forest)).toBeGreaterThan(0);
    },
  );

  it("section B -- forest.nodes[0] is isAlphanumeric.js", { timeout: 120_000 }, async () => {
    const forest = await shavePackage(VALIDATOR_FIXTURE_ROOT, {
      registry: emptyRegistry,
      entryPath: join(VALIDATOR_FIXTURE_ROOT, "lib", "isAlphanumeric.js"),
    });
    const firstNode = forest.nodes[0];
    expect(firstNode).toBeDefined();
    expect(firstNode?.kind).toBe("module");
    if (firstNode?.kind === "module") expect(firstNode.filePath).toContain("isAlphanumeric.js");
  });

  it(
    "section C -- subgraph contains only transitively-reachable modules; no unrelated validators",
    { timeout: 120_000 },
    async () => {
      const forest = await shavePackage(VALIDATOR_FIXTURE_ROOT, {
        registry: emptyRegistry,
        entryPath: join(VALIDATOR_FIXTURE_ROOT, "lib", "isAlphanumeric.js"),
      });
      const filePaths = forestModules(forest).map((m) => m.filePath);
      for (const fp of filePaths) expect(fp).toContain("validator-13.15.35");
      expect(filePaths.some((p) => p.includes("isAlphanumeric.js"))).toBe(true);
      expect(filePaths.some((p) => p.includes("util") && p.includes("assertString"))).toBe(true);
      expect(
        filePaths.some((p) => p.includes("alpha.js")),
        "alpha.js must be in isAlphanumeric subgraph",
      ).toBe(true);
      const mustNotContain = [
        "isFQDN",
        "isIP",
        "isByteLength",
        "isURL",
        "isEmail",
        "isUUID",
        "isCreditCard",
      ];
      for (const name of mustNotContain) {
        expect(
          filePaths.every((p) => !p.includes(name)),
          `${name} must NOT be in isAlphanumeric subgraph`,
        ).toBe(true);
      }
      expect(forestStubs(forest).length).toBe(0);
    },
  );

  it(
    "section D -- two-pass byte-identical determinism for isAlphanumeric subgraph",
    { timeout: 120_000 },
    async () => {
      const entryPath = join(VALIDATOR_FIXTURE_ROOT, "lib", "isAlphanumeric.js");
      const forest1 = await shavePackage(VALIDATOR_FIXTURE_ROOT, {
        registry: emptyRegistry,
        entryPath,
      });
      const forest2 = await shavePackage(VALIDATOR_FIXTURE_ROOT, {
        registry: emptyRegistry,
        entryPath,
      });
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
    },
  );

  it(
    "section E -- isAlphanumeric forest persisted via real collectForestSlicePlans -> maybePersistNovelGlueAtom path",
    { timeout: 120_000 },
    async () => {
      const registry = await openRegistry(":memory:", {
        embeddings: createOfflineEmbeddingProvider(),
      });
      try {
        const forest = await shavePackage(VALIDATOR_FIXTURE_ROOT, {
          registry,
          entryPath: join(VALIDATOR_FIXTURE_ROOT, "lib", "isAlphanumeric.js"),
        });
        const plans = await collectForestSlicePlans(forest, slice, registry, "glue-aware");
        expect(plans.length).toBeGreaterThan(0);
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
        console.log("[isAlphanumeric sE] persisted atoms:", persistedCount);
        expect(persistedCount).toBeGreaterThan(0);
      } finally {
        await registry.close();
      }
    },
  );
});

// Section F tests (combinedScore quality gate, DISCOVERY_EVAL_PROVIDER=local)
// Per section 5.6 criterion 7: skipped = BLOCKED, not ready.

describe("validator isEmail section F -- combinedScore quality gate", () => {
  it.skipIf(!USE_LOCAL_PROVIDER)(
    "isEmail combinedScore >= 0.70 for corpus query (DISCOVERY_EVAL_PROVIDER=local)",
    { timeout: 120_000 },
    async () => {
      const registry = await openRegistry(":memory:", {
        embeddings: createLocalEmbeddingProvider("Xenova/all-MiniLM-L6-v2", 384),
      });
      try {
        const forest = await shavePackage(VALIDATOR_FIXTURE_ROOT, {
          registry,
          entryPath: join(VALIDATOR_FIXTURE_ROOT, "lib", "isEmail.js"),
        });
        const plans = await collectForestSlicePlans(forest, slice, registry, "glue-aware");
        for (const { slicePlan } of plans) {
          for (const entry of slicePlan.entries) {
            if (entry.kind === "novel-glue")
              await maybePersistNovelGlueAtom(withStubIntentCard(entry), registry);
          }
        }
        const result = await registry.findCandidatesByQuery({
          behavior:
            "Validate whether a string is a valid email address, with support for display names, UTF-8 local parts, and configurable TLD requirements",
          topK: 10,
        });
        console.log(
          "[isEmail sF] candidates:",
          result.candidates.map((c) => ({ score: c.combinedScore })),
        );
        expect(result.candidates.length).toBeGreaterThan(0);
        const topScore = result.candidates[0]?.combinedScore ?? 0;
        console.log("[isEmail sF] top combinedScore:", topScore);
        expect(topScore, "isEmail combinedScore must be >= 0.70").toBeGreaterThanOrEqual(0.7);
      } finally {
        await registry.close();
      }
    },
  );
});

describe("validator isURL section F -- combinedScore quality gate", () => {
  it.skipIf(!USE_LOCAL_PROVIDER)(
    "isURL combinedScore >= 0.70 for corpus query (DISCOVERY_EVAL_PROVIDER=local)",
    { timeout: 120_000 },
    async () => {
      const registry = await openRegistry(":memory:", {
        embeddings: createLocalEmbeddingProvider("Xenova/all-MiniLM-L6-v2", 384),
      });
      try {
        const forest = await shavePackage(VALIDATOR_FIXTURE_ROOT, {
          registry,
          entryPath: join(VALIDATOR_FIXTURE_ROOT, "lib", "isURL.js"),
        });
        const plans = await collectForestSlicePlans(forest, slice, registry, "glue-aware");
        for (const { slicePlan } of plans) {
          for (const entry of slicePlan.entries) {
            if (entry.kind === "novel-glue")
              await maybePersistNovelGlueAtom(withStubIntentCard(entry), registry);
          }
        }
        const result = await registry.findCandidatesByQuery({
          behavior:
            "Validate whether a string is a valid URL, supporting multiple protocols, authentication, IP addresses, and configurable options for TLD and underscores",
          topK: 10,
        });
        console.log(
          "[isURL sF] candidates:",
          result.candidates.map((c) => ({ score: c.combinedScore })),
        );
        expect(result.candidates.length).toBeGreaterThan(0);
        const topScore = result.candidates[0]?.combinedScore ?? 0;
        console.log("[isURL sF] top combinedScore:", topScore);
        expect(topScore, "isURL combinedScore must be >= 0.70").toBeGreaterThanOrEqual(0.7);
      } finally {
        await registry.close();
      }
    },
  );
});

describe("validator isUUID section F -- combinedScore quality gate", () => {
  it.skipIf(!USE_LOCAL_PROVIDER)(
    "isUUID combinedScore >= 0.70 for corpus query (DISCOVERY_EVAL_PROVIDER=local)",
    { timeout: 120_000 },
    async () => {
      const registry = await openRegistry(":memory:", {
        embeddings: createLocalEmbeddingProvider("Xenova/all-MiniLM-L6-v2", 384),
      });
      try {
        const forest = await shavePackage(VALIDATOR_FIXTURE_ROOT, {
          registry,
          entryPath: join(VALIDATOR_FIXTURE_ROOT, "lib", "isUUID.js"),
        });
        const plans = await collectForestSlicePlans(forest, slice, registry, "glue-aware");
        for (const { slicePlan } of plans) {
          for (const entry of slicePlan.entries) {
            if (entry.kind === "novel-glue")
              await maybePersistNovelGlueAtom(withStubIntentCard(entry), registry);
          }
        }
        const result = await registry.findCandidatesByQuery({
          behavior:
            "Validate whether a string is a valid UUID (universally unique identifier) in versions 1 through 5, nil UUID, or max UUID format",
          topK: 10,
        });
        console.log(
          "[isUUID sF] candidates:",
          result.candidates.map((c) => ({ score: c.combinedScore })),
        );
        expect(result.candidates.length).toBeGreaterThan(0);
        const topScore = result.candidates[0]?.combinedScore ?? 0;
        console.log("[isUUID sF] top combinedScore:", topScore);
        expect(topScore, "isUUID combinedScore must be >= 0.70").toBeGreaterThanOrEqual(0.7);
      } finally {
        await registry.close();
      }
    },
  );
});

describe("validator isAlphanumeric section F -- combinedScore quality gate", () => {
  it.skipIf(!USE_LOCAL_PROVIDER)(
    "isAlphanumeric combinedScore >= 0.70 for corpus query (DISCOVERY_EVAL_PROVIDER=local)",
    { timeout: 120_000 },
    async () => {
      const registry = await openRegistry(":memory:", {
        embeddings: createLocalEmbeddingProvider("Xenova/all-MiniLM-L6-v2", 384),
      });
      try {
        const forest = await shavePackage(VALIDATOR_FIXTURE_ROOT, {
          registry,
          entryPath: join(VALIDATOR_FIXTURE_ROOT, "lib", "isAlphanumeric.js"),
        });
        const plans = await collectForestSlicePlans(forest, slice, registry, "glue-aware");
        for (const { slicePlan } of plans) {
          for (const entry of slicePlan.entries) {
            if (entry.kind === "novel-glue")
              await maybePersistNovelGlueAtom(withStubIntentCard(entry), registry);
          }
        }
        const result = await registry.findCandidatesByQuery({
          behavior:
            "Validate whether a string contains only alphanumeric characters, with optional locale support for language-specific character sets",
          topK: 10,
        });
        console.log(
          "[isAlphanumeric sF] candidates:",
          result.candidates.map((c) => ({ score: c.combinedScore })),
        );
        expect(result.candidates.length).toBeGreaterThan(0);
        const topScore = result.candidates[0]?.combinedScore ?? 0;
        console.log("[isAlphanumeric sF] top combinedScore:", topScore);
        expect(topScore, "isAlphanumeric combinedScore must be >= 0.70").toBeGreaterThanOrEqual(
          0.7,
        );
      } finally {
        await registry.close();
      }
    },
  );
});

describe("validator headline bindings -- compound interaction (real production sequence)", () => {
  it(
    "all four per-entry shaves are independent, complete, and produce non-empty forests",
    { timeout: 120_000 },
    async () => {
      const bindings = [
        { name: "isEmail", entry: "isEmail.js", minMod: 7, maxMod: 12 },
        { name: "isURL", entry: "isURL.js", minMod: 6, maxMod: 12 },
        { name: "isUUID", entry: "isUUID.js", minMod: 1, maxMod: 4 },
        { name: "isAlphanumeric", entry: "isAlphanumeric.js", minMod: 2, maxMod: 5 },
      ] as const;
      for (const b of bindings) {
        const registry = await openRegistry(":memory:", {
          embeddings: createOfflineEmbeddingProvider(),
        });
        try {
          const forest = await shavePackage(VALIDATOR_FIXTURE_ROOT, {
            registry,
            entryPath: join(VALIDATOR_FIXTURE_ROOT, "lib", b.entry),
          });
          expect(forest.moduleCount).toBeGreaterThanOrEqual(b.minMod);
          expect(forest.moduleCount).toBeLessThanOrEqual(b.maxMod);
          expect(forest.stubCount).toBe(0);
          const firstNode = forest.nodes[0];
          expect(firstNode?.kind).toBe("module");
          if (firstNode?.kind === "module") expect(firstNode.filePath).toContain(b.entry);
          const plans = await collectForestSlicePlans(forest, slice, registry, "glue-aware");
          expect(plans.length).toBeGreaterThan(0);
          let persistedCount = 0;
          for (const { slicePlan } of plans) {
            for (const entry of slicePlan.entries) {
              if (entry.kind === "novel-glue") {
                const mr = await maybePersistNovelGlueAtom(withStubIntentCard(entry), registry);
                if (mr !== undefined) persistedCount++;
              }
            }
          }
          expect(persistedCount).toBeGreaterThan(0);
          console.log(
            `[compound] ${b.name}: moduleCount=${forest.moduleCount} stubCount=${forest.stubCount} persisted=${persistedCount}`,
          );
        } finally {
          await registry.close();
        }
      }
    },
  );
});
