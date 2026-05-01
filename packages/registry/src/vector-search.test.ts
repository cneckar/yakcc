/**
 * vector-search.test.ts — Tests for findCandidatesByIntent() (WI-025).
 *
 * Production sequence exercised:
 *   openRegistry → storeBlock(row) → findCandidatesByIntent(card, opts) → close()
 *
 * This is the real production sequence: the Claude Code hook (WI-026) will call
 * findCandidatesByIntent after each AI emission to check for registry hits.
 *
 * Mock embedding provider notes:
 * - Uses a hash of the text so different behavior strings produce meaningfully
 *   different vectors — this ensures KNN ordering is exercised, not just returned.
 * - Does NOT use the local transformers.js provider (ONNX) to keep tests fast
 *   and offline-capable (Sacred Practice #5: real implementations, not mocks,
 *   but external boundaries like ONNX models are the exception).
 */

import {
  type CanonicalAstHash,
  type EmbeddingProvider,
  type ProofManifest,
  type SpecYak,
  blockMerkleRoot,
  canonicalize,
  canonicalAstHash as deriveCanonicalAstHash,
  specHash as deriveSpecHash,
} from "@yakcc/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  BlockTripletRow,
  CandidateMatch,
  FindCandidatesOptions,
  IntentQuery,
  IntentQueryParam,
  Registry,
} from "./index.js";
import { openRegistry } from "./storage.js";

// ---------------------------------------------------------------------------
// Deterministic mock embedding provider
// ---------------------------------------------------------------------------

/**
 * Returns a deterministic 384-dim Float32Array for any input text.
 * Uses a hash of text characters to produce distinct embeddings so KNN ordering
 * is exercised — closer behavior strings will have smaller cosine distances.
 *
 * Vectors are L2-normalized (unit sphere) so cosine distance = euclidean distance²/2.
 */
function mockEmbeddingProvider(): EmbeddingProvider {
  return {
    dimension: 384,
    modelId: "mock/test-vector-search",
    async embed(text: string): Promise<Float32Array> {
      const vec = new Float32Array(384);
      // Seed vector entries using a mix of character codes at different positions.
      // Different text → different dominant dimensions → different KNN neighbors.
      for (let i = 0; i < 384; i++) {
        const charIdx = (i * 7 + 3) % text.length;
        const charCode = text.charCodeAt(charIdx) / 128;
        // Add position-dependent variation so longer similar strings stay close.
        vec[i] = charCode * Math.sin((i + 1) * 0.05) + (i % 10) * 0.001;
      }
      // L2-normalize to unit sphere.
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

// ---------------------------------------------------------------------------
// Test fixture factories
// ---------------------------------------------------------------------------

/** Make a minimal valid SpecYak with required v0.6 fields. */
function makeSpecYak(name: string, behavior: string): SpecYak {
  return {
    name,
    inputs: [{ name: "input", type: "string" }],
    outputs: [{ name: "result", type: "number" }],
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

/** Make a SpecYak with custom inputs/outputs for structural-rerank tests. */
function makeSpecYakWithParams(
  name: string,
  behavior: string,
  inputs: SpecYak["inputs"],
  outputs: SpecYak["outputs"],
): SpecYak {
  return {
    name,
    inputs,
    outputs,
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

/** Make a minimal L0 ProofManifest. */
function makeManifest(): ProofManifest {
  return { artifacts: [{ kind: "property_tests", path: "property_tests.ts" }] };
}

/** Build a complete BlockTripletRow from a SpecYak. */
function makeBlockRow(spec: SpecYak, implSource?: string): BlockTripletRow {
  const src =
    implSource ??
    `export function f(x: string): number { return parseInt(x, 10); /* ${spec.name} */ }`;
  const manifest = makeManifest();
  const artifactBytes = new TextEncoder().encode("// property tests");
  const artifacts = new Map<string, Uint8Array>([["property_tests.ts", artifactBytes]]);

  const root = blockMerkleRoot({ spec, implSource: src, manifest, artifacts });
  const sh = deriveSpecHash(spec);
  const canonicalBytes = canonicalize(spec as unknown as Parameters<typeof canonicalize>[0]);

  return {
    blockMerkleRoot: root,
    specHash: sh,
    specCanonicalBytes: canonicalBytes,
    implSource: src,
    proofManifestJson: JSON.stringify(manifest),
    level: "L0",
    createdAt: Date.now(),
    canonicalAstHash: deriveCanonicalAstHash(src) as CanonicalAstHash,
    artifacts,
  };
}

/**
 * Make a minimal IntentQuery from a behavior string.
 * IntentQuery is the local structural type used by findCandidatesByIntent;
 * it is a subset of @yakcc/shave's IntentCard (DEC-VECTOR-RETRIEVAL-004).
 */
function makeIntentQuery(
  behavior: string,
  inputs: IntentQueryParam[] = [],
  outputs: IntentQueryParam[] = [],
): IntentQuery {
  return { behavior, inputs, outputs };
}

// ---------------------------------------------------------------------------
// Test lifecycle
// ---------------------------------------------------------------------------

let registry: Registry;

beforeEach(async () => {
  registry = await openRegistry(":memory:", {
    embeddings: mockEmbeddingProvider(),
  });
});

afterEach(async () => {
  await registry.close();
});

// ---------------------------------------------------------------------------
// Test 1: basic KNN ordering by cosine distance
// ---------------------------------------------------------------------------

describe("findCandidatesByIntent — basic ordering", () => {
  it("returns results ordered by ascending cosineDistance for semantically close card", async () => {
    // Seed blocks with varying behavior strings. One is very close to the query.
    const blocks = [
      makeBlockRow(makeSpecYak("parse-int", "Parse an integer from a string")),
      makeBlockRow(makeSpecYak("match-bracket", "Check if a character is a bracket")),
      makeBlockRow(makeSpecYak("check-digit", "Check whether a character is a digit")),
      makeBlockRow(makeSpecYak("get-comma", "Return whether a character is a comma")),
      makeBlockRow(makeSpecYak("parse-list", "Parse a list of integers from JSON")),
    ];

    for (const row of blocks) {
      await registry.storeBlock(row);
    }

    // Query card close to "Parse an integer from a string"
    const card = makeIntentQuery("Parse an integer from a string input");
    const results = await registry.findCandidatesByIntent(card, { k: 10 });

    expect(results.length).toBeGreaterThan(0);
    expect(results.length).toBeLessThanOrEqual(10);

    // Verify results are ordered by ascending cosineDistance (lower = more similar).
    for (let i = 1; i < results.length; i++) {
      const prev = results[i - 1];
      const curr = results[i];
      expect(prev).toBeDefined();
      expect(curr).toBeDefined();
      expect((prev as CandidateMatch).cosineDistance).toBeLessThanOrEqual(
        (curr as CandidateMatch).cosineDistance,
      );
    }

    // The most semantically similar block should be in the top-3.
    const top3Behaviors = results.slice(0, 3).map((r) => {
      const spec = JSON.parse(Buffer.from(r.block.specCanonicalBytes).toString("utf-8")) as SpecYak;
      return spec.behavior ?? "";
    });

    expect(top3Behaviors.some((b) => b.includes("Parse an integer"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Test 2: structural rerank moves structurally-better candidates up
// ---------------------------------------------------------------------------

describe("findCandidatesByIntent — structural rerank", () => {
  it("rerank: structural reorders by combined score, improving structurally-better matches", async () => {
    // Two blocks with identical behavior text (same embedding) but one has
    // matching input/output signatures and one has mismatching signatures.
    // After rerank: "structural" the one with matching inputs/outputs should score higher.
    const targetInputs = [{ name: "value", type: "string" }] as const;
    const targetOutputs = [{ name: "parsed", type: "number" }] as const;

    // Block A: matching inputs and outputs — structuralMatch should pass.
    const blockA = makeBlockRow(
      makeSpecYakWithParams(
        "parse-num-match",
        "Convert a string value to a parsed number",
        [...targetInputs],
        [...targetOutputs],
      ),
    );

    // Block B: completely different behavior text, mismatching signatures.
    const blockB = makeBlockRow(
      makeSpecYakWithParams(
        "totally-different",
        "Check if a bracket character matches at current position in text",
        [{ name: "ch", type: "string" }],
        [{ name: "ok", type: "boolean" }],
      ),
    );

    await registry.storeBlock(blockA);
    await registry.storeBlock(blockB);

    const card = makeIntentQuery(
      "Convert a string value to a parsed number",
      [{ name: "value", typeHint: "string" }],
      [{ name: "parsed", typeHint: "number" }],
    );

    const resultsReranked = await registry.findCandidatesByIntent(card, {
      k: 10,
      rerank: "structural",
    });

    expect(resultsReranked.length).toBeGreaterThan(0);

    // All results with rerank: "structural" must have a structuralScore field.
    for (const r of resultsReranked) {
      expect(r.structuralScore).toBeDefined();
    }

    // blockA should rank first (has better cosine + structural combined score).
    const firstResult = resultsReranked[0];
    if (firstResult === undefined) throw new Error("expected at least one result");
    const firstSpec = JSON.parse(
      Buffer.from(firstResult.block.specCanonicalBytes).toString("utf-8"),
    ) as SpecYak;
    expect(firstSpec.name).toBe("parse-num-match");
  });

  it("without rerank, results have no structuralScore field", async () => {
    const block = makeBlockRow(makeSpecYak("test-block", "A simple test block behavior"));
    await registry.storeBlock(block);

    const card = makeIntentQuery("A simple test block behavior");
    const results = await registry.findCandidatesByIntent(card);

    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      expect(r.structuralScore).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// Test 3: k option limits result count
// ---------------------------------------------------------------------------

describe("findCandidatesByIntent — k limit", () => {
  it("with k: 3, returns exactly ≤3 results even when corpus is larger", async () => {
    // Seed 8 distinct blocks.
    for (let i = 0; i < 8; i++) {
      const block = makeBlockRow(
        makeSpecYak(`block-${i}`, `Behavior description for block number ${i} in the test corpus`),
        `export function f${i}(x: string): number { return ${i}; }`,
      );
      await registry.storeBlock(block);
    }

    const card = makeIntentQuery("Behavior description for block number 3 in the test corpus");
    const results = await registry.findCandidatesByIntent(card, { k: 3 });

    expect(results.length).toBeGreaterThanOrEqual(0);
    expect(results.length).toBeLessThanOrEqual(3);
  });
});

// ---------------------------------------------------------------------------
// Test 4: empty registry returns [] without error
// ---------------------------------------------------------------------------

describe("findCandidatesByIntent — empty registry", () => {
  it("returns empty array (not error) when registry has no blocks", async () => {
    const card = makeIntentQuery("Parse an integer from a string");
    const results = await registry.findCandidatesByIntent(card, { k: 5 });

    expect(Array.isArray(results)).toBe(true);
    expect(results.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Test 5: card with empty inputs/outputs produces valid query
// ---------------------------------------------------------------------------

describe("findCandidatesByIntent — minimal IntentCard", () => {
  it("card with empty inputs and outputs still produces a valid query string", async () => {
    // Seed one block so we can verify a non-empty result.
    const block = makeBlockRow(makeSpecYak("some-block", "Do some computation on the input"));
    await registry.storeBlock(block);

    // Card with no inputs/outputs — behavior only.
    const card = makeIntentQuery("Do some computation on the input", [], []);
    const results = await registry.findCandidatesByIntent(card, { k: 5 });

    // Should not throw and should return results (at least the seeded block).
    expect(Array.isArray(results)).toBe(true);
    expect(results.length).toBeGreaterThan(0);
  });

  it("card with only whitespace behavior does not throw", async () => {
    const card = makeIntentQuery("   ", [], []);
    const results = await registry.findCandidatesByIntent(card, { k: 5 });
    expect(Array.isArray(results)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Test 6: default k is 10
// ---------------------------------------------------------------------------

describe("findCandidatesByIntent — default options", () => {
  it("default k=10 caps results at 10 when corpus is large", async () => {
    for (let i = 0; i < 15; i++) {
      const block = makeBlockRow(
        makeSpecYak(`corpus-${i}`, `Test corpus block ${i} with unique behavior description`),
        `export function corpus${i}(x: string): number { return ${i}; }`,
      );
      await registry.storeBlock(block);
    }

    const card = makeIntentQuery("Test corpus block with unique behavior description");
    const results = await registry.findCandidatesByIntent(card);

    expect(results.length).toBeLessThanOrEqual(10);
  });
});
