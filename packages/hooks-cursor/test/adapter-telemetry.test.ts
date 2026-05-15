/**
 * adapter-telemetry.test.ts — Adapter integration tests for telemetry wire-in.
 *
 * WI-HOOK-PHASE-4-CURSOR (#219) — cursor adapter telemetry parity.
 *
 * These tests verify that the Cursor adapter produces correct JSONL telemetry
 * end-to-end via the executeRegistryQueryWithSubstitution wrapper with the
 * cursor-specific session ID prefix (DEC-HOOK-CURSOR-PHASE4-001-B).
 *
 * Production sequence exercised:
 *   createHook(registry, { telemetryDir, sessionId }) →
 *   onCodeEmissionIntent(ctx, toolName) →
 *   assert JSONL written + schema match + observe-don't-mutate + no-PII
 *
 * Key cursor-specific assertion: when sessionId is omitted, the JSONL filename
 * is prefixed with "cursor-" (resolveCursorSessionId() behaviour).
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
import { type EmissionContext, createHook, resolveCursorSessionId } from "../src/index.js";

// ---------------------------------------------------------------------------
// Mock embedding provider
// ---------------------------------------------------------------------------

function mockEmbeddingProvider(): EmbeddingProvider {
  return {
    dimension: 384,
    modelId: "mock/test-cursor-adapter-telemetry",
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
// Test fixture factories
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

// ---------------------------------------------------------------------------
// TelemetryEvent shape (mirrors D-HOOK-5 schema in telemetry.ts)
// ---------------------------------------------------------------------------

type TelemetryEvent = {
  t: number;
  intentHash: string;
  toolName: "Edit" | "Write" | "MultiEdit";
  candidateCount: number;
  topScore: number | null;
  substituted: boolean;
  substitutedAtomHash: string | null;
  latencyMs: number;
  outcome: "registry-hit" | "synthesis-required" | "passthrough";
};

function readTelemetryLines(telemetryDir: string, sessionId: string): TelemetryEvent[] {
  const filePath = join(telemetryDir, `${sessionId}.jsonl`);
  if (!existsSync(filePath)) return [];
  return readFileSync(filePath, "utf-8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as TelemetryEvent);
}

// ---------------------------------------------------------------------------
// Test lifecycle
// ---------------------------------------------------------------------------

let registry: Registry;
let testTelemetryDir: string;
const SESSION_ID = `cursor-test-session-${process.pid}`;

beforeEach(async () => {
  registry = await openRegistry(":memory:", { embeddings: mockEmbeddingProvider() });
  testTelemetryDir = join(tmpdir(), `yakcc-cursor-tel-${process.pid}-${Date.now()}`);
});

afterEach(async () => {
  await registry.close();
  if (existsSync(testTelemetryDir)) {
    rmSync(testTelemetryDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// T1: Telemetry-write integration
// ---------------------------------------------------------------------------

describe("T1: telemetry-write integration", () => {
  it("writes exactly one JSONL line with D-HOOK-5 schema after an Edit tool-call event", async () => {
    const spec = makeSpecYak("sort-list", "Sort a list of integers in ascending order");
    await registry.storeBlock(makeBlockRow(spec));

    const hook = createHook(registry, {
      threshold: 1.5,
      sessionId: SESSION_ID,
      telemetryDir: testTelemetryDir,
    });
    await hook.onCodeEmissionIntent({ intent: "Sort a list of integers" }, "Edit");

    const lines = readTelemetryLines(testTelemetryDir, SESSION_ID);
    expect(lines).toHaveLength(1);

    const event = lines[0];
    expect(event).toBeDefined();
    if (!event) return;

    expect(typeof event.t).toBe("number");
    expect(event.t).toBeGreaterThan(0);
    expect(typeof event.intentHash).toBe("string");
    expect(event.intentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(event.toolName).toBe("Edit");
    expect(typeof event.candidateCount).toBe("number");
    expect(event.candidateCount).toBeGreaterThanOrEqual(0);
    if (event.candidateCount === 0) {
      expect(event.topScore).toBeNull();
    } else {
      expect(typeof event.topScore).toBe("number");
    }
    expect(typeof event.latencyMs).toBe("number");
    expect(event.latencyMs).toBeGreaterThanOrEqual(0);
    expect(["registry-hit", "synthesis-required", "passthrough"]).toContain(event.outcome);
  }, 10_000);

  it("writes JSONL for Write and MultiEdit tool names", async () => {
    const hook = createHook(registry, {
      sessionId: SESSION_ID,
      telemetryDir: testTelemetryDir,
    });

    await hook.onCodeEmissionIntent({ intent: "Write a file header" }, "Write");
    await hook.onCodeEmissionIntent({ intent: "Apply multi-file edits" }, "MultiEdit");

    const lines = readTelemetryLines(testTelemetryDir, SESSION_ID);
    expect(lines).toHaveLength(2);
    expect(lines[0]?.toolName).toBe("Write");
    expect(lines[1]?.toolName).toBe("MultiEdit");
  }, 10_000);
});

// ---------------------------------------------------------------------------
// T2: Observe-don't-mutate invariant under all 3 outcomes
// ---------------------------------------------------------------------------

describe("T2: observe-don't-mutate — response unchanged under all 3 outcomes", () => {
  it("registry-hit outcome: HookResponse unchanged by telemetry write", async () => {
    const spec = makeSpecYak("parse-int", "Parse an integer from a string");
    await registry.storeBlock(makeBlockRow(spec));

    const hook = createHook(registry, {
      threshold: 1.5,
      sessionId: SESSION_ID,
      telemetryDir: testTelemetryDir,
    });
    const response = await hook.onCodeEmissionIntent(
      { intent: "Parse an integer from a string" },
      "Edit",
    );

    expect(response.kind).toBe("registry-hit");
    if (response.kind === "registry-hit") {
      expect(response.id).toMatch(/^[0-9a-f]{64}$/);
    }
    const lines = readTelemetryLines(testTelemetryDir, SESSION_ID);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.outcome).toBe("registry-hit");
  }, 10_000);

  it("synthesis-required outcome: HookResponse unchanged by telemetry write", async () => {
    const hook = createHook(registry, {
      sessionId: SESSION_ID,
      telemetryDir: testTelemetryDir,
    });
    const intent = "Generate a binary search tree insertion function";
    const response = await hook.onCodeEmissionIntent({ intent }, "Write");

    expect(response.kind).toBe("synthesis-required");
    if (response.kind === "synthesis-required") {
      expect(response.proposal.behavior).toBe(intent);
      expect(response.proposal.inputs).toHaveLength(0);
    }
    const lines = readTelemetryLines(testTelemetryDir, SESSION_ID);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.outcome).toBe("synthesis-required");
  }, 10_000);

  it("passthrough outcome: HookResponse unchanged by telemetry write", async () => {
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
      findCandidatesByQuery: async () => {
        throw new Error("simulated DB failure");
      },
      exportManifest: registry.exportManifest.bind(registry),
      getForeignRefs: registry.getForeignRefs.bind(registry),
      storeWorkspacePlumbing: registry.storeWorkspacePlumbing.bind(registry),
      listWorkspacePlumbing: registry.listWorkspacePlumbing.bind(registry),
        storeSourceFileGlue: registry.storeSourceFileGlue.bind(registry),
        getSourceFileGlue: registry.getSourceFileGlue.bind(registry),
        listSourceFileGlue: registry.listSourceFileGlue.bind(registry),
        getAtomRangesBySourceFile: registry.getAtomRangesBySourceFile.bind(registry),
        listOccurrencesBySourceFile: registry.listOccurrencesBySourceFile.bind(registry),
        listOccurrencesByMerkleRoot: registry.listOccurrencesByMerkleRoot.bind(registry),
        replaceSourceFileOccurrences: registry.replaceSourceFileOccurrences.bind(registry),
        storeSourceFileContentHash: registry.storeSourceFileContentHash.bind(registry),
        getSourceFileContentHash: registry.getSourceFileContentHash.bind(registry),
    };

    const hook = createHook(brokenRegistry, {
      sessionId: SESSION_ID,
      telemetryDir: testTelemetryDir,
    });
    const response = await hook.onCodeEmissionIntent({ intent: "any intent" }, "MultiEdit");

    expect(response.kind).toBe("passthrough");
    const lines = readTelemetryLines(testTelemetryDir, SESSION_ID);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.outcome).toBe("passthrough");
  }, 10_000);
});

// ---------------------------------------------------------------------------
// T3: No-PII invariant
// ---------------------------------------------------------------------------

describe("T3: no-PII invariant", () => {
  it("JSONL contains BLAKE3 intentHash but no plaintext intent text", async () => {
    const sensitiveIntent = "paste my API key abc123 into config";
    const hook = createHook(registry, {
      sessionId: SESSION_ID,
      telemetryDir: testTelemetryDir,
    });
    await hook.onCodeEmissionIntent({ intent: sensitiveIntent }, "Edit");

    const lines = readTelemetryLines(testTelemetryDir, SESSION_ID);
    expect(lines).toHaveLength(1);

    const event = lines[0];
    expect(event).toBeDefined();
    if (!event) return;

    expect(event.intentHash).toMatch(/^[0-9a-f]{64}$/);

    const rawContent = readFileSync(join(testTelemetryDir, `${SESSION_ID}.jsonl`), "utf-8");
    expect(rawContent).not.toContain(sensitiveIntent);
    expect(rawContent).not.toContain("abc123");
  }, 10_000);
});

// ---------------------------------------------------------------------------
// T4: One-line-per-event invariant
// ---------------------------------------------------------------------------

describe("T4: one-line-per-event invariant", () => {
  it("N adapter invocations produce exactly N JSONL lines", async () => {
    const N = 7;
    const hook = createHook(registry, {
      sessionId: SESSION_ID,
      telemetryDir: testTelemetryDir,
    });

    const toolNames: Array<"Edit" | "Write" | "MultiEdit"> = ["Edit", "Write", "MultiEdit"];
    for (let i = 0; i < N; i++) {
      const toolName = toolNames[i % toolNames.length] ?? "Edit";
      await hook.onCodeEmissionIntent({ intent: `Intent number ${i}` }, toolName);
    }

    const lines = readTelemetryLines(testTelemetryDir, SESSION_ID);
    expect(lines).toHaveLength(N);
  }, 15_000);
});

// ---------------------------------------------------------------------------
// T5: Cursor-specific — "cursor-" prefix in resolved session ID
// ---------------------------------------------------------------------------

describe("T5: cursor-specific session ID prefix", () => {
  it("resolveCursorSessionId() always returns a string starting with 'cursor-'", () => {
    const id = resolveCursorSessionId();
    expect(id).toMatch(/^cursor-.+/);
  });

  it("telemetry file is written with cursor-prefixed session ID when sessionId option omitted", async () => {
    // Determine what the cursor session ID will be for this process.
    // We can't predict the exact UUID, but we know it starts with "cursor-".
    const autoId = resolveCursorSessionId();
    expect(autoId.startsWith("cursor-")).toBe(true);

    const hook = createHook(registry, {
      // No sessionId override — auto-resolution must produce cursor-<id>
      telemetryDir: testTelemetryDir,
    });
    await hook.onCodeEmissionIntent({ intent: "Any intent for prefix test" }, "Edit");

    // The JSONL file must exist at cursor-<id>.jsonl in the telemetry dir.
    const expectedPath = join(testTelemetryDir, `${autoId}.jsonl`);
    expect(existsSync(expectedPath)).toBe(true);

    const lines = readTelemetryLines(testTelemetryDir, autoId);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.outcome).toMatch(/^(registry-hit|synthesis-required|passthrough)$/);
  }, 10_000);
});
