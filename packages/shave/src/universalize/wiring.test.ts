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
import type { BlockMerkleRoot } from "@yakcc/contracts";
import { canonicalAstHash } from "@yakcc/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeIntent } from "../cache/file-cache.js";
import { keyFromIntentInputs, sourceHash } from "../cache/key.js";
import { universalize } from "../index.js";
import {
  DEFAULT_MODEL,
  INTENT_PROMPT_VERSION,
  INTENT_SCHEMA_VERSION,
} from "../intent/constants.js";
import type { IntentCard } from "../intent/types.js";
import type { ShaveRegistryView } from "../types.js";
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
    // "variance" remains stubbed; "license-gate" is now live (WI-013-02).
    expect(result.diagnostics.stubbed).toContain("variance");
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
    // node is classified as non-atomic. For a SourceFile with one expression
    // statement (console.log(1)), decomposableChildrenOf(SourceFile) returns
    // [ExpressionStatement]. The ExpressionStatement has no decomposable
    // children → DidNotReachAtomError.
    //
    // We seed the cache so extractIntent succeeds before decompose() runs.
    const source = "// SPDX-License-Identifier: MIT\nconsole.log(1);";
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
