// SPDX-License-Identifier: Apache-2.0
/**
 * The regex compiler's matchers (DEC-DUC-REGEX-GRAPH-001) against V8's: each pattern's matcher source,
 * run as JavaScript, must find the match and the captures RegExp#exec finds, at every start.
 */
import { describe, expect, it } from "vitest";
import { regexMatcherSource } from "./regex.js";
import {
  UNICODE_PROPERTY_NAMES,
  UNICODE_PROPERTY_RANGES,
  UNICODE_VERSION,
} from "./unicode-properties.js";

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
  // Anchored at the start (no m): only position 0 can match, from any start.
  ["^#!.*", "", ["#!/usr/bin/env node\nx", "x#!y"]],
  ["^a|^b", "g", ["ab ba", "ba"]],
  ["(^x)+", "", ["xx", "yx"]],
  ["^x", "m", ["a\nx\nx"]],
  // Unicode property escapes (with u), from the generated table.
  ["\\p{L}+", "u", ["12h\u00e9llo\u4e16\u754c!", "\u{1F600}"]],
  ["\\P{L}", "gu", ["a1-\u00df_\u03a9\u{1F600}"]],
  [
    "^(\\p{Extended_Pictographic}|\\p{Emoji_Component})+$",
    "u",
    ["\u{1F600}\u{1F44D}\u{1F3FD}", "ab"],
  ],
  ["\\p{Script=Greek}+", "u", ["Gr\u00fc\u00dfe, \u1f08\u03b8\u1fc6\u03bd\u03b1\u03b9"]],
  ["[\\p{Lu}\\d]+", "u", ["abCD12ef"]],
  ["\\p{gc=Nd}", "u", ["\u0663", "x"]],
  ["[^\\p{White_Space}]+", "u", ["  \u00a0 xy z"]],
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

describe("the Unicode property table, as the host's RegExp has it (#1331)", () => {
  it("each property's code points, every one of them, and each name of it", () => {
    // Every name to its property, as the host has it; each property's code points, all of them.
    for (const name of Object.keys(UNICODE_PROPERTY_NAMES)) new RegExp(`\\p{${name}}`, "u");
    const first = new Map<string, string>();
    for (const [name, property] of Object.entries(UNICODE_PROPERTY_NAMES))
      if (!first.has(property)) first.set(property, name);
    for (const [property, name] of first) {
      const re = new RegExp(`^\\p{${name}}$`, "u");
      const inTable = new Set<number>();
      for (const r of (UNICODE_PROPERTY_RANGES[property] as string).split(",")) {
        if (r === "") continue;
        const [a, b] = r.split("-").map((x) => Number.parseInt(x, 36)) as [number, number?];
        for (let c = a; c <= (b ?? a); c++) inTable.add(c);
      }
      let differ = 0;
      for (let c = 0; c <= 0x10ffff; c++)
        if (inTable.has(c) !== re.test(String.fromCodePoint(c))) differ++;
      expect([property, differ]).toEqual([property, 0]);
    }
    expect(UNICODE_VERSION).toBe(process.versions.unicode);
  }, 300_000);
});
