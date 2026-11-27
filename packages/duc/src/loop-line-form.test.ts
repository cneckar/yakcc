import { describe, expect, it } from "vitest";
import { graphIdentity } from "./canonical.js";
import { liftAtom } from "./lift.js";
import { parseLineForm, printLineForm } from "./line-form.js";
// SPDX-License-Identifier: Apache-2.0
// The `loop` directives of the line form (loops, #1275): a loop prints as a block whose body reads
// the outside only through its invariants, and parses back to the same structure.
import { paramIndex } from "./params.js";

const SOURCES = [
  "export function f(n: number, x: number): number { let s = 0; let i = 0; while (i < n) { s = s + x; i = i + 1; } return s; }",
  "export function f(n: number): number { let s = 0; for (let i = 0; i < n; i = i + 1) { s = s + i; } return s; }",
  "export function f(n: number, x: number): number { let s = 0; for (let i = 0; i < n; i = i + 1) { let j = 0; while (j < 2) { s = s + x; j = j + 1; } } return s; }",
  "export function f(c: boolean, n: number): number { let s = 0; if (c) { for (let i = 0; i < n; i = i + 1) { s = s + i; } } return s; }",
  "export function f(n: number): number { let s = 0; for (let i = 0; i < n; i = i + 1) { if (i > 2) { s = s + 1; } else { s = s - 1; } } return s; }",
];

describe("loops in the line form (#1275)", () => {
  for (const src of SOURCES) {
    it(`prints and parses back to the same structure: ${src.slice(40, 120)}`, () => {
      const g = liftAtom(src);
      expect(graphIdentity(parseLineForm(printLineForm(g)))).toBe(graphIdentity(g));
    });
  }

  it("the printed text shows the loop's header, sources, body, condition, next values and results", () => {
    const text = printLineForm(liftAtom(SOURCES[0] as string));
    expect(text).toMatch(/^loop .* with /m);
    expect(text).toMatch(/^carry /m);
    expect(text).toMatch(/^invariant /m);
    expect(text).toMatch(/^while /m);
    expect(text).toMatch(/^next /m);
    expect(text).toMatch(/^end /m);
  });

  it("a hand-written while loop parses to the graph the lifter produces for it", () => {
    const text = [
      // Declared numbers (#1370): no operator on them is ordered. The loop still carries the heap
      // token, as the lifter decides by the body's syntax whether it may need it.
      "param n prim",
      "param x prim",
      'lit "0" -> s0',
      'lit "0" -> i0',
      'lit "undefined" -> h0',
      "loop s0 i0 h0 with n x",
      "carry s i ^h",
      "invariant nn xx",
      "op + s xx -> s2",
      'lit "1" -> one',
      "op + i one -> i2",
      "op < i nn -> c",
      "while c",
      "next s2 i2 h",
      "end r ii hh",
      "out r",
    ].join("\n");
    expect(graphIdentity(parseLineForm(text))).toBe(graphIdentity(liftAtom(SOURCES[0] as string)));
  });

  it("an outer loop takes as input every outer value its body reads, through nested loops", () => {
    // `x` is read by the inner loop only. The outer loop's results depend on it, so the graph must
    // show that: the outer loop's inputs include the parameter x, as an invariant.
    const g = liftAtom(SOURCES[2] as string);
    const outer = g.nodes.find((n) => n.kind === "loop" && n.region === undefined);
    const param = g.nodes.find((n) => n.kind === "param-source" && paramIndex(n.label) === 1);
    expect(outer?.inputs).toContain(param?.outputs[0]);
  });

  describe("iterating loops (3A)", () => {
    const ITERATING = [
      "export function f(xs: number[], k: number): number { let s = 0; for (const x of xs) { s = s + x * k; } return s; }",
      "export function f(o: object): number { let n = 0; for (const key in o) { n = n + 1; } return n; }",
      "export function f(xs: number[], ys: number[]): number { let s = 0; for (const x of xs) { for (const y of ys) { s = s + x * y; } } return s; }",
      "export function f(xs: number[]): number { let s = 0; for (const x of xs) { if (x > 0) { s = s + x; } } return s; }",
    ];
    for (const src of ITERATING) {
      it(`prints and parses back to the same structure: ${src.slice(40, 120)}`, () => {
        const g = liftAtom(src);
        expect(graphIdentity(parseLineForm(printLineForm(g)))).toBe(graphIdentity(g));
      });
    }

    it("a hand-written for...of parses to the graph the lifter produces for it", () => {
      const text = [
        "param xs",
        "param k prim",
        'lit "0" -> s0',
        // An iterating loop reads its iterable at each step, so it carries the heap token (#1285).
        'lit "undefined" -> h0',
        "loop s0 h0 of xs with k",
        "carry s ^h",
        "invariant kk",
        "element x",
        // An element may be an object: the operators on it are ordered (#1370).
        "op * x kk ^h -> t",
        "op + s t ^t -> s2",
        "next s2 s2",
        "end r h1",
        "out r",
      ].join("\n");
      expect(graphIdentity(parseLineForm(text))).toBe(
        graphIdentity(liftAtom(ITERATING[0] as string)),
      );
    });

    it("an iterating loop may have a while, which stops it before an element's body (#1276)", () => {
      const text = [
        "param xs",
        'lit "0" -> s0',
        'lit "undefined" -> h0',
        "loop s0 h0 of xs",
        "carry s ^h",
        "invariant",
        "element x",
        'lit "10" -> ten',
        "op < s ten -> going",
        "while going",
        "op + s x -> s2",
        "next s2 h",
        "end r h1",
        "out r",
      ].join("\n");
      const loop = parseLineForm(text).nodes.find((n) => n.kind === "loop");
      expect(loop?.loop?.cond).toBeDefined();
      expect(loop?.loop?.iterate?.of).toBe("values");
    });

    it("an iterating loop needs its element line", () => {
      const text = 'param xs\nlit "0" -> s0\nloop s0 of xs\ncarry s\ninvariant\nnext s\n';
      expect(() => parseLineForm(text)).toThrow(/expected: element/);
    });
  });

  describe("errors", () => {
    it("a loop that is not closed is an error at its line", () => {
      expect(() => parseLineForm("param n\nloop n\ncarry a\ninvariant\n")).toThrow(
        /line 2: loop is not closed by end/,
      );
    });

    it("a carry line must name each carried variable", () => {
      expect(() => parseLineForm('param n\nlit "0" -> s0\nloop s0\ncarry a b\n')).toThrow(
        /expected 1 name/,
      );
    });

    it("the loop's body must come after its carry and invariant lines", () => {
      expect(() => parseLineForm('param n\nlit "0" -> s0\nloop s0\nlit "1" -> k\n')).toThrow(
        /expected: carry/,
      );
    });

    it("a loop needs while and next before its end", () => {
      expect(() =>
        parseLineForm('param n\nlit "0" -> s0\nloop s0\ncarry a\ninvariant\nend r\n'),
      ).toThrow(/while and next/);
    });

    it("names defined in the body are not visible after the loop", () => {
      const text =
        'param n\nlit "0" -> s0\nloop s0\ncarry a\ninvariant\nlit "1" -> k\nwhile a\nnext a\nend r\nop + k r -> z\n';
      expect(() => parseLineForm(text)).toThrow(/line 10.*"k" is used before it is defined/);
    });

    it("the printer refuses a source that is not a carried or invariant value of a loop", () => {
      const g = liftAtom(SOURCES[0] as string);
      const loop = g.nodes.find((n) => n.kind === "loop");
      if (loop === undefined || loop.loop === undefined) throw new Error("no loop");
      const broken = {
        ...g,
        nodes: g.nodes.map((n) =>
          n.loop !== undefined
            ? {
                ...n,
                loop: { ...n.loop, invariant: [] },
                inputs: n.inputs.slice(0, n.loop.carry.length),
              }
            : n,
        ),
      };
      expect(() => printLineForm(broken)).toThrow(/not a carried or invariant value/);
    });
  });
});
