// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { authorityDelta } from "./authority.js";

describe("authorityDelta — differential authority (WI-GUARD A1, #1254)", () => {
  it("reports no added authority for an identical implementation", () => {
    const src = "export function f(a: number, b: number): number { return a + b; }";
    const d = authorityDelta(src, src);
    expect(d).toEqual({ comparable: true, addsAuthority: false, added: [] });
  });

  it("a candidate that lets a parameter reach the result, which the reference does not, adds authority", () => {
    // Reference ignores `b`. Candidate uses it, so `b` now influences the result.
    const reference = "export function f(a: number, b: number): number { return a; }";
    const candidate = "export function f(a: number, b: number): number { return a + b; }";
    const d = authorityDelta(candidate, reference);
    expect(d.comparable).toBe(true);
    if (!d.comparable) return;
    expect(d.addsAuthority).toBe(true);
    expect(d.added.map((e) => e.paramIndex)).toEqual([1]);
    expect(d.added[0]?.witness).toBeTruthy();
  });

  it("a candidate that removes a flow is a refinement, so it adds nothing", () => {
    const reference = "export function f(a: number, b: number): number { return a + b; }";
    const candidate = "export function f(a: number, b: number): number { return a; }";
    expect(authorityDelta(candidate, reference)).toEqual({
      comparable: true,
      addsAuthority: false,
      added: [],
    });
  });

  it("different boundary arity is not comparable, never reported as clean", () => {
    const reference = "export function f(a: number): number { return a; }";
    const candidate = "export function f(a: number, b: number): number { return a; }";
    expect(authorityDelta(candidate, reference)).toEqual({
      comparable: false,
      reason: "boundary-mismatch",
    });
  });

  it("a source that does not lift is not comparable", () => {
    const ok = "export function f(a: number): number { return a; }";
    expect(authorityDelta("export function f( {", ok)).toEqual({
      comparable: false,
      reason: "unliftable",
    });
    expect(authorityDelta(ok, "}}} {{{")).toEqual({ comparable: false, reason: "unliftable" });
  });
});
