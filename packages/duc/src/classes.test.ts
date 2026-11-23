// SPDX-License-Identifier: Apache-2.0
// Classes (#1276): a class is one operation over its members' closures, and a member reads its own
// class as `class-self`. A field, `super.x`, or a member that is not a closure keeps it opaque.
import { describe, expect, it } from "vitest";
import { graphIdentity } from "./canonical.js";
import { GoEmitError, emitGo } from "./emit-go.js";
import { PyEmitError, emitPython } from "./emit-py.js";
import { emitTypeScript } from "./emit-ts.js";
import { liftAtom } from "./lift.js";
import { parseLineForm, printLineForm } from "./line-form.js";

const opaque = (src: string): boolean =>
  liftAtom(src).nodes.some((n) => (n.label ?? "").startsWith("Class#"));

const run = (code: string): ((...a: unknown[]) => unknown) =>
  new Function(`${code.replace("export ", "")}; return f;`)() as (...a: unknown[]) => unknown;

describe("classes (#1276)", () => {
  const counter =
    "export function f(n: number) { class Counter { constructor(start: number) { this.n = start; } step() { this.n = this.n + 1; return this; } get value() { return this.n; } static of(k: number) { return new Counter(k); } } return Counter.of(n).step().step().value; }";

  it("a class with a constructor, methods, an accessor and a static method lifts, and computes the same", () => {
    expect(opaque(counter)).toBe(false);
    const g = liftAtom(counter);
    const code = emitTypeScript(g);
    expect(run(code)(4)).toBe(6);
    expect(graphIdentity(liftAtom(code))).toBe(graphIdentity(g));
    expect(graphIdentity(parseLineForm(printLineForm(g)))).toBe(graphIdentity(g));
  });

  it("the class's own name inside a member is the class, whatever it is called", () => {
    const renamed = counter.replace(/Counter/g, "Tally");
    expect(graphIdentity(liftAtom(renamed))).toBe(graphIdentity(liftAtom(counter)));
  });

  it("a class expression lifts as a class declaration does", () => {
    const src =
      "export function f(x: number) { const Box = class { constructor(v: number) { this.v = v; } get() { return this.v * 2; } }; return new Box(x).get(); }";
    expect(opaque(src)).toBe(false);
    const g = liftAtom(src);
    const code = emitTypeScript(g);
    expect(run(code)(5)).toBe(10);
    expect(graphIdentity(liftAtom(code))).toBe(graphIdentity(g));
  });

  it("a class that extends another: the parent is an input, and super(..) makes the receiver", () => {
    const src =
      "export function f(m: string, k: number) { class E extends Error { constructor(x: string, ...rest: any[]) { if (k > 1) x = x + '!'; super(x); const g = () => this.message; this.code = k + rest.length; this.g = g; } } const e = new E(m, 1, 2); return [e.message, e.code, e.g(), e instanceof Error]; }";
    const g = liftAtom(src);
    expect(opaque(src)).toBe(false);
    const code = emitTypeScript(g);
    expect(code).toContain("extends");
    expect(graphIdentity(liftAtom(code)), code).toBe(graphIdentity(g));
    expect(run(code)("boom", 2)).toEqual(["boom!", 4, "boom!", true]);
    // Which parent it extends is structure.
    expect(graphIdentity(liftAtom(src.replace("extends Error", "extends TypeError")))).not.toBe(
      graphIdentity(g),
    );
  });

  it("super.x in a derived class's member is structure: the parent's member, with the receiver (#1294)", () => {
    expect(
      opaque(
        "export function f(m: string) { class E extends Error { describe() { const up = () => super.toString(); return up() + super.message; } } return new E(m); }",
      ),
    ).toBe(false);
  });

  it("super anywhere else stays opaque: a write through it, a base class's, this before super(..)", () => {
    expect(
      opaque(
        "export function f(m: string) { class A {} class E extends A { set(v: number) { super.x = v; } } return new E(); }",
      ),
    ).toBe(true);
    expect(
      opaque(
        "export function f(m: string) { class E { describe() { return super.toString(); } } return new E(); }",
      ),
    ).toBe(true);
    expect(
      opaque(
        "export function f(m: string) { class E extends Error { constructor(x: string) { this.a = 1; super(x); } } return new E(m); }",
      ),
    ).toBe(true);
  });

  it("Python and Go refuse a class with a reason, not a guess", () => {
    const g = liftAtom(counter);
    // The first construct either lowering has no form for: a member's receiver, or the class.
    expect(() => emitPython(g)).toThrow(PyEmitError);
    expect(() => emitGo(g)).toThrow(GoEmitError);
  });
});

describe("object literal methods and accessors (#1276)", () => {
  const src =
    "export function f(k: number, key: string) { const o = { a: k, get double() { return this.a * 2; }, set double(v: number) { this.a = v / 2; }, add(x: number) { this.a = this.a + x; return this; }, [key]: 1 }; o.add(3).double = 20; return [o.a, o.double, o[key]]; }";

  it("a method or accessor is a closure, not an opaque summary", () => {
    const g = liftAtom(src);
    expect(g.nodes.some((n) => (n.label ?? "").startsWith("Closure#"))).toBe(false);
    expect(g.nodes.some((n) => (n.label ?? "").includes('{"get":"double"}'))).toBe(true);
  });

  it("round-trips, written in place, and computes the same", () => {
    const g = liftAtom(src);
    const code = emitTypeScript(g);
    expect(code).toContain('get "double"()');
    expect(graphIdentity(liftAtom(code)), code).toBe(graphIdentity(g));
    expect(run(code)(1, "z")).toEqual([10, 20, 1]);
  });

  it("a getter and a method with the same body are different entries", () => {
    expect(
      graphIdentity(liftAtom("export function f() { return { get a() { return 1; } }; }")),
    ).not.toBe(graphIdentity(liftAtom("export function f() { return { a() { return 1; } }; }")));
  });
});
