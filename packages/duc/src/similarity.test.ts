// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { graphIdentity } from "./canonical.js";
import { liftAtom } from "./lift.js";
import { rankStructurally, structuralBag, structuralDistance } from "./similarity.js";

const g = (src: string) => liftAtom(src);

describe("structural distance (#1280)", () => {
  it("is zero for the same structure, whatever the names", () => {
    expect(
      structuralDistance(
        g("export function f(a: number) { return a * 2 + 1; }"),
        g("export function f(zz: number) { return zz * 2 + 1; }"),
      ),
    ).toBe(0);
  });

  it("a redundant + 0 is nearer the original than another function is", () => {
    const original = g(
      "export function f(a: number, b: number) { return Math.max(a, b) - Math.min(a, b); }",
    );
    const rewritten = g(
      "export function f(a: number, b: number) { return Math.max(a + 0, b) - Math.min(a, b); }",
    );
    const other = g(
      "export function f(a: number, b: number) { return Math.max(a, b) + Math.max(b, a); }",
    );
    expect(structuralDistance(rewritten, original)).toBeLessThan(
      structuralDistance(rewritten, other),
    );
  });

  it("selection puts an identical candidate first, then the nearest", () => {
    const q = g("export function f(s: string) { return s.trim().length + 0; }");
    const items = [
      g("export function f(s: string) { return s.trim().toUpperCase(); }"),
      g("export function f(s: string) { return s.trim().length; }"),
      g("export function f(s: string) { return s.trim().length + 0; }"),
    ].map((x, i) => ({
      item: i,
      identity: graphIdentity(x),
      bag: structuralBag(x),
      score: [0.9, 0.8, 0.1][i] as number,
    }));
    expect(rankStructurally(graphIdentity(q), structuralBag(q), items).map((c) => c.item)).toEqual([
      2, 1, 0,
    ]);
    const withoutExact = items.slice(0, 2);
    expect(
      rankStructurally(graphIdentity(q), structuralBag(q), withoutExact).map((c) => c.item),
    ).toEqual([1, 0]);
  });

  it("a comparison written the other way round is the same structure for selection", () => {
    const lt = g("export function f(a: number, b: number) { return a < b ? a : b; }");
    const gt = g("export function f(a: number, b: number) { return b > a ? a : b; }");
    const max = g("export function f(a: number, b: number) { return a > b ? a : b; }");
    // Identity keeps them apart; selection does not.
    expect(graphIdentity(gt)).not.toBe(graphIdentity(lt));
    expect(structuralDistance(gt, lt)).toBe(0);
    // min and max stay apart: parameters enter by position.
    expect(structuralDistance(max, lt)).toBeGreaterThan(0);
  });

  it("tells apart equal producers feeding a comparison the other way round", () => {
    // isBefore and isAfter: the same calls, compared the other way round.
    const before = g(
      "export function f(a: string, b: string) { const x = h(a); const y = h(b); return x < y; }",
    );
    const after = g(
      "export function f(a: string, b: string) { const x = h(a); const y = h(b); return x > y; }",
    );
    const afterFlipped = g(
      "export function f(a: string, b: string) { const x = h(a); const y = h(b); return y < x; }",
    );
    expect(structuralDistance(afterFlipped, after)).toBe(0);
    expect(structuralDistance(afterFlipped, before)).toBeGreaterThan(0);
  });
});
