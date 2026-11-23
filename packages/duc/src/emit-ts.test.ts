// SPDX-License-Identifier: Apache-2.0
// Lowering to TypeScript (#1275, decision 5A): the emitted code lifts back to the same identity, and
// computes what the original source computes.
import { ts } from "ts-morph";
import { describe, expect, it } from "vitest";
import { EMIT_CASES as CASES } from "./__fixtures__/emit-cases.js";
import { graphIdentity } from "./canonical.js";
import { EmitError, emitTypeScript } from "./emit-ts.js";
import { liftAtom } from "./lift.js";

/** Runs emitted code: it is untyped, so it is valid JavaScript once the export is dropped. */
function run(code: string, args: readonly unknown[]): unknown {
  const fn = new Function(`${code.replace("export function f", "return function f")}`)() as (
    ...a: unknown[]
  ) => unknown;
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

  it("refuses an opaque node: a recursive function has no structure to emit", () => {
    const g = liftAtom(
      "export function f(n: number): number { function fact(m: number): number { return m < 2 ? 1 : m * fact(m - 1); } return fact(n); }",
    );
    expect(() => emitTypeScript(g)).toThrow(EmitError);
  });
});
