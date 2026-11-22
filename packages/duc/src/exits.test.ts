// SPDX-License-Identifier: Apache-2.0
/**
 * Exits (#1276): a return or a throw leaves the function, so what follows it runs only on the paths
 * that have not left. An `if` that exits on some paths takes the rest of the function onto both
 * sides, and the exits join in one total `if`. Falling off the end returns undefined.
 */
import { describe, expect, it } from "vitest";
import { graphIdentity } from "./canonical.js";
import { emitTypeScript } from "./emit-ts.js";
import { liftAtom } from "./lift.js";

const id = (src: string): string => graphIdentity(liftAtom(src));
const regionOfCall = (src: string, callee: string): string | undefined => {
  const g = liftAtom(src);
  const sym = g.nodes.find((n) => n.diamond?.symbol === callee)?.outputs[0];
  return g.nodes.find((n) => n.label === "CallExpression" && n.inputs[0] === sym)?.region;
};

describe("exits (#1276)", () => {
  it("what follows a throw on some paths runs only on the other paths", () => {
    // The call is inside the branch's else side, not at the top level where it would always run.
    expect(regionOfCall("export function f(c: boolean, x: number) { if (c) throw new Error('no'); log(x); }", "log")).toMatch(/^b\d+\.e$/);
  });

  it("a throw after two returns is only on the path neither return takes", () => {
    const src =
      "export function f(v: any) { if (typeof v === 'string') { return parse(v); } else if (typeof v === 'number') { return show(v); } throw new Error('bad'); }";
    const g = liftAtom(src);
    const thrown = g.nodes.find((n) => n.label === "throw");
    expect(thrown?.region).toMatch(/\.e\/b\d+\.e$/);
  });

  it("falling off the end, return; and return undefined are one program", () => {
    const a = id("export function f(x: number) { log(x); }");
    expect(id("export function f(x: number) { log(x); return; }")).toBe(a);
    expect(id("export function f(x: number) { log(x); return undefined; }")).toBe(a);
  });

  it("nothing after a return is lifted", () => {
    expect(id("export function f(x: number) { return x; log(x); }")).toBe(id("export function f(x: number) { return x; }"));
  });

  it("an exit inside a nested if takes the rest of the function onto every path", () => {
    const g = liftAtom("export function f(c: boolean, x: number) { if (c) { if (x > 0) { return 1; } } log(x); return x; }");
    // log runs on two paths (c false; c true and x <= 0), never at the top level.
    const calls = g.nodes.filter((n) => n.label === "CallExpression");
    expect(calls.length).toBe(2);
    expect(calls.every((n) => n.region !== undefined)).toBe(true);
  });

  it("a loop whose body throws stays opaque, so the rest of its body is not unguarded", () => {
    const g = liftAtom("export function f(xs: number[]) { let s = 0; for (const x of xs) { if (x < 0) throw new Error('neg'); s = s + x; } return s; }");
    expect(g.nodes.some((n) => n.kind === "loop" && n.loop !== undefined)).toBe(false);
  });

  it("the emitter writes what does not depend on a throwing branch before it", () => {
    const src =
      "export function f(a: string, b: string) { check(a); check(b); if (b in table) { return table[b](a); } throw new Error('unknown ' + b); }";
    const code = emitTypeScript(liftAtom(src));
    const lastCheck = Math.max(...[...code.matchAll(/check\(/g)].map((m) => m.index ?? -1));
    const branch = code.indexOf("if (");
    expect(lastCheck).toBeGreaterThan(-1);
    expect(lastCheck).toBeLessThan(branch);
    expect(graphIdentity(liftAtom(code))).toBe(graphIdentity(liftAtom(src)));
  });

  it("a select of one value on both sides is that value, and one inside its own condition takes its arm", () => {
    expect(id("export function f(c: boolean, x: number) { return c ? x : x; }")).toBe(id("export function f(c: boolean, x: number) { return x; }"));
    expect(id("export function f(c: boolean, x: number, y: number) { return c ? x : (c ? 0 : y); }")).toBe(
      id("export function f(c: boolean, x: number, y: number) { return c ? x : y; }"),
    );
  });
});
