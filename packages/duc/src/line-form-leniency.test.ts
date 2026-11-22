// SPDX-License-Identifier: Apache-2.0
/**
 * The line form accepts the ways models wrote the same program in the format-v2 trial (#1283):
 * shadowing names in a loop's header, reading outer values without `with`, `next` before `while`,
 * and literals written once or many times. Each variant must denote the same graph as the strict
 * form. Text that is not a JavaScript literal is refused.
 */
import { describe, expect, it } from "vitest";
import { graphIdentity } from "./canonical.js";
import { parseLineForm, printLineForm } from "./line-form.js";

const id = (lines: string[]): string => graphIdentity(parseLineForm(lines.join("\n")));

const STRICT_SUM = [
  "param n",
  'lit "0" -> zero',
  'lit "1" -> one',
  "loop zero one with n",
  "carry sum i",
  "invariant limit",
  "op <= i limit -> go",
  "op + sum i -> sum2",
  'lit "1" -> step',
  "op + i step -> i2",
  "while go",
  "next sum2 i2",
  "end total last",
  "out total",
];

describe("loop leniency (#1283)", () => {
  it("an invariant may shadow the outer name it stands for", () => {
    const shadowed = STRICT_SUM.map((l) => l.replace("invariant limit", "invariant n").replace("<= i limit", "<= i n"));
    expect(id(shadowed)).toBe(id(STRICT_SUM));
  });

  it("an outer value read by the body is an invariant without with", () => {
    const implicit = STRICT_SUM.filter((l) => l !== "invariant limit").map((l) =>
      l.replace(" with n", "").replace("<= i limit", "<= i n"),
    );
    expect(id(implicit)).toBe(id(STRICT_SUM));
  });

  it("an invariant line without with names outer values", () => {
    const named = STRICT_SUM.map((l) => l.replace(" with n", "").replace("invariant limit", "invariant n").replace("<= i limit", "<= i n"));
    expect(id(named)).toBe(id(STRICT_SUM));
  });

  it("next may come before while", () => {
    const swapped = STRICT_SUM.map((l) => (l === "while go" ? "next sum2 i2" : l === "next sum2 i2" ? "while go" : l));
    expect(id(swapped)).toBe(id(STRICT_SUM));
  });

  it("the header lines may come in any order", () => {
    const iterate = (header: string[]): string =>
      id(["param xs", "param k", 'lit "0" -> zero', "loop zero of xs with k", ...header, "op > x t -> gt", "op + c x -> c2", "select c3 gt c2 c", "next c3", "end r", "out r"]);
    expect(iterate(["element x", "invariant t", "carry c"])).toBe(iterate(["carry c", "invariant t", "element x"]));
  });

  it("carry and element names may shadow outer names", () => {
    const g = parseLineForm(
      ["param x", "param xs", 'lit "0" -> s', "loop s of xs", "carry s", "element x", "op + s x -> s2", "next s2", "end r", "out r"].join("\n"),
    );
    expect(g.nodes.filter((n) => n.kind === "loop")).toHaveLength(1);
  });

  it("nested loops read an outer value through both loops", () => {
    const g = parseLineForm(
      [
        "param n",
        "param x",
        'lit "0" -> zero',
        'lit "1" -> one',
        "loop zero zero",
        "carry s i",
        "op < i n -> go",
        "loop s zero",
        "carry t j",
        'lit "2" -> two',
        "op < j two -> more",
        "op + t x -> t2",
        "op + j one -> j2",
        "while more",
        "next t2 j2",
        "end s2 jj",
        "op + i one -> i2",
        "while go",
        "next s2 i2",
        "end r ii",
        "out r",
      ].join("\n"),
    );
    // x reaches the inner body through an invariant of each loop; n through the outer one.
    const loops = g.nodes.filter((n) => n.kind === "loop");
    expect(loops.map((l) => l.loop?.invariant.length).sort()).toEqual([1, 2]);
    expect(graphIdentity(parseLineForm(printLineForm(g)))).toBe(graphIdentity(g));
  });

  it("a name defined in the body may not shadow", () => {
    expect(() => parseLineForm(["param n", 'lit "0" -> z', "loop z", "carry s", "op + s n -> n", "while n", "next n", "end r", "out r"].join("\n"))).toThrow(
      /already defined/,
    );
  });
});

describe("literals (#1283)", () => {
  it("one literal written twice is one literal", () => {
    const once = ["param x", 'lit "0" -> zero', "op < x zero -> neg", "op - zero x -> r", "out r"];
    const twice = ["param x", 'lit "0" -> zero', "op < x zero -> neg", 'lit "0" -> z2', "op - z2 x -> r", "out r"];
    expect(id(twice)).toBe(id(once));
  });

  it("a literal inside a branch is the same as one before it", () => {
    const outside = ["param x", 'lit "0" -> zero', "op < x zero -> neg", "if neg", "op - zero x -> a", "end", "join r neg a x", "out r"];
    const inside = ["param x", 'lit "0" -> zero', "op < x zero -> neg", "if neg", 'lit "0" -> z', "op - z x -> a", "end", "join r neg a x", "out r"];
    expect(id(inside)).toBe(id(outside));
  });

  it("a branch that only picks literals is a select", () => {
    const branch = ["param c", "if c", 'lit "1" -> a', "else", 'lit "2" -> b', "end", "join r c a b", "out r"];
    const select = ["param c", 'lit "1" -> a', 'lit "2" -> b', "select r c a b", "out r"];
    expect(id(branch)).toBe(id(select));
  });

  it("an unread literal is no structure", () => {
    expect(id(["param x", 'lit "5" -> unused', "out x"])).toBe(id(["param x", "out x"]));
  });

  it.each([['lit "" -> e'], ['lit "v" -> k'], ['lit "id-" -> p'], ['lit "a b" -> p']])("refuses %s", (line) => {
    expect(() => parseLineForm(["param x", line, "out x"].join("\n"))).toThrow(/not a JavaScript literal/);
  });

  it.each([["3"], ["0x1F"], ["1.5e3"], ["10n"], ["'abc'"], ['"abc"'], ["`abc`"], ["true"], ["null"], ["undefined"], ["/a+b/g"]])("accepts %s", (text) => {
    expect(() => parseLineForm(["param x", `lit ${JSON.stringify(text)} -> l`, "op + x l -> r", "out r"].join("\n"))).not.toThrow();
  });
});
