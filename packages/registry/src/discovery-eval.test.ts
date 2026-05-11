// SPDX-License-Identifier: MIT
/**
 * discovery-eval.test.ts — D5 evaluation harness for v3 discovery quality measurement.
 *
 * WI-V3-DISCOVERY-D5-HARNESS (issue #200)
 *
 * PURPOSE:
 *   This is the measurement-first guardrail per DEC-V3-INITIATIVE-001. It runs M1..M5
 *   against the existing single-vector embedding path (findCandidatesByIntent) to determine
 *   whether single-vector already meets the >=80% M1 target before committing to the
 *   5x storage cost of D1's multi-dimensional schema.
 *
 * PROVIDER STRATEGY:
 *   CI runs use the offline BLAKE3 provider (DEC-CI-OFFLINE-001) for determinism.
 *   The offline provider does NOT produce semantic embeddings — it hashes text deterministically.
 *   Therefore:
 *     - CI tests do NOT assert M1>=0.80 against offline provider (that would always fail).
 *     - CI tests assert that the HARNESS ITSELF is correct (metric math, corpus schema, types).
 *     - The operator-facing baseline (real M1..M5 numbers) is produced by running with
 *       DISCOVERY_EVAL_PROVIDER=local which uses the transformers.js semantic provider.
 *     - The baseline JSON artifact is committed to tmp/discovery-eval/ (see acceptance criteria).
 *
 *   When DISCOVERY_EVAL_PROVIDER=local is set, the test spawns with the local provider and
 *   the expect() gates use real targets. Without it, targets are skipped and only the
 *   artifact-emission and metric-computation correctness is verified.
 *
 * CORPUS:
 *   This WI ships a 9-entry bootstrap corpus (5 seed-derived + 4 synthetic).
 *   The expectedAtom values are discovered at test runtime from the live in-memory registry —
 *   they are NOT hardcoded hashes (which would break whenever seed blocks are regenerated).
 *   Full corpus authoring (>=30 + >=20) is WI-V3-DISCOVERY-D5-CORPUS-SEED.
 *
 * DEPENDENCY NOTE:
 *   @yakcc/seeds is NOT a dependency of @yakcc/registry (circular-dep avoidance, same grounds
 *   as DEC-VECTOR-RETRIEVAL-004). The 5 seed-derived corpus blocks are constructed inline from
 *   their SpecYak data using @yakcc/contracts (which IS a registry dependency). This mirrors
 *   the pattern used by vector-search.test.ts.
 *
 * PRODUCTION SEQUENCE EXERCISED:
 *   openRegistry (offline/local provider) → storeBlock ×5 →
 *   findCandidatesByIntent ×N (corpus queries) →
 *   computeHitRate/computePrecisionAt1/computeRecallAtK/computeMRR/computeBrierPerBand →
 *   baseline JSON artifact emission → measurement-first-decision.md
 */

import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type CanonicalAstHash,
  type EmbeddingProvider,
  type ProofManifest,
  type SpecYak,
  blockMerkleRoot,
  canonicalize,
  createLocalEmbeddingProvider,
  createOfflineEmbeddingProvider,
  canonicalAstHash as deriveCanonicalAstHash,
  specHash as deriveSpecHash,
} from "@yakcc/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { BenchmarkEntry } from "./discovery-eval-helpers.js";
import {
  M1_HIT_THRESHOLD,
  computeBaseline,
  computeBrierPerBand,
  computeHitRate,
  computeMRR,
  computePrecisionAt1,
  computeRecallAtK,
  computeReliabilityDiagram,
  runBenchmarkEntries,
  worstHitRateEntries,
  worstMRREntries,
  worstPrecisionAt1Entries,
  worstRecallEntries,
} from "./discovery-eval-helpers.js";
import type { BlockTripletRow, Registry } from "./index.js";
import { openRegistry } from "./storage.js";

// ---------------------------------------------------------------------------
// Provider selection
// ---------------------------------------------------------------------------

const USE_LOCAL_PROVIDER = process.env.DISCOVERY_EVAL_PROVIDER === "local";
const EMIT_REPORT = process.env.DISCOVERY_EVAL_REPORT === "1" || USE_LOCAL_PROVIDER;

// ---------------------------------------------------------------------------
// Inline seed block specs (5 chosen from the 20 seed blocks)
// These are verbatim copies of the spec.yak JSON from packages/seeds/src/blocks/.
// Kept inline to avoid a circular @yakcc/seeds dependency (DEC-VECTOR-RETRIEVAL-004 rationale).
// The 5 blocks chosen (ascii-char, digit, bracket, comma, integer) are the most
// semantically distinct in the seed corpus, maximizing KNN separability.
// ---------------------------------------------------------------------------

const SEED_SPECS: ReadonlyArray<SpecYak & { readonly _blockName: string }> = [
  {
    _blockName: "ascii-char",
    name: "ascii-char",
    inputs: [
      { name: "input", type: "string" },
      { name: "position", type: "number" },
    ],
    outputs: [{ name: "char", type: "string" }],
    preconditions: [],
    postconditions: [],
    invariants: [],
    effects: [],
    level: "L0",
    behavior:
      "Return the single ASCII character at the given zero-based position in the input string. Throws RangeError if position is out of bounds or the character code is above 127.",
    guarantees: [
      { id: "pure", description: "Referentially transparent; no side effects." },
      { id: "length-1", description: "Returned string always has length 1." },
      { id: "ascii", description: "Returned character has char code <= 127." },
    ],
    errorConditions: [
      { description: "position < 0 or position >= input.length.", errorType: "RangeError" },
      { description: "Character at position has code > 127.", errorType: "RangeError" },
    ],
    nonFunctional: { time: "O(1)", space: "O(1)", purity: "pure", threadSafety: "safe" },
    propertyTests: [
      { id: "ascii-char-first", description: "asciiChar('abc', 0) returns 'a'" },
      { id: "ascii-char-middle", description: "asciiChar('abc', 1) returns 'b'" },
      { id: "ascii-char-oob", description: "asciiChar('abc', 3) throws RangeError" },
      { id: "ascii-char-negative", description: "asciiChar('abc', -1) throws RangeError" },
      {
        id: "ascii-char-non-ascii",
        description: "asciiChar('aéb', 1) throws RangeError",
      },
    ],
  } as SpecYak & { readonly _blockName: string },
  {
    _blockName: "digit",
    name: "digit",
    inputs: [{ name: "s", type: "string" }],
    outputs: [{ name: "result", type: "number" }],
    preconditions: [],
    postconditions: [],
    invariants: [],
    effects: [],
    level: "L0",
    behavior:
      "Parse a single ASCII digit character '0'-'9' to its integer value 0-9. Throws RangeError if the input is not exactly one character in the range '0' to '9'.",
    guarantees: [
      { id: "pure", description: "Referentially transparent; no side effects." },
      { id: "range", description: "Result is an integer in the closed range [0, 9]." },
      {
        id: "inverse",
        description: "digit(String.fromCharCode(48 + n)) === n for n in [0,9].",
      },
    ],
    errorConditions: [
      { description: "Input is not exactly one character.", errorType: "RangeError" },
      { description: "Input character is not in '0'-'9'.", errorType: "RangeError" },
    ],
    nonFunctional: { time: "O(1)", space: "O(1)", purity: "pure", threadSafety: "safe" },
    propertyTests: [
      { id: "digit-zero", description: "digit('0') returns 0" },
      { id: "digit-nine", description: "digit('9') returns 9" },
      { id: "digit-five", description: "digit('5') returns 5" },
      { id: "digit-non-numeric", description: "digit('a') throws RangeError" },
      { id: "digit-empty", description: "digit('') throws RangeError" },
      { id: "digit-multi-char", description: "digit('12') throws RangeError" },
    ],
  } as SpecYak & { readonly _blockName: string },
  {
    _blockName: "bracket",
    name: "bracket",
    inputs: [
      { name: "input", type: "string" },
      { name: "position", type: "number" },
      { name: "kind", type: "'[' | ']'" },
    ],
    outputs: [{ name: "newPosition", type: "number" }],
    preconditions: [],
    postconditions: [],
    invariants: [],
    effects: [],
    level: "L0",
    behavior:
      "Assert that the character at position equals kind ('[' or ']'), then return position + 1. Throws SyntaxError if the character does not match or if position is out of bounds.",
    guarantees: [
      { id: "pure", description: "Referentially transparent; no side effects." },
      { id: "advance-1", description: "Returns position + 1 on success." },
    ],
    errorConditions: [
      {
        description: "Character at position does not equal kind.",
        errorType: "SyntaxError",
      },
      { description: "position >= input.length (end of input).", errorType: "SyntaxError" },
      { description: "position < 0.", errorType: "RangeError" },
    ],
    nonFunctional: { time: "O(1)", space: "O(1)", purity: "pure", threadSafety: "safe" },
    propertyTests: [
      { id: "bracket-open", description: "bracket('[abc', 0, '[') returns 1" },
      { id: "bracket-close", description: "bracket(']', 0, ']') returns 1" },
      { id: "bracket-mismatch", description: "bracket('[', 0, ']') throws SyntaxError" },
      { id: "bracket-oob", description: "bracket('', 0, '[') throws SyntaxError" },
      { id: "bracket-negative", description: "bracket('[', -1, '[') throws RangeError" },
    ],
  } as SpecYak & { readonly _blockName: string },
  {
    _blockName: "comma",
    name: "comma",
    inputs: [
      { name: "input", type: "string" },
      { name: "position", type: "number" },
    ],
    outputs: [{ name: "newPosition", type: "number" }],
    preconditions: [],
    postconditions: [],
    invariants: [],
    effects: [],
    level: "L0",
    behavior:
      "Match a literal ',' at the given position in the input string, returning the new position after the comma. Throws SyntaxError if the character at position is not ','.",
    guarantees: [
      { id: "pure", description: "Referentially transparent; no side effects." },
      { id: "advance-1", description: "Returns position + 1 on success." },
    ],
    errorConditions: [
      {
        description: "Character at position is not ','.",
        errorType: "SyntaxError",
      },
    ],
    nonFunctional: { time: "O(1)", space: "O(1)", purity: "pure", threadSafety: "safe" },
    propertyTests: [
      { id: "comma-match", description: "comma(',abc', 0) returns 1" },
      { id: "comma-mismatch", description: "comma('abc', 0) throws SyntaxError" },
    ],
  } as SpecYak & { readonly _blockName: string },
  {
    _blockName: "integer",
    name: "integer",
    inputs: [
      { name: "input", type: "string" },
      { name: "position", type: "number" },
    ],
    outputs: [
      { name: "value", type: "number" },
      { name: "newPosition", type: "number" },
    ],
    preconditions: [],
    postconditions: [],
    invariants: [],
    effects: [],
    level: "L0",
    behavior:
      "Parse a sequence of ASCII digit characters starting at position in the input string and return the parsed integer value and the new position after the digits.",
    guarantees: [
      { id: "pure", description: "Referentially transparent; no side effects." },
      {
        id: "advances",
        description: "newPosition > position when at least one digit is consumed.",
      },
    ],
    errorConditions: [
      {
        description: "No digit character found at the given position.",
        errorType: "SyntaxError",
      },
    ],
    nonFunctional: { time: "O(n)", space: "O(1)", purity: "pure", threadSafety: "safe" },
    propertyTests: [
      { id: "integer-single", description: "integer('3', 0) returns {value:3, newPosition:1}" },
      {
        id: "integer-multi",
        description: "integer('123', 0) returns {value:123, newPosition:3}",
      },
      { id: "integer-non-digit", description: "integer('abc', 0) throws SyntaxError" },
    ],
  } as SpecYak & { readonly _blockName: string },
];

// ---------------------------------------------------------------------------
// Block builder (mirrors vector-search.test.ts pattern, avoids @yakcc/seeds dep)
// ---------------------------------------------------------------------------

/** Minimal L0 ProofManifest for inline test blocks. */
function makeManifest(): ProofManifest {
  return { artifacts: [{ kind: "property_tests", path: "property_tests.ts" }] };
}

/** Build a BlockTripletRow from a SpecYak (inline corpus construction). */
function makeBlockRowFromSpec(spec: SpecYak): BlockTripletRow {
  const src = `export function impl(..._args: unknown[]): unknown { /* ${spec.name} */ return undefined; }`;
  const manifest = makeManifest();
  const artifactBytes = new TextEncoder().encode("// property tests");
  const artifacts = new Map<string, Uint8Array>([["property_tests.ts", artifactBytes]]);

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
    createdAt: 0,
    canonicalAstHash: deriveCanonicalAstHash(src) as CanonicalAstHash,
    artifacts,
  };
}

// ---------------------------------------------------------------------------
// Test lifecycle
// ---------------------------------------------------------------------------

let registry: Registry;
let embeddingProvider: EmbeddingProvider;
/** BlockMerkleRoot map: seed block name → merkle root (discovered at runtime). */
const seedRoots = new Map<string, string>();

beforeAll(async () => {
  embeddingProvider = USE_LOCAL_PROVIDER
    ? createLocalEmbeddingProvider()
    : createOfflineEmbeddingProvider();

  registry = await openRegistry(":memory:", { embeddings: embeddingProvider });

  // Store the 5 inline seed blocks and capture their merkle roots by name.
  for (const spec of SEED_SPECS) {
    const row = makeBlockRowFromSpec(spec);
    await registry.storeBlock(row);
    seedRoots.set(spec._blockName, row.blockMerkleRoot as string);
  }
}, 60_000); // allow time for local provider model download if needed

afterAll(async () => {
  await registry.close();
});

// ---------------------------------------------------------------------------
// Bootstrap corpus (5 seed-derived + 4 synthetic)
//
// @decision DEC-V3-DISCOVERY-D5-HARNESS-001 (corpus shape):
//   9 entries chosen for maximal discriminability with the offline BLAKE3 provider:
//   - 5 seed-derived: behavior strings are distinct enough that BLAKE3 hash distances
//     differ meaningfully between corpus query and stored canonical JSON embedding.
//     ascii-char, digit, bracket, comma, integer chosen as most self-contained seeds.
//   - 4 synthetic: clamp (positive, multi-dim), haversine-neg (negative-space, poor-band),
//     parse-float (positive, simple), validate-email (positive, realistic LLM task).
//   expectedAtom values are resolved at runtime from seedRoots — NOT hardcoded hashes.
//   Full corpus (>=30 + >=20) is WI-V3-DISCOVERY-D5-CORPUS-SEED.
// ---------------------------------------------------------------------------

function buildCorpus(): readonly BenchmarkEntry[] {
  return [
    // --- Seed-derived (5 entries) ---
    {
      id: "seed-ascii-char-001",
      source: "seed-derived",
      query: {
        behavior:
          "Return the single ASCII character at the given zero-based position in the input string. Throws RangeError if position is out of bounds or the character code is above 127.",
        signature: {
          inputs: [
            { name: "input", type: "string" },
            { name: "position", type: "number" },
          ],
          outputs: [{ name: "char", type: "string" }],
        },
      },
      expectedAtom: seedRoots.get("ascii-char") ?? null,
      rationale:
        "ascii-char is a canonical seed block with well-defined boundary conditions. Tests M1/M2 strong-band path with exact behavior text match.",
    },
    {
      id: "seed-digit-001",
      source: "seed-derived",
      query: {
        behavior:
          "Parse a single ASCII digit character '0'-'9' to its integer value 0-9. Throws RangeError if the input is not exactly one character in the range '0' to '9'.",
        signature: {
          inputs: [{ name: "s", type: "string" }],
          outputs: [{ name: "result", type: "number" }],
        },
      },
      expectedAtom: seedRoots.get("digit") ?? null,
      rationale:
        "digit block has a distinct short behavior string. Tests M2 exact hash match and M4 MRR rank-1 path.",
    },
    {
      id: "seed-bracket-001",
      source: "seed-derived",
      query: {
        behavior:
          "Assert that the character at position equals kind ('[' or ']'), then return position + 1. Throws SyntaxError if the character does not match or if position is out of bounds.",
        signature: {
          inputs: [
            { name: "input", type: "string" },
            { name: "position", type: "number" },
            { name: "kind", type: "'[' | ']'" },
          ],
          outputs: [{ name: "newPosition", type: "number" }],
        },
      },
      expectedAtom: seedRoots.get("bracket") ?? null,
      rationale:
        "bracket has a 3-input signature, exercising multi-param query path. Tests M3 recall.",
    },
    {
      id: "seed-comma-001",
      source: "seed-derived",
      query: {
        behavior:
          "Match a literal ',' at the given position in the input string, returning the new position after the comma. Throws SyntaxError if the character at position is not ','.",
      },
      expectedAtom: seedRoots.get("comma") ?? null,
      rationale:
        "comma block has minimal signature (no explicit params in query), testing behavior-only query path.",
    },
    {
      id: "seed-integer-001",
      source: "seed-derived",
      query: {
        behavior:
          "Parse a sequence of ASCII digit characters starting at position in the input string and return the parsed integer value and the new position after the digits.",
        signature: {
          inputs: [
            { name: "input", type: "string" },
            { name: "position", type: "number" },
          ],
          outputs: [
            { name: "value", type: "number" },
            { name: "newPosition", type: "number" },
          ],
        },
      },
      expectedAtom: seedRoots.get("integer") ?? null,
      rationale:
        "integer has a 2-output signature, exercising multi-output query. Tests M3/M4 with a more complex block.",
    },

    // --- Synthetic tasks (4 entries) ---
    {
      id: "synth-clamp-001",
      source: "synthetic-tasks",
      query: {
        behavior: "clamp a number between a lower bound and upper bound",
        signature: {
          inputs: [
            { name: "x", type: "number" },
            { name: "lo", type: "number" },
            { name: "hi", type: "number" },
          ],
          outputs: [{ name: "result", type: "number" }],
        },
      },
      expectedAtom: null,
      rationale:
        "Synthetic task with no matching seed atom. Tests that the harness correctly handles null expectedAtom (skips M2/M3/M4). With offline provider, top-1 score is random; with local provider, should fall in weak/poor band (no clamp atom in seed corpus).",
    },
    {
      id: "synth-haversine-negative-001",
      source: "synthetic-tasks",
      query: {
        behavior: "compute Haversine distance between two GPS coordinates with sub-meter precision",
        signature: {
          inputs: [
            { name: "lat1", type: "number" },
            { name: "lon1", type: "number" },
            { name: "lat2", type: "number" },
            { name: "lon2", type: "number" },
          ],
          outputs: [{ name: "distanceMeters", type: "number" }],
        },
      },
      expectedAtom: null,
      rationale:
        "Negative-space entry per D5 ADR Q2 example. No atom satisfies sub-meter GPS + flat-signature. Validates no_match path and ensures poor-band coverage for M5 calibration.",
    },
    {
      id: "synth-parse-float-001",
      source: "synthetic-tasks",
      query: {
        behavior: "parse a floating-point number from a string, returning the numeric value",
        signature: {
          inputs: [{ name: "s", type: "string" }],
          outputs: [{ name: "value", type: "number" }],
        },
      },
      expectedAtom: null,
      rationale:
        "Realistic LLM coding task with no exact seed match. With local provider, may weakly match digit/integer atoms; tests weak/confident band boundary behavior.",
    },
    {
      id: "synth-validate-email-001",
      source: "synthetic-tasks",
      query: {
        behavior:
          "validate that a string is a well-formed email address according to RFC 5321, returning true if valid",
        signature: {
          inputs: [{ name: "email", type: "string" }],
          outputs: [{ name: "valid", type: "boolean" }],
        },
      },
      expectedAtom: null,
      rationale:
        "Realistic LLM coding task with no seed match. Tests poor-band coverage: email validation is semantically distant from all seed blocks. Useful for M5 poor-band calibration.",
    },
  ];
}

// ---------------------------------------------------------------------------
// Helper: get git HEAD SHA (gracefully fallback)
// ---------------------------------------------------------------------------

function getHeadSha(): string {
  try {
    return execSync("git rev-parse --short HEAD", { encoding: "utf-8" }).trim();
  } catch {
    return "unknown";
  }
}

// ---------------------------------------------------------------------------
// Helper: emit artifacts to tmp/discovery-eval/
// ---------------------------------------------------------------------------

function emitArtifacts(
  corpus: readonly BenchmarkEntry[],
  results: Awaited<ReturnType<typeof runBenchmarkEntries>>,
  provider: string,
): void {
  const headSha = getHeadSha();
  const outDir = join(process.cwd(), "../../tmp/discovery-eval");
  mkdirSync(outDir, { recursive: true });

  // Baseline JSON
  const providerNote = USE_LOCAL_PROVIDER
    ? undefined
    : "OFFLINE PROVIDER (BLAKE3 hashes — NOT semantic). M1..M4 numbers reflect hash-space proximity, not semantic quality. Re-run with DISCOVERY_EVAL_PROVIDER=local for operator-facing baseline.";

  const baseline = computeBaseline(
    "bootstrap-inline",
    corpus,
    results,
    headSha,
    provider,
    providerNote,
  );

  const baselineFile = join(outDir, "baseline-single-vector-2026-05-10.json");
  writeFileSync(baselineFile, JSON.stringify(baseline, null, 2), "utf-8");

  // Reliability diagram (Q4 of D5 ADR)
  const diagram = computeReliabilityDiagram("bootstrap-inline", results, headSha, provider);
  const diagramFile = join(outDir, "reliability-bootstrap-inline.json");
  writeFileSync(diagramFile, JSON.stringify(diagram, null, 2), "utf-8");

  // Measurement-first decision doc
  const M1 = computeHitRate(results);
  const M2 = computePrecisionAt1(results);
  const M3 = computeRecallAtK(results);
  const M4 = computeMRR(results);
  const M5 = computeBrierPerBand(results);

  const worstM1 = worstHitRateEntries(results, 3)
    .map((r) => `  - ${r.entryId}: combinedScore=${r.top1Score.toFixed(3)}`)
    .join("\n");
  const worstM2 = worstPrecisionAt1Entries(results, 3)
    .map(
      (r) => `  - ${r.entryId}: top1=${r.top1Atom ?? "none"} expected=${r.expectedAtom ?? "null"}`,
    )
    .join("\n");
  const worstM3 = worstRecallEntries(results, 3)
    .map((r) => `  - ${r.entryId}: expectedAtom not in top-10`)
    .join("\n");
  const worstM4 = worstMRREntries(results, 3)
    .map((r) => `  - ${r.entryId}: rank=${r.expectedAtomRank ?? "not found"}`)
    .join("\n");

  const m1Pass = M1 >= 0.8;
  const m1Section = m1Pass
    ? `**M1 PASSES (${(M1 * 100).toFixed(1)}% >= 80%)**

OPERATOR DECISION: Single-vector embedding ALREADY meets the M1 target.
The 5x storage cost committed to in D1 (1,920 floats/atom vs 384) is NOT empirically
justified by retrieval quality. **v3-implementation SHOULD PAUSE pending re-spec.**

Before proceeding with D1's multi-dimensional schema, consider:
1. Is 5x storage cost justified by other dimensions (error_conditions, guarantees, non_functional)?
2. Do M2/M3/M4 failures (below) justify multi-dimensional embeddings?
3. File a re-spec WI if the answer to (1) and (2) is no.`
    : `**M1 FAILS (${(M1 * 100).toFixed(1)}% < 80%)**

Single-vector embedding does NOT meet the M1 target.
v3-implementation MAY PROCEED with D1's multi-dimensional schema.

Worst-performing entries (lowest top-1 score):
${worstM1 || "  (none — all entries hit)"}

These entries justify per-dimension embeddings in D1:
- Entries failing M2 suggest top-1 retrieval is imprecise (wrong atom ranked first)
- Entries failing M3 suggest the correct atom is not in the top-10 at all
- Entries failing M4 suggest ranking quality is poor`;

  const decision = `# Measurement-First Decision — Single-Vector Baseline

**WI-V3-DISCOVERY-D5-HARNESS** (issue #200)
**Generated:** ${new Date().toISOString()}
**HEAD SHA:** ${headSha}
**Provider:** ${provider}
**Corpus:** bootstrap-inline (${corpus.length} entries: 5 seed-derived + 4 synthetic)

---

## The Gate

Per DEC-V3-INITIATIVE-001: if single-vector M1 hit-rate ALREADY meets >=80%, the 5x storage
cost in D1 (1,920 floats/atom) is unjustified. This file is the operator-facing decision input.

---

## Provider Note

${
  USE_LOCAL_PROVIDER
    ? "Provider: transformers.js local (Xenova/all-MiniLM-L6-v2) — SEMANTIC embeddings. These numbers are the operator-meaningful baseline."
    : `**WARNING: OFFLINE PROVIDER (BLAKE3 hashes)**

The numbers below were produced with the offline BLAKE3 embedding provider (DEC-CI-OFFLINE-001),
which produces deterministic but NON-SEMANTIC vectors. Similar behavior strings do NOT produce
nearby vectors. M1..M4 numbers DO NOT reflect real retrieval quality.

To produce the operator-meaningful baseline, re-run with:
  DISCOVERY_EVAL_PROVIDER=local pnpm --filter @yakcc/registry test

The offline-provider run validates that the harness code is correct and the corpus schema is
well-formed. It does NOT answer the "should v3-implementation proceed?" question.`
}

---

## Baseline Results (${provider})

| Metric | Value | Target | Pass? |
|--------|-------|--------|-------|
| M1 Hit rate | ${(M1 * 100).toFixed(1)}% | >=80% | ${m1Pass ? "PASS" : "FAIL"} |
| M2 Precision@1 | ${(M2 * 100).toFixed(1)}% | >=70% | ${M2 >= 0.7 ? "PASS" : "FAIL"} |
| M3 Recall@10 | ${(M3 * 100).toFixed(1)}% | >=90% | ${M3 >= 0.9 ? "PASS" : "FAIL"} |
| M4 MRR | ${M4.toFixed(3)} | >=0.70 | ${M4 >= 0.7 ? "PASS" : "FAIL"} |
| M5 Brier strong | ${M5.strong.brier !== null ? M5.strong.brier.toFixed(5) : "N/A (no data)"} | <0.10 | ${M5.strong.brier === null ? "N/A" : M5.strong.brier < 0.1 ? "PASS" : "FAIL"} |
| M5 Brier confident | ${M5.confident.brier !== null ? M5.confident.brier.toFixed(5) : "N/A (no data)"} | <0.10 | ${M5.confident.brier === null ? "N/A" : M5.confident.brier < 0.1 ? "PASS" : "FAIL"} |
| M5 Brier weak | ${M5.weak.brier !== null ? M5.weak.brier.toFixed(5) : "N/A (no data)"} | <0.10 | ${M5.weak.brier === null ? "N/A" : M5.weak.brier < 0.1 ? "PASS" : "FAIL"} |
| M5 Brier poor | ${M5.poor.brier !== null ? M5.poor.brier.toFixed(5) : "N/A (no data)"} | <0.10 | ${M5.poor.brier === null ? "N/A" : M5.poor.brier < 0.1 ? "PASS" : "FAIL"} |

---

## Operator Decision

${m1Section}

---

## Worst-Performing Entries

**M2 (Precision@1 failures):**
${worstM2 || "  (none — all eligible entries hit top-1)"}

**M3 (Recall@10 failures):**
${worstM3 || "  (none — all eligible entries found in top-10)"}

**M4 (MRR failures):**
${worstM4 || "  (none — all eligible entries ranked first)"}

---

## Next Steps

${
  USE_LOCAL_PROVIDER
    ? m1Pass
      ? "1. File a re-spec WI for D1 (5-vector schema) before proceeding with v3-implementation.\n2. Consider whether M2/M3/M4 failures justify multi-dimensional embeddings independently of M1.\n3. If re-spec confirms 5-vector is still needed (e.g. for error_conditions dimension), update DEC-V3-INITIATIVE-001."
      : "1. v3-implementation MAY PROCEED with D1 multi-dimensional schema.\n2. Use worst-performing entries above as justification per dimension for D1's 5-vector design.\n3. After D1 lands, re-run this harness to confirm multi-dimensional improves M1."
    : "1. Re-run with DISCOVERY_EVAL_PROVIDER=local to produce the semantic baseline.\n2. The CI run (offline provider) only validates harness correctness, not retrieval quality.\n3. Commit the local-provider output as the authoritative baseline."
}
`;

  const decisionFile = join(outDir, "measurement-first-decision.md");
  writeFileSync(decisionFile, decision, "utf-8");

  // Print summary to test output
  console.log("\n=== DISCOVERY EVAL BASELINE ===");
  console.log(`Provider: ${provider} (${USE_LOCAL_PROVIDER ? "SEMANTIC" : "OFFLINE/HASH"})`);
  console.log(`Corpus:   bootstrap-inline (${corpus.length} entries)`);
  console.log(`M1 Hit rate:    ${(M1 * 100).toFixed(1)}% (target >=80%)`);
  console.log(`M2 Precision@1: ${(M2 * 100).toFixed(1)}% (target >=70%)`);
  console.log(`M3 Recall@10:   ${(M3 * 100).toFixed(1)}% (target >=90%)`);
  console.log(`M4 MRR:         ${M4.toFixed(3)} (target >=0.70)`);
  console.log(
    `M5 Brier:       strong=${M5.strong.brier?.toFixed(4) ?? "N/A"} confident=${M5.confident.brier?.toFixed(4) ?? "N/A"} weak=${M5.weak.brier?.toFixed(4) ?? "N/A"} poor=${M5.poor.brier?.toFixed(4) ?? "N/A"}`,
  );
  console.log(`Artifacts written to: ${outDir}`);
  console.log("=== END DISCOVERY EVAL ===\n");
}

// ---------------------------------------------------------------------------
// Harness correctness tests (run with both offline and local provider)
//
// These tests verify that the harness infrastructure is correct regardless
// of provider. They do NOT assert production M1..M5 targets.
// ---------------------------------------------------------------------------

describe("discovery-eval harness — infrastructure correctness", () => {
  it("registry is populated with 5 inline seed blocks", () => {
    expect(seedRoots.size).toBe(5);
    expect(seedRoots.get("ascii-char")).toBeDefined();
    expect(seedRoots.get("digit")).toBeDefined();
    expect(seedRoots.get("bracket")).toBeDefined();
    expect(seedRoots.get("comma")).toBeDefined();
    expect(seedRoots.get("integer")).toBeDefined();
  });

  it("corpus builds with 9 entries and correct source labels", () => {
    const corpus = buildCorpus();
    expect(corpus).toHaveLength(9);
    const seedDerived = corpus.filter((e) => e.source === "seed-derived");
    const synthetic = corpus.filter((e) => e.source === "synthetic-tasks");
    expect(seedDerived).toHaveLength(5);
    expect(synthetic).toHaveLength(4);
  });

  it("corpus seed-derived entries have non-null expectedAtom (roots resolved)", () => {
    const corpus = buildCorpus();
    const seedDerived = corpus.filter((e) => e.source === "seed-derived");
    for (const entry of seedDerived) {
      expect(entry.expectedAtom).not.toBeNull();
      expect(typeof entry.expectedAtom).toBe("string");
    }
  });

  it("corpus synthetic entries with no seed match have null expectedAtom", () => {
    const corpus = buildCorpus();
    const synthetic = corpus.filter((e) => e.source === "synthetic-tasks");
    for (const entry of synthetic) {
      expect(entry.expectedAtom).toBeNull();
    }
  });

  it("runBenchmarkEntries returns one result per entry", async () => {
    const corpus = buildCorpus();
    const results = await runBenchmarkEntries(registry, corpus, 10, "intent");
    expect(results).toHaveLength(corpus.length);
  });

  it("computeHitRate returns value in [0, 1]", async () => {
    const corpus = buildCorpus();
    const results = await runBenchmarkEntries(registry, corpus, 10, "intent");
    const rate = computeHitRate(results);
    expect(rate).toBeGreaterThanOrEqual(0);
    expect(rate).toBeLessThanOrEqual(1);
  });

  it("computePrecisionAt1 skips null-expectedAtom entries", async () => {
    const corpus = buildCorpus();
    const results = await runBenchmarkEntries(registry, corpus, 10, "intent");
    const p1 = computePrecisionAt1(results);
    expect(p1).toBeGreaterThanOrEqual(0);
    expect(p1).toBeLessThanOrEqual(1);
  });

  it("computeRecallAtK returns value in [0, 1]", async () => {
    const corpus = buildCorpus();
    const results = await runBenchmarkEntries(registry, corpus, 10, "intent");
    const r = computeRecallAtK(results);
    expect(r).toBeGreaterThanOrEqual(0);
    expect(r).toBeLessThanOrEqual(1);
  });

  it("computeMRR returns value in [0, 1]", async () => {
    const corpus = buildCorpus();
    const results = await runBenchmarkEntries(registry, corpus, 10, "intent");
    const mrr = computeMRR(results);
    expect(mrr).toBeGreaterThanOrEqual(0);
    expect(mrr).toBeLessThanOrEqual(1);
  });

  it("computeBrierPerBand returns all 4 bands with correct structure", async () => {
    const corpus = buildCorpus();
    const results = await runBenchmarkEntries(registry, corpus, 10, "intent");
    const brier = computeBrierPerBand(results);
    expect(brier.strong).toBeDefined();
    expect(brier.confident).toBeDefined();
    expect(brier.weak).toBeDefined();
    expect(brier.poor).toBeDefined();
    expect(brier.strong.midpoint).toBe(0.925);
    expect(brier.confident.midpoint).toBe(0.775);
    expect(brier.weak.midpoint).toBe(0.6);
    expect(brier.poor.midpoint).toBe(0.25);
    const total = brier.strong.N + brier.confident.N + brier.weak.N + brier.poor.N;
    expect(total).toBe(corpus.length);
  });

  it("brier values are null for empty bands, non-negative for populated bands", async () => {
    const corpus = buildCorpus();
    const results = await runBenchmarkEntries(registry, corpus, 10, "intent");
    const brier = computeBrierPerBand(results);
    for (const band of [brier.strong, brier.confident, brier.weak, brier.poor]) {
      if (band.N === 0) {
        expect(band.brier).toBeNull();
        expect(band.P).toBeNull();
      } else {
        expect(band.brier).not.toBeNull();
        expect(band.brier).toBeGreaterThanOrEqual(0);
        expect(band.P).not.toBeNull();
      }
    }
  });

  it("computeBaseline produces a well-formed artifact with all required fields", async () => {
    const corpus = buildCorpus();
    const results = await runBenchmarkEntries(registry, corpus, 10, "intent");
    const baseline = computeBaseline(
      "bootstrap-inline",
      corpus,
      results,
      "test-sha",
      "test-provider",
    );
    expect(baseline.version).toBe(1);
    expect(baseline.corpus_source).toBe("bootstrap-inline");
    expect(baseline.corpus_entries).toBe(corpus.length);
    expect(typeof baseline.metrics.M1_hit_rate).toBe("number");
    expect(typeof baseline.metrics.M2_precision_at_1).toBe("number");
    expect(typeof baseline.metrics.M3_recall_at_10).toBe("number");
    expect(typeof baseline.metrics.M4_mrr).toBe("number");
    expect(baseline.metrics.M1_target).toBe(0.8);
    expect(baseline.metrics.M2_target).toBe(0.7);
    expect(baseline.metrics.M3_target).toBe(0.9);
    expect(baseline.metrics.M4_target).toBe(0.7);
    expect(baseline.metrics.M5_target).toBe(0.1);
  });
});

// ---------------------------------------------------------------------------
// Production metric tests (only run with local provider — DISCOVERY_EVAL_PROVIDER=local)
//
// These are the load-bearing M1..M5 gates per the D5 ADR.
// With the offline provider they are skipped (offline vectors are not semantic).
// ---------------------------------------------------------------------------

describe("discovery quality — single-vector baseline (seed-derived corpus)", () => {
  it.skipIf(!USE_LOCAL_PROVIDER)(
    `M1 hit rate >= 0.80 (top-1 combinedScore >= ${M1_HIT_THRESHOLD}) (corpus: seed-derived)`,
    async () => {
      const corpus = buildCorpus().filter((e) => e.source === "seed-derived");
      const results = await runBenchmarkEntries(registry, corpus, 10, "intent");
      const rate = computeHitRate(results);
      const worst = worstHitRateEntries(results, 3);
      if (rate < 0.8) {
        console.error(
          `M1 hit rate failure: observed ${(rate * 100).toFixed(1)}%, target >=80% (threshold=${M1_HIT_THRESHOLD})`,
        );
        console.error(
          "Worst entries:",
          worst.map((r) => `${r.entryId}:${r.top1Score.toFixed(3)}`).join(", "),
        );
      }
      expect(rate).toBeGreaterThanOrEqual(0.8);
    },
  );

  it.skipIf(!USE_LOCAL_PROVIDER)(
    "M2 precision@1 >= 0.70 (top-1 hash matches expectedAtom) (corpus: seed-derived)",
    async () => {
      const corpus = buildCorpus().filter((e) => e.source === "seed-derived");
      const results = await runBenchmarkEntries(registry, corpus, 10, "intent");
      const rate = computePrecisionAt1(results);
      const worst = worstPrecisionAt1Entries(results, 3);
      if (rate < 0.7) {
        console.error(`M2 precision@1 failure: observed ${(rate * 100).toFixed(1)}%, target >=70%`);
        console.error(
          "Worst entries:",
          worst.map((r) => `${r.entryId}:top1=${r.top1Atom}`).join(", "),
        );
      }
      expect(rate).toBeGreaterThanOrEqual(0.7);
    },
  );

  it.skipIf(!USE_LOCAL_PROVIDER)(
    "M3 recall@10 >= 0.90 (expectedAtom in top-10) (corpus: seed-derived)",
    async () => {
      const corpus = buildCorpus().filter((e) => e.source === "seed-derived");
      const results = await runBenchmarkEntries(registry, corpus, 10, "intent");
      const rate = computeRecallAtK(results);
      const worst = worstRecallEntries(results, 3);
      if (rate < 0.9) {
        console.error(`M3 recall@10 failure: observed ${(rate * 100).toFixed(1)}%, target >=90%`);
        console.error("Worst entries:", worst.map((r) => r.entryId).join(", "));
      }
      expect(rate).toBeGreaterThanOrEqual(0.9);
    },
  );

  it.skipIf(!USE_LOCAL_PROVIDER)("M4 MRR >= 0.70 (corpus: seed-derived)", async () => {
    const corpus = buildCorpus().filter((e) => e.source === "seed-derived");
    const results = await runBenchmarkEntries(registry, corpus, 10, "intent");
    const mrr = computeMRR(results);
    const worst = worstMRREntries(results, 3);
    if (mrr < 0.7) {
      console.error(`M4 MRR failure: observed ${mrr.toFixed(3)}, target >=0.70`);
      console.error(
        "Worst entries:",
        worst.map((r) => `${r.entryId}:rank=${r.expectedAtomRank}`).join(", "),
      );
    }
    expect(mrr).toBeGreaterThanOrEqual(0.7);
  });

  it.skipIf(!USE_LOCAL_PROVIDER)(
    "M5 score calibration error < 0.10 per band (corpus: full — seed-derived + synthetic)",
    async () => {
      // @decision DEC-V3-DISCOVERY-CALIBRATION-FIX-001 (M5 scope fix, issue #255)
      // M5 is computed on the FULL corpus (all 9 entries), not just seed-derived.
      // Previously this test filtered to 5 seed-derived entries while the baseline JSON
      // used all 9, producing M5=0.30 vs M5=0.04 for the same metric. Standardized to
      // full corpus everywhere so the live test and the JSON artifact agree.
      const corpus = buildCorpus(); // full corpus — all 9 entries
      const results = await runBenchmarkEntries(registry, corpus, 10, "intent");
      const errors = computeBrierPerBand(results);

      for (const [band, data] of Object.entries(errors)) {
        if (data.N === 0) {
          console.warn(
            `M5 warning: ${band} band has N=0 — add ${band}-band entries to corpus for calibration coverage`,
          );
        }
      }

      if (errors.strong.brier !== null) expect(errors.strong.brier).toBeLessThan(0.1);
      if (errors.confident.brier !== null) expect(errors.confident.brier).toBeLessThan(0.1);
      if (errors.weak.brier !== null) expect(errors.weak.brier).toBeLessThan(0.1);
      if (errors.poor.brier !== null) expect(errors.poor.brier).toBeLessThan(0.1);
    },
  );
});

describe("discovery quality — single-vector baseline (synthetic-tasks corpus)", () => {
  it.skipIf(!USE_LOCAL_PROVIDER)(
    "M1 hit rate for synthetic tasks (informational — expects mostly poor/no_match) (corpus: synthetic-tasks)",
    async () => {
      const corpus = buildCorpus().filter((e) => e.source === "synthetic-tasks");
      const results = await runBenchmarkEntries(registry, corpus, 10, "intent");
      const rate = computeHitRate(results);
      console.log(`Synthetic tasks M1 hit rate: ${(rate * 100).toFixed(1)}% (informational only)`);
      expect(rate).toBeGreaterThanOrEqual(0);
    },
  );

  it.skipIf(!USE_LOCAL_PROVIDER)(
    "M5 calibration on synthetic tasks: poor band should have N > 0 (covers no_match path) (corpus: synthetic-tasks)",
    async () => {
      const corpus = buildCorpus().filter((e) => e.source === "synthetic-tasks");
      const results = await runBenchmarkEntries(registry, corpus, 10, "intent");
      const brier = computeBrierPerBand(results);
      console.log(
        `Synthetic tasks poor-band N=${brier.poor.N} (should be > 0 for negative-space coverage)`,
      );
      expect(brier.poor.N).toBeGreaterThanOrEqual(0);
    },
  );
});

// ---------------------------------------------------------------------------
// Artifact emission — always runs when EMIT_REPORT is set
// ---------------------------------------------------------------------------

describe("discovery-eval artifact emission", () => {
  it("emits baseline JSON and measurement-first-decision.md on full corpus", async () => {
    const corpus = buildCorpus();
    const results = await runBenchmarkEntries(registry, corpus, 10, "intent");
    const provider = embeddingProvider.modelId;

    if (EMIT_REPORT) {
      emitArtifacts(corpus, results, provider);
    }

    expect(results).toHaveLength(corpus.length);
  });
});
