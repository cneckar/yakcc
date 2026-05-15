/**
 * adapter-telemetry.test.ts — Adapter integration tests for telemetry wire-in.
 *
 * WI-HOOK-PHASE-1 layer 2 (#260, closes #216).
 *
 * These tests verify that the Claude Code adapter produces correct JSONL telemetry
 * end-to-end via the executeRegistryQueryWithTelemetry wrapper (DEC-HOOK-PHASE-1-001).
 *
 * Production sequence exercised:
 *   createHook(registry, { telemetryDir, sessionId }) →
 *   onCodeEmissionIntent(ctx, toolName) →
 *   assert JSONL written + schema match + observe-don't-mutate + no-PII
 *
 * Test isolation:
 * - All tests use YAKCC_TELEMETRY_DIR via ClaudeCodeHookOptions.telemetryDir.
 * - A fixed sessionId is passed per test so the JSONL filename is predictable.
 * - tmpdir is cleaned up in afterEach.
 *
 * Acceptance items verified (from #216 / #260):
 * T1. Telemetry-write integration: JSONL line written with D-HOOK-5 schema match.
 * T2. Observe-don't-mutate: response UNCHANGED for all 3 outcomes.
 * T3. No-PII: intentHash (BLAKE3) present; plaintext intent absent from JSONL.
 * T4. One-line-per-event: N calls → exactly N JSONL lines.
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
import { type EmissionContext, createHook } from "../src/index.js";

// ---------------------------------------------------------------------------
// Mock embedding provider (same deterministic approach as index.test.ts)
// ---------------------------------------------------------------------------

function mockEmbeddingProvider(): EmbeddingProvider {
  return {
    dimension: 384,
    modelId: "mock/test-adapter-telemetry",
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
// D-HOOK-5 TelemetryEvent shape (mirrors telemetry.ts — used for schema assertions)
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

/** Read all JSONL lines from a session file as parsed TelemetryEvent objects. */
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
const SESSION_ID = `test-session-${process.pid}`;

beforeEach(async () => {
  registry = await openRegistry(":memory:", { embeddings: mockEmbeddingProvider() });
  testTelemetryDir = join(tmpdir(), `yakcc-tel-${process.pid}-${Date.now()}`);
});

afterEach(async () => {
  await registry.close();
  if (existsSync(testTelemetryDir)) {
    rmSync(testTelemetryDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// T1: Telemetry-write integration — JSONL produced with D-HOOK-5 schema
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

    // D-HOOK-5 required fields present
    expect(typeof event.t).toBe("number");
    expect(event.t).toBeGreaterThan(0);
    expect(typeof event.intentHash).toBe("string");
    expect(event.intentHash).toMatch(/^[0-9a-f]{64}$/); // BLAKE3-256 hex
    expect(event.toolName).toBe("Edit");
    expect(typeof event.candidateCount).toBe("number");
    expect(event.candidateCount).toBeGreaterThanOrEqual(0);
    // topScore: null when candidateCount===0, otherwise a number
    if (event.candidateCount === 0) {
      expect(event.topScore).toBeNull();
    } else {
      expect(typeof event.topScore).toBe("number");
    }
    expect(event.substituted).toBe(false); // Phase 1: always false
    expect(event.substitutedAtomHash).toBeNull(); // Phase 1: never substituted
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
  it("registry-hit outcome: HookResponse is unchanged by telemetry write", async () => {
    const spec = makeSpecYak("parse-int", "Parse an integer from a string");
    await registry.storeBlock(makeBlockRow(spec));

    // threshold=1.5 ensures a registry-hit under the mock embedder
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
    // Telemetry was written — but the response is the real HookResponse, not mutated
    const lines = readTelemetryLines(testTelemetryDir, SESSION_ID);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.outcome).toBe("registry-hit");
  }, 10_000);

  it("synthesis-required outcome: HookResponse is unchanged by telemetry write", async () => {
    // Empty registry → synthesis-required
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

  it("passthrough outcome: HookResponse is unchanged by telemetry write", async () => {
    // Broken registry → passthrough
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
    // Telemetry is still attempted even on passthrough (observe, don't skip)
    // The wrapper captures the passthrough outcome in the JSONL
    const lines = readTelemetryLines(testTelemetryDir, SESSION_ID);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.outcome).toBe("passthrough");
  }, 10_000);
});

// ---------------------------------------------------------------------------
// T3: No-PII invariant — intentHash only, no plaintext intent in JSONL
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

    // intentHash must be a 64-hex BLAKE3 digest
    expect(event.intentHash).toMatch(/^[0-9a-f]{64}$/);

    // The raw JSONL file must not contain the plaintext intent
    const rawContent = readFileSync(join(testTelemetryDir, `${SESSION_ID}.jsonl`), "utf-8");
    expect(rawContent).not.toContain(sensitiveIntent);
    expect(rawContent).not.toContain("abc123");
    expect(rawContent).not.toContain("API key");
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

  it("each line is valid JSON (no partial writes)", async () => {
    const hook = createHook(registry, {
      sessionId: SESSION_ID,
      telemetryDir: testTelemetryDir,
    });

    for (let i = 0; i < 5; i++) {
      await hook.onCodeEmissionIntent({ intent: `Check JSON integrity ${i}` }, "Edit");
    }

    const filePath = join(testTelemetryDir, `${SESSION_ID}.jsonl`);
    const rawLines = readFileSync(filePath, "utf-8")
      .split("\n")
      .filter((l) => l.trim().length > 0);

    expect(rawLines).toHaveLength(5);
    for (const line of rawLines) {
      // Each line must be parseable JSON — no partial writes
      expect(() => JSON.parse(line)).not.toThrow();
    }
  }, 10_000);
});

// ---------------------------------------------------------------------------
// T5: Schema end-to-end — all D-HOOK-5 fields present and correctly typed
// ---------------------------------------------------------------------------

describe("T5: D-HOOK-5 schema end-to-end", () => {
  it("all required TelemetryEvent fields are present with correct types for a registry-hit", async () => {
    const spec = makeSpecYak("concat-strings", "Concatenate two strings");
    await registry.storeBlock(makeBlockRow(spec));

    const hook = createHook(registry, {
      threshold: 1.5,
      sessionId: SESSION_ID,
      telemetryDir: testTelemetryDir,
    });
    await hook.onCodeEmissionIntent({ intent: "Concatenate two strings" }, "Edit");

    const lines = readTelemetryLines(testTelemetryDir, SESSION_ID);
    expect(lines).toHaveLength(1);
    const event = lines[0];
    expect(event).toBeDefined();
    if (!event) return;

    // Exhaustive field check per D-HOOK-5
    const requiredKeys: Array<keyof TelemetryEvent> = [
      "t",
      "intentHash",
      "toolName",
      "candidateCount",
      "topScore",
      "substituted",
      "substitutedAtomHash",
      "latencyMs",
      "outcome",
    ];
    for (const key of requiredKeys) {
      expect(event).toHaveProperty(key);
    }

    // Phase 1 invariants
    expect(event.substituted).toBe(false);
    expect(event.substitutedAtomHash).toBeNull();

    // toolName preserved
    expect(event.toolName).toBe("Edit");
  }, 10_000);
});
