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
import { join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { createOfflineEmbeddingProvider } from "@yakcc/contracts";
import { openRegistry } from "@yakcc/registry";
import { describe, expect, it } from "vitest";
import type { ShaveRegistryView } from "../types.js";
import {
  collectForestSlicePlans,
  forestModules,
  forestStubs,
  forestTotalLeafCount,
  shavePackage,
} from "./module-graph.js";
import { slice } from "./slicer.js";

const USE_LOCAL_PROVIDER = process.env.DISCOVERY_EVAL_PROVIDER === "local";

const FIXTURES_DIR = join(fileURLToPath(new URL("../__fixtures__/module-graph", import.meta.url)));
const LRU_CACHE_FIXTURE_ROOT = join(FIXTURES_DIR, "lru-cache-11.3.6");

const emptyRegistry: Pick<ShaveRegistryView, "findByCanonicalAstHash"> = {
  findByCanonicalAstHash: async () => [],
};

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
// Timeouts: per-it() 180_000ms (conservative; accommodates future engine fix rerun)
//           section D 360_000ms (two consecutive calls)
// ---------------------------------------------------------------------------
describe("lru-cache/dist/esm/index.js -- per-entry shave (WI-510 Slice 10 / #642 S10)", () => {
  it(
    "section A -- ENGINE-GAP CORROBORATION: moduleCount=0, stubCount=1 (private class fields #foo)",
    { timeout: 180_000 },
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
        "lru-cache ENGINE-GAP: moduleCount must be 0 (entry stubs; private class field gap; DEC-WI510-S10-PRIVATE-CLASS-FIELD-ENGINE-GAP-001)",
      ).toBe(0);
      expect(
        forest.stubCount,
        "lru-cache ENGINE-GAP: stubCount must be 1 (dist/esm/index.js stubs entirely; DEC-WI510-S10-PRIVATE-CLASS-FIELD-ENGINE-GAP-001)",
      ).toBe(1);
      // When the entry stubs, no modules are decomposed: forestTotalLeafCount=0.
      expect(
        forestTotalLeafCount(forest),
        "lru-cache ENGINE-GAP: forestTotalLeafCount must be 0 (entry stubs; no decomposed leaves)",
      ).toBe(0);
      // DEC-WI510-S10-EXTERNAL-SPECIFIERS-EXPECTATIONS-001 + DEC-WI510-S10-DYNAMIC-IMPORT-EMPIRICAL-001:
      // Entry stubs before BFS; no modules traversed; externalSpecifiers=[] across empty forest.
      // Outcome A confirmed: dynamic import('node:diagnostics_channel') not reached.
      expect(
        allExternal,
        "lru-cache externalSpecifiers must be [] (Outcome A: entry stubs before BFS traversal; DEC-WI510-S10-EXTERNAL-SPECIFIERS-EXPECTATIONS-001)",
      ).toEqual([]);
      // The stub node must reference the entry file path.
      const stubs = forestStubs(forest);
      expect(stubs, "lru-cache: exactly 1 stub expected").toHaveLength(1);
      expect(
        stubs[0]?.specifier,
        "lru-cache: stub specifier must reference dist/esm/index.js",
      ).toContain("index.js");
    },
  );

  it(
    "section B -- forest.nodes[0] is a stub node referencing lru-cache-11.3.6/dist/esm/index.js",
    { timeout: 180_000 },
    async () => {
      const forest = await shavePackage(LRU_CACHE_FIXTURE_ROOT, {
        registry: emptyRegistry,
        entryPath: join(LRU_CACHE_FIXTURE_ROOT, "dist/esm/index.js"),
      });
      const firstNode = forest.nodes[0];
      expect(firstNode).toBeDefined();
      // ENGINE-GAP CORROBORATION: entry stubs, so first node is a stub, not a module.
      // DEC-WI510-S10-PRIVATE-CLASS-FIELD-ENGINE-GAP-001
      expect(
        firstNode?.kind,
        "lru-cache ENGINE-GAP: first BFS node must be 'stub' (private class field gap; DEC-WI510-S10-PRIVATE-CLASS-FIELD-ENGINE-GAP-001)",
      ).toBe("stub");
      if (firstNode?.kind === "stub") {
        expect(firstNode.specifier, "lru-cache stub specifier must contain index.js").toContain(
          "index.js",
        );
        expect(
          firstNode.specifier,
          "lru-cache stub specifier must be inside lru-cache-11.3.6/",
        ).toContain("lru-cache-11.3.6");
      }
    },
  );

  it(
    "section C -- stub-state boundary check: forest has 0 modules, 1 stub, externalSpecifiers=[]",
    { timeout: 180_000 },
    async () => {
      const forest = await shavePackage(LRU_CACHE_FIXTURE_ROOT, {
        registry: emptyRegistry,
        entryPath: join(LRU_CACHE_FIXTURE_ROOT, "dist/esm/index.js"),
      });
      // ENGINE-GAP CORROBORATION: no modules in the forest (entry stubs).
      const modules = forestModules(forest);
      expect(
        modules,
        "lru-cache ENGINE-GAP: forest must have 0 modules (entry stubs entirely; DEC-WI510-S10-PRIVATE-CLASS-FIELD-ENGINE-GAP-001)",
      ).toHaveLength(0);
      // All in-boundary paths should be empty (no modules to check).
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
        "lru-cache stubs must be exactly 1 (entry stubs; DEC-WI510-S10-PRIVATE-CLASS-FIELD-ENGINE-GAP-001)",
      ).toHaveLength(1);
    },
  );

  it(
    "section D -- two-pass byte-identical determinism for lru-cache/dist/esm/index.js (stub state)",
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
      // Two-pass determinism must hold even for stub state.
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
        "lru-cache two-pass: BFS filePath list must be byte-identical (empty in stub state)",
      ).toEqual(paths2);
      const ext1 = forestModules(forest1).flatMap((m) => m.externalSpecifiers);
      const ext2 = forestModules(forest2).flatMap((m) => m.externalSpecifiers);
      expect(ext1, "lru-cache two-pass: externalSpecifiers must be byte-identical").toEqual(ext2);
      expect(
        forestTotalLeafCount(forest1),
        "lru-cache two-pass: forestTotalLeafCount must be identical (both 0 in stub state)",
      ).toBe(forestTotalLeafCount(forest2));
    },
  );

  it(
    "section E -- stub-state: collectForestSlicePlans returns 0 plans (no decomposed atoms to persist)",
    { timeout: 180_000 },
    async () => {
      const registry = await openRegistry(":memory:", {
        embeddings: createOfflineEmbeddingProvider(),
      });
      try {
        const forest = await shavePackage(LRU_CACHE_FIXTURE_ROOT, {
          registry,
          entryPath: join(LRU_CACHE_FIXTURE_ROOT, "dist/esm/index.js"),
        });
        // ENGINE-GAP CORROBORATION: stub-state entry produces no slice plans.
        // DEC-WI510-S10-PRIVATE-CLASS-FIELD-ENGINE-GAP-001: no modules decomposed -> no plans.
        // This section documents the gap state, not a happy-path persist test.
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
          "lru-cache ENGINE-GAP: collectForestSlicePlans must return 0 plans (entry stubs; DEC-WI510-S10-PRIVATE-CLASS-FIELD-ENGINE-GAP-001)",
        ).toBe(0);
        // Corroborate that the forest is in the expected stub state.
        expect(forest.moduleCount, "lru-cache sE: moduleCount must be 0").toBe(0);
        expect(forest.stubCount, "lru-cache sE: stubCount must be 1").toBe(1);
      } finally {
        await registry.close();
      }
    },
  );
});

// ===========================================================================
// Section F -- combinedScore quality gate (DEFERRED due to engine-gap stub state)
// DEC-WI510-S10-COMBINED-SCORE-STUB-STATE-002: Since dist/esm/index.js stubs entirely,
// no atoms are persisted and the combinedScore gate cannot fire on a real atom.
// The gate is documented as the post-engine-fix target (>= 0.70 fixed floor per
// DEC-WI510-S10-COMBINED-SCORE-FIXED-FLOOR-001). Skipped unless DISCOVERY_EVAL_PROVIDER=local.
// ===========================================================================
describe("lru-cache section F -- combinedScore quality gate (WI-510 Slice 10 / #642 S10)", () => {
  // ---------------------------------------------------------------------------
  // lru-cache ssF: LRU cache headline behavior query
  // NOTE: In stub-state, no atoms can be persisted and the combinedScore gate cannot fire.
  // This it.skipIf block documents the gap and the post-engine-fix target.
  // When the private-class-field engine gap is fixed (new engine WI), this test will:
  //   1. Persist the LRUCache atom via the novel-glue path.
  //   2. Assert combinedScore >= 0.70 for the LRU cache query.
  // DEC-WI510-S10-COMBINED-SCORE-STUB-STATE-002
  // ---------------------------------------------------------------------------
  it.skipIf(!USE_LOCAL_PROVIDER)(
    "lru-cache section F -- DEFERRED (stub state; no atoms to score; engine-gap post-fix target >= 0.70)",
    { timeout: 60_000 },
    async () => {
      // ENGINE-GAP STATE: dist/esm/index.js stubs entirely (DEC-WI510-S10-PRIVATE-CLASS-FIELD-ENGINE-GAP-001).
      // No atoms are persisted in stub state. combinedScore gate cannot fire.
      // This test documents the engine-gap state when DISCOVERY_EVAL_PROVIDER=local is set.
      // Post-engine-fix target: combinedScore >= 0.70 for the LRU cache query per
      // DEC-WI510-S10-COMBINED-SCORE-FIXED-FLOOR-001.
      //
      // BEHAVIOR TEXT (for post-fix run):
      //   "Bounded-size key-value cache with least-recently-used eviction; tracks recency on get and set;
      //    supports optional per-entry time-to-live with lazy expiration; supports optional max byte budget
      //    with size-aware eviction; provides get, set, has, delete, clear, and peek operations"
      //
      // For now, verify the engine-gap state is consistent under DISCOVERY_EVAL_PROVIDER=local.
      const registry = await openRegistry(":memory:", {
        embeddings: createOfflineEmbeddingProvider(),
      });
      try {
        const forest = await shavePackage(LRU_CACHE_FIXTURE_ROOT, {
          registry,
          entryPath: join(LRU_CACHE_FIXTURE_ROOT, "dist/esm/index.js"),
        });
        const plans = await collectForestSlicePlans(forest, slice, registry, "glue-aware");
        console.log(
          "[lru-cache sF] ENGINE-GAP stub state: moduleCount:",
          forest.moduleCount,
          "stubCount:",
          forest.stubCount,
          "plans:",
          plans.length,
        );
        // Corroborate stub state (DEC-WI510-S10-PRIVATE-CLASS-FIELD-ENGINE-GAP-001).
        expect(forest.moduleCount, "lru-cache sF: stub state moduleCount=0").toBe(0);
        expect(forest.stubCount, "lru-cache sF: stub state stubCount=1").toBe(1);
        expect(plans.length, "lru-cache sF: stub state plans=0").toBe(0);
        // combinedScore gate is deferred. When engine-gap is fixed, update this test:
        //   - persist the LRUCache atom via withSemanticIntentCard + maybePersistNovelGlueAtom
        //   - assert combinedScore >= 0.70 per DEC-WI510-S10-COMBINED-SCORE-FIXED-FLOOR-001
      } finally {
        await registry.close();
      }
    },
  );
});

// ===========================================================================
// Compound interaction test -- real production sequence end-to-end (stub-state)
// Plan ss5.1: exercises shavePackage -> collectForestSlicePlans through the full
// production path. In stub-state, asserts the deterministic empty-plans outcome.
// DEC-WI510-S10-PRIVATE-CLASS-FIELD-ENGINE-GAP-001: first production-fixture exercise
// revealing the private-class-field gap via the full compound path.
// ===========================================================================
describe("lru-cache -- compound interaction: LRUCache stub-state end-to-end (WI-510 Slice 10 / #642 S10)", () => {
  it(
    "LRUCache entry stubs entirely; compound path terminates cleanly with 0 plans (engine-gap corroboration)",
    { timeout: 180_000 },
    async () => {
      const registry = await openRegistry(":memory:", {
        embeddings: createOfflineEmbeddingProvider(),
      });
      try {
        const forest = await shavePackage(LRU_CACHE_FIXTURE_ROOT, {
          registry,
          entryPath: join(LRU_CACHE_FIXTURE_ROOT, "dist/esm/index.js"),
        });

        // ENGINE-GAP CORROBORATION: private class fields (#foo) in Stack and LRUCache
        // cause decompose() to stub dist/esm/index.js entirely.
        // DEC-WI510-S10-PRIVATE-CLASS-FIELD-ENGINE-GAP-001
        expect(forest.moduleCount, "compound: lru-cache ENGINE-GAP moduleCount must be 0").toBe(0);
        expect(forest.stubCount, "compound: lru-cache ENGINE-GAP stubCount must be 1").toBe(1);
        expect(
          forestTotalLeafCount(forest),
          "compound: lru-cache ENGINE-GAP forestTotalLeafCount must be 0",
        ).toBe(0);

        // No modules traversed: externalSpecifiers=[] (Outcome A confirmed).
        const allExternal = forestModules(forest).flatMap((m) => m.externalSpecifiers);
        expect(
          allExternal,
          "compound: externalSpecifiers must be [] (Outcome A; entry stubs before traversal)",
        ).toEqual([]);

        // Slice plans: stub-state produces no plans (no decomposed leaves).
        const plans = await collectForestSlicePlans(forest, slice, registry, "glue-aware");
        expect(
          plans.length,
          "compound: lru-cache ENGINE-GAP plans must be 0 (no decomposed modules)",
        ).toBe(0);

        console.log(
          `[compound] lru-cache ENGINE-GAP: moduleCount=${forest.moduleCount} stubCount=${forest.stubCount} leafCount=${forestTotalLeafCount(forest)} plans=${plans.length}`,
        );
        console.log(
          "[compound] lru-cache: stub specifiers:",
          forestStubs(forest).map((s) => s.specifier.split("/").slice(-3).join("/")),
        );
      } finally {
        await registry.close();
      }
    },
  );
});
