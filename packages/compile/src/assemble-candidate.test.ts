/**
 * assemble-candidate.test.ts — tests for the compile-time continuous-shave
 * entry point (WI-014-05, DEC-COMPILE-CANDIDATE-001).
 *
 * Production trigger: assembleCandidate() is called by the CLI (WI-015) when a
 * user passes raw source text they want to compile. It runs universalize() on
 * the source, resolves the resulting slice plan to a BlockMerkleRoot, then
 * delegates to assemble().
 *
 * Real production sequence (documented, tested):
 *   candidateSource
 *     → universalize() [license gate → extractIntent (cache) → decompose → slice]
 *     → PointerEntry(merkleRoot) or NovelGlueEntry or multi-leaf
 *     → assemble(merkleRoot, registry)
 *     → Artifact { source, manifest }
 *
 * License-refusal test (Test 1): fully live — the license gate fires BEFORE
 * extractIntent, so no cache or API key is required.
 *
 * Tests 2–4 (PointerEntry end-to-end, multi-leaf, novel-glue): re-enabled as
 * part of WI-018 using the public seedIntentCache() helper exported from
 * @yakcc/shave. seedIntentCache() writes intent cache entries offline without
 * calling the Anthropic API (DEC-SHAVE-002, DEC-SHAVE-SEED-001).
 *
 * @decision DEC-COMPILE-AC-TEST-001
 * title: assemble-candidate tests use expression-body arrow functions (WI-018)
 * status: decided (WI-018)
 * rationale:
 *   Test sources use const + arrow function with expression body (not block body)
 *   to avoid a CanonicalAstParseError in childMatchesRegistry() in
 *   recursion.ts. That function hashes the source text of each decomposable child
 *   as a standalone string; for block-body functions, the child is a bare
 *   `return` statement which is invalid TypeScript at file scope. Expression-body
 *   arrow functions assigned to a const produce a VariableStatement with no
 *   decomposable children (getTopLevelStatements returns []), so childMatchesRegistry
 *   returns false immediately without calling canonicalAstHash on any child.
 *   This pattern is established in shave/src/universalize/wiring.test.ts.
 *
 *   The IntentCard.sourceHash field is populated using the internal sourceHash
 *   helper from @yakcc/shave (accessed via the vitest alias). This produces the
 *   exact same hash that seedIntentCache() will use for key derivation, ensuring
 *   the cache entry is readable by extractIntent() during the test.
 *
 *   Identifier constants (DEFAULT_MODEL, INTENT_PROMPT_VERSION) are imported
 *   from the shave source via the vitest alias (same as the module alias used
 *   for @yakcc/shave itself). This avoids hardcoding values that could drift.
 */

import { mkdir } from "node:fs/promises";
import * as os from "node:os";
import { join } from "node:path";
import {
  type BlockMerkleRoot,
  type SpecHash,
  type SpecYak,
  blockMerkleRoot,
  canonicalAstHash,
  specHash,
} from "@yakcc/contracts";
import { openRegistry } from "@yakcc/registry";
import type { BlockTripletRow, Registry } from "@yakcc/registry";
import {
  type IntentCard,
  type SeedIntentSpec,
  LicenseRefusedError,
  seedIntentCache,
} from "@yakcc/shave";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assembleCandidate, CandidateNotResolvableError } from "./assemble-candidate.js";

// ---------------------------------------------------------------------------
// Internal shave helpers imported via the vitest alias
// (alias: @yakcc/shave → packages/shave/src/index.ts, same as the main entry)
// These are internal modules not on the public exports map, accessed only in
// test code to compute the exact hashes that extractIntent() uses internally.
// ---------------------------------------------------------------------------

// Dynamic imports used below to access internal modules from shave source tree.
// The vitest alias for @yakcc/shave resolves to the source directory.

// ---------------------------------------------------------------------------
// Constants imported from shave source via relative path from the alias root.
// Must match packages/shave/src/intent/constants.ts exactly.
// ---------------------------------------------------------------------------

import { DEFAULT_MODEL, INTENT_PROMPT_VERSION } from "../../../packages/shave/src/intent/constants.js";
import { sourceHash as computeSourceHash } from "../../../packages/shave/src/cache/key.js";

// ---------------------------------------------------------------------------
// Per-test isolation: cacheDir, registry, API key
// ---------------------------------------------------------------------------

let cacheDir: string;
let registry: Registry;

beforeEach(async () => {
  const unique = Math.random().toString(36).slice(2);
  cacheDir = join(os.tmpdir(), `ac-test-${unique}`);
  await mkdir(cacheDir, { recursive: true });
  // biome-ignore lint/performance/noDelete: process.env requires delete to truly unset
  delete process.env.ANTHROPIC_API_KEY;
  registry = await openRegistry(":memory:");
});

afterEach(async () => {
  await registry.close();
  const { rm } = await import("node:fs/promises");
  await rm(cacheDir, { recursive: true, force: true }).catch(() => {});
  // biome-ignore lint/performance/noDelete: process.env requires delete to truly unset
  delete process.env.ANTHROPIC_API_KEY;
});

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal SpecYak for testing. Each unique behavior string produces
 * a distinct SpecHash (and thus a distinct BlockMerkleRoot when combined with
 * distinct impl sources).
 */
function makeSpecYak(name: string, behavior: string): SpecYak {
  return {
    name,
    inputs: [{ name: "input", type: "string" }],
    outputs: [{ name: "result", type: "string" }],
    preconditions: [],
    postconditions: [],
    invariants: [],
    effects: [],
    level: "L0",
    behavior,
    guarantees: [],
    errorConditions: [],
    nonFunctional: { purity: "pure", threadSafety: "safe" },
    propertyTests: [],
  };
}

/** Minimal proof manifest JSON for L0. */
const MINIMAL_MANIFEST_JSON = JSON.stringify({
  artifacts: [{ kind: "property_tests", path: "tests.fast-check.ts" }],
});

/**
 * Build a BlockTripletRow for a self-contained impl source and store it in
 * the given in-memory registry. Returns the row and its merkleRoot.
 *
 * The row's canonicalAstHash is derived from implSource. For the slicer to
 * produce a PointerEntry, the candidate source's atom's nodeSource must produce
 * the same canonicalAstHash. See DEC-COMPILE-AC-TEST-001 for the reasoning.
 */
async function storeBlock(
  reg: Registry,
  name: string,
  behavior: string,
  implSource: string,
): Promise<{ row: BlockTripletRow; merkleRoot: BlockMerkleRoot; specHashValue: SpecHash }> {
  const spec = makeSpecYak(name, behavior);
  const specHashValue = specHash(spec);
  const canonBytes = new TextEncoder().encode(JSON.stringify(spec));

  const manifest = JSON.parse(MINIMAL_MANIFEST_JSON) as {
    artifacts: Array<{ kind: string; path: string }>;
  };
  const artifactBytes = new TextEncoder().encode(implSource);
  const artifactsMap = new Map<string, Uint8Array>();
  for (const art of manifest.artifacts) {
    artifactsMap.set(art.path, artifactBytes);
  }

  const root = blockMerkleRoot({
    spec,
    implSource,
    manifest: manifest as Parameters<typeof blockMerkleRoot>[0]["manifest"],
    artifacts: artifactsMap,
  });

  const row: BlockTripletRow = {
    blockMerkleRoot: root,
    specHash: specHashValue,
    specCanonicalBytes: canonBytes,
    implSource,
    proofManifestJson: MINIMAL_MANIFEST_JSON,
    level: "L0",
    createdAt: Date.now(),
    canonicalAstHash: canonicalAstHash(implSource),
    parentBlockRoot: null,
  };

  await reg.storeBlock(row);
  return { row, merkleRoot: root, specHashValue };
}

/**
 * Build a minimal IntentCard for offline cache seeding.
 *
 * Uses computeSourceHash (the internal BLAKE3 source-hash function from
 * @yakcc/shave) to produce the exact sourceHash that extractIntent() would
 * store — ensuring the seeded card passes validateIntentCard() on read-back.
 *
 * Behavior text is accepted as a parameter for test readability.
 */
function makeIntentCard(source: string, behavior: string): IntentCard {
  return {
    schemaVersion: 1,
    behavior,
    inputs: [{ name: "x", typeHint: "number", description: "Input" }],
    outputs: [{ name: "result", typeHint: "number", description: "Output" }],
    preconditions: [],
    postconditions: [],
    notes: [],
    modelVersion: DEFAULT_MODEL,
    promptVersion: INTENT_PROMPT_VERSION,
    sourceHash: computeSourceHash(source),
    extractedAt: "2025-01-01T00:00:00.000Z",
  };
}

// ---------------------------------------------------------------------------
// Test 1: License-refused candidate → LicenseRefusedError propagates
// ---------------------------------------------------------------------------

describe("assembleCandidate — license-refused candidate", () => {
  it(
    "throws LicenseRefusedError for a GPL-licensed source before intent extraction",
    async () => {
      // The license gate in universalize() runs before extractIntent (cheap, fail-fast).
      // No cache seed is needed — the gate fires before any API or cache access.
      const gplSource = `// SPDX-License-Identifier: GPL-3.0-or-later
export function foo(x: number): number { return x + 1; }`;

      await expect(
        assembleCandidate(gplSource, registry, undefined, {
          shaveOptions: { cacheDir, offline: true },
        }),
      ).rejects.toBeInstanceOf(LicenseRefusedError);
    },
  );
});

// ---------------------------------------------------------------------------
// Test 2: PointerEntry-only single-entry slice → delegates to assemble()
//
// Compound-interaction: seedIntentCache (public API) + storeBlock + assembleCandidate
//   → universalize() → extractIntent (cache hit) → decompose → slice (PointerEntry)
//   → resolveToMerkleRoot → assemble(merkleRoot, registry) → Artifact
//
// WI-018: enabled using seedIntentCache() from @yakcc/shave.
//
// Source shape (DEC-COMPILE-AC-TEST-001): const + expression-body arrow function.
// SourceFile's canonicalAstHash (comments stripped by ts-morph canonicalization)
// equals the VariableStatement's hash. childMatchesRegistry(SourceFile) checks
// the VS hash → finds it in registry → SourceFile branches → VS becomes AtomLeaf.
// Slicer: VS atom's nodeHash matches stored block → PointerEntry → assemble().
// ---------------------------------------------------------------------------

describe("assembleCandidate — PointerEntry → assemble end-to-end (compound)", () => {
  it(
    "resolves PointerEntry to an Artifact via the full pipeline without API key",
    async () => {
      // Expression-body arrow function (no block body): VariableStatement has no
      // decomposable children, avoiding the childMatchesRegistry bug described in
      // DEC-COMPILE-AC-TEST-001. MIT license passes the license gate.
      const source =
        "// SPDX-License-Identifier: MIT\nexport const pointerTest = (n: number): number => n + 1;";

      // Store the block in the registry. implSource = source (with SPDX).
      // canonicalAstHash(source) is used as the row's canonicalAstHash.
      // Since ts-morph strips the SPDX comment as trivia when canonicalizing,
      // canonicalAstHash(source) ≈ canonicalAstHash(source_without_comment).
      // The slicer computes nodeHash = canonicalAstHash(nodeSource) for the atom.
      // For the single-VariableStatement SourceFile, nodeSource = source → same hash.
      const { merkleRoot } = await storeBlock(
        registry,
        "pointer-test",
        "Increments an integer by 1",
        source,
      );

      // Seed intent cache via public API. seedIntentCache(spec, card) writes an
      // IntentCard under the BLAKE3(source) → keyFromIntentInputs(...) cache key,
      // which is the same key that extractIntent() will look up for the same source.
      const card = makeIntentCard(source, "Increments an integer by 1");
      const spec: SeedIntentSpec = { source, cacheDir };
      await seedIntentCache(spec, card);

      // Full production pipeline — no API key, cache hit guaranteed.
      const artifact = await assembleCandidate(source, registry, undefined, {
        shaveOptions: { cacheDir, offline: true },
      });

      // The artifact is produced by assemble() with the PointerEntry's merkleRoot.
      expect(typeof artifact.source).toBe("string");
      expect(artifact.source.length).toBeGreaterThan(0);
      // The assembled source must contain the function name from implSource.
      expect(artifact.source).toContain("pointerTest");
      // Manifest must reference the stored block.
      expect(artifact.manifest.entries.length).toBeGreaterThan(0);
      expect(artifact.manifest.entries.some((e) => e.blockMerkleRoot === merkleRoot)).toBe(true);
    },
  );
});

// ---------------------------------------------------------------------------
// Test 3: Multi-leaf slice → CandidateNotResolvableError("multi-leaf")
//
// WI-018: enabled using seedIntentCache() from @yakcc/shave.
//
// Production sequence:
//   seedIntentCache(spec, card)         — seed intent cache for the full source
//   storeBlock(registry, f1Source, ...) — store VS1 so childMatchesRegistry fires
//   assembleCandidate(source, registry) — universalize():
//     → extractIntent (cache hit)
//     → decompose: SourceFile branches because childMatchesRegistry finds VS1
//       in registry → recurse into [VS1, VS2] → each becomes AtomLeaf
//     → slice: VS1 → PointerEntry, VS2 → NovelGlueEntry (not in registry)
//     → resolveToMerkleRoot: entries.length=2 > 1 → CandidateNotResolvableError
// ---------------------------------------------------------------------------

describe("assembleCandidate — multi-leaf slice", () => {
  it(
    "throws CandidateNotResolvableError with 'multi-leaf' in the message",
    async () => {
      // Two const arrow functions. Each VariableStatement is an AtomLeaf.
      // VS1 is stored in registry so childMatchesRegistry(SourceFile) returns true,
      // causing the SourceFile to branch into [VS1, VS2].
      // VS2 is NOT stored — it becomes a NovelGlueEntry.
      // Result: two SlicePlan entries → "multi-leaf" error.
      const f1Source =
        "export const firstFn = (a: number): number => a + 1;";
      const f2Source =
        "export const secondFn = (b: number): number => b + 2;";

      const candidateSource = `// SPDX-License-Identifier: MIT
${f1Source}
${f2Source}`;

      // Store only f1 in the registry so the SourceFile branches.
      await storeBlock(registry, "first-fn", "Increments a by 1", f1Source);

      // Seed intent cache for the full two-function source.
      const card = makeIntentCard(candidateSource, "Two-function multi-leaf test");
      const spec: SeedIntentSpec = { source: candidateSource, cacheDir };
      await seedIntentCache(spec, card);

      await expect(
        assembleCandidate(candidateSource, registry, undefined, {
          shaveOptions: { cacheDir, offline: true },
        }),
      ).rejects.toSatisfy(
        (e) => e instanceof CandidateNotResolvableError && /multi-leaf/.test(e.message),
      );
    },
  );
});

// ---------------------------------------------------------------------------
// Test 4: Single NovelGlueEntry → CandidateNotResolvableError("atom persistence")
//
// WI-018: enabled using seedIntentCache() from @yakcc/shave.
//
// Production sequence:
//   seedIntentCache(spec, card)         — seed intent cache for the full source
//   assembleCandidate(source, registry) — universalize():
//     → extractIntent (cache hit)
//     → decompose: SourceFile is AtomLeaf (no registry match, CF=0)
//     → slice: SourceFile atom → NovelGlueEntry (not in registry)
//     → resolveToMerkleRoot: single novel-glue → CandidateNotResolvableError
// ---------------------------------------------------------------------------

describe("assembleCandidate — single novel-glue entry", () => {
  it(
    "throws CandidateNotResolvableError with 'atom persistence in universalize' in message",
    async () => {
      // A single const arrow function. No registry match → NovelGlueEntry.
      // The empty in-memory registry has findByCanonicalAstHash returning []
      // for all hashes, so SourceFile is AtomLeaf and becomes a NovelGlueEntry.
      const source =
        "// SPDX-License-Identifier: MIT\nexport const novelGlue = (n: number): number => n * 7;";

      // Seed intent cache so extractIntent does not call the API.
      const card = makeIntentCard(source, "Multiplies by 7 — novel glue test");
      const spec: SeedIntentSpec = { source, cacheDir };
      await seedIntentCache(spec, card);

      await expect(
        assembleCandidate(source, registry, undefined, {
          shaveOptions: { cacheDir, offline: true },
        }),
      ).rejects.toSatisfy(
        (e) =>
          e instanceof CandidateNotResolvableError &&
          /atom persistence in universalize/i.test(e.message),
      );
    },
  );
});
