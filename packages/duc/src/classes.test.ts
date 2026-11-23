// SPDX-License-Identifier: Apache-2.0
// Classes (#1276): a class is one operation over its members' closures, and a member reads its own
// class as `class-self`. A heritage clause, a field, or a member that is not a closure keeps it opaque.
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

  it("a class that extends another stays opaque: super needs the parent's constructor", () => {
    expect(
      opaque(
        "export function f(m: string) { class E extends Error { constructor(x: string) { super(x); } } return new E(m); }",
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
