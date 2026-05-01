import { describe, expect, it } from "vitest";
import type { CanonicalAstHash } from "@yakcc/contracts";
import type { IntentCard } from "../intent/types.js";
import { buildTriplet } from "./triplet.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FAKE_HASH =
  "abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890" as CanonicalAstHash;

const ALT_HASH =
  "1111111111111111111111111111111111111111111111111111111111111111" as CanonicalAstHash;

function makeIntentCard(overrides: Partial<IntentCard> = {}): IntentCard {
  return {
    schemaVersion: 1,
    behavior: "Parse a comma-separated list of integers and return them as an array",
    inputs: [{ name: "raw", typeHint: "string", description: "The raw CSV string" }],
    outputs: [{ name: "result", typeHint: "number[]", description: "Parsed integers" }],
    preconditions: ["raw is a non-empty string"],
    postconditions: ["result.length >= 0"],
    notes: ["Trailing commas are ignored"],
    modelVersion: "claude-3-5-haiku-20241022",
    promptVersion: "v1.0",
    sourceHash: "deadbeef",
    extractedAt: "2025-01-01T00:00:00.000Z",
    ...overrides,
  };
}

const SAMPLE_SOURCE = `function parseIntList(raw: string): number[] {
  return raw.split(",").map(Number).filter(Number.isFinite);
}`;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("buildTriplet()", () => {
  it("returns an object with all expected BuiltTriplet fields", () => {
    const card = makeIntentCard();
    const triplet = buildTriplet(card, SAMPLE_SOURCE, FAKE_HASH);

    // All fields present
    expect(triplet).toHaveProperty("spec");
    expect(triplet).toHaveProperty("specHash");
    expect(triplet).toHaveProperty("specCanonicalBytes");
    expect(triplet).toHaveProperty("impl");
    expect(triplet).toHaveProperty("manifest");
    expect(triplet).toHaveProperty("merkleRoot");
  });

  it("impl field equals the raw source string passed in", () => {
    const card = makeIntentCard();
    const triplet = buildTriplet(card, SAMPLE_SOURCE, FAKE_HASH);
    expect(triplet.impl).toBe(SAMPLE_SOURCE);
  });

  it("spec has level=L0, a non-empty name, inputs, and outputs", () => {
    const card = makeIntentCard();
    const triplet = buildTriplet(card, SAMPLE_SOURCE, FAKE_HASH);
    const { spec } = triplet;

    expect(spec.level).toBe("L0");
    expect(typeof spec.name).toBe("string");
    expect(spec.name.length).toBeGreaterThan(0);
    expect(Array.isArray(spec.inputs)).toBe(true);
    expect(Array.isArray(spec.outputs)).toBe(true);
    expect(spec.inputs).toHaveLength(1);
    expect(spec.outputs).toHaveLength(1);
  });

  it("manifest has exactly one 'property_tests' artifact (L0 bootstrap shape)", () => {
    const card = makeIntentCard();
    const triplet = buildTriplet(card, SAMPLE_SOURCE, FAKE_HASH);
    const { manifest } = triplet;

    expect(Array.isArray(manifest.artifacts)).toBe(true);
    expect(manifest.artifacts).toHaveLength(1);
    expect(manifest.artifacts[0]!.kind).toBe("property_tests");
    expect(typeof manifest.artifacts[0]!.path).toBe("string");
    expect(manifest.artifacts[0]!.path.length).toBeGreaterThan(0);
  });

  it("merkleRoot is a non-empty string", () => {
    const card = makeIntentCard();
    const triplet = buildTriplet(card, SAMPLE_SOURCE, FAKE_HASH);
    expect(typeof triplet.merkleRoot).toBe("string");
    expect(triplet.merkleRoot.length).toBeGreaterThan(0);
  });

  it("specCanonicalBytes is a Uint8Array with non-zero length", () => {
    const card = makeIntentCard();
    const triplet = buildTriplet(card, SAMPLE_SOURCE, FAKE_HASH);
    expect(triplet.specCanonicalBytes).toBeInstanceOf(Uint8Array);
    expect(triplet.specCanonicalBytes.length).toBeGreaterThan(0);
  });

  it("is deterministic: same inputs produce the same merkleRoot", () => {
    const card = makeIntentCard();
    const triplet1 = buildTriplet(card, SAMPLE_SOURCE, FAKE_HASH);
    const triplet2 = buildTriplet(card, SAMPLE_SOURCE, FAKE_HASH);

    expect(triplet1.merkleRoot).toBe(triplet2.merkleRoot);
    expect(triplet1.specHash).toBe(triplet2.specHash);
    expect(triplet1.spec.name).toBe(triplet2.spec.name);
  });

  it("different sources produce different merkleRoots", () => {
    const card = makeIntentCard();
    const source1 = "function foo() { return 1; }";
    const source2 = "function foo() { return 2; }";

    const triplet1 = buildTriplet(card, source1, FAKE_HASH);
    const triplet2 = buildTriplet(card, source2, FAKE_HASH);

    expect(triplet1.merkleRoot).not.toBe(triplet2.merkleRoot);
  });

  it("different canonicalAstHashes produce different merkleRoots (via different spec names)", () => {
    const card = makeIntentCard();

    const triplet1 = buildTriplet(card, SAMPLE_SOURCE, FAKE_HASH);
    const triplet2 = buildTriplet(card, SAMPLE_SOURCE, ALT_HASH);

    // The name slug includes the last 6 chars of canonicalAstHash, so names differ
    // → specs differ → merkle roots differ.
    expect(triplet1.merkleRoot).not.toBe(triplet2.merkleRoot);
  });
});
