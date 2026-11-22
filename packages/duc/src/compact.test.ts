// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { canonicalJson } from "./canonical.js";
import { decodeGraph, encodeGraph } from "./compact.js";
import { liftAtom } from "./lift.js";

const SOURCES = [
  "export function f(a: number): number { return a + 1; }",
  "export function f(c: boolean, x: number): number { let y = 0; if (c) { y = x; } return y; }",
  "export function g(xs: number[]): number { let s = 0; for (const x of xs) { s += x; } return s; }",
  "class C { m (range, options) { return new C(range, options) } }",
  "export function h(p: string): string { return encodeURI(readFileSync(p)); }",
];

describe("compact graph encoding", () => {
  for (const src of SOURCES) {
    it(`round-trips losslessly: ${src.slice(0, 48)}`, () => {
      const g = liftAtom(src);
      expect(canonicalJson(decodeGraph(encodeGraph(g)))).toBe(canonicalJson(g));
    });
  }

  it("is smaller than the canonical JSON it encodes", () => {
    const g = liftAtom(SOURCES[2] as string);
    expect(JSON.stringify(encodeGraph(g)).length).toBeLessThan(JSON.stringify(g).length);
  });

  it("refuses a graph that is not in canonical numbering", () => {
    const g = liftAtom(SOURCES[0] as string);
    const scrambled = { ...g, nodes: [...g.nodes].reverse() };
    expect(() => encodeGraph(scrambled)).toThrow(/canonical numbering/);
  });
});
