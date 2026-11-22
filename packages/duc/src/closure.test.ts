// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { closureOf } from "./closure.js";
import { liftAtom } from "./lift.js";

describe("closure (P7, #1275)", () => {
  it("an atom with no references is closed", () => {
    expect(
      closureOf(liftAtom("export function f(a: number): number { return a + 1; }")).closed,
    ).toBe(true);
  });

  it("a platform primitive keeps an atom closed and is reported as a primitive", () => {
    const r = closureOf(liftAtom("export function f(s: string): string { return encodeURI(s); }"));
    expect(r.closed).toBe(true);
    expect(r.primitives).toEqual(["encodeURI"]);
  });

  it("a reference to nothing is an unlinked reference, and the atom is not closed", () => {
    const r = closureOf(liftAtom("export function f(a: number): number { return g(a); }"));
    expect(r.closed).toBe(false);
    expect(r.unlinked).toEqual(["g"]);
  });

  it("a reference linked to a corpus atom by spec id closes the atom", () => {
    const g = liftAtom("export function f(a: number): number { return g(a); }");
    const r = closureOf(g, { linked: new Set(["g"]) });
    expect(r.closed).toBe(true);
    expect(r.linked).toEqual(["g"]);
  });
});
