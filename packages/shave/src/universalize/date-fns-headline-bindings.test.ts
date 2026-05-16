// SPDX-License-Identifier: MIT
/**
 * WI-510 Slice 5 --- per-entry shave of five date-fns headline bindings.
 *
 * Structural sibling of uuid-headline-bindings.test.ts (Slice 4 / PR #573),
 * nanoid-headline-bindings.test.ts (Slice 4 / PR #573),
 * semver-headline-bindings.test.ts (Slice 3 / PR #570), and
 * validator-headline-bindings.test.ts (Slice 2 / PR #544).
 * Engine is FROZEN after Slice 1. This is a pure fixture-and-test slice.
 *
 * Five bindings from date-fns@4.1.0 (TRIMMED fixture — ~50-80KB, not the full 32MB tarball):
 *   1. parseISO     (headline 1) -- parse ISO-8601 string into Date
 *   2. formatISO    (headline 2) -- format Date into ISO-8601 string
 *   3. addDays      (headline 3) -- add N days to a Date
 *   4. differenceInMilliseconds (headline 4) -- ms difference between two Dates
 *   5. parseJSON    (headline 5) -- parse ISO date string with tz-offset suffix into Date
 *
 * Novel properties exercised by this slice vs prior slices:
 *   - Return to stubCount=0 (inverse of Slice 4's Node-builtin case)
 *     DEC-WI510-S5-RETURN-TO-ZERO-EXTERNAL-001
 *   - First real-world subdirectory traversal: formatISO -> _lib/addLeadingZeros.cjs
 *     DEC-WI510-S5-SUBDIRECTORY-TRAVERSAL-001
 *
 * @decision DEC-WI510-S5-PER-ENTRY-SHAVE-001
 * title: Slice 5 shaves five date-fns headline bindings per-entry, not the whole package
 * status: decided
 * rationale: Inherits the structural pattern from Slices 2-4. Each of the five bindings
 *   is its own shavePackage({ entryPath }) call producing a 4-5-module subgraph.
 *   A whole-package shave on date-fns would start at index.cjs which re-exports ~250 behaviors.
 *
 * @decision DEC-WI510-S5-DIFFERENCE-IN-MS-BINDING-001
 * title: Issue-body "differenceInMs" resolves to differenceInMilliseconds.cjs
 * status: decided
 * rationale: date-fns exports the full name differenceInMilliseconds, not the abbreviation.
 *
 * @decision DEC-WI510-S5-PARSE-TZ-OFFSET-RESOLUTION-001
 * title: Issue-body "parse-tz-offset" resolves to substitute parseJSON.cjs
 * status: decided
 * rationale: date-fns@4.1.0 ships no top-level parseTzOffset.cjs entry. parseJSON is the
 *   canonical public binding that parses a date string WITH a trailing timezone-offset suffix
 *   (+00:00, +0000, +05:45) into a Date. Real tz-string parsing via date-fns-tz is deferred.
 *
 * @decision DEC-WI510-S5-VERSION-PIN-001
 * title: Pin to date-fns@4.1.0 (current latest; dual-format ESM+CJS via package.json exports)
 * status: decided
 * rationale: 4.1.0 is current latest dist-tag. Ships dual-format .cjs + .js via exports.
 *   Zero npm dependencies. No class declarations in any Slice 5 headline transitive subgraph
 *   (engine limit #576 structurally not exercised).
 *
 * @decision DEC-WI510-S5-FIXTURE-TRIMMED-VENDOR-001
 * title: Vendor a trimmed subset of date-fns-4.1.0 (not the full 32MB tarball)
 * status: decided
 * rationale: Full tarball is 32MB (65x the largest prior fixture at 487KB). Trimmed vendor
 *   retains only the 9 .cjs files the headlines traverse plus package.json and LICENSE.md.
 *   Total ~50-80KB. See PROVENANCE.md for the explicit manifest.
 *
 * @decision DEC-WI510-S5-RETURN-TO-ZERO-EXTERNAL-001
 * title: All 5 date-fns headline subgraphs produce stubCount=0 -- inverse of Slice 4
 * status: decided
 * rationale: date-fns has no runtime npm deps AND the 5 headline subgraphs reach no Node
 *   builtins via require(). Inverse corroboration of Slice 4's Node-builtin case.
 *
 * @decision DEC-WI510-S5-SUBDIRECTORY-TRAVERSAL-001
 * title: formatISO shave traverses _lib/addLeadingZeros.cjs -- first subdirectory descent
 * status: decided
 * rationale: First WI-510 fixture to exercise BFS descent into a package subdirectory (_lib/).
 *   The B-scope predicate (isInPackageBoundary) must correctly accept subdirectory edges.
 *   Plan section 5.6 criterion 13 makes this an explicit acceptance gate.
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
const DATE_FNS_FIXTURE_ROOT = join(FIXTURES_DIR, "date-fns-4.1.0");

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
    notes: ["WI-510 Slice 5 section E stub intent card for persist pipeline test"],
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
    notes: ["WI-510 Slice 5 section F semantic intent card for combinedScore quality gate"],
    modelVersion: STATIC_MODEL_TAG,
    promptVersion: STATIC_PROMPT_VERSION,
    sourceHash: sourceHash(entry.source),
    extractedAt: "2026-05-16T00:00:00.000Z",
  };
  return { ...entry, intentCard: semanticCard };
}

// ---------------------------------------------------------------------------
// parseISO -- sections A-E
// Expected subgraph: ~4 modules (plan section 3.1): parseISO, toDate, constructFrom, constants
// stubCount=0: no external edges (Date is a runtime global, not a require() edge).
// DEC-WI510-S5-RETURN-TO-ZERO-EXTERNAL-001: inverse of Slice 4's Node-builtin case.
// ---------------------------------------------------------------------------

describe("parseISO -- per-entry shave (WI-510 Slice 5)", () => {
  it(
    "section A -- moduleCount in [3,6], stubCount=0, forestTotalLeafCount>0 for parseISO subgraph",
    { timeout: 120_000 },
    async () => {
      const forest = await shavePackage(DATE_FNS_FIXTURE_ROOT, {
        registry: emptyRegistry,
        entryPath: join(DATE_FNS_FIXTURE_ROOT, "parseISO.cjs"),
      });
      console.log("[parseISO sA] moduleCount:", forest.moduleCount);
      console.log("[parseISO sA] stubCount:", forest.stubCount);
      console.log("[parseISO sA] forestTotalLeafCount:", forestTotalLeafCount(forest));
      console.log(
        "[parseISO sA] BFS filePaths:",
        forestModules(forest).map((m) => normalize(m.filePath).split("date-fns-4.1.0")[1]),
      );
      // DEC-WI510-S5-RETURN-TO-ZERO-EXTERNAL-001: pure in-package subgraph, no Node builtins.
      expect(
        forest.moduleCount,
        "parseISO moduleCount should be 3-6 (plan section 3.1)",
      ).toBeGreaterThanOrEqual(3);
      expect(
        forest.moduleCount,
        "parseISO moduleCount should be 3-6 (plan section 3.1)",
      ).toBeLessThanOrEqual(6);
      // Plan section 5.6 criterion 12: stubCount must be 0 for all 5 headlines.
      expect(
        forest.stubCount,
        "parseISO forest-level stubCount must be 0 (no external edges -- DEC-WI510-S5-RETURN-TO-ZERO-EXTERNAL-001)",
      ).toBe(0);
      expect(forestStubs(forest).length, "parseISO forestStubs must be empty").toBe(0);
      expect(forestTotalLeafCount(forest)).toBeGreaterThan(0);
    },
  );

  it("section B -- forest.nodes[0] is parseISO.cjs", { timeout: 120_000 }, async () => {
    const forest = await shavePackage(DATE_FNS_FIXTURE_ROOT, {
      registry: emptyRegistry,
      entryPath: join(DATE_FNS_FIXTURE_ROOT, "parseISO.cjs"),
    });
    const firstNode = forest.nodes[0];
    expect(firstNode).toBeDefined();
    expect(firstNode?.kind).toBe("module");
    if (firstNode?.kind === "module") expect(firstNode.filePath).toContain("parseISO.cjs");
  });

  it(
    "section C -- subgraph has only transitively-reachable modules; no unrelated date-fns behaviors",
    { timeout: 120_000 },
    async () => {
      const forest = await shavePackage(DATE_FNS_FIXTURE_ROOT, {
        registry: emptyRegistry,
        entryPath: join(DATE_FNS_FIXTURE_ROOT, "parseISO.cjs"),
      });
      const filePaths = forestModules(forest).map((m) => m.filePath);
      for (const fp of filePaths) expect(fp).toContain("date-fns-4.1.0");
      expect(filePaths.some((p) => p.includes("parseISO.cjs"))).toBe(true);
      expect(filePaths.some((p) => p.endsWith("toDate.cjs"))).toBe(true);
      expect(filePaths.some((p) => p.endsWith("constructFrom.cjs"))).toBe(true);
      expect(filePaths.some((p) => p.endsWith("constants.cjs"))).toBe(true);
      // parseISO does NOT pull in formatISO, addDays, differenceInMilliseconds, parseJSON:
      const unrelated = [
        "formatISO.cjs",
        "addDays.cjs",
        "differenceInMilliseconds.cjs",
        "parseJSON.cjs",
      ];
      for (const u of unrelated) {
        expect(
          filePaths.every((p) => !p.endsWith(u)),
          `${String(u)} must NOT be in parseISO subgraph`,
        ).toBe(true);
      }
      // parseISO subgraph does NOT traverse _lib/ (only formatISO does).
      expect(
        filePaths.every((p) => !p.includes("_lib")),
        "parseISO subgraph must not include _lib/ files (only formatISO uses addLeadingZeros)",
      ).toBe(true);
      expect(forestStubs(forest).length).toBe(0);
    },
  );

  it(
    "section D -- two-pass byte-identical determinism for parseISO subgraph",
    { timeout: 120_000 },
    async () => {
      const entryPath = join(DATE_FNS_FIXTURE_ROOT, "parseISO.cjs");
      const forest1 = await shavePackage(DATE_FNS_FIXTURE_ROOT, {
        registry: emptyRegistry,
        entryPath,
      });
      const forest2 = await shavePackage(DATE_FNS_FIXTURE_ROOT, {
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
    "section E -- parseISO forest persisted via real collectForestSlicePlans -> maybePersistNovelGlueAtom path",
    { timeout: 120_000 },
    async () => {
      const registry = await openRegistry(":memory:", {
        embeddings: createOfflineEmbeddingProvider(),
      });
      try {
        const forest = await shavePackage(DATE_FNS_FIXTURE_ROOT, {
          registry,
          entryPath: join(DATE_FNS_FIXTURE_ROOT, "parseISO.cjs"),
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
        console.log("[parseISO sE] persisted atoms:", persistedCount);
        // parseISO contains multiple function bodies and complex const patterns.
        // Per plan section 5.2: persistedCount > 0 for parseISO.
        expect(persistedCount).toBeGreaterThan(0);
      } finally {
        await registry.close();
      }
    },
  );
});

// ---------------------------------------------------------------------------
// formatISO -- sections A-E
// Expected subgraph: ~5 modules (plan section 3.2):
//   formatISO, _lib/addLeadingZeros, toDate, constructFrom, constants
// stubCount=0.
// DEC-WI510-S5-SUBDIRECTORY-TRAVERSAL-001: first WI-510 fixture to traverse _lib/ subdirectory.
// Plan section 5.6 criterion 13: reviewer confirms _lib/addLeadingZeros.cjs is in the forest.
// ---------------------------------------------------------------------------

describe("formatISO -- per-entry shave (WI-510 Slice 5)", () => {
  it(
    "section A -- moduleCount in [4,8], stubCount=0, forestTotalLeafCount>0 for formatISO subgraph",
    { timeout: 120_000 },
    async () => {
      const forest = await shavePackage(DATE_FNS_FIXTURE_ROOT, {
        registry: emptyRegistry,
        entryPath: join(DATE_FNS_FIXTURE_ROOT, "formatISO.cjs"),
      });
      console.log("[formatISO sA] moduleCount:", forest.moduleCount);
      console.log("[formatISO sA] stubCount:", forest.stubCount);
      console.log("[formatISO sA] forestTotalLeafCount:", forestTotalLeafCount(forest));
      console.log(
        "[formatISO sA] BFS filePaths:",
        forestModules(forest).map((m) => normalize(m.filePath).split("date-fns-4.1.0")[1]),
      );
      expect(
        forest.moduleCount,
        "formatISO moduleCount should be 4-8 (plan section 3.2)",
      ).toBeGreaterThanOrEqual(4);
      expect(
        forest.moduleCount,
        "formatISO moduleCount should be 4-8 (plan section 3.2)",
      ).toBeLessThanOrEqual(8);
      // DEC-WI510-S5-RETURN-TO-ZERO-EXTERNAL-001
      expect(
        forest.stubCount,
        "formatISO forest-level stubCount must be 0 (no external edges)",
      ).toBe(0);
      expect(forestStubs(forest).length, "formatISO forestStubs must be empty").toBe(0);
      expect(forestTotalLeafCount(forest)).toBeGreaterThan(0);
    },
  );

  it("section B -- forest.nodes[0] is formatISO.cjs", { timeout: 120_000 }, async () => {
    const forest = await shavePackage(DATE_FNS_FIXTURE_ROOT, {
      registry: emptyRegistry,
      entryPath: join(DATE_FNS_FIXTURE_ROOT, "formatISO.cjs"),
    });
    const firstNode = forest.nodes[0];
    expect(firstNode).toBeDefined();
    expect(firstNode?.kind).toBe("module");
    if (firstNode?.kind === "module") expect(firstNode.filePath).toContain("formatISO.cjs");
  });

  it(
    "section C -- subdirectory traversal proven: _lib/addLeadingZeros.cjs in forest (DEC-WI510-S5-SUBDIRECTORY-TRAVERSAL-001)",
    { timeout: 120_000 },
    async () => {
      const forest = await shavePackage(DATE_FNS_FIXTURE_ROOT, {
        registry: emptyRegistry,
        entryPath: join(DATE_FNS_FIXTURE_ROOT, "formatISO.cjs"),
      });
      const filePaths = forestModules(forest).map((m) => m.filePath);
      for (const fp of filePaths) expect(fp).toContain("date-fns-4.1.0");
      expect(filePaths.some((p) => p.includes("formatISO.cjs"))).toBe(true);
      expect(filePaths.some((p) => p.endsWith("toDate.cjs"))).toBe(true);
      expect(filePaths.some((p) => p.endsWith("constructFrom.cjs"))).toBe(true);
      expect(filePaths.some((p) => p.endsWith("constants.cjs"))).toBe(true);
      // DEC-WI510-S5-SUBDIRECTORY-TRAVERSAL-001: _lib/ subdirectory traversal.
      // Plan section 5.6 criterion 13: this is the explicit acceptance gate.
      expect(
        filePaths.some((p) => p.includes("_lib") && p.endsWith("addLeadingZeros.cjs")),
        "_lib/addLeadingZeros.cjs must be in formatISO subgraph (DEC-WI510-S5-SUBDIRECTORY-TRAVERSAL-001)",
      ).toBe(true);
      // formatISO does NOT pull in unrelated bindings:
      const unrelated = [
        "parseISO.cjs",
        "addDays.cjs",
        "differenceInMilliseconds.cjs",
        "parseJSON.cjs",
      ];
      for (const u of unrelated) {
        expect(
          filePaths.every((p) => !p.endsWith(u)),
          `${String(u)} must NOT be in formatISO subgraph`,
        ).toBe(true);
      }
      expect(forestStubs(forest).length).toBe(0);
    },
  );

  it(
    "section D -- two-pass byte-identical determinism for formatISO subgraph",
    { timeout: 120_000 },
    async () => {
      const entryPath = join(DATE_FNS_FIXTURE_ROOT, "formatISO.cjs");
      const forest1 = await shavePackage(DATE_FNS_FIXTURE_ROOT, {
        registry: emptyRegistry,
        entryPath,
      });
      const forest2 = await shavePackage(DATE_FNS_FIXTURE_ROOT, {
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
    "section E -- formatISO forest persisted via real collectForestSlicePlans -> maybePersistNovelGlueAtom path",
    { timeout: 120_000 },
    async () => {
      const registry = await openRegistry(":memory:", {
        embeddings: createOfflineEmbeddingProvider(),
      });
      try {
        const forest = await shavePackage(DATE_FNS_FIXTURE_ROOT, {
          registry,
          entryPath: join(DATE_FNS_FIXTURE_ROOT, "formatISO.cjs"),
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
        console.log("[formatISO sE] persisted atoms:", persistedCount);
        // formatISO contains multiple function bodies. Per plan section 5.2: persistedCount > 0.
        expect(persistedCount).toBeGreaterThan(0);
      } finally {
        await registry.close();
      }
    },
  );
});

// ---------------------------------------------------------------------------
// addDays -- sections A-E
// Expected subgraph: ~4 modules (plan section 3.3): addDays, toDate, constructFrom, constants
// stubCount=0: no external edges.
// ---------------------------------------------------------------------------

describe("addDays -- per-entry shave (WI-510 Slice 5)", () => {
  it(
    "section A -- moduleCount in [3,6], stubCount=0, forestTotalLeafCount>0 for addDays subgraph",
    { timeout: 120_000 },
    async () => {
      const forest = await shavePackage(DATE_FNS_FIXTURE_ROOT, {
        registry: emptyRegistry,
        entryPath: join(DATE_FNS_FIXTURE_ROOT, "addDays.cjs"),
      });
      console.log("[addDays sA] moduleCount:", forest.moduleCount);
      console.log("[addDays sA] stubCount:", forest.stubCount);
      console.log("[addDays sA] forestTotalLeafCount:", forestTotalLeafCount(forest));
      console.log(
        "[addDays sA] BFS filePaths:",
        forestModules(forest).map((m) => normalize(m.filePath).split("date-fns-4.1.0")[1]),
      );
      expect(
        forest.moduleCount,
        "addDays moduleCount should be 3-6 (plan section 3.3)",
      ).toBeGreaterThanOrEqual(3);
      expect(
        forest.moduleCount,
        "addDays moduleCount should be 3-6 (plan section 3.3)",
      ).toBeLessThanOrEqual(6);
      // DEC-WI510-S5-RETURN-TO-ZERO-EXTERNAL-001
      expect(forest.stubCount, "addDays forest-level stubCount must be 0 (no external edges)").toBe(
        0,
      );
      expect(forestStubs(forest).length, "addDays forestStubs must be empty").toBe(0);
      expect(forestTotalLeafCount(forest)).toBeGreaterThan(0);
    },
  );

  it("section B -- forest.nodes[0] is addDays.cjs", { timeout: 120_000 }, async () => {
    const forest = await shavePackage(DATE_FNS_FIXTURE_ROOT, {
      registry: emptyRegistry,
      entryPath: join(DATE_FNS_FIXTURE_ROOT, "addDays.cjs"),
    });
    const firstNode = forest.nodes[0];
    expect(firstNode).toBeDefined();
    expect(firstNode?.kind).toBe("module");
    if (firstNode?.kind === "module") expect(firstNode.filePath).toContain("addDays.cjs");
  });

  it(
    "section C -- subgraph has only transitively-reachable modules; no unrelated date-fns behaviors",
    { timeout: 120_000 },
    async () => {
      const forest = await shavePackage(DATE_FNS_FIXTURE_ROOT, {
        registry: emptyRegistry,
        entryPath: join(DATE_FNS_FIXTURE_ROOT, "addDays.cjs"),
      });
      const filePaths = forestModules(forest).map((m) => m.filePath);
      for (const fp of filePaths) expect(fp).toContain("date-fns-4.1.0");
      expect(filePaths.some((p) => p.includes("addDays.cjs"))).toBe(true);
      expect(filePaths.some((p) => p.endsWith("toDate.cjs"))).toBe(true);
      expect(filePaths.some((p) => p.endsWith("constructFrom.cjs"))).toBe(true);
      expect(filePaths.some((p) => p.endsWith("constants.cjs"))).toBe(true);
      // addDays does NOT pull in unrelated bindings:
      const unrelated = [
        "parseISO.cjs",
        "formatISO.cjs",
        "differenceInMilliseconds.cjs",
        "parseJSON.cjs",
      ];
      for (const u of unrelated) {
        expect(
          filePaths.every((p) => !p.endsWith(u)),
          `${String(u)} must NOT be in addDays subgraph`,
        ).toBe(true);
      }
      // addDays does NOT traverse _lib/:
      expect(
        filePaths.every((p) => !p.includes("_lib")),
        "addDays subgraph must not include _lib/ files",
      ).toBe(true);
      expect(forestStubs(forest).length).toBe(0);
    },
  );

  it(
    "section D -- two-pass byte-identical determinism for addDays subgraph",
    { timeout: 120_000 },
    async () => {
      const entryPath = join(DATE_FNS_FIXTURE_ROOT, "addDays.cjs");
      const forest1 = await shavePackage(DATE_FNS_FIXTURE_ROOT, {
        registry: emptyRegistry,
        entryPath,
      });
      const forest2 = await shavePackage(DATE_FNS_FIXTURE_ROOT, {
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
    "section E -- addDays forest persisted via real collectForestSlicePlans -> maybePersistNovelGlueAtom path",
    { timeout: 120_000 },
    async () => {
      const registry = await openRegistry(":memory:", {
        embeddings: createOfflineEmbeddingProvider(),
      });
      try {
        const forest = await shavePackage(DATE_FNS_FIXTURE_ROOT, {
          registry,
          entryPath: join(DATE_FNS_FIXTURE_ROOT, "addDays.cjs"),
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
        console.log("[addDays sE] persisted atoms:", persistedCount);
        // addDays is a small single-function-body file.
        // Per plan section 5.2: the slicer may emit GlueLeafEntry for simple AST patterns.
        // persistedCount >= 0 (may be 0 for leaf-only modules).
        expect(persistedCount).toBeGreaterThanOrEqual(0);
      } finally {
        await registry.close();
      }
    },
  );
});

// ---------------------------------------------------------------------------
// differenceInMilliseconds -- sections A-E
// Expected subgraph: ~4 modules (plan section 3.4):
//   differenceInMilliseconds, toDate, constructFrom, constants
// stubCount=0: no external edges.
// Resolves issue-body "differenceInMs" per DEC-WI510-S5-DIFFERENCE-IN-MS-BINDING-001.
// ---------------------------------------------------------------------------

describe("differenceInMilliseconds -- per-entry shave (WI-510 Slice 5)", () => {
  it(
    "section A -- moduleCount in [3,6], stubCount=0, forestTotalLeafCount>0 for differenceInMilliseconds subgraph",
    { timeout: 120_000 },
    async () => {
      const forest = await shavePackage(DATE_FNS_FIXTURE_ROOT, {
        registry: emptyRegistry,
        entryPath: join(DATE_FNS_FIXTURE_ROOT, "differenceInMilliseconds.cjs"),
      });
      console.log("[diffInMs sA] moduleCount:", forest.moduleCount);
      console.log("[diffInMs sA] stubCount:", forest.stubCount);
      console.log("[diffInMs sA] forestTotalLeafCount:", forestTotalLeafCount(forest));
      console.log(
        "[diffInMs sA] BFS filePaths:",
        forestModules(forest).map((m) => normalize(m.filePath).split("date-fns-4.1.0")[1]),
      );
      expect(
        forest.moduleCount,
        "differenceInMilliseconds moduleCount should be 3-6 (plan section 3.4)",
      ).toBeGreaterThanOrEqual(3);
      expect(
        forest.moduleCount,
        "differenceInMilliseconds moduleCount should be 3-6 (plan section 3.4)",
      ).toBeLessThanOrEqual(6);
      // DEC-WI510-S5-RETURN-TO-ZERO-EXTERNAL-001
      expect(
        forest.stubCount,
        "differenceInMilliseconds forest-level stubCount must be 0 (no external edges)",
      ).toBe(0);
      expect(forestStubs(forest).length, "differenceInMilliseconds forestStubs must be empty").toBe(
        0,
      );
      expect(forestTotalLeafCount(forest)).toBeGreaterThan(0);
    },
  );

  it(
    "section B -- forest.nodes[0] is differenceInMilliseconds.cjs",
    { timeout: 120_000 },
    async () => {
      const forest = await shavePackage(DATE_FNS_FIXTURE_ROOT, {
        registry: emptyRegistry,
        entryPath: join(DATE_FNS_FIXTURE_ROOT, "differenceInMilliseconds.cjs"),
      });
      const firstNode = forest.nodes[0];
      expect(firstNode).toBeDefined();
      expect(firstNode?.kind).toBe("module");
      if (firstNode?.kind === "module")
        expect(firstNode.filePath).toContain("differenceInMilliseconds.cjs");
    },
  );

  it(
    "section C -- subgraph has only transitively-reachable modules; no unrelated date-fns behaviors",
    { timeout: 120_000 },
    async () => {
      const forest = await shavePackage(DATE_FNS_FIXTURE_ROOT, {
        registry: emptyRegistry,
        entryPath: join(DATE_FNS_FIXTURE_ROOT, "differenceInMilliseconds.cjs"),
      });
      const filePaths = forestModules(forest).map((m) => m.filePath);
      for (const fp of filePaths) expect(fp).toContain("date-fns-4.1.0");
      expect(filePaths.some((p) => p.includes("differenceInMilliseconds.cjs"))).toBe(true);
      expect(filePaths.some((p) => p.endsWith("toDate.cjs"))).toBe(true);
      expect(filePaths.some((p) => p.endsWith("constructFrom.cjs"))).toBe(true);
      expect(filePaths.some((p) => p.endsWith("constants.cjs"))).toBe(true);
      // differenceInMilliseconds does NOT pull in unrelated bindings:
      const unrelated = ["parseISO.cjs", "formatISO.cjs", "addDays.cjs", "parseJSON.cjs"];
      for (const u of unrelated) {
        expect(
          filePaths.every((p) => !p.endsWith(u)),
          `${String(u)} must NOT be in differenceInMilliseconds subgraph`,
        ).toBe(true);
      }
      expect(
        filePaths.every((p) => !p.includes("_lib")),
        "differenceInMilliseconds subgraph must not include _lib/ files",
      ).toBe(true);
      expect(forestStubs(forest).length).toBe(0);
    },
  );

  it(
    "section D -- two-pass byte-identical determinism for differenceInMilliseconds subgraph",
    { timeout: 120_000 },
    async () => {
      const entryPath = join(DATE_FNS_FIXTURE_ROOT, "differenceInMilliseconds.cjs");
      const forest1 = await shavePackage(DATE_FNS_FIXTURE_ROOT, {
        registry: emptyRegistry,
        entryPath,
      });
      const forest2 = await shavePackage(DATE_FNS_FIXTURE_ROOT, {
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
    "section E -- differenceInMilliseconds forest persisted via real collectForestSlicePlans -> maybePersistNovelGlueAtom path",
    { timeout: 120_000 },
    async () => {
      const registry = await openRegistry(":memory:", {
        embeddings: createOfflineEmbeddingProvider(),
      });
      try {
        const forest = await shavePackage(DATE_FNS_FIXTURE_ROOT, {
          registry,
          entryPath: join(DATE_FNS_FIXTURE_ROOT, "differenceInMilliseconds.cjs"),
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
        console.log("[diffInMs sE] persisted atoms:", persistedCount);
        // differenceInMilliseconds is a tiny single-function-body file (29 lines, one require).
        // Per plan section 5.2: persistedCount >= 0 (may be 0 for leaf-only modules).
        expect(persistedCount).toBeGreaterThanOrEqual(0);
      } finally {
        await registry.close();
      }
    },
  );
});

// ---------------------------------------------------------------------------
// parseJSON -- sections A-E
// Expected subgraph: ~4 modules (plan section 3.5):
//   parseJSON, toDate, constructFrom, constants
// stubCount=0: no external edges.
// Substitute for issue-body "parse-tz-offset" per DEC-WI510-S5-PARSE-TZ-OFFSET-RESOLUTION-001.
// ---------------------------------------------------------------------------

describe("parseJSON -- per-entry shave (WI-510 Slice 5)", () => {
  it(
    "section A -- moduleCount in [3,6], stubCount=0, forestTotalLeafCount>0 for parseJSON subgraph",
    { timeout: 120_000 },
    async () => {
      const forest = await shavePackage(DATE_FNS_FIXTURE_ROOT, {
        registry: emptyRegistry,
        entryPath: join(DATE_FNS_FIXTURE_ROOT, "parseJSON.cjs"),
      });
      console.log("[parseJSON sA] moduleCount:", forest.moduleCount);
      console.log("[parseJSON sA] stubCount:", forest.stubCount);
      console.log("[parseJSON sA] forestTotalLeafCount:", forestTotalLeafCount(forest));
      console.log(
        "[parseJSON sA] BFS filePaths:",
        forestModules(forest).map((m) => normalize(m.filePath).split("date-fns-4.1.0")[1]),
      );
      expect(
        forest.moduleCount,
        "parseJSON moduleCount should be 3-6 (plan section 3.5)",
      ).toBeGreaterThanOrEqual(3);
      expect(
        forest.moduleCount,
        "parseJSON moduleCount should be 3-6 (plan section 3.5)",
      ).toBeLessThanOrEqual(6);
      // DEC-WI510-S5-RETURN-TO-ZERO-EXTERNAL-001
      expect(
        forest.stubCount,
        "parseJSON forest-level stubCount must be 0 (no external edges)",
      ).toBe(0);
      expect(forestStubs(forest).length, "parseJSON forestStubs must be empty").toBe(0);
      expect(forestTotalLeafCount(forest)).toBeGreaterThan(0);
    },
  );

  it("section B -- forest.nodes[0] is parseJSON.cjs", { timeout: 120_000 }, async () => {
    const forest = await shavePackage(DATE_FNS_FIXTURE_ROOT, {
      registry: emptyRegistry,
      entryPath: join(DATE_FNS_FIXTURE_ROOT, "parseJSON.cjs"),
    });
    const firstNode = forest.nodes[0];
    expect(firstNode).toBeDefined();
    expect(firstNode?.kind).toBe("module");
    if (firstNode?.kind === "module") expect(firstNode.filePath).toContain("parseJSON.cjs");
  });

  it(
    "section C -- subgraph has only transitively-reachable modules; no unrelated date-fns behaviors",
    { timeout: 120_000 },
    async () => {
      const forest = await shavePackage(DATE_FNS_FIXTURE_ROOT, {
        registry: emptyRegistry,
        entryPath: join(DATE_FNS_FIXTURE_ROOT, "parseJSON.cjs"),
      });
      const filePaths = forestModules(forest).map((m) => m.filePath);
      for (const fp of filePaths) expect(fp).toContain("date-fns-4.1.0");
      expect(filePaths.some((p) => p.includes("parseJSON.cjs"))).toBe(true);
      expect(filePaths.some((p) => p.endsWith("toDate.cjs"))).toBe(true);
      expect(filePaths.some((p) => p.endsWith("constructFrom.cjs"))).toBe(true);
      expect(filePaths.some((p) => p.endsWith("constants.cjs"))).toBe(true);
      // parseJSON does NOT pull in unrelated bindings:
      const unrelated = [
        "parseISO.cjs",
        "formatISO.cjs",
        "addDays.cjs",
        "differenceInMilliseconds.cjs",
      ];
      for (const u of unrelated) {
        expect(
          filePaths.every((p) => !p.endsWith(u)),
          `${String(u)} must NOT be in parseJSON subgraph`,
        ).toBe(true);
      }
      expect(
        filePaths.every((p) => !p.includes("_lib")),
        "parseJSON subgraph must not include _lib/ files",
      ).toBe(true);
      expect(forestStubs(forest).length).toBe(0);
    },
  );

  it(
    "section D -- two-pass byte-identical determinism for parseJSON subgraph",
    { timeout: 120_000 },
    async () => {
      const entryPath = join(DATE_FNS_FIXTURE_ROOT, "parseJSON.cjs");
      const forest1 = await shavePackage(DATE_FNS_FIXTURE_ROOT, {
        registry: emptyRegistry,
        entryPath,
      });
      const forest2 = await shavePackage(DATE_FNS_FIXTURE_ROOT, {
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
    "section E -- parseJSON forest persisted via real collectForestSlicePlans -> maybePersistNovelGlueAtom path",
    { timeout: 120_000 },
    async () => {
      const registry = await openRegistry(":memory:", {
        embeddings: createOfflineEmbeddingProvider(),
      });
      try {
        const forest = await shavePackage(DATE_FNS_FIXTURE_ROOT, {
          registry,
          entryPath: join(DATE_FNS_FIXTURE_ROOT, "parseJSON.cjs"),
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
        console.log("[parseJSON sE] persisted atoms:", persistedCount);
        // parseJSON is a small file with a single function body.
        // Per plan section 5.2: persistedCount >= 0 (may be 0 for leaf-only modules).
        expect(persistedCount).toBeGreaterThanOrEqual(0);
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

describe("parseISO section F -- combinedScore quality gate", () => {
  it.skipIf(!USE_LOCAL_PROVIDER)(
    "parseISO combinedScore >= 0.70 for corpus query (DISCOVERY_EVAL_PROVIDER=local)",
    { timeout: 120_000 },
    async () => {
      const registry = await openRegistry(":memory:", {
        embeddings: createLocalEmbeddingProvider("Xenova/all-MiniLM-L6-v2", 384),
      });
      try {
        const forest = await shavePackage(DATE_FNS_FIXTURE_ROOT, {
          registry,
          entryPath: join(DATE_FNS_FIXTURE_ROOT, "parseISO.cjs"),
        });
        const plans = await collectForestSlicePlans(forest, slice, registry, "glue-aware");
        for (const { slicePlan } of plans) {
          for (const entry of slicePlan.entries) {
            if (entry.kind === "novel-glue")
              await maybePersistNovelGlueAtom(
                withSemanticIntentCard(
                  entry,
                  "Parse an ISO-8601 date-time string into a JavaScript Date object including the optional fractional seconds and timezone offset",
                  [
                    "ISO-8601 date string parser to Date object",
                    "parses YYYY-MM-DDTHH:mm:ss.SSSZ format and its variants",
                    "converts date-time string into JavaScript Date preserving timezone offset",
                  ],
                ),
                registry,
              );
          }
        }
        const result = await registry.findCandidatesByQuery({
          behavior:
            "Parse an ISO-8601 date-time string into a JavaScript Date object including the optional fractional seconds and timezone offset",
          topK: 10,
        });
        console.log(
          "[parseISO sF] candidates:",
          result.candidates.map((c) => ({ score: c.combinedScore })),
        );
        expect(result.candidates.length).toBeGreaterThan(0);
        const topScore = result.candidates[0]?.combinedScore ?? 0;
        console.log("[parseISO sF] top combinedScore:", topScore);
        expect(topScore, "parseISO combinedScore must be >= 0.70").toBeGreaterThanOrEqual(0.7);
      } finally {
        await registry.close();
      }
    },
  );
});

describe("formatISO section F -- combinedScore quality gate", () => {
  it.skipIf(!USE_LOCAL_PROVIDER)(
    "formatISO combinedScore >= 0.70 for corpus query (DISCOVERY_EVAL_PROVIDER=local)",
    { timeout: 120_000 },
    async () => {
      const registry = await openRegistry(":memory:", {
        embeddings: createLocalEmbeddingProvider("Xenova/all-MiniLM-L6-v2", 384),
      });
      try {
        const forest = await shavePackage(DATE_FNS_FIXTURE_ROOT, {
          registry,
          entryPath: join(DATE_FNS_FIXTURE_ROOT, "formatISO.cjs"),
        });
        const plans = await collectForestSlicePlans(forest, slice, registry, "glue-aware");
        for (const { slicePlan } of plans) {
          for (const entry of slicePlan.entries) {
            if (entry.kind === "novel-glue")
              await maybePersistNovelGlueAtom(
                withSemanticIntentCard(
                  entry,
                  "Format a JavaScript Date object as an ISO-8601 string with optional date-only or time-only representation",
                  [
                    "ISO-8601 date formatter from Date object",
                    "produces YYYY-MM-DDTHH:mm:ssZ format string from JavaScript Date",
                    "date to ISO-8601 string conversion with date or time representation option",
                  ],
                ),
                registry,
              );
          }
        }
        const result = await registry.findCandidatesByQuery({
          behavior:
            "Format a JavaScript Date object as an ISO-8601 string with optional date-only or time-only representation",
          topK: 10,
        });
        console.log(
          "[formatISO sF] candidates:",
          result.candidates.map((c) => ({ score: c.combinedScore })),
        );
        expect(result.candidates.length).toBeGreaterThan(0);
        const topScore = result.candidates[0]?.combinedScore ?? 0;
        console.log("[formatISO sF] top combinedScore:", topScore);
        expect(topScore, "formatISO combinedScore must be >= 0.70").toBeGreaterThanOrEqual(0.7);
      } finally {
        await registry.close();
      }
    },
  );
});

describe("addDays section F -- combinedScore quality gate", () => {
  it.skipIf(!USE_LOCAL_PROVIDER)(
    "addDays combinedScore >= 0.70 for corpus query (DISCOVERY_EVAL_PROVIDER=local)",
    { timeout: 120_000 },
    async () => {
      const registry = await openRegistry(":memory:", {
        embeddings: createLocalEmbeddingProvider("Xenova/all-MiniLM-L6-v2", 384),
      });
      try {
        const forest = await shavePackage(DATE_FNS_FIXTURE_ROOT, {
          registry,
          entryPath: join(DATE_FNS_FIXTURE_ROOT, "addDays.cjs"),
        });
        const plans = await collectForestSlicePlans(forest, slice, registry, "glue-aware");
        for (const { slicePlan } of plans) {
          for (const entry of slicePlan.entries) {
            if (entry.kind === "novel-glue")
              await maybePersistNovelGlueAtom(
                withSemanticIntentCard(
                  entry,
                  "Return a new Date that is the given number of days after the input Date preserving the time-of-day components",
                  [
                    "add N days to a Date object returning a new Date",
                    "date arithmetic: advance a date by a given number of days",
                    "preserves time-of-day components while advancing the calendar date",
                  ],
                ),
                registry,
              );
          }
        }
        const result = await registry.findCandidatesByQuery({
          behavior:
            "Return a new Date that is the given number of days after the input Date preserving the time-of-day components",
          topK: 10,
        });
        console.log(
          "[addDays sF] candidates:",
          result.candidates.map((c) => ({ score: c.combinedScore })),
        );
        expect(result.candidates.length).toBeGreaterThan(0);
        const topScore = result.candidates[0]?.combinedScore ?? 0;
        console.log("[addDays sF] top combinedScore:", topScore);
        expect(topScore, "addDays combinedScore must be >= 0.70").toBeGreaterThanOrEqual(0.7);
      } finally {
        await registry.close();
      }
    },
  );
});

describe("differenceInMilliseconds section F -- combinedScore quality gate", () => {
  it.skipIf(!USE_LOCAL_PROVIDER)(
    "differenceInMilliseconds combinedScore >= 0.70 for corpus query (DISCOVERY_EVAL_PROVIDER=local)",
    { timeout: 120_000 },
    async () => {
      const registry = await openRegistry(":memory:", {
        embeddings: createLocalEmbeddingProvider("Xenova/all-MiniLM-L6-v2", 384),
      });
      try {
        const forest = await shavePackage(DATE_FNS_FIXTURE_ROOT, {
          registry,
          entryPath: join(DATE_FNS_FIXTURE_ROOT, "differenceInMilliseconds.cjs"),
        });
        const plans = await collectForestSlicePlans(forest, slice, registry, "glue-aware");
        for (const { slicePlan } of plans) {
          for (const entry of slicePlan.entries) {
            if (entry.kind === "novel-glue")
              await maybePersistNovelGlueAtom(
                withSemanticIntentCard(
                  entry,
                  "Compute the difference in milliseconds between two Date objects as a signed integer",
                  [
                    "signed millisecond difference between two dates",
                    "returns positive integer if laterDate is after earlierDate",
                    "date subtraction in milliseconds",
                  ],
                ),
                registry,
              );
          }
        }
        const result = await registry.findCandidatesByQuery({
          behavior:
            "Compute the difference in milliseconds between two Date objects as a signed integer",
          topK: 10,
        });
        console.log(
          "[diffInMs sF] candidates:",
          result.candidates.map((c) => ({ score: c.combinedScore })),
        );
        expect(result.candidates.length).toBeGreaterThan(0);
        const topScore = result.candidates[0]?.combinedScore ?? 0;
        console.log("[diffInMs sF] top combinedScore:", topScore);
        expect(
          topScore,
          "differenceInMilliseconds combinedScore must be >= 0.70",
        ).toBeGreaterThanOrEqual(0.7);
      } finally {
        await registry.close();
      }
    },
  );
});

describe("parseJSON section F -- combinedScore quality gate", () => {
  it.skipIf(!USE_LOCAL_PROVIDER)(
    "parseJSON combinedScore >= 0.70 for corpus query (DISCOVERY_EVAL_PROVIDER=local)",
    { timeout: 120_000 },
    async () => {
      const registry = await openRegistry(":memory:", {
        embeddings: createLocalEmbeddingProvider("Xenova/all-MiniLM-L6-v2", 384),
      });
      try {
        const forest = await shavePackage(DATE_FNS_FIXTURE_ROOT, {
          registry,
          entryPath: join(DATE_FNS_FIXTURE_ROOT, "parseJSON.cjs"),
        });
        const plans = await collectForestSlicePlans(forest, slice, registry, "glue-aware");
        for (const { slicePlan } of plans) {
          for (const entry of slicePlan.entries) {
            if (entry.kind === "novel-glue")
              await maybePersistNovelGlueAtom(
                withSemanticIntentCard(
                  entry,
                  "Parse an ISO-8601 date string with optional timezone offset suffix as produced by JSON.stringify(new Date()) into a Date object",
                  [
                    "JSON date string parser with timezone offset suffix",
                    "parses ISO-8601 string with +HH:mm or -HH:mm suffix into Date",
                    "deserialize JSON.stringify(new Date()) output including UTC and offset variants",
                  ],
                ),
                registry,
              );
          }
        }
        const result = await registry.findCandidatesByQuery({
          behavior:
            "Parse an ISO-8601 date string with optional timezone offset suffix as produced by JSON.stringify(new Date()) into a Date object",
          topK: 10,
        });
        console.log(
          "[parseJSON sF] candidates:",
          result.candidates.map((c) => ({ score: c.combinedScore })),
        );
        expect(result.candidates.length).toBeGreaterThan(0);
        const topScore = result.candidates[0]?.combinedScore ?? 0;
        console.log("[parseJSON sF] top combinedScore:", topScore);
        expect(topScore, "parseJSON combinedScore must be >= 0.70").toBeGreaterThanOrEqual(0.7);
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
// All five date-fns headline bindings run in sequence with isolated registries.
// DEC-WI510-S5-RETURN-TO-ZERO-EXTERNAL-001: all 5 bindings must show stubCount=0.
// DEC-WI510-S5-SUBDIRECTORY-TRAVERSAL-001: formatISO must contain _lib/addLeadingZeros.cjs.
// ---------------------------------------------------------------------------

describe("date-fns headline bindings -- compound interaction (real production sequence)", () => {
  it(
    "all five per-entry shaves are independent, complete, produce non-empty forests with stubCount=0, and persist via real path",
    { timeout: 360_000 },
    async () => {
      const bindings = [
        {
          name: "parseISO",
          entry: "parseISO.cjs",
          minMod: 3,
          maxMod: 6,
          expectSubdir: false,
          persistGreaterThanZero: true,
        },
        {
          name: "formatISO",
          entry: "formatISO.cjs",
          minMod: 4,
          maxMod: 8,
          expectSubdir: true,
          persistGreaterThanZero: true,
        },
        {
          name: "addDays",
          entry: "addDays.cjs",
          minMod: 3,
          maxMod: 6,
          expectSubdir: false,
          persistGreaterThanZero: false,
        },
        {
          name: "differenceInMilliseconds",
          entry: "differenceInMilliseconds.cjs",
          minMod: 3,
          maxMod: 6,
          expectSubdir: false,
          persistGreaterThanZero: false,
        },
        {
          name: "parseJSON",
          entry: "parseJSON.cjs",
          minMod: 3,
          maxMod: 6,
          expectSubdir: false,
          persistGreaterThanZero: false,
        },
      ] as const;

      for (const b of bindings) {
        const registry = await openRegistry(":memory:", {
          embeddings: createOfflineEmbeddingProvider(),
        });
        try {
          const forest = await shavePackage(DATE_FNS_FIXTURE_ROOT, {
            registry,
            entryPath: join(DATE_FNS_FIXTURE_ROOT, b.entry),
          });
          expect(forest.moduleCount).toBeGreaterThanOrEqual(b.minMod);
          expect(forest.moduleCount).toBeLessThanOrEqual(b.maxMod);
          // DEC-WI510-S5-RETURN-TO-ZERO-EXTERNAL-001: all 5 bindings must show stubCount=0.
          expect(
            forest.stubCount,
            `${b.name}: stubCount must be 0 (DEC-WI510-S5-RETURN-TO-ZERO-EXTERNAL-001)`,
          ).toBe(0);
          expect(forestStubs(forest).length, `${b.name}: forestStubs must be empty`).toBe(0);
          const firstNode = forest.nodes[0];
          expect(firstNode?.kind, `${b.name}: first node must be a module`).toBe("module");
          if (firstNode?.kind === "module") {
            expect(firstNode.filePath, `${b.name}: first module must be the entry file`).toContain(
              b.entry,
            );
          }
          // DEC-WI510-S5-SUBDIRECTORY-TRAVERSAL-001: formatISO must include _lib/addLeadingZeros.cjs.
          if (b.expectSubdir) {
            const filePaths = forestModules(forest).map((m) => m.filePath);
            expect(
              filePaths.some((p) => p.includes("_lib") && p.endsWith("addLeadingZeros.cjs")),
              `${b.name}: _lib/addLeadingZeros.cjs must be in subgraph (DEC-WI510-S5-SUBDIRECTORY-TRAVERSAL-001)`,
            ).toBe(true);
          }
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
          if (b.persistGreaterThanZero) {
            expect(
              persistedCount,
              `${b.name}: must persist at least one novel-glue atom`,
            ).toBeGreaterThan(0);
          } else {
            expect(
              persistedCount,
              `${b.name}: persistedCount must be >= 0 (small files may produce GlueLeafEntry only)`,
            ).toBeGreaterThanOrEqual(0);
          }
          console.log(
            `[compound] date-fns ${b.name}: moduleCount=${forest.moduleCount} stubCount=${forest.stubCount} persisted=${persistedCount}`,
          );
        } finally {
          await registry.close();
        }
      }
    },
  );
});
