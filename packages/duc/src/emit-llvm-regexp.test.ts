// SPDX-License-Identifier: Apache-2.0
/**
 * Regular expressions compiled at run time in the native runtime (`new RegExp(string)`, rx.h,
 * #1331): every match, its groups and their indices, and split and replace, against Node's, for
 * patterns the program builds from strings; and the SyntaxError a bad pattern or flag gives.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { canRun, harness, same } from "./__fixtures__/native-harness.js";
import { emitLlvmBoxed } from "./emit-llvm-boxed.js";
import { liftAtom } from "./lift.js";

const work = mkdtempSync(join(tmpdir(), "yakcc-rx-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

const SOURCE = `export function f(p, fl, s) {
  let re;
  try { re = new RegExp(p, fl); } catch (e) { return [e.name]; }
  const all = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
  const out = [];
  let m;
  let guard = 0;
  while ((m = all.exec(s)) !== null && guard++ < 50) {
    out.push([m.index, [...m], m.groups === undefined ? null : Object.entries(m.groups)]);
    if (m[0] === "") all.lastIndex++;
  }
  return [out, s.split(re).length, s.replace(re, "<$&>"), re.test(s), re.flags];
}`;

const CASES: [string, string, string[]][] = [
  [String.raw`a+b`, "", ["aaab ab b", ""]],
  [String.raw`(\d+)-(\d+)`, "", ["10-20 3-4 x-5"]],
  [String.raw`(?<y>\d{4})-(?<m>\d\d)?`, "", ["2024-05 1999- 12"]],
  [String.raw`^\s*(\w+)\s*$`, "m", ["  one \n two\nthree four"]],
  [String.raw`[^a-c\d]+`, "i", ["ABCdef123XYZ"]],
  [String.raw`(a|ab)(c|bcd)(d*)`, "", ["abcd abcdd"]],
  [String.raw`(a*)*b`, "", ["aaab b"]],
  [String.raw`(?:x|y){2,3}?z`, "", ["xyxz yyyyz"]],
  [String.raw`(\w)\1`, "i", ["aA bb Cc dE"]],
  [String.raw`\b\w`, "g", ["hello big world"]],
  [String.raw`(?=(\w+))\w`, "", ["abc"]],
  [String.raw`(?<=\$)\d+(?!\d|\.)`, "", ["$12 $3.5 $40"]],
  [String.raw`(?<!x)y+`, "", ["xyy yy zyy"]],
  [String.raw`\u{1F600}+.`, "u", ["\u{1F600}\u{1F600}a b"]],
  [String.raw`.`, "su", ["\n\u{1F600}"]],
  [String.raw`[A-C]\x44\cJ?`, "", ["ABD\n CD"]],
  [String.raw`\k<n>(?<n>a)`, "", ["aa"]],
  [String.raw`a{2}b{1,}c{0,1}`, "y", ["aabbc aab"]],
  [String.raw`[\]\-]|\/|a{,2}|x{`, "", ["]-/a{,2}x{"]],
  [String.raw`\x4gé\08`, "i", ["\x04gÉ\x008"]],
  [String.raw`^(?:\+|-)?\d+(?:\.\d+)?(?:e[+-]?\d+)?$`, "i", ["-12.5E+3", "1.", ".5"]],
  ["\\", "", ["x"]],
  ["(", "", ["x"]],
  ["a", "gg", ["a"]],
  ["[b-a]", "", ["x"]],
  ["a**", "", ["x"]],
  ["", "", ["ab"]],
];

describe.skipIf(!canRun("x86_64-linux"))("RegExp compiled at run time, natively (#1331)", () => {
  it("matches, groups, split, replace and errors as Node's", () => {
    const ref = new Function(`${SOURCE.replace(/^export /, "")}; return f;`)() as (
      ...a: unknown[]
    ) => unknown;
    const calls = CASES.flatMap(([p, fl, inputs]) => inputs.map((s) => [p, fl, s]));
    const run = harness(emitLlvmBoxed(liftAtom(SOURCE)), work);
    const { results, stderr } = run(calls);
    expect(results.length, stderr).toBe(calls.length);
    for (const [i, args] of calls.entries()) {
      const want = ref(...args);
      expect(
        same(results[i], want),
        `${JSON.stringify(args)}: native ${JSON.stringify(results[i])}, node ${JSON.stringify(want)}`,
      ).toBe(true);
    }
  }, 300_000);
});
