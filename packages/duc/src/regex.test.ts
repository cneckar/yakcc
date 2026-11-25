// SPDX-License-Identifier: Apache-2.0
/**
 * The regex compiler's matchers (DEC-DUC-REGEX-GRAPH-001) against V8's: each pattern's matcher source,
 * run as JavaScript, must find the match and the captures RegExp#exec finds, at every start.
 */
import { describe, expect, it } from "vitest";
import { regexMatcherSource } from "./regex.js";

type Matcher = (s: string, start: number, sticky: boolean) => number[] | null;
const matcherOf = (pattern: string, flags: string): Matcher =>
  new Function(`${regexMatcherSource(pattern, flags).source}; return f;`)() as Matcher;

/** V8's match at or after `start`, as the matcher reports it. */
function v8(pattern: string, flags: string, s: string, start: number): number[] | null {
  const re = new RegExp(pattern, `${flags.replace(/[gy]/g, "")}gd`);
  re.lastIndex = start;
  const m = re.exec(s);
  if (m === null) return null;
  return (m.indices as unknown as ([number, number] | undefined)[]).flatMap((p) => p ?? [-1, -1]);
}

const CASES: [string, string, string[]][] = [
  ["(?<=\\$)\\d+", "", ["cost $42 or 7", "$", "no", "$$1"]],
  ["(?<!\\$)\\b\\d+", "", ["cost $42 or 7", "12 $3 45"]],
  ["(?<=(\\w)(\\w))x", "", ["abx", "x", "a x"]],
  ["(?<=(a+))b", "", ["aaab", "b", "cab"]],
  ["(?<=(\\w)\\1)z", "", ["aaz", "abz", "z"]],
  ["(?<=\\n)", "", ["a\nb\n", "none"]],
  ["(?<=^|,)\\s*(\\w*)", "", ["a, b,,c", ""]],
  ["(?<=a(?=b)b)c", "", ["abc", "ac"]],
  ["(?<=(?<!x)y)z", "", ["yz xyz", "z"]],
  ["(?<=ab|c)d", "", ["abd cd xd", "bd"]],
  ["(?<=[^a-c]{2})e", "", ["xye abe", "e"]],
  ["(?<=A)b", "i", ["aB Ab ab", "b"]],
  ["(?<=\\u{1F600})x", "u", ["\u{1F600}x x", "\uDE00x"]],
  ["(?<=.)$", "m", ["ab\ncd", ""]],
  ["(?<=a*?)b", "", ["aab", "b"]],
];

describe("regex matchers against V8's", () => {
  for (const [pattern, flags, inputs] of CASES)
    it(`/${pattern}/${flags}`, () => {
      const f = matcherOf(pattern, flags);
      for (const s of inputs)
        for (let start = 0; start <= s.length; start++)
          expect(f(s, start, false), `${JSON.stringify(s)} at ${start}`).toEqual(
            v8(pattern, flags, s, start),
          );
    });
});
