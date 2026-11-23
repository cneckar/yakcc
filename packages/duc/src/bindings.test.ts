// SPDX-License-Identifier: Apache-2.0
// Bindings outside the atom (#1276): a free name the atom assigns is a binding it reads and writes
// through ordered operations, so the write is part of the identity, and a closure that writes it
// writes the same binding. A destructuring assignment assigns each member it names.
import { describe, expect, it } from "vitest";
import { graphIdentity } from "./canonical.js";
import { emitTypeScript } from "./emit-ts.js";
import { liftAtom } from "./lift.js";

const id = (src: string): string => graphIdentity(liftAtom(src));

function roundTrip(src: string): string {
  const g = liftAtom(src);
  const code = emitTypeScript(g);
  expect(graphIdentity(liftAtom(code)), code).toBe(graphIdentity(g));
  return code;
}

describe("bindings outside the atom (#1276)", () => {
  it("a write to a free name is structure: it is not the empty function", () => {
    expect(id("export function f(v: number) { counter = v; }")).not.toBe(
      id("export function f(v: number) { }"),
    );
    expect(id("export function f(v: number) { counter = v; }")).not.toBe(
      id("export function f(v: number) { total = v; }"),
    );
  });

  it("a closure writes the binding itself, and a read after a call sees the write", () => {
    const src =
      "export function f(v: number) { total = total + v; count++; const bump = () => { count = count + 10; return count; }; const r = bump(); return [total, count, r]; }";
    const code = roundTrip(src);
    const scope = { total: 1, count: 0 };
    const fn = new Function(
      "scope",
      `with (scope) { ${code.replace("export function f", "var f = function")}; return f; }`,
    )(scope) as (v: number) => unknown;
    expect(fn(5)).toEqual([6, 11, 11]);
    expect(scope).toEqual({ total: 6, count: 11 });
  });

  it("a destructuring assignment assigns each member, defaults included", () => {
    const src =
      "export function f(o: any) { let a, c; ({ a, b: [c] = [9], d = 4 } = o); [x, , y = 2] = [a, 0]; return [a, c, d, x, y]; }";
    const g = liftAtom(src);
    expect(g.nodes.some((n) => (n.label ?? "").includes("#"))).toBe(false);
    const code = roundTrip(src);
    const scope: Record<string, unknown> = { d: 0, x: 0, y: 0 };
    const fn = new Function(
      "scope",
      `with (scope) { ${code.replace("export function f", "var f = function")}; return f; }`,
    )(scope) as (o: unknown) => unknown;
    expect(fn({ a: 1, b: [7] })).toEqual([1, 7, 4, 1, 2]);
    expect(fn({ a: 3, d: 5 })).toEqual([3, 9, 5, 3, 2]);
  });
});
