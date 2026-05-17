// SPDX-License-Identifier: MIT
/**
 * WI-510 Slice 3 --- per-entry shave of four semver headline bindings.
 *
 * Structural sibling of validator-headline-bindings.test.ts (Slice 2 / PR #544).
 * Engine is FROZEN after Slice 1. This is a pure fixture-and-test slice.
 *
 * @decision DEC-WI510-S3-PER-ENTRY-SHAVE-001
 * title: Slice 3 shaves the four semver headline bindings per-entry, not the whole package
 * status: decided
 * rationale:
 *   Inherits structural pattern from Slice 2 (DEC-WI510-S2-PER-ENTRY-SHAVE-001).
 *   Each of the four bindings is its own shavePackage({ entryPath }) call producing
 *   a 5-22-module subgraph (plan section 3), comfortable inside the default 30s testTimeout
 *   and bounded by the Slice 2 120s per-it() ceiling.
 *
 * @decision DEC-WI510-S3-PARSE-COMPONENT-BINDING-001
 * title: parse-component from #510 issue body resolves to functions/parse.js
 * status: decided
 * rationale:
 *   semver has no file named parse-component. parse() is the canonical
 *   string-to-component-structure entry returning SemVer with major/minor/patch/
 *   prerelease/build fields. major()/minor()/patch() are thin extractors calling parse().
 *
 * @decision DEC-WI510-S3-VERSION-PIN-001
 * title: Pin to semver@7.8.0 (current latest, zero runtime deps, plain CJS)
 * status: decided
 * rationale:
 *   7.8.0 is the current latest dist-tag (verified 2026-05-16). semver@7 has zero
 *   runtime dependencies. Source is plain Node.js CJS, no Babel transpilation.
 *
 * @decision DEC-WI510-S3-FIXTURE-FULL-TARBALL-001
 * title: Vendor the full semver-7.8.0 published tarball verbatim
 * status: decided
 * rationale:
 *   Inherits Slice 2 rationale (DEC-WI510-S2-VENDORED-FIXTURE-CARRYOVER-001).
 *
 * @decision DEC-WI510-S3-CYCLE-GUARD-REAL-WORLD-PROOF-001
 * title: satisfies shave is first real-world corroboration of Slice 1 cycle guard
 * status: decided
 * rationale:
 *   semver classes/range.js <-> classes/comparator.js is a genuine circular import.
 *   Slice 1 cycle guard proven on synthetic circular-pkg/; this corroborates on real npm source.
 *   After the DEC-SLICER-ARROW-RETURNS-ARROW-001 engine fix (issue #576), range.js decompose()
 *   succeeds and the cycle guard proof is live: both range.js and comparator.js appear exactly
 *   once in the module forest (moduleCount=18, stubCount=0).
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
const SEMVER_FIXTURE_ROOT = join(FIXTURES_DIR, "semver-7.8.0");

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
    notes: ["WI-510 Slice 3 section E stub intent card for persist pipeline test"],
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
    notes: ["WI-510 Slice 3 section F semantic intent card for combinedScore quality gate"],
    modelVersion: STATIC_MODEL_TAG,
    promptVersion: STATIC_PROMPT_VERSION,
    sourceHash: sourceHash(entry.source),
    extractedAt: "2026-05-16T00:00:00.000Z",
  };
  return { ...entry, intentCard: semanticCard };
}

// ---------------------------------------------------------------------------
// semver satisfies -- sections A-E
// Expected subgraph: ~18 modules (plan section 3.1); largest of the four.
// Exercises classes/range.js <-> classes/comparator.js circular import.
// ---------------------------------------------------------------------------

describe("semver satisfies -- per-entry shave (WI-510 Slice 3)", () => {
  it(
    "section A -- moduleCount in [14,22], stubCount=0, forestTotalLeafCount>0 for satisfies subgraph",
    { timeout: 300_000 },
    async () => {
      const forest = await shavePackage(SEMVER_FIXTURE_ROOT, {
        registry: emptyRegistry,
        entryPath: join(SEMVER_FIXTURE_ROOT, "functions", "satisfies.js"),
      });
      console.log("[satisfies sA] moduleCount:", forest.moduleCount);
      console.log("[satisfies sA] stubCount:", forest.stubCount);
      console.log("[satisfies sA] forestTotalLeafCount:", forestTotalLeafCount(forest));
      console.log(
        "[satisfies sA] BFS filePaths:",
        forestModules(forest).map((m) => normalize(m.filePath).split("semver-7.8.0")[1]),
      );
      // Cycle guard proof: range <-> comparator must not cause hang.
      // DEC-WI510-S3-CYCLE-GUARD-REAL-WORLD-PROOF-001: proven live after engine fix #576.
      // Plan section 5.6 criterion 12: each must appear exactly once.
      const filePaths = forestModules(forest).map((m) => m.filePath);
      const rangeCount = filePaths.filter((p) => p.endsWith("range.js")).length;
      const comparatorCount = filePaths.filter((p) => p.endsWith("comparator.js")).length;
      console.log(
        "[satisfies sA] cycle guard: range.js:",
        rangeCount,
        "comparator.js:",
        comparatorCount,
      );
      expect(
        forest.moduleCount,
        "satisfies moduleCount should be in [14,22]",
      ).toBeGreaterThanOrEqual(14);
      expect(forest.moduleCount, "satisfies moduleCount should be in [14,22]").toBeLessThanOrEqual(
        22,
      );
      expect(forest.stubCount, "satisfies stubCount must be 0 after engine fix #576").toBe(0);
      expect(rangeCount, "range.js must appear exactly once (cycle guard proof)").toBe(1);
      expect(comparatorCount, "comparator.js must appear exactly once (cycle guard proof)").toBe(1);
      expect(forestTotalLeafCount(forest)).toBeGreaterThan(0);
    },
  );

  it("section B -- forest.nodes[0] is satisfies.js", { timeout: 300_000 }, async () => {
    const forest = await shavePackage(SEMVER_FIXTURE_ROOT, {
      registry: emptyRegistry,
      entryPath: join(SEMVER_FIXTURE_ROOT, "functions", "satisfies.js"),
    });
    const firstNode = forest.nodes[0];
    expect(firstNode).toBeDefined();
    expect(firstNode?.kind).toBe("module");
    if (firstNode?.kind === "module") expect(firstNode.filePath).toContain("satisfies.js");
  });

  it(
    "section C -- subgraph has only transitively-reachable modules; no unrelated semver behaviors",
    { timeout: 300_000 },
    async () => {
      const forest = await shavePackage(SEMVER_FIXTURE_ROOT, {
        registry: emptyRegistry,
        entryPath: join(SEMVER_FIXTURE_ROOT, "functions", "satisfies.js"),
      });
      const filePaths = forestModules(forest).map((m) => m.filePath);
      for (const fp of filePaths) expect(fp).toContain("semver-7.8.0");
      expect(filePaths.some((p) => p.includes("satisfies.js"))).toBe(true);
      // Engine fix #576: range.js and comparator.js now decompose successfully.
      expect(filePaths.some((p) => p.endsWith("range.js"))).toBe(true);
      expect(filePaths.some((p) => p.endsWith("comparator.js"))).toBe(true);
      expect(filePaths.some((p) => p.endsWith("semver.js") && p.includes("classes"))).toBe(true);
      const unrelated = ["inc.js", "diff.js", "clean.js"];
      for (const u of unrelated) {
        expect(
          filePaths.every((p) => !p.includes(u)),
          `${u} must NOT be in satisfies subgraph`,
        ).toBe(true);
      }
      expect(forestStubs(forest).length).toBe(0);
    },
  );

  it(
    "section D -- two-pass byte-identical determinism for satisfies subgraph",
    { timeout: 600_000 },
    async () => {
      const entryPath = join(SEMVER_FIXTURE_ROOT, "functions", "satisfies.js");
      const forest1 = await shavePackage(SEMVER_FIXTURE_ROOT, {
        registry: emptyRegistry,
        entryPath,
      });
      const forest2 = await shavePackage(SEMVER_FIXTURE_ROOT, {
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
    "section E -- satisfies forest persisted via real collectForestSlicePlans -> maybePersistNovelGlueAtom path",
    { timeout: 300_000 },
    async () => {
      const registry = await openRegistry(":memory:", {
        embeddings: createOfflineEmbeddingProvider(),
      });
      try {
        const forest = await shavePackage(SEMVER_FIXTURE_ROOT, {
          registry,
          entryPath: join(SEMVER_FIXTURE_ROOT, "functions", "satisfies.js"),
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
        console.log("[satisfies sE] persisted atoms:", persistedCount);
        expect(
          plans.length,
          "satisfies sE: collectForestSlicePlans must produce plans",
        ).toBeGreaterThan(0);
        // Engine fix #576: range.js decomposes now, so satisfies produces novel-glue atoms.
        expect(
          persistedCount,
          "satisfies sE: must persist at least one atom after engine fix #576",
        ).toBeGreaterThan(0);
      } finally {
        await registry.close();
      }
    },
  );
});

// ---------------------------------------------------------------------------
// semver coerce -- sections A-E
// Expected subgraph: ~8 modules (plan section 3.2)
// ---------------------------------------------------------------------------

describe("semver coerce -- per-entry shave (WI-510 Slice 3)", () => {
  it(
    "section A -- moduleCount in [6,12], stubCount=0, forestTotalLeafCount>0 for coerce subgraph",
    { timeout: 300_000 },
    async () => {
      const forest = await shavePackage(SEMVER_FIXTURE_ROOT, {
        registry: emptyRegistry,
        entryPath: join(SEMVER_FIXTURE_ROOT, "functions", "coerce.js"),
      });
      console.log("[coerce sA] moduleCount:", forest.moduleCount);
      console.log("[coerce sA] stubCount:", forest.stubCount);
      console.log("[coerce sA] forestTotalLeafCount:", forestTotalLeafCount(forest));
      console.log(
        "[coerce sA] BFS filePaths:",
        forestModules(forest).map((m) => normalize(m.filePath).split("semver-7.8.0")[1]),
      );
      expect(forest.moduleCount, "coerce moduleCount should be 6-12").toBeGreaterThanOrEqual(6);
      expect(forest.moduleCount, "coerce moduleCount should be 6-12").toBeLessThanOrEqual(12);
      expect(forest.stubCount).toBe(0);
      expect(forestTotalLeafCount(forest)).toBeGreaterThan(0);
    },
  );

  it("section B -- forest.nodes[0] is coerce.js", { timeout: 300_000 }, async () => {
    const forest = await shavePackage(SEMVER_FIXTURE_ROOT, {
      registry: emptyRegistry,
      entryPath: join(SEMVER_FIXTURE_ROOT, "functions", "coerce.js"),
    });
    const firstNode = forest.nodes[0];
    expect(firstNode).toBeDefined();
    expect(firstNode?.kind).toBe("module");
    if (firstNode?.kind === "module") expect(firstNode.filePath).toContain("coerce.js");
  });

  it(
    "section C -- subgraph has only transitively-reachable modules; no unrelated semver behaviors",
    { timeout: 300_000 },
    async () => {
      const forest = await shavePackage(SEMVER_FIXTURE_ROOT, {
        registry: emptyRegistry,
        entryPath: join(SEMVER_FIXTURE_ROOT, "functions", "coerce.js"),
      });
      const filePaths = forestModules(forest).map((m) => m.filePath);
      for (const fp of filePaths) expect(fp).toContain("semver-7.8.0");
      expect(filePaths.some((p) => p.includes("coerce.js"))).toBe(true);
      expect(filePaths.some((p) => p.endsWith("semver.js") && p.includes("classes"))).toBe(true);
      expect(filePaths.some((p) => p.includes("functions") && p.endsWith("parse.js"))).toBe(true);
      expect(filePaths.some((p) => p.endsWith("re.js"))).toBe(true);
      const unrelated = ["satisfies.js", "inc.js", "diff.js"];
      for (const u of unrelated) {
        expect(
          filePaths.every((p) => !p.includes(u)),
          `${u} must NOT be in coerce subgraph`,
        ).toBe(true);
      }
      expect(forestStubs(forest).length).toBe(0);
    },
  );

  it(
    "section D -- two-pass byte-identical determinism for coerce subgraph",
    { timeout: 300_000 },
    async () => {
      const entryPath = join(SEMVER_FIXTURE_ROOT, "functions", "coerce.js");
      const forest1 = await shavePackage(SEMVER_FIXTURE_ROOT, {
        registry: emptyRegistry,
        entryPath,
      });
      const forest2 = await shavePackage(SEMVER_FIXTURE_ROOT, {
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
    "section E -- coerce forest persisted via real collectForestSlicePlans -> maybePersistNovelGlueAtom path",
    { timeout: 300_000 },
    async () => {
      const registry = await openRegistry(":memory:", {
        embeddings: createOfflineEmbeddingProvider(),
      });
      try {
        const forest = await shavePackage(SEMVER_FIXTURE_ROOT, {
          registry,
          entryPath: join(SEMVER_FIXTURE_ROOT, "functions", "coerce.js"),
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
        console.log("[coerce sE] persisted atoms:", persistedCount);
        expect(persistedCount).toBeGreaterThan(0);
      } finally {
        await registry.close();
      }
    },
  );
});

// ---------------------------------------------------------------------------
// semver compare -- sections A-E
// Expected subgraph: ~7 modules (plan section 3.3)
// ---------------------------------------------------------------------------

describe("semver compare -- per-entry shave (WI-510 Slice 3)", () => {
  it(
    "section A -- moduleCount in [5,10], stubCount=0, forestTotalLeafCount>0 for compare subgraph",
    { timeout: 300_000 },
    async () => {
      const forest = await shavePackage(SEMVER_FIXTURE_ROOT, {
        registry: emptyRegistry,
        entryPath: join(SEMVER_FIXTURE_ROOT, "functions", "compare.js"),
      });
      console.log("[compare sA] moduleCount:", forest.moduleCount);
      console.log("[compare sA] stubCount:", forest.stubCount);
      console.log("[compare sA] forestTotalLeafCount:", forestTotalLeafCount(forest));
      console.log(
        "[compare sA] BFS filePaths:",
        forestModules(forest).map((m) => normalize(m.filePath).split("semver-7.8.0")[1]),
      );
      expect(forest.moduleCount, "compare moduleCount should be 5-10").toBeGreaterThanOrEqual(5);
      expect(forest.moduleCount, "compare moduleCount should be 5-10").toBeLessThanOrEqual(10);
      expect(forest.stubCount).toBe(0);
      expect(forestTotalLeafCount(forest)).toBeGreaterThan(0);
    },
  );

  it("section B -- forest.nodes[0] is compare.js", { timeout: 300_000 }, async () => {
    const forest = await shavePackage(SEMVER_FIXTURE_ROOT, {
      registry: emptyRegistry,
      entryPath: join(SEMVER_FIXTURE_ROOT, "functions", "compare.js"),
    });
    const firstNode = forest.nodes[0];
    expect(firstNode).toBeDefined();
    expect(firstNode?.kind).toBe("module");
    if (firstNode?.kind === "module") expect(firstNode.filePath).toContain("compare.js");
  });

  it(
    "section C -- subgraph has only transitively-reachable modules; no unrelated semver behaviors",
    { timeout: 300_000 },
    async () => {
      const forest = await shavePackage(SEMVER_FIXTURE_ROOT, {
        registry: emptyRegistry,
        entryPath: join(SEMVER_FIXTURE_ROOT, "functions", "compare.js"),
      });
      const filePaths = forestModules(forest).map((m) => m.filePath);
      for (const fp of filePaths) expect(fp).toContain("semver-7.8.0");
      expect(filePaths.some((p) => p.includes("compare.js"))).toBe(true);
      expect(filePaths.some((p) => p.endsWith("semver.js") && p.includes("classes"))).toBe(true);
      const unrelated = ["satisfies.js", "coerce.js", "inc.js", "diff.js"];
      for (const u of unrelated) {
        expect(
          filePaths.every((p) => !p.includes(u)),
          `${u} must NOT be in compare subgraph`,
        ).toBe(true);
      }
      expect(forestStubs(forest).length).toBe(0);
    },
  );

  it(
    "section D -- two-pass byte-identical determinism for compare subgraph",
    { timeout: 300_000 },
    async () => {
      const entryPath = join(SEMVER_FIXTURE_ROOT, "functions", "compare.js");
      const forest1 = await shavePackage(SEMVER_FIXTURE_ROOT, {
        registry: emptyRegistry,
        entryPath,
      });
      const forest2 = await shavePackage(SEMVER_FIXTURE_ROOT, {
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
    "section E -- compare forest persisted via real collectForestSlicePlans -> maybePersistNovelGlueAtom path",
    { timeout: 300_000 },
    async () => {
      const registry = await openRegistry(":memory:", {
        embeddings: createOfflineEmbeddingProvider(),
      });
      try {
        const forest = await shavePackage(SEMVER_FIXTURE_ROOT, {
          registry,
          entryPath: join(SEMVER_FIXTURE_ROOT, "functions", "compare.js"),
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
        console.log("[compare sE] persisted atoms:", persistedCount);
        expect(persistedCount).toBeGreaterThan(0);
      } finally {
        await registry.close();
      }
    },
  );
});

// ---------------------------------------------------------------------------
// semver parse -- sections A-E
// Expected subgraph: ~7 modules (plan section 3.4)
// Resolves issue-body "parse-component" per DEC-WI510-S3-PARSE-COMPONENT-BINDING-001
// ---------------------------------------------------------------------------

describe("semver parse -- per-entry shave (WI-510 Slice 3)", () => {
  it(
    "section A -- moduleCount in [5,10], stubCount=0, forestTotalLeafCount>0 for parse subgraph",
    { timeout: 300_000 },
    async () => {
      const forest = await shavePackage(SEMVER_FIXTURE_ROOT, {
        registry: emptyRegistry,
        entryPath: join(SEMVER_FIXTURE_ROOT, "functions", "parse.js"),
      });
      console.log("[parse sA] moduleCount:", forest.moduleCount);
      console.log("[parse sA] stubCount:", forest.stubCount);
      console.log("[parse sA] forestTotalLeafCount:", forestTotalLeafCount(forest));
      console.log(
        "[parse sA] BFS filePaths:",
        forestModules(forest).map((m) => normalize(m.filePath).split("semver-7.8.0")[1]),
      );
      expect(forest.moduleCount, "parse moduleCount should be 5-10").toBeGreaterThanOrEqual(5);
      expect(forest.moduleCount, "parse moduleCount should be 5-10").toBeLessThanOrEqual(10);
      expect(forest.stubCount).toBe(0);
      expect(forestTotalLeafCount(forest)).toBeGreaterThan(0);
    },
  );

  it("section B -- forest.nodes[0] is parse.js", { timeout: 300_000 }, async () => {
    const forest = await shavePackage(SEMVER_FIXTURE_ROOT, {
      registry: emptyRegistry,
      entryPath: join(SEMVER_FIXTURE_ROOT, "functions", "parse.js"),
    });
    const firstNode = forest.nodes[0];
    expect(firstNode).toBeDefined();
    expect(firstNode?.kind).toBe("module");
    if (firstNode?.kind === "module") expect(firstNode.filePath).toContain("parse.js");
  });

  it(
    "section C -- subgraph has only transitively-reachable modules; no unrelated semver behaviors",
    { timeout: 300_000 },
    async () => {
      const forest = await shavePackage(SEMVER_FIXTURE_ROOT, {
        registry: emptyRegistry,
        entryPath: join(SEMVER_FIXTURE_ROOT, "functions", "parse.js"),
      });
      const filePaths = forestModules(forest).map((m) => m.filePath);
      for (const fp of filePaths) expect(fp).toContain("semver-7.8.0");
      expect(filePaths.some((p) => p.includes("functions") && p.endsWith("parse.js"))).toBe(true);
      expect(filePaths.some((p) => p.endsWith("semver.js") && p.includes("classes"))).toBe(true);
      const unrelated = ["satisfies.js", "coerce.js", "inc.js", "diff.js"];
      for (const u of unrelated) {
        expect(
          filePaths.every((p) => !p.includes(u)),
          `${u} must NOT be in parse subgraph`,
        ).toBe(true);
      }
      expect(forestStubs(forest).length).toBe(0);
    },
  );

  it(
    "section D -- two-pass byte-identical determinism for parse subgraph",
    { timeout: 300_000 },
    async () => {
      const entryPath = join(SEMVER_FIXTURE_ROOT, "functions", "parse.js");
      const forest1 = await shavePackage(SEMVER_FIXTURE_ROOT, {
        registry: emptyRegistry,
        entryPath,
      });
      const forest2 = await shavePackage(SEMVER_FIXTURE_ROOT, {
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
    "section E -- parse forest persisted via real collectForestSlicePlans -> maybePersistNovelGlueAtom path",
    { timeout: 300_000 },
    async () => {
      const registry = await openRegistry(":memory:", {
        embeddings: createOfflineEmbeddingProvider(),
      });
      try {
        const forest = await shavePackage(SEMVER_FIXTURE_ROOT, {
          registry,
          entryPath: join(SEMVER_FIXTURE_ROOT, "functions", "parse.js"),
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
        console.log("[parse sE] persisted atoms:", persistedCount);
        expect(persistedCount).toBeGreaterThan(0);
      } finally {
        await registry.close();
      }
    },
  );
});

// ---------------------------------------------------------------------------
// Section F tests (combinedScore quality gate, DISCOVERY_EVAL_PROVIDER=local)
// Per plan section 5.6 criterion 7: if DISCOVERY_EVAL_PROVIDER=local is absent,
// the quality block skips -- the slice is BLOCKED, not ready.
// ---------------------------------------------------------------------------

describe("semver satisfies section F -- combinedScore quality gate", () => {
  it.skipIf(!USE_LOCAL_PROVIDER)(
    "satisfies combinedScore >= 0.70 for corpus query (DISCOVERY_EVAL_PROVIDER=local)",
    { timeout: 120_000 },
    async () => {
      const registry = await openRegistry(":memory:", {
        embeddings: createLocalEmbeddingProvider("Xenova/all-MiniLM-L6-v2", 384),
      });
      try {
        const forest = await shavePackage(SEMVER_FIXTURE_ROOT, {
          registry,
          entryPath: join(SEMVER_FIXTURE_ROOT, "functions", "satisfies.js"),
        });
        const plans = await collectForestSlicePlans(forest, slice, registry, "glue-aware");
        for (const { slicePlan } of plans) {
          for (const entry of slicePlan.entries) {
            if (entry.kind === "novel-glue")
              await maybePersistNovelGlueAtom(
                withSemanticIntentCard(
                  entry,
                  "Check whether a semantic version string satisfies a given semver range expression, returning true or false",
                  [
                    "semver version range satisfaction check",
                    "version string matches range constraint",
                    "returns boolean true if version is within range",
                  ],
                ),
                registry,
              );
          }
        }
        const result = await registry.findCandidatesByQuery({
          behavior:
            "Check whether a semantic version string satisfies a given semver range expression, returning true or false",
          topK: 10,
        });
        console.log(
          "[satisfies sF] candidates:",
          result.candidates.map((c) => ({ score: c.combinedScore })),
        );
        expect(result.candidates.length).toBeGreaterThan(0);
        const topScore = result.candidates[0]?.combinedScore ?? 0;
        console.log("[satisfies sF] top combinedScore:", topScore);
        expect(topScore, "satisfies combinedScore must be >= 0.70").toBeGreaterThanOrEqual(0.7);
      } finally {
        await registry.close();
      }
    },
  );
});

describe("semver coerce section F -- combinedScore quality gate", () => {
  it.skipIf(!USE_LOCAL_PROVIDER)(
    "coerce combinedScore >= 0.70 for corpus query (DISCOVERY_EVAL_PROVIDER=local)",
    { timeout: 120_000 },
    async () => {
      const registry = await openRegistry(":memory:", {
        embeddings: createLocalEmbeddingProvider("Xenova/all-MiniLM-L6-v2", 384),
      });
      try {
        const forest = await shavePackage(SEMVER_FIXTURE_ROOT, {
          registry,
          entryPath: join(SEMVER_FIXTURE_ROOT, "functions", "coerce.js"),
        });
        const plans = await collectForestSlicePlans(forest, slice, registry, "glue-aware");
        for (const { slicePlan } of plans) {
          for (const entry of slicePlan.entries) {
            if (entry.kind === "novel-glue")
              await maybePersistNovelGlueAtom(
                withSemanticIntentCard(
                  entry,
                  "Coerce a loose version string or number into a valid semver version object, extracting major, minor, and patch components",
                  [
                    "semver version coercion normalization",
                    "convert loose version string to SemVer object with major minor patch fields",
                  ],
                ),
                registry,
              );
          }
        }
        const result = await registry.findCandidatesByQuery({
          behavior:
            "Coerce a loose version string or number into a valid semver version object, extracting major, minor, and patch components",
          topK: 10,
        });
        console.log(
          "[coerce sF] candidates:",
          result.candidates.map((c) => ({ score: c.combinedScore })),
        );
        expect(result.candidates.length).toBeGreaterThan(0);
        const topScore = result.candidates[0]?.combinedScore ?? 0;
        console.log("[coerce sF] top combinedScore:", topScore);
        expect(topScore, "coerce combinedScore must be >= 0.70").toBeGreaterThanOrEqual(0.7);
      } finally {
        await registry.close();
      }
    },
  );
});

describe("semver compare section F -- combinedScore quality gate", () => {
  it.skipIf(!USE_LOCAL_PROVIDER)(
    "compare combinedScore >= 0.70 for corpus query (DISCOVERY_EVAL_PROVIDER=local)",
    { timeout: 120_000 },
    async () => {
      const registry = await openRegistry(":memory:", {
        embeddings: createLocalEmbeddingProvider("Xenova/all-MiniLM-L6-v2", 384),
      });
      try {
        const forest = await shavePackage(SEMVER_FIXTURE_ROOT, {
          registry,
          entryPath: join(SEMVER_FIXTURE_ROOT, "functions", "compare.js"),
        });
        const plans = await collectForestSlicePlans(forest, slice, registry, "glue-aware");
        for (const { slicePlan } of plans) {
          for (const entry of slicePlan.entries) {
            if (entry.kind === "novel-glue")
              await maybePersistNovelGlueAtom(
                withSemanticIntentCard(
                  entry,
                  "Compare two semantic version strings and return -1, 0, or 1 indicating their relative ordering",
                  [
                    "semver version comparison ordering",
                    "returns negative zero positive integer for version sort",
                  ],
                ),
                registry,
              );
          }
        }
        const result = await registry.findCandidatesByQuery({
          behavior:
            "Compare two semantic version strings and return -1, 0, or 1 indicating their relative ordering",
          topK: 10,
        });
        console.log(
          "[compare sF] candidates:",
          result.candidates.map((c) => ({ score: c.combinedScore })),
        );
        expect(result.candidates.length).toBeGreaterThan(0);
        const topScore = result.candidates[0]?.combinedScore ?? 0;
        console.log("[compare sF] top combinedScore:", topScore);
        expect(topScore, "compare combinedScore must be >= 0.70").toBeGreaterThanOrEqual(0.7);
      } finally {
        await registry.close();
      }
    },
  );
});

describe("semver parse section F -- combinedScore quality gate", () => {
  it.skipIf(!USE_LOCAL_PROVIDER)(
    "parse combinedScore >= 0.70 for corpus query (DISCOVERY_EVAL_PROVIDER=local)",
    { timeout: 120_000 },
    async () => {
      const registry = await openRegistry(":memory:", {
        embeddings: createLocalEmbeddingProvider("Xenova/all-MiniLM-L6-v2", 384),
      });
      try {
        const forest = await shavePackage(SEMVER_FIXTURE_ROOT, {
          registry,
          entryPath: join(SEMVER_FIXTURE_ROOT, "functions", "parse.js"),
        });
        const plans = await collectForestSlicePlans(forest, slice, registry, "glue-aware");
        for (const { slicePlan } of plans) {
          for (const entry of slicePlan.entries) {
            if (entry.kind === "novel-glue")
              await maybePersistNovelGlueAtom(
                withSemanticIntentCard(
                  entry,
                  "Parse a semantic version string into its component parts: major, minor, patch, prerelease, and build metadata",
                  [
                    "semver version parsing component extraction",
                    "returns SemVer object with major minor patch prerelease build fields",
                  ],
                ),
                registry,
              );
          }
        }
        const result = await registry.findCandidatesByQuery({
          behavior:
            "Parse a semantic version string into its component parts: major, minor, patch, prerelease, and build metadata",
          topK: 10,
        });
        console.log(
          "[parse sF] candidates:",
          result.candidates.map((c) => ({ score: c.combinedScore })),
        );
        expect(result.candidates.length).toBeGreaterThan(0);
        const topScore = result.candidates[0]?.combinedScore ?? 0;
        console.log("[parse sF] top combinedScore:", topScore);
        expect(topScore, "parse combinedScore must be >= 0.70").toBeGreaterThanOrEqual(0.7);
      } finally {
        await registry.close();
      }
    },
  );
});

// ---------------------------------------------------------------------------
// Compound interaction test -- real production sequence end-to-end
// Plan section 5.1: at least one test exercising the real production sequence
// crossing multiple internal component boundaries:
//   shavePackage -> collectForestSlicePlans -> maybePersistNovelGlueAtom
// All four headline bindings run in sequence with isolated registries.
// ---------------------------------------------------------------------------

describe("semver headline bindings -- compound interaction (real production sequence)", () => {
  it(
    "all four per-entry shaves are independent, complete, produce non-empty forests, and persist via real path",
    { timeout: 900_000 },
    async () => {
      const bindings = [
        { name: "satisfies", entry: "satisfies.js", minMod: 14, maxMod: 22 }, // engine fix #576: range.js now decomposes
        { name: "coerce", entry: "coerce.js", minMod: 6, maxMod: 12 },
        { name: "compare", entry: "compare.js", minMod: 5, maxMod: 10 },
        { name: "parse", entry: "parse.js", minMod: 5, maxMod: 10 },
      ] as const;
      for (const b of bindings) {
        const registry = await openRegistry(":memory:", {
          embeddings: createOfflineEmbeddingProvider(),
        });
        try {
          const forest = await shavePackage(SEMVER_FIXTURE_ROOT, {
            registry,
            entryPath: join(SEMVER_FIXTURE_ROOT, "functions", b.entry),
          });
          expect(forest.moduleCount).toBeGreaterThanOrEqual(b.minMod);
          expect(forest.moduleCount).toBeLessThanOrEqual(b.maxMod);
          expect(forest.stubCount, `${b.name} stubCount must be 0`).toBe(0);
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
          expect(
            persistedCount,
            `${b.name} compound: must persist at least one atom`,
          ).toBeGreaterThan(0);
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
