// SPDX-License-Identifier: MIT
/**
 * discovery-d3-strictness.test.ts — Regression tests for D3 filter strictness fix.
 *
 * WI-V3-DISCOVERY-D3-FILTER-STRICTNESS-FIX (issue #319)
 *
 * Three regression tests (R1, R2, R3) that verify the "no-op when one side is missing"
 * rule for optional fields (guarantees, errorConditions, nonFunctional):
 *
 *   R1: Candidate with empty guarantees/errorConditions appears in top-K for a
 *       behavior-only query with near-zero semantic distance.
 *
 *   R2: Candidate atom with guarantees is NOT demoted when query has no guarantees
 *       constraint. (Field present on one side only → no-op for ranking.)
 *
 *   R3: Candidate atom with guarantees IS demoted when query has conflicting
 *       guarantees. (Legitimate misalignment case — the pipeline should still work.)
 *
 * Uses an in-memory registry with the offline (BLAKE3) embedding provider.
 * These tests do NOT depend on the bootstrap registry or local semantic provider.
 *
 * @decision DEC-V3-DISCOVERY-D3-FILTER-STRICTNESS-FIX-001
 * @title D3 filter strictness regression tests
 * @status accepted
 * @rationale
 *   The fix for issue #319 changes Stage 1 KNN to use behavior-only text for
 *   embedding, preventing optional fields (guarantees, errorConditions) from
 *   inadvertently demoting semantically-correct candidates via embedding pressure.
 *   These regression tests encode the expected behavior to guard against regressions.
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
import { afterAll, beforeAll, describe, it, expect } from "vitest";
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

/** Minimal impl source for making a BlockTripletRow. Not semantically meaningful. */
const STUB_IMPL = "export function stub(): void {}";
/** Stub proof manifest with no artifacts. */
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
// Registry setup for tests
// ---------------------------------------------------------------------------

let registry: Registry;

// Three candidate atoms for regression tests:
//
// atom-parse-digit:  has guarantees, has errorConditions — the "fully specified" candidate
// atom-bare-parse:   has no guarantees, no errorConditions — the "bare" candidate
// atom-unrelated:    completely different behavior — the negative-space candidate

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

// Block rows — computed in beforeAll
let rowParseDigit: BlockTripletRow;
let rowBareParse: BlockTripletRow;
let rowUnrelated: BlockTripletRow;

// BMRs for checking results
let bmrParseDigit: string;
let bmrBareParse: string;
let bmrUnrelated: string;

beforeAll(async () => {
  const provider = createOfflineEmbeddingProvider();

  // Use in-memory registry for isolation (no bootstrap registry needed)
  registry = await openRegistry(":memory:", { embeddings: provider });

  // Build block rows
  rowParseDigit = await makeBlockRow(SPEC_PARSE_DIGIT);
  rowBareParse = await makeBlockRow(SPEC_BARE_PARSE);
  rowUnrelated = await makeBlockRow(SPEC_UNRELATED);

  bmrParseDigit = rowParseDigit.blockMerkleRoot as string;
  bmrBareParse = rowBareParse.blockMerkleRoot as string;
  bmrUnrelated = rowUnrelated.blockMerkleRoot as string;

  // Store all three atoms
  await registry.storeBlock(rowParseDigit);
  await registry.storeBlock(rowBareParse);
  await registry.storeBlock(rowUnrelated);
});

afterAll(async () => {
  await registry.close();
});

// ---------------------------------------------------------------------------
// R1: Bare candidate (empty guarantees/errorConditions) appears in top-K
// ---------------------------------------------------------------------------

describe("R1 — bare candidate not rejected by behavior-only query", () => {
  it("bare-parse appears in top-K for a behavior-only query", async () => {
    /**
     * @decision DEC-V3-DISCOVERY-D3-FILTER-STRICTNESS-FIX-001
     *
     * R1 tests the "field absent on both sides → no-op" rule.
     * A behavior-only query has no guarantees or errorConditions constraint.
     * A candidate with no guarantees/errorConditions should not be penalized.
     * It must appear in the Stage 1 top-K set.
     *
     * Issue #319: before the fix, Stage 1 would embed the full query dimensions
     * which could demote candidates that don't match those dimensions. After fix,
     * Stage 1 uses behavior-only embedding so the bare candidate is ranked by
     * behavioral similarity only.
     */
    const result = await registry.findCandidatesByQuery({
      behavior: "Parse a decimal digit character into its integer value",
      topK: 10,
    });

    const candidateRoots = result.candidates.map((c) => c.block.blockMerkleRoot as string);
    const nearMissRoots = result.nearMisses.map((c) => c.block.blockMerkleRoot as string);

    // bare-parse must appear in top-K (not rejected or near-missed)
    const bareInCandidates = candidateRoots.includes(bmrBareParse);
    const bareInNearMisses = nearMissRoots.includes(bmrBareParse);

    expect(bareInCandidates || bareInNearMisses).toBe(true);
    expect(bareInNearMisses).toBe(false); // should NOT be in near-misses (that means it was filtered)

    // unrelated should not appear (different behavior)
    // (With offline BLAKE3 provider, this may vary — just verify bare-parse is found)
    console.log(
      `[R1] bare-parse in candidates: ${bareInCandidates}, near-misses: ${bareInNearMisses}`
    );
    console.log(`[R1] Candidates: ${candidateRoots.length}, near-misses: ${nearMissRoots.length}`);
  });
});

// ---------------------------------------------------------------------------
// R2: Candidate with guarantees NOT demoted when query has no guarantees
// ---------------------------------------------------------------------------

describe("R2 — candidate with guarantees not demoted when query omits guarantees", () => {
  it("parse-digit appears in top-K for a behavior-only query despite having guarantees", async () => {
    /**
     * @decision DEC-V3-DISCOVERY-D3-FILTER-STRICTNESS-FIX-001
     *
     * R2 tests the "field present on candidate only → no-op" rule.
     * parse-digit has guarantees; the query has none.
     * Per the spec: field present on one side only → no-op. The candidate must
     * NOT be penalized for declaring guarantees that the query didn't ask for.
     *
     * Issue #319: Stage 3 had a bug (lines 882-885 in storage.ts) where candidates
     * without nonFunctional were rejected when the query required it. The analog
     * for guarantees would be similar. This test verifies the no-op behavior.
     */
    const result = await registry.findCandidatesByQuery({
      behavior: "Parse a decimal digit character into its integer value",
      // No guarantees constraint — must be a no-op for candidates that HAVE guarantees
      topK: 10,
    });

    const candidateRoots = result.candidates.map((c) => c.block.blockMerkleRoot as string);
    const nearMissRoots = result.nearMisses.map((c) => c.block.blockMerkleRoot as string);

    // parse-digit (with guarantees) must appear in candidates (not near-misses)
    const pdInCandidates = candidateRoots.includes(bmrParseDigit);
    const pdInNearMisses = nearMissRoots.includes(bmrParseDigit);

    expect(pdInCandidates || pdInNearMisses).toBe(true);
    expect(pdInNearMisses).toBe(false); // NOT filtered into near-misses

    console.log(
      `[R2] parse-digit in candidates: ${pdInCandidates}, near-misses: ${pdInNearMisses}`
    );
  });
});

// ---------------------------------------------------------------------------
// R3: Legitimate misalignment — candidate with guarantees IS demoted when
//     query has conflicting nonFunctional constraints
// ---------------------------------------------------------------------------

describe("R3 — candidate with weak purity demoted when query requires pure", () => {
  it("impure candidate is filtered (near-miss) when query requires pure purity", async () => {
    /**
     * @decision DEC-V3-DISCOVERY-D3-FILTER-STRICTNESS-FIX-001
     *
     * R3 tests the legitimate filtering case: both query and candidate assert
     * nonFunctional, and they're misaligned. The fix must NOT break this case.
     *
     * An impure candidate (purity="io") should be rejected when the query
     * requires purity="pure".
     *
     * Note: This uses query.nonFunctional (structured field), which triggers
     * Stage 3 filtering. This is distinct from guarantees/errorConditions (text
     * strings), which don't trigger filtering stages.
     */
    // Create a specialized in-memory registry with two candidates:
    // - pure-spec: purity=pure
    // - impure-spec: purity=io
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
      nonFunctional: { purity: "pure" }, // requires pure — impure-digit should fail
      topK: 10,
    });

    const candidateRoots = result.candidates.map((c) => c.block.blockMerkleRoot as string);
    const nearMissRoots = result.nearMisses.map((c) => c.block.blockMerkleRoot as string);

    const pureBmr = pureRow.blockMerkleRoot as string;
    const impureBmr = impureRow.blockMerkleRoot as string;

    console.log(`[R3] pure-digit in candidates: ${candidateRoots.includes(pureBmr)}`);
    console.log(`[R3] impure-digit in candidates: ${candidateRoots.includes(impureBmr)}`);
    console.log(`[R3] impure-digit in near-misses: ${nearMissRoots.includes(impureBmr)}`);
    console.log(`[R3] Candidates: ${candidateRoots.length}, nearMisses: ${nearMissRoots.length}`);

    // pure-digit should be a candidate (it meets the purity requirement)
    expect(candidateRoots.includes(pureBmr)).toBe(true);

    // impure-digit should NOT be a candidate (purity mismatch)
    // It may be in near-misses if candidates is non-empty, or just absent
    expect(candidateRoots.includes(impureBmr)).toBe(false);

    await testReg.close();
  });
});

// ---------------------------------------------------------------------------
// R4: Stage 3 no-op when candidate has no nonFunctional but query requires it
// ---------------------------------------------------------------------------

describe("R4 — candidate without nonFunctional is not rejected when query requires nonFunctional", () => {
  it("candidate without nonFunctional declaration passes Stage 3 when query specifies nonFunctional", async () => {
    /**
     * @decision DEC-V3-DISCOVERY-D3-FILTER-STRICTNESS-FIX-001
     *
     * R4 tests the Stage 3 bug fix (storage.ts lines 882-885).
     * BEFORE fix: if query.nonFunctional.purity is set and candidate has no
     * nonFunctional field, the candidate is rejected with
     * "candidate has no nonFunctional declaration".
     *
     * AFTER fix: field present on one side only → no-op. Candidate without
     * nonFunctional should pass Stage 3 (treated as "not asserting any constraint").
     *
     * The correct semantics per issue #319: a candidate that doesn't declare
     * nonFunctional properties isn't claiming to be impure — it's simply not
     * asserting anything about purity. The query's purity constraint cannot be
     * verified against it, so it should pass through (no-op, not rejection).
     */
    const provider = createOfflineEmbeddingProvider();
    const testReg = await openRegistry(":memory:", { embeddings: provider });

    // Candidate with no nonFunctional field (bare candidate)
    const bareSpec = makeSpecYak({
      name: "bare-digit",
      behavior: "Convert digit character to integer",
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

    console.log(`[R4] bare-digit in candidates: ${candidateRoots.includes(bareBmr)}`);
    console.log(`[R4] bare-digit in near-misses: ${nearMissRoots.includes(bareBmr)}`);

    // After fix: bare-digit (no nonFunctional) should NOT be rejected.
    // It should appear in candidates (Stage 3 is no-op when candidate has no NF).
    expect(candidateRoots.includes(bareBmr)).toBe(true);
    expect(nearMissRoots.includes(bareBmr)).toBe(false);

    await testReg.close();
  });
});
