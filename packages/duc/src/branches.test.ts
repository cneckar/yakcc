// SPDX-License-Identifier: Apache-2.0
// Structured `if` (option B, #1275): branches are recorded, their operations carry a region path,
// and the identity sees the branch structure.
import { describe, expect, it } from "vitest";
import { graphIdentity } from "./canonical.js";
import { decodeGraph, encodeGraph } from "./compact.js";
import { liftAtom } from "./lift.js";

const IF =
  "export function f(c: boolean, x: number, y: number): number { let r = 0; if (c) { r = x + 1; } else { r = y - 1; } return r; }";

describe("structured if (option B, #1275)", () => {
  it("an if records one branch, whose condition is the test value", () => {
    const g = liftAtom(IF);
    expect(g.branches?.length).toBe(1);
    expect(g.branches?.[0]?.id).toBe("b0");
  });

  it("the operations of each side carry their side of the branch, and the join sits outside", () => {
    const g = liftAtom(IF);
    const regions = g.nodes.map((n) => n.region).filter((r) => r !== undefined);
    expect(regions).toContain("b0.t");
    expect(regions).toContain("b0.e");
    const join = g.nodes.find((n) => n.kind === "sel");
    expect(join?.region).toBeUndefined();
  });

  it("a program with no if records no branches", () => {
    const g = liftAtom("export function f(a: number): number { return a + 1; }");
    expect(g.branches).toBeUndefined();
  });

  it("the branch structure survives the compact encoding", () => {
    const g = liftAtom(IF);
    expect(graphIdentity(decodeGraph(encodeGraph(g)))).toBe(graphIdentity(g));
    expect(decodeGraph(encodeGraph(g)).branches).toEqual(g.branches);
  });

  it("renaming the condition and the locals does not change the identity", () => {
    const renamed =
      "export function f(k: boolean, p: number, q: number): number { let s = 0; if (k) { s = p + 1; } else { s = q - 1; } return s; }";
    expect(graphIdentity(liftAtom(renamed))).toBe(graphIdentity(liftAtom(IF)));
  });

  it("a different branch structure gives a different identity", () => {
    const flatter =
      "export function f(c: boolean, x: number, y: number): number { let r = 0; if (c) { r = x + 1; } return r; }";
    expect(graphIdentity(liftAtom(flatter))).not.toBe(graphIdentity(liftAtom(IF)));
  });

  it("two independent ifs written in either order have the same identity", () => {
    const ab =
      "export function f(a: boolean, b: boolean, x: number, y: number): number { let p = 0; let q = 0; if (a) { p = x; } if (b) { q = y; } return p + q; }";
    const ba =
      "export function f(a: boolean, b: boolean, x: number, y: number): number { let p = 0; let q = 0; if (b) { q = y; } if (a) { p = x; } return p + q; }";
    expect(graphIdentity(liftAtom(ba))).toBe(graphIdentity(liftAtom(ab)));
  });
});
