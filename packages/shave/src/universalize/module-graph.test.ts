// SPDX-License-Identifier: MIT
/**
 * Tests for the module-resolution-aware recursion engine (WI-510 Slice 1).
 *
 * @decision DEC-WI510-ENGINE-ORCHESTRATION-LAYER-001
 * @decision DEC-WI510-RECURSION-SCOPE-B-001
 * @decision DEC-WI510-FOREST-CONNECTED-NOT-NESTED-001
 * @decision DEC-WI510-BEST-EFFORT-MODULE-DEGRADATION-001
 * @decision DEC-WI510-MS-FIXTURE-FIRST-001
 *
 * Production sequence:
 *   shavePackage(packageRoot, { registry }) →
 *     resolvePackageEntry() → BFS of in-package edges →
 *     decompose() per module → ModuleForest
 *
 * Real production trigger: shavePackage() is called by the corpus-ingestion
 * pipeline when a new npm package target is named. The forest flows to
 * collectForestSlicePlans() → storeBlock() to persist atoms.
 *
 * Test scope covers §6.1 of the Evaluation Contract:
 *   - Module resolver (relative, main, exports, index, unresolvable)
 *   - Cycle guard (circular import terminates, finite forest)
 *   - Connected forest (3-module graph, cross-module peer-addressability)
 *   - Determinism (two-pass byte-identical on ms fixture)
 *   - Best-effort degradation (unresolvable edge → stub, rest still shaves)
 *   - ms fixture end-to-end (connected forest of granular behavior atoms)
 *   - B-scope predicate (external edges stay ForeignLeafEntry, internal followed)
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import {
  canonicalAstHash as computeCanonicalAstHash,
  createLocalEmbeddingProvider,
  createOfflineEmbeddingProvider,
} from "@yakcc/contracts";
import type { BlockMerkleRoot, CanonicalAstHash } from "@yakcc/contracts";
import { openRegistry } from "@yakcc/registry";
import type { BlockTripletRow } from "@yakcc/registry";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildTriplet } from "../persist/triplet.js";
import type { ShaveRegistryView } from "../types.js";
import {
  collectForestSlicePlans,
  forestModules,
  forestStubs,
  forestTotalLeafCount,
  shavePackage,
} from "./module-graph.js";
import {
  UNRESOLVABLE,
  extractImportSpecifiers,
  extractRequireSpecifiers,
  isInPackageBoundary,
  probeFile,
  probeIndex,
  readPackageJson,
  resolveExportValue,
  resolveFromExports,
  resolveModuleEdge,
  resolvePackageEntry,
} from "./module-resolver.js";
import { slice } from "./slicer.js";

// ---------------------------------------------------------------------------
// Provider flag for combinedScore quality test (§6.6 #5)
// ---------------------------------------------------------------------------

/**
 * Whether to use the local semantic embedding provider for quality tests.
 * Set DISCOVERY_EVAL_PROVIDER=local to enable. Without this, the combinedScore
 * quality test is skipped (offline BLAKE3 provider produces non-semantic vectors;
 * KNN scores are degenerate and do not meet the >= 0.70 threshold).
 *
 * @decision DEC-WI510-ENGINE-ORCHESTRATION-LAYER-001
 * Per §6.6 #5 of the Evaluation Contract: if the local provider is absent so
 * the quality block skips, the slice is BLOCKED, not ready. This flag controls
 * that skip gate explicitly rather than silently passing with a degenerate score.
 */
const USE_LOCAL_PROVIDER = process.env.DISCOVERY_EVAL_PROVIDER === "local";

// ---------------------------------------------------------------------------
// §10: combinedScore quality gate (§6.6 #5)
// ---------------------------------------------------------------------------

/**
 * Verifies that a real ms parse() atom achieves combinedScore >= 0.70 when
 * queried with the corpus behavioral description. This test requires the local
 * semantic embedding provider (Xenova/all-MiniLM-L6-v2, 384-dim); the offline
 * BLAKE3 provider produces non-semantic vectors that cannot meet this threshold.
 *
 * Guard: DISCOVERY_EVAL_PROVIDER=local must be set. Without it this test skips,
 * and per §6.6 #5 the slice is BLOCKED (not ready) until a reviewer confirms
 * the local provider run.
 *
 * @decision DEC-WI510-ENGINE-ORCHESTRATION-LAYER-001
 * @decision DEC-WI510-MS-FIXTURE-FIRST-001
 */
describe("shavePackage — combinedScore quality gate (§6.6 #5, DISCOVERY_EVAL_PROVIDER=local)", () => {
  it.skipIf(!USE_LOCAL_PROVIDER)(
    "ms parse() atom achieves combinedScore >= 0.70 for the corpus query (local semantic embedder)",
    { timeout: 120_000 },
    async () => {
      const pkgRoot = join(FIXTURES_DIR, "ms-2.1.3");
      const forest = await shavePackage(pkgRoot, { registry: emptyRegistry });
      expect(forest.moduleCount).toBeGreaterThan(0);

      // Get the entry module source
      const entryMod = forestModules(forest)[0];
      expect(entryMod).toBeDefined();
      if (entryMod === undefined) {
        throw new Error("expected entry module for ms fixture");
      }
      const msSource = entryMod.tree.root.source ?? "";
      expect(msSource.length).toBeGreaterThan(0);

      // Compute canonical AST hash of the source
      const astHash = computeCanonicalAstHash(msSource) as CanonicalAstHash;

      // Build a synthetic IntentCard representing the ms parse() behavior
      const msParseIntentCard = {
        schemaVersion: 1 as const,
        behavior:
          "Parse a human-readable duration string (e.g. '2 days', '1h', '30m') into its" +
          " equivalent number of milliseconds. Also formats milliseconds into a human-readable string.",
        inputs: [
          {
            name: "str",
            type: "string",
            description: "Duration string like '2 days', '1h', or '500'",
            optional: false,
          },
        ],
        outputs: [
          {
            name: "result",
            type: "number | string",
            description: "Milliseconds as a number, or formatted string if no precision given",
            optional: false,
          },
        ],
        preconditions: [],
        postconditions: [],
        notes: [
          "Returns undefined for invalid input",
          "Supports short form (1h) and long form (1 hour)",
        ],
        modelVersion: "test-synthetic",
        promptVersion: "wi510-quality-test-v1",
        sourceHash: astHash,
        extractedAt: new Date().toISOString(),
      };

      // Build the triplet (bootstrap path: no corpus extraction needed for this test)
      const triplet = buildTriplet(msParseIntentCard, msSource, astHash, undefined, {
        bootstrap: true,
      });

      // Open an in-memory registry with the local semantic embedding provider
      const embeddingProvider = createLocalEmbeddingProvider("Xenova/all-MiniLM-L6-v2", 384);
      const registry = await openRegistry(":memory:", { embeddings: embeddingProvider });

      try {
        // Store the triplet
        const row: BlockTripletRow = {
          blockMerkleRoot: triplet.merkleRoot,
          specHash: triplet.specHash,
          specCanonicalBytes: triplet.specCanonicalBytes,
          implSource: triplet.impl,
          proofManifestJson: JSON.stringify(triplet.manifest),
          level: "L0",
          createdAt: Date.now(),
          canonicalAstHash: astHash,
          parentBlockRoot: null,
          artifacts: triplet.artifacts as Map<string, Uint8Array>,
          kind: "local",
          foreignPkg: null,
          foreignExport: null,
          foreignDtsHash: null,
        };
        await registry.storeBlock(row);

        // Query with the corpus behavior description (from corpus.json cat1-ms-duration-parse-001)
        const corpusQuery =
          "Parse a human-readable duration string such as '2 days' or '1h' into a number of milliseconds";
        const result = await registry.findCandidatesByQuery({ behavior: corpusQuery, topK: 10 });

        // Evidence for reviewer: log the actual scores
        console.log(
          "[§10 quality gate] candidates:",
          result.candidates.map((c) => ({ score: c.combinedScore, rank: c.rank })),
        );

        expect(result.candidates.length).toBeGreaterThan(0);
        const topScore = result.candidates[0]?.combinedScore ?? 0;
        console.log("[§10 quality gate] top combinedScore:", topScore);
        expect(topScore).toBeGreaterThanOrEqual(0.7);
      } finally {
        await registry.close();
      }
    },
  );
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FIXTURES_DIR = join(fileURLToPath(new URL("../__fixtures__/module-graph", import.meta.url)));

/** Registry with no matches — all nodes will become NovelGlueEntry. */
const emptyRegistry: Pick<ShaveRegistryView, "findByCanonicalAstHash"> = {
  findByCanonicalAstHash: async () => [],
};

// ---------------------------------------------------------------------------
// §1: Module resolver unit tests
// ---------------------------------------------------------------------------

describe("module-resolver — probeFile", () => {
  it("returns the path when the file exists", () => {
    const p = join(FIXTURES_DIR, "three-module-pkg/index.js");
    expect(probeFile(p)).toBe(normalize(p));
  });

  it("returns undefined when the file does not exist", () => {
    expect(probeFile(join(FIXTURES_DIR, "three-module-pkg/does-not-exist.js"))).toBeUndefined();
  });

  it("probes .js extension when no extension given", () => {
    const base = join(FIXTURES_DIR, "three-module-pkg/index");
    const result = probeFile(base);
    expect(result).toBeDefined();
    expect(result).toContain("index.js");
  });
});

describe("module-resolver — probeIndex", () => {
  it("finds index.js in a directory", () => {
    const dir = join(FIXTURES_DIR, "three-module-pkg");
    const result = probeIndex(dir);
    expect(result).toBeDefined();
    expect(result).toContain("index.js");
  });

  it("returns undefined for a directory with no index file", () => {
    const dir = join(FIXTURES_DIR, "three-module-pkg/lib");
    // lib/ has parse.js and format.js but no index.js
    expect(probeIndex(dir)).toBeUndefined();
  });
});

describe("module-resolver — readPackageJson", () => {
  it("parses a valid package.json", () => {
    const pkgPath = join(FIXTURES_DIR, "three-module-pkg/package.json");
    const result = readPackageJson(pkgPath);
    expect(result).toBeDefined();
    expect(result?.name).toBe("three-module-pkg");
    expect(result?.main).toBe("./index.js");
  });

  it("returns undefined for a non-existent path", () => {
    expect(readPackageJson(join(FIXTURES_DIR, "no-such/package.json"))).toBeUndefined();
  });
});

describe("module-resolver — resolveFromExports", () => {
  it("resolves string exports value for sub-path '.'", () => {
    const pkgRoot = join(FIXTURES_DIR, "three-module-pkg");
    const result = resolveFromExports("./index.js", ".", pkgRoot);
    expect(result).toBeDefined();
    expect(result).toContain("index.js");
  });

  it("returns undefined for string exports when sub-path is not '.'", () => {
    const pkgRoot = join(FIXTURES_DIR, "three-module-pkg");
    expect(resolveFromExports("./index.js", "./other", pkgRoot)).toBeUndefined();
  });

  it("resolves conditional exports map (node condition)", () => {
    const pkgRoot = join(FIXTURES_DIR, "three-module-pkg");
    const exportsMap = { node: "./index.js", default: "./index.js" };
    const result = resolveFromExports(exportsMap, ".", pkgRoot);
    expect(result).toBeDefined();
  });
});

describe("module-resolver — resolveExportValue", () => {
  it("resolves a string value to a file path", () => {
    const pkgRoot = join(FIXTURES_DIR, "three-module-pkg");
    const result = resolveExportValue("./index.js", pkgRoot);
    expect(result).toBeDefined();
    expect(result).toContain("index.js");
  });

  it("resolves nested conditional map with 'default' condition", () => {
    const pkgRoot = join(FIXTURES_DIR, "three-module-pkg");
    const result = resolveExportValue({ default: "./index.js" }, pkgRoot);
    expect(result).toBeDefined();
  });

  it("returns undefined for non-string, non-object value", () => {
    const pkgRoot = join(FIXTURES_DIR, "three-module-pkg");
    expect(resolveExportValue(null, pkgRoot)).toBeUndefined();
    expect(resolveExportValue(42, pkgRoot)).toBeUndefined();
  });
});

describe("module-resolver — resolvePackageEntry (package.json#main)", () => {
  it("resolves the entry for three-module-pkg via package.json#main", () => {
    const pkgRoot = join(FIXTURES_DIR, "three-module-pkg");
    const result = resolvePackageEntry(pkgRoot);
    expect(result).not.toBe(UNRESOLVABLE);
    expect(String(result)).toContain("index.js");
  });

  it("resolves the entry for ms-2.1.3 via package.json#main", () => {
    const pkgRoot = join(FIXTURES_DIR, "ms-2.1.3");
    const result = resolvePackageEntry(pkgRoot);
    expect(result).not.toBe(UNRESOLVABLE);
    expect(String(result)).toContain("index.js");
  });

  it("returns UNRESOLVABLE for a directory with no package.json", () => {
    const result = resolvePackageEntry(join(FIXTURES_DIR, "three-module-pkg/lib"));
    expect(result).toBe(UNRESOLVABLE);
  });
});

describe("module-resolver — resolvePackageEntry (index fallback)", () => {
  let tmpDir: string;

  beforeAll(() => {
    // Create a temporary package with no package.json#main but with an index.js
    tmpDir = join(FIXTURES_DIR, "_tmp_index_fallback");
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(join(tmpDir, "package.json"), JSON.stringify({ name: "index-fallback-pkg" }));
    writeFileSync(join(tmpDir, "index.js"), "module.exports = {};");
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("resolves via index.js when package.json#main is absent", () => {
    const result = resolvePackageEntry(tmpDir);
    expect(result).not.toBe(UNRESOLVABLE);
    expect(String(result)).toContain("index.js");
  });
});

describe("module-resolver — resolveModuleEdge (relative specifiers)", () => {
  const pkgRoot = join(FIXTURES_DIR, "three-module-pkg");
  const importerDir = pkgRoot;

  it("resolves ./lib/parse to parse.js", () => {
    const result = resolveModuleEdge("./lib/parse", importerDir, pkgRoot);
    expect(result).not.toBe(UNRESOLVABLE);
    expect(String(result)).toContain("parse.js");
  });

  it("resolves ./lib/format to format.js", () => {
    const result = resolveModuleEdge("./lib/format", importerDir, pkgRoot);
    expect(result).not.toBe(UNRESOLVABLE);
    expect(String(result)).toContain("format.js");
  });

  it("returns UNRESOLVABLE for a non-existent relative path", () => {
    const result = resolveModuleEdge("./lib/does-not-exist", importerDir, pkgRoot);
    expect(result).toBe(UNRESOLVABLE);
  });
});

describe("module-resolver — resolveModuleEdge (package self-reference)", () => {
  it("resolves package self-reference (name == specifier) via package.json#main", () => {
    const pkgRoot = join(FIXTURES_DIR, "three-module-pkg");
    const result = resolveModuleEdge("three-module-pkg", pkgRoot, pkgRoot);
    expect(result).not.toBe(UNRESOLVABLE);
    expect(String(result)).toContain("index.js");
  });

  it("returns UNRESOLVABLE for external package name (not this package's name)", () => {
    const pkgRoot = join(FIXTURES_DIR, "three-module-pkg");
    const result = resolveModuleEdge("some-external-pkg", pkgRoot, pkgRoot);
    expect(result).toBe(UNRESOLVABLE);
  });
});

describe("module-resolver — unresolvable specifier does NOT throw", () => {
  it("returns UNRESOLVABLE sentinel (not throws) for truly unresolvable specifier", () => {
    const pkgRoot = join(FIXTURES_DIR, "three-module-pkg");
    // Should return sentinel, never throw
    expect(() => resolveModuleEdge("totally-fake-pkg", pkgRoot, pkgRoot)).not.toThrow();
    expect(resolveModuleEdge("totally-fake-pkg", pkgRoot, pkgRoot)).toBe(UNRESOLVABLE);
  });
});

// ---------------------------------------------------------------------------
// §2: B-scope predicate unit tests
// ---------------------------------------------------------------------------

describe("isInPackageBoundary — B-scope predicate", () => {
  it("returns true for a path inside the package root", () => {
    const root = "/pkg/root";
    expect(isInPackageBoundary("/pkg/root/lib/foo.js", root)).toBe(true);
    expect(isInPackageBoundary("/pkg/root/index.js", root)).toBe(true);
  });

  it("returns false for a path outside the package root", () => {
    const root = "/pkg/root";
    expect(isInPackageBoundary("/other/lib/foo.js", root)).toBe(false);
  });

  it("returns false for a path that is a prefix sibling (anti-collision)", () => {
    const root = "/pkg/root";
    // /pkg/root-extra/foo.js must NOT be considered inside /pkg/root/
    expect(isInPackageBoundary("/pkg/root-extra/foo.js", root)).toBe(false);
  });

  it("returns true for the root itself (edge case)", () => {
    const root = "/pkg/root";
    expect(isInPackageBoundary("/pkg/root/", root)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// §3: Specifier extraction unit tests
// ---------------------------------------------------------------------------

describe("extractRequireSpecifiers", () => {
  it("extracts require() specifiers from CJS source", () => {
    const src = "var a = require('./lib/a');\nvar b = require('external-pkg');\n";
    const result = extractRequireSpecifiers(src, "index.js");
    expect(result).toContain("./lib/a");
    expect(result).toContain("external-pkg");
    expect(result).toHaveLength(2);
  });

  it("returns empty array for source with no require() calls", () => {
    const src = "function foo(x) { return x + 1; }\nmodule.exports = { foo };\n";
    expect(extractRequireSpecifiers(src, "index.js")).toHaveLength(0);
  });

  it("returns sorted array for determinism", () => {
    const src = `require('z-pkg'); require('a-pkg'); require('./b');`;
    const result = extractRequireSpecifiers(src, "index.js");
    expect([...result]).toEqual([...result].sort());
  });

  it("does not throw on unparseable source", () => {
    expect(() => extractRequireSpecifiers("{{{{invalid{{{{", "bad.js")).not.toThrow();
    // Best-effort: may return empty array
    const result = extractRequireSpecifiers("{{{{invalid{{{{", "bad.js");
    expect(Array.isArray(result)).toBe(true);
  });
});

describe("extractImportSpecifiers", () => {
  it("extracts ESM import specifiers from TypeScript source", () => {
    const src = `import { x } from './lib/x';\nimport y from 'external';\n`;
    const result = extractImportSpecifiers(src, "index.ts");
    expect(result).toContain("./lib/x");
    expect(result).toContain("external");
  });

  it("excludes type-only imports", () => {
    const src = `import type { Foo } from './foo';\nimport { bar } from './bar';\n`;
    const result = extractImportSpecifiers(src, "index.ts");
    expect(result).not.toContain("./foo");
    expect(result).toContain("./bar");
  });

  it("returns sorted array for determinism", () => {
    const src = `import z from 'z'; import a from 'a'; import b from './b';`;
    const result = extractImportSpecifiers(src, "index.ts");
    expect([...result]).toEqual([...result].sort());
  });
});

// ---------------------------------------------------------------------------
// §4: Cycle guard tests
// ---------------------------------------------------------------------------

describe("shavePackage — cycle guard (circular import terminates)", () => {
  it("terminates and produces a finite forest for a circular import (a.js → b.js → a.js)", async () => {
    const pkgRoot = join(FIXTURES_DIR, "circular-pkg");
    const forest = await shavePackage(pkgRoot, { registry: emptyRegistry });

    // Must terminate (this test completes) — if it didn't, the test would hang.
    // The forest must have exactly 2 successfully-decomposed modules (a.js and b.js),
    // since the visited-set prevents re-visiting a.js when b.js requires it.
    const modules = forestModules(forest);
    expect(modules.length).toBe(2);

    // Both a.js and b.js must be present
    const filePaths = modules.map((m) => m.filePath);
    expect(filePaths.some((p) => p.includes("a.js"))).toBe(true);
    expect(filePaths.some((p) => p.includes("b.js"))).toBe(true);
  });

  it("cycle guard: visited-set prevents re-descent — no duplicate file paths in forest", async () => {
    const pkgRoot = join(FIXTURES_DIR, "circular-pkg");
    const forest = await shavePackage(pkgRoot, { registry: emptyRegistry });

    const modules = forestModules(forest);
    const filePaths = modules.map((m) => m.filePath);
    const uniquePaths = new Set(filePaths);
    expect(filePaths.length).toBe(uniquePaths.size);
  });
});

// ---------------------------------------------------------------------------
// §5: Connected forest tests
// ---------------------------------------------------------------------------

describe("shavePackage — connected forest (three-module-pkg)", () => {
  it("produces a forest with all 3 modules (index, parse, format)", async () => {
    const pkgRoot = join(FIXTURES_DIR, "three-module-pkg");
    const forest = await shavePackage(pkgRoot, { registry: emptyRegistry });

    const modules = forestModules(forest);
    expect(modules.length).toBe(3);
    expect(forest.moduleCount).toBe(3);
    expect(forest.stubCount).toBe(0);
  });

  it("entry path is the resolved package entry point (index.js)", async () => {
    const pkgRoot = join(FIXTURES_DIR, "three-module-pkg");
    const forest = await shavePackage(pkgRoot, { registry: emptyRegistry });

    expect(forest.entryPath).toContain("index.js");
  });

  it("in-package edges are recorded on the entry module (index.js has edges to parse and format)", async () => {
    const pkgRoot = join(FIXTURES_DIR, "three-module-pkg");
    const forest = await shavePackage(pkgRoot, { registry: emptyRegistry });

    const entryNode = forestModules(forest).find((m) => m.filePath.includes("index.js"));
    expect(entryNode).toBeDefined();
    if (entryNode === undefined) {
      throw new Error("expected entry module node for three-module-pkg");
    }
    expect(entryNode.inPackageEdges.length).toBe(2);
    expect(entryNode.inPackageEdges.some((e) => e.includes("parse.js"))).toBe(true);
    expect(entryNode.inPackageEdges.some((e) => e.includes("format.js"))).toBe(true);
  });

  it("leaf modules (parse.js, format.js) have no in-package edges", async () => {
    const pkgRoot = join(FIXTURES_DIR, "three-module-pkg");
    const forest = await shavePackage(pkgRoot, { registry: emptyRegistry });

    const parse = forestModules(forest).find((m) => m.filePath.includes("parse.js"));
    const format = forestModules(forest).find((m) => m.filePath.includes("format.js"));
    expect(parse).toBeDefined();
    expect(format).toBeDefined();
    if (parse === undefined || format === undefined) {
      throw new Error("expected parse.js and format.js module nodes");
    }
    expect(parse.inPackageEdges.length).toBe(0);
    expect(format.inPackageEdges.length).toBe(0);
  });

  it("every module node has a non-empty RecursionTree with at least one leaf", async () => {
    const pkgRoot = join(FIXTURES_DIR, "three-module-pkg");
    const forest = await shavePackage(pkgRoot, { registry: emptyRegistry });

    for (const mod of forestModules(forest)) {
      expect(mod.tree.leafCount).toBeGreaterThan(0);
    }
  });

  it("total leaf count > 0 across the forest (independently addressable atoms)", async () => {
    const pkgRoot = join(FIXTURES_DIR, "three-module-pkg");
    const forest = await shavePackage(pkgRoot, { registry: emptyRegistry });

    expect(forestTotalLeafCount(forest)).toBeGreaterThan(0);
  });

  it("cross-module peer-addressability: module B node is a peer in the same forest as module A", async () => {
    const pkgRoot = join(FIXTURES_DIR, "three-module-pkg");
    const forest = await shavePackage(pkgRoot, { registry: emptyRegistry });

    const modules = forestModules(forest);
    // All three modules are peers in the same forest — same nodes[] array
    expect(modules.some((m) => m.filePath.includes("index.js"))).toBe(true);
    expect(modules.some((m) => m.filePath.includes("parse.js"))).toBe(true);
    expect(modules.some((m) => m.filePath.includes("format.js"))).toBe(true);
    // The forest is one structure — not N disconnected trees
    expect(forest.nodes.length).toBe(3);
  });

  it("collectForestSlicePlans emits a slice plan for each module", async () => {
    const pkgRoot = join(FIXTURES_DIR, "three-module-pkg");
    const forest = await shavePackage(pkgRoot, { registry: emptyRegistry });

    const plans = await collectForestSlicePlans(forest, slice, emptyRegistry, "glue-aware");
    expect(plans.length).toBe(3);
    for (const { filePath, slicePlan } of plans) {
      expect(filePath).toBeTruthy();
      expect(slicePlan.entries.length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// §6: Best-effort degradation tests
// ---------------------------------------------------------------------------

describe("shavePackage — best-effort degradation (unresolvable edge)", () => {
  it("still produces modules for the resolvable portion when one edge is unresolvable", async () => {
    const pkgRoot = join(FIXTURES_DIR, "degradation-pkg");
    const forest = await shavePackage(pkgRoot, { registry: emptyRegistry });

    // index.js + helper.js should both be in the forest.
    // some-external-pkg is unresolvable → goes to externalSpecifiers, NOT a stub
    const modules = forestModules(forest);
    expect(modules.length).toBe(2);
    expect(modules.some((m) => m.filePath.includes("index.js"))).toBe(true);
    expect(modules.some((m) => m.filePath.includes("helper.js"))).toBe(true);
  });

  it("external specifier appears in externalSpecifiers (not as a stub)", async () => {
    const pkgRoot = join(FIXTURES_DIR, "degradation-pkg");
    const forest = await shavePackage(pkgRoot, { registry: emptyRegistry });

    const entryMod = forestModules(forest).find((m) => m.filePath.includes("index.js"));
    expect(entryMod).toBeDefined();
    if (entryMod === undefined) {
      throw new Error("expected entry module node for degradation-pkg");
    }
    expect(entryMod.externalSpecifiers).toContain("some-external-pkg");
  });

  it("forest does NOT fail wholesale — shave result is partial-but-useful, not empty", async () => {
    const pkgRoot = join(FIXTURES_DIR, "degradation-pkg");
    const forest = await shavePackage(pkgRoot, { registry: emptyRegistry });

    expect(forest.moduleCount).toBeGreaterThan(0);
    expect(forestTotalLeafCount(forest)).toBeGreaterThan(0);
  });

  it("returns a stub for a package whose entry cannot be resolved", async () => {
    // Use a temp dir with no package.json
    const tmpDir = join(FIXTURES_DIR, "_tmp_empty_pkg");
    mkdirSync(tmpDir, { recursive: true });
    try {
      const forest = await shavePackage(tmpDir, { registry: emptyRegistry });
      expect(forest.stubCount).toBeGreaterThan(0);
      expect(forest.moduleCount).toBe(0);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// §7: Two-pass determinism test
// ---------------------------------------------------------------------------

describe("shavePackage — two-pass determinism (ms fixture)", () => {
  it(
    "two passes over ms produce byte-identical forest structure (moduleCount, leafCount, filePaths)",
    { timeout: 30000 },
    async () => {
      const pkgRoot = join(FIXTURES_DIR, "ms-2.1.3");

      // Run twice
      const forest1 = await shavePackage(pkgRoot, { registry: emptyRegistry });
      const forest2 = await shavePackage(pkgRoot, { registry: emptyRegistry });

      // Structural determinism
      expect(forest1.moduleCount).toBe(forest2.moduleCount);
      expect(forest1.stubCount).toBe(forest2.stubCount);
      expect(forestTotalLeafCount(forest1)).toBe(forestTotalLeafCount(forest2));

      // Same entry path
      expect(forest1.entryPath).toBe(forest2.entryPath);

      // Same BFS order of file paths
      const paths1 = forestModules(forest1).map((m) => m.filePath);
      const paths2 = forestModules(forest2).map((m) => m.filePath);
      expect(paths1).toEqual(paths2);

      // Same canonicalAstHash for each leaf — byte-identical atom identity
      const hashes1 = forestModules(forest1)
        .flatMap((m) => collectLeafHashes(m.tree.root))
        .sort();
      const hashes2 = forestModules(forest2)
        .flatMap((m) => collectLeafHashes(m.tree.root))
        .sort();
      expect(hashes1).toEqual(hashes2);
    },
  );
});

// ---------------------------------------------------------------------------
// §8: ms fixture end-to-end test
// ---------------------------------------------------------------------------

describe("shavePackage — ms fixture end-to-end (DEC-WI510-MS-FIXTURE-FIRST-001)", () => {
  it("produces a non-empty connected forest from ms/index.js", { timeout: 30000 }, async () => {
    const pkgRoot = join(FIXTURES_DIR, "ms-2.1.3");
    const forest = await shavePackage(pkgRoot, { registry: emptyRegistry });

    // ms is a single-file package — exactly 1 module
    expect(forest.moduleCount).toBe(1);
    expect(forest.stubCount).toBe(0);
  });

  it(
    "ms forest is not ForeignLeafEntry-dominated — leafCount > 0",
    { timeout: 30000 },
    async () => {
      const pkgRoot = join(FIXTURES_DIR, "ms-2.1.3");
      const forest = await shavePackage(pkgRoot, { registry: emptyRegistry });

      // ms has no foreign imports at all (pure JS, no require() of external deps)
      // All nodes should decompose to behavior atoms, not foreign leaves
      expect(forestTotalLeafCount(forest)).toBeGreaterThan(0);

      // Verify the forest produces granular atoms via the slicer
      const plans = await collectForestSlicePlans(forest, slice, emptyRegistry, "glue-aware");
      expect(plans.length).toBe(1);

      const { slicePlan } = plans[0];
      // Should have some entries (atoms/glue) — not just foreign leaves
      const foreignEntries = slicePlan.entries.filter((e) => e.kind === "foreign-leaf");
      const nonForeignEntries = slicePlan.entries.filter((e) => e.kind !== "foreign-leaf");
      // ms has no foreign deps → zero foreign leaf entries
      expect(foreignEntries.length).toBe(0);
      // And real atoms/novel-glue entries
      expect(nonForeignEntries.length).toBeGreaterThan(0);
    },
  );

  it(
    "ms forest entry path points into the ms-2.1.3 fixture directory",
    { timeout: 30000 },
    async () => {
      const pkgRoot = join(FIXTURES_DIR, "ms-2.1.3");
      const forest = await shavePackage(pkgRoot, { registry: emptyRegistry });

      expect(existsSync(forest.entryPath)).toBe(true);
      expect(forest.entryPath).toContain("ms-2.1.3");
    },
  );

  it(
    "B-scope: ms has no in-package edges (single-file — external deps would stay foreign)",
    { timeout: 30000 },
    async () => {
      const pkgRoot = join(FIXTURES_DIR, "ms-2.1.3");
      const forest = await shavePackage(pkgRoot, { registry: emptyRegistry });

      // ms/index.js has no require() calls at all
      const entryMod = forestModules(forest)[0];
      expect(entryMod).toBeDefined();
      expect(entryMod.inPackageEdges.length).toBe(0);
      expect(entryMod.externalSpecifiers.length).toBe(0);
    },
  );

  it(
    "B-scope: in three-module-pkg, external dep names do NOT produce in-package edges",
    { timeout: 30000 },
    async () => {
      const pkgRoot = join(FIXTURES_DIR, "degradation-pkg");
      const forest = await shavePackage(pkgRoot, { registry: emptyRegistry });

      const entryMod = forestModules(forest).find((m) => m.filePath.includes("index.js"));
      expect(entryMod).toBeDefined();
      if (entryMod === undefined) {
        throw new Error("expected entry module node for degradation-pkg");
      }
      // some-external-pkg must NOT appear in inPackageEdges
      expect(entryMod.inPackageEdges.every((e) => !e.includes("some-external-pkg"))).toBe(true);
      // It appears in externalSpecifiers instead
      expect(entryMod.externalSpecifiers).toContain("some-external-pkg");
    },
  );
});

// ---------------------------------------------------------------------------
// §9: Compound interaction test (real production sequence)
// ---------------------------------------------------------------------------

describe("shavePackage — compound interaction (real production sequence)", () => {
  it(
    "end-to-end: shavePackage → collectForestSlicePlans on three-module-pkg produces a connected atom forest",
    { timeout: 30000 },
    async () => {
      /**
       * This is the compound-interaction test required by §6.1.
       *
       * Production sequence exercised:
       *   1. resolvePackageEntry() → finds index.js
       *   2. BFS over 3 modules (index → parse, format)
       *   3. decompose() called for each module (crosses decompose boundary)
       *   4. collectForestSlicePlans() → slice() called per module (crosses slicer boundary)
       *   5. Forest connectivity verified: all 3 modules are peers in the same structure
       *   6. Every module contributes atoms (leafCount > 0 per module)
       *
       * State transitions: unvisited → visited (cycle guard), module → decomposed → sliced
       */
      const pkgRoot = join(FIXTURES_DIR, "three-module-pkg");
      const forest = await shavePackage(pkgRoot, { registry: emptyRegistry });

      // 1. Entry point resolved
      expect(existsSync(forest.entryPath)).toBe(true);

      // 2. All 3 modules traversed
      expect(forest.moduleCount).toBe(3);
      expect(forest.stubCount).toBe(0);

      // 3. Each module decomposed
      for (const mod of forestModules(forest)) {
        expect(mod.tree.leafCount).toBeGreaterThan(0);
      }

      // 4. Slicer runs over the full forest
      const plans = await collectForestSlicePlans(forest, slice, emptyRegistry, "glue-aware");
      expect(plans.length).toBe(3);

      // 5. Forest connectivity: cross-module peers in same nodes[] structure
      const filePaths = forestModules(forest).map((m) => m.filePath);
      expect(filePaths.length).toBe(new Set(filePaths).size); // no duplicates

      // 6. Total atoms across the forest
      const totalLeaves = forestTotalLeafCount(forest);
      expect(totalLeaves).toBeGreaterThan(0);

      // 7. Combined slice entries across all modules
      const allEntries = plans.flatMap((p) => p.slicePlan.entries);
      expect(allEntries.length).toBeGreaterThan(0);
    },
  );
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Recursively collect all leaf canonicalAstHash values from a RecursionNode tree. */
function collectLeafHashes(node: {
  kind: string;
  canonicalAstHash?: string;
  children?: unknown[];
}): string[] {
  if (node.kind === "atom") {
    return [node.canonicalAstHash ?? ""];
  }
  if (node.kind === "branch" && Array.isArray(node.children)) {
    return node.children.flatMap((c) =>
      collectLeafHashes(c as { kind: string; canonicalAstHash?: string; children?: unknown[] }),
    );
  }
  return [];
}
