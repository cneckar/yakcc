// SPDX-License-Identifier: MIT
/**
 * lru-cache@11.3.6 headline bindings — engine-gap-corroboration shave tests (WI-510 Slice 10 / #642 S10)
 *
 * STRUCTURE:
 *   LRUCache class entry -- ENGINE-GAP CORROBORATION (1 describe: sections A-E)
 *     dist/esm/index.js -- TSC-emitted ESM; 1681 LOC; LRUCache class + ZeroArray + Stack
 *     EMPIRICAL RESULT: moduleCount=0, stubCount=1 — the engine stubs dist/esm/index.js entirely
 *     ROOT CAUSE: Private class field declarations (#max, #maxSize, #constructing, etc.) in both
 *       Stack and LRUCache classes. The engine's decompose() does not handle ECMAScript private
 *       class fields (#foo syntax; ClassElement with PrivateIdentifier name). This is a new engine-gap
 *       class: not #576 (ArrowFunctions), not #585 (UMD IIFE), not #619 (TSC CJS prelude).
 *     ACTION: Engine-gap corroboration tests per S8 Group A pattern. Slice ships engine-reality.
 *     New engine-gap issue filed per plan §9 / §5.6 criterion 18.
 *
 *   Section F (1 describe, 1 it.skipIf block) -- combinedScore quality gate.
 *     Skipped unless DISCOVERY_EVAL_PROVIDER=local.
 *     NOTE: Since dist/esm/index.js stubs entirely, no atoms are persisted. Section F records
 *     the stub-state corroboration: the quality gate cannot fire on this entry as-is.
 *     Fixed floor >= 0.70 is the target post-engine-fix; for now the gate SKIP records the gap.
 *     DEC-WI510-S10-COMBINED-SCORE-STUB-STATE-002: combined-score gate deferred to engine-fix WI.
 *
 *   Compound interaction test (1 describe) -- real production sequence end-to-end.
 *     Asserts the full shavePackage -> collectForestSlicePlans path on the stub-state entry.
 *     Verifies stub-corroboration state is deterministic and the forest is empty-plans (no novel-glue).
 *
 * Engine-gap evidence (new gap, to be filed as GitHub issue post-slice):
 *   File: packages/shave/src/__fixtures__/module-graph/lru-cache-11.3.6/dist/esm/index.js
 *   Classes: Stack (#constructing static private field), LRUCache (#max, #maxSize, #dispose, etc.)
 *   Private field count: Stack has 1 (#constructing), LRUCache has ~8+ (#max, #maxSize, #dispose,
 *     #onInsert, #disposeAfter, etc.)
 *   ECMAScript private field syntax: ClassElement.key = PrivateIdentifier (#foo)
 *   Engine behavior: decompose() stubs the entire file (moduleCount=0, stubCount=1) when the
 *     source contains private class field declarations. The #576 fix handled ArrowFunctions in
 *     class bodies; private class field syntax is a NEW class-body shape the post-#576 engine
 *     still cannot decompose.
 *   Affected engine path: packages/shave/src/universalize/recursion.ts — ClassDeclaration/
 *     ClassExpression walk descends into body members; PrivateIdentifier key in field declarations
 *     is not handled in the member-walk path.
 *   First occurrence: WI-510 Slice 10 is the first WI-510 production fixture with private class
 *     fields. The synthetic test fixtures (atom-test.ts etc.) did not include #foo patterns.
 *   Resolution: out of scope for Slice 10 (engine frozen after Slice 1, per DEC-WI510-S10-ENGINE-GAPS-LANDSCAPE-001).
 *     File engine-gap issue; Slice 10 ships with stub-corroboration assertions.
 *
 * Engine-gap landscape (DEC-WI510-S10-ENGINE-GAPS-LANDSCAPE-001):
 *   #576 CLOSED (b5dff3a / PR #604) — arrow-returns-arrow HOF in class bodies. NOT this gap.
 *   #585 CLOSED (cbefa3c / PR #627) — UMD IIFE walk via ParenthesizedExpression. NOT relevant.
 *   #619 CLOSED (dual-group engine-gap-honest pattern) — TS-compiled CJS prelude. NOT relevant.
 *   NEW ENGINE GAP (filed post-slice): private class field declarations (#foo syntax) defeat
 *     decompose() on the entire containing class, causing moduleCount=0, stubCount=1 for the
 *     entry file. Affects lru-cache@11.3.6 dist/esm/index.js and any other package with #-fields.
 *
 * @decision DEC-WI510-S10-PER-ENTRY-SHAVE-001
 *   title: Slice 10 shaves the LRUCache class entry per-entry, not via the published '.' default
 *   status: accepted
 *   rationale: Inherits per-entry discipline of Slices 2-9. One shavePackage({ entryPath:
 *   'dist/esm/index.js' }) call. The published '.' default resolves to dist/commonjs/index.min.js
 *   (minified CJS). We point at dist/esm/index.js directly. Engine-gap-corroboration pattern
 *   applies (S8 Group A): the entry stubs entirely due to private class fields.
 *
 * @decision DEC-WI510-S10-ENTRY-PATH-DIST-ESM-001
 *   title: Slice 10 entry is dist/esm/index.js (NOT dist/commonjs/index.js, NOT dist/esm/index.min.js)
 *   status: accepted
 *   rationale: Three options evaluated. Path A (chosen): dist/esm/index.js — TSC-emitted ESM with
 *   clean import/export/class; no __createBinding prelude; class-body decomposition path post-#576.
 *   Path B: dist/commonjs/index.js — TSC-emitted CJS with __createBinding prelude that defeats
 *   strict-subset decomposition per #619. Path C: dist/esm/index.min.js — minified. Chosen path:
 *   cleanest engine-tractability once the private-class-field engine-gap is fixed (new issue).
 *
 * @decision DEC-WI510-S10-ONE-CLASS-ONE-ROW-001
 *   title: Slice 10 ships ONE corpus row (cat1-lru-cache-001) for the LRUCache class headline
 *   status: accepted
 *   rationale: The LRUCache class IS the binding surface. Corpus row is a behavior-only marker
 *   (expectedAtom: null); atom will be populated once the private-class-field engine-gap is fixed.
 *   Mirrors S8's array-each corpus row (no viable atom due to engine gap; row is pure behavior marker).
 *
 * @decision DEC-WI510-S10-VERSION-PIN-001
 *   title: Pin to lru-cache@11.3.6 (current latest dist-tag at 2026-05-17)
 *   status: accepted
 *   rationale: v11 is the modern dual-ESM/CJS tshy-published line; engines.node >= 20; current
 *   latest. v10/v9/v8/v7 also tshy-published but with different export shapes. v11 atom keying
 *   matches what fresh npm install lru-cache lands on.
 *
 * @decision DEC-WI510-S10-FIXTURE-TRIMMED-VENDOR-001
 *   title: Vendor a TRIMMED 7-file subset of the lru-cache-11.3.6 published tarball (89 -> 7 files)
 *   status: accepted
 *   rationale: Full tarball is 89 files (~2.7 MB). Only 3 ESM source files are transitively
 *   reachable from dist/esm/index.js. Trimmed vendor: dist/esm/index.js + dist/esm/diagnostics-channel.js
 *   + dist/esm/perf.js + root package.json + dist/esm/package.json + LICENSE.md + PROVENANCE.md.
 *
 * @decision DEC-WI510-S10-INNER-PACKAGE-JSON-INCLUDED-001
 *   title: The inner dist/esm/package.json ({"type":"module"} marker) IS included in the trimmed vendor
 *   status: accepted
 *   rationale: tshy-published packages emit an inner package.json at each dist/<format>/ boundary.
 *   Matching the published tarball exactly avoids fixture-vs-published divergence.
 *
 * @decision DEC-WI510-S10-CLASS-BODY-FIRST-PRODUCTION-EXERCISE-001
 *   title: Slice 10 is the first WI-510 PRODUCTION-fixture exercise revealing the private-class-field engine gap
 *   status: accepted
 *   rationale: Prior slices touched class declarations without private #-fields. Slice 10 exercises
 *   the post-#576 engine on LRUCache (Stack.#constructing, LRUCache.#max, .#maxSize, etc.). The
 *   engine stubs the entire file (moduleCount=0, stubCount=1). Engine-reality-honest per S8 dispatch
 *   contract: assert empirical stub state, file new engine-gap issue, proceed. Engine source frozen.
 *   The private-class-field gap is a NEW gap class beyond #576/#585/#619.
 *
 * @decision DEC-WI510-S10-DYNAMIC-IMPORT-EMPIRICAL-001
 *   title: import('node:diagnostics_channel') dynamic import in diagnostics-channel.js: Outcome A ([])
 *   status: accepted
 *   rationale: The engine's entry stubs before BFS can traverse diagnostics-channel.js or perf.js.
 *   In the non-stub case (post-engine-fix), Outcome A ([]) is the expected state: extractImportSpecifiers
 *   walks only static ImportDeclaration nodes; dynamic import() CallExpression is invisible to BFS.
 *   Outcome A recorded as canonical per plan §1.7.
 *
 * @decision DEC-WI510-S10-ENGINE-GAPS-LANDSCAPE-001
 *   title: Engine gaps #576/#585/#619 all closed; Slice 10 surfaces a NEW private-class-field gap
 *   status: accepted
 *   rationale: #576 closed (ArrowFunctions), #585 closed (UMD IIFE), #619 closed (TSC CJS prelude).
 *   Slice 10's ESM path doesn't exercise #585 or #619. #576 is relevant but the private-class-field
 *   gap is distinct: it manifests as PrivateIdentifier in ClassElement.key, not ArrowFunction in
 *   class body. NEW gap filed post-slice.
 *
 * @decision DEC-WI510-S10-MODERN-PRIMITIVES-001
 *   title: LRUCache uses AbortSignal, Symbol('type'), Map, Set, process; engine treats as opaque refs
 *   status: accepted
 *   rationale: Same regime as S9 WeakMap/WeakRef/FinalizationRegistry/AbortSignal. These primitives
 *   are opaque identifier references that do not trigger stubbing by themselves. The stubbing is
 *   caused by private class fields (#foo), not these primitives.
 *
 * @decision DEC-WI510-S10-EXTERNAL-SPECIFIERS-EXPECTATIONS-001
 *   title: externalSpecifiers=[] for entry and transitives; dynamic import Outcome A confirmed
 *   status: accepted
 *   rationale: dist/esm/index.js stubs before BFS traversal; externalSpecifiers=[] across all.
 *   The dynamic import('node:diagnostics_channel') in diagnostics-channel.js is not reached.
 *   Outcome A ([]) confirmed as engine-reality.
 *
 * @decision DEC-WI510-S10-COMBINED-SCORE-FIXED-FLOOR-001
 *   title: combinedScore quality gate uses canonical >= 0.70 fixed floor (deferred to engine-fix WI)
 *   status: accepted
 *   rationale: Since dist/esm/index.js stubs entirely, no atoms are persisted and the combinedScore
 *   gate cannot fire against a real atom. The gate is documented as the post-engine-fix target.
 *   DEC-WI510-S10-COMBINED-SCORE-STUB-STATE-002 records that the gate is skipped in stub-state.
 *
 * @decision DEC-WI510-S10-COMBINED-SCORE-STUB-STATE-002
 *   title: combinedScore gate cannot fire in stub-state; deferred to engine-fix follow-up WI
 *   status: accepted
 *   rationale: With moduleCount=0 and forestTotalLeafCount=0, no novel-glue atoms exist to persist.
 *   The Section F it.skipIf block documents this as the gap state. The >= 0.70 floor remains the
 *   target for the post-engine-fix run. This matches S8's approach: array-each has no atom; the
 *   corpus row is a pure behavior-only marker.
 *
 * @decision DEC-WI510-S10-PRIVATE-CLASS-FIELD-ENGINE-GAP-001
 *   title: Engine cannot decompose files with private class field declarations (#foo); stub-state recorded
 *   status: accepted
 *   rationale: ECMAScript private class fields (ClassElement.key = PrivateIdentifier) in Stack
 *   (#constructing) and LRUCache (#max, #maxSize, #dispose, etc.) cause decompose() to stub the
 *   entire containing file. This is a new gap class. The engine-gap-corroboration test pattern
 *   (S8 Group A) locks in the empirical behavior so a future fix surfaces as an intentional assertion
 *   update. Slice 10 ships with: moduleCount=0, stubCount=1, forestTotalLeafCount=0. Engine source frozen.
 */

/**
 * @decision DEC-WI510-S10-PRIVATE-CLASS-FIELD-ENGINE-FIX-FLIP-001
 * title: lru-cache-headline-bindings.test.ts flipped from engine-gap-corroboration to post-fix
 * status: accepted
 * rationale:
 *   WI-666 (closes #666) fixed decompose() to handle ArrowFunction with nested ConditionalExpression
 *   expression body. Root cause (§P6 probe): Node at [1301,1558) kind=ArrowFunction with 5 CF
 *   boundaries and no decomposable children under the old code. Fix in recursion.ts: expression-body
 *   ArrowFunction now returns [body] for any defined non-Block body (DEC-SHAVE-PRIVATE-CLASS-FIELD-001).
 *   Assertion flip (evaluation contract gate 1): moduleCount>=3, stubCount=0,
 *   forestTotalLeafCount>0, first node kind='module', plans.length>0.
 *   Previous DEC headers (DEC-WI510-S10-*) preserved as historical record of the gap state.
 * consequences:
 *   - Slice 10 acceptance graduates from engine-reality-honest (PR #663) to fully-decomposed
 *   - Combined-score fixed floor 0.70 (DEC-WI510-S10-COMBINED-SCORE-FIXED-FLOOR-001) now binding
 * closes #666
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
const LRU_CACHE_FIXTURE_ROOT = join(FIXTURES_DIR, "lru-cache-11.3.6");

const emptyRegistry: Pick<ShaveRegistryView, "findByCanonicalAstHash"> = {
  findByCanonicalAstHash: async () => [],
};

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
    notes: ["WI-510 Slice 10 section F semantic intent card for combinedScore quality gate"],
    modelVersion: STATIC_MODEL_TAG,
    promptVersion: STATIC_PROMPT_VERSION,
    sourceHash: sourceHash(entry.source),
    extractedAt: "2026-05-17T00:00:00.000Z",
  };
  return { ...entry, intentCard: semanticCard };
}

// ===========================================================================
// lru-cache@11.3.6 -- LRUCache class entry (bounded-size LRU cache with TTL)
// Entry: dist/esm/index.js (TSC-emitted ESM; 1681 LOC; "type": "module")
// EMPIRICAL: moduleCount=0, stubCount=1 — ENGINE-GAP CORROBORATION
// Root cause: Private class fields (#constructing in Stack, #max/#maxSize/#dispose/etc. in LRUCache)
//   cause decompose() to stub the entire file. New engine-gap class (not #576/#585/#619).
//   Filed as new issue post-slice. Engine source frozen for Slice 10.
// DEC-WI510-S10-PRIVATE-CLASS-FIELD-ENGINE-GAP-001
// ===========================================================================

// ---------------------------------------------------------------------------
// lru-cache/dist/esm/index.js -- sections A-E (ENGINE-GAP CORROBORATION)
// Timeouts: per-it() 300_000ms (conservative; accommodates future engine fix rerun)
//           section D 360_000ms (two consecutive calls)
// ---------------------------------------------------------------------------
describe("lru-cache/dist/esm/index.js -- per-entry shave (WI-510 Slice 10 / #642 S10 / post-fix #666)", () => {
  it(
    "section A -- post-fix #666: moduleCount>=3, stubCount=0, forestTotalLeafCount>0",
    { timeout: 300_000 },
    async () => {
      const forest = await shavePackage(LRU_CACHE_FIXTURE_ROOT, {
        registry: emptyRegistry,
        entryPath: join(LRU_CACHE_FIXTURE_ROOT, "dist/esm/index.js"),
      });
      console.log("[lru-cache sA] moduleCount:", forest.moduleCount);
      console.log("[lru-cache sA] stubCount:", forest.stubCount);
      console.log(
        "[lru-cache sA] stubs:",
        forestStubs(forest).map((s) => s.specifier),
      );
      console.log("[lru-cache sA] forestTotalLeafCount:", forestTotalLeafCount(forest));
      const allExternal = forestModules(forest).flatMap((m) => m.externalSpecifiers);
      console.log("[lru-cache sA] externalSpecifiers:", allExternal);

      // ENGINE-GAP CORROBORATION: DEC-WI510-S10-PRIVATE-CLASS-FIELD-ENGINE-GAP-001
      // Empirical first-run result (2026-05-17): moduleCount=0, stubCount=1.
      // Root cause: ECMAScript private class field declarations (#foo) in Stack (#constructing)
      // and LRUCache (#max, #maxSize, #dispose, #onInsert, #disposeAfter, etc.) cause decompose()
      // to stub the entire 1681-LOC file. This is a new engine-gap class: not #576 (ArrowFunctions),
      // not #585 (UMD IIFE), not #619 (TSC CJS prelude). Filed as a new engine-gap issue post-slice.
      // Engine source is FROZEN for Slice 10 (DEC-WI510-S10-ENGINE-GAPS-LANDSCAPE-001).
      // These corroboration assertions LOCK IN the empirical state so a future engine fix surfaces
      // as an intentional assertion update (with a fresh DEC), not a silent regression.
      expect(
        forest.moduleCount,
        "lru-cache post-fix #666: moduleCount must be >=3 (index.js + diagnostics-channel.js + perf.js; DEC-SHAVE-PRIVATE-CLASS-FIELD-001)",
      ).toBeGreaterThanOrEqual(3);
      expect(
        forest.stubCount,
        "lru-cache post-fix #666: stubCount must be 0 (all modules decompose; DEC-SHAVE-PRIVATE-CLASS-FIELD-001)",
      ).toBe(0);
      // Post-fix: all modules decompose; forestTotalLeafCount > 0.
      expect(
        forestTotalLeafCount(forest),
        "lru-cache post-fix #666: forestTotalLeafCount must be >0 (modules decomposed; DEC-SHAVE-PRIVATE-CLASS-FIELD-001)",
      ).toBeGreaterThan(0);
      // DEC-WI510-S10-EXTERNAL-SPECIFIERS-EXPECTATIONS-001 + DEC-WI510-S10-DYNAMIC-IMPORT-EMPIRICAL-001:
      // Entry stubs before BFS; no modules traversed; externalSpecifiers=[] across empty forest.
      // Outcome A confirmed: dynamic import('node:diagnostics_channel') not reached.
      expect(
        allExternal,
        "lru-cache externalSpecifiers must be [] (Outcome A: entry stubs before BFS traversal; DEC-WI510-S10-EXTERNAL-SPECIFIERS-EXPECTATIONS-001)",
      ).toEqual([]);
      // Post-fix: no stubs; all 3 modules decompose.
      const stubs = forestStubs(forest);
      expect(
        stubs,
        "lru-cache post-fix #666: 0 stubs expected (all modules decompose)",
      ).toHaveLength(0);
    },
  );

  it(
    "section B -- post-fix #666: forest.nodes[0] is a module node (not stub) for lru-cache-11.3.6/dist/esm/index.js",
    { timeout: 300_000 },
    async () => {
      const forest = await shavePackage(LRU_CACHE_FIXTURE_ROOT, {
        registry: emptyRegistry,
        entryPath: join(LRU_CACHE_FIXTURE_ROOT, "dist/esm/index.js"),
      });
      const firstNode = forest.nodes[0];
      expect(firstNode).toBeDefined();
      // Post-fix #666: entry decomposes, so first node is a module, not a stub.
      // DEC-SHAVE-PRIVATE-CLASS-FIELD-001
      expect(
        firstNode?.kind,
        "lru-cache post-fix #666: first BFS node must be 'module' (entry decomposes; DEC-SHAVE-PRIVATE-CLASS-FIELD-001)",
      ).toBe("module");
      if (firstNode?.kind === "module") {
        expect(firstNode.filePath, "lru-cache module filePath must contain index.js").toContain(
          "index.js",
        );
        expect(
          firstNode.filePath,
          "lru-cache module filePath must be inside lru-cache-11.3.6/",
        ).toContain("lru-cache-11.3.6");
      }
    },
  );

  it(
    "section C -- post-fix #666: forest has >=3 modules, 0 stubs, externalSpecifiers=[]",
    { timeout: 300_000 },
    async () => {
      const forest = await shavePackage(LRU_CACHE_FIXTURE_ROOT, {
        registry: emptyRegistry,
        entryPath: join(LRU_CACHE_FIXTURE_ROOT, "dist/esm/index.js"),
      });
      // Post-fix #666: all modules decompose; >= 3 modules in the forest.
      const modules = forestModules(forest);
      expect(
        modules.length,
        "lru-cache post-fix #666: forest must have >=3 modules (all decompose; DEC-SHAVE-PRIVATE-CLASS-FIELD-001)",
      ).toBeGreaterThanOrEqual(3);
      // Post-fix: all modules are in-boundary (within lru-cache-11.3.6/).
      for (const fp of modules.map((m) => m.filePath)) {
        expect(
          normalize(fp),
          `lru-cache module path must be inside lru-cache-11.3.6/: ${fp}`,
        ).toContain("lru-cache-11.3.6");
      }
      const allExternal = modules.flatMap((m) => m.externalSpecifiers);
      expect(
        allExternal,
        "lru-cache externalSpecifiers must be [] (no traversed modules; DEC-WI510-S10-EXTERNAL-SPECIFIERS-EXPECTATIONS-001)",
      ).toEqual([]);
      const stubs = forestStubs(forest);
      expect(
        stubs,
        "lru-cache post-fix #666: stubs must be 0 (all modules decompose; DEC-SHAVE-PRIVATE-CLASS-FIELD-001)",
      ).toHaveLength(0);
    },
  );

  it(
    "section D -- two-pass byte-identical determinism for lru-cache/dist/esm/index.js (post-fix #666)",
    { timeout: 360_000 },
    async () => {
      const forest1 = await shavePackage(LRU_CACHE_FIXTURE_ROOT, {
        registry: emptyRegistry,
        entryPath: join(LRU_CACHE_FIXTURE_ROOT, "dist/esm/index.js"),
      });
      const forest2 = await shavePackage(LRU_CACHE_FIXTURE_ROOT, {
        registry: emptyRegistry,
        entryPath: join(LRU_CACHE_FIXTURE_ROOT, "dist/esm/index.js"),
      });
      // Two-pass determinism must hold post-fix (non-stub state).
      expect(forest1.moduleCount, "lru-cache two-pass: moduleCount must be identical").toBe(
        forest2.moduleCount,
      );
      expect(forest1.stubCount, "lru-cache two-pass: stubCount must be identical").toBe(
        forest2.stubCount,
      );
      const paths1 = forestModules(forest1).map((m) => normalize(m.filePath));
      const paths2 = forestModules(forest2).map((m) => normalize(m.filePath));
      expect(
        paths1,
        "lru-cache two-pass: BFS filePath list must be byte-identical (3 modules post-fix)",
      ).toEqual(paths2);
      const ext1 = forestModules(forest1).flatMap((m) => m.externalSpecifiers);
      const ext2 = forestModules(forest2).flatMap((m) => m.externalSpecifiers);
      expect(ext1, "lru-cache two-pass: externalSpecifiers must be byte-identical").toEqual(ext2);
      expect(
        forestTotalLeafCount(forest1),
        "lru-cache two-pass: forestTotalLeafCount must be identical (both >0 post-fix)",
      ).toBe(forestTotalLeafCount(forest2));
    },
  );

  it(
    "section E -- post-fix #666: collectForestSlicePlans returns >0 plans (modules decomposed)",
    { timeout: 300_000 },
    async () => {
      const registry = await openRegistry(":memory:", {
        embeddings: createOfflineEmbeddingProvider(),
      });
      try {
        const forest = await shavePackage(LRU_CACHE_FIXTURE_ROOT, {
          registry,
          entryPath: join(LRU_CACHE_FIXTURE_ROOT, "dist/esm/index.js"),
        });
        // Post-fix #666: modules decompose; collectForestSlicePlans returns >0 plans.
        // DEC-SHAVE-PRIVATE-CLASS-FIELD-001
        const plans = await collectForestSlicePlans(forest, slice, registry, "glue-aware");
        console.log("[lru-cache sE] plans.length:", plans.length);
        console.log(
          "[lru-cache sE] moduleCount:",
          forest.moduleCount,
          "stubCount:",
          forest.stubCount,
        );
        expect(
          plans.length,
          "lru-cache post-fix #666: collectForestSlicePlans must return >0 plans (modules decomposed; DEC-SHAVE-PRIVATE-CLASS-FIELD-001)",
        ).toBeGreaterThan(0);
        // Post-fix: modules decomposed, no stubs.
        expect(
          forest.moduleCount,
          "lru-cache post-fix sE: moduleCount must be >=3",
        ).toBeGreaterThanOrEqual(3);
        expect(forest.stubCount, "lru-cache post-fix sE: stubCount must be 0").toBe(0);
      } finally {
        await registry.close();
      }
    },
  );
});

// ===========================================================================
// Section F -- combinedScore quality gate (post-fix #666 / DEC-WI510-S10-COMBINED-SCORE-FIXED-FLOOR-001)
// Engine gap closed: dist/esm/index.js now decomposes (moduleCount>=3, stubCount=0).
// Novel-glue atoms persist via the glue-aware path; combinedScore >= 0.70 fixed floor is binding.
// Skipped unless DISCOVERY_EVAL_PROVIDER=local.
// ===========================================================================
describe("lru-cache section F -- combinedScore quality gate (WI-510 Slice 10 / #642 S10)", () => {
  // ---------------------------------------------------------------------------
  // lru-cache ssF: LRU cache headline behavior + combinedScore quality gate
  // Post-fix #666: engine decomposes dist/esm/index.js; novel-glue atoms can be persisted.
  // Asserts combinedScore >= 0.70 (DEC-WI510-S10-COMBINED-SCORE-FIXED-FLOOR-001).
  // ---------------------------------------------------------------------------
  it.skipIf(!USE_LOCAL_PROVIDER)(
    "lru-cache section F -- post-fix #666: combinedScore >= 0.70 for LRUCache headline behavior (DISCOVERY_EVAL_PROVIDER=local)",
    { timeout: 300_000 },
    async () => {
      const provider = createLocalEmbeddingProvider("Xenova/all-MiniLM-L6-v2", 384);
      const registry = await openRegistry(":memory:", { embeddings: provider });
      try {
        const forest = await shavePackage(LRU_CACHE_FIXTURE_ROOT, {
          registry,
          entryPath: join(LRU_CACHE_FIXTURE_ROOT, "dist/esm/index.js"),
        });
        const plans = await collectForestSlicePlans(forest, slice, registry, "glue-aware");
        console.log(
          "[lru-cache sF] post-fix state: moduleCount:",
          forest.moduleCount,
          "stubCount:",
          forest.stubCount,
          "plans:",
          plans.length,
          "forestTotalLeafCount:",
          forestTotalLeafCount(forest),
        );
        // Post-fix gates (DEC-SHAVE-PRIVATE-CLASS-FIELD-001):
        expect(forest.moduleCount, "lru-cache sF post-fix: moduleCount>=3").toBeGreaterThanOrEqual(
          3,
        );
        expect(forest.stubCount, "lru-cache sF post-fix: stubCount=0").toBe(0);
        expect(
          forestTotalLeafCount(forest),
          "lru-cache sF post-fix: forestTotalLeafCount>0",
        ).toBeGreaterThan(0);
        expect(plans.length, "lru-cache sF post-fix: plans.length>0").toBeGreaterThan(0);
        // combinedScore >= 0.70 gate (DEC-WI510-S10-COMBINED-SCORE-FIXED-FLOOR-001).
        for (const { slicePlan } of plans) {
          for (const entry of slicePlan.entries) {
            if (entry.kind === "novel-glue") {
              const withCard = withSemanticIntentCard(
                entry,
                "Cache recently used key-value pairs with configurable max size and TTL, evicting the least-recently-used entry when the limit is exceeded",
                [
                  "Maintains bounded-size cache with O(1) get/set via Map + doubly-linked-list",
                  "get() returns cached value and updates recency; set() adds or updates an entry",
                  "Supports TTL expiration and a dispose() callback on eviction",
                ],
              );
              const result = await maybePersistNovelGlueAtom(withCard, registry);
              if (result !== undefined) {
                console.log("[lru-cache sF] combinedScore:", result.combinedScore);
                expect(
                  result.combinedScore,
                  "lru-cache section F: combinedScore must be >= 0.70 (DEC-WI510-S10-COMBINED-SCORE-FIXED-FLOOR-001)",
                ).toBeGreaterThanOrEqual(0.7);
              }
            }
          }
        }
      } finally {
        await registry.close();
      }
    },
  );
});

// ===========================================================================
// Compound interaction test -- real production sequence end-to-end (post-fix #666)
// Plan ss5.1: exercises shavePackage -> collectForestSlicePlans through the full
// production path. Post-fix: asserts moduleCount>=3, stubCount=0, plans>0.
// DEC-SHAVE-PRIVATE-CLASS-FIELD-001: engine fix closes the private-class-field gap.
// DEC-WI510-S10-PRIVATE-CLASS-FIELD-ENGINE-GAP-001: historical (gap now fixed).
// ===========================================================================
describe("lru-cache -- compound interaction: LRUCache post-fix decomposition end-to-end (WI-510 Slice 10 / #642 S10 / post-fix #666)", () => {
  it(
    "LRUCache entry decomposes; compound path produces modules and slice plans (post-fix #666)",
    { timeout: 300_000 },
    async () => {
      const registry = await openRegistry(":memory:", {
        embeddings: createOfflineEmbeddingProvider(),
      });
      try {
        const forest = await shavePackage(LRU_CACHE_FIXTURE_ROOT, {
          registry,
          entryPath: join(LRU_CACHE_FIXTURE_ROOT, "dist/esm/index.js"),
        });

        // Post-fix #666: engine decomposes dist/esm/index.js successfully.
        // DEC-SHAVE-PRIVATE-CLASS-FIELD-001: ArrowFunction expression-body descent fix.
        expect(
          forest.moduleCount,
          "compound: lru-cache post-fix moduleCount>=3",
        ).toBeGreaterThanOrEqual(3);
        expect(forest.stubCount, "compound: lru-cache post-fix stubCount=0").toBe(0);
        expect(
          forestTotalLeafCount(forest),
          "compound: lru-cache post-fix forestTotalLeafCount>0",
        ).toBeGreaterThan(0);

        // Post-fix: all 3 modules traverse; static imports only; externalSpecifiers=[] (Outcome A).
        const allExternal = forestModules(forest).flatMap((m) => m.externalSpecifiers);
        expect(
          allExternal,
          "compound: externalSpecifiers must be [] (Outcome A: static imports only, no external pkg imports; DEC-WI510-S10-EXTERNAL-SPECIFIERS-EXPECTATIONS-001)",
        ).toEqual([]);

        // Post-fix: modules decompose; plans are generated.
        const plans = await collectForestSlicePlans(forest, slice, registry, "glue-aware");
        expect(
          plans.length,
          "compound: lru-cache post-fix: plans.length>0 (modules decomposed; DEC-SHAVE-PRIVATE-CLASS-FIELD-001)",
        ).toBeGreaterThan(0);

        console.log(
          `[compound] lru-cache post-fix #666: moduleCount=${forest.moduleCount} stubCount=${forest.stubCount} leafCount=${forestTotalLeafCount(forest)} plans=${plans.length}`,
        );
        console.log(
          "[compound] lru-cache post-fix: stub count (expected 0):",
          forestStubs(forest).length,
        );
      } finally {
        await registry.close();
      }
    },
  );
});
