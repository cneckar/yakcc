// SPDX-License-Identifier: MIT
/**
 * discovery-eval.test.ts — D5 evaluation harness.
 *
 * Suite 1: unit tests for discovery-eval-helpers (pure functions, always pass).
 * Suite 2: integration baseline — seeds a test registry with the offline BLAKE3
 *   provider (DEC-CI-OFFLINE-001), runs the inline stub corpus through
 *   findCandidatesByIntent, and verifies the harness machinery produces valid
 *   outputs. The offline provider does NOT produce semantically meaningful vectors
 *   (BLAKE3 hashes are not semantically aware), so M1–M5 threshold assertions
 *   (≥ 0.80 etc.) are NOT present here — those belong in the full corpus tests
 *   once WI-V3-DISCOVERY-D5-CORPUS-SEED and the v3 multi-dim system land.
 *
 * Measurement-first guardrail output:
 *   The integration suite writes baseline M1–M5 numbers to
 *   tmp/discovery-eval/baseline-single-vector-{date}.json when that directory
 *   exists (.gitignored runtime artifact). The decision summary lives at
 *   tmp/discovery-eval/measurement-first-decision.md (committed via .gitignore
 *   exception — see the root .gitignore).
 *
 * @decision DEC-V3-DISCOVERY-D5-HARNESS-001 (see discovery-eval-helpers.ts)
 * - Inline corpus shape: 8 seed-derived-style entries + 2 synthetic negative-space.
 *   Corpus uses exact-match behavior queries (same text stored and queried).
 *   Rationale: With the offline BLAKE3 provider, stored embeddings derive from
 *   canonicalizeText(spec) (full spec JSON), while query embeddings derive from
 *   behavior+params text. These are different strings so BLAKE3 produces different
 *   vectors — even exact-match behavior queries will not reliably surface the right
 *   block. The inline stub corpus therefore serves to exercise the harness machinery
 *   (types, metric computation, file output) rather than to produce a semantically
 *   meaningful measurement. The meaningful measurement requires the local embedding
 *   provider (DEC-EMBED-010) with paraphrase queries — see measurement-first-decision.md.
 * - Reliability-diagram emission: harness writes to tmp/discovery-eval/ if it exists.
 *   No test assertions depend on the file write succeeding.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type CanonicalAstHash,
  type EmbeddingProvider,
  type ProofManifest,
  type SpecYak,
  blockMerkleRoot,
  canonicalize,
  canonicalAstHash as deriveCanonicalAstHash,
  createOfflineEmbeddingProvider,
  specHash as deriveSpecHash,
} from "@yakcc/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { BlockTripletRow, CandidateMatch, Registry } from "./index.js";
import { openRegistry } from "./storage.js";
import {
  type BrierPerBandResult,
  type QueryEvalResult,
  computeBrierPerBand,
  computeHitRate,
  computeMRR,
  computePrecisionAt1,
  computeRecallAtK,
} from "./discovery-eval-helpers.js";

// ---------------------------------------------------------------------------
// Shared fixture factories (mirrors vector-search.test.ts patterns)
// ---------------------------------------------------------------------------

function makeSpecYak(name: string, behavior: string): SpecYak {
  return {
    name,
    inputs: [{ name: "input", type: "string" }],
    outputs: [{ name: "result", type: "string" }],
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
  const src = `export function impl(input: string): string { return input; /* ${spec.name} */ }`;
  const manifest: ProofManifest = {
    artifacts: [{ kind: "property_tests", path: "tests.ts" }],
  };
  const artifactBytes = new TextEncoder().encode("// stub tests");
  const artifacts = new Map<string, Uint8Array>([["tests.ts", artifactBytes]]);

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

// ---------------------------------------------------------------------------
// Inline stub corpus (8 seed-derived-style + 2 synthetic negative-space)
// Behaviors are unique enough to produce distinct BLAKE3 embeddings.
// ---------------------------------------------------------------------------

const STUB_ATOMS = [
  {
    name: "parse-int-list",
    behavior:
      "Parse a comma-separated list of integers enclosed in square brackets from a string.",
  },
  {
    name: "is-ascii-digit",
    behavior: "Return true if a single character is an ASCII decimal digit 0 through 9.",
  },
  {
    name: "is-bracket-char",
    behavior: "Return true if a character is an opening or closing square bracket.",
  },
  {
    name: "skip-whitespace",
    behavior: "Advance a string position past any leading whitespace characters.",
  },
  {
    name: "parse-nat-int",
    behavior:
      "Parse a non-negative integer starting at a position in a string, returning its value and the new position.",
  },
  {
    name: "is-eof",
    behavior:
      "Return true if a position index equals or exceeds the string length, indicating end of input.",
  },
  {
    name: "peek-character",
    behavior: "Return the character at the current position without advancing the position.",
  },
  {
    name: "validate-ascii",
    behavior: "Throw RangeError if a string contains any character whose code point exceeds 127.",
  },
] as const;

// Synthetic negative-space entries (no matching atom should be surfaced).
const NEGATIVE_BEHAVIORS = [
  "Compute the Haversine distance in meters between two GPS coordinates.",
  "Clamp a number to a lower and upper bound returning the nearest bound if out of range.",
] as const;

// ---------------------------------------------------------------------------
// Suite 1 — Unit tests for helper functions
// These tests use hand-crafted QueryEvalResult[] and verify correctness of the
// metric computation logic independent of any registry.
// ---------------------------------------------------------------------------

describe("discovery-eval-helpers — unit tests", () => {
  const ROOT_A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const ROOT_B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const ROOT_C = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";

  // All correct: 3 results where top-1 matches expectedAtom with strong score.
  const allCorrectStrong: QueryEvalResult[] = [
    {
      entryId: "s1",
      expectedAtom: ROOT_A,
      acceptableAtoms: [],
      candidates: [
        { blockMerkleRoot: ROOT_A, combinedScore: 0.92 },
        { blockMerkleRoot: ROOT_B, combinedScore: 0.70 },
      ],
    },
    {
      entryId: "s2",
      expectedAtom: ROOT_B,
      acceptableAtoms: [],
      candidates: [
        { blockMerkleRoot: ROOT_B, combinedScore: 0.88 },
        { blockMerkleRoot: ROOT_A, combinedScore: 0.65 },
      ],
    },
    {
      entryId: "s3",
      expectedAtom: ROOT_C,
      acceptableAtoms: [],
      candidates: [
        { blockMerkleRoot: ROOT_C, combinedScore: 0.95 },
        { blockMerkleRoot: ROOT_A, combinedScore: 0.80 },
      ],
    },
  ];

  // Mixed: 2 correct (one via acceptableAtoms), 1 miss, 1 not-in-topK.
  const mixedResults: QueryEvalResult[] = [
    {
      entryId: "m1",
      expectedAtom: ROOT_A,
      acceptableAtoms: [],
      candidates: [
        { blockMerkleRoot: ROOT_A, combinedScore: 0.88 }, // correct (top-1)
        { blockMerkleRoot: ROOT_B, combinedScore: 0.70 },
      ],
    },
    {
      entryId: "m2",
      expectedAtom: ROOT_B,
      acceptableAtoms: [ROOT_C],
      candidates: [
        { blockMerkleRoot: ROOT_C, combinedScore: 0.75 }, // correct via acceptableAtoms (top-1)
        { blockMerkleRoot: ROOT_A, combinedScore: 0.60 },
      ],
    },
    {
      entryId: "m3",
      expectedAtom: ROOT_A,
      acceptableAtoms: [],
      candidates: [
        { blockMerkleRoot: ROOT_B, combinedScore: 0.52 }, // miss
        { blockMerkleRoot: ROOT_C, combinedScore: 0.48 },
      ],
    },
    {
      entryId: "m4",
      expectedAtom: ROOT_C,
      acceptableAtoms: [],
      candidates: [
        { blockMerkleRoot: ROOT_A, combinedScore: 0.45 }, // miss, below 0.50
        { blockMerkleRoot: ROOT_B, combinedScore: 0.40 }, // ROOT_C not in results
      ],
    },
  ];

  // One negative-space entry.
  const withNegativeSpace: QueryEvalResult[] = [
    {
      entryId: "pos1",
      expectedAtom: ROOT_A,
      acceptableAtoms: [],
      candidates: [{ blockMerkleRoot: ROOT_A, combinedScore: 0.90 }],
    },
    {
      entryId: "neg1",
      expectedAtom: null, // negative-space
      acceptableAtoms: [],
      candidates: [{ blockMerkleRoot: ROOT_B, combinedScore: 0.55 }],
    },
  ];

  describe("computeHitRate", () => {
    it("returns 1.0 for all strong-band correct results", () => {
      expect(computeHitRate(allCorrectStrong)).toBe(1.0);
    });

    it("excludes negative-space entries from denominator", () => {
      // 1 positive entry, top-1 score = 0.90 ≥ 0.50 → hit rate = 1.0
      expect(computeHitRate(withNegativeSpace)).toBe(1.0);
    });

    it("counts a miss when top-1 score < 0.50", () => {
      // mixedResults: m1 hits (0.88), m2 hits (0.75), m3 hits (0.52), m4 misses (0.45)
      // 3 hits / 4 total = 0.75
      expect(computeHitRate(mixedResults)).toBeCloseTo(0.75, 5);
    });

    it("returns 1.0 for empty corpus", () => {
      expect(computeHitRate([])).toBe(1.0);
    });
  });

  describe("computePrecisionAt1", () => {
    it("returns 1.0 when all top-1 candidates match expectedAtom", () => {
      expect(computePrecisionAt1(allCorrectStrong)).toBe(1.0);
    });

    it("counts acceptableAtoms as correct", () => {
      // m1: ROOT_A correct; m2: ROOT_C correct (alternate); m3: ROOT_B incorrect; m4: ROOT_A incorrect
      // 2/4 = 0.50
      expect(computePrecisionAt1(mixedResults)).toBeCloseTo(0.5, 5);
    });

    it("excludes negative-space entries from denominator", () => {
      // pos1: ROOT_A correct → 1/1 = 1.0 (neg1 is excluded)
      expect(computePrecisionAt1(withNegativeSpace)).toBe(1.0);
    });

    it("returns 1.0 for empty corpus", () => {
      expect(computePrecisionAt1([])).toBe(1.0);
    });
  });

  describe("computeRecallAtK", () => {
    it("returns 1.0 when all expectedAtoms appear in top-1 (k=1)", () => {
      expect(computeRecallAtK(allCorrectStrong, 1)).toBe(1.0);
    });

    it("counts a result recalled when expectedAtom appears beyond rank-1", () => {
      // m1: expectedAtom=ROOT_A at rank-0 → recalled.
      // m2: expectedAtom=ROOT_B; acceptableAtoms=[ROOT_C]; ROOT_C at rank-0 → recalled via alternate.
      // m3: expectedAtom=ROOT_A; candidates=[ROOT_B, ROOT_C] — not recalled.
      // m4: expectedAtom=ROOT_C; candidates=[ROOT_A, ROOT_B] — not recalled.
      // 2 recalled / 4 = 0.50
      expect(computeRecallAtK(mixedResults, 2)).toBeCloseTo(0.5, 5);
    });

    it("excludes negative-space entries", () => {
      expect(computeRecallAtK(withNegativeSpace, 10)).toBe(1.0);
    });

    it("returns 1.0 for empty corpus", () => {
      expect(computeRecallAtK([], 10)).toBe(1.0);
    });
  });

  describe("computeMRR", () => {
    it("returns 1.0 when all expectedAtoms are rank-1", () => {
      // All correct at rank-1 → reciprocal = 1.0 each → MRR = 1.0
      expect(computeMRR(allCorrectStrong)).toBe(1.0);
    });

    it("returns 0 contribution for queries where expectedAtom is absent", () => {
      // mixedResults: m1 rank-1 (1/1=1), m2 via alternate rank-1 (1/1=1, ROOT_C match),
      //   m3 ROOT_A not in candidates (0), m4 ROOT_C not in candidates (0)
      // sum = 1+1+0+0 = 2; MRR = 2/4 = 0.5
      expect(computeMRR(mixedResults)).toBeCloseTo(0.5, 5);
    });

    it("excludes negative-space entries", () => {
      // pos1 rank-1 = 1.0; neg1 excluded → MRR = 1.0
      expect(computeMRR(withNegativeSpace)).toBe(1.0);
    });

    it("returns 1.0 for empty corpus", () => {
      expect(computeMRR([])).toBe(1.0);
    });
  });

  describe("computeBrierPerBand", () => {
    it("computes strong-band brier from all-correct strong-score results", () => {
      // All 3 results in strong band (scores 0.92, 0.88, 0.95 all ≥ 0.85).
      // P_strong = 3/3 = 1.0; err_strong = (1.0 - 0.925)² = 0.005625
      const result = computeBrierPerBand(allCorrectStrong);
      expect(result.strong.N).toBe(3);
      expect(result.strong.correct).toBe(3);
      expect(result.strong.P).toBeCloseTo(1.0, 5);
      expect(result.strong.brier).toBeCloseTo(0.005625, 5);
    });

    it("reports N=0 and brier=0 for empty bands", () => {
      // allCorrectStrong has no confident/weak/poor-band entries.
      const result = computeBrierPerBand(allCorrectStrong);
      expect(result.confident.N).toBe(0);
      expect(result.confident.brier).toBe(0);
      expect(result.confident.P).toBeNull();
    });

    it("includes negative-space entries in band counts (they are always incorrect)", () => {
      // withNegativeSpace: pos1 in strong band (0.90), correct.
      //   neg1 in weak band (0.55), incorrect (expectedAtom=null).
      // strong: N=1, correct=1, P=1.0, brier=(1.0-0.925)²=0.005625
      // weak: N=1, correct=0, P=0.0, brier=(0.0-0.60)²=0.36
      const result = computeBrierPerBand(withNegativeSpace);
      expect(result.strong.N).toBe(1);
      expect(result.strong.correct).toBe(1);
      expect(result.weak.N).toBe(1);
      expect(result.weak.correct).toBe(0);
      expect(result.weak.P).toBeCloseTo(0.0, 5);
      expect(result.weak.brier).toBeCloseTo(0.36, 5);
    });

    it("handles no candidates gracefully (entry with no results)", () => {
      const noResults: QueryEvalResult[] = [
        { entryId: "empty", expectedAtom: ROOT_A, acceptableAtoms: [], candidates: [] },
      ];
      // No candidates → no band contributions.
      const result = computeBrierPerBand(noResults);
      expect(result.strong.N).toBe(0);
      expect(result.confident.N).toBe(0);
      expect(result.weak.N).toBe(0);
      expect(result.poor.N).toBe(0);
    });
  });
});

// ---------------------------------------------------------------------------
// Suite 2 — Integration baseline (offline BLAKE3 provider, stub corpus)
// ---------------------------------------------------------------------------

describe("discovery-eval integration — offline baseline", () => {
  let registry: Registry;

  // Map from atom name to stored BlockMerkleRoot (populated in beforeAll).
  const atomRoots = new Map<string, string>();

  beforeAll(async () => {
    registry = await openRegistry(":memory:", {
      embeddings: createOfflineEmbeddingProvider(),
    });

    // Store all stub atoms and record their BlockMerkleRoots.
    for (const atom of STUB_ATOMS) {
      const spec = makeSpecYak(atom.name, atom.behavior);
      const row = makeBlockRow(spec);
      await registry.storeBlock(row);
      atomRoots.set(atom.name, row.blockMerkleRoot);
    }
  });

  afterAll(async () => {
    await registry.close();
  });

  /**
   * Build QueryEvalResult[] by running all stub corpus entries through the
   * registry's findCandidatesByIntent.
   */
  async function runInlineEval(): Promise<QueryEvalResult[]> {
    const results: QueryEvalResult[] = [];

    // Positive entries: one query per stub atom.
    for (const atom of STUB_ATOMS) {
      const candidates = await registry.findCandidatesByIntent(
        { behavior: atom.behavior, inputs: [], outputs: [] },
        { k: 10 },
      );
      results.push({
        entryId: `stub-${atom.name}`,
        expectedAtom: atomRoots.get(atom.name) ?? null,
        acceptableAtoms: [],
        candidates: candidates.map((c: CandidateMatch) => ({
          blockMerkleRoot: c.block.blockMerkleRoot,
          combinedScore: 1 - c.cosineDistance,
        })),
      });
    }

    // Negative-space entries: behaviors that have no matching atom.
    for (const behavior of NEGATIVE_BEHAVIORS) {
      const candidates = await registry.findCandidatesByIntent(
        { behavior, inputs: [], outputs: [] },
        { k: 10 },
      );
      results.push({
        entryId: `stub-neg-${behavior.slice(0, 20).replace(/\W/g, "-")}`,
        expectedAtom: null,
        acceptableAtoms: [],
        candidates: candidates.map((c: CandidateMatch) => ({
          blockMerkleRoot: c.block.blockMerkleRoot,
          combinedScore: 1 - c.cosineDistance,
        })),
      });
    }

    return results;
  }

  it("harness runs without error and produces valid M1–M5 outputs", async () => {
    const results = await runInlineEval();

    // Structural sanity: results count = 8 stub atoms + 2 negative-space.
    expect(results.length).toBe(STUB_ATOMS.length + NEGATIVE_BEHAVIORS.length);

    const m1 = computeHitRate(results);
    const m2 = computePrecisionAt1(results);
    const m3 = computeRecallAtK(results, 10);
    const m4 = computeMRR(results);
    const m5 = computeBrierPerBand(results);

    // Structural assertions: all metric values are valid numbers in expected ranges.
    // No threshold assertions (≥ 0.80 etc.) — those require the semantic embedding
    // provider and full corpus (WI-V3-DISCOVERY-D5-CORPUS-SEED).
    expect(m1).toBeGreaterThanOrEqual(0);
    expect(m1).toBeLessThanOrEqual(1);
    expect(m2).toBeGreaterThanOrEqual(0);
    expect(m2).toBeLessThanOrEqual(1);
    expect(m3).toBeGreaterThanOrEqual(0);
    expect(m3).toBeLessThanOrEqual(1);
    expect(m4).toBeGreaterThanOrEqual(0);
    expect(m4).toBeLessThanOrEqual(1);

    // M5: all brier values must be ≥ 0 (squared error is non-negative).
    expect(m5.strong.brier).toBeGreaterThanOrEqual(0);
    expect(m5.confident.brier).toBeGreaterThanOrEqual(0);
    expect(m5.weak.brier).toBeGreaterThanOrEqual(0);
    expect(m5.poor.brier).toBeGreaterThanOrEqual(0);

    // Write baseline results to tmp/discovery-eval/ (gitignored runtime artifact).
    const baseline = {
      description:
        "Single-vector embedding baseline using offline BLAKE3 provider (DEC-CI-OFFLINE-001). " +
        "BLAKE3 vectors are not semantically meaningful; M1–M5 numbers reflect random similarity. " +
        "For semantically meaningful measurement, run with YAKCC_NETWORK_TESTS=1 and the local " +
        "Xenova/all-MiniLM-L6-v2 provider (DEC-EMBED-010).",
      provider: "yakcc/offline-blake3-stub",
      corpusSize: { positive: STUB_ATOMS.length, negativeSpace: NEGATIVE_BEHAVIORS.length },
      head_sha: process.env["GIT_COMMIT"] ?? "unknown",
      generated_at: new Date().toISOString(),
      m1_hit_rate: m1,
      m2_precision_at_1: m2,
      m3_recall_at_10: m3,
      m4_mrr: m4,
      m5_brier_per_band: m5,
    };

    try {
      const outDir = join(process.cwd(), "../../tmp/discovery-eval");
      mkdirSync(outDir, { recursive: true });
      const date = new Date().toISOString().slice(0, 10);
      writeFileSync(
        join(outDir, `baseline-single-vector-${date}.json`),
        JSON.stringify(baseline, null, 2),
      );
    } catch {
      // Non-fatal: tmp/ write failure does not fail the test.
    }
  });
});
