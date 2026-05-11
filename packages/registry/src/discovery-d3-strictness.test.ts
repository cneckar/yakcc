// SPDX-License-Identifier: MIT
/**
 * discovery-d3-strictness.test.ts — Regression tests for D3 filter strictness fix.
 *
 * WI-V3-DISCOVERY-D3-FILTER-STRICTNESS-FIX (issue #314)
 *
 * Four regression tests (R1–R4) verifying the "no-op when one side is missing"
 * rule for optional fields (guarantees, errorConditions, nonFunctional):
 *
 *   R1: Candidate with empty guarantees/errorConditions appears in top-K for a
 *       behavior-only query with near-zero semantic distance.
 *
 *   R2: Candidate atom with guarantees is NOT demoted when query has no guarantees
 *       constraint. (Field present on one side only → no-op for ranking.)
 *
 *   R3: Candidate atom with weak purity IS filtered when query requires pure purity.
 *       (Legitimate misalignment case — the pipeline should still work.)
 *
 *   R4: Candidate without nonFunctional declaration passes Stage 3 when query
 *       requires nonFunctional. (The original bug: missing field → rejection.)
 *
 * Uses an in-memory registry with the offline (BLAKE3) embedding provider.
 * These tests do NOT depend on the bootstrap registry or local semantic provider.
 *
 * @decision DEC-V3-DISCOVERY-D3-FILTER-STRICTNESS-FIX-001
 * @title D3 filter strictness regression tests (issue #314)
 * @status accepted
 * @rationale
 *   The fix for issue #314 changes Stage 1 KNN to use behavior-only text for
 *   embedding (preventing optional field inflation from demoting correct candidates),
 *   removes Stage 3's rejection of candidates without nonFunctional declaration
 *   (absent-dimension rule), and sets ε=0 in Stage 5 to prevent rank inversions
 *   from the tiebreaker window. These regression tests guard against regressions.
 */

import { join } from "node:path";
import {
  type SpecYak,
  blockMerkleRoot,
  canonicalize,
  createOfflineEmbeddingProvider,
  specHash as deriveSpecHash,
  canonicalAstHash as deriveCanonicalAstHash,
} from "@yakcc/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { BlockMerkleRoot, BlockTripletRow, CanonicalAstHash, Registry, SpecHash } from "./index.js";
import { openRegistry } from "./storage.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeSpecYak(fields: Partial<SpecYak> & { name: string; behavior: string }): SpecYak {
  return {
    name: fields.name,
    behavior: fields.behavior,
    inputs: fields.inputs ?? [],
    outputs: fields.outputs ?? [],
    preconditions: fields.preconditions ?? [],
    postconditions: fields.postconditions ?? [],
    invariants: fields.invariants ?? [],
    effects: fields.effects ?? [],
    level: fields.level ?? "L0",
    ...(fields.guarantees ? { guarantees: fields.guarantees } : {}),
    ...(fields.errorConditions ? { errorConditions: fields.errorConditions } : {}),
    ...(fields.nonFunctional ? { nonFunctional: fields.nonFunctional } : {}),
  };
}

const STUB_IMPL = "export function stub(): void {}";
const STUB_MANIFEST = { version: 1, artifacts: [] as { path: string; algorithm: string; hash: string }[] };

async function makeBlockRow(spec: SpecYak): Promise<BlockTripletRow> {
  const implSource = STUB_IMPL;
  const manifest = STUB_MANIFEST;
  const artifacts = new Map<string, Uint8Array>();
  const bmr = blockMerkleRoot({
    spec,
    implSource,
    manifest: manifest as never,
    artifacts,
  }) as BlockMerkleRoot;
  const specHashVal = deriveSpecHash(spec) as SpecHash;
  const specCanonicalBytes = canonicalize(spec as unknown as Parameters<typeof canonicalize>[0]);
  const astHash = deriveCanonicalAstHash(implSource) as CanonicalAstHash;
  return {
    blockMerkleRoot: bmr,
    specHash: specHashVal,
    specCanonicalBytes,
    implSource,
    proofManifestJson: JSON.stringify(manifest),
    level: "L0",
    createdAt: Date.now(),
    canonicalAstHash: astHash,
    parentBlockRoot: null,
    artifacts,
    kind: "local",
    foreignPkg: null,
    foreignExport: null,
    foreignDtsHash: null,
  };
}

// ---------------------------------------------------------------------------
// Registry + atom setup
// ---------------------------------------------------------------------------

let registry: Registry;

const SPEC_PARSE_DIGIT = makeSpecYak({
  name: "parse-digit",
  behavior: "Parse a decimal digit character into its integer value",
  inputs: [{ name: "ch", type: "string" }],
  outputs: [{ name: "value", type: "number" }],
  guarantees: [
    { id: "pure", description: "Referentially transparent; no side effects" },
    { id: "range", description: "Result is always in [0, 9]" },
  ],
  errorConditions: [
    { description: "Throws RangeError if input is not a digit character", errorType: "RangeError" },
  ],
});

const SPEC_BARE_PARSE = makeSpecYak({
  name: "bare-parse",
  behavior: "Parse a decimal digit character into its integer value",
  inputs: [{ name: "ch", type: "string" }],
  outputs: [{ name: "value", type: "number" }],
  // No guarantees, no errorConditions — the "bare" candidate per R1
});

const SPEC_UNRELATED = makeSpecYak({
  name: "unrelated-op",
  behavior: "Compute the hash of a file path for caching purposes",
  inputs: [{ name: "path", type: "string" }],
  outputs: [{ name: "hash", type: "string" }],
});

let rowParseDigit: BlockTripletRow;
let rowBareParse: BlockTripletRow;
let rowUnrelated: BlockTripletRow;
let bmrParseDigit: string;
let bmrBareParse: string;
let bmrUnrelated: string;

beforeAll(async () => {
  const provider = createOfflineEmbeddingProvider();
  registry = await openRegistry(":memory:", { embeddings: provider });

  rowParseDigit = await makeBlockRow(SPEC_PARSE_DIGIT);
  rowBareParse = await makeBlockRow(SPEC_BARE_PARSE);
  rowUnrelated = await makeBlockRow(SPEC_UNRELATED);

  bmrParseDigit = rowParseDigit.blockMerkleRoot as string;
  bmrBareParse = rowBareParse.blockMerkleRoot as string;
  bmrUnrelated = rowUnrelated.blockMerkleRoot as string;

  await registry.storeBlock(rowParseDigit);
  await registry.storeBlock(rowBareParse);
  await registry.storeBlock(rowUnrelated);
});

afterAll(async () => {
  await registry.close();
});

// ---------------------------------------------------------------------------
// R1: Bare candidate (no guarantees/errorConditions) appears in top-K
// ---------------------------------------------------------------------------

describe("R1 — bare candidate not rejected by behavior-only query", () => {
  it("bare-parse (no guarantees/errorConditions) appears in candidates for behavior-only query", async () => {
    /**
     * @decision DEC-V3-DISCOVERY-D3-FILTER-STRICTNESS-FIX-001
     *
     * R1 verifies the "field absent on both sides → no-op" rule.
     * A behavior-only query has no guarantees or errorConditions constraint.
     * A candidate with no guarantees/errorConditions must not be penalized.
     * After Fix 1 (Stage 1 uses plain behavior text), optional dimensions no
     * longer inflate the query vector and push bare candidates to lower ranks.
     */
    const result = await registry.findCandidatesByQuery({
      behavior: "Parse a decimal digit character into its integer value",
      topK: 10,
    });

    const candidateRoots = result.candidates.map((c) => c.block.blockMerkleRoot as string);
    const nearMissRoots = result.nearMisses.map((c) => c.block.blockMerkleRoot as string);

    const bareInCandidates = candidateRoots.includes(bmrBareParse);
    const bareInNearMisses = nearMissRoots.includes(bmrBareParse);

    expect(bareInNearMisses).toBe(false); // must NOT be filtered into near-misses
    expect(bareInCandidates).toBe(true);   // must appear in candidates
  });
});

// ---------------------------------------------------------------------------
// R2: Candidate with guarantees NOT demoted when query omits guarantees
// ---------------------------------------------------------------------------

describe("R2 — candidate with guarantees not demoted when query omits guarantees", () => {
  it("parse-digit (has guarantees) appears in candidates for behavior-only query", async () => {
    /**
     * @decision DEC-V3-DISCOVERY-D3-FILTER-STRICTNESS-FIX-001
     *
     * R2 verifies the "field present on candidate only → no-op" rule.
     * parse-digit declares guarantees; the query specifies none.
     * Per D3 ADR absent-dimension rule: field present on one side only → no-op.
     * The candidate must NOT be penalized for declaring guarantees the query
     * didn't ask for.
     */
    const result = await registry.findCandidatesByQuery({
      behavior: "Parse a decimal digit character into its integer value",
      topK: 10,
    });

    const candidateRoots = result.candidates.map((c) => c.block.blockMerkleRoot as string);
    const nearMissRoots = result.nearMisses.map((c) => c.block.blockMerkleRoot as string);

    const pdInCandidates = candidateRoots.includes(bmrParseDigit);
    const pdInNearMisses = nearMissRoots.includes(bmrParseDigit);

    expect(pdInNearMisses).toBe(false); // must NOT be filtered into near-misses
    expect(pdInCandidates).toBe(true);  // must appear in candidates
  });
});

// ---------------------------------------------------------------------------
// R3: Legitimate purity mismatch — impure candidate rejected when query requires pure
// ---------------------------------------------------------------------------

describe("R3 — legitimate purity mismatch: impure candidate rejected when query requires pure", () => {
  it("candidate with purity=io is filtered when query requires purity=pure", async () => {
    /**
     * @decision DEC-V3-DISCOVERY-D3-FILTER-STRICTNESS-FIX-001
     *
     * R3 verifies the Stage 3 fix does NOT break the legitimate filtering case.
     * When BOTH query AND candidate declare nonFunctional and they are misaligned
     * (candidate purity < query purity), Stage 3 must still reject the candidate.
     * Fix 2 only removes the rejection of candidates WITHOUT nonFunctional;
     * the misalignment case is preserved.
     */
    const provider = createOfflineEmbeddingProvider();
    const testReg = await openRegistry(":memory:", { embeddings: provider });

    const pureSpec = makeSpecYak({
      name: "pure-digit",
      behavior: "Convert digit to number with no I/O",
      nonFunctional: { purity: "pure", threadSafety: "safe", time: "O(1)", space: "O(1)" },
    });
    const impureSpec = makeSpecYak({
      name: "impure-digit",
      behavior: "Convert digit to number with I/O logging",
      nonFunctional: { purity: "io", threadSafety: "safe", time: "O(1)", space: "O(1)" },
    });

    const pureRow = await makeBlockRow(pureSpec);
    const impureRow = await makeBlockRow(impureSpec);

    await testReg.storeBlock(pureRow);
    await testReg.storeBlock(impureRow);

    const result = await testReg.findCandidatesByQuery({
      behavior: "Convert digit to number",
      nonFunctional: { purity: "pure" },
      topK: 10,
    });

    const candidateRoots = result.candidates.map((c) => c.block.blockMerkleRoot as string);
    const pureBmr = pureRow.blockMerkleRoot as string;
    const impureBmr = impureRow.blockMerkleRoot as string;

    expect(candidateRoots.includes(pureBmr)).toBe(true);    // pure candidate passes
    expect(candidateRoots.includes(impureBmr)).toBe(false); // impure candidate rejected

    await testReg.close();
  });
});

// ---------------------------------------------------------------------------
// R4: Stage 3 no-op — candidate without nonFunctional passes when query requires it
// ---------------------------------------------------------------------------

describe("R4 — Stage 3 no-op: candidate without nonFunctional passes when query specifies nonFunctional", () => {
  it("bare candidate (no nonFunctional) is NOT rejected when query requires purity=pure", async () => {
    /**
     * @decision DEC-V3-DISCOVERY-D3-FILTER-STRICTNESS-FIX-001
     *
     * R4 directly tests the Stage 3 bug fix (storage.ts ~line 882-885).
     *
     * BEFORE fix (original code):
     *   if candidateNF is undefined AND query.nonFunctional.purity is set →
     *   candidate pushed to near-misses with "candidate has no nonFunctional declaration".
     *   This violated the D3 absent-dimension rule.
     *
     * AFTER fix:
     *   absence of nonFunctional on the candidate → pass through Stage 3 (no-op).
     *   A candidate that doesn't declare nonFunctional is not asserting it fails
     *   the purity requirement — it simply doesn't assert anything about purity.
     */
    const provider = createOfflineEmbeddingProvider();
    const testReg = await openRegistry(":memory:", { embeddings: provider });

    const bareSpec = makeSpecYak({
      name: "bare-digit",
      behavior: "Convert digit character to integer",
      // No nonFunctional field
    });

    const bareRow = await makeBlockRow(bareSpec);
    const bareBmr = bareRow.blockMerkleRoot as string;

    await testReg.storeBlock(bareRow);

    const result = await testReg.findCandidatesByQuery({
      behavior: "Convert digit character to integer",
      nonFunctional: { purity: "pure" }, // query requires pure
      topK: 10,
    });

    const candidateRoots = result.candidates.map((c) => c.block.blockMerkleRoot as string);
    const nearMissRoots = result.nearMisses.map((c) => c.block.blockMerkleRoot as string);

    // After fix: candidate without nonFunctional must NOT be rejected by Stage 3.
    expect(candidateRoots.includes(bareBmr)).toBe(true);
    expect(nearMissRoots.includes(bareBmr)).toBe(false);

    await testReg.close();
  });
});
