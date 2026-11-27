// SPDX-License-Identifier: Apache-2.0
// The `if` / `else` / `end` / `join` directives of the line form (structured control, #1275).
import { describe, expect, it } from "vitest";
import { graphIdentity } from "./canonical.js";
import { decodeGraph, encodeGraph } from "./compact.js";
import { liftAtom } from "./lift.js";
import { LineFormError, parseLineForm, printLineForm } from "./line-form.js";

const SOURCES = [
  "export function f(c: boolean, x: number, y: number): number { let r = 0; if (c) { r = x + 1; } else { r = y - 1; } return r; }",
  "export function f(c: boolean, x: number): number { let r = x; if (c) { r = x * 2; } return r; }",
  "export function f(a: boolean, b: boolean, x: number): number { let r = x; if (a) { if (b) { r = x + 1; } else { r = x - 1; } } return r; }",
  "export function f(c: boolean, x: number): number { let r = x; if (c) { r = Math.abs(x); } return Math.abs(r); }",
  "export function f(a: number, b: number): number { let r = a; if (b > a) { r = b; } return r; }",
];

describe("structured if in the line form (#1275)", () => {
  for (const src of SOURCES) {
    it(`prints and parses back to the same structure: ${src.slice(40, 110)}`, () => {
      const g = liftAtom(src);
      const text = printLineForm(g);
      expect(graphIdentity(parseLineForm(text))).toBe(graphIdentity(g));
    });
  }

  it("the printed text shows the block, its else-side and the join after the end", () => {
    const text = printLineForm(liftAtom(SOURCES[0] as string));
    const lines = text.trim().split("\n");
    const ifAt = lines.indexOf(lines.find((l) => l.startsWith("if ")) as string);
    const elseAt = lines.indexOf("else");
    const endAt = lines.indexOf("end");
    expect(ifAt).toBeGreaterThan(-1);
    expect(ifAt).toBeLessThan(elseAt);
    expect(elseAt).toBeLessThan(endAt);
    expect(lines[endAt + 1]?.startsWith("join ")).toBe(true);
  });

  it("a hand-written if parses to the graph the lifter produces for the same function", () => {
    const text = [
      "# let r = x; if (c) { r = x * 2 }; return r",
      "param c prim",
      "param x prim",
      "if c",
      'lit "2" -> k',
      "op * x k -> t",
      "end",
      "join r c t x",
      "out r",
    ].join("\n");
    expect(graphIdentity(parseLineForm(text))).toBe(graphIdentity(liftAtom(SOURCES[1] as string)));
  });

  it("a ternary inside a branch prints as select inside the branch, and round-trips", () => {
    const src =
      "export function f(c: boolean, d: boolean, x: number): number { let r = x; if (c) { r = d ? x + 1 : x - 1; } return r; }";
    const g = liftAtom(src);
    const text = printLineForm(g);
    expect(text).toMatch(/^select /m);
    expect(graphIdentity(parseLineForm(text))).toBe(graphIdentity(g));
  });

  it("select takes a condition and two values, and defines its result", () => {
    const g = parseLineForm('param c\nparam x\nlit "0" -> z\nselect r c x z\nout r\n');
    expect(g.nodes.some((n) => n.kind === "sel")).toBe(true);
    expect(graphIdentity(parseLineForm(printLineForm(g)))).toBe(graphIdentity(g));
  });

  it("select with the wrong number of operands is an error", () => {
    expect(() => parseLineForm("param c\nparam x\nselect r c x\n")).toThrow(/expected: select/);
  });

  it("an if with an empty body has no effect, so it is no branch, and round-trips", () => {
    const text = "param c\nif c\nend\nout c\n";
    const g = parseLineForm(text);
    expect(g.branches).toBeUndefined();
    expect(graphIdentity(g)).toBe(graphIdentity(parseLineForm("param c\nout c\n")));
    expect(graphIdentity(parseLineForm(printLineForm(g)))).toBe(graphIdentity(g));
  });

  it("two ifs on the same condition, one after the other, round-trip", () => {
    const text = [
      "param c",
      "param x",
      "if c",
      "op - x -> a",
      "end",
      "join p c a x",
      "if c",
      "op + p x -> b",
      "end",
      "join q c b p",
      "out q",
    ].join("\n");
    const g = parseLineForm(text);
    expect(g.branches?.length).toBe(2);
    expect(graphIdentity(parseLineForm(printLineForm(g)))).toBe(graphIdentity(g));
  });

  it("nested branches survive the compact encoding", () => {
    const g = liftAtom(SOURCES[2] as string);
    const back = decodeGraph(encodeGraph(g));
    expect(back.branches).toEqual(g.branches);
    expect(graphIdentity(back)).toBe(graphIdentity(g));
  });

  it("a return on some paths takes the rest of the function onto both sides, joins into one observation, and prints", () => {
    const src =
      "export function f(c: boolean, x: number): number { if (c) { if (x > 0) { return 1; } } return x; }";
    const g = liftAtom(src);
    expect(g.obs.length).toBe(1);
    // The rest (`return x`) is on both sides of the outer if and the else of the inner one (#1276).
    expect(g.nodes.some((n) => n.origin?.kind === "ReturnSelect")).toBe(false);
    expect(g.nodes.filter((n) => n.origin?.kind === "IfReturn")).toHaveLength(2);
    expect(graphIdentity(parseLineForm(printLineForm(g)))).toBe(graphIdentity(g));
  });

  it("a return inside an iterating loop is a loop with a condition, and one observation (#1276)", () => {
    const g = liftAtom(
      "export function f(xs: number[]): number { for (const x of xs) { if (x > 0) { return x; } } return 0; }",
    );
    const text = printLineForm(g);
    expect(text).toMatch(/\nwhile /);
    expect(g.obs.length).toBe(1);
    expect(graphIdentity(parseLineForm(text))).toBe(graphIdentity(g));
  });

  it("early returns on every path become one observation, the join of the returns", () => {
    const src =
      "export function f(c: boolean, x: number): number { if (c) { return x + 1; } return x - 1; }";
    const g = liftAtom(src);
    expect(g.obs.length).toBe(1);
    expect(g.nodes.some((n) => n.kind === "sel" && n.origin?.kind === "IfReturn")).toBe(true);
    expect(graphIdentity(parseLineForm(printLineForm(g)))).toBe(graphIdentity(g));
  });

  it("an early return keeps its branch, so it is a different structure from the equivalent ternary", () => {
    // Option B (#1275): the branch is part of the structure, as it is for an if that assigns.
    const early = liftAtom(
      "export function f(c: boolean, x: number): number { if (c) { return x + 1; } return x - 1; }",
    );
    const ternary = liftAtom(
      "export function f(c: boolean, x: number): number { return c ? x + 1 : x - 1; }",
    );
    expect(early.branches?.length).toBe(1);
    expect(ternary.branches).toBeUndefined();
    expect(graphIdentity(early)).not.toBe(graphIdentity(ternary));
    expect(graphIdentity(parseLineForm(printLineForm(ternary)))).toBe(graphIdentity(ternary));
  });

  it("the return of a total if depends on its condition", () => {
    const g = liftAtom(
      "export function f(c: boolean, x: number): number { if (c) { return x; } return 0 - x; }",
    );
    const sel = g.nodes.find((n) => n.kind === "sel" && n.origin?.kind === "IfReturn");
    expect(sel?.inputs[0]).toBe(g.branches?.[0]?.cond);
  });

  describe("scope and structure errors", () => {
    it("a name defined inside the then-side is not visible after the end", () => {
      const text = 'param c\nparam x\nif c\nlit "2" -> k\nend\nop + k x -> r\nout r\n';
      expect(() => parseLineForm(text)).toThrow(/line 6.*"k" is used before it is defined/);
    });

    it("a name from the then-side is not visible on the else-side", () => {
      const text = 'param c\nif c\nlit "1" -> a\nelse\nop + a a -> r\nend\n';
      expect(() => parseLineForm(text)).toThrow(/line 5.*"a" is used before it is defined/);
    });

    it("a join names only values that are visible on its own sides", () => {
      const text = 'param c\nparam x\nif c\nlit "1" -> k\nelse\nend\njoin r c x k\n';
      expect(() => parseLineForm(text)).toThrow(/"k" is not visible on the else-side/);
    });

    it("a join must directly follow the end of its if", () => {
      const text = 'param c\nparam x\nif c\nend\nlit "1" -> k\njoin r c x x\n';
      expect(() => parseLineForm(text)).toThrow(/must directly follow the end/);
    });

    it("a join must use the condition of its own if", () => {
      const text = "param c\nparam d\nif c\nend\njoin r d c c\n";
      expect(() => parseLineForm(text)).toThrow(/uses the condition of its if/);
    });

    it("a branch whose sides only take existing values round-trips", () => {
      const text = "param c\nparam x\nparam y\nif c\nend\njoin r c x y\nout r\n";
      const g = parseLineForm(text);
      expect(graphIdentity(parseLineForm(printLineForm(g)))).toBe(graphIdentity(g));
    });

    it("an if that is not closed is an error at the if's line", () => {
      expect(() => parseLineForm("param c\nif c\n")).toThrow(/line 2: if is not closed by end/);
    });

    it("an end without an if, and an else without an if, are errors", () => {
      expect(() => parseLineForm("param c\nend\n")).toThrow(/end without an if/);
      expect(() => parseLineForm("param c\nelse\n")).toThrow(/else must follow/);
    });

    it("a parameter cannot appear inside an if", () => {
      expect(() => parseLineForm("param c\nif c\nparam x\nend\n")).toThrow(
        /param must come before any if/,
      );
    });

    it("an observation cannot appear inside an if", () => {
      expect(() => parseLineForm('param c\nif c\nlit "1" -> k\nout k\nend\n')).toThrow(
        LineFormError,
      );
    });
  });
});
