// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vitest";
import { type FillCandidate, fill } from "./fill.js";

const cand = (id: string, pkg: string, score: number, chars: number): FillCandidate => ({
  id,
  sourcePkg: pkg,
  score,
  text: "x".repeat(chars),
  citation: { merkleRoot: `root-${id}`, sourceFile: `${pkg}/index.ts`, lineStart: 1, lineEnd: 2 },
});

describe("budgeted, source-spread, cited fill (WI-REUSE B4, #1261)", () => {
  it("never exceeds the token budget", () => {
    const cs = [cand("a", "p", 0.9, 400), cand("b", "q", 0.8, 400), cand("c", "r", 0.7, 400)];
    const r = fill(cs, { tokenBudget: 250, maxPackageShare: 1 });
    expect(r.tokens).toBeLessThanOrEqual(250);
    expect(r.selected.map((c) => c.id)).toEqual(["a", "b"]); // 100 tokens each; two fit in 250
  });

  it("spreads across packages: one package cannot take more than its share when alternatives exist", () => {
    // Package p has the three best scores, but its share of a 400-token budget is 200.
    const cs = [
      cand("p1", "p", 0.9, 200), // 50
      cand("p2", "p", 0.85, 200), // 50
      cand("p3", "p", 0.8, 200), // 50
      cand("p4", "p", 0.75, 200), // 50
      cand("q1", "q", 0.5, 200), // 50
      cand("r1", "r", 0.4, 200), // 50
    ];
    const r = fill(cs, { tokenBudget: 400, maxPackageShare: 0.5 });
    expect(r.byPackage["p"]).toBeLessThanOrEqual(200);
    expect(r.selected.some((c) => c.sourcePkg === "q")).toBe(true);
    expect(r.selected.some((c) => c.sourcePkg === "r")).toBe(true);
  });

  it("the second pass spends leftover budget when the share cannot be used up by other packages", () => {
    // Only one package exists: the share would block it, but pass 2 must still fill.
    const cs = [cand("p1", "p", 0.9, 200), cand("p2", "p", 0.8, 200), cand("p3", "p", 0.7, 200)];
    const r = fill(cs, { tokenBudget: 150, maxPackageShare: 0.3 });
    expect(r.tokens).toBeGreaterThan(0);
    expect(r.selected.length).toBeGreaterThan(0);
  });

  it("every selected item keeps its citation", () => {
    const cs = [cand("a", "p", 0.9, 40), cand("b", "q", 0.8, 40)];
    const r = fill(cs, { tokenBudget: 100, maxPackageShare: 1 });
    expect(r.selected.every((c) => c.citation.merkleRoot.startsWith("root-"))).toBe(true);
    expect(r.selected[0]?.citation.sourceFile).toBe("p/index.ts");
  });

  it("is deterministic and breaks score ties by input order", () => {
    const cs = [cand("first", "p", 0.5, 40), cand("second", "q", 0.5, 40)];
    const a = fill(cs, { tokenBudget: 10, maxPackageShare: 1 }); // 10 tokens each: only one fits
    const b = fill(cs, { tokenBudget: 10, maxPackageShare: 1 });
    expect(a).toEqual(b);
    expect(a.selected.map((c) => c.id)).toEqual(["first"]);
  });

  it("uses a supplied tokenizer", () => {
    const cs = [cand("a", "p", 0.9, 400)];
    const r = fill(cs, { tokenBudget: 10, maxPackageShare: 1, countTokens: () => 5 });
    expect(r.tokens).toBe(5);
  });

  it("rejects invalid options", () => {
    expect(() => fill([], { tokenBudget: 10, maxPackageShare: 0 })).toThrow(RangeError);
    expect(() => fill([], { tokenBudget: 10, maxPackageShare: 1.5 })).toThrow(RangeError);
    expect(() => fill([], { tokenBudget: -1, maxPackageShare: 1 })).toThrow(RangeError);
  });
});
