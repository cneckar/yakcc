// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vitest";
import { graphSearchCandidates, selectCompositionContext } from "./context.js";
import type { FillCandidate } from "./fill.js";

const cand = (id: string, pkg: string, score: number, chars: number): FillCandidate => ({
  id,
  sourcePkg: pkg,
  score,
  text: "x".repeat(chars),
  citation: { merkleRoot: `root-${id}`, sourceFile: `${pkg}/index.ts`, lineStart: 1, lineEnd: 2 },
});

// One package holds the five best-scored candidates. Each is 50 tokens, so the 250-token
// budget can be spent entirely on it.
const dominated = [
  cand("p1", "p", 0.95, 200),
  cand("p2", "p", 0.9, 200),
  cand("p3", "p", 0.85, 200),
  cand("p4", "p", 0.8, 200),
  cand("p5", "p", 0.75, 200),
  cand("q1", "q", 0.6, 200),
  cand("r1", "r", 0.5, 200),
];

describe("composition context (WI-REUSE B7, #1271)", () => {
  it("by default selects in rank order: one package takes the whole budget", () => {
    const ctx = selectCompositionContext(dominated, { tokenBudget: 250 });
    expect(ctx.mode).toBe("rank");
    expect(ctx.maxPackageShare).toBe(1);
    expect(ctx.selected.map((c) => c.id)).toEqual(["p1", "p2", "p3", "p4", "p5"]);
    expect(ctx.byPackage).toEqual({ p: 250 });
    expect(ctx.dropped).toEqual(["q1", "r1"]);
  });

  it("with the source-spread fill, caps the dominant package and admits the others", () => {
    const ctx = selectCompositionContext(dominated, {
      tokenBudget: 250,
      sourceSpread: { maxPackageShare: 0.4 },
    });
    expect(ctx.mode).toBe("fill");
    // Pass 1: p may take 100 of 250 tokens (p1, p2), then q1 and r1. Pass 2 spends the last 50.
    expect(ctx.selected.map((c) => c.id)).toEqual(["p1", "p2", "p3", "q1", "r1"]);
    expect(ctx.byPackage).toEqual({ p: 150, q: 50, r: 50 });
    expect(ctx.tokens).toBe(250);
    expect(ctx.dropped).toEqual(["p4", "p5"]);
  });

  it("the default is exactly the fill with a share of 1", () => {
    const a = selectCompositionContext(dominated, { tokenBudget: 250 });
    const b = selectCompositionContext(dominated, {
      tokenBudget: 250,
      sourceSpread: { maxPackageShare: 1 },
    });
    expect(b.selected).toEqual(a.selected);
    expect(b.mode).toBe("fill");
  });

  it("the fill changes nothing when no package would dominate", () => {
    const spread = [cand("a", "p", 0.9, 200), cand("b", "q", 0.8, 200), cand("c", "r", 0.7, 200)];
    const off = selectCompositionContext(spread, { tokenBudget: 200 });
    const on = selectCompositionContext(spread, {
      tokenBudget: 200,
      sourceSpread: { maxPackageShare: 0.5 },
    });
    expect(on.selected).toEqual(off.selected);
  });

  it("keeps every selected candidate's citation", () => {
    const ctx = selectCompositionContext(dominated, {
      tokenBudget: 250,
      sourceSpread: { maxPackageShare: 0.4 },
    });
    for (const c of ctx.selected) expect(c.citation.merkleRoot).toBe(`root-${c.id}`);
  });

  it("rejects a share outside (0, 1]", () => {
    expect(() =>
      selectCompositionContext(dominated, { tokenBudget: 1, sourceSpread: { maxPackageShare: 0 } }),
    ).toThrow(RangeError);
  });
});

describe("graph-search candidates in the composition context (#1271, #1280)", () => {
  const hits = [
    { graphIdentity: "g-exact", exact: true, structuralDistance: 0, lineForm: "a".repeat(200) },
    { graphIdentity: "g-near", exact: false, structuralDistance: 0.1, lineForm: "b".repeat(200) },
    { graphIdentity: "g-mid", exact: false, structuralDistance: 0.3, lineForm: "c".repeat(200) },
    { graphIdentity: "g-other", exact: false, structuralDistance: 0.4, lineForm: "d".repeat(200) },
    { graphIdentity: "g-orphan", exact: false, structuralDistance: 0.05, lineForm: "e" },
  ];
  const provenance: Record<string, { pkg: string; line: number }> = {
    "g-exact": { pkg: "lodash", line: 10 },
    "g-near": { pkg: "lodash", line: 20 },
    "g-mid": { pkg: "lodash", line: 30 },
    "g-other": { pkg: "semver", line: 40 },
  };
  const provenanceOf = (id: string) => {
    const p = provenance[id];
    return p === undefined
      ? undefined
      : {
          sourcePkg: p.pkg,
          citation: {
            merkleRoot: `root-${id}`,
            sourceFile: `${p.pkg}/x.js`,
            lineStart: p.line,
            lineEnd: p.line + 5,
          },
        };
  };

  it("scores by structural similarity and reports graphs with no provenance as uncited", () => {
    const { candidates, uncited } = graphSearchCandidates(hits, provenanceOf);
    expect(candidates.map((c) => [c.id, c.score])).toEqual([
      ["g-exact", 1],
      ["g-near", 0.9],
      ["g-mid", 0.7],
      ["g-other", 0.6],
    ]);
    expect(uncited).toEqual(["g-orphan"]);
    expect(candidates[0]?.text).toBe(hits[0]?.lineForm);
  });

  it("the fill caps a package that dominates the graph candidates", () => {
    const { candidates } = graphSearchCandidates(hits, provenanceOf);
    const off = selectCompositionContext(candidates, { tokenBudget: 150 });
    const on = selectCompositionContext(candidates, {
      tokenBudget: 150,
      sourceSpread: { maxPackageShare: 0.5 },
    });
    expect(off.selected.map((c) => c.id)).toEqual(["g-exact", "g-near", "g-mid"]);
    expect(on.selected.map((c) => c.id)).toEqual(["g-exact", "g-near", "g-other"]);
    expect(on.byPackage).toEqual({ lodash: 100, semver: 50 });
  });
});
