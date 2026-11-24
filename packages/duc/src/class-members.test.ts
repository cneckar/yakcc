// SPDX-License-Identifier: Apache-2.0
/**
 * Class fields, static blocks and computed member names (#1330): lifted as structure, not opaque;
 * the TypeScript lowering computes what the source computes; the round trip holds.
 */
import { describe, expect, it } from "vitest";
import { graphIdentity } from "./canonical.js";
import { emitTypeScript } from "./emit-ts.js";
import { liftAtom } from "./lift.js";
import type { DucGraph } from "./types.js";

const opaque = (g: DucGraph): string[] =>
  g.nodes.flatMap((n) => [
    ...(/#[0-9a-f]{16}$/.test(n.label ?? "") ? [n.label as string] : []),
    ...(n.closure !== undefined ? opaque(n.closure) : []),
  ]);

const run = (code: string): unknown =>
  (new Function(`${code.replace(/^export /m, "")}; return f;`)() as () => unknown)();

const CASES: [string, string][] = [
  [
    "instance and static fields, read by methods and by later fields",
    "export function f() { class A { x = 1; y = this.x + 1; static z = 3; m() { return this.x + this.y; } } const a = new A(); return [a.m(), A.z, Object.keys(a)]; }",
  ],
  [
    "a field with no initializer is defined, as undefined",
    "export function f() { class E { x; } const e = new E(); return ['x' in e, e.x, Object.keys(e)]; }",
  ],
  [
    "computed, string and numeric names: methods, accessors and fields",
    "export function f() { const k = 'm' + 'n'; class B { [k]() { return 1; } get ['g' + 1]() { return 2; } static ['s' + 1] = 3; ['a-b'] = 4; 7() { return 7; } } const b = new B(); return [b.mn(), b.g1, B.s1, b['a-b'], b[7](), Object.keys(b)]; }",
  ],
  [
    "symbol keys, as Node's library writes them",
    "export function f() { const kState = Symbol('state'); class C { [kState] = 5; [Symbol.iterator]() { let i = 0; const n = this[kState]; return { next: () => (i < n ? { value: i++, done: false } : { value: undefined, done: true }) }; } } return [...new C()]; }",
  ],
  [
    "static blocks run at definition, in order with static fields, with the class as this",
    "export function f() { class D { static count = 1; static { D.count = D.count + 10; this.flag = true; } static after = D.count * 2; } return [D.count, D.flag, D.after]; }",
  ],
  [
    "a derived class's fields are defined after super() returns",
    "export function f() { class P { constructor() { this.a = 1; } } class Q extends P { b = this.a + 1; constructor() { super(); this.c = this.b + 1; } } const q = new Q(); return [q.a, q.b, q.c, Object.keys(q)]; }",
  ],
  [
    "a derived class with fields and the default constructor",
    "export function f() { class P { constructor(n) { this.n = n; } } class Q extends P { twice = this.n * 2; } return new Q(21).twice; }",
  ],
  [
    "an arrow field captures the instance",
    "export function f() { class F { n = 2; get = () => this.n; } const g = new F().get; return g(); }",
  ],
  [
    "keys are evaluated at definition, in member order; initializers when an instance is made",
    "export function f() { const log = []; class G { [(log.push('a'), 'a')] = log.push('init'); static [(log.push('b'), 'b')] = log.push('static'); } const before = [...log]; new G(); return [before, log]; }",
  ],
  [
    "a class expression with fields, assigned and returned",
    "export function f(n) { const K = class { v = n; double() { return this.v * 2; } }; return new K().double(); }",
  ],
];

describe("class fields, static blocks and computed names (#1330)", () => {
  for (const [name, source] of CASES) {
    it(name, () => {
      const g = liftAtom(source);
      expect(opaque(g), "lifted as structure").toEqual([]);
      const reference = run(source);
      const code = emitTypeScript(g);
      expect(run(code), code).toEqual(reference);
      expect(graphIdentity(liftAtom(code)), code).toBe(graphIdentity(g));
    });
  }

  it("a field and the constructor write that means the same thing on a plain class are different graphs", () => {
    // A field is defined ([[DefineOwnProperty]]); an assignment is a [[Set]], which a setter sees.
    const field = liftAtom("export function f() { class A { x = 1; } return new A(); }");
    const set = liftAtom(
      "export function f() { class A { constructor() { this.x = 1; } } return new A(); }",
    );
    expect(graphIdentity(field)).not.toBe(graphIdentity(set));
  });

  it("a private name is not lifted yet: it stays a summary", () => {
    const g = liftAtom(
      "export function f() { class A { #x = 1; get() { return this.#x; } } return new A().get(); }",
    );
    expect(opaque(g).length).toBeGreaterThan(0);
  });
});
