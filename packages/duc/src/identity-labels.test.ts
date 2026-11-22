// SPDX-License-Identifier: Apache-2.0
// Identity is lossless (#1275, D6): every token that distinguishes two programs is in the structure,
// in an operation's label when it is not an input. Two different programs never share an identity.
import { describe, expect, it } from "vitest";
import { graphIdentity } from "./canonical.js";
import { liftAtom } from "./lift.js";
import { parseLineForm, printLineForm } from "./line-form.js";

const f = (body: string, params = "x: number"): string => `export function f(${params}): unknown { ${body} }`;

const DIFFERENT: [string, string, string][] = [
  ["member name", f("return Math.abs(x);"), f("return Math.floor(x);")],
  ["property read", f("return o.a;", "o: { a: number; b: number }"), f("return o.b;", "o: { a: number; b: number }")],
  ["object key", f("return { a: x };"), f("return { b: x };")],
  ["object spread", f("return { ...o };", "o: object"), f("return { o };", "o: object")],
  ["template text", f("return `a${x}`;"), f("return `b${x}`;")],
  ["unary operator", f("return -x;"), f("return +x;")],
  ["prefix and postfix", f("let y = x; return ++y;"), f("let y = x; return y++;")],
  ["closure body", f("const g = () => 1; return g();"), f("const g = () => 2; return g();")],
  ["thrown value", f("throw new Error('a');"), f("throw new Error('b');")],
  ["written member", f("const o = { a: 0, b: 0 }; o.a = x; return o;"), f("const o = { a: 0, b: 0 }; o.b = x; return o;")],
  ["optional chain", f("return o?.a;", "o: { a: number }"), f("return o.a;", "o: { a: number }")],
];

describe("identity tells apart programs that differ in a token (D6)", () => {
  for (const [name, a, b] of DIFFERENT) {
    it(name, () => {
      expect(graphIdentity(liftAtom(a))).not.toBe(graphIdentity(liftAtom(b)));
    });
  }

  it("renaming a parameter that a closure reads keeps the identity", () => {
    const a = "export function f(a: number): number { const g = () => a + 1; return g(); }";
    const b = "export function f(q: number): number { const g = () => q + 1; return g(); }";
    expect(graphIdentity(liftAtom(b))).toBe(graphIdentity(liftAtom(a)));
  });

  it("member, object and template labels round-trip through the line form", () => {
    const g = liftAtom(f("return { k: o.size, t: `a b ${o.size}` };", "o: { size: number }"));
    expect(graphIdentity(parseLineForm(printLineForm(g)))).toBe(graphIdentity(g));
  });

  it("a hand-written member read matches the lifted one", () => {
    const text = ["param s", "op .length s -> n", "out n"].join("\n");
    expect(graphIdentity(parseLineForm(text))).toBe(graphIdentity(liftAtom("export function f(s: string): number { return s.length; }")));
  });
});
