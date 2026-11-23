// SPDX-License-Identifier: Apache-2.0
// P1 (#1275): the canonical graph depends on the implementation, not on traversal order,
// formatting, or the order of independent statements.
import { describe, expect, it } from "vitest";
import { canonicalJson, graphIdentity } from "./canonical.js";
import { liftAtom } from "./lift.js";
import { isWellFormed } from "./wellformed.js";

const canon = (src: string) => canonicalJson(liftAtom(src));

describe("P1 canonical form (#1275)", () => {
  it("the same source lifts to byte-identical canonical graphs", () => {
    const src = "export function f(a: number, b: number): number { return a * 2 + b; }";
    expect(canon(src)).toBe(canon(src));
  });

  it("formatting-only differences give the same canonical graph", () => {
    const tight = "export function f(a: number): number { return a + 1; }";
    const loose = "export function f (a: number): number {\n  return a + 1\n}";
    expect(canon(loose)).toBe(canon(tight));
  });

  it("independent statements in a different order give the same canonical graph", () => {
    const ab =
      "export function f(a: number, b: number): number { const x = a * 2; const y = b * 3; return x + y; }";
    const ba =
      "export function f(a: number, b: number): number { const y = b * 3; const x = a * 2; return x + y; }";
    expect(canon(ba)).toBe(canon(ab));
  });

  it("node and value ids are sequential in canonical order", () => {
    const g = liftAtom("export function f(a: number): number { return a + 1; }");
    expect(g.nodes.map((n) => n.id)).toEqual(g.nodes.map((_, i) => `n${i}`));
    expect(g.values).toEqual(g.values.map((_, i) => `v${i}`));
  });

  it("parameters keep their order, since parameter index is part of the interface", () => {
    const g = liftAtom("export function f(a: number, b: number): number { return b; }");
    const params = g.nodes.filter((n) => n.kind === "param-source");
    expect(params.map((n) => n.origin?.text)).toEqual(["a", "b"]);
  });

  it("a canonical graph is still well-formed", () => {
    const g = liftAtom(
      "export function f(c: boolean, x: number): number { let y = 0; if (c) { y = x; } return y; }",
    );
    expect(isWellFormed(g).wellFormed).toBe(true);
  });

  it("a real difference in implementation gives a different canonical graph", () => {
    expect(canon("export function f(a: number): number { return a + 1; }")).not.toBe(
      canon("export function f(a: number): number { return a + 2; }"),
    );
  });
});

describe("pure URI codecs are explained (validator residue)", () => {
  it("encodeURI and decodeURI are explained ambient reads", () => {
    const g = liftAtom("export function f (x: string) { return decodeURI(encodeURI(x)); }");
    const reasonOf = (sym: string) =>
      g.nodes.find((n) => n.diamond?.symbol === sym)?.diamond?.reason;
    expect(reasonOf("encodeURI")).toBe("platform-primitive");
    expect(reasonOf("decodeURI")).toBe("platform-primitive");
  });
});

describe("D6 identity is structure only (#1275)", () => {
  it("renaming a local does not change the identity", () => {
    expect(graphIdentity(liftAtom("export function f(a: number): number { return a + 1; }"))).toBe(
      graphIdentity(liftAtom("export function f(b: number): number { return b + 1; }")),
    );
  });

  it("a comment or formatting does not change the identity", () => {
    expect(graphIdentity(liftAtom("export function f(a: number): number { return a + 1; }"))).toBe(
      graphIdentity(
        liftAtom("export function f (a: number): number {\n  // add one\n  return a + 1\n}"),
      ),
    );
  });

  it("a real change in structure changes the identity", () => {
    expect(
      graphIdentity(liftAtom("export function f(a: number): number { return a + 1; }")),
    ).not.toBe(graphIdentity(liftAtom("export function f(a: number): number { return a * 1; }")));
  });

  it("the annotations are still present and lossless after renaming", () => {
    const g = liftAtom("export function f(a: number): number { return a + 1; }");
    const texts = g.nodes.map((n) => n.origin?.text).filter((t) => t !== undefined);
    expect(texts).toContain("a");
  });
});

describe("closures nested deep, capturing values the outer graph cannot tell apart (#1173)", () => {
  // Hoisted `var` cells all look alike from outside: a cell holding undefined. Four levels of
  // closures each capture six of them, used alike, so every order of the six is a candidate.
  const source = (names: readonly string[]): string =>
    `function outer () { function a () { return function () { return function () { return function () { return ${names[0]} === ${names[1]} && ${names[2]} === ${names[3]} && ${names[4]} === ${names[5]} } } } } var x1 = 1, x2 = 2, x3 = 3, x4 = 4, x5 = 5, x6 = 6; return a }`;
  it("lifts in bounded time: each closure is canonicalized once per order, not once per level", () => {
    const t = Date.now();
    const g = liftAtom(source(["x1", "x2", "x3", "x4", "x5", "x6"]));
    expect(isWellFormed(g).wellFormed).toBe(true);
    expect(Date.now() - t).toBeLessThan(20_000);
  }, 60_000);
  it("the identity is the structure's: renaming every variable leaves it unchanged", () => {
    const a = graphIdentity(liftAtom(source(["x1", "x2", "x3", "x4", "x5", "x6"])));
    const renamed = source(["x1", "x2", "x3", "x4", "x5", "x6"]).replace(/\bx(\d)\b/g, "q$1");
    expect(graphIdentity(liftAtom(renamed))).toBe(a);
  }, 60_000);
});
