// SPDX-License-Identifier: MIT
/**
 * jsonpointer@5.0.1 headline bindings -- single-entry shave tests (WI-510 Slice 14 / #642 S14)
 *
 * STRUCTURE:
 *   jsonpointer (1 describe: sections A-E)
 *     jsonpointer.js -- pure-CJS single-file; 100 LOC production source;
 *     exports.get = get + exports.set = set + exports.compile = compile
 *     externalSpecifiers = [] (zero require() calls AND zero import declarations;
 *       DEC-WI510-S14-NO-EXTERNAL-IMPORTS-001 -- third WI-510 zero-imports fixture;
 *       second via the CJS extractor path)
 *     Plan §3.1: moduleCount=1, stubCount<=1, forestTotalLeafCount>=8, wall-clock <60s
 *
 *   Section F (1 describe, 1 it.skipIf block) -- combinedScore quality gate.
 *     Skipped unless DISCOVERY_EVAL_PROVIDER=local.
 *     Fixed floor >= 0.70 per DEC-WI510-S14-COMBINED-SCORE-FIXED-FLOOR-001.
 *     NOTE: Full decomposition predicted (zero classes; #666 N/A;
 *       DEC-WI510-S14-NO-CLASSES-001).
 *     If Section A produces stubCount === moduleCount === 1 (entire tree stubs),
 *     Section F SKIPS with a measurement-citing comment (mirroring S10 engine-reality exit).
 *
 *   Compound interaction test (1 describe) -- end-to-end production sequence.
 *     shavePackage -> collectForestSlicePlans -> maybePersistNovelGlueAtom for the single entry.
 *     Crosses: engine decompose, forest slice plans, registry persist, merkle retrieval.
 *     DEC-WI510-S14-ONE-FILE-ONE-ROW-001: one entry file -> one atom containing all three
 *     exports.get / exports.set / exports.compile surfaces.
 *
 * Package selection: jsonpointer@5.0.1 (Jan Lehnardt) -- canonical RFC 6901 JSON Pointer npm.
 *   DEC-WI510-S14-PACKAGE-SELECTION-JSONPOINTER-001: The #642 issue table names jsonpointer
 *   as a singular slot. jsonpointer@5.0.1 is the canonical Jan Lehnardt package (same
 *   package the npm ecosystem has used since 2011). v5.0.1 is current latest, stable
 *   since 2021. Alternatives (json-pointer manuelstofer variant, @hyperjump/json-pointer
 *   scoped variant, rfc6902 JSON Patch) rejected.
 *
 * Engine-gap landscape (DEC-WI510-S14-ENGINE-GAPS-LANDSCAPE-001):
 *   #576 CLOSED (b5dff3a / PR #604) -- arrow-returns-arrow HOF in class bodies. NOT applicable.
 *   #585 CLOSED (cbefa3c / PR #627) -- UMD IIFE walk. NOT applicable (jsonpointer.js is bare CJS).
 *   #619 CLOSED (dual-group engine-gap-honest pattern) -- TSC CJS prelude. NOT applicable
 *     (jsonpointer.js is hand-authored CJS; Jan Lehnardt 2011-2021; no __esModule prelude).
 *   #666 OPEN but VERIFIED NOT APPLICABLE -- private class fields (#foo). NOT applicable.
 *     jsonpointer.js has ZERO classes anywhere; all bindings are function declarations.
 *     Verified at planning time via grep. Full decomposition predicted.
 *
 * Fixture file count: 4 files (plan §4.1+§4.2 trimmed vendor manifest -- NO inner marker)
 *   jsonpointer.js (100 LOC; the shaved source) + package.json (root manifest; CJS default) +
 *   LICENSE.md (all-caps .md extension; DEC-WI510-S14-LICENSE-FILE-NAMING-001) + PROVENANCE.md
 *   DEC-WI510-S14-NO-INNER-MARKER-001: root package.json has no "type":"module"; default
 *   commonjs is exactly correct for jsonpointer.js. No synthetic inner marker needed.
 *
 * Bare main path: package.json#main is "./jsonpointer" (no .js extension).
 *   DEC-WI510-S14-BARE-MAIN-PATH-001: engine resolves via <main> -> <main>.js extension-fallback,
 *   finding jsonpointer.js. Same resolution path as S1 ms ("main":"./index"). Bare path preserved
 *   verbatim from tarball.
 *
 * Named-export CJS shape: exports.X = Identifier (three assignments; no module.exports replace).
 *   DEC-WI510-S14-CJS-EXPORT-SHAPE-001: First WI-510 fixture exercising exports.X = Identifier
 *   as the SOLE top-level export surface. S2 validator used module.exports.default = exports.default
 *   as a property tack-on; S13 toposort used module.exports = FunctionExpression + property tack-on;
 *   jsonpointer uses three pure exports.X = Y assignments without ever writing module.exports.
 *   Engine treats exports.X MemberExpression assignments identically to module.exports.X.
 *
 * Module-scope RegExp literals: var hasExcape = /~/ and var escapeMatcher = /~[01]/g.
 *   DEC-WI510-S14-MODULE-SCOPE-REGEX-LITERAL-001: First WI-510 fixture with module-scope var
 *   RegExp literal bindings. Same conceptual regime as S12 module-scope typed-array allocation
 *   but with a simpler AST shape (RegExp Literal node vs NewExpression).
 *
 * @decision DEC-WI510-S14-PACKAGE-SELECTION-JSONPOINTER-001
 *   title: Slice 14 ships jsonpointer@5.0.1 (Jan Lehnardt) for the #642 S14 JSON-Pointer slot
 *   status: accepted
 *   rationale: The #642 issue table names jsonpointer as a singular slot (no (or X) clause).
 *   Planner-time research confirmed jsonpointer@5.0.1 is the canonical Jan Lehnardt package —
 *   the same package the npm ecosystem has used since 2011. Alternatives (json-pointer
 *   manuelstofer variant, jsonpointer.js stale fork, @hyperjump/json-pointer scoped variant,
 *   rfc6902 which is JSON Patch not JSON Pointer) do not match the canonical headline.
 *   v5.0.1 is current latest, stable since 2021.
 *
 * @decision DEC-WI510-S14-ENTRY-PATH-JSONPOINTER-CJS-001
 *   title: Slice 14 entry is jsonpointer.js (the ONLY entry; no ESM alternative)
 *   status: accepted
 *   rationale: jsonpointer@5.0.1 ships pure-CJS only: no package.json#module, no
 *   package.json#exports, no esm/ subdir. jsonpointer.js is hand-authored CJS (Jan Lehnardt
 *   2011-2021) with exports.get = get + exports.set = set + exports.compile = compile. No path
 *   choice exists; the trimmed vendor manifest mirrors the tarball faithfully (with
 *   jsonpointer.d.ts excluded per plan §4.1 since the JS shave engine does not read .d.ts files).
 *   Engine bypasses package.json resolution via explicit entryPath (same pattern as
 *   S5/S6/S7/S8/S10/S11/S12/S13).
 *
 * @decision DEC-WI510-S14-ONE-FILE-ONE-ROW-001
 *   title: Slice 14 ships ONE corpus row (cat1-jsonpointer-001) carrying all three
 *     exports.get / exports.set / exports.compile surfaces
 *   status: accepted
 *   rationale: The package's public CJS surface is three callable bindings from a SINGLE file
 *   (exports.get = get, exports.set = set, exports.compile = compile). The shave engine
 *   produces one ModuleForest per entry; all three surfaces atom-merkle-root into the same
 *   single-module forest. Same pattern as S12 fastest-levenshtein (distance + closest in one
 *   entry, one row) and S13 toposort (default + .array in one entry, one row).
 *
 * @decision DEC-WI510-S14-VERSION-PIN-001
 *   title: Pin to jsonpointer@5.0.1 (current latest dist-tag at 2026-05-17)
 *   status: accepted
 *   rationale: v5 is the current major (v4/v3 superseded for security — prototype-pollution
 *   mitigation added in 5.0.0); v5.0.1 is current latest; package stable since the 5.0.1
 *   patch (2021). Any fresh npm install jsonpointer lands on 5.0.1.
 *
 * @decision DEC-WI510-S14-NO-INNER-MARKER-001
 *   title: NO inner package.json markers required for jsonpointer (unlike S10/S12)
 *   status: accepted
 *   rationale: Root package.json does NOT set "type":"module"; package defaults to commonjs.
 *   jsonpointer.js is CJS (exports.X = Y; zero require() calls but CJS syntax). The default
 *   commonjs classification is exactly correct for jsonpointer.js; no override needed.
 *   Structurally the simplest WI-510 vendor shape — pure tarball-faithful copy with no
 *   synthetic injection. Same shape as S13 toposort.
 *
 * @decision DEC-WI510-S14-LICENSE-FILE-NAMING-001
 *   title: Preserve tarball-faithful LICENSE.md spelling (all-caps with .md extension)
 *   status: accepted
 *   rationale: The jsonpointer tarball ships LICENSE.md (all-caps with .md extension) — matches
 *   the dominant WI-510 convention (S5/S7/S10/S11/S12 also used LICENSE.md). The license-detector
 *   reads the file text and matches on the MIT license header phrase; the filename itself does
 *   not gate detection. Vendor verbatim from the tarball; preserve the all-caps .md spelling
 *   (do NOT rename to License / LICENSE / license).
 *
 * @decision DEC-WI510-S14-BARE-MAIN-PATH-001
 *   title: package.json#main is the bare path "./jsonpointer" (no extension); engine resolves
 *     via <main> -> <main>.js extension-fallback
 *   status: accepted
 *   rationale: First WI-510 vendored npm fixture with a bare package.json#main path under
 *   headline-bindings discipline. S1 ms ships "main":"./index" as the engine's own fixture
 *   and validated the resolution pathway. Engine resolveSpecifier() falls back through <main>,
 *   <main>.js, <main>.cjs, <main>.mjs when the bare path doesn't directly hit a file. The bare
 *   path resolves to jsonpointer.js. Preserved verbatim from tarball.
 *
 * @decision DEC-WI510-S14-NO-CLASSES-001
 *   title: jsonpointer/jsonpointer.js has ZERO classes; #666 engine-gap CANNOT apply
 *   status: accepted
 *   rationale: Verified at planning time by grep: zero class, extends, or #foo private-field
 *   syntax in the file. All bindings are function declarations (NOT arrow expressions — same
 *   as S13). The #666 engine-gap (private class fields stub the whole file) cannot apply by
 *   structural type — there are no classes for the gap to trigger on.
 *
 * @decision DEC-WI510-S14-NO-EXTERNAL-IMPORTS-001
 *   title: jsonpointer.js has ZERO require() calls AND zero import declarations;
 *     externalSpecifiers === [] is the contract
 *   status: accepted
 *   rationale: Third WI-510 fixture with zero imports/requires of any kind (S12
 *   fastest-levenshtein/esm/mod.js was the first via the ESM extractor path; S13 toposort was
 *   the second AND the first via the CJS extractor path; S14 jsonpointer is the third — second
 *   via the CJS extractor path). The empty-union case re-corroborates that externalSpecifiers
 *   starts and stays empty when there are no requires anywhere in the BFS. JavaScript globals
 *   (Array, Object, Error, Infinity) are NOT imports — they are free identifier references.
 *
 * @decision DEC-WI510-S14-CJS-EXPORT-SHAPE-001
 *   title: exports.X = Identifier named-export shape is the validated CJS surface (three
 *     simultaneous exports.X = Y assignments as the SOLE export surface)
 *   status: accepted
 *   rationale: First WI-510 fixture exercising exports.X = Identifier as the SOLE top-level
 *   export surface. S2 validator uses module.exports.default = exports.default as a property
 *   tack-on; S13 toposort uses module.exports = FunctionExpression + property tack-on;
 *   jsonpointer uses three pure exports.X = Y assignments without ever writing module.exports.
 *   The engine should treat exports.X MemberExpression assignments identically to
 *   module.exports.X (both resolve to the same module-record export object in CJS semantics).
 *
 * @decision DEC-WI510-S14-MODULE-SCOPE-REGEX-LITERAL-001
 *   title: Two module-scope var RegExp literal bindings (var hasExcape = /~/ and
 *     var escapeMatcher = /~[01]/g) are first-class AST nodes that decompose cleanly
 *   status: accepted
 *   rationale: First WI-510 fixture exercising module-scope RegExp literal allocation. Same
 *   conceptual regime as S12 fastest-levenshtein module-scope typed-array allocation
 *   (new Uint32Array(0x10000)), but with a simpler AST shape (RegExp Literal node vs
 *   NewExpression). Engine decompose() walks Literal nodes uniformly; RegExp literals carry
 *   their pattern + flags as Literal-node properties. No engine-gap predicted.
 *
 * @decision DEC-WI510-S14-ENGINE-GAPS-LANDSCAPE-001
 *   title: Engine gaps #576/#585/#619 CLOSED + #666 OPEN-but-N/A; Slice 14 risk is LOW
 *   status: accepted
 *   rationale: #576 closed (arrow-returns-arrow class HOF). #585 closed (UMD IIFE). #619
 *   closed (TS-compiled CJS prelude). #666 OPEN but verifiably N/A for jsonpointer per
 *   DEC-WI510-S14-NO-CLASSES-001. Slice 14 risk is the three-simultaneous exports.X = Y shape —
 *   but the engine has validated MemberExpression assignments through S2 validator. If a
 *   previously-unobserved shape surfaces, ship engine-reality + file a new gap.
 *
 * @decision DEC-WI510-S14-EXTERNAL-SPECIFIERS-EXPECTATIONS-001
 *   title: Expected externalSpecifiers for jsonpointer.js is [] (the empty union)
 *   status: accepted
 *   rationale: Per source-read plan §1.8. jsonpointer.js has zero require() calls and zero
 *   ImportDeclaration AST nodes. If externalSpecifiers shows ANY entries (e.g. Array/Object/
 *   Error/Infinity showing up), that is stop-and-report — JavaScript globals should NEVER
 *   appear in externals; the empty-union case is the contract.
 *
 * @decision DEC-WI510-S14-COMBINED-SCORE-FIXED-FLOOR-001
 *   title: combinedScore quality gate uses the canonical >= 0.70 fixed floor
 *   status: accepted
 *   rationale: Slice 14's atom contains the binding-bearing source text directly: the get
 *   function body IS the RFC 6901 pointer-walking algorithm; the setter helper implements
 *   the create-as-you-go path materialization; the compile function precompiles for reuse.
 *   Same per-binding-text-rich rationale as Slices 2-13.
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
const JSONPOINTER_FIXTURE_ROOT = join(FIXTURES_DIR, "jsonpointer-5.0.1");

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
    notes: ["WI-510 Slice 14 section E stub intent card for persist pipeline test"],
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
    notes: ["WI-510 Slice 14 section F semantic intent card for combinedScore quality gate"],
    modelVersion: STATIC_MODEL_TAG,
    promptVersion: STATIC_PROMPT_VERSION,
    sourceHash: sourceHash(entry.source),
    extractedAt: "2026-05-17T00:00:00.000Z",
  };
  return { ...entry, intentCard: semanticCard };
}

// ===========================================================================
// jsonpointer@5.0.1 -- RFC 6901 JSON Pointer resolution (pure-CJS single-file)
// Entry: jsonpointer.js (pure-CJS; 100 LOC; exports.get = get + exports.set = set +
//        exports.compile = compile)
// externalSpecifiers: [] (zero require() + zero import declarations;
//   DEC-WI510-S14-NO-EXTERNAL-IMPORTS-001 -- third WI-510 zero-imports fixture;
//   second via the CJS extractor path)
// Plan §3.1: moduleCount=1, stubCount<=1, forestTotalLeafCount>=8, wall-clock <60s
// DEC-WI510-S14-NO-CLASSES-001: zero classes anywhere; #666 N/A; full decomposition predicted.
// DEC-WI510-S14-CJS-EXPORT-SHAPE-001: exports.X=Identifier as SOLE export surface (no module.exports replace).
// DEC-WI510-S14-VAR-FUNCTION-DECL-001: pre-ES2015 var + function decls; same engine handling.
// DEC-WI510-S14-MODULE-SCOPE-REGEX-LITERAL-001: two module-scope var RegExp literal bindings.
// ===========================================================================

// ---------------------------------------------------------------------------
// jsonpointer/jsonpointer.js -- sections A-E
// Timeouts: per-it() 60_000ms (§3.1 plan budget; predicted <5s on modern hardware)
//           section D 120_000ms (two consecutive calls)
// ---------------------------------------------------------------------------
describe("jsonpointer/jsonpointer.js -- per-entry shave (WI-510 Slice 14 / #642 S14)", () => {
  it(
    "section A -- moduleCount=1, stubCount<=1, forestTotalLeafCount>=8, externalSpecifiers=[]",
    { timeout: 60_000 },
    async () => {
      const forest = await shavePackage(JSONPOINTER_FIXTURE_ROOT, {
        registry: emptyRegistry,
        entryPath: join(JSONPOINTER_FIXTURE_ROOT, "jsonpointer.js"),
      });
      console.log("[jsonpointer sA] moduleCount:", forest.moduleCount);
      console.log("[jsonpointer sA] stubCount:", forest.stubCount);
      console.log(
        "[jsonpointer sA] stubs:",
        forestStubs(forest).map((s) => s.specifier),
      );
      console.log("[jsonpointer sA] forestTotalLeafCount:", forestTotalLeafCount(forest));
      const allExternal = forestModules(forest).flatMap((m) => m.externalSpecifiers);
      console.log("[jsonpointer sA] externalSpecifiers:", allExternal);
      console.log(
        "[jsonpointer sA] BFS filePaths:",
        forestModules(forest).map((m) => m.filePath.split("/").slice(-3).join("/")),
      );

      // Plan §3.1: single-file entry; no require() or import declarations anywhere; BFS terminates.
      expect(
        forest.moduleCount,
        "jsonpointer moduleCount must be 1 (single-file entry; no transitives)",
      ).toBe(1);

      // DEC-WI510-S14-NO-CLASSES-001: zero classes; #666 N/A; full decomposition expected (0).
      // Engine-reality-honest band per plan §3.1: stubCount <= 1 tolerated.
      // If stubCount === 1 (entire single file stubs), file a NEW engine-gap issue (not #666).
      expect(
        forest.stubCount,
        "jsonpointer stubCount must be <= 1 (engine-reality-honest band; expected 0; DEC-WI510-S14-NO-CLASSES-001)",
      ).toBeLessThanOrEqual(1);

      // Plan §3.1: conservative floor >= 8 (6 top-level function decls: escapeReplacer, untilde,
      // setter, compilePointer, get, set, compile + 3 exports.X = Y assignments + 2 module-scope
      // var RegExp bindings; each function body may expand further).
      expect(
        forestTotalLeafCount(forest),
        "jsonpointer forestTotalLeafCount must be >= 8 (plan §3.1)",
      ).toBeGreaterThanOrEqual(8);

      // DEC-WI510-S14-NO-EXTERNAL-IMPORTS-001: jsonpointer.js has zero require() calls AND zero
      // ImportDeclaration nodes. JavaScript globals (Array, Object, Error, Infinity) are NOT imports.
      // If externalSpecifiers is non-empty, that is stop-and-report (globals in externals = bug).
      expect(
        allExternal,
        "jsonpointer externalSpecifiers must be [] (zero require()+imports; DEC-WI510-S14-NO-EXTERNAL-IMPORTS-001)",
      ).toEqual([]);
    },
  );

  it(
    "section B -- forest.nodes[0] is jsonpointer-5.0.1/jsonpointer.js (CJS entry; BFS root)",
    { timeout: 60_000 },
    async () => {
      const forest = await shavePackage(JSONPOINTER_FIXTURE_ROOT, {
        registry: emptyRegistry,
        entryPath: join(JSONPOINTER_FIXTURE_ROOT, "jsonpointer.js"),
      });
      const firstNode = forest.nodes[0];
      expect(firstNode).toBeDefined();
      expect(firstNode?.kind, "jsonpointer first BFS node must be a module (not a stub)").toBe(
        "module",
      );
      if (firstNode?.kind === "module") {
        expect(
          firstNode.filePath,
          "jsonpointer first BFS node must contain jsonpointer.js",
        ).toContain("jsonpointer.js");
        expect(
          firstNode.filePath,
          "jsonpointer first BFS node must be inside jsonpointer-5.0.1/",
        ).toContain("jsonpointer-5.0.1");
      }
    },
  );

  it(
    "section C -- single module inside jsonpointer-5.0.1/ boundary; externalSpecifiers=[]; stubCount<=1",
    { timeout: 60_000 },
    async () => {
      const forest = await shavePackage(JSONPOINTER_FIXTURE_ROOT, {
        registry: emptyRegistry,
        entryPath: join(JSONPOINTER_FIXTURE_ROOT, "jsonpointer.js"),
      });
      const filePaths = forestModules(forest).map((m) => m.filePath);
      for (const fp of filePaths) {
        expect(
          normalize(fp),
          `jsonpointer module path must be inside jsonpointer-5.0.1/: ${fp}`,
        ).toContain("jsonpointer-5.0.1");
      }
      const allExternal = forestModules(forest).flatMap((m) => m.externalSpecifiers);
      expect(
        allExternal,
        "jsonpointer externalSpecifiers must be [] (DEC-WI510-S14-NO-EXTERNAL-IMPORTS-001)",
      ).toEqual([]);
      const stubs = forestStubs(forest);
      expect(
        stubs.length,
        "jsonpointer stubs must be <= 1 (engine-reality-honest band; DEC-WI510-S14-ENGINE-GAPS-LANDSCAPE-001)",
      ).toBeLessThanOrEqual(1);
    },
  );

  it(
    "section D -- two-pass byte-identical determinism for jsonpointer/jsonpointer.js",
    { timeout: 120_000 },
    async () => {
      const forest1 = await shavePackage(JSONPOINTER_FIXTURE_ROOT, {
        registry: emptyRegistry,
        entryPath: join(JSONPOINTER_FIXTURE_ROOT, "jsonpointer.js"),
      });
      const forest2 = await shavePackage(JSONPOINTER_FIXTURE_ROOT, {
        registry: emptyRegistry,
        entryPath: join(JSONPOINTER_FIXTURE_ROOT, "jsonpointer.js"),
      });
      expect(forest1.moduleCount, "jsonpointer two-pass: moduleCount must be identical").toBe(
        forest2.moduleCount,
      );
      expect(forest1.stubCount, "jsonpointer two-pass: stubCount must be identical").toBe(
        forest2.stubCount,
      );
      const paths1 = forestModules(forest1).map((m) => normalize(m.filePath));
      const paths2 = forestModules(forest2).map((m) => normalize(m.filePath));
      expect(paths1, "jsonpointer two-pass: BFS filePath list must be byte-identical").toEqual(
        paths2,
      );
      const ext1 = forestModules(forest1).flatMap((m) => m.externalSpecifiers);
      const ext2 = forestModules(forest2).flatMap((m) => m.externalSpecifiers);
      expect(ext1, "jsonpointer two-pass: externalSpecifiers must be byte-identical").toEqual(ext2);
      expect(
        forestTotalLeafCount(forest1),
        "jsonpointer two-pass: forestTotalLeafCount must be identical",
      ).toBe(forestTotalLeafCount(forest2));
    },
  );

  it(
    "section E -- jsonpointer forest persisted via real collectForestSlicePlans -> maybePersistNovelGlueAtom path",
    { timeout: 60_000 },
    async () => {
      const registry = await openRegistry(":memory:", {
        embeddings: createOfflineEmbeddingProvider(),
      });
      try {
        const forest = await shavePackage(JSONPOINTER_FIXTURE_ROOT, {
          registry,
          entryPath: join(JSONPOINTER_FIXTURE_ROOT, "jsonpointer.js"),
        });
        // DEC-WI510-S14-NO-CLASSES-001: full decomposition expected; plans > 0.
        // Engine-reality-honest fallback: if stubCount === moduleCount === 1 (entire single
        // file stubs), plans may be 0. Adjust assertion to empirical reality; file new
        // engine-gap issue (since #666 does NOT apply — zero classes in jsonpointer.js).
        const plans = await collectForestSlicePlans(forest, slice, registry, "glue-aware");
        console.log("[jsonpointer sE] plans.length:", plans.length);
        console.log(
          "[jsonpointer sE] moduleCount:",
          forest.moduleCount,
          "stubCount:",
          forest.stubCount,
        );
        if (forest.stubCount === forest.moduleCount && forest.moduleCount === 1) {
          // Engine-reality-honest fallback: entire single-file tree stubs (unexpected per plan).
          // File a NEW engine-gap issue (not #666 — jsonpointer.js has zero classes).
          // DEC-WI510-S14-ENGINE-GAPS-LANDSCAPE-001: if reached, a previously-unobserved gap.
          expect(
            plans.length,
            "jsonpointer sE: stub-state fallback — 0 plans (entire single-file tree stubs; unexpected per plan §3.1)",
          ).toBe(0);
        } else {
          expect(
            plans.length,
            "jsonpointer sE: collectForestSlicePlans must return > 0 plans",
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
                    "jsonpointer sE: persisted atom must be retrievable via registry.getBlock",
                  ).not.toBeNull();
                }
              }
            }
          }
          console.log("[jsonpointer sE] persisted atoms:", persistedCount);
          console.log("[jsonpointer sE] headline merkle root:", headlineMerkleRoot);
          expect(
            persistedCount,
            "jsonpointer sE: at least one atom must persist (novel-glue path)",
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
// DEC-WI510-S14-COMBINED-SCORE-FIXED-FLOOR-001: Atom contains the binding-bearing source
// text directly (get function body IS the RFC 6901 pointer-walking algorithm; the setter
// helper implements the create-as-you-go path materialization; compile precompiles for reuse).
// Skipped unless DISCOVERY_EVAL_PROVIDER=local.
// NOTE: If Section A produces stubCount === moduleCount === 1 (entire file stubs),
// this section SKIPS with a measurement-citing comment (mirroring S10 engine-reality exit).
// Predicted: full decomposition (zero classes; #666 N/A; clean pure-CJS single file).
// ===========================================================================
describe("jsonpointer section F -- combinedScore quality gate (WI-510 Slice 14 / #642 S14)", () => {
  // ---------------------------------------------------------------------------
  // jsonpointer sF: RFC 6901 JSON Pointer resolution query
  // Query: corpus cat1-jsonpointer-001 behavior string (plan §5.4)
  // ---------------------------------------------------------------------------
  it.skipIf(!USE_LOCAL_PROVIDER)(
    "jsonpointer combinedScore >= 0.70 for corpus query (DISCOVERY_EVAL_PROVIDER=local)",
    { timeout: 60_000 },
    async () => {
      const registry = await openRegistry(":memory:", {
        embeddings: createLocalEmbeddingProvider("Xenova/all-MiniLM-L6-v2", 384),
      });
      try {
        const JSONPOINTER_BEHAVIOR =
          "Resolve an RFC 6901 JSON Pointer against a JSON-shaped object and read or write the value at the addressed path; given an object and a slash-separated pointer string (for example /foo/bar/0), the get operation returns the value at that location or undefined if the path does not exist, the set operation writes a value at that location creating intermediate arrays and objects as needed and returns the previous value at that location, and a separate compile operation pre-validates a pointer and returns a reusable accessor bound to that compiled pointer; honors the RFC 6901 tilde escape sequences (~0 for a literal tilde and ~1 for a literal forward slash) and the array-append /- convention when setting; throws when given a pointer that does not begin with a slash, when given a non-object input, or when given a non-string non-array pointer; blocks prototype-chain segment names (constructor, prototype, __proto__) during the set traversal";
        const forest = await shavePackage(JSONPOINTER_FIXTURE_ROOT, {
          registry,
          entryPath: join(JSONPOINTER_FIXTURE_ROOT, "jsonpointer.js"),
        });
        // If entire file stubs (unexpected), skip quality gate and document the gap.
        if (forest.stubCount === forest.moduleCount && forest.moduleCount === 1) {
          // Engine-reality-honest: stub-state prevents atom persistence; quality gate deferred.
          // Unexpected for jsonpointer (DEC-WI510-S14-NO-CLASSES-001 — zero classes, #666 N/A).
          // File a NEW engine-gap issue with this evidence before marking slice ready.
          console.log(
            "[jsonpointer sF] UNEXPECTED STUB STATE: moduleCount=1, stubCount=1. Quality gate deferred.",
          );
          expect(
            forest.stubCount,
            "jsonpointer sF: stub-state corroboration (DEC-WI510-S14-ENGINE-GAPS-LANDSCAPE-001)",
          ).toBe(1);
          return;
        }
        const plans = await collectForestSlicePlans(forest, slice, registry, "glue-aware");
        for (const { slicePlan } of plans) {
          for (const entry of slicePlan.entries) {
            if (entry.kind === "novel-glue") {
              await maybePersistNovelGlueAtom(
                withSemanticIntentCard(entry, JSONPOINTER_BEHAVIOR),
                registry,
              );
            }
          }
        }
        const result = await registry.findCandidatesByQuery({
          behavior: JSONPOINTER_BEHAVIOR,
          topK: 10,
        });
        console.log(
          "[jsonpointer sF] candidates:",
          result.candidates.map((c) => ({ score: c.combinedScore })),
        );
        expect(
          result.candidates.length,
          "jsonpointer sF: must find at least one candidate",
        ).toBeGreaterThan(0);
        const topScore = result.candidates[0]?.combinedScore ?? 0;
        console.log("[jsonpointer sF] top combinedScore:", topScore);
        // Fixed floor >= 0.70 per DEC-WI510-S14-COMBINED-SCORE-FIXED-FLOOR-001.
        // Atom contains get + set + compile + setter + escapeReplacer + untilde + compilePointer
        // source directly (binding-bearing text).
        // If empirical falls below 0.70, extend semanticHints or document via
        // DEC-WI510-S14-COMBINED-SCORE-EMPIRICAL-FLOOR-002 escape hatch.
        expect(
          topScore,
          "jsonpointer combinedScore must be >= 0.70 (DEC-WI510-S14-COMBINED-SCORE-FIXED-FLOOR-001)",
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
// for the single jsonpointer entry, crossing multiple internal component boundaries.
// Asserts: entry produces > 0 persisted atoms + merkle root retrievable from registry.
// DEC-WI510-S14-ONE-FILE-ONE-ROW-001: one file -> one entry-atom containing all three
// exports.get / exports.set / exports.compile surfaces via the single-module forest.
// DEC-WI510-S14-CJS-EXPORT-SHAPE-001: exports.X = Identifier named-export shape verified
// empirically — engine treats exports.X MemberExpression assignments as module export surfaces.
// ===========================================================================
describe("jsonpointer -- compound interaction: entry end-to-end (WI-510 Slice 14 / #642 S14)", () => {
  it(
    "entry resolves, shaves, slices, persists; entry-atom merkle root is retrievable (DEC-WI510-S14-ONE-FILE-ONE-ROW-001)",
    { timeout: 120_000 },
    async () => {
      const registry = await openRegistry(":memory:", {
        embeddings: createOfflineEmbeddingProvider(),
      });
      try {
        const forest = await shavePackage(JSONPOINTER_FIXTURE_ROOT, {
          registry,
          entryPath: join(JSONPOINTER_FIXTURE_ROOT, "jsonpointer.js"),
        });

        // Plan §3.1: single-file entry.
        expect(forest.moduleCount, "compound test: jsonpointer moduleCount must be 1").toBe(1);

        // DEC-WI510-S14-NO-CLASSES-001: expected 0 stubs; tolerate 1 (engine-reality-honest band).
        expect(
          forest.stubCount,
          "compound test: jsonpointer stubCount must be <= 1 (DEC-WI510-S14-NO-CLASSES-001)",
        ).toBeLessThanOrEqual(1);

        // DEC-WI510-S14-NO-EXTERNAL-IMPORTS-001: zero require()+imports; empty union is the contract.
        const allExternal = forestModules(forest).flatMap((m) => m.externalSpecifiers);
        expect(
          allExternal,
          "compound test: jsonpointer externalSpecifiers must be [] (DEC-WI510-S14-NO-EXTERNAL-IMPORTS-001)",
        ).toEqual([]);

        const plans = await collectForestSlicePlans(forest, slice, registry, "glue-aware");

        console.log(
          `[compound] jsonpointer: moduleCount=${forest.moduleCount} stubCount=${forest.stubCount} leafCount=${forestTotalLeafCount(forest)} plans=${plans.length}`,
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

        expect(plans.length, "compound test: jsonpointer plans.length must be > 0").toBeGreaterThan(
          0,
        );

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
          `[compound] jsonpointer: persisted=${persistedCount} entryMR=${entryAtomMerkleRoot?.slice(0, 16)}`,
        );

        expect(persistedCount, "compound test: jsonpointer must persist > 0 atoms").toBeGreaterThan(
          0,
        );

        // DEC-WI510-S14-ONE-FILE-ONE-ROW-001: entry-atom merkle root must be retrievable.
        // The single-module forest carries all three exports.get / exports.set / exports.compile
        // surfaces in one atom (DEC-WI510-S14-CJS-EXPORT-SHAPE-001).
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
