// SPDX-License-Identifier: Apache-2.0
// Async functions and generators (#1276): `await` and `yield` are ordered operations, and whether a
// function is async or a generator is part of its identity, the atom's own function included.
import { describe, expect, it } from "vitest";
import { runnable } from "./__fixtures__/runnable.js";
import { graphIdentity } from "./canonical.js";
import { decodeGraph, encodeGraph } from "./compact.js";
import { PyEmitError, emitPython } from "./emit-py.js";
import { emitTypeScript } from "./emit-ts.js";
import { liftAtom } from "./lift.js";
import { parseLineForm, printLineForm } from "./line-form.js";
import { packGraph, unpackGraph } from "./store.js";

const id = (src: string): string => graphIdentity(liftAtom(src));
const opaque = (src: string): boolean =>
  JSON.stringify(liftAtom(src)).includes("#") &&
  /"label":"[A-Za-z]+#/.test(JSON.stringify(liftAtom(src)));

function roundTrip(src: string): string {
  const g = liftAtom(src);
  const code = emitTypeScript(g);
  expect(graphIdentity(liftAtom(code)), code).toBe(graphIdentity(g));
  return code;
}

const load = (code: string): ((...a: unknown[]) => unknown) =>
  new Function(`${runnable(code)}; return f;`)() as (...a: unknown[]) => unknown;

describe("async functions and generators (#1276)", () => {
  it("an async or generator function is another identity than the plain one", () => {
    const ids = [
      "export function f(x: number) { return x; }",
      "export async function f(x: number) { return x; }",
      "export function* f(x: number) { return x; }",
      "export async function* f(x: number) { return x; }",
    ].map(id);
    expect(new Set(ids).size).toBe(4);
    expect(id("export const g = (k: number) => { const h = async () => k; return h; };")).not.toBe(
      id("export const g = (k: number) => { const h = () => k; return h; };"),
    );
  });

  it("await and yield lift as operations, not opaque summaries", () => {
    expect(
      opaque("export async function f(p: any) { const v = await p.get(); return v + 1; }"),
    ).toBe(false);
    expect(opaque("export function* f(n: number) { yield n; yield* [n]; return yield; }")).toBe(
      false,
    );
  });

  it("the order of awaits is structure", () => {
    expect(
      id(
        "export async function f(a: any, b: any) { const x = await a; const y = await b; return [x, y]; }",
      ),
    ).not.toBe(
      id(
        "export async function f(a: any, b: any) { const y = await b; const x = await a; return [x, y]; }",
      ),
    );
  });

  it("an async function round-trips and computes the same", async () => {
    const src =
      "export async function f(p: any, k: number) { const add = async (x: number) => (await x) + k; const v = await p; return [await add(v), await add(1)]; }";
    const code = roundTrip(src);
    expect(code).toContain("export async function f");
    await expect(load(code)(Promise.resolve(2), 10)).resolves.toEqual([12, 11]);
  });

  it("a generator round-trips and yields the same", () => {
    const src =
      "export function f(n: number) { function* g(m: number) { const got = yield m; yield* [got, m + 1]; } const it = g(n); return [it.next().value, it.next(7).value, it.next().value, it.next().done]; }";
    const code = roundTrip(src);
    expect(code).toContain("function*");
    expect(load(code)(3)).toEqual([3, 7, 4, true]);
  });

  it("an async and a generator method of a class round-trip", () => {
    const src =
      "export function f(k: number) { class C { static async a(x: number) { return (await x) + k; } *b() { yield k; } } return [C.a, [...new C().b()]]; }";
    roundTrip(src);
  });

  it("the mode survives the line form, the compact format and the store", () => {
    const g = liftAtom("export async function f(p: any) { return await p; }");
    expect(g.mode).toBe("async");
    expect(printLineForm(g).startsWith("mode async\n")).toBe(true);
    expect(graphIdentity(parseLineForm(printLineForm(g)))).toBe(graphIdentity(g));
    expect(graphIdentity(decodeGraph(encodeGraph(g)))).toBe(graphIdentity(g));
    const packed = packGraph(g);
    expect(packed.identity).toBe(graphIdentity(g));
    expect(graphIdentity(unpackGraph(packed))).toBe(graphIdentity(g));
  });

  it("an async closure in the line form is an `async function`", () => {
    const g = liftAtom("export function f(k: number) { return async () => k; }");
    const text = printLineForm(g);
    expect(text).toContain("async function ");
    expect(graphIdentity(parseLineForm(text))).toBe(graphIdentity(g));
  });

  it("a try whose blocks await is an awaited call of the async try primitive", async () => {
    const src =
      "export async function f(p: any) { let r = 0; try { r = await p; if (r > 5) return 'big'; } catch (e) { r = -1; } finally { r = r + 1; } return r; }";
    const code = roundTrip(src);
    expect(code).toContain("__yakccTryAsync");
    const run = load(code);
    await expect(run(Promise.resolve(2))).resolves.toBe(3);
    await expect(run(Promise.resolve(9))).resolves.toBe("big");
    await expect(run(Promise.reject(new Error("x")))).resolves.toBe(0);
  });

  it("a lowering without async refuses it with a reason", () => {
    expect(() =>
      emitPython(liftAtom("export async function f(p: any) { return await p; }")),
    ).toThrow(PyEmitError);
    expect(() =>
      emitPython(liftAtom("export function f(k: number) { return async () => k; }")),
    ).toThrow(PyEmitError);
  });
});
