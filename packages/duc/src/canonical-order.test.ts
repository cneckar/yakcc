// SPDX-License-Identifier: Apache-2.0
// Canonical order (#1275, decision 4A): the operands of === and !== are ordered by structure, and so
// are a loop's invariants. Operations that do not commute for every type keep their order.
import { describe, expect, it } from "vitest";
import { graphIdentity } from "./canonical.js";
import { liftAtom } from "./lift.js";
import { parseLineForm } from "./line-form.js";

const f = (body: string): string => `export function f(a: number, b: number): unknown { ${body} }`;
const id = (src: string): string => graphIdentity(liftAtom(src));

describe("canonical order of operands and invariants (4A)", () => {
  it("=== with its operands swapped is the same structure", () => {
    expect(id(f("return a === b;"))).toBe(id(f("return b === a;")));
  });

  it("!== with its operands swapped is the same structure", () => {
    expect(id(f("return a !== b + 1;"))).toBe(id(f("return b + 1 !== a;")));
  });

  it("< with its operands swapped is a different structure", () => {
    expect(id(f("return a < b;"))).not.toBe(id(f("return b < a;")));
  });

  it("+ keeps its order: string concatenation does not commute", () => {
    expect(id(f("return a + b;"))).not.toBe(id(f("return b + a;")));
  });

  it("the same program with its statements in another order has the same identity", () => {
    // Two computations with the same structure behind them; their users tell them apart.
    const a =
      "export function f(n: number): unknown { const x = [n + 1, 2]; const y = [n + 1, 3]; return [x, y]; }";
    const b =
      "export function f(n: number): unknown { const y = [n + 1, 3]; const x = [n + 1, 2]; return [x, y]; }";
    expect(id(b)).toBe(id(a));
  });

  it("heap operations in another order are another program (#1285)", () => {
    // Each call may change what the other sees: their order is structure.
    const a =
      "export function f(): unknown { const x = Buffer.from([1, 2]); const y = Buffer.from([3]); return [x, y]; }";
    const b =
      "export function f(): unknown { const y = Buffer.from([3]); const x = Buffer.from([1, 2]); return [x, y]; }";
    expect(id(b)).not.toBe(id(a));
    // A read after a call that may change it is not the read before the call.
    expect(id("export function f(o: any) { g(o); return o.x; }")).not.toBe(
      id("export function f(o: any) { const t = o.x; g(o); return t; }"),
    );
  });

  it("a loop's invariants written in either order are the same structure", () => {
    const loop = (withNames: string, invNames: string): string =>
      [
        "param n",
        "param x",
        'lit "0" -> s0',
        'lit "0" -> i0',
        `loop s0 i0 with ${withNames}`,
        "carry s i",
        `invariant ${invNames}`,
        "op + s xx -> s2",
        'lit "1" -> one',
        "op + i one -> i2",
        "op < i nn -> c",
        "while c",
        "next s2 i2",
        "end r ii",
        "out r",
      ].join("\n");
    expect(graphIdentity(parseLineForm(loop("x n", "xx nn")))).toBe(
      graphIdentity(parseLineForm(loop("n x", "nn xx"))),
    );
  });
});
