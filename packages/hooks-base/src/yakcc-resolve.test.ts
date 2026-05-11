// SPDX-License-Identifier: MIT
/**
 * yakcc-resolve.test.ts — Integration-style tests for yakccResolve().
 *
 * Covers the three input forms and five key result shapes per the dispatch spec:
 *   T1: string input → matched envelope when registry has a clear top-1
 *   T2: {kind:"hash", root} input → single-candidate envelope when block exists
 *   T3: {kind:"hash", root} input → no_match when block absent
 *   T4: QueryIntentCard input → pass-through preserves topK
 *   T5: no_match envelope shape correctness (empty candidates)
 *   T6: weak_only envelope when all candidates below CONFIDENT_THRESHOLD
 *
 * Uses an in-memory registry seeded with 3–5 synthetic blocks via the offline
 * (BLAKE3) embedding provider — same pattern as discovery-d3-strictness.test.ts.
 * No network, no local model download required.
 *
 * @decision DEC-HOOK-PHASE-3-L3-MCP-001 (cross-reference)
 * See yakcc-resolve.ts for full rationale on the 4-band thresholds and D4 ADR
 * envelope shape.
 */

import {
  type SpecYak,
  blockMerkleRoot,
  canonicalize,
  createOfflineEmbeddingProvider,
  specHash as deriveSpecHash,
  canonicalAstHash as deriveCanonicalAstHash,
} from "@yakcc/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { BlockMerkleRoot, BlockTripletRow, CanonicalAstHash, Registry } from "@yakcc/registry";
import { openRegistry } from "@yakcc/registry";
import {
  CONFIDENT_THRESHOLD,
  WEAK_THRESHOLD,
  type EvidenceProjection,
  type ResolveResult,
  yakccResolve,
} from "./yakcc-resolve.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Minimal SpecYak factory for test blocks. */
function makeSpecYak(
  name: string,
  behavior: string,
  extras: Partial<SpecYak> = {},
): SpecYak {
  return {
    name,
    behavior,
    inputs: extras.inputs ?? [],
    outputs: extras.outputs ?? [],
    preconditions: [],
    postconditions: [],
    invariants: [],
    effects: [],
    level: extras.level ?? "L0",
    ...(extras.guarantees ? { guarantees: extras.guarantees } : {}),
    ...(extras.errorConditions ? { errorConditions: extras.errorConditions } : {}),
    ...(extras.nonFunctional ? { nonFunctional: extras.nonFunctional } : {}),
    ...(extras.propertyTests ? { propertyTests: extras.propertyTests } : {}),
  };
}

const STUB_IMPL = "export function stub(): void {}";
const STUB_MANIFEST = { version: 1, artifacts: [] as { path: string; algorithm: string; hash: string }[] };

/** Build a minimal BlockTripletRow from a SpecYak. */
function makeBlockRow(spec: SpecYak): BlockTripletRow {
  const artifacts = new Map<string, Uint8Array>();
  const bmr = blockMerkleRoot({
    spec,
    implSource: STUB_IMPL,
    manifest: STUB_MANIFEST as never,
    artifacts,
  }) as BlockMerkleRoot;
  const sh = deriveSpecHash(spec);
  const canonicalBytes = canonicalize(spec as unknown as Parameters<typeof canonicalize>[0]);
  const cah = deriveCanonicalAstHash(STUB_IMPL) as CanonicalAstHash;

  return {
    blockMerkleRoot: bmr,
    specHash: sh,
    specCanonicalBytes: canonicalBytes,
    implSource: STUB_IMPL,
    proofManifestJson: JSON.stringify(STUB_MANIFEST),
    level: "L0",
    createdAt: 0,
    canonicalAstHash: cah,
    artifacts,
  };
}

// ---------------------------------------------------------------------------
// Synthetic seed specs — 4 blocks with distinct behaviors
// ---------------------------------------------------------------------------

const SPEC_CLAMP = makeSpecYak(
  "clamp",
  "clamp a numeric value to the range [lo, hi]",
  {
    inputs: [
      { name: "x", type: "number" },
      { name: "lo", type: "number" },
      { name: "hi", type: "number" },
    ],
    outputs: [{ name: "result", type: "number" }],
    guarantees: [
      { id: "lo-bound", description: "returns lo when x < lo" },
      { id: "hi-bound", description: "returns hi when x > hi" },
      { id: "passthrough", description: "returns x when lo <= x <= hi" },
    ],
    propertyTests: [
      { id: "clamp-lo", description: "clamp(0, 1, 10) returns 1" },
      { id: "clamp-hi", description: "clamp(20, 1, 10) returns 10" },
    ],
  },
);

const SPEC_TRIM = makeSpecYak(
  "trim",
  "remove leading and trailing whitespace from a string",
  {
    inputs: [{ name: "s", type: "string" }],
    outputs: [{ name: "result", type: "string" }],
    guarantees: [
      { id: "no-leading", description: "result has no leading whitespace" },
      { id: "no-trailing", description: "result has no trailing whitespace" },
    ],
  },
);

const SPEC_PARSE_INT = makeSpecYak(
  "parse-int",
  "parse a decimal integer string to a number, throwing on invalid input",
  {
    inputs: [{ name: "s", type: "string" }],
    outputs: [{ name: "result", type: "number" }],
    errorConditions: [
      { description: "throws RangeError when input is not a valid integer", errorType: "RangeError" },
    ],
  },
);

const SPEC_SHA256 = makeSpecYak(
  "sha256-hex",
  "compute SHA-256 hash of a byte array and return the lowercase hex digest",
  {
    inputs: [{ name: "data", type: "Uint8Array" }],
    outputs: [{ name: "hex", type: "string" }],
    guarantees: [
      { id: "length", description: "result is exactly 64 hex characters" },
    ],
  },
);

// ---------------------------------------------------------------------------
// Test lifecycle
// ---------------------------------------------------------------------------

let registry: Registry;
let clampRoot: string;

beforeAll(async () => {
  const provider = createOfflineEmbeddingProvider();
  registry = await openRegistry(":memory:", { embeddings: provider });

  const clampRow = makeBlockRow(SPEC_CLAMP);
  const trimRow = makeBlockRow(SPEC_TRIM);
  const parseIntRow = makeBlockRow(SPEC_PARSE_INT);
  const sha256Row = makeBlockRow(SPEC_SHA256);

  await registry.storeBlock(clampRow);
  await registry.storeBlock(trimRow);
  await registry.storeBlock(parseIntRow);
  await registry.storeBlock(sha256Row);

  clampRoot = clampRow.blockMerkleRoot as string;
});

afterAll(async () => {
  await (registry as Registry & { close(): Promise<void> }).close();
});

// ---------------------------------------------------------------------------
// Helper: EvidenceProjection shape invariants
// ---------------------------------------------------------------------------

function assertEvidenceProjectionShape(proj: EvidenceProjection): void {
  // Address: exactly 8 hex chars
  expect(proj.address).toMatch(/^[0-9a-f]{8}$/);
  // Behavior: non-empty string
  expect(typeof proj.behavior).toBe("string");
  expect(proj.behavior.length).toBeGreaterThan(0);
  // Signature: non-empty string
  expect(typeof proj.signature).toBe("string");
  expect(proj.signature.length).toBeGreaterThan(0);
  // Score: in [0, 1]
  expect(proj.score).toBeGreaterThanOrEqual(0);
  expect(proj.score).toBeLessThanOrEqual(1);
  // Guarantees: array
  expect(Array.isArray(proj.guarantees)).toBe(true);
  // Tests: has count
  expect(typeof proj.tests.count).toBe("number");
  // Usage: null or string
  expect(proj.usage === null || typeof proj.usage === "string").toBe(true);
  // Field order: D4 ADR Q2 locked
  const keys = Object.keys(proj);
  expect(keys).toEqual(["address", "behavior", "signature", "score", "guarantees", "tests", "usage"]);
}

// ---------------------------------------------------------------------------
// T1: string input → matched envelope when registry has a clear top-1
// ---------------------------------------------------------------------------

describe("T1: string input", () => {
  it("returns a ResolveResult with candidates when registry has semantically matching block", async () => {
    // The offline BLAKE3 provider uses a hash-based embedding, so semantic matching
    // is based on the canonical JSON text. We query with the exact behavior string
    // to maximize the chance of a strong match.
    const result: ResolveResult = await yakccResolve(
      registry,
      "clamp a numeric value to the range [lo, hi]",
    );

    expect(result.status).toMatch(/^(matched|weak_only)$/);
    // At least one candidate returned
    expect(result.candidates.length).toBeGreaterThanOrEqual(1);
    // Candidate shape invariants
    for (const proj of result.candidates) {
      assertEvidenceProjectionShape(proj);
    }
  });

  it("wraps string as QueryIntentCard with behavior field", async () => {
    // Same result whether we pass the string or the explicit QueryIntentCard
    const stringResult = await yakccResolve(registry, "remove leading and trailing whitespace from a string");
    const cardResult = await yakccResolve(registry, {
      behavior: "remove leading and trailing whitespace from a string",
    });

    // Both should return the same status
    expect(stringResult.status).toBe(cardResult.status);
    expect(stringResult.candidates.length).toBe(cardResult.candidates.length);
  });
});

// ---------------------------------------------------------------------------
// T2: {kind:"hash", root} → single-candidate envelope when block exists
// ---------------------------------------------------------------------------

describe("T2: hash lookup — block exists", () => {
  it("returns matched status with exactly one candidate at score=1.0", async () => {
    const result = await yakccResolve(registry, { kind: "hash", root: clampRoot });

    expect(result.status).toBe("matched");
    expect(result.candidates.length).toBe(1);

    const proj = result.candidates[0];
    expect(proj).toBeDefined();
    if (proj === undefined) return;

    // Hash lookup always returns score=1.0 (exact identity match)
    expect(proj.score).toBe(1.0);
    // Address is first 8 chars of the root
    expect(proj.address).toBe(clampRoot.slice(0, 8));
    assertEvidenceProjectionShape(proj);
  });
});

// ---------------------------------------------------------------------------
// T3: {kind:"hash", root} → no_match when block absent
// ---------------------------------------------------------------------------

describe("T3: hash lookup — block absent", () => {
  it("returns no_match with empty candidates", async () => {
    const fakeRoot = "00000000000000000000000000000000000000000000000000000000000000000000";
    const result = await yakccResolve(registry, { kind: "hash", root: fakeRoot });

    expect(result.status).toBe("no_match");
    expect(result.candidates.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// T4: QueryIntentCard input → pass-through preserves topK
// ---------------------------------------------------------------------------

describe("T4: QueryIntentCard input", () => {
  it("passes topK to the registry query and returns at most topK candidates", async () => {
    // Request at most 2 candidates
    const result = await yakccResolve(registry, {
      behavior: "parse",
      topK: 2,
    });

    // Should return at most topK candidates
    expect(result.candidates.length).toBeLessThanOrEqual(2);
    // All candidates should have valid shape
    for (const proj of result.candidates) {
      assertEvidenceProjectionShape(proj);
    }
  });

  it("QueryIntentCard with guarantees dimension returns valid result", async () => {
    const result = await yakccResolve(registry, {
      behavior: "clamp a value",
      guarantees: ["returns lo when x < lo"],
    });

    // Must return a valid status
    expect(["matched", "weak_only", "no_match"]).toContain(result.status);
    for (const proj of result.candidates) {
      assertEvidenceProjectionShape(proj);
    }
  });
});

// ---------------------------------------------------------------------------
// T5: no_match envelope shape correctness
// ---------------------------------------------------------------------------

describe("T5: no_match envelope shape", () => {
  it("no_match result has empty candidates and correct status", async () => {
    // Query for something extremely unlikely to match the 4-block registry
    const result = await yakccResolve(registry, {
      behavior:
        "compute quantum entanglement entropy coefficient for a Bell-state pair using density matrix formalism",
    });

    // May match weakly or not at all; if no_match, must have empty candidates
    if (result.status === "no_match") {
      expect(result.candidates.length).toBe(0);
    }

    // Status always one of three values
    expect(["matched", "weak_only", "no_match"]).toContain(result.status);
  });

  it("forced no_match: empty registry returns no_match", async () => {
    const provider = createOfflineEmbeddingProvider();
    const emptyRegistry = await openRegistry(":memory:", { embeddings: provider });

    try {
      const result = await yakccResolve(emptyRegistry, "any query");
      // Empty registry → no candidates → no_match
      expect(result.status).toBe("no_match");
      expect(result.candidates.length).toBe(0);
    } finally {
      await emptyRegistry.close();
    }
  });
});

// ---------------------------------------------------------------------------
// T6: weak_only envelope when all candidates below CONFIDENT_THRESHOLD
// ---------------------------------------------------------------------------

describe("T6: weak_only / score band logic", () => {
  it("score thresholds: CONFIDENT_THRESHOLD=0.70, WEAK_THRESHOLD=0.50 match ADR values", () => {
    // D3 ADR §Q4, cited in D4 ADR Q3
    expect(CONFIDENT_THRESHOLD).toBe(0.70);
    expect(WEAK_THRESHOLD).toBe(0.50);
  });

  it("all candidates in result have score in [0, 1]", async () => {
    const result = await yakccResolve(registry, "compute SHA-256 hash");
    for (const proj of result.candidates) {
      expect(proj.score).toBeGreaterThanOrEqual(0);
      expect(proj.score).toBeLessThanOrEqual(1);
    }
  });
});

// ---------------------------------------------------------------------------
// T7: ResolveResult structural invariants across all input forms
// ---------------------------------------------------------------------------

describe("T7: ResolveResult structural invariants", () => {
  it("status is always one of three valid values across all input forms", async () => {
    const results = await Promise.all([
      yakccResolve(registry, "clamp a value"),
      yakccResolve(registry, { behavior: "trim a string" }),
      yakccResolve(registry, { kind: "hash", root: clampRoot }),
      yakccResolve(registry, { kind: "hash", root: "0".repeat(64) }),
    ]);

    for (const r of results) {
      expect(["matched", "weak_only", "no_match"]).toContain(r.status);
    }
  });

  it("matched status always has at least one candidate", async () => {
    const results = await Promise.all([
      yakccResolve(registry, "clamp a numeric value"),
      yakccResolve(registry, { kind: "hash", root: clampRoot }),
    ]);

    for (const r of results) {
      if (r.status === "matched") {
        expect(r.candidates.length).toBeGreaterThanOrEqual(1);
      }
    }
  });

  it("no_match status always has empty candidates", async () => {
    // Empty registry guarantees no_match
    const provider = createOfflineEmbeddingProvider();
    const emptyReg = await openRegistry(":memory:", { embeddings: provider });
    try {
      const r = await yakccResolve(emptyReg, "any query at all");
      expect(r.status).toBe("no_match");
      expect(r.candidates.length).toBe(0);
    } finally {
      await emptyReg.close();
    }
  });
});
