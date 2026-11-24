// SPDX-License-Identifier: Apache-2.0
// Lowering to TypeScript (#1275, decision 5A): the emitted code lifts back to the same identity, and
// computes what the original source computes.
import { ts } from "ts-morph";
import { describe, expect, it } from "vitest";
import { EMIT_CASES as CASES } from "./__fixtures__/emit-cases.js";
import { runnable } from "./__fixtures__/runnable.js";
import { graphIdentity } from "./canonical.js";
import { EmitError, emitTypeScript } from "./emit-ts.js";
import { liftAtom } from "./lift.js";

/** Runs emitted code: it is untyped, so it is valid JavaScript once the export is dropped. */
function run(code: string, args: readonly unknown[]): unknown {
  const fn = new Function(`${runnable(code)}; return f;`)() as (...a: unknown[]) => unknown;
  return fn(...args);
}

function runSource(source: string, args: readonly unknown[]): unknown {
  const js = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText;
  return run(js, args);
}

describe("emitting TypeScript from the graph (5A)", () => {
  for (const tc of CASES) {
    it(`round-trips and computes the same: ${tc.name}`, () => {
      const g = liftAtom(tc.source);
      const code = emitTypeScript(g);
      expect(graphIdentity(liftAtom(code)), code).toBe(graphIdentity(g));
      // Each run gets its own copy of the arguments: a case may change them.
      for (const args of tc.args)
        expect(run(code, structuredClone(args)), `${JSON.stringify(args)}\n${code}`).toEqual(
          runSource(tc.source, structuredClone(args)),
        );
    });
  }

  it("refuses an opaque node: a class with a private name has no structure to emit yet", () => {
    const g = liftAtom("export function f(m: string) { class E { #y = 1; } return new E(); }");
    expect(() => emitTypeScript(g)).toThrow(EmitError);
  });

  it("a derived class's super calls and super reads round-trip (#1294)", () => {
    const g = liftAtom(
      "export function f(m: string) { class A { constructor(v: string) { this.v = v; } d() { return this.v; } static s() { return 1; } } class E extends A { constructor(v: string) { super(v + '!'); } d() { const up = () => super.d(); return up() + super.d; } static s() { return super.s() + 1; } } return new E(m).d(); }",
    );
    expect(graphIdentity(liftAtom(emitTypeScript(g)))).toBe(graphIdentity(g));
  });
});

describe("a fragment that can return: its completion record (#1297)", () => {
  // Each fragment reads `a` and `t` (free) and is a slice of a function body. The reference runs it
  // in a function: a return is [true, value]; falling off its end is [false, undefined, …declared].
  const FRAGMENTS: [string, string[]][] = [
    ["if (a === undefined) return undefined;", []],
    ["const x = a + 1; if (x > 2) return x; const y = x * 2; t.push(y);", ["x", "y"]],
    [
      "if (a === 0) return 'zero'; const v = a * 3; if (v > 10) return v; const w = v - 1;",
      ["v", "w"],
    ],
    ["for (const k of [1, 2, 3]) { if (k === a) return k * 10; }", []],
    ["return [a, t.length];", []],
  ];
  const run = (fragment: string, names: string[], input: number): unknown => {
    const body = fragment.replace(
      /\breturn\b([^;]*);/g,
      (_m, e: string) => `return [true, ${e.trim() || "undefined"}];`,
    );
    return new Function(
      "a",
      "t",
      `${body}\nreturn [false, undefined${names.map((n) => `, ${n}`).join("")}];`,
    )(input, []);
  };
  const emitted = (fragment: string, input: number): unknown => {
    const code = emitTypeScript(liftAtom(fragment));
    const names = [...code.matchAll(/^export \{ (\w+) \};$/gm)].map((m) => m[1] as string);
    const body = code
      .split("\n")
      .filter((l) => !/^export /.test(l))
      .join("\n");
    const ret = `return [${names.join(", ")}];`;
    return new Function("a", "t", `${runnable(body)}\n${ret}`)(input, []);
  };
  for (const [fragment, names] of FRAGMENTS)
    it(`gives what the function it was cut from gives: ${fragment}`, () => {
      for (const input of [0, 1, 2, 3, 5, -4, Number.NaN]) {
        const want = run(fragment, names, input) as unknown[];
        const got = emitted(fragment, input) as unknown[];
        // A return: the flag and the value. Falling off: the flag and each declared name too.
        expect(got.slice(0, 2)).toEqual(want.slice(0, 2));
        if (want[0] === false) expect(got.slice(2)).toEqual(want.slice(2));
      }
    });
});
