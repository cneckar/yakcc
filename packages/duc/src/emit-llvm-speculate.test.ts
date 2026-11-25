// SPDX-License-Identifier: Apache-2.0
/**
 * Parameter speculation in the native lowering (#1369, DEC-DUC-TYPED-NATIVE-001): a function whose
 * arguments feed numeric operations is also lowered taking them as numbers, and entered that way
 * only when they are. Called with anything else (a string, a BigInt, an object with valueOf,
 * undefined past argc), it must still compute what JavaScript does: each program runs natively on
 * mixed inputs and is compared with Node.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import { afterAll, describe, expect, it } from "vitest";
import { canRun, harness, same } from "./__fixtures__/native-harness.js";
import { emitLlvmBoxed } from "./emit-llvm-boxed.js";
import { liftAtom } from "./lift.js";

const work = mkdtempSync(join(tmpdir(), "yakcc-speculate-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

const show = (v: unknown) => JSON.stringify(v, (_, x) => (typeof x === "bigint" ? `${x}n` : x));

const value = fc.oneof(
  fc.integer({ min: -50, max: 50 }),
  fc.double(),
  fc.constantFrom(0, -0, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 31, 2 ** 53),
  fc.constantFrom("7", "x", "", " 3 "),
  fc.constantFrom(true, false, null, undefined),
  fc.bigInt({ min: -100n, max: 100n }),
);

describe.skipIf(!canRun("x86_64-linux"))("parameter speculation, natively (#1369)", () => {
  it("a function speculated on numbers gives JavaScript's results for any arguments", () => {
    const source = `export function f(x, y) {
      function g(a, b) {
        let s = 0;
        for (let i = 0; i < 3; i++) s = s * a + b - i;
        return [s, a < b, a | b, -a, a % 3, Math.floor(a), a * 2 + b];
      }
      function h(a) { return a - 1; }
      const o = { valueOf() { return 4; } };
      const at = (k) => { try { return k(); } catch (e) { return 'threw ' + e.name; } };
      return [at(() => g(x, y)), at(() => g(y, x)), at(() => g(x, 1)), at(() => g(o, x)), at(() => h()), at(() => h(x)), at(() => g(x))];
    }`;
    const inputs = fc.sample(fc.tuple(value, value), { numRuns: 300, seed: 1369 }) as unknown[][];
    const ref = new Function(`${source.replace(/^export /, "")}; return f;`)() as (
      ...a: unknown[]
    ) => unknown;
    const run = harness(emitLlvmBoxed(liftAtom(source)), work);
    const { results, stderr } = run(inputs);
    expect(results.length, stderr).toBe(inputs.length);
    const bad = inputs.flatMap((args, i) => {
      const want = ref(...args);
      return same(results[i], want)
        ? []
        : [`${show(args)} → native ${show(results[i])}, node ${show(want)}`];
    });
    expect(bad.slice(0, 5)).toEqual([]);
  }, 300_000);
});
