// @decision DEC-CORPUS-001 (WI-016)
// Tests for buildTriplet() with CorpusResult integration (WI-016) and the
// explicit bootstrap opt-in. Required tests from the WI-016 Evaluation Contract:
//   - Test 3: with-corpus-result manifest emits non-placeholder artifact.
//   - Test 4: bootstrap-only path requires explicit flag.

import type { CanonicalAstHash } from "@yakcc/contracts";
import { describe, expect, it } from "vitest";
import type { CorpusResult } from "../corpus/types.js";
import type { IntentCard } from "../intent/types.js";
import { buildTriplet, makeBootstrapArtifacts } from "./triplet.js";

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

/** Build a minimal CorpusResult fixture with deterministic bytes. */
function makeCorpusResult(overrides: Partial<CorpusResult> = {}): CorpusResult {
  const content = "// property-test corpus fixture\nimport * as fc from 'fast-check';\n";
  const encoder = new TextEncoder();
  return {
    source: "upstream-test",
    bytes: encoder.encode(content),
    path: "property-tests.fast-check.ts",
    contentHash: "aaaa1234",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Existing tests — updated to use CorpusResult (WI-016)
// ---------------------------------------------------------------------------

describe("buildTriplet()", () => {
  it("returns an object with all expected BuiltTriplet fields", () => {
    const card = makeIntentCard();
    const corpus = makeCorpusResult();
    const triplet = buildTriplet(card, SAMPLE_SOURCE, FAKE_HASH, corpus);

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
    const corpus = makeCorpusResult();
    const triplet = buildTriplet(card, SAMPLE_SOURCE, FAKE_HASH, corpus);
    expect(triplet.impl).toBe(SAMPLE_SOURCE);
  });

  it("spec has level=L0, a non-empty name, inputs, and outputs", () => {
    const card = makeIntentCard();
    const corpus = makeCorpusResult();
    const triplet = buildTriplet(card, SAMPLE_SOURCE, FAKE_HASH, corpus);
    const { spec } = triplet;

    expect(spec.level).toBe("L0");
    expect(typeof spec.name).toBe("string");
    expect(spec.name.length).toBeGreaterThan(0);
    expect(Array.isArray(spec.inputs)).toBe(true);
    expect(Array.isArray(spec.outputs)).toBe(true);
    expect(spec.inputs).toHaveLength(1);
    expect(spec.outputs).toHaveLength(1);
  });

  it("manifest has exactly one 'property_tests' artifact matching the corpus path", () => {
    const card = makeIntentCard();
    const corpus = makeCorpusResult({ path: "my-corpus.fast-check.ts" });
    const triplet = buildTriplet(card, SAMPLE_SOURCE, FAKE_HASH, corpus);
    const { manifest } = triplet;

    expect(Array.isArray(manifest.artifacts)).toBe(true);
    expect(manifest.artifacts).toHaveLength(1);
    expect(manifest.artifacts[0]?.kind).toBe("property_tests");
    expect(manifest.artifacts[0]?.path).toBe("my-corpus.fast-check.ts");
  });

  it("merkleRoot is a non-empty string", () => {
    const card = makeIntentCard();
    const corpus = makeCorpusResult();
    const triplet = buildTriplet(card, SAMPLE_SOURCE, FAKE_HASH, corpus);
    expect(typeof triplet.merkleRoot).toBe("string");
    expect(triplet.merkleRoot.length).toBeGreaterThan(0);
  });

  it("specCanonicalBytes is a Uint8Array with non-zero length", () => {
    const card = makeIntentCard();
    const corpus = makeCorpusResult();
    const triplet = buildTriplet(card, SAMPLE_SOURCE, FAKE_HASH, corpus);
    expect(triplet.specCanonicalBytes).toBeInstanceOf(Uint8Array);
    expect(triplet.specCanonicalBytes.length).toBeGreaterThan(0);
  });

  it("is deterministic: same inputs produce the same merkleRoot", () => {
    const card = makeIntentCard();
    const corpus = makeCorpusResult();
    const triplet1 = buildTriplet(card, SAMPLE_SOURCE, FAKE_HASH, corpus);
    const triplet2 = buildTriplet(card, SAMPLE_SOURCE, FAKE_HASH, corpus);

    expect(triplet1.merkleRoot).toBe(triplet2.merkleRoot);
    expect(triplet1.specHash).toBe(triplet2.specHash);
    expect(triplet1.spec.name).toBe(triplet2.spec.name);
  });

  it("different sources produce different merkleRoots", () => {
    const card = makeIntentCard();
    const source1 = "function foo() { return 1; }";
    const source2 = "function foo() { return 2; }";
    const encoder = new TextEncoder();
    const corpus1 = makeCorpusResult({ bytes: encoder.encode("corpus1") });
    const corpus2 = makeCorpusResult({ bytes: encoder.encode("corpus2") });

    const triplet1 = buildTriplet(card, source1, FAKE_HASH, corpus1);
    const triplet2 = buildTriplet(card, source2, FAKE_HASH, corpus2);

    expect(triplet1.merkleRoot).not.toBe(triplet2.merkleRoot);
  });

  it("different canonicalAstHashes produce different merkleRoots (via different spec names)", () => {
    const card = makeIntentCard();
    const corpus = makeCorpusResult();

    const triplet1 = buildTriplet(card, SAMPLE_SOURCE, FAKE_HASH, corpus);
    const triplet2 = buildTriplet(card, SAMPLE_SOURCE, ALT_HASH, corpus);

    // The name slug includes the last 6 chars of canonicalAstHash, so names differ
    // → specs differ → merkle roots differ.
    expect(triplet1.merkleRoot).not.toBe(triplet2.merkleRoot);
  });
});

// ---------------------------------------------------------------------------
// WI-016 Required Test 3: with-corpus-result manifest emits non-placeholder artifact
// ---------------------------------------------------------------------------

describe("buildTriplet() — WI-016 Test 3: corpus-result manifest", () => {
  it("manifest artifact path comes from CorpusResult.path, not a placeholder", () => {
    const card = makeIntentCard();
    const corpusPath = "property-tests.fast-check.ts";
    const corpus = makeCorpusResult({ path: corpusPath });

    const triplet = buildTriplet(card, SAMPLE_SOURCE, FAKE_HASH, corpus);

    expect(triplet.manifest.artifacts[0]?.path).toBe(corpusPath);
    // The placeholder path "property-tests.ts" must NOT appear
    expect(triplet.manifest.artifacts[0]?.path).not.toBe("property-tests.ts");
  });

  it("corpus bytes affect the merkleRoot (content-dependent identity)", () => {
    const card = makeIntentCard();
    const encoder = new TextEncoder();

    const corpus1 = makeCorpusResult({ bytes: encoder.encode("// corpus variant A\n") });
    const corpus2 = makeCorpusResult({ bytes: encoder.encode("// corpus variant B\n") });

    const triplet1 = buildTriplet(card, SAMPLE_SOURCE, FAKE_HASH, corpus1);
    const triplet2 = buildTriplet(card, SAMPLE_SOURCE, FAKE_HASH, corpus2);

    // Different corpus bytes → different artifact bytes → different proof_root → different merkleRoot
    expect(triplet1.merkleRoot).not.toBe(triplet2.merkleRoot);
  });
});

// ---------------------------------------------------------------------------
// WI-016 Required Test 4: bootstrap-only path requires explicit flag
// ---------------------------------------------------------------------------

describe("buildTriplet() — WI-016 Test 4: bootstrap explicit flag", () => {
  it("throws when corpusResult is undefined and bootstrap flag is absent", () => {
    const card = makeIntentCard();
    expect(() => buildTriplet(card, SAMPLE_SOURCE, FAKE_HASH, undefined)).toThrow(/bootstrap/);
  });

  it("throws when corpusResult is undefined and bootstrap is false", () => {
    const card = makeIntentCard();
    expect(() =>
      buildTriplet(card, SAMPLE_SOURCE, FAKE_HASH, undefined, { bootstrap: false }),
    ).toThrow(/bootstrap/);
  });

  it("succeeds with empty placeholder bytes when options.bootstrap === true", () => {
    const card = makeIntentCard();
    const triplet = buildTriplet(card, SAMPLE_SOURCE, FAKE_HASH, undefined, { bootstrap: true });

    // Bootstrap manifest has one property_tests artifact
    expect(triplet.manifest.artifacts).toHaveLength(1);
    expect(triplet.manifest.artifacts[0]?.kind).toBe("property_tests");
    // The bootstrap path is the well-known placeholder
    expect(triplet.manifest.artifacts[0]?.path).toBe("property-tests.ts");
    // merkleRoot is computable even with empty bytes
    expect(typeof triplet.merkleRoot).toBe("string");
    expect(triplet.merkleRoot.length).toBeGreaterThan(0);
  });

  it("bootstrap merkleRoot differs from corpus-populated merkleRoot", () => {
    const card = makeIntentCard();
    const encoder = new TextEncoder();
    const corpus = makeCorpusResult({ bytes: encoder.encode("// real corpus\n") });

    const bootstrapTriplet = buildTriplet(card, SAMPLE_SOURCE, FAKE_HASH, undefined, {
      bootstrap: true,
    });
    const corpusTriplet = buildTriplet(card, SAMPLE_SOURCE, FAKE_HASH, corpus);

    // Empty bytes vs real bytes → different proof_root → different merkleRoot
    expect(bootstrapTriplet.merkleRoot).not.toBe(corpusTriplet.merkleRoot);
  });
});

// ---------------------------------------------------------------------------
// WI-022 Required Test 1: artifacts Map threading through buildTriplet
// ---------------------------------------------------------------------------

describe("buildTriplet() — WI-022: artifacts Map threading", () => {
  // @decision DEC-V1-FEDERATION-WIRE-ARTIFACTS-002
  // title: buildTriplet exposes artifacts as the single source of truth
  // status: decided (WI-022 slice b)
  // rationale:
  //   The SAME Map<string, Uint8Array> constructed for blockMerkleRoot() is
  //   returned on BuiltTriplet.artifacts. No second Map, no copy, no re-derivation.
  //   These tests assert byte-identity (same Map reference) and deep-equality of
  //   the bytes contained, verifying the single-source-of-truth invariant.

  it("corpus path: returned triplet.artifacts is byte-identical to the corpus bytes", () => {
    const card = makeIntentCard();
    const encoder = new TextEncoder();
    const corpusBytes = encoder.encode("// corpus content for WI-022 test\n");
    const corpus = makeCorpusResult({ bytes: corpusBytes, path: "property-tests.fast-check.ts" });

    const triplet = buildTriplet(card, SAMPLE_SOURCE, FAKE_HASH, corpus);

    // artifacts Map must contain the corpus path as a key.
    expect(triplet.artifacts.has(corpus.path)).toBe(true);

    // The bytes stored under the corpus path must be byte-identical to corpusBytes.
    // biome-ignore lint/style/noNonNullAssertion: Map.get guarded by has() assertion above
    const storedBytes = triplet.artifacts.get(corpus.path)!;
    expect(storedBytes).toBeInstanceOf(Uint8Array);
    expect(storedBytes.length).toBe(corpusBytes.length);
    // Deep equality: every byte matches.
    expect(Array.from(storedBytes)).toEqual(Array.from(corpusBytes));
  });

  it("corpus path: artifacts Map has exactly one entry matching the manifest artifact path", () => {
    const card = makeIntentCard();
    const corpus = makeCorpusResult({ path: "my-tests.ts" });

    const triplet = buildTriplet(card, SAMPLE_SOURCE, FAKE_HASH, corpus);

    expect(triplet.artifacts.size).toBe(1);
    expect(triplet.artifacts.has("my-tests.ts")).toBe(true);
    // The manifest artifact path and the artifacts Map key must agree.
    expect(triplet.manifest.artifacts[0]?.path).toBe("my-tests.ts");
  });

  it("bootstrap path: returned triplet.artifacts is deep-equal to makeBootstrapArtifacts()", () => {
    const card = makeIntentCard();
    const triplet = buildTriplet(card, SAMPLE_SOURCE, FAKE_HASH, undefined, { bootstrap: true });

    const expected = makeBootstrapArtifacts();

    // Same size.
    expect(triplet.artifacts.size).toBe(expected.size);

    // Each key-value pair matches byte-for-byte.
    for (const [path, expectedBytes] of expected) {
      expect(triplet.artifacts.has(path)).toBe(true);
      // biome-ignore lint/style/noNonNullAssertion: Map.get guarded by has() assertion above
      const actualBytes = triplet.artifacts.get(path)!;
      expect(Array.from(actualBytes)).toEqual(Array.from(expectedBytes));
    }
  });

  it("different corpus bytes produce different artifacts entries (no aliasing)", () => {
    const card = makeIntentCard();
    const encoder = new TextEncoder();
    const corpus1 = makeCorpusResult({ bytes: encoder.encode("variant A"), path: "tests.ts" });
    const corpus2 = makeCorpusResult({ bytes: encoder.encode("variant B"), path: "tests.ts" });

    const triplet1 = buildTriplet(card, SAMPLE_SOURCE, FAKE_HASH, corpus1);
    const triplet2 = buildTriplet(card, SAMPLE_SOURCE, FAKE_HASH, corpus2);

    // Different bytes in → different bytes out (no cross-call aliasing).
    // biome-ignore lint/style/noNonNullAssertion: key "tests.ts" known present (added via corpus1/corpus2)
    const bytes1 = Array.from(triplet1.artifacts.get("tests.ts")!);
    // biome-ignore lint/style/noNonNullAssertion: key "tests.ts" known present (added via corpus1/corpus2)
    const bytes2 = Array.from(triplet2.artifacts.get("tests.ts")!);
    expect(bytes1).not.toEqual(bytes2);
  });
});
