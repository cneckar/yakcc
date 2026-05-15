// SPDX-License-Identifier: MIT
/**
 * substitution-integration.test.ts — End-to-end integration tests for Phase 2
 * executeRegistryQueryWithSubstitution().
 *
 * Production sequence exercised:
 *   openRegistry(":memory:", { embeddings }) → storeBlock(row) →
 *   executeRegistryQueryWithSubstitution(registry, ctx, originalCode, toolName, opts) →
 *   assert substituted/non-substituted response + telemetry
 *
 * These tests exercise the full pipeline:
 *   1. High-confidence mock candidate → substitution fires
 *   2. Low-confidence mock candidate → substitution skipped
 *   3. YAKCC_HOOK_DISABLE_SUBSTITUTE=1 → substitution bypassed
 *   4. Observe-don't-mutate: original HookResponse shape preserved
 *   5. Telemetry file written with Phase 2 fields
 */

import { existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import type { BlockTripletRow, CandidateMatch, Registry } from "@yakcc/registry";
import { openRegistry } from "@yakcc/registry";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  HOOK_LATENCY_BUDGET_MS,
  type HookResponseWithSubstitution,
  executeRegistryQueryWithSubstitution,
} from "../src/index.js";
import type { TelemetryEvent } from "../src/telemetry.js";

// ---------------------------------------------------------------------------
// Mock embedding provider (same pattern as index.test.ts)
// ---------------------------------------------------------------------------

function mockEmbeddingProvider(): EmbeddingProvider {
  return {
    dimension: 384,
    modelId: "mock/test-substitution-integration",
    async embed(text: string): Promise<Float32Array> {
      const vec = new Float32Array(384);
      for (let i = 0; i < 384; i++) {
        const charIdx = (i * 7 + 3) % text.length;
        const charCode = text.charCodeAt(charIdx) / 128;
        vec[i] = charCode * Math.sin((i + 1) * 0.05) + (i % 10) * 0.001;
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

// ---------------------------------------------------------------------------
// Test fixture helpers
// ---------------------------------------------------------------------------

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

function makeBlockRow(spec: SpecYak): BlockTripletRow {
  const implSource = `export function f(x: string): number { return parseInt(x, 10); /* ${spec.name} */ }`;
  const manifest: ProofManifest = {
    artifacts: [{ kind: "property_tests", path: "property_tests.ts" }],
  };
  const artifactBytes = new TextEncoder().encode("// property tests");
  const artifacts = new Map<string, Uint8Array>([["property_tests.ts", artifactBytes]]);
  const root = blockMerkleRoot({ spec, implSource, manifest, artifacts });
  const sh = deriveSpecHash(spec);
  const canonicalBytes = canonicalize(spec as unknown as Parameters<typeof canonicalize>[0]);
  return {
    blockMerkleRoot: root,
    specHash: sh,
    specCanonicalBytes: canonicalBytes,
    implSource,
    proofManifestJson: JSON.stringify(manifest),
    level: "L0",
    createdAt: Date.now(),
    canonicalAstHash: deriveCanonicalAstHash(implSource) as CanonicalAstHash,
    artifacts,
  };
}

/** Build a mock Registry that returns a fixed candidates list. */
function makeHighConfidenceRegistry(
  baseRegistry: Registry,
  overrideCandidates: readonly CandidateMatch[],
): Registry {
  return {
    ...baseRegistry,
    // Keep findCandidatesByIntent for backwards-compat with any baseRegistry usage;
    // hooks-base source now only calls findCandidatesByQuery (P1a migration).
    findCandidatesByIntent: async () => overrideCandidates,
    findCandidatesByQuery: async () => ({
      candidates: overrideCandidates.map((c) => ({
        ...c,
        // QueryCandidate fields beyond CandidateMatch
        combinedScore: Math.max(0, Math.min(1, 1 - (c.cosineDistance * c.cosineDistance) / 4)),
        perDimensionScores: { unified: Math.max(0, Math.min(1, 1 - (c.cosineDistance * c.cosineDistance) / 4)) },
        autoAccepted: false as const,
      })),
      nearMisses: [],
    }),
  };
}

// ---------------------------------------------------------------------------
// Test lifecycle
// ---------------------------------------------------------------------------

let registry: Registry;
const testTelemetryDir = join(tmpdir(), `yakcc-sub-int-test-${process.pid}`);
const testSessionId = `test-session-sub-${process.pid}`;

beforeEach(async () => {
  registry = await openRegistry(":memory:", {
    embeddings: mockEmbeddingProvider(),
  });
  // Ensure substitute is enabled for most tests.
  delete process.env.YAKCC_HOOK_DISABLE_SUBSTITUTE;
});

afterEach(async () => {
  await registry.close();
  if (existsSync(testTelemetryDir)) {
    rmSync(testTelemetryDir, { recursive: true, force: true });
  }
  delete process.env.YAKCC_HOOK_DISABLE_SUBSTITUTE;
});

// ---------------------------------------------------------------------------
// Helper: read last telemetry event from JSONL file
// ---------------------------------------------------------------------------

function readLastTelemetryEvent(): TelemetryEvent | null {
  const filePath = join(testTelemetryDir, `${testSessionId}.jsonl`);
  if (!existsSync(filePath)) return null;
  const lines = readFileSync(filePath, "utf-8")
    .trim()
    .split("\n")
    .filter((l) => l.length > 0);
  const last = lines[lines.length - 1];
  if (last === undefined) return null;
  return JSON.parse(last) as TelemetryEvent;
}

// ---------------------------------------------------------------------------
// HOOK_LATENCY_BUDGET_MS constant
// ---------------------------------------------------------------------------

describe("HOOK_LATENCY_BUDGET_MS", () => {
  it("is 200", () => {
    expect(HOOK_LATENCY_BUDGET_MS).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Non-substitution path — observe-don't-mutate preserved
// ---------------------------------------------------------------------------

describe("executeRegistryQueryWithSubstitution — non-substitution paths", () => {
  it(
    "returns substituted=false when registry is empty (synthesis-required)",
    async () => {
      const result = await executeRegistryQueryWithSubstitution(
        registry,
        { intent: "Do something obscure" },
        "const x = doSomethingObscure(input);",
        "Write",
        {
          threshold: 0.3,
          sessionId: testSessionId,
          telemetryDir: testTelemetryDir,
        },
      );
      expect(result.substituted).toBe(false);
      // Phase 1 response shape preserved — synthesis-required
      expect(result.kind).toBe("synthesis-required");
    },
    15_000,
  );

  it(
    "returns substituted=false when YAKCC_HOOK_DISABLE_SUBSTITUTE=1",
    async () => {
      process.env.YAKCC_HOOK_DISABLE_SUBSTITUTE = "1";

      // Seed the registry so there's a potential match.
      const spec = makeSpecYak("listOfInts", "Produce a list of integers");
      await registry.storeBlock(makeBlockRow(spec));

      // Use a registry that would normally return a high-confidence result.
      const d = Math.sqrt((1 - 0.92) * 4); // cosineDistance → combinedScore 0.92
      const mockRow = makeBlockRow(makeSpecYak("listOfInts", "Produce a list of integers"));
      const highConfRegistry = makeHighConfidenceRegistry(registry, [
        { block: mockRow, cosineDistance: d },
      ]);

      const result = await executeRegistryQueryWithSubstitution(
        highConfRegistry,
        { intent: "Produce a list of integers" },
        "const result = listOfInts(input);",
        "Edit",
        {
          threshold: 1.5,
          sessionId: testSessionId,
          telemetryDir: testTelemetryDir,
        },
      );
      expect(result.substituted).toBe(false);
    },
    15_000,
  );

  it(
    "returns substituted=false when top-1 score is below threshold (low confidence)",
    async () => {
      // cosineDistance → combinedScore = 1 - d²/4 = 0.60 (below 0.85)
      const d = Math.sqrt((1 - 0.60) * 4);
      const mockRow = makeBlockRow(makeSpecYak("fn", "some behavior"));
      const lowConfRegistry = makeHighConfidenceRegistry(registry, [
        { block: mockRow, cosineDistance: d },
      ]);

      const result = await executeRegistryQueryWithSubstitution(
        lowConfRegistry,
        { intent: "some intent" },
        "const x = fn(a);",
        "Edit",
        {
          threshold: 0.3,
          sessionId: testSessionId,
          telemetryDir: testTelemetryDir,
        },
      );
      expect(result.substituted).toBe(false);
    },
    15_000,
  );

  it(
    "returns substituted=false when gap between top-1 and top-2 is too small",
    async () => {
      // top-1 = 0.92, top-2 = 0.82 → gap = 0.10 < 0.15 → no substitution
      const d1 = Math.sqrt((1 - 0.92) * 4);
      const d2 = Math.sqrt((1 - 0.82) * 4);
      const row1 = makeBlockRow(makeSpecYak("fn1", "behavior one"));
      const row2 = makeBlockRow(makeSpecYak("fn2", "behavior two"));
      const tooCloseRegistry = makeHighConfidenceRegistry(registry, [
        { block: row1, cosineDistance: d1 },
        { block: row2, cosineDistance: d2 },
      ]);

      const result = await executeRegistryQueryWithSubstitution(
        tooCloseRegistry,
        { intent: "some intent" },
        "const x = fn1(a);",
        "Edit",
        {
          threshold: 0.3,
          sessionId: testSessionId,
          telemetryDir: testTelemetryDir,
        },
      );
      expect(result.substituted).toBe(false);
    },
    15_000,
  );
});

// ---------------------------------------------------------------------------
// Substitution path — high-confidence candidate → substitution fires
// ---------------------------------------------------------------------------

describe("executeRegistryQueryWithSubstitution — substitution path", () => {
  it(
    "returns substituted=true with substitutedCode when top-1 > 0.85 AND gap > 0.15",
    async () => {
      // top-1 = 0.95, no top-2 → gap = 0.95 > 0.15 → substitute
      const d = Math.sqrt((1 - 0.95) * 4);
      const mockRow = makeBlockRow(makeSpecYak("listOfInts", "Produce a list of integers"));
      const highConfRegistry = makeHighConfidenceRegistry(registry, [
        { block: mockRow, cosineDistance: d },
      ]);

      const result = await executeRegistryQueryWithSubstitution(
        highConfRegistry,
        { intent: "Produce a list of integers" },
        "const result = listOfInts(input);",
        "Write",
        {
          threshold: 1.5,
          sessionId: testSessionId,
          telemetryDir: testTelemetryDir,
        },
      );

      expect(result.substituted).toBe(true);
      if (result.substituted) {
        expect(result.substitutedCode).toContain("import");
        expect(result.substitutedCode).toContain("listOfInts");
        expect(result.substitutedCode).toContain("@yakcc/atoms/listOfInts");
        expect(result.substitutedCode).toContain("const result");
        expect(result.substitutedCode).toContain("input");
        expect(result.atomHash).toBe(mockRow.blockMerkleRoot);
      }
    },
    15_000,
  );

  it(
    "variable-binding preservation: const x = fn(y) preserved in substituted output",
    async () => {
      const d = Math.sqrt((1 - 0.96) * 4);
      const mockRow = makeBlockRow(makeSpecYak("parseInteger", "Parse an integer from a string"));
      const highConfRegistry = makeHighConfidenceRegistry(registry, [
        { block: mockRow, cosineDistance: d },
      ]);

      const result = await executeRegistryQueryWithSubstitution(
        highConfRegistry,
        { intent: "Parse an integer from a string" },
        "const parsedValue = parseInteger(rawInput);",
        "Edit",
        {
          threshold: 1.5,
          sessionId: testSessionId,
          telemetryDir: testTelemetryDir,
        },
      );

      expect(result.substituted).toBe(true);
      if (result.substituted) {
        // Variable name preserved
        expect(result.substitutedCode).toContain("const parsedValue");
        // Atom name used
        expect(result.substitutedCode).toContain("parseInteger");
        // Arg preserved
        expect(result.substitutedCode).toContain("rawInput");
      }
    },
    15_000,
  );

  it(
    "returns substituted=false when binding extraction fails (destructuring code)",
    async () => {
      // Destructuring: extractBindingShape returns null → substitution fails gracefully
      const d = Math.sqrt((1 - 0.95) * 4);
      const mockRow = makeBlockRow(makeSpecYak("fn", "some behavior"));
      const highConfRegistry = makeHighConfidenceRegistry(registry, [
        { block: mockRow, cosineDistance: d },
      ]);

      const result = await executeRegistryQueryWithSubstitution(
        highConfRegistry,
        { intent: "some behavior" },
        // Destructuring — extractBindingShape returns null for v1
        "const { a, b } = fn(input);",
        "Edit",
        {
          threshold: 1.5,
          sessionId: testSessionId,
          telemetryDir: testTelemetryDir,
        },
      );
      // Should not throw — falls through gracefully
      expect(result.substituted).toBe(false);
    },
    15_000,
  );
});

// ---------------------------------------------------------------------------
// Telemetry — Phase 2 fields written correctly
// ---------------------------------------------------------------------------

describe("executeRegistryQueryWithSubstitution — telemetry", () => {
  it(
    "writes Phase 2 telemetry fields when substitution occurs",
    async () => {
      const d = Math.sqrt((1 - 0.95) * 4);
      const mockRow = makeBlockRow(makeSpecYak("listOfInts", "Produce a list of integers"));
      const highConfRegistry = makeHighConfidenceRegistry(registry, [
        { block: mockRow, cosineDistance: d },
      ]);

      await executeRegistryQueryWithSubstitution(
        highConfRegistry,
        { intent: "Produce a list of integers" },
        "const result = listOfInts(input);",
        "Write",
        {
          threshold: 1.5,
          sessionId: testSessionId,
          telemetryDir: testTelemetryDir,
        },
      );

      const event = readLastTelemetryEvent();
      expect(event).not.toBeNull();
      if (event === null) return;

      expect(event.substituted).toBe(true);
      expect(event.substitutedAtomHash).toBe(mockRow.blockMerkleRoot);
      expect(typeof event.substitutionLatencyMs).toBe("number");
      expect(typeof event.top1Score).toBe("number");
      expect(typeof event.top1Gap).toBe("number");
      if (event.top1Score !== null && event.top1Score !== undefined) {
        expect(event.top1Score).toBeGreaterThan(0.85);
      }
    },
    15_000,
  );

  it(
    "writes Phase 2 telemetry fields when substitution does NOT occur (low score)",
    async () => {
      const d = Math.sqrt((1 - 0.60) * 4);
      const mockRow = makeBlockRow(makeSpecYak("fn", "some behavior"));
      const lowConfRegistry = makeHighConfidenceRegistry(registry, [
        { block: mockRow, cosineDistance: d },
      ]);

      await executeRegistryQueryWithSubstitution(
        lowConfRegistry,
        { intent: "some behavior" },
        "const x = fn(a);",
        "Edit",
        {
          threshold: 0.3,
          sessionId: testSessionId,
          telemetryDir: testTelemetryDir,
        },
      );

      const event = readLastTelemetryEvent();
      expect(event).not.toBeNull();
      if (event === null) return;

      expect(event.substituted).toBe(false);
      expect(event.substitutedAtomHash).toBeNull();
      // top1Score and top1Gap are still populated (from the candidate scores)
      expect(typeof event.top1Score).toBe("number");
    },
    15_000,
  );

  it(
    "Phase 3: substitutedCode starts with contract comment line (additive bytes only)",
    async () => {
      // Phase 3 sanity: the substitutedAtomHash in telemetry matches the hash[:8] in the comment.
      // makeSpecYak produces guarantees:[] so the parenthetical is (string => number) — no semicolon.
      const d = Math.sqrt((1 - 0.95) * 4);
      const mockRow = makeBlockRow(makeSpecYak("listOfInts", "Produce a list of integers"));
      const highConfRegistry = makeHighConfidenceRegistry(registry, [
        { block: mockRow, cosineDistance: d },
      ]);

      const result = await executeRegistryQueryWithSubstitution(
        highConfRegistry,
        { intent: "Produce a list of integers" },
        "const result = listOfInts(input);",
        "Write",
        {
          threshold: 1.5,
          sessionId: testSessionId,
          telemetryDir: testTelemetryDir,
        },
      );

      expect(result.substituted).toBe(true);
      if (!result.substituted) return;

      const lines = result.substitutedCode.split("\n");

      // Line 0: contract comment in D-HOOK-4 format
      expect(lines[0]).toMatch(/^\/\/ @atom listOfInts \(.* => .*\) — yakcc:[0-9a-f]{8}$/);

      // The hash[:8] in the comment must match the first 8 chars of the block's merkleRoot
      const hashInComment = lines[0]?.match(/yakcc:([0-9a-f]{8})/)?.[1];
      expect(hashInComment).toBe(mockRow.blockMerkleRoot.slice(0, 8));

      // Line 1: import (Phase 2 content preserved)
      expect(lines[1]).toContain("import { listOfInts }");
      expect(lines[1]).toContain("@yakcc/atoms/listOfInts");

      // Line 2: binding (Phase 2 content preserved)
      expect(lines[2]).toContain("const result");
      expect(lines[2]).toContain("listOfInts(input)");

      // Phase 2 telemetry field still correlates with comment hash
      const event = readLastTelemetryEvent();
      expect(event?.substitutedAtomHash).toBe(mockRow.blockMerkleRoot);
    },
    15_000,
  );

  it(
    "Phase 1 fields are still present in Phase 2 telemetry events (no regression)",
    async () => {
      await executeRegistryQueryWithSubstitution(
        registry,
        { intent: "anything" },
        "const x = fn();",
        "Edit",
        {
          threshold: 0.3,
          sessionId: testSessionId,
          telemetryDir: testTelemetryDir,
        },
      );

      const event = readLastTelemetryEvent();
      expect(event).not.toBeNull();
      if (event === null) return;

      // Phase 1 fields must all be present
      expect(typeof event.t).toBe("number");
      expect(typeof event.intentHash).toBe("string");
      expect(event.intentHash).toMatch(/^[0-9a-f]{64}$/);
      expect(event.toolName).toBe("Edit");
      expect(typeof event.candidateCount).toBe("number");
      expect(typeof event.latencyMs).toBe("number");
      expect(["registry-hit", "synthesis-required", "passthrough"]).toContain(event.outcome);
    },
    15_000,
  );
});
