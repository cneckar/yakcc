// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vitest";
import { decideFallback, tallyDecisions } from "./fallback.js";

describe("gap-gated fallback (WI-REUSE B6, #1263)", () => {
  it("reuses the best candidate when it is a strong match and leaves no residual", () => {
    expect(
      decideFallback({ scores: [0.4, 0.92, 0.5], strongThreshold: 0.8, unexplainedCount: 0 }),
    ).toEqual({
      action: "reuse",
      reason: "strong-match",
      candidateIndex: 1,
    });
  });

  it("synthesizes on a near-miss only: no candidate reaches the threshold", () => {
    expect(
      decideFallback({ scores: [0.5, 0.6], strongThreshold: 0.8, unexplainedCount: 0 }),
    ).toEqual({
      action: "synthesize",
      reason: "near-miss-only",
    });
  });

  it("synthesizes when there are no candidates at all", () => {
    expect(decideFallback({ scores: [], strongThreshold: 0.8, unexplainedCount: 0 })).toEqual({
      action: "synthesize",
      reason: "near-miss-only",
    });
  });

  it("a strong match with an unexplained residual still triggers synthesis, for the residual", () => {
    expect(decideFallback({ scores: [0.95], strongThreshold: 0.8, unexplainedCount: 2 })).toEqual({
      action: "synthesize",
      reason: "unexplained-residual",
      candidateIndex: 0,
    });
  });

  it("the threshold is inclusive", () => {
    expect(
      decideFallback({ scores: [0.8], strongThreshold: 0.8, unexplainedCount: 0 }).action,
    ).toBe("reuse");
  });

  it("tallies decisions and reports the synthesis rate and its causes", () => {
    const decisions = [
      decideFallback({ scores: [0.95], strongThreshold: 0.8, unexplainedCount: 0 }),
      decideFallback({ scores: [0.3], strongThreshold: 0.8, unexplainedCount: 0 }),
      decideFallback({ scores: [0.95], strongThreshold: 0.8, unexplainedCount: 1 }),
      decideFallback({ scores: [0.95], strongThreshold: 0.8, unexplainedCount: 0 }),
    ];
    expect(tallyDecisions(decisions)).toEqual({
      reuse: 2,
      synthesizeNearMiss: 1,
      synthesizeResidual: 1,
      synthesisRate: 0.5,
    });
    expect(tallyDecisions([]).synthesisRate).toBe(0);
  });
});
