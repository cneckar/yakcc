// SPDX-License-Identifier: Apache-2.0
/**
 * Number's conversions natively (#1516): the runtime's are V8's own, src/numbers/conversions.cc and
 * src/base/numbers shaved (atoms/v8-numbers.ts): String(x), toString(radix), toFixed, toPrecision,
 * toExponential and ToNumber of a string, as Node gives them.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { canRun, harness } from "./__fixtures__/native-harness.js";
import { emitLlvmBoxed } from "./emit-llvm-boxed.js";
import { liftAtom } from "./lift.js";
describe.skipIf(!canRun("x86_64-linux"))("Number's conversions, V8's, natively (#1516)", () => {
  it("String, toString(16) and (7), toFixed, toPrecision, toExponential and Number(string) equal Node's", () => {
    const src = `export function f(x, s) { return [String(x), x.toString(16), x.toString(7), x.toFixed(3), x.toPrecision(5), x.toExponential(), x.toExponential(2), Number(s), +("  " + s + "\\n")]; }`;
    const run = harness(emitLlvmBoxed(liftAtom(src)), mkdtempSync(join(tmpdir(), "nc-")));
    const xs = [
      0,
      -0,
      1,
      -1,
      0.1,
      1 / 3,
      123.456,
      1e21,
      1.5e-7,
      5e-324,
      1.7976931348623157e308,
      2 ** 53,
      -2147483648,
      2147483647,
      2147483648,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      ...fc.sample(fc.double({ noNaN: true, noDefaultInfinity: true }), {
        numRuns: 60,
        seed: 1516,
      }),
    ];
    const ss = [
      "",
      " 12 ",
      "0x1F",
      "0o17",
      "0b101",
      "-0x1",
      "1e3",
      ".5",
      "5.",
      "Infinity",
      "-Infinity",
      "infinity",
      "1_000",
      " 12 ",
      "12px",
      "0x",
      "+.e1",
      "1e-400",
      "123456789012345678901234567890",
    ];
    const calls = xs.map((x, i) => [x, ss[i % ss.length] as string]);
    const { results, stderr } = run(calls);
    expect(results.length, stderr).toBe(calls.length);
    const bad: string[] = [];
    calls.forEach(([x, s], i) => {
      const n = x as number;
      const want = [
        String(n),
        n.toString(16),
        n.toString(7),
        n.toFixed(3),
        n.toPrecision(5),
        n.toExponential(),
        n.toExponential(2),
        Number(s),
        +`  ${s}\n`,
      ];
      if (JSON.stringify(results[i]) !== JSON.stringify(want) && bad.length < 8)
        bad.push(
          `${n} ${JSON.stringify(s)}: ${JSON.stringify(results[i])} vs ${JSON.stringify(want)}`,
        );
    });
    expect(bad).toEqual([]);
  }, 3_600_000);
});
