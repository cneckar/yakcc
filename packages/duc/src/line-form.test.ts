// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { graphIdentity } from "./canonical.js";
import { liftAtom } from "./lift.js";
import { LineFormError, parseLineForm, printLineForm } from "./line-form.js";

describe("line form (#1275, item 2)", () => {
  const SOURCES = [
    "export function f(a: number): number { return a + 1; }",
    "export function f(a: number, b: number): number { return a * 2 + b; }",
    "export function f(s: string): string { return encodeURI(s) + 'x'; }",
    "export function f(xs: number[]): number { return xs[0] - xs[1]; }",
  ];

  for (const src of SOURCES) {
    it(`prints and parses back to the same structure: ${src.slice(0, 50)}`, () => {
      const g = liftAtom(src);
      const text = printLineForm(g);
      expect(graphIdentity(parseLineForm(text))).toBe(graphIdentity(g));
    });
  }

  it("a model-style text parses to the graph the lifter produces for the same function", () => {
    const text = ["# a + 1", "param a", 'lit "1" -> one', "op + a one -> r", "out r"].join("\n");
    expect(graphIdentity(parseLineForm(text))).toBe(
      graphIdentity(liftAtom("export function f(a: number): number { return a + 1; }")),
    );
  });

  it("the author's names do not affect identity", () => {
    const named = 'param x\nlit "1" -> k\nop + x k -> y\nout y\n';
    const other = 'param a\nlit "1" -> one\nop + a one -> r\nout r\n';
    expect(graphIdentity(parseLineForm(named))).toBe(graphIdentity(parseLineForm(other)));
  });

  it("a name used before it is defined is rejected, with its line", () => {
    expect(() => parseLineForm("param a\nop + a b -> r\nout r\n")).toThrow(LineFormError);
    expect(() => parseLineForm("param a\nop + a b -> r\nout r\n")).toThrow(
      /line 2.*"b" is used before it is defined/,
    );
  });

  it("a name defined twice is rejected", () => {
    expect(() => parseLineForm("param a\nparam a\n")).toThrow(/already defined/);
  });

  it("a do loop prints as a loop with a first-pass flag, and parses back (#1276)", () => {
    const g = liftAtom(
      "export function f(n: number): number { let i = 0; do { i = i + 1; } while (i < n); return i; }",
    );
    expect(graphIdentity(parseLineForm(printLineForm(g)))).toBe(graphIdentity(g));
  });

  it("a ternary prints as select, and parses back to the same structure", () => {
    const g = liftAtom("export function f(c: boolean, x: number): number { return c ? x : 0; }");
    const text = printLineForm(g);
    expect(text).toMatch(/^select /m);
    expect(graphIdentity(parseLineForm(text))).toBe(graphIdentity(g));
  });

  it("an unknown directive is rejected, with its line", () => {
    expect(() => parseLineForm("param a\nfrobnicate a\n")).toThrow(
      /line 2.*unknown directive "frobnicate"/,
    );
  });
});

describe("one unknown, one source (line form)", () => {
  it("two references to the same ambient symbol are one source, as in the lifter", () => {
    const twice =
      "param s\nparam t\nambient encodeURI -> e1\nop CallExpression e1 s -> x\nambient encodeURI -> e2\nop CallExpression e2 t -> y\nop + x y -> r\nout r\n";
    const once =
      "param s\nparam t\nambient encodeURI -> e\nop CallExpression e s -> x\nop CallExpression e t -> y\nop + x y -> r\nout r\n";
    expect(graphIdentity(parseLineForm(twice))).toBe(graphIdentity(parseLineForm(once)));
  });
  it("the lifter's graph for the same function has the same identity", () => {
    expect(
      graphIdentity(
        parseLineForm(
          "param s\nparam t\nambient encodeURI -> e\nop CallExpression e s -> x\nop CallExpression e t ^x -> y\nop + x y -> r\nout r\n",
        ),
      ),
    ).toBe(
      graphIdentity(
        liftAtom(
          "export function f(s: string, t: string): string { return encodeURI(s) + encodeURI(t); }",
        ),
      ),
    );
  });
});

describe("heap order a program does not write (#1288)", () => {
  it("top-level heap operations are ordered as written, as the lifter orders them", () => {
    const written = parseLineForm(
      'param xs\nlit "0" -> zero\nlit "1" -> one\nop ElementAccess xs zero -> x\nop ElementAccess xs one -> y\nop - x y -> r\nout r\n',
    );
    const lifted = liftAtom("export function f(xs: number[]) { return xs[0] - xs[1]; }");
    expect(graphIdentity(written)).toBe(graphIdentity(lifted));
  });

  it("the order written is the order taken: reads swapped are another program", () => {
    const swapped = parseLineForm(
      'param xs\nlit "0" -> zero\nlit "1" -> one\nop ElementAccess xs one -> y\nop ElementAccess xs zero -> x\nop - x y -> r\nout r\n',
    );
    const lifted = liftAtom("export function f(xs: number[]) { return xs[0] - xs[1]; }");
    expect(graphIdentity(swapped)).not.toBe(graphIdentity(lifted));
  });

  it("a program that writes a heap token is taken as written", () => {
    const g = parseLineForm(
      'param xs\nlit "0" -> zero\nlit "1" -> one\nop ElementAccess xs zero -> x\nop ElementAccess xs one ^x -> y\nop - x y -> r\nout r\n',
    );
    expect(g.nodes.filter((n) => n.order === 1)).toHaveLength(1);
  });
});
