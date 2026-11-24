// SPDX-License-Identifier: Apache-2.0
/**
 * A destructuring assignment inside a loop writes the names its pattern names, so each is one of
 * the loop's carries (found lowering @noble/hashes' BLAKE2 `compress` natively, #1333): object and
 * array patterns, renamed, defaulted, nested and rest targets. The lifted graph, emitted as
 * TypeScript, computes what the source does.
 */
import { describe, expect, it } from "vitest";
import { runnable } from "./__fixtures__/runnable.js";
import { emitTypeScript } from "./emit-ts.js";
import { liftAtom } from "./lift.js";

const CASES: string[] = [
  "export function f(a, b) { for (let i = 0; i < 3; i++) { ({ x: a, y: b } = { x: b + 1, y: a * 2 }); } return [a, b]; }",
  "export function f(a, b) { let c = 0; for (let i = 0; i < 3; i++) { [a, , ...b] = [b, 0, a, i]; ({ c = 5 } = {}); } return [a, b, c]; }",
  "export function f(a, b) { let n = 0; while (n < 4) { ({ p: { q: a } } = { p: { q: a + b } }); [b] = [b * 2]; n++; } return [a, b, n]; }",
  "export function f(a, b) { const xs = [1, 2, 3]; for (const x of xs) { ({ a, b = 7 } = { a: a + x }); } return [a, b]; }",
];

describe("destructuring assignments in loops are carried", () => {
  for (const src of CASES)
    it(src.slice(30, 90), () => {
      const ref = new Function(`${src.replace(/^export /, "")}; return f;`)() as (
        ...a: unknown[]
      ) => unknown;
      const got = new Function(`${runnable(emitTypeScript(liftAtom(src)))}; return f;`)() as (
        ...a: unknown[]
      ) => unknown;
      expect(got(1, 2)).toEqual(ref(1, 2));
      expect(got(-3, 0.5)).toEqual(ref(-3, 0.5));
    });
});
