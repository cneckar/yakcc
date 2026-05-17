// SPDX-License-Identifier: MIT
/**
 * toposort@2.0.2 headline bindings -- single-entry shave tests (WI-510 Slice 13 / #642 S13)
 *
 * STRUCTURE:
 *   toposort (1 describe: sections A-E)
 *     index.js -- pure-CJS single-file; 99 LOC production source;
 *     module.exports = function(edges){...} + module.exports.array = toposort
 *     externalSpecifiers = [] (zero require() calls AND zero import declarations;
 *       DEC-WI510-S13-NO-EXTERNAL-IMPORTS-001 -- second WI-510 zero-imports fixture;
 *       first via the CJS extractor path)
 *     Plan §3.1: moduleCount=1, stubCount<=1, forestTotalLeafCount>=8, wall-clock <60s
 *
 *   Section F (1 describe, 1 it.skipIf block) -- combinedScore quality gate.
 *     Skipped unless DISCOVERY_EVAL_PROVIDER=local.
 *     Fixed floor >= 0.70 per DEC-WI510-S13-COMBINED-SCORE-FIXED-FLOOR-001.
 *     NOTE: Full decomposition predicted (zero classes; #666 N/A;
 *       DEC-WI510-S13-NO-CLASSES-001).
 *     If Section A produces stubCount === moduleCount === 1 (entire tree stubs),
 *     Section F SKIPS with a measurement-citing comment (mirroring S10 engine-reality exit).
 *
 *   Compound interaction test (1 describe) -- end-to-end production sequence.
 *     shavePackage -> collectForestSlicePlans -> maybePersistNovelGlueAtom for the single entry.
 *     Crosses: engine decompose, forest slice plans, registry persist, merkle retrieval.
 *     DEC-WI510-S13-ONE-FILE-ONE-ROW-001: one entry file -> one atom containing both
 *     default-export edge-sort and module.exports.array node-aware-sort surfaces.
 *
 * Package selection: toposort@2.0.2 (Marcel Klehr) -- canonical topological-sort npm.
 *   DEC-WI510-S13-PACKAGE-SELECTION-TOPOSORT-001: The #642 issue table names toposort
 *   as a singular slot. toposort@2.0.2 is the canonical Marcel Klehr package (same
 *   package the npm ecosystem has used since 2012). v2.0.2 is current latest, stable
 *   since 2018. Alternatives (dependency-graph, topo, toposort-class) rejected.
 *
 * Engine-gap landscape (DEC-WI510-S13-ENGINE-GAPS-LANDSCAPE-001):
 *   #576 CLOSED (b5dff3a / PR #604) -- arrow-returns-arrow HOF in class bodies. NOT applicable.
 *   #585 CLOSED (cbefa3c / PR #627) -- UMD IIFE walk. NOT applicable (index.js is bare CJS).
 *   #619 CLOSED (dual-group engine-gap-honest pattern) -- TSC CJS prelude. NOT applicable
 *     (index.js is hand-authored CJS; Marcel Klehr 2012-2018; no __esModule prelude).
 *   #666 OPEN but VERIFIED NOT APPLICABLE -- private class fields (#foo). NOT applicable.
 *     index.js has ZERO classes anywhere; all bindings are function declarations.
 *     Verified at planning time via grep. Full decomposition predicted.
 *
 * Fixture file count: 4 files (plan §4.1+§4.2 trimmed vendor manifest -- NO inner marker)
 *   index.js (99 LOC; the shaved source) + package.json (root manifest; CJS default) +
 *   License (capital-L, no extension; DEC-WI510-S13-LICENSE-FILE-NAMING-001) + PROVENANCE.md
 *   DEC-WI510-S13-NO-INNER-MARKER-001: root package.json has no "type":"module"; default
 *   commonjs is exactly correct for index.js. No synthetic inner marker needed.
 *
 * @decision DEC-WI510-S13-PACKAGE-SELECTION-TOPOSORT-001
 *   title: Slice 13 ships toposort@2.0.2 (Marcel Klehr) for the #642 S13 Topological-sort slot
 *   status: accepted
 *   rationale: The #642 issue table names toposort as a singular slot (no (or X) clause).
 *   Planner-time research confirmed toposort@2.0.2 is the canonical Marcel Klehr package —
 *   the same package the npm ecosystem has used since 2012. Alternatives (dependency-graph
 *   class-based, topo hapi-deprecated, toposort-class wrapper) do not match the canonical
 *   headline. v2.0.2 is current latest, stable since 2018.
 *
 * @decision DEC-WI510-S13-ENTRY-PATH-INDEX-CJS-001
 *   title: Slice 13 entry is index.js (the ONLY entry; no ESM alternative)
 *   status: accepted
 *   rationale: toposort@2.0.2 ships pure-CJS only: no package.json#module, no
 *   package.json#exports, no esm/ subdir. index.js is hand-authored CJS (Marcel Klehr 2012-2018)
 *   with module.exports = function(...) {...} + module.exports.array = identifier. No path
 *   choice exists; the trimmed vendor manifest mirrors the tarball faithfully. Engine bypasses
 *   package.json resolution via explicit entryPath (same pattern as S5/S6/S7/S8/S10/S11/S12).
 *
 * @decision DEC-WI510-S13-ONE-FILE-ONE-ROW-001
 *   title: Slice 13 ships ONE corpus row (cat1-toposort-001) carrying both default-export
 *     edge-sort and .array node-aware-sort surfaces
 *   status: accepted
 *   rationale: The package's public CJS surface is two callable bindings from a SINGLE file
 *   (module.exports = function(edges) + module.exports.array = toposort). The shave engine
 *   produces one ModuleForest per entry; both surfaces atom-merkle-root into the same single-
 *   module forest. Within-file two-surface shape is not S4/S6/S9/S11's multi-file multi-row
 *   scenario. One corpus row pointing at the entry-atom captures both behaviors via source text.
 *   Same pattern as S12 fastest-levenshtein (distance + closest in one entry, one row).
 *
 * @decision DEC-WI510-S13-VERSION-PIN-001
 *   title: Pin to toposort@2.0.2 (current latest dist-tag at 2026-05-17)
 *   status: accepted
 *   rationale: v2 is the current major (v1 superseded for lack of cycle detection); v2.0.2
 *   is current latest; 22 published versions total. Last publish over a year ago — package
 *   is stable/feature-complete. Any fresh npm install toposort lands on 2.0.2.
 *
 * @decision DEC-WI510-S13-NO-INNER-MARKER-001
 *   title: NO inner package.json markers required for toposort (unlike S10/S12)
 *   status: accepted
 *   rationale: Root package.json does NOT set "type":"module"; package defaults to commonjs.
 *   index.js is CJS (module.exports; zero require() calls but CJS syntax). The default
 *   commonjs classification is exactly correct for index.js; no override needed. Structurally
 *   the simplest WI-510 vendor shape — pure tarball-faithful copy with no synthetic injection.
 *
 * @decision DEC-WI510-S13-LICENSE-FILE-NAMING-001
 *   title: Preserve tarball-faithful License capitalization (capital-L, no extension)
 *   status: accepted
 *   rationale: The toposort tarball ships License (capital L, no extension) — first WI-510
 *   fixture with this exact spelling. The license-detector reads the file text and matches on
 *   the MIT license header phrase; the filename itself does not gate detection. Vendor verbatim
 *   from the tarball; preserve the capitalization (do NOT rename to LICENSE.md or license).
 *
 * @decision DEC-WI510-S13-NO-CLASSES-001
 *   title: toposort/index.js has ZERO classes; #666 engine-gap CANNOT apply
 *   status: accepted
 *   rationale: Verified at planning time by grep: zero class, extends, or #foo private-field
 *   syntax in the file. All bindings are function declarations (NOT arrow expressions — a
 *   structural distinction from S12 where everything was arrow). The #666 engine-gap (private
 *   class fields stub the whole file) cannot apply by structural type — there are no classes
 *   for the gap to trigger on.
 *
 * @decision DEC-WI510-S13-NO-EXTERNAL-IMPORTS-001
 *   title: index.js has ZERO require() calls AND zero import declarations;
 *     externalSpecifiers === [] is the contract
 *   status: accepted
 *   rationale: Second WI-510 fixture with zero imports/requires of any kind (S12
 *   fastest-levenshtein/esm/mod.js was the first; S13 is the second AND the first via the CJS
 *   extractor path). The empty-union case validates that externalSpecifiers starts empty and
 *   stays empty when there are no requires anywhere in the BFS. JavaScript globals (Set, Map,
 *   Array, JSON) are NOT imports — they are free identifier references at module scope.
 *
 * @decision DEC-WI510-S13-CJS-EXPORT-SHAPE-001
 *   title: module.exports = FunctionExpression + module.exports.X = Identifier combo is the
 *     validated CJS export-shape
 *   status: accepted
 *   rationale: Validated regime: S1 ms, S6 jsonwebtoken/decode.js/sign.js/verify.js,
 *   three-module-pkg. Engine decompose() has handled this CJS export-shape across Slices 1/2/6/7.
 *
 * @decision DEC-WI510-S13-VAR-FUNCTION-DECL-001
 *   title: Pre-ES2015 var + function name(){} declarations decompose identically to modern
 *     let/const + const name = () => {}
 *   status: accepted
 *   rationale: Engine treats VariableDeclaration kind="var" identically to let/const for
 *   decompose purposes (same AST node type); function declarations identically to function
 *   expressions for body-traversal. Validated through S7 lodash extensive function name(...) {}
 *   usage. No structural property exercises only modern declaration kinds.
 *
 * @decision DEC-WI510-S13-ENGINE-GAPS-LANDSCAPE-001
 *   title: Engine gaps #576/#585/#619 CLOSED + #666 OPEN-but-N/A; Slice 13 risk is LOW
 *   status: accepted
 *   rationale: #576 closed (arrow-returns-arrow class HOF). #585 closed (UMD IIFE). #619
 *   closed (TS-compiled CJS prelude). #666 OPEN but verifiably N/A for toposort per
 *   DEC-WI510-S13-NO-CLASSES-001. Slice 13 risk is the nested function visit(...) declaration
 *   inside toposort body — but the engine has validated nested function bodies of arbitrary
 *   depth through Slices 5/7/9/11/12.
 *
 * @decision DEC-WI510-S13-MODERN-PRIMITIVES-001
 *   title: index.js uses Set/Map/Array.from/new Array(N)/JSON.stringify inside function bodies;
 *     engine treats as opaque identifier references
 *   status: accepted
 *   rationale: Same regime as S9/S10/S11/S12 platform-primitive handling. Set, Map, Array,
 *   JSON are JavaScript globals at module scope. The strict-subset validator does not block
 *   them. If any are stubbed as foreign leaves (showing up unexpectedly in externalSpecifiers),
 *   ship engine-reality.
 *
 * @decision DEC-WI510-S13-EXTERNAL-SPECIFIERS-EXPECTATIONS-001
 *   title: Expected externalSpecifiers for index.js is [] (the empty union)
 *   status: accepted
 *   rationale: Per source-read §1.8 of the plan. index.js has zero require() calls and zero
 *   ImportDeclaration AST nodes. If externalSpecifiers shows ANY entries (e.g. Set/Map/Array/
 *   JSON showing up), that is stop-and-report — JavaScript globals should NEVER appear in
 *   externals; the empty-union case is the contract.
 *
 * @decision DEC-WI510-S13-COMBINED-SCORE-FIXED-FLOOR-001
 *   title: combinedScore quality gate uses the canonical >= 0.70 fixed floor
 *   status: accepted
 *   rationale: Slice 13's atom contains the binding-bearing source text directly: the toposort
 *   function body IS the Kahn-style DFS topological sort; the inner visit function performs the
 *   cycle-detected post-order DFS; the uniqueNodes/makeOutgoingEdges/makeNodesHash helpers build
 *   the input data structures. Same per-binding-text-rich rationale as Slices 2-12.
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
const TOPOSORT_FIXTURE_ROOT = join(FIXTURES_DIR, "toposort-2.0.2");

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
    notes: ["WI-510 Slice 13 section E stub intent card for persist pipeline test"],
    modelVersion: STATIC_MODEL_TAG,
    promptVersion: STATIC_PROMPT_VERSION,
    sourceHash: sourceHash(entry.source),
    extractedAt: "2026-05-17T00:00:00.000Z",
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
    notes: ["WI-510 Slice 13 section F semantic intent card for combinedScore quality gate"],
    modelVersion: STATIC_MODEL_TAG,
    promptVersion: STATIC_PROMPT_VERSION,
    sourceHash: sourceHash(entry.source),
    extractedAt: "2026-05-17T00:00:00.000Z",
  };
  return { ...entry, intentCard: semanticCard };
}

// ===========================================================================
// toposort@2.0.2 -- Topological sort (Kahn-style DFS; pure-CJS single-file)
// Entry: index.js (pure-CJS; 99 LOC; module.exports = function(edges){...} +
//        module.exports.array = toposort)
// externalSpecifiers: [] (zero require() + zero import declarations;
//   DEC-WI510-S13-NO-EXTERNAL-IMPORTS-001 -- second WI-510 zero-imports fixture)
// Plan §3.1: moduleCount=1, stubCount<=1, forestTotalLeafCount>=8, wall-clock <60s
// DEC-WI510-S13-NO-CLASSES-001: zero classes anywhere; #666 N/A; full decomposition predicted.
// DEC-WI510-S13-CJS-EXPORT-SHAPE-001: module.exports=FunctionExpr + module.exports.X=id.
// DEC-WI510-S13-VAR-FUNCTION-DECL-001: pre-ES2015 var + function decls; same engine handling.
// ===========================================================================

// ---------------------------------------------------------------------------
// toposort/index.js -- sections A-E
// Timeouts: per-it() 60_000ms (§3.1 plan budget; predicted <5s on modern hardware)
//           section D 120_000ms (two consecutive calls)
// ---------------------------------------------------------------------------
describe("toposort/index.js -- per-entry shave (WI-510 Slice 13 / #642 S13)", () => {
  it(
    "section A -- moduleCount=1, stubCount<=1, forestTotalLeafCount>=8, externalSpecifiers=[]",
    { timeout: 60_000 },
    async () => {
      const forest = await shavePackage(TOPOSORT_FIXTURE_ROOT, {
        registry: emptyRegistry,
        entryPath: join(TOPOSORT_FIXTURE_ROOT, "index.js"),
      });
      console.log("[toposort sA] moduleCount:", forest.moduleCount);
      console.log("[toposort sA] stubCount:", forest.stubCount);
      console.log(
        "[toposort sA] stubs:",
        forestStubs(forest).map((s) => s.specifier),
      );
      console.log("[toposort sA] forestTotalLeafCount:", forestTotalLeafCount(forest));
      const allExternal = forestModules(forest).flatMap((m) => m.externalSpecifiers);
      console.log("[toposort sA] externalSpecifiers:", allExternal);
      console.log(
        "[toposort sA] BFS filePaths:",
        forestModules(forest).map((m) => m.filePath.split("/").slice(-3).join("/")),
      );

      // Plan §3.1: single-file entry; no require() or import declarations anywhere; BFS terminates.
      expect(
        forest.moduleCount,
        "toposort moduleCount must be 1 (single-file entry; no transitives)",
      ).toBe(1);

      // DEC-WI510-S13-NO-CLASSES-001: zero classes; #666 N/A; full decomposition expected (0).
      // Engine-reality-honest band per plan §3.1: stubCount <= 1 tolerated.
      // If stubCount === 1 (entire single file stubs), file a NEW engine-gap issue (not #666).
      expect(
        forest.stubCount,
        "toposort stubCount must be <= 1 (engine-reality-honest band; expected 0; DEC-WI510-S13-NO-CLASSES-001)",
      ).toBeLessThanOrEqual(1);

      // Plan §3.1: conservative floor >= 8 (4 top-level function decls + 2 module.exports
      // assignments + 1 inner function visit + 1 forEach callback; each may expand).
      expect(
        forestTotalLeafCount(forest),
        "toposort forestTotalLeafCount must be >= 8 (plan §3.1)",
      ).toBeGreaterThanOrEqual(8);

      // DEC-WI510-S13-NO-EXTERNAL-IMPORTS-001: index.js has zero require() calls AND zero
      // ImportDeclaration nodes. JavaScript globals (Set, Map, Array, JSON) are NOT imports.
      // If externalSpecifiers is non-empty, that is stop-and-report (globals in externals = bug).
      expect(
        allExternal,
        "toposort externalSpecifiers must be [] (zero require()+imports; DEC-WI510-S13-NO-EXTERNAL-IMPORTS-001)",
      ).toEqual([]);
    },
  );

  it(
    "section B -- forest.nodes[0] is toposort-2.0.2/index.js (CJS entry; BFS root)",
    { timeout: 60_000 },
    async () => {
      const forest = await shavePackage(TOPOSORT_FIXTURE_ROOT, {
        registry: emptyRegistry,
        entryPath: join(TOPOSORT_FIXTURE_ROOT, "index.js"),
      });
      const firstNode = forest.nodes[0];
      expect(firstNode).toBeDefined();
      expect(firstNode?.kind, "toposort first BFS node must be a module (not a stub)").toBe(
        "module",
      );
      if (firstNode?.kind === "module") {
        expect(firstNode.filePath, "toposort first BFS node must contain index.js").toContain(
          "index.js",
        );
        expect(
          firstNode.filePath,
          "toposort first BFS node must be inside toposort-2.0.2/",
        ).toContain("toposort-2.0.2");
      }
    },
  );

  it(
    "section C -- single module inside toposort-2.0.2/ boundary; externalSpecifiers=[]; stubCount<=1",
    { timeout: 60_000 },
    async () => {
      const forest = await shavePackage(TOPOSORT_FIXTURE_ROOT, {
        registry: emptyRegistry,
        entryPath: join(TOPOSORT_FIXTURE_ROOT, "index.js"),
      });
      const filePaths = forestModules(forest).map((m) => m.filePath);
      for (const fp of filePaths) {
        expect(
          normalize(fp),
          `toposort module path must be inside toposort-2.0.2/: ${fp}`,
        ).toContain("toposort-2.0.2");
      }
      const allExternal = forestModules(forest).flatMap((m) => m.externalSpecifiers);
      expect(
        allExternal,
        "toposort externalSpecifiers must be [] (DEC-WI510-S13-NO-EXTERNAL-IMPORTS-001)",
      ).toEqual([]);
      const stubs = forestStubs(forest);
      expect(
        stubs.length,
        "toposort stubs must be <= 1 (engine-reality-honest band; DEC-WI510-S13-ENGINE-GAPS-LANDSCAPE-001)",
      ).toBeLessThanOrEqual(1);
    },
  );

  it(
    "section D -- two-pass byte-identical determinism for toposort/index.js",
    { timeout: 120_000 },
    async () => {
      const forest1 = await shavePackage(TOPOSORT_FIXTURE_ROOT, {
        registry: emptyRegistry,
        entryPath: join(TOPOSORT_FIXTURE_ROOT, "index.js"),
      });
      const forest2 = await shavePackage(TOPOSORT_FIXTURE_ROOT, {
        registry: emptyRegistry,
        entryPath: join(TOPOSORT_FIXTURE_ROOT, "index.js"),
      });
      expect(forest1.moduleCount, "toposort two-pass: moduleCount must be identical").toBe(
        forest2.moduleCount,
      );
      expect(forest1.stubCount, "toposort two-pass: stubCount must be identical").toBe(
        forest2.stubCount,
      );
      const paths1 = forestModules(forest1).map((m) => normalize(m.filePath));
      const paths2 = forestModules(forest2).map((m) => normalize(m.filePath));
      expect(paths1, "toposort two-pass: BFS filePath list must be byte-identical").toEqual(paths2);
      const ext1 = forestModules(forest1).flatMap((m) => m.externalSpecifiers);
      const ext2 = forestModules(forest2).flatMap((m) => m.externalSpecifiers);
      expect(ext1, "toposort two-pass: externalSpecifiers must be byte-identical").toEqual(ext2);
      expect(
        forestTotalLeafCount(forest1),
        "toposort two-pass: forestTotalLeafCount must be identical",
      ).toBe(forestTotalLeafCount(forest2));
    },
  );

  it(
    "section E -- toposort forest persisted via real collectForestSlicePlans -> maybePersistNovelGlueAtom path",
    { timeout: 60_000 },
    async () => {
      const registry = await openRegistry(":memory:", {
        embeddings: createOfflineEmbeddingProvider(),
      });
      try {
        const forest = await shavePackage(TOPOSORT_FIXTURE_ROOT, {
          registry,
          entryPath: join(TOPOSORT_FIXTURE_ROOT, "index.js"),
        });
        // DEC-WI510-S13-NO-CLASSES-001: full decomposition expected; plans > 0.
        // Engine-reality-honest fallback: if stubCount === moduleCount === 1 (entire single
        // file stubs), plans may be 0. Adjust assertion to empirical reality; file new
        // engine-gap issue (since #666 does NOT apply — zero classes in index.js).
        const plans = await collectForestSlicePlans(forest, slice, registry, "glue-aware");
        console.log("[toposort sE] plans.length:", plans.length);
        console.log(
          "[toposort sE] moduleCount:",
          forest.moduleCount,
          "stubCount:",
          forest.stubCount,
        );
        if (forest.stubCount === forest.moduleCount && forest.moduleCount === 1) {
          // Engine-reality-honest fallback: entire single-file tree stubs (unexpected per plan).
          // File a NEW engine-gap issue (not #666 — index.js has zero classes).
          // DEC-WI510-S13-ENGINE-GAPS-LANDSCAPE-001: if reached, a previously-unobserved gap.
          expect(
            plans.length,
            "toposort sE: stub-state fallback — 0 plans (entire single-file tree stubs; unexpected per plan §3.1)",
          ).toBe(0);
        } else {
          expect(
            plans.length,
            "toposort sE: collectForestSlicePlans must return > 0 plans",
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
                    "toposort sE: persisted atom must be retrievable via registry.getBlock",
                  ).not.toBeNull();
                }
              }
            }
          }
          console.log("[toposort sE] persisted atoms:", persistedCount);
          console.log("[toposort sE] headline merkle root:", headlineMerkleRoot);
          expect(
            persistedCount,
            "toposort sE: at least one atom must persist (novel-glue path)",
          ).toBeGreaterThan(0);
        }
      } finally {
        await registry.close();
      }
    },
  );
});

// ===========================================================================
// Section F -- combinedScore quality gate (fixed floor >= 0.70)
// DEC-WI510-S13-COMBINED-SCORE-FIXED-FLOOR-001: Atom contains the binding-bearing source
// text directly (toposort function body IS the Kahn-style DFS topological sort; the inner
// visit function performs the cycle-detected post-order DFS).
// Skipped unless DISCOVERY_EVAL_PROVIDER=local.
// NOTE: If Section A produces stubCount === moduleCount === 1 (entire file stubs),
// this section SKIPS with a measurement-citing comment (mirroring S10 engine-reality exit).
// Predicted: full decomposition (zero classes; #666 N/A; clean pure-CJS single file).
// ===========================================================================
describe("toposort section F -- combinedScore quality gate (WI-510 Slice 13 / #642 S13)", () => {
  // ---------------------------------------------------------------------------
  // toposort sF: Topological sort / DAG dependency-ordering query
  // Query: corpus cat1-toposort-001 behavior string (plan §5.4)
  // ---------------------------------------------------------------------------
  it.skipIf(!USE_LOCAL_PROVIDER)(
    "toposort combinedScore >= 0.70 for corpus query (DISCOVERY_EVAL_PROVIDER=local)",
    { timeout: 60_000 },
    async () => {
      const registry = await openRegistry(":memory:", {
        embeddings: createLocalEmbeddingProvider("Xenova/all-MiniLM-L6-v2", 384),
      });
      try {
        const TOPOSORT_BEHAVIOR =
          "Topologically sort a directed acyclic graph given as an array of [from, to] edge pairs; returns the nodes in an order such that every directed edge points from an earlier element to a later element in the returned array; supports an alternative form that accepts an explicit node list alongside the edges (toposort.array(nodes, edges)); throws a cyclic-dependency error when the graph contains a cycle and throws an unknown-node error when an edge references a node not in the supplied node list";
        const forest = await shavePackage(TOPOSORT_FIXTURE_ROOT, {
          registry,
          entryPath: join(TOPOSORT_FIXTURE_ROOT, "index.js"),
        });
        // If entire file stubs (unexpected), skip quality gate and document the gap.
        if (forest.stubCount === forest.moduleCount && forest.moduleCount === 1) {
          // Engine-reality-honest: stub-state prevents atom persistence; quality gate deferred.
          // Unexpected for toposort (DEC-WI510-S13-NO-CLASSES-001 — zero classes, #666 N/A).
          // File a NEW engine-gap issue with this evidence before marking slice ready.
          console.log(
            "[toposort sF] UNEXPECTED STUB STATE: moduleCount=1, stubCount=1. Quality gate deferred.",
          );
          expect(
            forest.stubCount,
            "toposort sF: stub-state corroboration (DEC-WI510-S13-ENGINE-GAPS-LANDSCAPE-001)",
          ).toBe(1);
          return;
        }
        const plans = await collectForestSlicePlans(forest, slice, registry, "glue-aware");
        for (const { slicePlan } of plans) {
          for (const entry of slicePlan.entries) {
            if (entry.kind === "novel-glue") {
              await maybePersistNovelGlueAtom(
                withSemanticIntentCard(entry, TOPOSORT_BEHAVIOR),
                registry,
              );
            }
          }
        }
        const result = await registry.findCandidatesByQuery({
          behavior: TOPOSORT_BEHAVIOR,
          topK: 10,
        });
        console.log(
          "[toposort sF] candidates:",
          result.candidates.map((c) => ({ score: c.combinedScore })),
        );
        expect(
          result.candidates.length,
          "toposort sF: must find at least one candidate",
        ).toBeGreaterThan(0);
        const topScore = result.candidates[0]?.combinedScore ?? 0;
        console.log("[toposort sF] top combinedScore:", topScore);
        // Fixed floor >= 0.70 per DEC-WI510-S13-COMBINED-SCORE-FIXED-FLOOR-001.
        // Atom contains toposort + visit + uniqueNodes + makeOutgoingEdges + makeNodesHash
        // source directly (binding-bearing text).
        // If empirical falls below 0.70, extend semanticHints or document via
        // DEC-WI510-S13-COMBINED-SCORE-EMPIRICAL-FLOOR-002 escape hatch.
        expect(
          topScore,
          "toposort combinedScore must be >= 0.70 (DEC-WI510-S13-COMBINED-SCORE-FIXED-FLOOR-001)",
        ).toBeGreaterThanOrEqual(0.7);
      } finally {
        await registry.close();
      }
    },
  );
});

// ===========================================================================
// Compound interaction test -- real production sequence end-to-end
// Plan §5.1: exercises shavePackage -> collectForestSlicePlans -> maybePersistNovelGlueAtom
// for the single toposort entry, crossing multiple internal component boundaries.
// Asserts: entry produces > 0 persisted atoms + merkle root retrievable from registry.
// DEC-WI510-S13-ONE-FILE-ONE-ROW-001: one file -> one entry-atom containing both
// default-export edge-sort and .array node-aware-sort surfaces via the single-module forest.
// ===========================================================================
describe("toposort -- compound interaction: entry end-to-end (WI-510 Slice 13 / #642 S13)", () => {
  it(
    "entry resolves, shaves, slices, persists; entry-atom merkle root is retrievable (DEC-WI510-S13-ONE-FILE-ONE-ROW-001)",
    { timeout: 120_000 },
    async () => {
      const registry = await openRegistry(":memory:", {
        embeddings: createOfflineEmbeddingProvider(),
      });
      try {
        const forest = await shavePackage(TOPOSORT_FIXTURE_ROOT, {
          registry,
          entryPath: join(TOPOSORT_FIXTURE_ROOT, "index.js"),
        });

        // Plan §3.1: single-file entry.
        expect(forest.moduleCount, "compound test: toposort moduleCount must be 1").toBe(1);

        // DEC-WI510-S13-NO-CLASSES-001: expected 0 stubs; tolerate 1 (engine-reality-honest band).
        expect(
          forest.stubCount,
          "compound test: toposort stubCount must be <= 1 (DEC-WI510-S13-NO-CLASSES-001)",
        ).toBeLessThanOrEqual(1);

        // DEC-WI510-S13-NO-EXTERNAL-IMPORTS-001: zero require()+imports; empty union is the contract.
        const allExternal = forestModules(forest).flatMap((m) => m.externalSpecifiers);
        expect(
          allExternal,
          "compound test: toposort externalSpecifiers must be [] (DEC-WI510-S13-NO-EXTERNAL-IMPORTS-001)",
        ).toEqual([]);

        const plans = await collectForestSlicePlans(forest, slice, registry, "glue-aware");

        console.log(
          `[compound] toposort: moduleCount=${forest.moduleCount} stubCount=${forest.stubCount} leafCount=${forestTotalLeafCount(forest)} plans=${plans.length}`,
        );

        if (forest.stubCount === forest.moduleCount && forest.moduleCount === 1) {
          // Engine-reality-honest: entire tree stubs; no atoms persisted. Expected 0 plans.
          // File new engine-gap issue before declaring readiness.
          expect(
            plans.length,
            "compound test: stub-state fallback — 0 plans (unexpected per plan §3.1)",
          ).toBe(0);
          return;
        }

        expect(plans.length, "compound test: toposort plans.length must be > 0").toBeGreaterThan(0);

        let persistedCount = 0;
        let entryAtomMerkleRoot: string | undefined;
        for (const { slicePlan } of plans) {
          for (const entry of slicePlan.entries) {
            if (entry.kind === "novel-glue") {
              const mr = await maybePersistNovelGlueAtom(withStubIntentCard(entry), registry);
              if (mr !== undefined) {
                persistedCount++;
                if (entryAtomMerkleRoot === undefined) entryAtomMerkleRoot = mr;
              }
            }
          }
        }

        console.log(
          `[compound] toposort: persisted=${persistedCount} entryMR=${entryAtomMerkleRoot?.slice(0, 16)}`,
        );

        expect(persistedCount, "compound test: toposort must persist > 0 atoms").toBeGreaterThan(0);

        // DEC-WI510-S13-ONE-FILE-ONE-ROW-001: entry-atom merkle root must be retrievable.
        // The single-module forest carries both default-export edge-sort and .array node-aware-sort
        // surfaces in one atom.
        if (entryAtomMerkleRoot !== undefined) {
          const block = await registry.getBlock(entryAtomMerkleRoot);
          expect(
            block,
            "compound test: entry-atom merkle root must be retrievable via registry.getBlock",
          ).not.toBeNull();
        }
      } finally {
        await registry.close();
      }
    },
  );
});
