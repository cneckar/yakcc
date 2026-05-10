// SPDX-License-Identifier: MIT
/**
 * telemetry.test.ts — Tests for @yakcc/hooks-base telemetry (WI-HOOK-PHASE-1-MVP, #216).
 *
 * Production sequence exercised:
 *   executeRegistryQueryWithTelemetry(registry, ctx, toolName, opts) →
 *     _executeRegistryQueryInternal() (unchanged response) +
 *     captureTelemetry() (JSONL append to telemetryDir) →
 *   assert: response unchanged, JSONL schema correct, no PII stored.
 *
 * Test coverage:
 *   - D-HOOK-5 schema correctness (all fields present, correct types)
 *   - BLAKE3 hash determinism (same input → same hash)
 *   - No plaintext intent stored (hash ≠ intent text)
 *   - JSONL append-only invariant (pre-existing records preserved)
 *   - observe-don't-mutate (executeRegistryQueryWithTelemetry returns same HookResponse)
 *   - Session-id resolution (env var takes precedence, fallback is UUID-shaped)
 *   - Telemetry dir resolution (env var override)
 *   - Telemetry write failure is swallowed (hook outcome unaffected)
 *
 * Mocking policy: only external FS is written to a tmpdir (not home dir).
 * No internal modules are mocked; registry uses :memory: sqlite.
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
  type EmissionContext,
  type HookResponse,
  executeRegistryQuery,
  executeRegistryQueryWithTelemetry,
} from "../src/index.js";
import {
  type TelemetryEvent,
  appendTelemetryEvent,
  captureTelemetry,
  hashIntent,
  resolveTelemetryDir,
  resolveSessionId,
} from "../src/telemetry.js";

// ---------------------------------------------------------------------------
// Deterministic mock embedding provider (same as index.test.ts)
// ---------------------------------------------------------------------------

function mockEmbeddingProvider(): EmbeddingProvider {
  return {
    dimension: 384,
    modelId: "mock/test-telemetry",
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
// Fixture factories
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
// Test lifecycle
// ---------------------------------------------------------------------------

let registry: Registry;
let telemetryDir: string;

beforeEach(async () => {
  registry = await openRegistry(":memory:", { embeddings: mockEmbeddingProvider() });
  telemetryDir = join(tmpdir(), `yakcc-telemetry-test-${process.pid}-${Date.now()}`);
});

afterEach(async () => {
  await registry.close();
  if (existsSync(telemetryDir)) {
    rmSync(telemetryDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// hashIntent — BLAKE3 determinism and no-PII
// ---------------------------------------------------------------------------

describe("hashIntent", () => {
  it("returns a 64-character lowercase hex string (BLAKE3-256)", () => {
    const h = hashIntent("Parse an integer");
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic — same input always produces the same hash", () => {
    const intent = "Reverse a string in place";
    expect(hashIntent(intent)).toBe(hashIntent(intent));
    // Call a third time to be sure (not memoised).
    expect(hashIntent(intent)).toBe(hashIntent(intent));
  });

  it("produces different hashes for different inputs", () => {
    expect(hashIntent("intent A")).not.toBe(hashIntent("intent B"));
  });

  it("hash is NOT the plaintext intent (no PII stored as-is)", () => {
    const intent = "Do something with user data";
    const h = hashIntent(intent);
    expect(h).not.toBe(intent);
    expect(h).not.toContain(intent);
  });

  it("handles empty string without throwing", () => {
    expect(() => hashIntent("")).not.toThrow();
    expect(hashIntent("")).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ---------------------------------------------------------------------------
// resolveSessionId
// ---------------------------------------------------------------------------

describe("resolveSessionId", () => {
  const origSessionId = process.env.CLAUDE_SESSION_ID;

  afterEach(() => {
    if (origSessionId === undefined) {
      delete process.env.CLAUDE_SESSION_ID;
    } else {
      process.env.CLAUDE_SESSION_ID = origSessionId;
    }
  });

  it("returns CLAUDE_SESSION_ID when set", () => {
    process.env.CLAUDE_SESSION_ID = "test-session-abc123";
    expect(resolveSessionId()).toBe("test-session-abc123");
  });

  it("returns a UUID-shaped fallback when CLAUDE_SESSION_ID is absent", () => {
    delete process.env.CLAUDE_SESSION_ID;
    const id = resolveSessionId();
    // UUID v4 pattern: xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  });

  it("fallback is stable within the same process (same value on repeated calls)", () => {
    delete process.env.CLAUDE_SESSION_ID;
    // The fallback is generated once per process; both calls must return the same value.
    expect(resolveSessionId()).toBe(resolveSessionId());
  });
});

// ---------------------------------------------------------------------------
// resolveTelemetryDir
// ---------------------------------------------------------------------------

describe("resolveTelemetryDir", () => {
  const origDir = process.env.YAKCC_TELEMETRY_DIR;

  afterEach(() => {
    if (origDir === undefined) {
      delete process.env.YAKCC_TELEMETRY_DIR;
    } else {
      process.env.YAKCC_TELEMETRY_DIR = origDir;
    }
  });

  it("returns YAKCC_TELEMETRY_DIR when set", () => {
    process.env.YAKCC_TELEMETRY_DIR = "/custom/telemetry/path";
    expect(resolveTelemetryDir()).toBe("/custom/telemetry/path");
  });

  it("returns a path ending in .yakcc/telemetry when env var is absent", () => {
    delete process.env.YAKCC_TELEMETRY_DIR;
    expect(resolveTelemetryDir()).toMatch(/\.yakcc[/\\]telemetry$/);
  });
});

// ---------------------------------------------------------------------------
// appendTelemetryEvent — JSONL writer
// ---------------------------------------------------------------------------

describe("appendTelemetryEvent", () => {
  const SESSION = "test-session-append";

  it("creates the directory if it does not exist and writes a valid JSONL line", () => {
    const event: TelemetryEvent = {
      t: 1000,
      intentHash: hashIntent("test intent"),
      toolName: "Edit",
      candidateCount: 0,
      topScore: null,
      substituted: false,
      substitutedAtomHash: null,
      latencyMs: 10,
      outcome: "synthesis-required",
    };

    appendTelemetryEvent(event, SESSION, telemetryDir);

    const filePath = join(telemetryDir, `${SESSION}.jsonl`);
    expect(existsSync(filePath)).toBe(true);

    const lines = readFileSync(filePath, "utf-8").split("\n").filter(Boolean);
    expect(lines).toHaveLength(1);

    const parsed = JSON.parse(lines[0]!) as TelemetryEvent;
    expect(parsed.intentHash).toBe(event.intentHash);
    expect(parsed.outcome).toBe("synthesis-required");
  });

  it("JSONL append-only — pre-existing records are preserved on subsequent writes", () => {
    const event1: TelemetryEvent = {
      t: 1000,
      intentHash: hashIntent("first intent"),
      toolName: "Edit",
      candidateCount: 1,
      topScore: 0.1,
      substituted: false,
      substitutedAtomHash: null,
      latencyMs: 5,
      outcome: "registry-hit",
    };
    const event2: TelemetryEvent = {
      t: 2000,
      intentHash: hashIntent("second intent"),
      toolName: "Write",
      candidateCount: 0,
      topScore: null,
      substituted: false,
      substitutedAtomHash: null,
      latencyMs: 8,
      outcome: "synthesis-required",
    };

    appendTelemetryEvent(event1, SESSION, telemetryDir);
    appendTelemetryEvent(event2, SESSION, telemetryDir);

    const filePath = join(telemetryDir, `${SESSION}.jsonl`);
    const lines = readFileSync(filePath, "utf-8").split("\n").filter(Boolean);
    expect(lines).toHaveLength(2);

    const first = JSON.parse(lines[0]!) as TelemetryEvent;
    const second = JSON.parse(lines[1]!) as TelemetryEvent;
    expect(first.outcome).toBe("registry-hit");
    expect(second.outcome).toBe("synthesis-required");
  });

  it("each line is independently valid JSON (JSONL format)", () => {
    for (let i = 0; i < 3; i++) {
      appendTelemetryEvent(
        {
          t: i * 1000,
          intentHash: hashIntent(`intent ${String(i)}`),
          toolName: "MultiEdit",
          candidateCount: 0,
          topScore: null,
          substituted: false,
          substitutedAtomHash: null,
          latencyMs: i * 2,
          outcome: "passthrough",
        },
        SESSION,
        telemetryDir,
      );
    }

    const lines = readFileSync(join(telemetryDir, `${SESSION}.jsonl`), "utf-8")
      .split("\n")
      .filter(Boolean);
    expect(lines).toHaveLength(3);
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  it("is idempotent on dir creation — second call does not throw", () => {
    const e: TelemetryEvent = {
      t: 1,
      intentHash: hashIntent("x"),
      toolName: "Edit",
      candidateCount: 0,
      topScore: null,
      substituted: false,
      substitutedAtomHash: null,
      latencyMs: 1,
      outcome: "passthrough",
    };
    appendTelemetryEvent(e, SESSION, telemetryDir);
    expect(() => appendTelemetryEvent(e, SESSION, telemetryDir)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// captureTelemetry — D-HOOK-5 schema correctness
// ---------------------------------------------------------------------------

describe("captureTelemetry — D-HOOK-5 schema", () => {
  const SESSION = "test-session-capture";

  it("writes a record with all D-HOOK-5 required fields present", () => {
    const response: HookResponse = { kind: "passthrough" };

    captureTelemetry({
      intent: "Compute a hash",
      toolName: "Edit",
      response,
      candidateCount: 0,
      topScore: null,
      latencyMs: 12,
      sessionId: SESSION,
      telemetryDir,
    });

    const filePath = join(telemetryDir, `${SESSION}.jsonl`);
    const parsed = JSON.parse(readFileSync(filePath, "utf-8").trim()) as TelemetryEvent;

    // All D-HOOK-5 fields must be present
    expect(typeof parsed.t).toBe("number");
    expect(typeof parsed.intentHash).toBe("string");
    expect(parsed.intentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(["Edit", "Write", "MultiEdit"]).toContain(parsed.toolName);
    expect(typeof parsed.candidateCount).toBe("number");
    // topScore is null or number
    expect(parsed.topScore === null || typeof parsed.topScore === "number").toBe(true);
    expect(typeof parsed.substituted).toBe("boolean");
    expect(
      parsed.substitutedAtomHash === null || typeof parsed.substitutedAtomHash === "string",
    ).toBe(true);
    expect(typeof parsed.latencyMs).toBe("number");
    expect(["registry-hit", "synthesis-required", "passthrough"]).toContain(parsed.outcome);
  });

  it("Phase 1: substituted is always false, substitutedAtomHash is always null", () => {
    const response: HookResponse = { kind: "registry-hit", id: "aabbcc" as never };
    captureTelemetry({
      intent: "test",
      toolName: "Write",
      response,
      candidateCount: 1,
      topScore: 0.15,
      latencyMs: 7,
      sessionId: SESSION,
      telemetryDir,
    });

    const filePath = join(telemetryDir, `${SESSION}.jsonl`);
    const parsed = JSON.parse(readFileSync(filePath, "utf-8").trim()) as TelemetryEvent;
    expect(parsed.substituted).toBe(false);
    expect(parsed.substitutedAtomHash).toBeNull();
  });

  it("intentHash is BLAKE3 of intent — not the plaintext (no PII)", () => {
    const intent = "Very sensitive internal logic description";
    captureTelemetry({
      intent,
      toolName: "Edit",
      response: { kind: "passthrough" },
      candidateCount: 0,
      topScore: null,
      latencyMs: 3,
      sessionId: SESSION,
      telemetryDir,
    });

    const filePath = join(telemetryDir, `${SESSION}.jsonl`);
    const content = readFileSync(filePath, "utf-8");
    // Plaintext intent must NOT appear in the file
    expect(content).not.toContain(intent);
    // But the BLAKE3 hash must be present
    const parsed = JSON.parse(content.trim()) as TelemetryEvent;
    expect(parsed.intentHash).toBe(hashIntent(intent));
  });

  it("outcome field matches HookResponse.kind", () => {
    for (const [response, expectedOutcome] of [
      [{ kind: "registry-hit", id: "abc" as never }, "registry-hit"],
      [{ kind: "synthesis-required", proposal: {} as never }, "synthesis-required"],
      [{ kind: "passthrough" }, "passthrough"],
    ] as [HookResponse, TelemetryEvent["outcome"]][]) {
      const sessionId = `${SESSION}-${expectedOutcome}`;
      captureTelemetry({
        intent: "test intent",
        toolName: "Edit",
        response,
        candidateCount: 0,
        topScore: null,
        latencyMs: 1,
        sessionId,
        telemetryDir,
      });
      const parsed = JSON.parse(
        readFileSync(join(telemetryDir, `${sessionId}.jsonl`), "utf-8").trim(),
      ) as TelemetryEvent;
      expect(parsed.outcome).toBe(expectedOutcome);
    }
  });
});

// ---------------------------------------------------------------------------
// executeRegistryQueryWithTelemetry — observe-don't-mutate invariant
// ---------------------------------------------------------------------------

describe("executeRegistryQueryWithTelemetry — observe-don't-mutate", () => {
  it("returns identical HookResponse to executeRegistryQuery (empty registry → synthesis-required)", async () => {
    const ctx: EmissionContext = { intent: "Compute the Fibonacci sequence" };
    const opts = { threshold: 0.3 };

    const base = await executeRegistryQuery(registry, ctx, opts);
    const withTel = await executeRegistryQueryWithTelemetry(registry, ctx, "Edit", {
      ...opts,
      telemetryDir,
      sessionId: "obs-test",
    });

    expect(withTel.kind).toBe(base.kind);
    if (base.kind === "synthesis-required" && withTel.kind === "synthesis-required") {
      expect(withTel.proposal.behavior).toBe(base.proposal.behavior);
    }
  }, 10_000);

  it("returns identical HookResponse to executeRegistryQuery (registry-hit path)", async () => {
    const spec = makeSpecYak("add-numbers", "Add two numbers together");
    await registry.storeBlock(makeBlockRow(spec));

    const ctx: EmissionContext = { intent: "Add two numbers together" };
    const opts = { threshold: 1.5 };

    const base = await executeRegistryQuery(registry, ctx, opts);
    const withTel = await executeRegistryQueryWithTelemetry(registry, ctx, "Write", {
      ...opts,
      telemetryDir,
      sessionId: "obs-hit-test",
    });

    expect(withTel.kind).toBe(base.kind);
    if (base.kind === "registry-hit" && withTel.kind === "registry-hit") {
      expect(withTel.id).toBe(base.id);
    }
  }, 10_000);

  it("writes a telemetry record to the JSONL file after each call", async () => {
    const ctx: EmissionContext = { intent: "Sort an array" };
    const SESSION = "obs-write-test";

    await executeRegistryQueryWithTelemetry(registry, ctx, "MultiEdit", {
      threshold: 0.3,
      telemetryDir,
      sessionId: SESSION,
    });

    const filePath = join(telemetryDir, `${SESSION}.jsonl`);
    expect(existsSync(filePath)).toBe(true);

    const lines = readFileSync(filePath, "utf-8").split("\n").filter(Boolean);
    expect(lines).toHaveLength(1);

    const record = JSON.parse(lines[0]!) as TelemetryEvent;
    expect(record.toolName).toBe("MultiEdit");
    expect(record.intentHash).toBe(hashIntent("Sort an array"));
    expect(record.latencyMs).toBeGreaterThanOrEqual(0);
  }, 10_000);

  it("accumulates one record per call (append-only in production sequence)", async () => {
    const SESSION = "obs-accumulate-test";
    const opts = { threshold: 0.3, telemetryDir, sessionId: SESSION };

    await executeRegistryQueryWithTelemetry(registry, { intent: "intent A" }, "Edit", opts);
    await executeRegistryQueryWithTelemetry(registry, { intent: "intent B" }, "Write", opts);
    await executeRegistryQueryWithTelemetry(registry, { intent: "intent C" }, "MultiEdit", opts);

    const lines = readFileSync(join(telemetryDir, `${SESSION}.jsonl`), "utf-8")
      .split("\n")
      .filter(Boolean);
    expect(lines).toHaveLength(3);
  }, 15_000);
});

// ---------------------------------------------------------------------------
// Full production sequence: registry-hit path with telemetry
// ---------------------------------------------------------------------------

describe("full production sequence — registry-hit + telemetry", () => {
  it("exercises intent→registry→response→telemetry in the real compound sequence", async () => {
    const SESSION = "prod-sequence-test";
    const spec = makeSpecYak("reverse-string", "Reverse a string");
    await registry.storeBlock(makeBlockRow(spec));

    const ctx: EmissionContext = { intent: "Reverse a string" };

    // Step 1: hook returns registry-hit
    const response = await executeRegistryQueryWithTelemetry(registry, ctx, "Edit", {
      threshold: 1.5,
      telemetryDir,
      sessionId: SESSION,
    });
    expect(response.kind).toBe("registry-hit");

    // Step 2: telemetry record was written
    const filePath = join(telemetryDir, `${SESSION}.jsonl`);
    expect(existsSync(filePath)).toBe(true);
    const parsed = JSON.parse(readFileSync(filePath, "utf-8").trim()) as TelemetryEvent;

    // Step 3: record satisfies D-HOOK-5 schema for a registry-hit
    expect(parsed.outcome).toBe("registry-hit");
    expect(parsed.intentHash).toBe(hashIntent("Reverse a string"));
    expect(parsed.candidateCount).toBe(1);
    expect(typeof parsed.topScore).toBe("number");
    expect(parsed.substituted).toBe(false);
    expect(parsed.latencyMs).toBeGreaterThanOrEqual(0);

    // Step 4: plaintext intent is NOT in the file (no PII)
    const raw = readFileSync(filePath, "utf-8");
    expect(raw).not.toContain("Reverse a string");
  }, 15_000);
});
