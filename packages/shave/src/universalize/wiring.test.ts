/**
 * @decision DEC-UNIVERSALIZE-WIRING-001
 * title: End-to-end wiring tests for universalize() → decompose() + slice()
 * status: decided
 * rationale: These tests exercise the real production sequence:
 *   universalize() → extractIntent() (cache) → decompose() → slice()
 * crossing all internal component boundaries. They prove the wiring is correct
 * without an Anthropic API key (offline + pre-seeded cache).
 *
 * Production trigger: universalize() is called by the continuous universalizer
 * loop for each candidate block emitted by the compiler.
 *
 * Real production sequence:
 *   1. Caller invokes universalize(candidate, registry, options).
 *   2. extractIntent reads from the file-system cache (or calls the API).
 *   3. decompose() parses the TypeScript source and builds a RecursionTree.
 *   4. slice() walks the tree, querying the registry for each node by
 *      canonicalAstHash, and emits PointerEntry | NovelGlueEntry entries.
 *   5. The intentCard is attached to the root NovelGlueEntry for single-leaf
 *      trees; multi-leaf per-leaf attachment is deferred.
 *
 * These tests exercise that sequence: they cross the universalize →
 * extractIntent → decompose → slice component boundaries in one call.
 *
 * Mocking strategy: the registry is a plain-object stub (no SQLite). The
 * intent-extraction API is bypassed via offline: true + pre-seeded cache.
 * No real network calls are made.
 */

import { mkdir } from "node:fs/promises";
import * as os from "node:os";
import { join } from "node:path";
import type { BlockMerkleRoot, EmbeddingProvider } from "@yakcc/contracts";
import { canonicalAstHash } from "@yakcc/contracts";
import { openRegistry } from "@yakcc/registry";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeIntent } from "../cache/file-cache.js";
import { keyFromIntentInputs, sourceHash } from "../cache/key.js";
import { PersistRequestedButNotSupportedError, universalize } from "../index.js";
import {
  DEFAULT_MODEL,
  INTENT_PROMPT_VERSION,
  INTENT_SCHEMA_VERSION,
} from "../intent/constants.js";
import type { IntentCard } from "../intent/types.js";
import { maybePersistNovelGlueAtom } from "../persist/atom-persist.js";
import type { ShaveRegistryView, UniversalizeOptions } from "../types.js";
import { DidNotReachAtomError } from "./recursion.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * A small atomic TypeScript source used across multiple tests.
 *
 * Uses an expression-body arrow function assigned to a const so that the
 * VariableStatement has no statement children (getTopLevelStatements returns []).
 * This avoids the CanonicalAstParseError that occurs when childMatchesRegistry()
 * in recursion.ts tries to hash a bare return statement fragment via
 * canonicalAstHash(childSource). A block-body function like
 *   function digit(c) { return ...; }
 * would cause childMatchesRegistry(FunctionDeclaration) to hash the naked
 * return statement text, which is invalid TypeScript at file scope.
 *
 * This source has zero control-flow boundaries → decompose() classifies the
 * SourceFile as an atom in one step (leafCount === 1, maxDepth === 0).
 */
const ATOMIC_SOURCE = `// SPDX-License-Identifier: MIT
const isDigit = (c: string): boolean => c >= "0" && c <= "9";`;

// ---------------------------------------------------------------------------
// Registry stubs
// ---------------------------------------------------------------------------

/** Registry with no matches — all nodes will become NovelGlueEntry. */
const emptyRegistry: ShaveRegistryView = {
  selectBlocks: async () => [],
  getBlock: async () => undefined,
  findByCanonicalAstHash: async () => [],
};

/**
 * Build a registry that returns a fake merkle root for the given source
 * string's canonicalAstHash, and no match for everything else.
 *
 * This simulates a registry that has the target primitive stored and is used
 * to exercise the PointerEntry path in universalize().
 */
async function registryMatchingSource(source: string): Promise<ShaveRegistryView> {
  const hash = canonicalAstHash(source);
  const fakeMerkle = "fake-merkle-root-001" as BlockMerkleRoot;
  return {
    selectBlocks: async () => [],
    getBlock: async () => undefined,
    findByCanonicalAstHash: async (h: string) => (h === hash ? [fakeMerkle] : []),
  };
}

// ---------------------------------------------------------------------------
// Per-test tmpdir + API key isolation
// ---------------------------------------------------------------------------

let cacheDir: string;

beforeEach(async () => {
  const unique = Math.random().toString(36).slice(2);
  cacheDir = join(os.tmpdir(), `wiring-test-${unique}`);
  await mkdir(cacheDir, { recursive: true });
  // biome-ignore lint/performance/noDelete: process.env requires delete to truly unset
  delete process.env.ANTHROPIC_API_KEY;
});

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await rm(cacheDir, { recursive: true, force: true }).catch(() => {});
  // biome-ignore lint/performance/noDelete: process.env requires delete to truly unset
  delete process.env.ANTHROPIC_API_KEY;
});

// ---------------------------------------------------------------------------
// Helper: pre-seed a valid IntentCard into the cache
// ---------------------------------------------------------------------------

async function seedCache(source: string, overrides?: Partial<IntentCard>): Promise<IntentCard> {
  const sh = sourceHash(source);
  const key = keyFromIntentInputs({
    sourceHash: sh,
    modelTag: DEFAULT_MODEL,
    promptVersion: INTENT_PROMPT_VERSION,
    schemaVersion: INTENT_SCHEMA_VERSION,
  });
  const card: IntentCard = {
    schemaVersion: 1,
    behavior: "Checks whether a character is a decimal digit",
    inputs: [{ name: "c", typeHint: "string", description: "A single character" }],
    outputs: [{ name: "result", typeHint: "boolean", description: "True if c is 0-9" }],
    preconditions: [],
    postconditions: [],
    notes: [],
    modelVersion: DEFAULT_MODEL,
    promptVersion: INTENT_PROMPT_VERSION,
    sourceHash: sh,
    extractedAt: "2025-01-01T00:00:00.000Z",
    ...overrides,
  };
  await writeIntent(cacheDir, key, card);
  return card;
}

// ---------------------------------------------------------------------------
// Test 1: Happy path — no registry matches → all NovelGlueEntry
// ---------------------------------------------------------------------------

describe("universalize() wiring — no registry matches", () => {
  it("returns slicePlan with NovelGlueEntry items, empty matchedPrimitives, no decomposition stub", async () => {
    const seeded = await seedCache(ATOMIC_SOURCE);

    // WI-022: intentStrategy: "llm" required — seedCache() uses LLM-mode tags;
    // the default "static" strategy uses a different key namespace and would miss.
    const result = await universalize({ source: ATOMIC_SOURCE }, emptyRegistry, {
      cacheDir,
      offline: true,
      intentStrategy: "llm",
    });

    // intentCard must come from the seeded cache.
    expect(result.intentCard.behavior).toBe(seeded.behavior);

    // slicePlan must be non-empty and contain only novel-glue entries.
    expect(result.slicePlan.length).toBeGreaterThan(0);
    for (const entry of result.slicePlan) {
      expect(entry.kind).toBe("novel-glue");
    }

    // No registry matches → matchedPrimitives is empty.
    expect(result.matchedPrimitives).toEqual([]);

    // "decomposition" must no longer appear in stubbed (it is live).
    expect(result.diagnostics.stubbed).not.toContain("decomposition");
    // variance is now live (#374) and license-gate is live (WI-013-02).
    expect(result.diagnostics.stubbed).not.toContain("variance");
    expect(result.diagnostics.stubbed).not.toContain("license-gate");
  });
});

// ---------------------------------------------------------------------------
// Test 2: Happy path — registry matches the input by canonicalAstHash
// ---------------------------------------------------------------------------

describe("universalize() wiring — registry match by canonicalAstHash", () => {
  it("returns slicePlan with one PointerEntry and matchedPrimitives.length === 1", async () => {
    await seedCache(ATOMIC_SOURCE);
    const matchingRegistry = await registryMatchingSource(ATOMIC_SOURCE);

    // WI-022: intentStrategy: "llm" — seedCache() uses LLM-mode tags.
    const result = await universalize({ source: ATOMIC_SOURCE }, matchingRegistry, {
      cacheDir,
      offline: true,
      intentStrategy: "llm",
    });

    // intentCard is still produced (extracted from cache).
    expect(result.intentCard.behavior).toBeTruthy();

    // The single leaf matched the registry → one PointerEntry.
    expect(result.slicePlan.length).toBe(1);
    expect(result.slicePlan[0].kind).toBe("pointer");

    // matchedPrimitives carries the one matched entry.
    expect(result.matchedPrimitives.length).toBe(1);
    expect(result.matchedPrimitives[0].merkleRoot).toBe("fake-merkle-root-001");

    // "decomposition" not in stubbed.
    expect(result.diagnostics.stubbed).not.toContain("decomposition");
  });
});

// ---------------------------------------------------------------------------
// Test 3: Decomposition error propagation
// ---------------------------------------------------------------------------

describe("universalize() wiring — decomposition error propagation", () => {
  it("propagates DidNotReachAtomError when decompose() cannot reach atoms", async () => {
    // Strategy: pass maxControlFlowBoundaries: -1 via recursionOptions.
    // With this setting, cfCount (always ≥ 0) > -1 is always true, so every
    // node is classified as non-atomic. For a SourceFile with one variable
    // statement ("let x;"), decomposableChildrenOf returns []. The
    // VariableStatement has no decomposable children → DidNotReachAtomError.
    // (Previously used "console.log(1);" which now glue-routes per
    // DEC-V2-SHAVE-CALLEXPRESSION-GLUE-001.)
    //
    // We seed the cache so extractIntent succeeds before decompose() runs.
    const source = "// SPDX-License-Identifier: MIT\nlet x;";
    await seedCache(source);

    // WI-022: intentStrategy: "llm" + offline — seedCache() uses LLM-mode tags.
    await expect(
      universalize({ source }, emptyRegistry, {
        cacheDir,
        offline: true,
        intentStrategy: "llm",
        recursionOptions: { maxControlFlowBoundaries: -1 },
      }),
    ).rejects.toThrow(DidNotReachAtomError);
  });
});

// ---------------------------------------------------------------------------
// Test 4: Compound interaction — intentCard attached to root single-leaf
//         NovelGlueEntry for an atomic input
// ---------------------------------------------------------------------------

describe("universalize() wiring — intentCard on root NovelGlueEntry", () => {
  it("attaches intentCard to the root NovelGlueEntry for a single atomic leaf with no registry match", async () => {
    // ATOMIC_SOURCE is a single function with no CF → one AtomLeaf at depth 0.
    // emptyRegistry → no matches → one NovelGlueEntry.
    // The intentCard from the cache should be attached to that entry.
    const seeded = await seedCache(ATOMIC_SOURCE);

    // WI-022: intentStrategy: "llm" — seedCache() uses LLM-mode tags.
    const result = await universalize({ source: ATOMIC_SOURCE }, emptyRegistry, {
      cacheDir,
      offline: true,
      intentStrategy: "llm",
    });

    // Exactly one entry (single-leaf tree, no registry match).
    expect(result.slicePlan.length).toBe(1);
    const entry = result.slicePlan[0];
    expect(entry.kind).toBe("novel-glue");

    // The intentCard from the top-level extractIntent call is attached.
    if (entry.kind === "novel-glue") {
      expect(entry.intentCard).toBeDefined();
      expect(entry.intentCard?.behavior).toBe(seeded.behavior);
      expect(entry.intentCard?.sourceHash).toBe(seeded.sourceHash);
    }

    // Top-level intentCard is also present.
    expect(result.intentCard.behavior).toBe(seeded.behavior);
  });

  it("does not attach intentCard to PointerEntry when the single leaf matches the registry", async () => {
    await seedCache(ATOMIC_SOURCE);
    const matchingRegistry = await registryMatchingSource(ATOMIC_SOURCE);

    // WI-022: intentStrategy: "llm" — seedCache() uses LLM-mode tags.
    const result = await universalize({ source: ATOMIC_SOURCE }, matchingRegistry, {
      cacheDir,
      offline: true,
      intentStrategy: "llm",
    });

    expect(result.slicePlan.length).toBe(1);
    const entry = result.slicePlan[0];
    // Registry match → PointerEntry, which has no intentCard field.
    expect(entry.kind).toBe("pointer");
    // PointerEntry type does not have intentCard — verify via discriminant.
    expect("intentCard" in entry).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Test 5 (WI-031 regression): single-leaf persist boundary
//
// This test exercises the production sequence:
//   universalize() → slicePlan[0] (NovelGlueEntry with intentCard) →
//   maybePersistNovelGlueAtom(entry, registry) → registry.getBlock()
//
// It crosses the universalize → slicer → persist component boundaries using
// a real in-memory registry (openRegistry(":memory:")) so that the
// parentBlockRoot column is exercised through actual SQLite persistence.
//
// The atom-persist.test.ts unit tests use hand-crafted makeEntry() fixtures;
// this test starts from universalize() to prove the full chain is wired
// correctly after WI-031 landed. It also guards against regressions that
// would strip intentCard from the single-leaf path before persist.
// ---------------------------------------------------------------------------

/** Deterministic mock EmbeddingProvider — no ONNX/network required. */
function mockEmbeddingProvider(): EmbeddingProvider {
  return {
    dimension: 384,
    modelId: "mock/test-provider-wiring",
    async embed(text: string): Promise<Float32Array> {
      const vec = new Float32Array(384);
      for (let i = 0; i < 384; i++) {
        vec[i] = text.charCodeAt(i % text.length) / 128 + i * 0.001;
      }
      let norm = 0;
      for (const v of vec) norm += v * v;
      const scale = norm > 0 ? 1 / Math.sqrt(norm) : 1;
      for (let i = 0; i < vec.length; i++) {
        const val = vec[i];
        if (val !== undefined) vec[i] = val * scale;
      }
      return vec;
    },
  };
}

describe("universalize() + maybePersistNovelGlueAtom() — single-leaf persist regression (WI-031)", () => {
  it("single-leaf entry from universalize() persists with defined merkleRoot and parentBlockRoot=null", async () => {
    // ATOMIC_SOURCE is a single expression-body arrow fn (no CF boundaries) →
    // one AtomLeaf, one NovelGlueEntry. Intent comes from the pre-seeded cache.
    const seeded = await seedCache(ATOMIC_SOURCE);

    const result = await universalize({ source: ATOMIC_SOURCE }, emptyRegistry, {
      cacheDir,
      offline: true,
      intentStrategy: "llm",
    });

    // Guard: we need exactly one novel-glue entry with an intentCard before persisting.
    expect(result.slicePlan.length).toBe(1);
    // biome-ignore lint/style/noNonNullAssertion: length asserted to be 1 above
    const entry = result.slicePlan[0]!;
    expect(entry.kind).toBe("novel-glue");
    if (entry.kind !== "novel-glue") return; // narrow for TypeScript

    expect(entry.intentCard).toBeDefined();
    expect(entry.intentCard?.behavior).toBe(seeded.behavior);

    // Persist through a real in-memory registry so parentBlockRoot hits SQLite.
    const registry = await openRegistry(":memory:", {
      embeddings: mockEmbeddingProvider(),
    });
    try {
      const merkleRoot = await maybePersistNovelGlueAtom(entry, registry, {
        cacheDir,
        parentBlockRoot: null,
      });

      // Single leaf with intentCard → must produce a defined merkleRoot.
      expect(merkleRoot).toBeDefined();

      // Read back and verify parentBlockRoot is null (root of its recursion tree).
      // biome-ignore lint/style/noNonNullAssertion: merkleRoot asserted defined above
      const row = await registry.getBlock(merkleRoot!);
      expect(row).not.toBeNull();
      expect(row?.parentBlockRoot).toBeNull();
    } finally {
      await registry.close();
    }
  });
});

// ---------------------------------------------------------------------------
// T2 (WI-373): Default path (persist:undefined) is unchanged
//
// Verifies REQ-GOAL-001 backwards-compat clause: when universalize() is called
// WITHOUT persist:true, NovelGlueEntry.merkleRoot is always undefined and no
// row is written to the registry.
//
// This pins the contract for all existing callers (shave(), atomize.ts,
// wiring.test.ts Tests 1-4) that do not opt in to in-pipeline persistence.
// ---------------------------------------------------------------------------

describe("universalize() — default path (persist:undefined): NovelGlueEntry.merkleRoot is undefined (WI-373 T2)", () => {
  it("NovelGlueEntry has merkleRoot===undefined and no row written when persist is not requested", async () => {
    // Seed cache so extractIntent succeeds without an API key.
    await seedCache(ATOMIC_SOURCE);

    // Open a real in-memory registry so we can verify no rows are written.
    const registry = await openRegistry(":memory:", {
      embeddings: mockEmbeddingProvider(),
    });

    try {
      // Call universalize() WITHOUT persist flag — the default backwards-compat path.
      const result = await universalize({ source: ATOMIC_SOURCE }, registry, {
        cacheDir,
        offline: true,
        intentStrategy: "llm",
      } satisfies UniversalizeOptions);

      // The single-leaf plan should produce one NovelGlueEntry.
      expect(result.slicePlan.length).toBe(1);
      const entry = result.slicePlan[0];
      expect(entry?.kind).toBe("novel-glue");

      // WI-373 backwards-compat: merkleRoot must be undefined when persist not requested.
      if (entry?.kind === "novel-glue") {
        expect(entry.merkleRoot).toBeUndefined();
      }

      // No row must have been written to the registry.
      const hash = canonicalAstHash(ATOMIC_SOURCE);
      const stored = await registry.findByCanonicalAstHash(hash);
      expect(stored.length).toBe(0);
    } finally {
      await registry.close();
    }
  });
});

// ---------------------------------------------------------------------------
// T4 (WI-373): persist:true + registry without storeBlock → loud error
//
// Verifies DEC-UNIVERSALIZE-PERSIST-ERR-001: when persist:true is requested
// but the registry view does NOT implement storeBlock, universalize() throws
// PersistRequestedButNotSupportedError immediately — no silent no-op.
//
// This is the Sacred Practice #5 (loud failure) check: a caller that says
// "persist" must get a clear error if the registry cannot honour that request.
// ---------------------------------------------------------------------------

describe("universalize() — persist:true + registry missing storeBlock → PersistRequestedButNotSupportedError (WI-373 T4)", () => {
  it("throws PersistRequestedButNotSupportedError when storeBlock is absent from the registry view", async () => {
    // Seed cache so the pipeline reaches step 6 (persistence) without crashing earlier.
    await seedCache(ATOMIC_SOURCE);

    // emptyRegistry (defined above) has no storeBlock — it's a pure ShaveRegistryView.
    // persist:true + no storeBlock → immediate loud-fail per DEC-UNIVERSALIZE-PERSIST-ERR-001.
    await expect(
      universalize({ source: ATOMIC_SOURCE }, emptyRegistry, {
        cacheDir,
        offline: true,
        intentStrategy: "llm",
        persist: true,
      } satisfies UniversalizeOptions),
    ).rejects.toBeInstanceOf(PersistRequestedButNotSupportedError);
  });

  it("does NOT throw when persist is undefined (the default path) even without storeBlock", async () => {
    // Ensure the default path (no persist flag) is a strict no-op regardless of
    // whether storeBlock is present. This guards against a regression where adding
    // the check breaks existing callers that never set persist:true.
    await seedCache(ATOMIC_SOURCE);

    // Should resolve normally — no error.
    const result = await universalize({ source: ATOMIC_SOURCE }, emptyRegistry, {
      cacheDir,
      offline: true,
      intentStrategy: "llm",
      // No persist flag — emptyRegistry has no storeBlock, but that's irrelevant here.
    });

    expect(result.slicePlan.length).toBeGreaterThan(0);
    expect(result.slicePlan[0]?.kind).toBe("novel-glue");
  });
});
