// SPDX-License-Identifier: Apache-2.0
// Links and imported references in the line form (#1275, P7): a linked reference prints its key,
// and an imported binding prints its module, so a submitted atom prints the way it is stored.
import { describe, expect, it } from "vitest";
import { graphIdentity } from "./canonical.js";
import { linkReferences } from "./closure.js";
import { liftAtom } from "./lift.js";
import { LineFormError, parseLineForm, printLineForm } from "./line-form.js";

describe("links in the line form", () => {
  it("a linked reference prints its key and parses back to the same structure", () => {
    const g = linkReferences(liftAtom("export function f(x: number): number { return foo(x) + 1; }"), () => "helper-key");
    const text = printLineForm(g);
    expect(text).toMatch(/^free foo -> \S+ link helper-key$/m);
    const back = parseLineForm(text);
    expect(graphIdentity(back)).toBe(graphIdentity(g));
    // Identity does not see links, so check the link itself survives.
    expect(back.nodes.find((n) => n.diamond?.symbol === "foo")?.diamond?.spec).toBe("helper-key");
  });

  it("an imported binding prints as unlinked, with its module", () => {
    const g = liftAtom("import { readFileSync } from 'fs'; export function f(p: string): string { return readFileSync(p); }");
    const text = printLineForm(g);
    expect(text).toMatch(/^unlinked readFileSync from fs -> \S+$/m);
    expect(graphIdentity(parseLineForm(text))).toBe(graphIdentity(g));
  });

  it("a hand-written link parses to the same graph as the linked lifted atom", () => {
    const linked = linkReferences(liftAtom("export function f(x: number): number { return foo(x) + 1; }"), () => "k1");
    const text = ["param x", "free foo -> g link k1", "op CallExpression g x -> c", 'lit "1" -> one', "op + c one -> r", "out r"].join("\n");
    expect(graphIdentity(parseLineForm(text))).toBe(graphIdentity(linked));
  });

  it("the same symbol linked to two keys is an error", () => {
    expect(() => parseLineForm("free foo -> a link k1\nfree foo -> b link k2\n")).toThrow(/linked to another key/);
  });

  it("a link needs its key", () => {
    expect(() => parseLineForm("free foo -> a link\n")).toThrow(LineFormError);
  });
});
