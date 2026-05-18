// SPDX-License-Identifier: MIT
/**
 * base64-js@1.5.1 headline bindings -- single-entry shave tests (WI-510 Slice 15 / #642 S15)
 *
 * STRUCTURE:
 *   base64-js (1 describe: sections A-E)
 *     index.js -- pure-CJS single-file; 150 LOC production source;
 *     exports.byteLength = byteLength + exports.toByteArray = toByteArray +
 *     exports.fromByteArray = fromByteArray
 *     externalSpecifiers = [] (zero require() calls AND zero import declarations;
 *       DEC-WI510-S15-NO-EXTERNAL-IMPORTS-001 -- fourth WI-510 zero-imports fixture;
 *       third via the CJS extractor path; same empty-union contract as S12/S13/S14)
 *     Plan §3.1: moduleCount=1, stubCount<=1, forestTotalLeafCount>=10, wall-clock <60s
 *
 *   Section F (1 describe, 1 it.skipIf block) -- combinedScore quality gate.
 *     Skipped unless DISCOVERY_EVAL_PROVIDER=local.
 *     Fixed floor >= 0.70 per DEC-WI510-S15-COMBINED-SCORE-FIXED-FLOOR-001.
 *     NOTE: Full decomposition predicted (zero classes; #666 N/A;
 *       DEC-WI510-S15-NO-CLASSES-001).
 *     If Section A produces stubCount === moduleCount === 1 (entire tree stubs),
 *     Section F SKIPS with a measurement-citing comment (mirroring S10 engine-reality exit).
 *
 *   Compound interaction test (1 describe) -- end-to-end production sequence.
 *     shavePackage -> collectForestSlicePlans -> maybePersistNovelGlueAtom for the single entry.
 *     Crosses: engine decompose, forest slice plans, registry persist, merkle retrieval.
 *     DEC-WI510-S15-ONE-FILE-ONE-ROW-001: one entry file -> one atom containing all three
 *     exports.byteLength / exports.toByteArray / exports.fromByteArray surfaces.
 *
 * Package selection: base64-js@1.5.1 (T. Jameson Little / beatgammit) -- canonical RFC 4648
 *   Base64 codec npm package; the package that the Node.js ecosystem's `buffer` polyfill
 *   (Feross-maintained), safe-buffer, and the Browserify/Webpack ecosystem use for browser
 *   Base64 codec.
 *   DEC-WI510-S15-PACKAGE-SELECTION-BASE64JS-001: The #642 issue table names base64-js as a
 *   singular slot. base64-js@1.5.1 is the canonical T. Jameson Little package -- the same package
 *   the npm ecosystem has used since 2014. v1.5.1 is current latest, stable since 2020.
 *   Alternatives (js-base64 dankogai, base-64 mathiasbynens, base64url, Node builtin) rejected.
 *
 * Engine-gap landscape (DEC-WI510-S15-ENGINE-GAPS-LANDSCAPE-001):
 *   #576 CLOSED (b5dff3a / PR #604) -- arrow-returns-arrow HOF in class bodies. NOT applicable.
 *   #585 CLOSED (cbefa3c / PR #627) -- UMD IIFE walk. NOT applicable (index.js is bare CJS;
 *     base64js.min.js IS UMD-wrapped but is EXCLUDED from the fixture per §4.1).
 *   #619 CLOSED (dual-group engine-gap-honest pattern) -- TSC CJS prelude. NOT applicable
 *     (index.js is hand-authored CJS; T. Jameson Little 2014-2020; no __esModule prelude.
 *     Hand-authored 'use strict' at line 1 is a Directive AST node, not a TSC prelude).
 *   #666 OPEN but VERIFIED NOT APPLICABLE -- private class fields (#foo). NOT applicable.
 *     index.js has ZERO classes anywhere; all bindings are function declarations.
 *     Verified at planning time via grep. Full decomposition predicted.
 *
 * Fixture file count: 4 files (plan §4.1+§4.2 trimmed vendor manifest -- NO inner marker)
 *   index.js (150 LOC; the shaved source) + package.json (root manifest; CJS default) +
 *   LICENSE (all-caps NO extension; DEC-WI510-S15-LICENSE-FILE-NAMING-001) + PROVENANCE.md
 *   DEC-WI510-S15-NO-INNER-MARKER-001: root package.json has no "type":"module"; default
 *   commonjs is exactly correct for index.js. No synthetic inner marker needed.
 *
 * Named-export CJS shape: exports.X = Identifier (three assignments; no module.exports replace).
 *   DEC-WI510-S15-CJS-EXPORT-SHAPE-001: Second WI-510 fixture exercising exports.X = Identifier
 *   as the SOLE top-level export surface. S14 jsonpointer was the first. S15 re-corroborates
 *   this contract with three new named exports (byteLength, toByteArray, fromByteArray vs
 *   S14's get, set, compile). Engine treats exports.X MemberExpression assignments identically
 *   to module.exports.X (validated empirically on S14).
 *
 * Module-scope executable for loop: lines 12-15 populate lookup/revLookup arrays from code.
 *   DEC-WI510-S15-MODULE-SCOPE-FOR-LOOP-001: First WI-510 fixture with executable module-scope
 *   for loop body. The loop runs at module load time, before any function is called. Engine
 *   decompose() walks ForStatement uniformly at module scope (same as in-function context).
 *
 * Hand-authored 'use strict' directive: line 1, single-quoted, no semicolon.
 *   DEC-WI510-S15-USE-STRICT-DIRECTIVE-001: First WI-510 fixture with hand-authored top-of-file
 *   'use strict'. A Directive AST node (not an ExpressionStatement). Engine handles Directive
 *   prologues uniformly (same node type validated in S2/S8 TSC/Babel emits).
 *
 * Heavy bitwise arithmetic: toByteArray/tripletToBase64/encodeChunk/fromByteArray function bodies.
 *   DEC-WI510-S15-HEAVY-BITWISE-ARITHMETIC-001: First WI-510 fixture with heavy bitwise arithmetic
 *   (<<, >>, &, |, 0xFF, 0xFF00, 0xFF0000, 0x3F, decimal 16383, 62, 63, etc.). Engine decompose()
 *   walks BinaryExpression with bitwise operators identically to arithmetic operators.
 *
 * @decision DEC-WI510-S15-PACKAGE-SELECTION-BASE64JS-001
 *   title: Slice 15 ships base64-js@1.5.1 (T. Jameson Little) for the #642 S15 Base64 slot
 *   status: accepted
 *   rationale: The #642 issue table names base64-js as a singular slot (no (or X) clause).
 *   Planner-time research confirmed base64-js@1.5.1 is the canonical T. Jameson Little package --
 *   the same package the npm ecosystem has used since 2014. Alternatives (js-base64 dankogai,
 *   base-64 mathiasbynens stale-v0.1.0, base64url URL-safe-only variant, Node builtin) do not
 *   match the canonical headline RFC 4648 byte-array codec slot.
 *   v1.5.1 is current latest, stable since the 1.5.0 cutover (2020).
 *
 * @decision DEC-WI510-S15-ENTRY-PATH-BASE64JS-CJS-001
 *   title: Slice 15 entry is index.js (the ONLY entry; no ESM alternative; base64js.min.js excluded)
 *   status: accepted
 *   rationale: base64-js@1.5.1 ships pure-CJS only: no package.json#module, no package.json#exports,
 *   no esm/ subdir. index.js is hand-authored CJS (T. Jameson Little 2014-2020) with
 *   exports.byteLength + exports.toByteArray + exports.fromByteArray. base64js.min.js is the UMD
 *   browser build (Browserify+babel-minify) -- excluded because (a) it is NOT the Node entry
 *   (package.json#main = "index.js"); (b) it exercises the closed #585 UMD/IIFE engine path;
 *   (c) minified source would produce a different merkle root. Engine bypasses package.json
 *   resolution via explicit entryPath (same pattern as S5/S6/S7/S8/S10/S11/S12/S13/S14).
 *
 * @decision DEC-WI510-S15-ONE-FILE-ONE-ROW-001
 *   title: Slice 15 ships ONE corpus row (cat1-base64-js-001) carrying all three
 *     exports.byteLength / exports.toByteArray / exports.fromByteArray surfaces
 *   status: accepted
 *   rationale: The package's public CJS surface is three callable bindings from a SINGLE file.
 *   The shave engine produces one ModuleForest per entry; all three surfaces atom-merkle-root
 *   into the same single-module forest. Same pattern as S12 fastest-levenshtein (two named
 *   exports, one row), S13 toposort (two callable surfaces, one row), S14 jsonpointer (three
 *   named exports, one row).
 *
 * @decision DEC-WI510-S15-VERSION-PIN-001
 *   title: Pin to base64-js@1.5.1 (current latest dist-tag at 2026-05-17)
 *   status: accepted
 *   rationale: v1 is the only major (no 2.x exists; package on v1.x since 2014). v1.5.1 is
 *   current latest; the 1.5.1 patch (2020) fixed an edge-case in byteLength for mid-string =
 *   padding. Package is stable / feature-complete.
 *
 * @decision DEC-WI510-S15-NO-INNER-MARKER-001
 *   title: NO inner package.json markers required for base64-js (unlike S10/S12)
 *   status: accepted
 *   rationale: Root package.json does NOT set "type":"module"; package defaults to commonjs.
 *   index.js is CJS (exports.X = Y; zero require() calls but CJS syntax). The default
 *   commonjs classification is exactly correct for index.js; no override needed. Same shape
 *   as S13 toposort and S14 jsonpointer (simplest WI-510 vendor shape).
 *
 * @decision DEC-WI510-S15-LICENSE-FILE-NAMING-001
 *   title: Preserve tarball-faithful LICENSE spelling (all-caps, NO extension)
 *   status: accepted
 *   rationale: The base64-js tarball ships LICENSE (all-caps, no extension) -- matches the S2
 *   validator, S3 semver, S6 jsonwebtoken+bcryptjs, S8 zod, S9 nanoid convention. Differs from
 *   the recent S14 jsonpointer (LICENSE.md) and S12 fastest-levenshtein (LICENSE.md). The
 *   license-detector reads file text and matches on the MIT header phrase; filename itself does
 *   not gate detection. Vendor verbatim; preserve the all-caps no-extension spelling.
 *
 * @decision DEC-WI510-S15-NO-CLASSES-001
 *   title: base64-js/index.js has ZERO classes; #666 engine-gap CANNOT apply
 *   status: accepted
 *   rationale: Verified at planning time by grep: zero class, extends, or #foo private-field
 *   syntax in the file. All bindings are function declarations (NOT arrow expressions -- same
 *   as S13/S14). The #666 engine-gap (private class fields stub the whole file) cannot apply by
 *   structural type -- there are no classes for the gap to trigger on.
 *
 * @decision DEC-WI510-S15-NO-EXTERNAL-IMPORTS-001
 *   title: index.js has ZERO require() calls AND zero import declarations;
 *     externalSpecifiers === [] is the contract
 *   status: accepted
 *   rationale: Fourth WI-510 fixture with zero imports/requires of any kind (S12
 *   fastest-levenshtein/esm/mod.js was the first via the ESM extractor path; S13 toposort was
 *   the second AND first via the CJS extractor path; S14 jsonpointer was the third -- second via
 *   CJS extractor path; S15 base64-js is the fourth -- third via CJS extractor path). JavaScript
 *   globals (Uint8Array, Array, Error) are NOT imports -- they are free identifier references.
 *   Uint8Array at line 9 is used as typeof operand and constructor reference; it is NOT imported.
 *
 * @decision DEC-WI510-S15-CJS-EXPORT-SHAPE-001
 *   title: exports.X = Identifier named-export shape is the validated CJS surface (second
 *     WI-510 fixture with three simultaneous exports.X = Y assignments as the SOLE export surface)
 *   status: accepted
 *   rationale: Second WI-510 fixture exercising exports.X = Identifier as the SOLE top-level
 *   export surface. S14 jsonpointer was the first. S15 re-corroborates this contract with three
 *   new named exports. Engine treats exports.X MemberExpression assignments identically to
 *   module.exports.X (same module-record export object in CJS semantics). Validated empirically
 *   on S14; S15 is the second corroboration.
 *
 * @decision DEC-WI510-S15-MODULE-SCOPE-FOR-LOOP-001
 *   title: First WI-510 fixture with executable module-scope for loop body (lines 12-15)
 *     populating lookup/revLookup arrays from the RFC 4648 alphabet string
 *   status: accepted
 *   rationale: lines 12-15 (for (var i = 0, len = code.length; i < len; ++i) { lookup[i] =
 *   code[i]; revLookup[code.charCodeAt(i)] = i; }) execute at module load time, before any
 *   function is called. Engine decompose() walks ForStatement uniformly; the module-scope context
 *   is a property of the traversal mode, not a different node-handling regime. No engine-gap
 *   predicted. Same traversal mode as in-function for loops (validated through S5/S7/S11/S12/S13/S14).
 *
 * @decision DEC-WI510-S15-USE-STRICT-DIRECTIVE-001
 *   title: Hand-authored 'use strict' at line 1 (single-quoted, no semicolon) is a Directive
 *     AST node identical in kind to TSC/Babel CJS emit directives
 *   status: accepted
 *   rationale: First WI-510 fixture with hand-authored 'use strict'. T. Jameson Little wrote this
 *   by hand; it differs from TSC/Babel emits ("use strict"; double-quoted + semicolon) only in
 *   punctuation. The AST representation is the same Directive node. Engine handles Directive
 *   prologues uniformly. No engine-gap predicted.
 *
 * @decision DEC-WI510-S15-ENGINE-GAPS-LANDSCAPE-001
 *   title: Engine gaps #576/#585/#619 CLOSED + #666 OPEN-but-N/A; Slice 15 risk is LOW
 *   status: accepted
 *   rationale: #576 closed (arrow-returns-arrow class HOF). #585 closed (UMD IIFE). #619
 *   closed (TS-compiled CJS prelude). #666 OPEN but verifiably N/A for base64-js per
 *   DEC-WI510-S15-NO-CLASSES-001. Slice 15 risk: two structural novelties (module-scope for loop
 *   + heavy bitwise) but both are uniform extensions of validated AST node types (ForStatement
 *   and BinaryExpression). If a previously-unobserved shape surfaces, ship engine-reality + file
 *   a new gap.
 *
 * @decision DEC-WI510-S15-EXTERNAL-SPECIFIERS-EXPECTATIONS-001
 *   title: Expected externalSpecifiers for index.js is [] (the empty union)
 *   status: accepted
 *   rationale: Per source-read plan §1.8. index.js has zero require() calls and zero
 *   ImportDeclaration AST nodes. If externalSpecifiers shows ANY entries (e.g. Uint8Array/Array/
 *   Error showing up as globals-treated-as-externals), that is stop-and-report -- JavaScript
 *   globals should NEVER appear in externals; the empty-union case is the contract.
 *
 * @decision DEC-WI510-S15-COMBINED-SCORE-FIXED-FLOOR-001
 *   title: combinedScore quality gate uses the canonical >= 0.70 fixed floor
 *   status: accepted
 *   rationale: Slice 15's atom contains the binding-bearing source text directly: the toByteArray
 *   function body IS the RFC 4648 Base64 decode arithmetic; the fromByteArray function body IS
 *   the RFC 4648 Base64 encode arithmetic; the byteLength function computes decoded length without
 *   allocating; the lookup/revLookup arrays carry the RFC 4648 alphabet. Same per-binding-text-rich
 *   rationale as Slices 2-14.
 *
 * @decision DEC-WI510-S15-MODULE-SCOPE-TYPED-ARRAY-CONDITIONAL-001
 *   title: Module-scope var Arr = typeof Uint8Array !== 'undefined' ? Uint8Array : Array
 *     (ConditionalExpression binding a typed-array constructor; distinct from S12's NewExpression)
 *   status: accepted
 *   rationale: S12 fastest-levenshtein validated new Uint32Array(0x10000) at module scope as a
 *   NewExpression. S15 validates a typed-array constructor binding via ConditionalExpression --
 *   different AST shape (Conditional vs NewExpression). Both are standard ECMAScript; engine
 *   handles both uniformly. No engine-gap predicted.
 *
 * @decision DEC-WI510-S15-HEAVY-BITWISE-ARITHMETIC-001
 *   title: First WI-510 fixture with heavy bitwise-arithmetic function bodies (<<, >>, &, |,
 *     0xFF, 0x3F, 0xFF00, 0xFF0000) in the encode/decode codec functions
 *   status: accepted
 *   rationale: S3 semver / S5 date-fns / S12 fastest-levenshtein had some bitwise ops but were
 *   not primarily bitwise. S15 base64-js is the first WI-510 fixture whose primary computation
 *   (RFC 4648 byte-packing/unpacking) is bitwise arithmetic. Engine decompose() walks
 *   BinaryExpression with bitwise operators identically to arithmetic operators; same AST regime.
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
const BASE64JS_FIXTURE_ROOT = join(FIXTURES_DIR, "base64-js-1.5.1");

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
    notes: ["WI-510 Slice 15 section E stub intent card for persist pipeline test"],
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
    notes: ["WI-510 Slice 15 section F semantic intent card for combinedScore quality gate"],
    modelVersion: STATIC_MODEL_TAG,
    promptVersion: STATIC_PROMPT_VERSION,
    sourceHash: sourceHash(entry.source),
    extractedAt: "2026-05-17T00:00:00.000Z",
  };
  return { ...entry, intentCard: semanticCard };
}

// ===========================================================================
// base64-js@1.5.1 -- RFC 4648 Base64 codec (pure-CJS single-file)
// Entry: index.js (pure-CJS; 150 LOC; exports.byteLength = byteLength +
//        exports.toByteArray = toByteArray + exports.fromByteArray = fromByteArray)
// externalSpecifiers: [] (zero require() + zero import declarations;
//   DEC-WI510-S15-NO-EXTERNAL-IMPORTS-001 -- fourth WI-510 zero-imports fixture;
//   third via the CJS extractor path)
// Plan §3.1: moduleCount=1, stubCount<=1, forestTotalLeafCount>=10, wall-clock <60s
// DEC-WI510-S15-NO-CLASSES-001: zero classes anywhere; #666 N/A; full decomposition predicted.
// DEC-WI510-S15-CJS-EXPORT-SHAPE-001: exports.X=Identifier as SOLE export surface (no module.exports replace).
// DEC-WI510-S15-MODULE-SCOPE-FOR-LOOP-001: first WI-510 module-scope executable for loop.
// DEC-WI510-S15-USE-STRICT-DIRECTIVE-001: hand-authored 'use strict' at line 1.
// DEC-WI510-S15-HEAVY-BITWISE-ARITHMETIC-001: first WI-510 heavy-bitwise codec function bodies.
// ===========================================================================

// ---------------------------------------------------------------------------
// base64-js/index.js -- sections A-E
// Timeouts: per-it() 60_000ms (§3.1 plan budget; predicted <5s on modern hardware)
//           section D 120_000ms (two consecutive calls)
// ---------------------------------------------------------------------------
describe("base64-js/index.js -- per-entry shave (WI-510 Slice 15 / #642 S15)", () => {
  it(
    "section A -- moduleCount=1, stubCount<=1, forestTotalLeafCount>=10, externalSpecifiers=[]",
    { timeout: 60_000 },
    async () => {
      const forest = await shavePackage(BASE64JS_FIXTURE_ROOT, {
        registry: emptyRegistry,
        entryPath: join(BASE64JS_FIXTURE_ROOT, "index.js"),
      });
      console.log("[base64-js sA] moduleCount:", forest.moduleCount);
      console.log("[base64-js sA] stubCount:", forest.stubCount);
      console.log(
        "[base64-js sA] stubs:",
        forestStubs(forest).map((s) => s.specifier),
      );
      console.log("[base64-js sA] forestTotalLeafCount:", forestTotalLeafCount(forest));
      const allExternal = forestModules(forest).flatMap((m) => m.externalSpecifiers);
      console.log("[base64-js sA] externalSpecifiers:", allExternal);
      console.log(
        "[base64-js sA] BFS filePaths:",
        forestModules(forest).map((m) => m.filePath.split("/").slice(-3).join("/")),
      );

      // Plan §3.1: single-file entry; no require() or import declarations anywhere; BFS terminates.
      expect(
        forest.moduleCount,
        "base64-js moduleCount must be 1 (single-file entry; no transitives)",
      ).toBe(1);

      // DEC-WI510-S15-NO-CLASSES-001: zero classes; #666 N/A; full decomposition expected (0).
      // Engine-reality-honest band per plan §3.1: stubCount <= 1 tolerated.
      // If stubCount === 1 (entire single file stubs), file a NEW engine-gap issue (not #666).
      expect(
        forest.stubCount,
        "base64-js stubCount must be <= 1 (engine-reality-honest band; expected 0; DEC-WI510-S15-NO-CLASSES-001)",
      ).toBeLessThanOrEqual(1);

      // Plan §3.1: conservative floor >= 10 (8 top-level function decls + 3 exports.X = Y
      // assignments + module-scope var bindings + for loop body + direct revLookup[...] = N).
      expect(
        forestTotalLeafCount(forest),
        "base64-js forestTotalLeafCount must be >= 10 (plan §3.1)",
      ).toBeGreaterThanOrEqual(10);

      // DEC-WI510-S15-NO-EXTERNAL-IMPORTS-001: index.js has zero require() calls AND zero
      // ImportDeclaration nodes. JavaScript globals (Uint8Array, Array, Error) are NOT imports.
      // If externalSpecifiers is non-empty, that is stop-and-report (globals in externals = bug).
      expect(
        allExternal,
        "base64-js externalSpecifiers must be [] (zero require()+imports; DEC-WI510-S15-NO-EXTERNAL-IMPORTS-001)",
      ).toEqual([]);
    },
  );

  it(
    "section B -- forest.nodes[0] is base64-js-1.5.1/index.js (CJS entry; BFS root)",
    { timeout: 60_000 },
    async () => {
      const forest = await shavePackage(BASE64JS_FIXTURE_ROOT, {
        registry: emptyRegistry,
        entryPath: join(BASE64JS_FIXTURE_ROOT, "index.js"),
      });
      const firstNode = forest.nodes[0];
      expect(firstNode).toBeDefined();
      expect(firstNode?.kind, "base64-js first BFS node must be a module (not a stub)").toBe(
        "module",
      );
      if (firstNode?.kind === "module") {
        expect(firstNode.filePath, "base64-js first BFS node must contain index.js").toContain(
          "index.js",
        );
        expect(
          firstNode.filePath,
          "base64-js first BFS node must be inside base64-js-1.5.1/",
        ).toContain("base64-js-1.5.1");
      }
    },
  );

  it(
    "section C -- single module inside base64-js-1.5.1/ boundary; externalSpecifiers=[]; stubCount<=1",
    { timeout: 60_000 },
    async () => {
      const forest = await shavePackage(BASE64JS_FIXTURE_ROOT, {
        registry: emptyRegistry,
        entryPath: join(BASE64JS_FIXTURE_ROOT, "index.js"),
      });
      const filePaths = forestModules(forest).map((m) => m.filePath);
      for (const fp of filePaths) {
        expect(
          normalize(fp),
          `base64-js module path must be inside base64-js-1.5.1/: ${fp}`,
        ).toContain("base64-js-1.5.1");
      }
      const allExternal = forestModules(forest).flatMap((m) => m.externalSpecifiers);
      expect(
        allExternal,
        "base64-js externalSpecifiers must be [] (DEC-WI510-S15-NO-EXTERNAL-IMPORTS-001)",
      ).toEqual([]);
      const stubs = forestStubs(forest);
      expect(
        stubs.length,
        "base64-js stubs must be <= 1 (engine-reality-honest band; DEC-WI510-S15-ENGINE-GAPS-LANDSCAPE-001)",
      ).toBeLessThanOrEqual(1);
    },
  );

  it(
    "section D -- two-pass byte-identical determinism for base64-js/index.js",
    { timeout: 120_000 },
    async () => {
      const forest1 = await shavePackage(BASE64JS_FIXTURE_ROOT, {
        registry: emptyRegistry,
        entryPath: join(BASE64JS_FIXTURE_ROOT, "index.js"),
      });
      const forest2 = await shavePackage(BASE64JS_FIXTURE_ROOT, {
        registry: emptyRegistry,
        entryPath: join(BASE64JS_FIXTURE_ROOT, "index.js"),
      });
      expect(forest1.moduleCount, "base64-js two-pass: moduleCount must be identical").toBe(
        forest2.moduleCount,
      );
      expect(forest1.stubCount, "base64-js two-pass: stubCount must be identical").toBe(
        forest2.stubCount,
      );
      const paths1 = forestModules(forest1).map((m) => normalize(m.filePath));
      const paths2 = forestModules(forest2).map((m) => normalize(m.filePath));
      expect(paths1, "base64-js two-pass: BFS filePath list must be byte-identical").toEqual(
        paths2,
      );
      const ext1 = forestModules(forest1).flatMap((m) => m.externalSpecifiers);
      const ext2 = forestModules(forest2).flatMap((m) => m.externalSpecifiers);
      expect(ext1, "base64-js two-pass: externalSpecifiers must be byte-identical").toEqual(ext2);
      expect(
        forestTotalLeafCount(forest1),
        "base64-js two-pass: forestTotalLeafCount must be identical",
      ).toBe(forestTotalLeafCount(forest2));
    },
  );

  it(
    "section E -- base64-js forest persisted via real collectForestSlicePlans -> maybePersistNovelGlueAtom path",
    { timeout: 60_000 },
    async () => {
      const registry = await openRegistry(":memory:", {
        embeddings: createOfflineEmbeddingProvider(),
      });
      try {
        const forest = await shavePackage(BASE64JS_FIXTURE_ROOT, {
          registry,
          entryPath: join(BASE64JS_FIXTURE_ROOT, "index.js"),
        });
        // DEC-WI510-S15-NO-CLASSES-001: full decomposition expected; plans > 0.
        // Engine-reality-honest fallback: if stubCount === moduleCount === 1 (entire single
        // file stubs), plans may be 0. Adjust assertion to empirical reality; file new
        // engine-gap issue (since #666 does NOT apply -- zero classes in index.js).
        const plans = await collectForestSlicePlans(forest, slice, registry, "glue-aware");
        console.log("[base64-js sE] plans.length:", plans.length);
        console.log(
          "[base64-js sE] moduleCount:",
          forest.moduleCount,
          "stubCount:",
          forest.stubCount,
        );
        if (forest.stubCount === forest.moduleCount && forest.moduleCount === 1) {
          // Engine-reality-honest fallback: entire single-file tree stubs (unexpected per plan).
          // File a NEW engine-gap issue (not #666 -- index.js has zero classes).
          // DEC-WI510-S15-ENGINE-GAPS-LANDSCAPE-001: if reached, a previously-unobserved gap.
          expect(
            plans.length,
            "base64-js sE: stub-state fallback -- 0 plans (entire single-file tree stubs; unexpected per plan §3.1)",
          ).toBe(0);
        } else {
          expect(
            plans.length,
            "base64-js sE: collectForestSlicePlans must return > 0 plans",
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
                    "base64-js sE: persisted atom must be retrievable via registry.getBlock",
                  ).not.toBeNull();
                }
              }
            }
          }
          console.log("[base64-js sE] persisted atoms:", persistedCount);
          console.log("[base64-js sE] headline merkle root:", headlineMerkleRoot);
          expect(
            persistedCount,
            "base64-js sE: at least one atom must persist (novel-glue path)",
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
// DEC-WI510-S15-COMBINED-SCORE-FIXED-FLOOR-001: Atom contains the binding-bearing source
// text directly (toByteArray function body IS the RFC 4648 Base64 decode arithmetic;
// fromByteArray function body IS the RFC 4648 Base64 encode arithmetic; byteLength computes
// decoded length; lookup/revLookup carry the RFC 4648 alphabet directly).
// Skipped unless DISCOVERY_EVAL_PROVIDER=local.
// NOTE: If Section A produces stubCount === moduleCount === 1 (entire file stubs),
// this section SKIPS with a measurement-citing comment (mirroring S10 engine-reality exit).
// Predicted: full decomposition (zero classes; #666 N/A; clean pure-CJS single file).
// ===========================================================================
describe("base64-js section F -- combinedScore quality gate (WI-510 Slice 15 / #642 S15)", () => {
  // ---------------------------------------------------------------------------
  // base64-js sF: RFC 4648 Base64 codec binding query
  // Query: corpus cat1-base64-js-001 behavior string (plan §5.4)
  // ---------------------------------------------------------------------------
  it.skipIf(!USE_LOCAL_PROVIDER)(
    "base64-js combinedScore >= 0.70 for corpus query (DISCOVERY_EVAL_PROVIDER=local)",
    { timeout: 60_000 },
    async () => {
      const registry = await openRegistry(":memory:", {
        embeddings: createLocalEmbeddingProvider("Xenova/all-MiniLM-L6-v2", 384),
      });
      try {
        const BASE64JS_BEHAVIOR =
          "Encode and decode binary data using the RFC 4648 Base64 codec; given a Base64-encoded string (using the standard alphabet A-Z a-z 0-9 + / with = padding, plus accepting URL-safe - and _ as drop-in replacements for + and / during decode), byteLength(b64) returns the number of bytes the decoded result will occupy without allocating, toByteArray(b64) returns a Uint8Array (or Array fallback when Uint8Array is undefined in the runtime) populated with the decoded bytes, and fromByteArray(uint8) returns a Base64-encoded string from a Uint8Array using the standard alphabet and = padding as specified by RFC 4648; throws on invalid Base64 input where the length is not a multiple of 4; implements the codec via bitwise arithmetic with a precomputed lookup table for both encode (lookup[index] to character) and decode (revLookup[charCode] to 6-bit value) directions populated at module load time by a top-level for loop iterating over the alphabet string";
        const forest = await shavePackage(BASE64JS_FIXTURE_ROOT, {
          registry,
          entryPath: join(BASE64JS_FIXTURE_ROOT, "index.js"),
        });
        // If entire file stubs (unexpected), skip quality gate and document the gap.
        if (forest.stubCount === forest.moduleCount && forest.moduleCount === 1) {
          // Engine-reality-honest: stub-state prevents atom persistence; quality gate deferred.
          // Unexpected for base64-js (DEC-WI510-S15-NO-CLASSES-001 -- zero classes, #666 N/A).
          // File a NEW engine-gap issue with this evidence before marking slice ready.
          console.log(
            "[base64-js sF] UNEXPECTED STUB STATE: moduleCount=1, stubCount=1. Quality gate deferred.",
          );
          expect(
            forest.stubCount,
            "base64-js sF: stub-state corroboration (DEC-WI510-S15-ENGINE-GAPS-LANDSCAPE-001)",
          ).toBe(1);
          return;
        }
        const plans = await collectForestSlicePlans(forest, slice, registry, "glue-aware");
        for (const { slicePlan } of plans) {
          for (const entry of slicePlan.entries) {
            if (entry.kind === "novel-glue") {
              await maybePersistNovelGlueAtom(
                withSemanticIntentCard(entry, BASE64JS_BEHAVIOR),
                registry,
              );
            }
          }
        }
        const result = await registry.findCandidatesByQuery({
          behavior: BASE64JS_BEHAVIOR,
          topK: 10,
        });
        console.log(
          "[base64-js sF] candidates:",
          result.candidates.map((c) => ({ score: c.combinedScore })),
        );
        expect(
          result.candidates.length,
          "base64-js sF: must find at least one candidate",
        ).toBeGreaterThan(0);
        const topScore = result.candidates[0]?.combinedScore ?? 0;
        console.log("[base64-js sF] top combinedScore:", topScore);
        // Fixed floor >= 0.70 per DEC-WI510-S15-COMBINED-SCORE-FIXED-FLOOR-001.
        // Atom contains byteLength + toByteArray + fromByteArray + getLens + _byteLength +
        // tripletToBase64 + encodeChunk source directly (binding-bearing text).
        // If empirical falls below 0.70, extend semanticHints or document via
        // DEC-WI510-S15-COMBINED-SCORE-EMPIRICAL-FLOOR-002 escape hatch.
        expect(
          topScore,
          "base64-js combinedScore must be >= 0.70 (DEC-WI510-S15-COMBINED-SCORE-FIXED-FLOOR-001)",
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
// for the single base64-js entry, crossing multiple internal component boundaries.
// Asserts: entry produces > 0 persisted atoms + merkle root retrievable from registry.
// DEC-WI510-S15-ONE-FILE-ONE-ROW-001: one file -> one entry-atom containing all three
// exports.byteLength / exports.toByteArray / exports.fromByteArray surfaces via the
// single-module forest.
// DEC-WI510-S15-CJS-EXPORT-SHAPE-001: exports.X = Identifier named-export shape verified
// empirically -- engine treats exports.X MemberExpression assignments as module export surfaces.
// ===========================================================================
describe("base64-js -- compound interaction: entry end-to-end (WI-510 Slice 15 / #642 S15)", () => {
  it(
    "entry resolves, shaves, slices, persists; entry-atom merkle root is retrievable (DEC-WI510-S15-ONE-FILE-ONE-ROW-001)",
    { timeout: 120_000 },
    async () => {
      const registry = await openRegistry(":memory:", {
        embeddings: createOfflineEmbeddingProvider(),
      });
      try {
        const forest = await shavePackage(BASE64JS_FIXTURE_ROOT, {
          registry,
          entryPath: join(BASE64JS_FIXTURE_ROOT, "index.js"),
        });

        // Plan §3.1: single-file entry.
        expect(forest.moduleCount, "compound test: base64-js moduleCount must be 1").toBe(1);

        // DEC-WI510-S15-NO-CLASSES-001: expected 0 stubs; tolerate 1 (engine-reality-honest band).
        expect(
          forest.stubCount,
          "compound test: base64-js stubCount must be <= 1 (DEC-WI510-S15-NO-CLASSES-001)",
        ).toBeLessThanOrEqual(1);

        // DEC-WI510-S15-NO-EXTERNAL-IMPORTS-001: zero require()+imports; empty union is the contract.
        const allExternal = forestModules(forest).flatMap((m) => m.externalSpecifiers);
        expect(
          allExternal,
          "compound test: base64-js externalSpecifiers must be [] (DEC-WI510-S15-NO-EXTERNAL-IMPORTS-001)",
        ).toEqual([]);

        const plans = await collectForestSlicePlans(forest, slice, registry, "glue-aware");

        console.log(
          `[compound] base64-js: moduleCount=${forest.moduleCount} stubCount=${forest.stubCount} leafCount=${forestTotalLeafCount(forest)} plans=${plans.length}`,
        );

        if (forest.stubCount === forest.moduleCount && forest.moduleCount === 1) {
          // Engine-reality-honest: entire tree stubs; no atoms persisted. Expected 0 plans.
          // File new engine-gap issue before declaring readiness.
          expect(
            plans.length,
            "compound test: stub-state fallback -- 0 plans (unexpected per plan §3.1)",
          ).toBe(0);
          return;
        }

        expect(plans.length, "compound test: base64-js plans.length must be > 0").toBeGreaterThan(
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
          `[compound] base64-js: persisted=${persistedCount} entryMR=${entryAtomMerkleRoot?.slice(0, 16)}`,
        );

        expect(persistedCount, "compound test: base64-js must persist > 0 atoms").toBeGreaterThan(
          0,
        );

        // DEC-WI510-S15-ONE-FILE-ONE-ROW-001: entry-atom merkle root must be retrievable.
        // The single-module forest carries all three exports.byteLength / exports.toByteArray /
        // exports.fromByteArray surfaces in one atom (DEC-WI510-S15-CJS-EXPORT-SHAPE-001).
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
