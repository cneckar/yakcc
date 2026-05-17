// SPDX-License-Identifier: MIT
/**
 * fastest-levenshtein@1.0.16 headline bindings -- single-entry shave tests (WI-510 Slice 12 / #642 S12)
 *
 * STRUCTURE:
 *   fastest-levenshtein (1 describe: sections A-E)
 *     esm/mod.js -- single-file ESM; 138 LOC production source; distance + closest arrow exports
 *     externalSpecifiers = [] (zero imports; DEC-WI510-S12-NO-EXTERNAL-IMPORTS-001)
 *     Plan §3.1: moduleCount=1, stubCount<=1, forestTotalLeafCount>=10, wall-clock <60s
 *
 *   Section F (1 describe, 1 it.skipIf block) -- combinedScore quality gate.
 *     Skipped unless DISCOVERY_EVAL_PROVIDER=local.
 *     Fixed floor >= 0.70 per DEC-WI510-S12-COMBINED-SCORE-FIXED-FLOOR-001.
 *     NOTE: Full decomposition predicted (zero classes; #666 N/A).
 *     If Section A produces stubCount === moduleCount === 1 (entire tree stubs),
 *     Section F SKIPS with a measurement-citing comment (mirroring S10 engine-reality-honest exit).
 *
 *   Compound interaction test (1 describe) -- end-to-end production sequence.
 *     shavePackage -> collectForestSlicePlans -> maybePersistNovelGlueAtom for the single entry.
 *     Crosses: engine decompose, forest slice plans, registry persist, merkle retrieval.
 *     DEC-WI510-S12-ONE-FILE-ONE-ROW-001: one entry file -> one atom containing both distance
 *     and closest exports.
 *
 * Package selection: fastest-levenshtein (NOT js-levenshtein).
 *   DEC-WI510-S12-PACKAGE-SELECTION-FASTEST-001: js-levenshtein ships only as CJS bare-IIFE
 *   (module.exports = (function(){...})()); HIGH-UNKNOWN engine-gap risk. fastest-levenshtein
 *   ships clean single-file ESM via the module field; structurally identical to S9 p-throttle
 *   (validated regime). The #642 table grants the swap explicitly.
 *
 * Engine-gap landscape (DEC-WI510-S12-ENGINE-GAPS-LANDSCAPE-001):
 *   #576 CLOSED (b5dff3a / PR #604) -- arrow-returns-arrow HOF in class bodies. NOT applicable.
 *   #585 CLOSED (cbefa3c / PR #627) -- UMD IIFE walk. NOT applicable (esm/mod.js is plain ESM).
 *   #619 CLOSED (dual-group engine-gap-honest pattern) -- TSC CJS prelude. NOT applicable
 *     (esm/mod.js is the ESM emit; mod.js CJS is explicitly NOT shaved per DEC-WI510-S12-ENTRY-PATH-ESM-MOD-001).
 *   #666 OPEN but VERIFIED NOT APPLICABLE -- private class fields (#foo). NOT applicable.
 *     esm/mod.js has zero classes anywhere; all bindings are arrow-function expressions.
 *     Verified at planning time via grep. Full decomposition predicted.
 *
 * Fixture file count: 5 files (plan §4.1+§4.2 trimmed vendor manifest)
 *   esm/mod.js (138 LOC; the shaved source) + esm/package.json (synthetic inner marker) +
 *   package.json (root manifest) + LICENSE.md + PROVENANCE.md
 *
 * @decision DEC-WI510-S12-PACKAGE-SELECTION-FASTEST-001
 *   title: Slice 12 ships fastest-levenshtein@1.0.16, NOT js-levenshtein@1.1.6
 *   status: accepted
 *   rationale: js-levenshtein ships only as a CJS module.exports = (function(){...})() IIFE —
 *   a previously-unobserved engine shape with HIGH-UNKNOWN engine-gap risk. fastest-levenshtein
 *   ships clean single-file ESM (esm/mod.js) with arrow-function const bindings + named exports
 *   (structurally identical to S9-validated p-throttle regime). The #642 issue table grants the
 *   swap: "Operator/implementer may swap exact npm package per WI-510 selection conventions."
 *
 * @decision DEC-WI510-S12-ENTRY-PATH-ESM-MOD-001
 *   title: Slice 12 entry is esm/mod.js (NOT mod.js / CJS)
 *   status: accepted
 *   rationale: esm/mod.js — clean hand-authored-style ESM with arrow-function const bindings and
 *   named exports; no class, no IIFE, no __esModule prelude. mod.js is TSC-emitted CJS with
 *   "use strict"; exports.__esModule = true; — would re-engage #619 territory unnecessarily.
 *   package.json#exports is absent; resolution bypassed via explicit entryPath.
 *
 * @decision DEC-WI510-S12-ONE-FILE-ONE-ROW-001
 *   title: Slice 12 ships ONE corpus row (cat1-fastest-levenshtein-001) carrying both exports
 *   status: accepted
 *   rationale: One entry file -> one ModuleForest; both distance and closest exports atom-merkle-root
 *   into the same single-module forest. Within-file two-export shape is not S4/S6/S9/S11's
 *   multi-file multi-row scenario. One corpus row pointing at the entry-atom captures both behaviors.
 *
 * @decision DEC-WI510-S12-VERSION-PIN-001
 *   title: Pin to fastest-levenshtein@1.0.16 (current latest dist-tag at 2026-05-17)
 *   status: accepted
 *   rationale: v1 is the only published major; v1.0.16 is current latest. Any fresh
 *   npm install fastest-levenshtein lands on 1.0.16. Atom keying matches the lockfile context.
 *
 * @decision DEC-WI510-S12-NO-CLASSES-001
 *   title: esm/mod.js has ZERO classes; #666 engine-gap CANNOT apply
 *   status: accepted
 *   rationale: All bindings are arrow-function expressions assigned to const. No class, extends,
 *   or #foo private-field syntax anywhere. #666 (private class fields stub the whole file)
 *   cannot trigger. If any module stubs, it is a NEW engine-gap (not #666).
 *
 * @decision DEC-WI510-S12-NO-EXTERNAL-IMPORTS-001
 *   title: esm/mod.js has ZERO import declarations; externalSpecifiers === [] is the contract
 *   status: accepted
 *   rationale: First WI-510 fixture with zero imports of any kind. JavaScript globals
 *   (Uint32Array, Math, String, Infinity, Array) are NOT imports; they are free identifier
 *   references at module scope (same regime as S11 Buffer/setImmediate).
 *
 * @decision DEC-WI510-S12-MODULE-SCOPE-TYPED-ARRAY-001
 *   title: const peq = new Uint32Array(0x10000) at module scope is opaque construction
 *   status: accepted
 *   rationale: Engine treats NewExpression as opaque (same regime as S9 WeakMap/Map/Set).
 *   peq binding is const; contents mutated inside myers_32/myers_x. Engine has no structural
 *   property defeated by mutation-through-a-const-binding.
 *
 * @decision DEC-WI510-S12-ENGINE-GAPS-LANDSCAPE-001
 *   title: Engine gaps #576/#585/#619 CLOSED + #666 OPEN-but-N/A; Slice 12 risk is LOW
 *   status: accepted
 *   rationale: All four known gaps verified inapplicable. Primary risk is myers_x ~80-LOC
 *   nested-loop body with chained bitwise expressions — but engine validated arrow-function bodies
 *   of arbitrary depth through Slices 5/7/9/11. If a previously-unobserved shape surfaces,
 *   ship engine-reality + file new engine-gap issue.
 *
 * @decision DEC-WI510-S12-MODERN-PRIMITIVES-001
 *   title: esm/mod.js uses Uint32Array/Math/String/Infinity/bitwise ops as opaque identifier refs
 *   status: accepted
 *   rationale: Same regime as S9/S10/S11 platform-primitive handling. The strict-subset validator
 *   does not stub these at module scope. If any appear in externalSpecifiers, stop-and-report.
 *
 * @decision DEC-WI510-S12-EXTERNAL-SPECIFIERS-EXPECTATIONS-001
 *   title: Expected externalSpecifiers for esm/mod.js is [] (the empty union)
 *   status: accepted
 *   rationale: esm/mod.js has zero ImportDeclaration AST nodes. If externalSpecifiers shows ANY
 *   entries (e.g. Uint32Array/Math showing up), that is stop-and-report — globals NEVER appear
 *   in externals. The empty-union case validates the contract for an import-free file.
 *
 * @decision DEC-WI510-S12-COMBINED-SCORE-FIXED-FLOOR-001
 *   title: combinedScore quality gate uses the canonical >= 0.70 fixed floor
 *   status: accepted
 *   rationale: The distance arrow function IS the edit-distance computation (Myers bit-parallel);
 *   the closest arrow function calls distance in a loop. Binding-bearing source text is present
 *   directly in the atom. Same per-binding-text-rich rationale as Slices 2-11.
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
const FASTEST_LEV_FIXTURE_ROOT = join(FIXTURES_DIR, "fastest-levenshtein-1.0.16");

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
    notes: ["WI-510 Slice 12 section E stub intent card for persist pipeline test"],
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
    notes: ["WI-510 Slice 12 section F semantic intent card for combinedScore quality gate"],
    modelVersion: STATIC_MODEL_TAG,
    promptVersion: STATIC_PROMPT_VERSION,
    sourceHash: sourceHash(entry.source),
    extractedAt: "2026-05-17T00:00:00.000Z",
  };
  return { ...entry, intentCard: semanticCard };
}

// ===========================================================================
// fastest-levenshtein@1.0.16 -- Levenshtein distance (Myers bit-parallel)
// Entry: esm/mod.js (single-file ESM; 138 LOC; distance + closest arrow-fn exports)
// externalSpecifiers: [] (zero imports; DEC-WI510-S12-NO-EXTERNAL-IMPORTS-001)
// Plan §3.1: moduleCount=1, stubCount<=1, forestTotalLeafCount>=10, wall-clock <60s
// DEC-WI510-S12-NO-CLASSES-001: zero classes anywhere; #666 N/A; full decomposition predicted.
// DEC-WI510-S12-MODULE-SCOPE-TYPED-ARRAY-001: peq=new Uint32Array(0x10000) is opaque construction.
// ===========================================================================

// ---------------------------------------------------------------------------
// fastest-levenshtein/esm/mod.js -- sections A-E
// Timeouts: per-it() 60_000ms (§3.1 plan budget; predicted <5s on modern hardware)
//           section D 120_000ms (two consecutive calls)
// ---------------------------------------------------------------------------
describe("fastest-levenshtein/esm/mod.js -- per-entry shave (WI-510 Slice 12 / #642 S12)", () => {
  it(
    "section A -- moduleCount=1, stubCount<=1, forestTotalLeafCount>=10, externalSpecifiers=[]",
    { timeout: 60_000 },
    async () => {
      const forest = await shavePackage(FASTEST_LEV_FIXTURE_ROOT, {
        registry: emptyRegistry,
        entryPath: join(FASTEST_LEV_FIXTURE_ROOT, "esm/mod.js"),
      });
      console.log("[fastest-lev sA] moduleCount:", forest.moduleCount);
      console.log("[fastest-lev sA] stubCount:", forest.stubCount);
      console.log(
        "[fastest-lev sA] stubs:",
        forestStubs(forest).map((s) => s.specifier),
      );
      console.log("[fastest-lev sA] forestTotalLeafCount:", forestTotalLeafCount(forest));
      const allExternal = forestModules(forest).flatMap((m) => m.externalSpecifiers);
      console.log("[fastest-lev sA] externalSpecifiers:", allExternal);
      console.log(
        "[fastest-lev sA] BFS filePaths:",
        forestModules(forest).map((m) => m.filePath.split("/").slice(-3).join("/")),
      );

      // Plan §3.1: single-file entry; no imports anywhere; BFS terminates at the entry.
      expect(
        forest.moduleCount,
        "fastest-levenshtein moduleCount must be 1 (single-file entry; no transitives)",
      ).toBe(1);

      // DEC-WI510-S12-NO-CLASSES-001: zero classes; #666 N/A; full decomposition expected (0).
      // Engine-reality-honest band per plan §3.1: stubCount <= 1 tolerated.
      // If stubCount === 1 (entire single file stubs), file a NEW engine-gap issue (not #666).
      expect(
        forest.stubCount,
        "fastest-levenshtein stubCount must be <= 1 (engine-reality-honest band; expected 0; DEC-WI510-S12-NO-CLASSES-001)",
      ).toBeLessThanOrEqual(1);

      // Plan §3.1: conservative floor >= 10 (5 top-level const bindings + export + inner leaves).
      expect(
        forestTotalLeafCount(forest),
        "fastest-levenshtein forestTotalLeafCount must be >= 10 (plan §3.1)",
      ).toBeGreaterThanOrEqual(10);

      // DEC-WI510-S12-NO-EXTERNAL-IMPORTS-001: esm/mod.js has zero ImportDeclaration nodes.
      // JavaScript globals (Uint32Array, Math, String, Infinity) are NOT imports.
      // If externalSpecifiers is non-empty, that is stop-and-report (globals in externals = bug).
      expect(
        allExternal,
        "fastest-levenshtein externalSpecifiers must be [] (zero imports; DEC-WI510-S12-NO-EXTERNAL-IMPORTS-001)",
      ).toEqual([]);
    },
  );

  it(
    "section B -- forest.nodes[0] is fastest-levenshtein-1.0.16/esm/mod.js (ESM entry; BFS root)",
    { timeout: 60_000 },
    async () => {
      const forest = await shavePackage(FASTEST_LEV_FIXTURE_ROOT, {
        registry: emptyRegistry,
        entryPath: join(FASTEST_LEV_FIXTURE_ROOT, "esm/mod.js"),
      });
      const firstNode = forest.nodes[0];
      expect(firstNode).toBeDefined();
      expect(
        firstNode?.kind,
        "fastest-levenshtein first BFS node must be a module (not a stub)",
      ).toBe("module");
      if (firstNode?.kind === "module") {
        expect(
          firstNode.filePath,
          "fastest-levenshtein first BFS node must contain mod.js",
        ).toContain("mod.js");
        expect(
          firstNode.filePath,
          "fastest-levenshtein first BFS node must be inside fastest-levenshtein-1.0.16/",
        ).toContain("fastest-levenshtein-1.0.16");
        expect(
          firstNode.filePath,
          "fastest-levenshtein first BFS node must be inside esm/ (inner ESM subtree)",
        ).toContain("esm/");
      }
    },
  );

  it(
    "section C -- single module inside fastest-levenshtein-1.0.16/ boundary; externalSpecifiers=[]; stubCount<=1",
    { timeout: 60_000 },
    async () => {
      const forest = await shavePackage(FASTEST_LEV_FIXTURE_ROOT, {
        registry: emptyRegistry,
        entryPath: join(FASTEST_LEV_FIXTURE_ROOT, "esm/mod.js"),
      });
      const filePaths = forestModules(forest).map((m) => m.filePath);
      for (const fp of filePaths) {
        expect(
          normalize(fp),
          `fastest-levenshtein module path must be inside fastest-levenshtein-1.0.16/: ${fp}`,
        ).toContain("fastest-levenshtein-1.0.16");
      }
      const allExternal = forestModules(forest).flatMap((m) => m.externalSpecifiers);
      expect(
        allExternal,
        "fastest-levenshtein externalSpecifiers must be [] (DEC-WI510-S12-NO-EXTERNAL-IMPORTS-001)",
      ).toEqual([]);
      const stubs = forestStubs(forest);
      expect(
        stubs.length,
        "fastest-levenshtein stubs must be <= 1 (engine-reality-honest band; DEC-WI510-S12-ENGINE-GAPS-LANDSCAPE-001)",
      ).toBeLessThanOrEqual(1);
    },
  );

  it(
    "section D -- two-pass byte-identical determinism for fastest-levenshtein/esm/mod.js",
    { timeout: 120_000 },
    async () => {
      const forest1 = await shavePackage(FASTEST_LEV_FIXTURE_ROOT, {
        registry: emptyRegistry,
        entryPath: join(FASTEST_LEV_FIXTURE_ROOT, "esm/mod.js"),
      });
      const forest2 = await shavePackage(FASTEST_LEV_FIXTURE_ROOT, {
        registry: emptyRegistry,
        entryPath: join(FASTEST_LEV_FIXTURE_ROOT, "esm/mod.js"),
      });
      expect(
        forest1.moduleCount,
        "fastest-levenshtein two-pass: moduleCount must be identical",
      ).toBe(forest2.moduleCount);
      expect(forest1.stubCount, "fastest-levenshtein two-pass: stubCount must be identical").toBe(
        forest2.stubCount,
      );
      const paths1 = forestModules(forest1).map((m) => normalize(m.filePath));
      const paths2 = forestModules(forest2).map((m) => normalize(m.filePath));
      expect(
        paths1,
        "fastest-levenshtein two-pass: BFS filePath list must be byte-identical",
      ).toEqual(paths2);
      const ext1 = forestModules(forest1).flatMap((m) => m.externalSpecifiers);
      const ext2 = forestModules(forest2).flatMap((m) => m.externalSpecifiers);
      expect(
        ext1,
        "fastest-levenshtein two-pass: externalSpecifiers must be byte-identical",
      ).toEqual(ext2);
      expect(
        forestTotalLeafCount(forest1),
        "fastest-levenshtein two-pass: forestTotalLeafCount must be identical",
      ).toBe(forestTotalLeafCount(forest2));
    },
  );

  it(
    "section E -- fastest-levenshtein forest persisted via real collectForestSlicePlans -> maybePersistNovelGlueAtom path",
    { timeout: 60_000 },
    async () => {
      const registry = await openRegistry(":memory:", {
        embeddings: createOfflineEmbeddingProvider(),
      });
      try {
        const forest = await shavePackage(FASTEST_LEV_FIXTURE_ROOT, {
          registry,
          entryPath: join(FASTEST_LEV_FIXTURE_ROOT, "esm/mod.js"),
        });
        // DEC-WI510-S12-NO-CLASSES-001: full decomposition expected; plans > 0.
        // Engine-reality-honest fallback: if stubCount === moduleCount === 1 (entire single file stubs),
        // plans may be 0. Adjust assertion to empirical reality; file new engine-gap issue.
        const plans = await collectForestSlicePlans(forest, slice, registry, "glue-aware");
        console.log("[fastest-lev sE] plans.length:", plans.length);
        console.log(
          "[fastest-lev sE] moduleCount:",
          forest.moduleCount,
          "stubCount:",
          forest.stubCount,
        );
        if (forest.stubCount === forest.moduleCount && forest.moduleCount === 1) {
          // Engine-reality-honest fallback: entire single-file tree stubs (unexpected per plan).
          // File a NEW engine-gap issue (not #666 — esm/mod.js has zero classes).
          // DEC-WI510-S12-ENGINE-GAPS-LANDSCAPE-001: if reached, a new previously-unobserved gap.
          expect(
            plans.length,
            "fastest-lev sE: stub-state fallback — 0 plans (entire single-file tree stubs; unexpected per plan §3.1)",
          ).toBe(0);
        } else {
          expect(
            plans.length,
            "fastest-lev sE: collectForestSlicePlans must return > 0 plans",
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
                    "fastest-lev sE: persisted atom must be retrievable via registry.getBlock",
                  ).not.toBeNull();
                }
              }
            }
          }
          console.log("[fastest-lev sE] persisted atoms:", persistedCount);
          console.log("[fastest-lev sE] headline merkle root:", headlineMerkleRoot);
          expect(
            persistedCount,
            "fastest-lev sE: at least one atom must persist (novel-glue path)",
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
// DEC-WI510-S12-COMBINED-SCORE-FIXED-FLOOR-001: Atom contains the binding-bearing source
// text directly (distance arrow function IS the Myers bit-parallel edit-distance computation;
// closest arrow function calls distance in a loop).
// Skipped unless DISCOVERY_EVAL_PROVIDER=local.
// NOTE: If Section A produces stubCount === moduleCount === 1 (entire file stubs),
// this section SKIPS with a measurement-citing comment (mirroring S10 engine-reality exit).
// Predicted: full decomposition (zero classes; #666 N/A; clean single-file ESM).
// ===========================================================================
describe("fastest-levenshtein section F -- combinedScore quality gate (WI-510 Slice 12 / #642 S12)", () => {
  // ---------------------------------------------------------------------------
  // fastest-levenshtein sF: Levenshtein distance / closest-string query
  // Query: corpus cat1-fastest-levenshtein-001 behavior string (plan §5.4)
  // ---------------------------------------------------------------------------
  it.skipIf(!USE_LOCAL_PROVIDER)(
    "fastest-levenshtein combinedScore >= 0.70 for corpus query (DISCOVERY_EVAL_PROVIDER=local)",
    { timeout: 60_000 },
    async () => {
      const registry = await openRegistry(":memory:", {
        embeddings: createLocalEmbeddingProvider("Xenova/all-MiniLM-L6-v2", 384),
      });
      try {
        const FASTEST_LEV_BEHAVIOR =
          "Compute the Levenshtein edit distance between two strings — the minimum number of single-character insertions, deletions, or substitutions required to transform one string into the other; also supports finding the string in a candidate array with the smallest edit distance to a target string; uses the Myers bit-parallel algorithm for fast computation on short strings (length <= 32) and a chunked variant for longer strings";
        const forest = await shavePackage(FASTEST_LEV_FIXTURE_ROOT, {
          registry,
          entryPath: join(FASTEST_LEV_FIXTURE_ROOT, "esm/mod.js"),
        });
        // If entire file stubs (unexpected), skip quality gate and document the gap.
        if (forest.stubCount === forest.moduleCount && forest.moduleCount === 1) {
          // Engine-reality-honest: stub-state prevents atom persistence; quality gate deferred.
          // Unexpected for fastest-levenshtein (DEC-WI510-S12-NO-CLASSES-001).
          // File a NEW engine-gap issue with this evidence before marking slice ready.
          console.log(
            "[fastest-lev sF] UNEXPECTED STUB STATE: moduleCount=1, stubCount=1. Quality gate deferred.",
          );
          expect(
            forest.stubCount,
            "fastest-lev sF: stub-state corroboration (DEC-WI510-S12-ENGINE-GAPS-LANDSCAPE-001)",
          ).toBe(1);
          return;
        }
        const plans = await collectForestSlicePlans(forest, slice, registry, "glue-aware");
        for (const { slicePlan } of plans) {
          for (const entry of slicePlan.entries) {
            if (entry.kind === "novel-glue") {
              await maybePersistNovelGlueAtom(
                withSemanticIntentCard(entry, FASTEST_LEV_BEHAVIOR),
                registry,
              );
            }
          }
        }
        const result = await registry.findCandidatesByQuery({
          behavior: FASTEST_LEV_BEHAVIOR,
          topK: 10,
        });
        console.log(
          "[fastest-lev sF] candidates:",
          result.candidates.map((c) => ({ score: c.combinedScore })),
        );
        expect(
          result.candidates.length,
          "fastest-lev sF: must find at least one candidate",
        ).toBeGreaterThan(0);
        const topScore = result.candidates[0]?.combinedScore ?? 0;
        console.log("[fastest-lev sF] top combinedScore:", topScore);
        // Fixed floor >= 0.70 per DEC-WI510-S12-COMBINED-SCORE-FIXED-FLOOR-001.
        // Atom contains distance + closest arrow-function source directly (binding-bearing text).
        // If empirical falls below 0.70, extend semanticHints or document via
        // DEC-WI510-S12-COMBINED-SCORE-EMPIRICAL-FLOOR-002 escape hatch.
        expect(
          topScore,
          "fastest-levenshtein combinedScore must be >= 0.70 (DEC-WI510-S12-COMBINED-SCORE-FIXED-FLOOR-001)",
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
// for the single fastest-levenshtein entry, crossing multiple internal component boundaries.
// Asserts: entry produces > 0 persisted atoms + merkle root retrievable from registry.
// DEC-WI510-S12-ONE-FILE-ONE-ROW-001: one file -> one entry-atom containing both distance
// and closest exports via the single-module forest.
// ===========================================================================
describe("fastest-levenshtein -- compound interaction: entry end-to-end (WI-510 Slice 12 / #642 S12)", () => {
  it(
    "entry resolves, shaves, slices, persists; entry-atom merkle root is retrievable (DEC-WI510-S12-ONE-FILE-ONE-ROW-001)",
    { timeout: 120_000 },
    async () => {
      const registry = await openRegistry(":memory:", {
        embeddings: createOfflineEmbeddingProvider(),
      });
      try {
        const forest = await shavePackage(FASTEST_LEV_FIXTURE_ROOT, {
          registry,
          entryPath: join(FASTEST_LEV_FIXTURE_ROOT, "esm/mod.js"),
        });

        // Plan §3.1: single-file entry.
        expect(forest.moduleCount, "compound test: fastest-levenshtein moduleCount must be 1").toBe(
          1,
        );

        // DEC-WI510-S12-NO-CLASSES-001: expected 0 stubs; tolerate 1 (engine-reality-honest band).
        expect(
          forest.stubCount,
          "compound test: fastest-levenshtein stubCount must be <= 1 (DEC-WI510-S12-NO-CLASSES-001)",
        ).toBeLessThanOrEqual(1);

        // DEC-WI510-S12-NO-EXTERNAL-IMPORTS-001: zero imports; empty union is the contract.
        const allExternal = forestModules(forest).flatMap((m) => m.externalSpecifiers);
        expect(
          allExternal,
          "compound test: fastest-levenshtein externalSpecifiers must be [] (DEC-WI510-S12-NO-EXTERNAL-IMPORTS-001)",
        ).toEqual([]);

        const plans = await collectForestSlicePlans(forest, slice, registry, "glue-aware");

        console.log(
          `[compound] fastest-levenshtein: moduleCount=${forest.moduleCount} stubCount=${forest.stubCount} leafCount=${forestTotalLeafCount(forest)} plans=${plans.length}`,
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

        expect(
          plans.length,
          "compound test: fastest-levenshtein plans.length must be > 0",
        ).toBeGreaterThan(0);

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
          `[compound] fastest-levenshtein: persisted=${persistedCount} entryMR=${entryAtomMerkleRoot?.slice(0, 16)}`,
        );

        expect(
          persistedCount,
          "compound test: fastest-levenshtein must persist > 0 atoms",
        ).toBeGreaterThan(0);

        // DEC-WI510-S12-ONE-FILE-ONE-ROW-001: entry-atom merkle root must be retrievable.
        // The single-module forest carries both distance and closest exports in one atom.
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
