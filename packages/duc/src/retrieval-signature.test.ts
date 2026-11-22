// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { liftAtom } from "./lift.js";
import { retrievalSignature } from "./retrieval-signature.js";

const sig = (src: string) => retrievalSignature(liftAtom(src));

describe("retrieval signature (#1275, item 3)", () => {
  it("renaming locals and changing formatting does not change the signature", () => {
    expect(sig("export function f(a: number): number { return a + 1; }")).toBe(
      sig("export function f (x: number): number {\n  // add one\n  const y = x + 1;\n  return y;\n}"),
    );
  });

  it("reordering independent statements does not change the signature", () => {
    expect(
      sig("export function f(a: number, b: number): number { const x = a * 2; const y = b * 3; return x + y; }"),
    ).toBe(
      sig("export function f(a: number, b: number): number { const y = b * 3; const x = a * 2; return x + y; }"),
    );
  });

  it("a different operator changes the signature", () => {
    expect(sig("export function f(a: number): number { return a + 1; }")).not.toBe(
      sig("export function f(a: number): number { return a * 1; }"),
    );
  });

  it("the influence matrix tells apart functions that read different parameters", () => {
    expect(sig("export function f(a: number, b: number): number { return a; }")).not.toBe(
      sig("export function f(a: number, b: number): number { return b; }"),
    );
  });

  it("the signature records primitives, unlinked names and control shape", () => {
    const text = sig("export function f(s: string): string { return encodeURI(s) + g(s); }");
    expect(text).toContain('primitives: "encodeURI"');
    expect(text).toContain('unlinked: "g"');
    const branchy = sig("export function f(c: boolean, x: number): number { return c ? x : 0; }");
    expect(branchy).toContain("control: sel=");
  });

  it("the intent text, when given, comes first", () => {
    const g = liftAtom("export function f(a: number): number { return a + 1; }");
    expect(retrievalSignature(g, { intent: "add one" }).startsWith("intent: add one\n")).toBe(true);
  });
});
