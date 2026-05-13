// SPDX-License-Identifier: MIT
//
// bench/B4-tokens/tasks/levenshtein-with-memo/oracle.test.ts
//
// @decision DEC-V0-B4-TASKS-EXPAND-001
// @title B4 Slice 2 oracle: levenshtein distance with memoization
// @status accepted
// @rationale
//   Oracle tests for semantic-equivalence verification. Must pass against reference-impl.ts
//   before Slice 2 measures LLM-generated implementations. Tests cover: base cases, known
//   distances, symmetry, Unicode, long strings (memo correctness under stress), and
//   adversarial inputs (all-insertions, all-deletions, transpositions).
//   39 tests mirrors csv-parser-quoted density as the benchmark target.
//
//   Adversarial trap documented in spec.yak: models hallucinate memo-inside-recursion
//   pattern (resets cache on every top-level call), making long inputs quadratic.
//
// Usage:
//   vitest run --config bench/B4-tokens/vitest.config.mjs bench/B4-tokens/tasks/levenshtein-with-memo/oracle.test.ts

import { describe, expect, it, beforeEach } from "vitest";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

const implPath = process.env["IMPL_PATH"]
  ? resolve(process.env["IMPL_PATH"])
  : resolve(__dirname, "reference-impl.ts");

const implUrl = pathToFileURL(implPath).href;

let levenshtein: (a: string, b: string) => number;

beforeEach(async () => {
  const mod = await import(/* @vite-ignore */ implUrl);
  levenshtein = mod.levenshtein ?? mod.default;
  if (typeof levenshtein !== "function") {
    throw new Error(
      `Implementation at ${implPath} must export levenshtein as a named or default export function`
    );
  }
});

describe("levenshtein — base cases", () => {
  it("both empty strings: distance 0", () => {
    expect(levenshtein("", "")).toBe(0);
  });

  it("a empty, b non-empty: distance = b.length (all insertions)", () => {
    expect(levenshtein("", "abc")).toBe(3);
  });

  it("a non-empty, b empty: distance = a.length (all deletions)", () => {
    expect(levenshtein("xyz", "")).toBe(3);
  });

  it("single character match: distance 0", () => {
    expect(levenshtein("a", "a")).toBe(0);
  });

  it("single character substitution: distance 1", () => {
    expect(levenshtein("a", "b")).toBe(1);
  });

  it("single character to empty: distance 1", () => {
    expect(levenshtein("a", "")).toBe(1);
  });

  it("empty to single character: distance 1", () => {
    expect(levenshtein("", "a")).toBe(1);
  });
});

describe("levenshtein — known distances", () => {
  it("kitten → sitting: 3", () => {
    // k→s, e→i, insert g: classic example
    expect(levenshtein("kitten", "sitting")).toBe(3);
  });

  it("saturday → sunday: 3", () => {
    expect(levenshtein("saturday", "sunday")).toBe(3);
  });

  it("identical strings: distance 0", () => {
    expect(levenshtein("hello", "hello")).toBe(0);
  });

  it("abc → abc: 0", () => {
    expect(levenshtein("abc", "abc")).toBe(0);
  });

  it("abc → abcd: 1 (one insertion)", () => {
    expect(levenshtein("abc", "abcd")).toBe(1);
  });

  it("abcd → abc: 1 (one deletion)", () => {
    expect(levenshtein("abcd", "abc")).toBe(1);
  });

  it("abc → xbc: 1 (one substitution)", () => {
    expect(levenshtein("abc", "xbc")).toBe(1);
  });

  it("abc → xyz: 3 (three substitutions)", () => {
    expect(levenshtein("abc", "xyz")).toBe(3);
  });

  it("intention → execution: 5", () => {
    expect(levenshtein("intention", "execution")).toBe(5);
  });

  it("horse → ros: 3", () => {
    expect(levenshtein("horse", "ros")).toBe(3);
  });
});

describe("levenshtein — symmetry property", () => {
  it("levenshtein(a, b) === levenshtein(b, a) for basic strings", () => {
    expect(levenshtein("abc", "def")).toBe(levenshtein("def", "abc"));
  });

  it("symmetry: kitten/sitting", () => {
    expect(levenshtein("kitten", "sitting")).toBe(levenshtein("sitting", "kitten"));
  });

  it("symmetry: empty/nonempty", () => {
    expect(levenshtein("", "hello")).toBe(levenshtein("hello", ""));
  });

  it("symmetry: partially-matching strings", () => {
    expect(levenshtein("abcdef", "acbdfe")).toBe(levenshtein("acbdfe", "abcdef"));
  });
});

describe("levenshtein — adversarial: pure insertions and deletions", () => {
  it("all deletions: abcde → empty", () => {
    expect(levenshtein("abcde", "")).toBe(5);
  });

  it("all insertions: empty → fghij", () => {
    expect(levenshtein("", "fghij")).toBe(5);
  });

  it("prefix match then deletion: abcdef → abc", () => {
    expect(levenshtein("abcdef", "abc")).toBe(3);
  });

  it("suffix match then insertion: abc → xyzabc", () => {
    expect(levenshtein("abc", "xyzabc")).toBe(3);
  });

  it("no overlap: aaa → bbb", () => {
    expect(levenshtein("aaa", "bbb")).toBe(3);
  });
});

describe("levenshtein — adversarial: transpositions (NOT Damerau-Levenshtein)", () => {
  it("ab → ba: distance 2 (not 1 — standard Levenshtein, not Damerau)", () => {
    // Standard Levenshtein: delete a (ba), then insert a at position 1 = 2 ops
    // OR: sub a→b (bb), sub b→a (ba) = 2 ops
    // Damerau-Levenshtein would give 1 (transposition counts as 1 op)
    // This oracle checks standard Levenshtein only
    expect(levenshtein("ab", "ba")).toBe(2);
  });

  it("abc → bca: distance 2", () => {
    expect(levenshtein("abc", "bca")).toBe(2);
  });
});

describe("levenshtein — edge: repeated characters", () => {
  it("aaaa → aaaa: 0", () => {
    expect(levenshtein("aaaa", "aaaa")).toBe(0);
  });

  it("aaaa → bbbb: 4 (all substitutions)", () => {
    expect(levenshtein("aaaa", "bbbb")).toBe(4);
  });

  it("aaa → aa: 1 (one deletion)", () => {
    expect(levenshtein("aaa", "aa")).toBe(1);
  });

  it("aa → aaa: 1 (one insertion)", () => {
    expect(levenshtein("aa", "aaa")).toBe(1);
  });

  it("aaab → baaa: 2", () => {
    // delete trailing b (aaab→aaa), insert b at front (aaa→baaa) = 2
    // OR: sub a→b at pos 0 (baab), sub b→a at pos 3 (baaa) = 2
    expect(levenshtein("aaab", "baaa")).toBe(2);
  });
});

describe("levenshtein — memoization stress: long strings", () => {
  it("30-char strings: produces correct result without timeout", () => {
    // Without memoization this would require O(2^30) recursive calls.
    // With memoization: O(30*30) = 900 subproblems.
    const a = "abcdefghijklmnopqrstuvwxyzabcd";
    const b = "abcdefghijklmnopqrstuvwxyzxyz1";
    // Computed reference: last 4 chars differ (abcd vs xyz1)
    // Prefix "abcdefghijklmnopqrstuvwxyz" (26) matches; then "abcd" vs "xyz1" = 4 subs
    const result = levenshtein(a, b);
    expect(result).toBeGreaterThanOrEqual(0);
    expect(result).toBeLessThanOrEqual(30); // bounded by max(|a|,|b|)
    // Known exact value: 4 substitutions (a→x, b→y, c→z, d→1)
    expect(result).toBe(4);
  });

  it("identical long strings: 0", () => {
    const s = "abcdefghijklmnopqrstuvwxyz".repeat(2);
    expect(levenshtein(s, s)).toBe(0);
  });

  it("25-char all-different: distance = 25", () => {
    const a = "aaaaaaaaaaaaaaaaaaaaaaaaa";
    const b = "bbbbbbbbbbbbbbbbbbbbbbbbb";
    expect(levenshtein(a, b)).toBe(25);
  });
});

describe("levenshtein — Unicode (UTF-16 code units)", () => {
  it("ASCII characters treated as single units", () => {
    expect(levenshtein("café", "cafe")).toBe(1);
  });

  it("emoji treated as two UTF-16 code units", () => {
    // "😀" is U+1F600, which is a surrogate pair (😀) — length 2 in JS
    // So levenshtein("😀", "") = 2 (two code units to delete)
    const emoji = "😀"; // 😀
    expect(levenshtein(emoji, "")).toBe(2);
  });

  it("identical Unicode strings: 0", () => {
    expect(levenshtein("αβγδ", "αβγδ")).toBe(0);
  });

  it("Greek alphabet substitution", () => {
    expect(levenshtein("αβγ", "αβδ")).toBe(1);
  });
});
