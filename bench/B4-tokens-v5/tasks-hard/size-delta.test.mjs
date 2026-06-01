// SPDX-License-Identifier: MIT
//
// bench/B4-tokens-v5/tasks-hard/size-delta.test.mjs
//
// Offline size-delta analysis tests — no API calls, fully deterministic.
//
// What this tests (production sequence):
//   1. runSizeDelta() reads the combined corpus (tasks.json + tasks-hard.json),
//      calls real @yakcc/compile (addReference/referenceImportLine), and returns
//      the stratified token-delta result.
//   2. The result is validated for correctness invariants:
//      - All 9 atoms present
//      - Collapse holds (ratio > 1.0) for every atom
//      - Large atoms have strictly greater absolute savings than the median small atom
//      - Results are deterministic (two sequential runs produce identical numbers)
//   3. The stratum split is correct (6 small, 3 large)
//
// These tests exercise the full real production sequence:
//   tasks.json + tasks-hard.json → reference-impl.ts → @yakcc/compile → token counts

import { beforeAll, describe, expect, it } from "vitest";
import { runSizeDelta } from "./size-delta.mjs";

// runSizeDelta() is async (top-level await on @yakcc/compile import happens at module load).
// We call it once per describe block and share the result.

describe("size-delta: combined corpus", () => {
  // Run once; share across all tests in this describe
  let result;
  beforeAll(async () => {
    result = await runSizeDelta();
  });

  it("reads exactly 9 atoms (6 small + 3 large)", () => {
    expect(result.atoms).toHaveLength(9);
    expect(result.smallAtoms).toHaveLength(6);
    expect(result.largeAtoms).toHaveLength(3);
  });

  it("small stratum contains the 6 existing v5 task IDs", () => {
    const smallIds = new Set(result.smallAtoms.map((a) => a.atomId));
    expect(smallIds).toContain("crc32c");
    expect(smallIds).toContain("utf8-codec");
    expect(smallIds).toContain("base32-rfc4648");
    expect(smallIds).toContain("lru-ttl-cache");
    expect(smallIds).toContain("semver-range");
    expect(smallIds).toContain("ring-buffer");
  });

  it("large stratum contains the 3 new hard #1049 task IDs", () => {
    const largeIds = new Set(result.largeAtoms.map((a) => a.atomId));
    expect(largeIds).toContain("avl-tree");
    expect(largeIds).toContain("pratt-expr-eval");
    expect(largeIds).toContain("dijkstra-heap");
  });

  it("atoms are sorted by impl_tokens ascending", () => {
    const tokens = result.atoms.map((a) => a.verbatim.tokens);
    for (let i = 1; i < tokens.length; i++) {
      expect(tokens[i]).toBeGreaterThanOrEqual(tokens[i - 1]);
    }
  });
});

describe("size-delta: collapse invariants", () => {
  let result;
  beforeAll(async () => {
    result = await runSizeDelta();
  });

  it("collapse holds (ratio > 1) for all 9 atoms", () => {
    for (const atom of result.atoms) {
      expect(atom.collapseRatio).toBeGreaterThan(1.0);
    }
  });

  it("absolute savings > 0 for all 9 atoms", () => {
    for (const atom of result.atoms) {
      expect(atom.absoluteSavings).toBeGreaterThan(0);
    }
  });

  it("import line is a valid .yakcc/atoms/ import for all 9 atoms", () => {
    for (const atom of result.atoms) {
      expect(atom.importLine).toMatch(/^import \{ \S+ \} from "\.yakcc\/atoms\/[0-9a-f]{12}";$/);
    }
  });
});

describe("size-delta: savings scale with atom size", () => {
  let result;
  beforeAll(async () => {
    result = await runSizeDelta();
  });

  it("large atoms have strictly greater median absolute savings than small atom median", () => {
    const { smallAggregate, largeAggregate } = result;
    // This is the core hypothesis from #1041: value lives on the large/hard tail.
    expect(largeAggregate.medianAbsoluteSavings).toBeGreaterThan(
      smallAggregate.medianAbsoluteSavings,
    );
  });

  it("large stratum median collapse ratio > small stratum median collapse ratio", () => {
    const { smallAggregate, largeAggregate } = result;
    expect(largeAggregate.medianCollapseRatio).toBeGreaterThan(smallAggregate.medianCollapseRatio);
  });

  it("each large atom saves more tokens than the median small atom", () => {
    const { smallAggregate, largeAtoms } = result;
    for (const largeAtom of largeAtoms) {
      expect(largeAtom.absoluteSavings).toBeGreaterThan(smallAggregate.medianAbsoluteSavings);
    }
  });

  it("large impl lines are >=200 for all hard atoms (size requirement satisfied)", () => {
    for (const atom of result.largeAtoms) {
      expect(atom.implLines).toBeGreaterThanOrEqual(200);
    }
  });
});

describe("size-delta: determinism", () => {
  it("two sequential runs produce identical atoms array", async () => {
    const r1 = await runSizeDelta();
    const r2 = await runSizeDelta();

    // Results should be identical (deterministic: same source → same SHA-256 → same alias)
    // Compare per-atom numbers, not timestamps
    const strip = (r) =>
      r.atoms.map((a) => ({
        atomId: a.atomId,
        stratum: a.stratum,
        verbatimTokens: a.verbatim.tokens,
        importTokens: a.reference.tokens,
        absoluteSavings: a.absoluteSavings,
        collapseRatio: a.collapseRatio,
        importLine: a.importLine,
      }));

    expect(strip(r1)).toEqual(strip(r2));
  });
});
