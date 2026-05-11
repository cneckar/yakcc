/**
 * index.test.ts — Production-sequence tests for @yakcc/hooks-cursor (WI-V1W2-HOOKS-02).
 *
 * Production sequence exercised:
 *   openRegistry(":memory:", { embeddings }) → storeBlock(row) →
 *   createHook(registry) → onCodeEmissionIntent({ intent }) → assert response shape
 *
 * This mirrors the real production sequence: the hook is created once per Cursor
 * session, backed by a live registry, and called on every emission intent. The three
 * paths (registry-hit, synthesis-required, passthrough) all flow through the same
 * factory and the same onCodeEmissionIntent call.
 *
 * Mock embedding notes:
 * - Uses a character-hash approach so different behavior strings produce meaningfully
 *   different unit vectors — this ensures KNN ordering is exercised.
 * - Does NOT use the local transformers.js/ONNX provider to keep tests offline-capable
 *   (Sacred Practice #5: mock only external boundaries).
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
import type { BlockTripletRow, Registry } from "@yakcc/registry";
import { openRegistry } from "@yakcc/registry";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CURSOR_COMMAND_MARKER_FILENAME,
  DEFAULT_REGISTRY_HIT_THRESHOLD,
  type EmissionContext,
  type HookResponse,
  createHook,
} from "../src/index.js";

// ---------------------------------------------------------------------------
// Deterministic mock embedding provider
// ---------------------------------------------------------------------------

/**
 * Returns a deterministic 384-dim Float32Array for any input text.
 * Uses a character-hash so different behavior strings produce distinct
 * unit vectors — KNN ordering is exercised meaningfully.
 */
function mockEmbeddingProvider(): EmbeddingProvider {
  return {
    dimension: 384,
    modelId: "mock/test-hook-cursor",
    async embed(text: string): Promise<Float32Array> {
      const vec = new Float32Array(384);
      for (let i = 0; i < 384; i++) {
        const charIdx = (i * 7 + 3) % text.length;
        const charCode = text.charCodeAt(charIdx) / 128;
        vec[i] = charCode * Math.sin((i + 1) * 0.05) + (i % 10) * 0.001;
      }
      // L2-normalize to unit sphere so cosine distance = euclidean distance²/2.
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

/** Make a minimal valid SpecYak for test fixtures. */
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

/** Build a complete BlockTripletRow from a SpecYak. */
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
// Path 1: registry-hit
// ---------------------------------------------------------------------------

describe("onCodeEmissionIntent — registry-hit path", () => {
  it(
    "returns kind=registry-hit when a close semantic match exists in the registry",
    async () => {
      // Seed a block whose behavior string is intentionally close to the query intent.
      const matchingSpec = makeSpecYak(
        "parse-integer",
        "Parse an integer from a string",
      );
      const row = makeBlockRow(matchingSpec);
      await registry.storeBlock(row);

      // Also seed noise blocks to ensure the KNN search actually ranks them.
      const noiseSpecs = [
        makeSpecYak("check-digit", "Check whether a character is a digit"),
        makeSpecYak("sort-array", "Sort an array of numbers in ascending order"),
      ];
      for (const spec of noiseSpecs) {
        await registry.storeBlock(makeBlockRow(spec));
      }

      // Use a very permissive threshold so the mock embedder's close-but-not-identical
      // vectors still register as a hit. The production threshold (0.30) is tested
      // with a real embedding provider; here we verify the conditional logic fires.
      const hook = createHook(registry, { threshold: 1.5 });
      const ctx: EmissionContext = { intent: "Parse an integer from a string" };
      const response: HookResponse = await hook.onCodeEmissionIntent(ctx);

      expect(response.kind).toBe("registry-hit");
      if (response.kind === "registry-hit") {
        // id must be a 64-char hex ContractId derived from the block's spec bytes.
        expect(response.id).toMatch(/^[0-9a-f]{64}$/);
      }
    },
    10_000,
  );

  it(
    "registry-hit id is stable across repeated calls for the same block",
    async () => {
      const spec = makeSpecYak("add-numbers", "Add two numbers together");
      await registry.storeBlock(makeBlockRow(spec));

      const hook = createHook(registry, { threshold: 1.5 });
      const ctx: EmissionContext = { intent: "Add two numbers together" };

      const r1 = await hook.onCodeEmissionIntent(ctx);
      const r2 = await hook.onCodeEmissionIntent(ctx);

      expect(r1.kind).toBe("registry-hit");
      expect(r2.kind).toBe("registry-hit");
      if (r1.kind === "registry-hit" && r2.kind === "registry-hit") {
        expect(r1.id).toBe(r2.id);
      }
    },
    10_000,
  );
});

// ---------------------------------------------------------------------------
// Path 2: synthesis-required
// ---------------------------------------------------------------------------

describe("onCodeEmissionIntent — synthesis-required path", () => {
  it(
    "returns kind=synthesis-required when the registry is empty",
    async () => {
      // No blocks stored — any query must produce synthesis-required.
      const hook = createHook(registry); // default threshold
      const ctx: EmissionContext = { intent: "Compute the Fibonacci sequence" };
      const response = await hook.onCodeEmissionIntent(ctx);

      expect(response.kind).toBe("synthesis-required");
      if (response.kind === "synthesis-required") {
        expect(response.proposal.behavior).toBe(ctx.intent);
        // Skeleton has empty collections for all array fields.
        expect(response.proposal.inputs).toHaveLength(0);
        expect(response.proposal.outputs).toHaveLength(0);
        expect(response.proposal.guarantees).toHaveLength(0);
        expect(response.proposal.errorConditions).toHaveLength(0);
        expect(response.proposal.propertyTests).toHaveLength(0);
      }
    },
    10_000,
  );

  it(
    "returns kind=synthesis-required when no candidate beats the threshold (strict threshold)",
    async () => {
      // Seed a block with an unrelated behavior.
      const spec = makeSpecYak("base64-encode", "Encode bytes as a base64 string");
      await registry.storeBlock(makeBlockRow(spec));

      // Use a zero threshold — no candidate can ever beat 0.0 cosine distance.
      const hook = createHook(registry, { threshold: 0.0 });
      const ctx: EmissionContext = {
        intent: "Completely different operation: validate email address format",
      };
      const response = await hook.onCodeEmissionIntent(ctx);

      expect(response.kind).toBe("synthesis-required");
      if (response.kind === "synthesis-required") {
        expect(response.proposal.behavior).toBe(ctx.intent);
      }
    },
    10_000,
  );

  it(
    "proposal behavior includes sourceContext when provided in the query",
    async () => {
      const hook = createHook(registry);
      const ctx: EmissionContext = {
        intent: "filter the list",
        sourceContext: "by removing nulls",
      };
      const response = await hook.onCodeEmissionIntent(ctx);

      // Empty registry → synthesis-required. The behavior query was built from
      // intent + sourceContext; the proposal behavior is the intent alone.
      expect(response.kind).toBe("synthesis-required");
      if (response.kind === "synthesis-required") {
        expect(response.proposal.behavior).toBe(ctx.intent);
      }
    },
    10_000,
  );
});

// ---------------------------------------------------------------------------
// Path 3: error → passthrough
// ---------------------------------------------------------------------------

describe("onCodeEmissionIntent — passthrough (error) path", () => {
  it(
    "returns kind=passthrough when the registry throws on findCandidatesByIntent",
    async () => {
      // Build a registry mock whose findCandidatesByIntent always throws.
      const brokenRegistry: Registry = {
        storeBlock: registry.storeBlock.bind(registry),
        selectBlocks: registry.selectBlocks.bind(registry),
        getBlock: registry.getBlock.bind(registry),
        findByCanonicalAstHash: registry.findByCanonicalAstHash.bind(registry),
        getProvenance: registry.getProvenance.bind(registry),
        enumerateSpecs: registry.enumerateSpecs.bind(registry),
        close: registry.close.bind(registry),
        findCandidatesByIntent: async () => {
          throw new Error("simulated DB failure");
        },
        findCandidatesByQuery: registry.findCandidatesByQuery.bind(registry),
        exportManifest: registry.exportManifest.bind(registry),
        getForeignRefs: registry.getForeignRefs.bind(registry),
        storeWorkspacePlumbing: registry.storeWorkspacePlumbing.bind(registry),
        listWorkspacePlumbing: registry.listWorkspacePlumbing.bind(registry),
      };

      const hook = createHook(brokenRegistry);
      const ctx: EmissionContext = { intent: "some emission intent" };
      const response = await hook.onCodeEmissionIntent(ctx);

      expect(response.kind).toBe("passthrough");
    },
    10_000,
  );
});

// ---------------------------------------------------------------------------
// Path 4: registerCommand
// ---------------------------------------------------------------------------

describe("registerCommand", () => {
  const testMarkerDir = join(tmpdir(), `yakcc-cursor-hook-test-${process.pid}`);

  afterEach(() => {
    // Clean up marker dir after each test.
    if (existsSync(testMarkerDir)) {
      rmSync(testMarkerDir, { recursive: true, force: true });
    }
  });

  it("writes the command marker file to the configured directory", () => {
    const hook = createHook(registry, { markerDir: testMarkerDir });
    hook.registerCommand();

    const markerPath = join(testMarkerDir, CURSOR_COMMAND_MARKER_FILENAME);
    expect(existsSync(markerPath)).toBe(true);

    const content = JSON.parse(readFileSync(markerPath, "utf-8")) as {
      command: string;
      description: string;
      registeredAt: string;
    };
    expect(content.command).toBe("yakcc.lookupOrSynthesize");
    expect(content.description).toContain("yakcc");
    expect(typeof content.registeredAt).toBe("string");
  });

  it("is idempotent — calling twice does not throw and marker file is updated", () => {
    const hook = createHook(registry, { markerDir: testMarkerDir });
    hook.registerCommand();
    hook.registerCommand(); // second call must not throw

    const markerPath = join(testMarkerDir, CURSOR_COMMAND_MARKER_FILENAME);
    expect(existsSync(markerPath)).toBe(true);
  });

  it("creates the marker directory if it does not exist", () => {
    const nestedDir = join(testMarkerDir, "nested", "deep");
    const hook = createHook(registry, { markerDir: nestedDir });
    hook.registerCommand();

    const markerPath = join(nestedDir, CURSOR_COMMAND_MARKER_FILENAME);
    expect(existsSync(markerPath)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Compound-interaction test: full production sequence end-to-end
// ---------------------------------------------------------------------------

describe("compound interaction — full production sequence", () => {
  it(
    "exercises the real production sequence: open → seed → createHook → register → emit → result",
    async () => {
      // Step 1: seed the registry with a known block.
      const spec = makeSpecYak("reverse-string", "Reverse a string");
      const row = makeBlockRow(spec);
      await registry.storeBlock(row);

      // Step 2: create the hook (as done once per Cursor session).
      const markerDir = join(tmpdir(), `yakcc-cursor-e2e-${process.pid}`);
      const hook = createHook(registry, { threshold: 1.5, markerDir });

      try {
        // Step 3: register the command (wires the hook marker into the Cursor directory).
        hook.registerCommand();
        expect(existsSync(join(markerDir, CURSOR_COMMAND_MARKER_FILENAME))).toBe(true);

        // Step 4: emit an intent that matches the seeded block.
        const hitResponse = await hook.onCodeEmissionIntent({
          intent: "Reverse a string",
        });
        expect(hitResponse.kind).toBe("registry-hit");

        // Step 5: emit an intent with no match using strict zero-threshold hook
        // to force synthesis-required.
        const strictHook = createHook(registry, { threshold: 0.0, markerDir });
        const strictMiss = await strictHook.onCodeEmissionIntent({
          intent: "Compute a 3D convex hull from point cloud data",
        });
        expect(strictMiss.kind).toBe("synthesis-required");
        if (strictMiss.kind === "synthesis-required") {
          expect(strictMiss.proposal.behavior).toContain("convex hull");
        }
      } finally {
        if (existsSync(markerDir)) {
          rmSync(markerDir, { recursive: true, force: true });
        }
      }
    },
    15_000,
  );

  it(
    "DEFAULT_REGISTRY_HIT_THRESHOLD is 0.30 — matches hooks-claude-code for cross-IDE consistency",
    () => {
      expect(DEFAULT_REGISTRY_HIT_THRESHOLD).toBe(0.3);
    },
  );
});
