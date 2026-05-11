/**
 * index.test.ts — Tests for @yakcc/hooks-base shared types and helpers (WI-V1W2-HOOKS-BASE).
 *
 * Production sequence exercised:
 *   openRegistry(":memory:", { embeddings }) → storeBlock(row) →
 *   executeRegistryQuery(registry, ctx, {threshold}) → assert response shape
 *
 * Each helper exported from hooks-base is tested in isolation and then in
 * the compound production sequence that the consumer hooks rely on.
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
  DEFAULT_REGISTRY_HIT_THRESHOLD,
  type EmissionContext,
  type HookOptions,
  type HookResponse,
  buildIntentCardQuery,
  buildSkeletonSpec,
  executeRegistryQuery,
  writeMarkerCommand,
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
    modelId: "mock/test-hooks-base",
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
// buildIntentCardQuery
// ---------------------------------------------------------------------------

describe("buildIntentCardQuery", () => {
  it("returns behavior = intent when no sourceContext is provided", () => {
    const ctx: EmissionContext = { intent: "Parse an integer" };
    const query = buildIntentCardQuery(ctx);
    expect(query.behavior).toBe("Parse an integer");
    expect(query.inputs).toHaveLength(0);
    expect(query.outputs).toHaveLength(0);
  });

  it("concatenates intent and sourceContext when sourceContext is present", () => {
    const ctx: EmissionContext = {
      intent: "filter the list",
      sourceContext: "by removing nulls",
    };
    const query = buildIntentCardQuery(ctx);
    expect(query.behavior).toBe("filter the list by removing nulls");
  });

  it("returns empty inputs and outputs arrays always", () => {
    const ctx: EmissionContext = { intent: "anything" };
    const query = buildIntentCardQuery(ctx);
    expect(Array.isArray(query.inputs)).toBe(true);
    expect(Array.isArray(query.outputs)).toBe(true);
    expect(query.inputs).toHaveLength(0);
    expect(query.outputs).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// buildSkeletonSpec
// ---------------------------------------------------------------------------

describe("buildSkeletonSpec", () => {
  it("returns a ContractSpec with behavior set to the intent", () => {
    const skeleton = buildSkeletonSpec("Compute a hash");
    expect(skeleton.behavior).toBe("Compute a hash");
  });

  it("returns empty arrays for all collection fields", () => {
    const skeleton = buildSkeletonSpec("anything");
    expect(skeleton.inputs).toHaveLength(0);
    expect(skeleton.outputs).toHaveLength(0);
    expect(skeleton.guarantees).toHaveLength(0);
    expect(skeleton.errorConditions).toHaveLength(0);
    expect(skeleton.propertyTests).toHaveLength(0);
  });

  it("defaults nonFunctional to pure + safe", () => {
    const skeleton = buildSkeletonSpec("anything");
    expect(skeleton.nonFunctional.purity).toBe("pure");
    expect(skeleton.nonFunctional.threadSafety).toBe("safe");
  });
});

// ---------------------------------------------------------------------------
// writeMarkerCommand
// ---------------------------------------------------------------------------

describe("writeMarkerCommand", () => {
  const testMarkerDir = join(tmpdir(), `yakcc-base-marker-test-${process.pid}`);

  afterEach(() => {
    if (existsSync(testMarkerDir)) {
      rmSync(testMarkerDir, { recursive: true, force: true });
    }
  });

  it("creates the marker directory if it does not exist and writes the file", () => {
    writeMarkerCommand(testMarkerDir, "test-marker.json", { key: "value" });
    const markerPath = join(testMarkerDir, "test-marker.json");
    expect(existsSync(markerPath)).toBe(true);
  });

  it("writes valid JSON that round-trips correctly", () => {
    const payload = { command: "/yakcc", registeredAt: "2026-01-01T00:00:00Z" };
    writeMarkerCommand(testMarkerDir, "marker.json", payload);

    const content = JSON.parse(readFileSync(join(testMarkerDir, "marker.json"), "utf-8")) as typeof payload;
    expect(content.command).toBe("/yakcc");
    expect(content.registeredAt).toBe("2026-01-01T00:00:00Z");
  });

  it("is idempotent — writing twice does not throw", () => {
    writeMarkerCommand(testMarkerDir, "marker.json", { v: 1 });
    expect(() => writeMarkerCommand(testMarkerDir, "marker.json", { v: 2 })).not.toThrow();
    expect(existsSync(join(testMarkerDir, "marker.json"))).toBe(true);
  });

  it("creates nested directories recursively", () => {
    const nestedDir = join(testMarkerDir, "deeply", "nested");
    writeMarkerCommand(nestedDir, "nested.json", { nested: true });
    expect(existsSync(join(nestedDir, "nested.json"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// DEFAULT_REGISTRY_HIT_THRESHOLD
// ---------------------------------------------------------------------------

describe("DEFAULT_REGISTRY_HIT_THRESHOLD", () => {
  it("is exactly 0.30", () => {
    expect(DEFAULT_REGISTRY_HIT_THRESHOLD).toBe(0.3);
  });
});

// ---------------------------------------------------------------------------
// executeRegistryQuery — registry-hit path
// ---------------------------------------------------------------------------

describe("executeRegistryQuery — registry-hit path", () => {
  it(
    "returns kind=registry-hit when a close semantic match exists",
    async () => {
      const spec = makeSpecYak("parse-integer", "Parse an integer from a string");
      await registry.storeBlock(makeBlockRow(spec));

      // Noise blocks to exercise KNN ranking.
      for (const [name, behavior] of [
        ["check-digit", "Check whether a character is a digit"],
        ["sort-array", "Sort an array of numbers in ascending order"],
      ] as [string, string][]) {
        await registry.storeBlock(makeBlockRow(makeSpecYak(name, behavior)));
      }

      const ctx: EmissionContext = { intent: "Parse an integer from a string" };
      // Permissive threshold so mock embedder's close vectors register as hit.
      const response: HookResponse = await executeRegistryQuery(registry, ctx, { threshold: 1.5 });

      expect(response.kind).toBe("registry-hit");
      if (response.kind === "registry-hit") {
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

      const ctx: EmissionContext = { intent: "Add two numbers together" };
      const r1 = await executeRegistryQuery(registry, ctx, { threshold: 1.5 });
      const r2 = await executeRegistryQuery(registry, ctx, { threshold: 1.5 });

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
// executeRegistryQuery — synthesis-required path
// ---------------------------------------------------------------------------

describe("executeRegistryQuery — synthesis-required path", () => {
  it(
    "returns kind=synthesis-required when the registry is empty",
    async () => {
      const ctx: EmissionContext = { intent: "Compute the Fibonacci sequence" };
      const response = await executeRegistryQuery(registry, ctx, {
        threshold: DEFAULT_REGISTRY_HIT_THRESHOLD,
      });

      expect(response.kind).toBe("synthesis-required");
      if (response.kind === "synthesis-required") {
        expect(response.proposal.behavior).toBe(ctx.intent);
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
    "returns kind=synthesis-required when strict threshold prevents any hit",
    async () => {
      const spec = makeSpecYak("base64-encode", "Encode bytes as a base64 string");
      await registry.storeBlock(makeBlockRow(spec));

      const ctx: EmissionContext = {
        intent: "Completely unrelated: validate email address format",
      };
      // Zero threshold: no candidate ever wins.
      const response = await executeRegistryQuery(registry, ctx, { threshold: 0.0 });

      expect(response.kind).toBe("synthesis-required");
      if (response.kind === "synthesis-required") {
        expect(response.proposal.behavior).toBe(ctx.intent);
      }
    },
    10_000,
  );

  it(
    "proposal behavior is the intent (not the concatenated query string) when sourceContext is provided",
    async () => {
      const ctx: EmissionContext = {
        intent: "filter the list",
        sourceContext: "by removing nulls",
      };
      const response = await executeRegistryQuery(registry, ctx, { threshold: 0.0 });

      expect(response.kind).toBe("synthesis-required");
      if (response.kind === "synthesis-required") {
        // Skeleton behavior is ctx.intent only, not the concatenated query string.
        expect(response.proposal.behavior).toBe("filter the list");
      }
    },
    10_000,
  );
});

// ---------------------------------------------------------------------------
// executeRegistryQuery — passthrough path
// ---------------------------------------------------------------------------

describe("executeRegistryQuery — passthrough (error) path", () => {
  it(
    "returns kind=passthrough when the registry throws on findCandidatesByIntent",
    async () => {
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

      const ctx: EmissionContext = { intent: "some emission intent" };
      const response = await executeRegistryQuery(brokenRegistry, ctx, {
        threshold: DEFAULT_REGISTRY_HIT_THRESHOLD,
      });

      expect(response.kind).toBe("passthrough");
    },
    10_000,
  );
});

// ---------------------------------------------------------------------------
// Compound-interaction test: full production sequence end-to-end
// ---------------------------------------------------------------------------

describe("compound interaction — full production sequence", () => {
  it(
    "exercises the shared hooks-base logic across the real registry interaction lifecycle",
    async () => {
      // Step 1: verify type exports are usable (compile-time proof via type annotations).
      const _optionsTypeCheck: HookOptions = { threshold: 0.3, markerDir: "/tmp" };
      void _optionsTypeCheck;

      // Step 2: seed the registry.
      const spec = makeSpecYak("reverse-string", "Reverse a string");
      await registry.storeBlock(makeBlockRow(spec));

      // Step 3: registry-hit path via executeRegistryQuery.
      const hitCtx: EmissionContext = { intent: "Reverse a string" };
      const hitResponse = await executeRegistryQuery(registry, hitCtx, { threshold: 1.5 });
      expect(hitResponse.kind).toBe("registry-hit");
      if (hitResponse.kind === "registry-hit") {
        expect(hitResponse.id).toMatch(/^[0-9a-f]{64}$/);
      }

      // Step 4: synthesis-required path (strict threshold).
      const missCtx: EmissionContext = { intent: "Compute a 3D convex hull" };
      const missResponse = await executeRegistryQuery(registry, missCtx, { threshold: 0.0 });
      expect(missResponse.kind).toBe("synthesis-required");
      if (missResponse.kind === "synthesis-required") {
        expect(missResponse.proposal.behavior).toContain("convex hull");
        // Skeleton built by buildSkeletonSpec — verify its shape.
        expect(missResponse.proposal.nonFunctional.purity).toBe("pure");
      }

      // Step 5: writeMarkerCommand writes a well-formed JSON marker file.
      const markerDir = join(tmpdir(), `yakcc-base-e2e-${process.pid}`);
      try {
        writeMarkerCommand(markerDir, "test-command.json", {
          command: "yakcc",
          registeredAt: new Date().toISOString(),
        });
        expect(existsSync(join(markerDir, "test-command.json"))).toBe(true);
      } finally {
        if (existsSync(markerDir)) {
          rmSync(markerDir, { recursive: true, force: true });
        }
      }
    },
    15_000,
  );
});
