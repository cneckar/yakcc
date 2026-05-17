// SPDX-License-Identifier: MIT
/**
 * csv-parse@6.2.1 headline bindings -- per-entry shave tests (WI-510 Slice 11 / #642 S11)
 *
 * STRUCTURE:
 *   csv-parse callback entry (1 describe: sections A-E)
 *     lib/index.js -- hand-authored ESM; 147 LOC; Parser extends Transform + parse function
 *     externalSpecifiers = ["stream"] (one Node builtin import; DEC-WI510-S11-NODE-BUILTIN-STREAM-001)
 *     Plan ss3.1: moduleCount=9, stubCount<=2, forestTotalLeafCount>=50, wall-clock <180s
 *
 *   csv-parse/sync entry (1 describe: sections A-E)
 *     lib/sync.js -- hand-authored ESM; 28 LOC; synchronous parse function
 *     externalSpecifiers = [] (no Node builtin imports; DEC-WI510-S11-EXTERNAL-SPECIFIERS-EXPECTATIONS-001)
 *     Plan ss3.2: moduleCount=8, stubCount<=2, forestTotalLeafCount>=40, wall-clock <120s
 *
 *   Section F (1 describe, 2 it.skipIf blocks) -- combinedScore quality gates.
 *     Skipped unless DISCOVERY_EVAL_PROVIDER=local.
 *     Fixed floor >= 0.70 per DEC-WI510-S11-COMBINED-SCORE-FIXED-FLOOR-001.
 *     NOTE: Both entries are predicted to fully decompose (no private class fields; #666 N/A).
 *     If Section A produces stubCount === moduleCount for a binding, Section F for that binding
 *     SKIPS with a measurement-citing comment (mirroring S10 engine-reality-honest exit).
 *
 *   Compound interaction test (1 describe) -- both bindings end-to-end.
 *     shavePackage -> collectForestSlicePlans -> maybePersistNovelGlueAtom for both entries
 *     in sequence, asserting two distinct merkle roots (different entry bodies -> different atoms).
 *     DEC-WI510-S11-TWO-ROW-FUNCTION-PAIR-001: callback lib/index.js and sync lib/sync.js
 *     produce distinct atom-merkle-roots even though they share lib/api/ transitive subgraph.
 *
 * Engine-gap landscape (DEC-WI510-S11-ENGINE-GAPS-LANDSCAPE-001):
 *   #576 CLOSED (b5dff3a / PR #604) -- arrow-returns-arrow HOF in class bodies. NOT applicable.
 *   #585 CLOSED (cbefa3c / PR #627) -- UMD IIFE walk. NOT applicable (lib/ is plain ESM).
 *   #619 CLOSED (dual-group engine-gap-honest pattern) -- TSC CJS prelude. NOT applicable.
 *   #666 OPEN but VERIFIED NOT APPLICABLE -- private class fields (#foo). NOT applicable.
 *     csv-parse's three classes (Parser, CsvError, ResizeableBuffer) use this.foo = ... pattern;
 *     no #-syntax anywhere in lib/. Verified at planning time via grep. Full decomposition predicted.
 *
 * Fixture file count: 13 files total
 *   (plan §4.1 counted 9 lib .js files but lists 10; the fixture has 10 lib .js sources +
 *    package.json + LICENSE + PROVENANCE.md = 13; plan §5.6 criterion 16 cites 12 from an
 *    off-by-one in the plan summary; the §4.1 Required files list is authoritative — 13 is correct)
 *
 * @decision DEC-WI510-S11-PER-ENTRY-SHAVE-001
 *   title: Slice 11 shaves two entries (callback lib/index.js + sync lib/sync.js) per-entry
 *   status: accepted
 *   rationale: Inherits per-entry discipline of Slices 2-10. Two shavePackage({ entryPath: ... })
 *   calls producing two separate forest atoms. The published '.' default resolves to
 *   dist/cjs/index.cjs (CJS rollup) for require() consumers and lib/index.js for import consumers;
 *   we point at lib/index.js directly (skipping exports-resolution) for parity with the modern
 *   ESM consumption path. Sync subpath: ./sync exports point at lib/sync.js for import consumers.
 *
 * @decision DEC-WI510-S11-ENTRY-PATH-LIB-ESM-001
 *   title: Slice 11 entries are lib/index.js and lib/sync.js (NOT any dist/* rollup)
 *   status: accepted
 *   rationale: Seven options evaluated. Paths A/B (chosen): lib/index.js + lib/sync.js —
 *   hand-authored ESM with clean import/export/class; no rollup wrapping; no IIFE. Paths D-G
 *   rejected per plan §1.2 (CJS rollup, browser ESM rollup, IIFE, UMD). lib/stream.js out of
 *   scope (web-stream wrapper; per §10 non-goals).
 *
 * @decision DEC-WI510-S11-TWO-ROW-FUNCTION-PAIR-001
 *   title: Two corpus rows (cat1-csv-parse-001 for callback, cat1-csv-parse-sync-001 for sync)
 *   status: accepted
 *   rationale: Two distinct public API surfaces in the published exports (one under '.', one
 *   under './sync'); two distinct file entries; two distinct atom-merkle-roots. B4 query routing
 *   for "synchronous CSV parse" vs "stream-based CSV parsing" requires separate atoms. Precedent:
 *   S4/S6/S9 all shipped two rows for two-binding slices; Slice 11 is within-package two-entry.
 *
 * @decision DEC-WI510-S11-VERSION-PIN-001
 *   title: Pin to csv-parse@6.2.1 (current latest dist-tag at 2026-05-17)
 *   status: accepted
 *   rationale: v6 is the modern ESM-friendly line; canonical ESM path via lib/; current latest.
 *   Older v5/v4 used legacy CJS-first export shapes. v6 atom keying matches fresh npm install.
 *
 * @decision DEC-WI510-S11-FIXTURE-TRIMMED-VENDOR-001
 *   title: Vendor a TRIMMED 13-file subset of the csv-parse-6.2.1 published tarball (30 -> 13)
 *   status: accepted
 *   rationale: Same rationale as Slices 5/7/8/10. Full tarball is 30 files. Only 10 lib/ ESM
 *   source files are transitively reachable from lib/index.js or lib/sync.js. Trimmed vendor
 *   retains the 10 lib/ ESM sources + package.json + LICENSE + PROVENANCE.md.
 *
 * @decision DEC-WI510-S11-NO-INNER-PACKAGE-JSON-001
 *   title: csv-parse does NOT ship inner package.json files; no inner marker copy required
 *   status: accepted
 *   rationale: Unlike S10 lru-cache (tshy emits inner dist/esm/package.json), csv-parse's
 *   rollup-based build doesn't emit inner markers. Root package.json#type:"module" is sufficient.
 *
 * @decision DEC-WI510-S11-NO-PRIVATE-FIELDS-001
 *   title: csv-parse has NO ES2022 private class fields (#foo); the #666 engine-gap is N/A
 *   status: accepted
 *   rationale: Verified at planning time by grep across all 9 lib/ files: grep -nE "^\s*#[a-zA-Z_]"
 *   returns no matches. All three csv-parse classes (Parser, CsvError, ResizeableBuffer) use the
 *   legacy constructor() { this.foo = ... } pattern. Full decomposition predicted.
 *
 * @decision DEC-WI510-S11-NODE-BUILTIN-STREAM-001
 *   title: lib/index.js imports Transform from "stream" (bare specifier); expected in externalSpecifiers
 *   status: accepted
 *   rationale: Same regime as S4 uuid Node-builtin crypto foreign-leaf. The engine extracts the
 *   bare "stream" specifier (not "node:stream"); externalSpecifiers for callback forest = ["stream"].
 *   lib/sync.js has only relative imports; expected externalSpecifiers = [].
 *
 * @decision DEC-WI510-S11-HAND-AUTHORED-ESM-001
 *   title: csv-parse lib/ is hand-authored ESM; engine pattern matches S9 p-limit/p-throttle precedent
 *   status: accepted
 *   rationale: All 10 lib files open with module-scope import/const/function/class and close with
 *   export { ... }. No 'use strict'. No Object.defineProperty(exports,...). No __createBinding.
 *   Patterns validated through S9. Slice 11 extends to a 10-file multi-folder ESM tree.
 *
 * @decision DEC-WI510-S11-ENGINE-GAPS-LANDSCAPE-001
 *   title: Engine gaps #576/#585/#619 CLOSED + #666 OPEN-but-N/A; Slice 11 risk is LOW
 *   status: accepted
 *   rationale: #576/#585/#619 all closed. #666 open but verifiably N/A for csv-parse
 *   (no private class fields per DEC-WI510-S11-NO-PRIVATE-FIELDS-001). Primary risk is
 *   the 922-LOC transform() state machine in lib/api/index.js; engine has validated similar
 *   imperative function bodies through Slices 1-9. If a shape surfaces, ship engine-reality.
 *
 * @decision DEC-WI510-S11-MODERN-PRIMITIVES-001
 *   title: csv-parse uses Buffer/JSON/Array/Math/Error/Object/setImmediate/setTimeout as opaque refs
 *   status: accepted
 *   rationale: Same regime as S9/S10. The strict-subset validator does not stub these at module
 *   scope. If any appear unexpectedly in externalSpecifiers, ship engine-reality per plan §1.6.
 *
 * @decision DEC-WI510-S11-EXTERNAL-SPECIFIERS-EXPECTATIONS-001
 *   title: externalSpecifiers = ["stream"] for lib/index.js forest; [] for lib/sync.js forest
 *   status: accepted
 *   rationale: lib/index.js has exactly one bare-specifier external import (from "stream").
 *   lib/sync.js has only relative imports. All transitives have only relative imports.
 *   Node globals (Buffer, setImmediate, etc.) should NOT appear in externalSpecifiers.
 *
 * @decision DEC-WI510-S11-COMBINED-SCORE-FIXED-FLOOR-001
 *   title: combinedScore >= 0.70 fixed floor for both bindings
 *   status: accepted
 *   rationale: Both entries contain the binding-bearing source text directly (Parser class +
 *   parse function in lib/index.js; sync parse function in lib/sync.js). Same per-binding-
 *   text-rich rationale as Slices 2-9. If empirical falls below 0.70, fall back to refined
 *   semanticHints per plan §5.1 / DEC-WI510-S11-COMBINED-SCORE-EMPIRICAL-FLOOR-002 escape hatch.
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
const CSV_PARSE_FIXTURE_ROOT = join(FIXTURES_DIR, "csv-parse-6.2.1");

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
    notes: ["WI-510 Slice 11 section E stub intent card for persist pipeline test"],
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
    notes: ["WI-510 Slice 11 section F semantic intent card for combinedScore quality gate"],
    modelVersion: STATIC_MODEL_TAG,
    promptVersion: STATIC_PROMPT_VERSION,
    sourceHash: sourceHash(entry.source),
    extractedAt: "2026-05-17T00:00:00.000Z",
  };
  return { ...entry, intentCard: semanticCard };
}

// ===========================================================================
// csv-parse@6.2.1 -- callback/Parser entry (streaming CSV parser)
// Entry: lib/index.js (hand-authored ESM; 147 LOC; Parser extends Transform + parse fn)
// externalSpecifiers: ["stream"] (Node builtin; DEC-WI510-S11-NODE-BUILTIN-STREAM-001)
// Plan ss3.1: moduleCount=9, stubCount<=2, forestTotalLeafCount>=50, wall-clock <180s
// DEC-WI510-S11-NO-PRIVATE-FIELDS-001: no #foo private fields; full decomposition predicted.
// ===========================================================================

// ---------------------------------------------------------------------------
// csv-parse/lib/index.js -- sections A-E
// Timeouts: per-it() 600_000ms (9-module tree; 1985 LOC total; raised from plan's 180s budget
//           after empirical measurement on this machine: shave took >180s on first run;
//           plan §5.6 criterion 12 says to file an engine-performance concern as a separate
//           GitHub issue when the 180s budget is exceeded — see performance concern filed
//           post-slice; timeout raised to 600s to allow tests to complete on this machine)
//           section D 1_200_000ms (two consecutive calls)
// ---------------------------------------------------------------------------
describe("csv-parse/lib/index.js -- per-entry shave (WI-510 Slice 11 / #642 S11)", () => {
  it(
    "section A -- moduleCount=9, stubCount<=2, forestTotalLeafCount>=50, externalSpecifiers=[stream]",
    { timeout: 600_000 },
    async () => {
      const forest = await shavePackage(CSV_PARSE_FIXTURE_ROOT, {
        registry: emptyRegistry,
        entryPath: join(CSV_PARSE_FIXTURE_ROOT, "lib/index.js"),
      });
      console.log("[csv-parse sA] moduleCount:", forest.moduleCount);
      console.log("[csv-parse sA] stubCount:", forest.stubCount);
      console.log(
        "[csv-parse sA] stubs:",
        forestStubs(forest).map((s) => s.specifier),
      );
      console.log("[csv-parse sA] forestTotalLeafCount:", forestTotalLeafCount(forest));
      const allExternal = forestModules(forest).flatMap((m) => m.externalSpecifiers);
      console.log("[csv-parse sA] externalSpecifiers:", allExternal);
      console.log(
        "[csv-parse sA] BFS filePaths:",
        forestModules(forest).map((m) => m.filePath.split("/").slice(-3).join("/")),
      );

      // Plan ss3.1: entry + 8 transitives = 9 in-package modules.
      // BFS: lib/index.js -> lib/utils/is_object.js, lib/api/index.js, lib/api/CsvError.js,
      //   lib/api/normalize_options.js -> lib/api/normalize_columns_array.js, lib/api/init_state.js
      //   -> lib/utils/ResizeableBuffer.js; lib/api/normalize_options.js -> lib/utils/underscore.js
      expect(forest.moduleCount, "csv-parse callback moduleCount must be 9 (plan ss3.1)").toBe(9);

      // DEC-WI510-S11-NO-PRIVATE-FIELDS-001: no #foo private fields; full decomposition expected.
      // DEC-WI510-S11-ENGINE-GAPS-LANDSCAPE-001: #666 N/A; up to 2 stubs tolerated for any
      // unforeseen body shape (e.g. 922-LOC transform() state machine in lib/api/index.js).
      // Empirical-first: if any stubs surface, file a new engine-gap issue per plan §5.5.
      expect(
        forest.stubCount,
        "csv-parse callback stubCount must be <= 2 (engine-reality-honest band; expected 0; DEC-WI510-S11-NO-PRIVATE-FIELDS-001)",
      ).toBeLessThanOrEqual(2);

      // Plan ss3.1: conservative floor >= 50; predicted 100-200 across 9 modules.
      expect(
        forestTotalLeafCount(forest),
        "csv-parse callback forestTotalLeafCount must be >= 50 (plan ss3.1)",
      ).toBeGreaterThanOrEqual(50);

      // DEC-WI510-S11-NODE-BUILTIN-STREAM-001: lib/index.js has exactly one bare-specifier
      // external import: import { Transform } from "stream". csv-parse uses bare "stream",
      // not "node:stream". Expected: ["stream"]. Empirical-first assertion.
      // If engine produces [] here (e.g. by ignoring non-package specifiers), record empirical.
      expect(
        allExternal,
        'csv-parse callback externalSpecifiers must be ["stream"] (DEC-WI510-S11-NODE-BUILTIN-STREAM-001)',
      ).toEqual(["stream"]);
    },
  );

  it(
    "section B -- forest.nodes[0] is csv-parse-6.2.1/lib/index.js (callback entry; BFS root)",
    { timeout: 600_000 },
    async () => {
      const forest = await shavePackage(CSV_PARSE_FIXTURE_ROOT, {
        registry: emptyRegistry,
        entryPath: join(CSV_PARSE_FIXTURE_ROOT, "lib/index.js"),
      });
      const firstNode = forest.nodes[0];
      expect(firstNode).toBeDefined();
      expect(
        firstNode?.kind,
        "csv-parse callback first BFS node must be a module (not a stub)",
      ).toBe("module");
      if (firstNode?.kind === "module") {
        expect(
          firstNode.filePath,
          "csv-parse callback first BFS node must contain index.js",
        ).toContain("index.js");
        expect(
          firstNode.filePath,
          "csv-parse callback first BFS node must be inside csv-parse-6.2.1/",
        ).toContain("csv-parse-6.2.1");
        expect(
          firstNode.filePath,
          "csv-parse callback first BFS node must be inside lib/ (hand-authored ESM tree)",
        ).toContain("lib/");
      }
    },
  );

  it(
    "section C -- all 9 modules inside csv-parse-6.2.1/ boundary; externalSpecifiers=[stream]; stubCount<=2",
    { timeout: 600_000 },
    async () => {
      const forest = await shavePackage(CSV_PARSE_FIXTURE_ROOT, {
        registry: emptyRegistry,
        entryPath: join(CSV_PARSE_FIXTURE_ROOT, "lib/index.js"),
      });
      const filePaths = forestModules(forest).map((m) => m.filePath);
      for (const fp of filePaths) {
        expect(
          normalize(fp),
          `csv-parse module path must be inside csv-parse-6.2.1/: ${fp}`,
        ).toContain("csv-parse-6.2.1");
      }
      const allExternal = forestModules(forest).flatMap((m) => m.externalSpecifiers);
      expect(
        allExternal,
        'csv-parse callback externalSpecifiers must be ["stream"] (DEC-WI510-S11-NODE-BUILTIN-STREAM-001)',
      ).toEqual(["stream"]);
      const stubs = forestStubs(forest);
      expect(
        stubs.length,
        "csv-parse callback stubs must be <= 2 (engine-reality-honest band; DEC-WI510-S11-ENGINE-GAPS-LANDSCAPE-001)",
      ).toBeLessThanOrEqual(2);
    },
  );

  it(
    "section D -- two-pass byte-identical determinism for csv-parse/lib/index.js",
    { timeout: 1_200_000 },
    async () => {
      const forest1 = await shavePackage(CSV_PARSE_FIXTURE_ROOT, {
        registry: emptyRegistry,
        entryPath: join(CSV_PARSE_FIXTURE_ROOT, "lib/index.js"),
      });
      const forest2 = await shavePackage(CSV_PARSE_FIXTURE_ROOT, {
        registry: emptyRegistry,
        entryPath: join(CSV_PARSE_FIXTURE_ROOT, "lib/index.js"),
      });
      expect(
        forest1.moduleCount,
        "csv-parse callback two-pass: moduleCount must be identical",
      ).toBe(forest2.moduleCount);
      expect(forest1.stubCount, "csv-parse callback two-pass: stubCount must be identical").toBe(
        forest2.stubCount,
      );
      const paths1 = forestModules(forest1).map((m) => normalize(m.filePath));
      const paths2 = forestModules(forest2).map((m) => normalize(m.filePath));
      expect(
        paths1,
        "csv-parse callback two-pass: BFS filePath list must be byte-identical",
      ).toEqual(paths2);
      const ext1 = forestModules(forest1).flatMap((m) => m.externalSpecifiers);
      const ext2 = forestModules(forest2).flatMap((m) => m.externalSpecifiers);
      expect(
        ext1,
        "csv-parse callback two-pass: externalSpecifiers must be byte-identical",
      ).toEqual(ext2);
      expect(
        forestTotalLeafCount(forest1),
        "csv-parse callback two-pass: forestTotalLeafCount must be identical",
      ).toBe(forestTotalLeafCount(forest2));
    },
  );

  it(
    "section E -- csv-parse callback forest persisted via real collectForestSlicePlans -> maybePersistNovelGlueAtom path",
    { timeout: 600_000 },
    async () => {
      const registry = await openRegistry(":memory:", {
        embeddings: createOfflineEmbeddingProvider(),
      });
      try {
        const forest = await shavePackage(CSV_PARSE_FIXTURE_ROOT, {
          registry,
          entryPath: join(CSV_PARSE_FIXTURE_ROOT, "lib/index.js"),
        });
        // DEC-WI510-S11-NO-PRIVATE-FIELDS-001: full decomposition expected; plans > 0.
        // If stubCount === moduleCount (entire tree stubs), this section adjusts to assert 0 plans
        // and documents the engine-reality state per S10 stub-state pattern. Predicted: no stubs.
        const plans = await collectForestSlicePlans(forest, slice, registry, "glue-aware");
        console.log("[csv-parse sE] plans.length:", plans.length);
        console.log(
          "[csv-parse sE] moduleCount:",
          forest.moduleCount,
          "stubCount:",
          forest.stubCount,
        );
        if (forest.stubCount === forest.moduleCount && forest.moduleCount === 0) {
          // Engine-reality-honest fallback: entire tree stubs (unexpected per plan).
          // File a new engine-gap issue with this evidence.
          expect(
            plans.length,
            "csv-parse callback sE: stub-state fallback — 0 plans (entire tree stubs; unexpected)",
          ).toBe(0);
        } else {
          expect(
            plans.length,
            "csv-parse callback sE: collectForestSlicePlans must return > 0 plans",
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
                    "csv-parse callback sE: persisted atom must be retrievable via registry.getBlock",
                  ).not.toBeNull();
                }
              }
            }
          }
          console.log("[csv-parse sE] persisted atoms:", persistedCount);
          console.log("[csv-parse sE] headline merkle root:", headlineMerkleRoot);
          expect(
            persistedCount,
            "csv-parse callback sE: at least one atom must persist (novel-glue path)",
          ).toBeGreaterThan(0);
        }
      } finally {
        await registry.close();
      }
    },
  );
});

// ===========================================================================
// csv-parse@6.2.1 -- sync entry (synchronous CSV parser)
// Entry: lib/sync.js (hand-authored ESM; 28 LOC; synchronous parse function)
// externalSpecifiers: [] (no Node builtin imports; DEC-WI510-S11-EXTERNAL-SPECIFIERS-EXPECTATIONS-001)
// Plan ss3.2: moduleCount=8, stubCount<=2, forestTotalLeafCount>=40, wall-clock <120s
// NOTE: lib/sync.js does NOT import lib/index.js; subgraph is lib/api/* + lib/utils/* only.
// ===========================================================================

// ---------------------------------------------------------------------------
// csv-parse/lib/sync.js -- sections A-E
// Timeouts: per-it() 600_000ms (8-module tree; raised from plan's 120s budget after empirical
//           measurement showing callback took >180s on this machine; sync subgraph is similar
//           in complexity due to shared lib/api/index.js 922-LOC state machine; performance
//           concern filed post-slice per plan §5.6 criterion 12)
//           section D 1_200_000ms (two consecutive calls)
// ---------------------------------------------------------------------------
describe("csv-parse/lib/sync.js -- per-entry shave (WI-510 Slice 11 / #642 S11)", () => {
  it(
    "section A -- moduleCount=8, stubCount<=2, forestTotalLeafCount>=40, externalSpecifiers=[]",
    { timeout: 600_000 },
    async () => {
      const forest = await shavePackage(CSV_PARSE_FIXTURE_ROOT, {
        registry: emptyRegistry,
        entryPath: join(CSV_PARSE_FIXTURE_ROOT, "lib/sync.js"),
      });
      console.log("[csv-parse-sync sA] moduleCount:", forest.moduleCount);
      console.log("[csv-parse-sync sA] stubCount:", forest.stubCount);
      console.log(
        "[csv-parse-sync sA] stubs:",
        forestStubs(forest).map((s) => s.specifier),
      );
      console.log("[csv-parse-sync sA] forestTotalLeafCount:", forestTotalLeafCount(forest));
      const allExternal = forestModules(forest).flatMap((m) => m.externalSpecifiers);
      console.log("[csv-parse-sync sA] externalSpecifiers:", allExternal);
      console.log(
        "[csv-parse-sync sA] BFS filePaths:",
        forestModules(forest).map((m) => m.filePath.split("/").slice(-3).join("/")),
      );

      // Plan ss3.2: entry + 7 transitives = 8 in-package modules.
      // BFS: lib/sync.js -> lib/api/index.js -> lib/api/normalize_columns_array.js,
      //   lib/api/init_state.js, lib/api/normalize_options.js, lib/api/CsvError.js
      //   -> lib/utils/underscore.js; lib/api/normalize_columns_array.js -> lib/utils/is_object.js;
      //   lib/api/init_state.js -> lib/utils/ResizeableBuffer.js
      // NOTE: lib/index.js is NOT reached (sync.js doesn't import it).
      expect(forest.moduleCount, "csv-parse sync moduleCount must be 8 (plan ss3.2)").toBe(8);

      // DEC-WI510-S11-NO-PRIVATE-FIELDS-001: no #foo private fields; full decomposition expected.
      expect(
        forest.stubCount,
        "csv-parse sync stubCount must be <= 2 (engine-reality-honest band; expected 0; DEC-WI510-S11-NO-PRIVATE-FIELDS-001)",
      ).toBeLessThanOrEqual(2);

      // Plan ss3.2: conservative floor >= 40; bulk from lib/api/ transitives.
      expect(
        forestTotalLeafCount(forest),
        "csv-parse sync forestTotalLeafCount must be >= 40 (plan ss3.2)",
      ).toBeGreaterThanOrEqual(40);

      // DEC-WI510-S11-EXTERNAL-SPECIFIERS-EXPECTATIONS-001: lib/sync.js has no external imports.
      // All imports in sync's transitive subgraph are relative in-package paths. Expected: [].
      expect(
        allExternal,
        "csv-parse sync externalSpecifiers must be [] (no Node builtin imports in sync subgraph; DEC-WI510-S11-EXTERNAL-SPECIFIERS-EXPECTATIONS-001)",
      ).toEqual([]);
    },
  );

  it(
    "section B -- forest.nodes[0] is csv-parse-6.2.1/lib/sync.js (sync entry; BFS root)",
    { timeout: 600_000 },
    async () => {
      const forest = await shavePackage(CSV_PARSE_FIXTURE_ROOT, {
        registry: emptyRegistry,
        entryPath: join(CSV_PARSE_FIXTURE_ROOT, "lib/sync.js"),
      });
      const firstNode = forest.nodes[0];
      expect(firstNode).toBeDefined();
      expect(firstNode?.kind, "csv-parse sync first BFS node must be a module (not a stub)").toBe(
        "module",
      );
      if (firstNode?.kind === "module") {
        expect(firstNode.filePath, "csv-parse sync first BFS node must contain sync.js").toContain(
          "sync.js",
        );
        expect(
          firstNode.filePath,
          "csv-parse sync first BFS node must be inside csv-parse-6.2.1/",
        ).toContain("csv-parse-6.2.1");
      }
    },
  );

  it(
    "section C -- all 8 modules inside csv-parse-6.2.1/ boundary; externalSpecifiers=[]; stubCount<=2",
    { timeout: 600_000 },
    async () => {
      const forest = await shavePackage(CSV_PARSE_FIXTURE_ROOT, {
        registry: emptyRegistry,
        entryPath: join(CSV_PARSE_FIXTURE_ROOT, "lib/sync.js"),
      });
      const filePaths = forestModules(forest).map((m) => m.filePath);
      for (const fp of filePaths) {
        expect(
          normalize(fp),
          `csv-parse sync module path must be inside csv-parse-6.2.1/: ${fp}`,
        ).toContain("csv-parse-6.2.1");
      }
      const allExternal = forestModules(forest).flatMap((m) => m.externalSpecifiers);
      expect(
        allExternal,
        "csv-parse sync externalSpecifiers must be [] (DEC-WI510-S11-EXTERNAL-SPECIFIERS-EXPECTATIONS-001)",
      ).toEqual([]);
      const stubs = forestStubs(forest);
      expect(
        stubs.length,
        "csv-parse sync stubs must be <= 2 (engine-reality-honest band; DEC-WI510-S11-ENGINE-GAPS-LANDSCAPE-001)",
      ).toBeLessThanOrEqual(2);
    },
  );

  it(
    "section D -- two-pass byte-identical determinism for csv-parse/lib/sync.js",
    { timeout: 1_200_000 },
    async () => {
      const forest1 = await shavePackage(CSV_PARSE_FIXTURE_ROOT, {
        registry: emptyRegistry,
        entryPath: join(CSV_PARSE_FIXTURE_ROOT, "lib/sync.js"),
      });
      const forest2 = await shavePackage(CSV_PARSE_FIXTURE_ROOT, {
        registry: emptyRegistry,
        entryPath: join(CSV_PARSE_FIXTURE_ROOT, "lib/sync.js"),
      });
      expect(forest1.moduleCount, "csv-parse sync two-pass: moduleCount must be identical").toBe(
        forest2.moduleCount,
      );
      expect(forest1.stubCount, "csv-parse sync two-pass: stubCount must be identical").toBe(
        forest2.stubCount,
      );
      const paths1 = forestModules(forest1).map((m) => normalize(m.filePath));
      const paths2 = forestModules(forest2).map((m) => normalize(m.filePath));
      expect(paths1, "csv-parse sync two-pass: BFS filePath list must be byte-identical").toEqual(
        paths2,
      );
      const ext1 = forestModules(forest1).flatMap((m) => m.externalSpecifiers);
      const ext2 = forestModules(forest2).flatMap((m) => m.externalSpecifiers);
      expect(ext1, "csv-parse sync two-pass: externalSpecifiers must be byte-identical").toEqual(
        ext2,
      );
      expect(
        forestTotalLeafCount(forest1),
        "csv-parse sync two-pass: forestTotalLeafCount must be identical",
      ).toBe(forestTotalLeafCount(forest2));
    },
  );

  it(
    "section E -- csv-parse sync forest persisted via real collectForestSlicePlans -> maybePersistNovelGlueAtom path",
    { timeout: 600_000 },
    async () => {
      const registry = await openRegistry(":memory:", {
        embeddings: createOfflineEmbeddingProvider(),
      });
      try {
        const forest = await shavePackage(CSV_PARSE_FIXTURE_ROOT, {
          registry,
          entryPath: join(CSV_PARSE_FIXTURE_ROOT, "lib/sync.js"),
        });
        const plans = await collectForestSlicePlans(forest, slice, registry, "glue-aware");
        console.log("[csv-parse-sync sE] plans.length:", plans.length);
        console.log(
          "[csv-parse-sync sE] moduleCount:",
          forest.moduleCount,
          "stubCount:",
          forest.stubCount,
        );
        if (forest.stubCount === forest.moduleCount && forest.moduleCount === 0) {
          // Engine-reality-honest fallback: entire tree stubs (unexpected per plan).
          expect(
            plans.length,
            "csv-parse sync sE: stub-state fallback — 0 plans (entire tree stubs; unexpected)",
          ).toBe(0);
        } else {
          expect(
            plans.length,
            "csv-parse sync sE: collectForestSlicePlans must return > 0 plans",
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
                    "csv-parse sync sE: persisted atom must be retrievable via registry.getBlock",
                  ).not.toBeNull();
                }
              }
            }
          }
          console.log("[csv-parse-sync sE] persisted atoms:", persistedCount);
          console.log("[csv-parse-sync sE] headline merkle root:", headlineMerkleRoot);
          expect(
            persistedCount,
            "csv-parse sync sE: at least one atom must persist (novel-glue path)",
          ).toBeGreaterThan(0);
        }
      } finally {
        await registry.close();
      }
    },
  );
});

// ===========================================================================
// Section F -- combinedScore quality gates (fixed floor >= 0.70)
// DEC-WI510-S11-COMBINED-SCORE-FIXED-FLOOR-001: Atoms contain the binding-bearing
// source text directly (Parser class + parse() fn in lib/index.js; sync parse in lib/sync.js).
// Skipped unless DISCOVERY_EVAL_PROVIDER=local.
// NOTE: If Section A for a binding produces stubCount === moduleCount === 0, that binding's
// Section F SKIPS with a measurement-citing comment (mirroring S10 stub-state exit).
// Predicted: both bindings fully decompose (no private class fields; #666 N/A).
// ===========================================================================
describe("csv-parse section F -- combinedScore quality gates (WI-510 Slice 11 / #642 S11)", () => {
  // ---------------------------------------------------------------------------
  // csv-parse ssF.1: callback/Parser API -- streaming CSV parser
  // Query: corpus cat1-csv-parse-001 behavior string (plan §5.4 Row 1)
  // ---------------------------------------------------------------------------
  it.skipIf(!USE_LOCAL_PROVIDER)(
    "csv-parse callback combinedScore >= 0.70 for corpus query (DISCOVERY_EVAL_PROVIDER=local)",
    { timeout: 60_000 },
    async () => {
      const registry = await openRegistry(":memory:", {
        embeddings: createLocalEmbeddingProvider("Xenova/all-MiniLM-L6-v2", 384),
      });
      try {
        const CSV_PARSE_BEHAVIOR =
          "Streaming CSV parser implementing the Node.js stream.Transform API; consumes string or Buffer input and emits parsed records as arrays or objects; supports callback-style invocation with parse(input, options, cb); handles quoted fields, custom delimiters, record terminators, BOM stripping, and column header mapping when columns option is true";
        const forest = await shavePackage(CSV_PARSE_FIXTURE_ROOT, {
          registry,
          entryPath: join(CSV_PARSE_FIXTURE_ROOT, "lib/index.js"),
        });
        // If entire tree stubs (unexpected), skip the quality gate and document the gap.
        if (forest.stubCount === forest.moduleCount && forest.moduleCount === 0) {
          // Engine-reality-honest: stub-state prevents atom persistence; quality gate deferred.
          // Unexpected for csv-parse (DEC-WI510-S11-NO-PRIVATE-FIELDS-001); file new engine-gap issue.
          console.log(
            "[csv-parse sF.1] UNEXPECTED STUB STATE: moduleCount=0, stubCount=1. Quality gate deferred.",
          );
          expect(forest.stubCount, "csv-parse sF.1: stub-state corroboration").toBe(1);
          return;
        }
        const plans = await collectForestSlicePlans(forest, slice, registry, "glue-aware");
        for (const { slicePlan } of plans) {
          for (const entry of slicePlan.entries) {
            if (entry.kind === "novel-glue") {
              await maybePersistNovelGlueAtom(
                withSemanticIntentCard(entry, CSV_PARSE_BEHAVIOR),
                registry,
              );
            }
          }
        }
        const result = await registry.findCandidatesByQuery({
          behavior: CSV_PARSE_BEHAVIOR,
          topK: 10,
        });
        console.log(
          "[csv-parse sF.1] candidates:",
          result.candidates.map((c) => ({ score: c.combinedScore })),
        );
        expect(
          result.candidates.length,
          "csv-parse sF.1: must find at least one candidate",
        ).toBeGreaterThan(0);
        const topScore = result.candidates[0]?.combinedScore ?? 0;
        console.log("[csv-parse sF.1] top combinedScore:", topScore);
        // Fixed floor >= 0.70 per DEC-WI510-S11-COMBINED-SCORE-FIXED-FLOOR-001.
        // If empirical falls below 0.70, fall back to refined semanticHints per plan §5.1.
        expect(
          topScore,
          "csv-parse callback combinedScore must be >= 0.70 (DEC-WI510-S11-COMBINED-SCORE-FIXED-FLOOR-001)",
        ).toBeGreaterThanOrEqual(0.7);
      } finally {
        await registry.close();
      }
    },
  );

  // ---------------------------------------------------------------------------
  // csv-parse ssF.2: sync API -- synchronous CSV parser
  // Query: corpus cat1-csv-parse-sync-001 behavior string (plan §5.4 Row 2)
  // ---------------------------------------------------------------------------
  it.skipIf(!USE_LOCAL_PROVIDER)(
    "csv-parse/sync combinedScore >= 0.70 for corpus query (DISCOVERY_EVAL_PROVIDER=local)",
    { timeout: 60_000 },
    async () => {
      const registry = await openRegistry(":memory:", {
        embeddings: createLocalEmbeddingProvider("Xenova/all-MiniLM-L6-v2", 384),
      });
      try {
        const CSV_PARSE_SYNC_BEHAVIOR =
          "Synchronous CSV parser that takes a complete string or Buffer input and returns the full array of parsed records in a single blocking call; throws CsvError on malformed input; supports the same option surface as the streaming parser including delimiters, quotes, BOM handling, and columns-as-headers; does not implement stream.Transform";
        const forest = await shavePackage(CSV_PARSE_FIXTURE_ROOT, {
          registry,
          entryPath: join(CSV_PARSE_FIXTURE_ROOT, "lib/sync.js"),
        });
        // If entire tree stubs (unexpected), skip the quality gate and document the gap.
        if (forest.stubCount === forest.moduleCount && forest.moduleCount === 0) {
          console.log(
            "[csv-parse sF.2] UNEXPECTED STUB STATE: moduleCount=0, stubCount=1. Quality gate deferred.",
          );
          expect(forest.stubCount, "csv-parse sF.2: stub-state corroboration").toBe(1);
          return;
        }
        const plans = await collectForestSlicePlans(forest, slice, registry, "glue-aware");
        for (const { slicePlan } of plans) {
          for (const entry of slicePlan.entries) {
            if (entry.kind === "novel-glue") {
              await maybePersistNovelGlueAtom(
                withSemanticIntentCard(entry, CSV_PARSE_SYNC_BEHAVIOR),
                registry,
              );
            }
          }
        }
        const result = await registry.findCandidatesByQuery({
          behavior: CSV_PARSE_SYNC_BEHAVIOR,
          topK: 10,
        });
        console.log(
          "[csv-parse sF.2] candidates:",
          result.candidates.map((c) => ({ score: c.combinedScore })),
        );
        expect(
          result.candidates.length,
          "csv-parse sF.2: must find at least one candidate",
        ).toBeGreaterThan(0);
        const topScore = result.candidates[0]?.combinedScore ?? 0;
        console.log("[csv-parse sF.2] top combinedScore:", topScore);
        // Fixed floor >= 0.70 per DEC-WI510-S11-COMBINED-SCORE-FIXED-FLOOR-001.
        expect(
          topScore,
          "csv-parse/sync combinedScore must be >= 0.70 (DEC-WI510-S11-COMBINED-SCORE-FIXED-FLOOR-001)",
        ).toBeGreaterThanOrEqual(0.7);
      } finally {
        await registry.close();
      }
    },
  );
});

// ===========================================================================
// Compound interaction test -- real production sequence end-to-end
// Plan ss5.1: exercises shavePackage -> collectForestSlicePlans -> maybePersistNovelGlueAtom
// for both csv-parse entries in sequence, crossing multiple internal component boundaries.
// Asserts: both entries produce non-zero atoms + two DISTINCT merkle roots.
// DEC-WI510-S11-TWO-ROW-FUNCTION-PAIR-001: callback lib/index.js and sync lib/sync.js
// have different entry bodies (Parser class + parse fn vs sync parse fn) -> distinct atoms.
// Even though they share transitive lib/api/ subgraph atoms, the entry-atoms differ.
// ===========================================================================
describe("csv-parse -- compound interaction: both entries end-to-end (WI-510 Slice 11 / #642 S11)", () => {
  it(
    "both bindings resolve, slice, persist; produce distinct entry-atom merkle roots (DEC-WI510-S11-TWO-ROW-FUNCTION-PAIR-001)",
    { timeout: 1_200_000 },
    async () => {
      const bindings = [
        {
          name: "csv-parse (callback)",
          entry: "lib/index.js",
          expectedModuleCount: 9,
          expectedExternalSpecifiers: ["stream"] as string[],
        },
        {
          name: "csv-parse/sync",
          entry: "lib/sync.js",
          expectedModuleCount: 8,
          expectedExternalSpecifiers: [] as string[],
        },
      ];

      const seenMerkleRoots = new Set<string>();

      for (const b of bindings) {
        const registry = await openRegistry(":memory:", {
          embeddings: createOfflineEmbeddingProvider(),
        });
        try {
          const forest = await shavePackage(CSV_PARSE_FIXTURE_ROOT, {
            registry,
            entryPath: join(CSV_PARSE_FIXTURE_ROOT, b.entry),
          });

          expect(
            forest.moduleCount,
            `${b.name}: compound test moduleCount must be ${b.expectedModuleCount}`,
          ).toBe(b.expectedModuleCount);
          expect(
            forest.stubCount,
            `${b.name}: compound test stubCount must be <= 2 (DEC-WI510-S11-NO-PRIVATE-FIELDS-001)`,
          ).toBeLessThanOrEqual(2);

          const allExternal = forestModules(forest).flatMap((m) => m.externalSpecifiers);
          expect(
            allExternal,
            `${b.name}: compound test externalSpecifiers (DEC-WI510-S11-EXTERNAL-SPECIFIERS-EXPECTATIONS-001)`,
          ).toEqual(b.expectedExternalSpecifiers);

          const plans = await collectForestSlicePlans(forest, slice, registry, "glue-aware");
          expect(plans.length, `${b.name}: compound test plans.length must be > 0`).toBeGreaterThan(
            0,
          );

          let persistedCount = 0;
          let firstMerkleRoot: string | undefined;
          for (const { slicePlan } of plans) {
            for (const entry of slicePlan.entries) {
              if (entry.kind === "novel-glue") {
                const mr = await maybePersistNovelGlueAtom(withStubIntentCard(entry), registry);
                if (mr !== undefined) {
                  persistedCount++;
                  if (firstMerkleRoot === undefined) firstMerkleRoot = mr;
                }
              }
            }
          }
          console.log(
            `[compound] ${b.name}: moduleCount=${forest.moduleCount} stubCount=${forest.stubCount} leafCount=${forestTotalLeafCount(forest)} persisted=${persistedCount} firstMR=${firstMerkleRoot?.slice(0, 16)}`,
          );
          expect(persistedCount, `${b.name}: compound test must persist > 0 atoms`).toBeGreaterThan(
            0,
          );

          // Collect the first (entry-atom) merkle root to verify distinctness.
          // DEC-WI510-S11-TWO-ROW-FUNCTION-PAIR-001: two entries -> two distinct first atoms.
          if (firstMerkleRoot !== undefined) {
            seenMerkleRoots.add(firstMerkleRoot);
          }
        } finally {
          await registry.close();
        }
      }

      // Both entries must produce distinct first-atom merkle roots.
      // lib/index.js entry body (Parser class + parse fn) != lib/sync.js entry body (sync parse fn).
      // If they collide, that would indicate a canonicalization-collision bug.
      expect(
        seenMerkleRoots.size,
        "compound test: csv-parse callback and sync must produce two DISTINCT merkle roots (DEC-WI510-S11-TWO-ROW-FUNCTION-PAIR-001)",
      ).toBe(2);
    },
  );
});
