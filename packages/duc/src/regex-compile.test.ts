// SPDX-License-Identifier: Apache-2.0
/**
 * Regular expression literals (#1311): the compiled program and the matcher's atoms (in their
 * JavaScript form) against the engine's RegExp, on generated patterns, flags and inputs; exactly,
 * captures included. The lowered atoms are checked against the reference in the bytecode suites.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { atomInJs } from "./__fixtures__/bytecode-cases.js";
import { RegexError, compileRegex } from "./regex-compile.js";

const ch = fc.constantFrom("a", "b", "-", " ", "A", "z", "Z", "\\.", "\\n", "é");
const cls = fc.constantFrom("[ab]", "[^a]", "[a-c]", "[-a]", "[\\s\\d]", "[^\\w]", "\\d", "\\s", "\\w", "\\W", "\\S", ".");
const quant = fc.constantFrom("", "", "*", "+", "?", "{0,2}", "{1,3}", "{2}", "*?", "+?", "??", "{1,2}?", "{0,}");
const anchor = fc.constantFrom("^", "$", "\\b", "\\B");

/** Patterns of the subset: atoms, groups, alternatives, quantifiers, lookaheads, backreferences. */
const pattern: fc.Arbitrary<string> = fc.letrec((tie) => ({
  atom: fc.oneof(
    { weight: 4, arbitrary: ch },
    { weight: 3, arbitrary: cls },
    { weight: 2, arbitrary: tie("alt").map((x) => `(${x as string})`) },
    { weight: 1, arbitrary: tie("alt").map((x) => `(?:${x as string})`) },
  ),
  term: fc.oneof(
    { weight: 6, arbitrary: fc.tuple(tie("atom"), quant).map(([a, q]) => `${a as string}${q}`) },
    { weight: 1, arbitrary: anchor },
    { weight: 1, arbitrary: tie("alt").map((x) => `(?=${x as string})`) },
    { weight: 1, arbitrary: tie("alt").map((x) => `(?!${x as string})`) },
    { weight: 1, arbitrary: fc.constantFrom("\\1", "\\2") },
  ),
  seq: fc.array(tie("term"), { minLength: 0, maxLength: 4 }).map((xs) => (xs as string[]).join("")),
  alt: fc
    .array(tie("seq"), { minLength: 1, maxLength: 3 })
    .map((xs) => (xs as string[]).join("|")),
})).alt as fc.Arbitrary<string>;

const flags = fc.constantFrom("", "g", "i", "m", "s", "y", "gi", "gm", "gy", "ims", "gimsy");
const input = fc.stringMatching(/^[ab\- A\n.ézZ]{0,8}$/);

/** A literal of the subset, with the engine's RegExp for it; undefined when outside either. */
function both(src: string, fl: string): { prog: number[]; re: RegExp } | undefined {
  let re: RegExp;
  try {
    re = new RegExp(src, fl);
  } catch {
    return undefined;
  }
  try {
    return { prog: [...compileRegex(`/${src}/${fl}`).program], re };
  } catch (e) {
    if (e instanceof RegexError) return undefined;
    throw e;
  }
}

describe("regular expression literals match as the engine's RegExp does (#1311)", () => {
  const execArr = atomInJs("__ykReExecArr");
  const test = atomInJs("__ykReTest");
  const search = atomInJs("__ykReSearch");
  const match = atomInJs("__ykReMatch");
  const replace = atomInJs("__ykReReplace");
  const split = atomInJs("__ykReSplit");
  const run = fc.sample(fc.tuple(pattern, flags, input), { numRuns: 3000, seed: 1311 });

  it("exec, test, search, match, replace (a template and a callback) and split, on 3000 generated cases", () => {
    const bad: string[] = [];
    let compared = 0;
    for (const [src, fl, s] of run) {
      const r = both(src, fl);
      if (r === undefined) continue;
      compared++;
      const fresh = () => new RegExp(r.re.source, r.re.flags);
      const got = [
        execArr(r.prog, s),
        test(r.prog, s),
        search(r.prog, s),
        match(r.prog, s),
        replace(r.prog, s, "<$&|$1|$`|$'|$$|$2|$10>"),
        replace(r.prog, s, (...a: unknown[]) => JSON.stringify(a)),
        split(r.prog, s, undefined),
        split(r.prog, s, 2),
      ];
      const ex = fresh().exec(s);
      const want = [
        ex === null ? null : [...ex],
        fresh().test(s),
        s.search(fresh()),
        ((m) => (m === null ? null : [...m]))(s.match(fresh())),
        s.replace(fresh(), "<$&|$1|$`|$'|$$|$2|$10>"),
        s.replace(fresh(), (...a: unknown[]) => JSON.stringify(a)),
        s.split(fresh()),
        s.split(fresh(), 2),
      ];
      if (JSON.stringify(got) !== JSON.stringify(want) && bad.length < 5)
        bad.push(`/${src}/${fl} on ${JSON.stringify(s)}: ${JSON.stringify(got)} vs ${JSON.stringify(want)}`);
    }
    expect(bad).toEqual([]);
    expect(compared).toBeGreaterThan(1500);
  }, 120_000);

  it("refuses what is outside the subset, with the reason", () => {
    const reason = (lit: string): string => {
      try {
        compileRegex(lit);
      } catch (e) {
        if (e instanceof RegexError) return e.message;
        throw e;
      }
      return "compiled";
    };
    expect(reason("/a/u")).toMatch(/flag u/);
    expect(reason("/(?<=a)b/")).toMatch(/lookbehind/);
    expect(reason("/(?<n>a)/")).toMatch(/named groups/);
    expect(reason("/é/i")).toMatch(/non-ASCII character with the i flag/);
    expect(reason("/(a)\\1/i")).toMatch(/backreference with the i flag/);
    expect(reason("/\\2(a)/")).toMatch(/octal or identity escape/);
    expect(reason("/a{/")).toMatch(/not a quantifier/);
    expect(reason("/\\p/")).toMatch(/identity escape/);
    expect(reason("/[\\d-z]/")).toMatch(/range's end/);
  });
});
