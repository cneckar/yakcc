// SPDX-License-Identifier: MIT
import type { BlockMerkleRoot } from "@yakcc/contracts";
import { describe, expect, it } from "vitest";
import { type VarianceScoreEntry, annotateAuthority } from "./variance-rank.js";

const root = (s: string) => s as unknown as BlockMerkleRoot;
const entry = (r: string, score: number): VarianceScoreEntry => ({
  merkleRoot: root(r),
  score,
  dimensions: {} as VarianceScoreEntry["dimensions"],
});

describe("annotateAuthority — differential authority in ranking (WI-GUARD A1, #1254)", () => {
  const REF = "export function f(a: number, b: number): number { return a; }";
  const WIDER = "export function f(a: number, b: number): number { return a + b; }";

  it("annotates non-reference candidates against the top-ranked reference", () => {
    const ranked = [entry("r1", 0.9), entry("r2", 0.8)];
    const out = annotateAuthority(
      ranked,
      new Map([
        [root("r1"), REF],
        [root("r2"), WIDER],
      ]),
    );
    expect(out[0]?.authority).toBeUndefined(); // the reference carries no delta
    expect(out[1]?.authority).toMatchObject({ comparable: true, addsAuthority: true });
  });

  it("never reorders the ranking", () => {
    const ranked = [entry("r1", 0.9), entry("r2", 0.8), entry("r3", 0.7)];
    const out = annotateAuthority(
      ranked,
      new Map([
        [root("r1"), REF],
        [root("r2"), REF],
        [root("r3"), WIDER],
      ]),
    );
    expect(out.map((e) => e.merkleRoot)).toEqual(ranked.map((e) => e.merkleRoot));
  });

  it("leaves a candidate unannotated when its source is unknown", () => {
    const out = annotateAuthority(
      [entry("r1", 0.9), entry("r2", 0.8)],
      new Map([[root("r1"), REF]]),
    );
    expect(out[1]?.authority).toBeUndefined();
  });

  it("returns the input unchanged when there is no reference source", () => {
    const ranked = [entry("r1", 0.9)];
    expect(annotateAuthority(ranked, new Map())).toEqual(ranked);
  });
});
