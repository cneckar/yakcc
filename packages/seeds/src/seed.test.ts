// @decision DEC-SEEDS-TEST-T05-001: seed.test.ts updated for WI-T05 triplet migration.
// Status: implemented (WI-T05)
// Rationale: Block source is now in <name>/impl.ts; imports come from <name>/impl.js.
// Suite 1 (registry loading) asserts 21 rows via seedRegistry() returning merkleRoots.
// timer-handle (WI-460 / closes #454) added as block 21.
// Suite 2 (content-address round-trip) uses parseBlockTriplet on block directories.
// Suite 3 (strict-subset validation) reads impl.ts from the triplet directory.
// Suite 4 (property-test corpora) exercises functions imported from impl.js paths.
// Suite 5 (composition) exercises listOfInts end-to-end.
// Suite 6 (E2E compound-interaction) seeds registry and round-trips via selectBlocks
//   + getBlock — the new T03 API — instead of the removed registry.match() path.
//
// @decision DEC-V0-B4-CORPUS-EXPAND-001
// @title WI-481: 5 algorithm seed atoms for B4 GAP tasks
// @status accepted
// @rationale
//   The B4 benchmark matrix was producing zero active_substitutions because the
//   registry contained only parser-combinator atoms misaligned with the 5 GAP tasks.
//   WI-481 adds 5 hand-authored atoms directly targeting those tasks:
//     - lru-node        -> lru-cache-with-ttl (doubly-linked list node, O(1) eviction)
//     - memoize         -> levenshtein-with-memo (Map-backed memoization wrapper)
//     - queue-drain     -> dependency-resolver (Kahn's topological sort inner loop)
//     - base64-alphabet -> base64-encode (RFC 4648 alphabet + bit-shift encoder)
//     - semver-component-parser -> semver-range-satisfies (version string parser)
//   Block count increases from 21 to 26. All tests updated accordingly.
//   Per DEC-BENCH-METHODOLOGY-NEVER-SYNTHETIC-001 — no LLM-generated tests.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createOfflineEmbeddingProvider } from "@yakcc/contracts";
import { validateStrictSubset } from "@yakcc/ir";
import { openRegistry } from "@yakcc/registry";
import { afterEach, describe, expect, it } from "vitest";
import { asciiChar } from "./blocks/ascii-char/impl.js";
import { isAsciiDigit } from "./blocks/ascii-digit-set/impl.js";
import { base64Encode } from "./blocks/base64-alphabet/impl.js";
import { bracket } from "./blocks/bracket/impl.js";
import { charCode } from "./blocks/char-code/impl.js";
import { commaSeparatedIntegers } from "./blocks/comma-separated-integers/impl.js";
import { comma } from "./blocks/comma/impl.js";
import { digitOrThrow } from "./blocks/digit-or-throw/impl.js";
import { digit } from "./blocks/digit/impl.js";
import { emptyListContent } from "./blocks/empty-list-content/impl.js";
import { eofCheck } from "./blocks/eof-check/impl.js";
import { integer } from "./blocks/integer/impl.js";
import { listOfInts } from "./blocks/list-of-ints/impl.js";
import { makeLruNode } from "./blocks/lru-node/impl.js";
import { memoize } from "./blocks/memoize/impl.js";
import { nonAsciiRejector } from "./blocks/non-ascii-rejector/impl.js";
import { nonemptyListContent } from "./blocks/nonempty-list-content/impl.js";
import { optionalWhitespace } from "./blocks/optional-whitespace/impl.js";
import { peekChar } from "./blocks/peek-char/impl.js";
import { positionStep } from "./blocks/position-step/impl.js";
import { queueDrain } from "./blocks/queue-drain/impl.js";
import { parseSemver } from "./blocks/semver-component-parser/impl.js";
import { signedInteger } from "./blocks/signed-integer/impl.js";
import { stringFromPosition } from "./blocks/string-from-position/impl.js";
import { timerHandle } from "./blocks/timer-handle/impl.js";
import { whitespace } from "./blocks/whitespace/impl.js";
import { type SeedResult, seedRegistry } from "./seed.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const BLOCKS_DIR = join(dirname(fileURLToPath(import.meta.url)), "blocks");

/** Read the impl.ts source for a named block directory. */
function readBlockImpl(blockName: string): string {
  return readFileSync(join(BLOCKS_DIR, blockName, "impl.ts"), "utf-8");
}

/** Return the absolute path to a block directory. */
function blockDir(blockName: string): string {
  return join(BLOCKS_DIR, blockName);
}

const BLOCK_DIRS = [
  "ascii-char",
  "ascii-digit-set",
  "base64-alphabet",
  "bracket",
  "char-code",
  "comma",
  "comma-separated-integers",
  "digit",
  "digit-or-throw",
  "empty-list-content",
  "eof-check",
  "integer",
  "list-of-ints",
  "lru-node",
  "memoize",
  "non-ascii-rejector",
  "nonempty-list-content",
  "optional-whitespace",
  "peek-char",
  "position-step",
  "queue-drain",
  "semver-component-parser",
  "signed-integer",
  "string-from-position",
  "timer-handle",
  "whitespace",
] as const;

// ---------------------------------------------------------------------------
// Suite 1: Registry loading — seedRegistry stores all 26 blocks
// (21 original parser-combinator atoms + 5 B4 algorithm seed atoms, WI-481)
// ---------------------------------------------------------------------------

describe("seedRegistry", () => {
  it("stores all 26 blocks and returns their merkleRoots", async () => {
    const registry = await openRegistry(":memory:", {
      embeddings: createOfflineEmbeddingProvider(),
    });
    let result: SeedResult;
    try {
      result = await seedRegistry(registry);
    } finally {
      await registry.close();
    }
    expect(result.stored).toBe(26);
    expect(result.merkleRoots).toHaveLength(26);
  });

  it("is idempotent — calling seedRegistry twice does not throw or double-count", async () => {
    const registry = await openRegistry(":memory:", {
      embeddings: createOfflineEmbeddingProvider(),
    });
    try {
      const r1 = await seedRegistry(registry);
      const r2 = await seedRegistry(registry);
      expect(r1.stored).toBe(r2.stored);
      // merkleRoots must be identical (same content-addressed triplets)
      expect(r1.merkleRoots).toEqual(r2.merkleRoots);
    } finally {
      await registry.close();
    }
  }, 30_000);

  it("seedRegistry() re-runs deterministically — same BlockMerkleRoot for every block", async () => {
    // Run seedRegistry twice on separate in-memory DBs; merkleRoots must match.
    const registry1 = await openRegistry(":memory:", {
      embeddings: createOfflineEmbeddingProvider(),
    });
    const registry2 = await openRegistry(":memory:", {
      embeddings: createOfflineEmbeddingProvider(),
    });
    try {
      const r1 = await seedRegistry(registry1);
      const r2 = await seedRegistry(registry2);
      expect(r1.merkleRoots).toEqual(r2.merkleRoots);
      expect(r1.stored).toBe(26);
      expect(r2.stored).toBe(26);
    } finally {
      await registry1.close();
      await registry2.close();
    }
  }, 30_000);

  it("registry.selectBlocks finds each block by its specHash after seeding", async () => {
    const registry = await openRegistry(":memory:", {
      embeddings: createOfflineEmbeddingProvider(),
    });
    try {
      const { merkleRoots } = await seedRegistry(registry);
      const { parseBlockTriplet } = await import("@yakcc/ir");

      // Spot-check: digit block
      const digitResult = parseBlockTriplet(blockDir("digit"));
      const roots = await registry.selectBlocks(digitResult.specHashValue);
      expect(roots.length).toBeGreaterThan(0);
      expect(roots).toContain(digitResult.merkleRoot);
      // merkleRoot must be in the returned list
      expect(merkleRoots).toContain(digitResult.merkleRoot);
    } finally {
      await registry.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Suite 2: Content-address round-trip — parseBlockTriplet produces stable merkleRoot
// ---------------------------------------------------------------------------

describe("content-address round-trip", () => {
  for (const name of BLOCK_DIRS) {
    it(`${name}: merkleRoot is stable across two parseBlockTriplet calls`, async () => {
      const { parseBlockTriplet } = await import("@yakcc/ir");
      const r1 = parseBlockTriplet(blockDir(name));
      const r2 = parseBlockTriplet(blockDir(name));
      expect(r1.merkleRoot).toBe(r2.merkleRoot);
      expect(r1.specHashValue).toBe(r2.specHashValue);
    });
  }
});

// ---------------------------------------------------------------------------
// Suite 3: Strict-subset validation — every block's impl.ts passes
// ---------------------------------------------------------------------------

describe("strict-subset validation", () => {
  for (const name of BLOCK_DIRS) {
    it(`${name}: impl.ts passes validateStrictSubset`, () => {
      const source = readBlockImpl(name);
      const result = validateStrictSubset(source);
      if (!result.ok) {
        const msgs = result.errors.map((e) => `${e.rule}: ${e.message}`).join("\n");
        throw new Error(`Strict-subset violations in ${name}/impl.ts:\n${msgs}`);
      }
      expect(result.ok).toBe(true);
    });
  }
});

// ---------------------------------------------------------------------------
// Suite 4: Property-test corpus execution
// Each block's propertyTests cases are deterministic; we run the actual impl.
// ---------------------------------------------------------------------------

describe("property-test corpora", () => {
  describe("digit", () => {
    it("digit-zero: digit('0') returns 0", () => {
      expect(digit("0")).toBe(0);
    });
    it("digit-nine: digit('9') returns 9", () => {
      expect(digit("9")).toBe(9);
    });
    it("digit-five: digit('5') returns 5", () => {
      expect(digit("5")).toBe(5);
    });
    it("digit-non-numeric: digit('a') throws RangeError", () => {
      expect(() => digit("a")).toThrow(RangeError);
    });
    it("digit-empty: digit('') throws RangeError", () => {
      expect(() => digit("")).toThrow(RangeError);
    });
    it("digit-multi-char: digit('12') throws RangeError", () => {
      expect(() => digit("12")).toThrow(RangeError);
    });
  });

  describe("ascii-char", () => {
    it("ascii-char-first: asciiChar('abc', 0) returns 'a'", () => {
      expect(asciiChar("abc", 0)).toBe("a");
    });
    it("ascii-char-middle: asciiChar('abc', 1) returns 'b'", () => {
      expect(asciiChar("abc", 1)).toBe("b");
    });
    it("ascii-char-oob: asciiChar('abc', 3) throws RangeError", () => {
      expect(() => asciiChar("abc", 3)).toThrow(RangeError);
    });
    it("ascii-char-negative: asciiChar('abc', -1) throws RangeError", () => {
      expect(() => asciiChar("abc", -1)).toThrow(RangeError);
    });
    it("ascii-char-non-ascii: asciiChar('aéb', 1) throws RangeError", () => {
      expect(() => asciiChar("aéb", 1)).toThrow(RangeError);
    });
  });

  describe("ascii-digit-set", () => {
    it("ascii-digit-set-zero: isAsciiDigit('0') returns true", () => {
      expect(isAsciiDigit("0")).toBe(true);
    });
    it("ascii-digit-set-nine: isAsciiDigit('9') returns true", () => {
      expect(isAsciiDigit("9")).toBe(true);
    });
    it("ascii-digit-set-letter: isAsciiDigit('a') returns false", () => {
      expect(isAsciiDigit("a")).toBe(false);
    });
    it("ascii-digit-set-empty: isAsciiDigit('') returns false", () => {
      expect(isAsciiDigit("")).toBe(false);
    });
    it("ascii-digit-set-multi: isAsciiDigit('12') returns false", () => {
      expect(isAsciiDigit("12")).toBe(false);
    });
  });

  describe("peek-char", () => {
    it("peek-char-first: peekChar('abc', 0) returns 'a'", () => {
      expect(peekChar("abc", 0)).toBe("a");
    });
    it("peek-char-eof: peekChar('abc', 3) returns null", () => {
      expect(peekChar("abc", 3)).toBeNull();
    });
    it("peek-char-negative: peekChar('abc', -1) throws RangeError", () => {
      expect(() => peekChar("abc", -1)).toThrow(RangeError);
    });
    it("peek-char-empty-input: peekChar('', 0) returns null", () => {
      expect(peekChar("", 0)).toBeNull();
    });
    it("peek-char-last: peekChar('abc', 2) returns 'c'", () => {
      expect(peekChar("abc", 2)).toBe("c");
    });
  });

  describe("eof-check", () => {
    it("eof-check-exact: eofCheck('abc', 3) returns undefined", () => {
      expect(eofCheck("abc", 3)).toBeUndefined();
    });
    it("eof-check-trailing: eofCheck('abc', 2) throws SyntaxError", () => {
      expect(() => eofCheck("abc", 2)).toThrow(SyntaxError);
    });
    it("eof-check-overrun: eofCheck('abc', 4) throws RangeError", () => {
      expect(() => eofCheck("abc", 4)).toThrow(RangeError);
    });
    it("eof-check-empty: eofCheck('', 0) returns undefined", () => {
      expect(eofCheck("", 0)).toBeUndefined();
    });
    it("eof-check-empty-nonzero: eofCheck('', 1) throws RangeError", () => {
      expect(() => eofCheck("", 1)).toThrow(RangeError);
    });
  });

  describe("string-from-position", () => {
    it("strfrompos-basic: stringFromPosition('abcde', 1, 3) returns 'bc'", () => {
      expect(stringFromPosition("abcde", 1, 3)).toBe("bc");
    });
    it("strfrompos-empty: stringFromPosition('abc', 1, 1) returns ''", () => {
      expect(stringFromPosition("abc", 1, 1)).toBe("");
    });
    it("strfrompos-negative-start: stringFromPosition('abc', -1, 2) throws RangeError", () => {
      expect(() => stringFromPosition("abc", -1, 2)).toThrow(RangeError);
    });
    it("strfrompos-start-gt-end: stringFromPosition('abc', 2, 1) throws RangeError", () => {
      expect(() => stringFromPosition("abc", 2, 1)).toThrow(RangeError);
    });
    it("strfrompos-end-oob: stringFromPosition('abc', 0, 4) throws RangeError", () => {
      expect(() => stringFromPosition("abc", 0, 4)).toThrow(RangeError);
    });
  });

  describe("position-step", () => {
    it("pos-step-basic: positionStep(0, 3, 5) returns 3", () => {
      expect(positionStep(0, 3, 5)).toBe(3);
    });
    it("pos-step-to-end: positionStep(2, 3, 5) returns 5", () => {
      expect(positionStep(2, 3, 5)).toBe(5);
    });
    it("pos-step-overrun: positionStep(3, 3, 5) throws RangeError", () => {
      expect(() => positionStep(3, 3, 5)).toThrow(RangeError);
    });
    it("pos-step-negative-n: positionStep(0, -1, 5) throws RangeError", () => {
      expect(() => positionStep(0, -1, 5)).toThrow(RangeError);
    });
    it("pos-step-zero: positionStep(2, 0, 5) returns 2", () => {
      expect(positionStep(2, 0, 5)).toBe(2);
    });
  });

  describe("whitespace", () => {
    it("whitespace-spaces: whitespace('   x', 0) returns 3", () => {
      expect(whitespace("   x", 0)).toBe(3);
    });
    it("whitespace-tab: whitespace('\\tx', 0) returns 1", () => {
      expect(whitespace("\tx", 0)).toBe(1);
    });
    it("whitespace-none: whitespace('abc', 0) returns 0", () => {
      expect(whitespace("abc", 0)).toBe(0);
    });
    it("whitespace-mid: whitespace('a   b', 1) returns 4", () => {
      expect(whitespace("a   b", 1)).toBe(4);
    });
    it("whitespace-negative: whitespace('abc', -1) throws RangeError", () => {
      expect(() => whitespace("abc", -1)).toThrow(RangeError);
    });
    it("whitespace-eof: whitespace('abc', 3) returns 3", () => {
      expect(whitespace("abc", 3)).toBe(3);
    });
  });

  describe("bracket", () => {
    it("bracket-open: bracket('[abc', 0, '[') returns 1", () => {
      expect(bracket("[abc", 0, "[")).toBe(1);
    });
    it("bracket-close: bracket(']', 0, ']') returns 1", () => {
      expect(bracket("]", 0, "]")).toBe(1);
    });
    it("bracket-mismatch: bracket('[', 0, ']') throws SyntaxError", () => {
      expect(() => bracket("[", 0, "]")).toThrow(SyntaxError);
    });
    it("bracket-oob: bracket('', 0, '[') throws SyntaxError", () => {
      expect(() => bracket("", 0, "[")).toThrow(SyntaxError);
    });
    it("bracket-negative: bracket('[', -1, '[') throws RangeError", () => {
      expect(() => bracket("[", -1, "[")).toThrow(RangeError);
    });
  });

  describe("comma", () => {
    it("comma-match: comma(',abc', 0) returns 1", () => {
      expect(comma(",abc", 0)).toBe(1);
    });
    it("comma-mid: comma('a,b', 1) returns 2", () => {
      expect(comma("a,b", 1)).toBe(2);
    });
    it("comma-mismatch: comma('abc', 0) throws SyntaxError", () => {
      expect(() => comma("abc", 0)).toThrow(SyntaxError);
    });
    it("comma-eof: comma('', 0) throws SyntaxError", () => {
      expect(() => comma("", 0)).toThrow(SyntaxError);
    });
    it("comma-negative: comma(',', -1) throws RangeError", () => {
      expect(() => comma(",", -1)).toThrow(RangeError);
    });
  });

  describe("integer", () => {
    it("integer-single: integer('5', 0) returns [5, 1]", () => {
      expect(integer("5", 0)).toEqual([5, 1]);
    });
    it("integer-multi: integer('123', 0) returns [123, 3]", () => {
      expect(integer("123", 0)).toEqual([123, 3]);
    });
    it("integer-mid: integer('a42b', 1) returns [42, 3]", () => {
      expect(integer("a42b", 1)).toEqual([42, 3]);
    });
    it("integer-no-digit: integer('abc', 0) throws SyntaxError", () => {
      expect(() => integer("abc", 0)).toThrow(SyntaxError);
    });
    it("integer-eof: integer('', 0) throws SyntaxError", () => {
      expect(() => integer("", 0)).toThrow(SyntaxError);
    });
    it("integer-negative-pos: integer('1', -1) throws RangeError", () => {
      expect(() => integer("1", -1)).toThrow(RangeError);
    });
  });

  describe("digit-or-throw", () => {
    it("digitorthrow-zero: digitOrThrow('0x', 0) returns [0, 1]", () => {
      expect(digitOrThrow("0x", 0)).toEqual([0, 1]);
    });
    it("digitorthrow-nine: digitOrThrow('9', 0) returns [9, 1]", () => {
      expect(digitOrThrow("9", 0)).toEqual([9, 1]);
    });
    it("digitorthrow-letter: digitOrThrow('a', 0) throws SyntaxError", () => {
      expect(() => digitOrThrow("a", 0)).toThrow(SyntaxError);
    });
    it("digitorthrow-eof: digitOrThrow('', 0) throws SyntaxError", () => {
      expect(() => digitOrThrow("", 0)).toThrow(SyntaxError);
    });
    it("digitorthrow-negative: digitOrThrow('5', -1) throws RangeError", () => {
      expect(() => digitOrThrow("5", -1)).toThrow(RangeError);
    });
  });

  describe("optional-whitespace", () => {
    it("optws-none: optionalWhitespace('abc', 0) returns 0", () => {
      expect(optionalWhitespace("abc", 0)).toBe(0);
    });
    it("optws-space: optionalWhitespace('  x', 0) returns 2", () => {
      expect(optionalWhitespace("  x", 0)).toBe(2);
    });
    it("optws-tab: optionalWhitespace('\\tx', 0) returns 1", () => {
      expect(optionalWhitespace("\tx", 0)).toBe(1);
    });
    it("optws-eof: optionalWhitespace('', 0) returns 0", () => {
      expect(optionalWhitespace("", 0)).toBe(0);
    });
    it("optws-negative: optionalWhitespace('x', -1) throws RangeError", () => {
      expect(() => optionalWhitespace("x", -1)).toThrow(RangeError);
    });
  });

  describe("signed-integer", () => {
    it("signed-int-positive: signedInteger('42', 0) returns [42, 2]", () => {
      expect(signedInteger("42", 0)).toEqual([42, 2]);
    });
    it("signed-int-negative: signedInteger('-7', 0) returns [-7, 2]", () => {
      expect(signedInteger("-7", 0)).toEqual([-7, 2]);
    });
    it("signed-int-bare-minus: signedInteger('-x', 0) throws SyntaxError", () => {
      expect(() => signedInteger("-x", 0)).toThrow(SyntaxError);
    });
    it("signed-int-no-digit: signedInteger('abc', 0) throws SyntaxError", () => {
      expect(() => signedInteger("abc", 0)).toThrow(SyntaxError);
    });
    it("signed-int-eof: signedInteger('', 0) throws SyntaxError", () => {
      expect(() => signedInteger("", 0)).toThrow(SyntaxError);
    });
    it("signed-int-negative-pos: signedInteger('1', -1) throws RangeError", () => {
      expect(() => signedInteger("1", -1)).toThrow(RangeError);
    });
  });

  describe("non-ascii-rejector", () => {
    it("non-ascii-rejector-clean: nonAsciiRejector('hello') returns undefined", () => {
      expect(nonAsciiRejector("hello")).toBeUndefined();
    });
    it("non-ascii-rejector-empty: nonAsciiRejector('') returns undefined", () => {
      expect(nonAsciiRejector("")).toBeUndefined();
    });
    it("non-ascii-rejector-unicode: nonAsciiRejector('café') throws RangeError", () => {
      expect(() => nonAsciiRejector("café")).toThrow(RangeError);
    });
    it("non-ascii-rejector-digits: nonAsciiRejector('[1,2,3]') returns undefined", () => {
      expect(nonAsciiRejector("[1,2,3]")).toBeUndefined();
    });
    it("non-ascii-rejector-mid: nonAsciiRejector('ab\\u0080c') throws RangeError", () => {
      expect(() => nonAsciiRejector("abc")).toThrow(RangeError);
    });
  });

  describe("empty-list-content", () => {
    it("empty-list-ok: emptyListContent(']', 0) returns 1", () => {
      expect(emptyListContent("]", 0)).toBe(1);
    });
    it("empty-list-mid: emptyListContent('[]', 1) returns 2", () => {
      expect(emptyListContent("[]", 1)).toBe(2);
    });
    it("empty-list-nonempty: emptyListContent('[1]', 1) throws SyntaxError", () => {
      expect(() => emptyListContent("[1]", 1)).toThrow(SyntaxError);
    });
    it("empty-list-eof: emptyListContent('', 0) throws SyntaxError", () => {
      expect(() => emptyListContent("", 0)).toThrow(SyntaxError);
    });
    it("empty-list-negative: emptyListContent(']', -1) throws RangeError", () => {
      expect(() => emptyListContent("]", -1)).toThrow(RangeError);
    });
  });

  describe("nonempty-list-content", () => {
    it("nonempty-single: nonemptyListContent('1]', 0) returns [[1], 2]", () => {
      expect(nonemptyListContent("1]", 0)).toEqual([[1], 2]);
    });
    it("nonempty-multiple: nonemptyListContent('1,2,3]', 0) returns [[1, 2, 3], 6]", () => {
      expect(nonemptyListContent("1,2,3]", 0)).toEqual([[1, 2, 3], 6]);
    });
    it("nonempty-spaces: nonemptyListContent(' 42 ]', 0) returns [[42], 5]", () => {
      expect(nonemptyListContent(" 42 ]", 0)).toEqual([[42], 5]);
    });
    it("nonempty-no-digit: nonemptyListContent('x]', 0) throws SyntaxError", () => {
      expect(() => nonemptyListContent("x]", 0)).toThrow(SyntaxError);
    });
    it("nonempty-no-close: nonemptyListContent('1,2', 0) throws SyntaxError", () => {
      expect(() => nonemptyListContent("1,2", 0)).toThrow(SyntaxError);
    });
  });

  describe("comma-separated-integers", () => {
    it("commasep-none: commaSeparatedIntegers(']', 0) returns [[], 0]", () => {
      expect(commaSeparatedIntegers("]", 0)).toEqual([[], 0]);
    });
    it("commasep-one: commaSeparatedIntegers(',2]', 0) returns [[2], 2]", () => {
      expect(commaSeparatedIntegers(",2]", 0)).toEqual([[2], 2]);
    });
    it("commasep-two: commaSeparatedIntegers(',2,3]', 0) returns [[2, 3], 4]", () => {
      expect(commaSeparatedIntegers(",2,3]", 0)).toEqual([[2, 3], 4]);
    });
    it("commasep-trailing-comma: commaSeparatedIntegers(',]', 0) throws SyntaxError", () => {
      expect(() => commaSeparatedIntegers(",]", 0)).toThrow(SyntaxError);
    });
    it("commasep-negative-pos: commaSeparatedIntegers(',1', -1) throws RangeError", () => {
      expect(() => commaSeparatedIntegers(",1", -1)).toThrow(RangeError);
    });
  });

  describe("char-code", () => {
    it("char-code-zero: charCode('0abc', 0) returns 48", () => {
      expect(charCode("0abc", 0)).toBe(48);
    });
    it("char-code-a: charCode('abc', 0) returns 97", () => {
      expect(charCode("abc", 0)).toBe(97);
    });
    it("char-code-oob: charCode('abc', 3) throws RangeError", () => {
      expect(() => charCode("abc", 3)).toThrow(RangeError);
    });
    it("char-code-negative: charCode('abc', -1) throws RangeError", () => {
      expect(() => charCode("abc", -1)).toThrow(RangeError);
    });
    it("char-code-bracket: charCode('[', 0) returns 91", () => {
      expect(charCode("[", 0)).toBe(91);
    });
  });

  describe("timer-handle", () => {
    it("timer-fires: timerHandle returns object with cancel function", () => {
      // Verify the API shape; timer fires after delayMs (tested with fake timers in unit tests)
      let fired = false;
      const handle = timerHandle(() => {
        fired = true;
      }, 10_000);
      expect(typeof handle.cancel).toBe("function");
      // cancel immediately — fires must be false (timer not elapsed)
      handle.cancel();
      expect(fired).toBe(false);
    });
    it("timer-cancel-prevents-fire: cancel() called synchronously prevents callback", () => {
      let callCount = 0;
      const handle = timerHandle(() => {
        callCount++;
      }, 10_000);
      handle.cancel();
      // After cancel, callCount should remain 0 (timer cleared)
      expect(callCount).toBe(0);
    });
    it("timer-cancel-idempotent: cancel() called twice does not throw", () => {
      const handle = timerHandle(() => {}, 10_000);
      // First cancel
      handle.cancel();
      // Second cancel — must not throw
      expect(() => handle.cancel()).not.toThrow();
    });
  });

  // WI-481: B4 algorithm seed atoms
  describe("lru-node", () => {
    it("lru-node-key-stored: makeLruNode('k', 1).key === 'k'", () => {
      expect(makeLruNode("k", 1).key).toBe("k");
    });
    it("lru-node-value-stored: makeLruNode('k', 42).value === 42", () => {
      expect(makeLruNode("k", 42).value).toBe(42);
    });
    it("lru-node-prev-null: makeLruNode('k', 1).prev === null", () => {
      expect(makeLruNode("k", 1).prev).toBeNull();
    });
    it("lru-node-next-null: makeLruNode('k', 1).next === null", () => {
      expect(makeLruNode("k", 1).next).toBeNull();
    });
    it("lru-node-independent: two makeLruNode calls produce distinct objects", () => {
      const a = makeLruNode("a", 1);
      const b = makeLruNode("b", 2);
      expect(a).not.toBe(b);
      expect(a.key).toBe("a");
      expect(b.key).toBe("b");
    });
    it("lru-node-mutable-prev: node.prev can be assigned to another node", () => {
      const a = makeLruNode("a", 1);
      const b = makeLruNode("b", 2);
      a.prev = b;
      expect(a.prev).toBe(b);
    });
  });

  describe("memoize", () => {
    it("memoize-returns-same-value: memoized(2, 3) returns same value as fn(2, 3)", () => {
      const fn = (a: unknown, b: unknown) => (a as number) + (b as number);
      const keyFn = (a: unknown, b: unknown) => `${a},${b}`;
      const mem = memoize(fn, keyFn);
      expect(mem(2, 3)).toBe(5);
    });
    it("memoize-calls-fn-once: fn called exactly once for repeated identical arguments", () => {
      let callCount = 0;
      const fn = (x: unknown) => {
        callCount++;
        return x;
      };
      const mem = memoize(fn, (x) => String(x));
      mem(42);
      mem(42);
      mem(42);
      expect(callCount).toBe(1);
    });
    it("memoize-different-keys-call-fn: fn called for each distinct key", () => {
      let callCount = 0;
      const fn = (x: unknown) => {
        callCount++;
        return x;
      };
      const mem = memoize(fn, (x) => String(x));
      mem(1);
      mem(2);
      mem(3);
      expect(callCount).toBe(3);
    });
    it("memoize-cache-hit-identity: second call returns same object reference", () => {
      const obj = { value: 99 };
      const fn = () => obj;
      const mem = memoize(fn, () => "k");
      const r1 = mem();
      const r2 = mem();
      expect(r1).toBe(r2);
    });
    it("memoize-exception-not-cached: if fn throws, next call re-invokes fn", () => {
      let callCount = 0;
      const fn = () => {
        callCount++;
        throw new Error("boom");
      };
      const mem = memoize(fn, () => "k");
      expect(() => mem()).toThrow("boom");
      expect(() => mem()).toThrow("boom");
      expect(callCount).toBe(2);
    });
  });

  describe("queue-drain", () => {
    it("queue-drain-linear: linear chain A->B->C visits all 3 nodes in order", () => {
      const visited: string[] = [];
      const inDegree = new Map([["A", 0], ["B", 1], ["C", 1]]);
      const adjacency = new Map([["A", ["B"]], ["B", ["C"]], ["C", []]]);
      const queue = ["A"];
      const count = queueDrain(queue, inDegree, adjacency, (n) => visited.push(n));
      expect(count).toBe(3);
      expect(visited).toEqual(["A", "B", "C"]);
    });
    it("queue-drain-empty: empty queue returns 0 and calls onVisit zero times", () => {
      const visited: string[] = [];
      const inDegree: Map<string, number> = new Map();
      const adjacency: Map<string, string[]> = new Map();
      const count = queueDrain([], inDegree, adjacency, (n) => visited.push(n));
      expect(count).toBe(0);
      expect(visited).toEqual([]);
    });
    it("queue-drain-single: single node with no edges visits once and returns 1", () => {
      const visited: string[] = [];
      const inDegree = new Map([["X", 0]]);
      const adjacency: Map<string, string[]> = new Map();
      const count = queueDrain(["X"], inDegree, adjacency, (n) => visited.push(n));
      expect(count).toBe(1);
      expect(visited).toEqual(["X"]);
    });
    it("queue-drain-diamond: diamond DAG visits all 4 nodes, visitCount === 4", () => {
      // A -> B, A -> C, B -> D, C -> D
      const visited: string[] = [];
      const inDegree = new Map([["A", 0], ["B", 1], ["C", 1], ["D", 2]]);
      const adjacency = new Map([["A", ["B", "C"]], ["B", ["D"]], ["C", ["D"]], ["D", []]]);
      const count = queueDrain(["A"], inDegree, adjacency, (n) => visited.push(n));
      expect(count).toBe(4);
      expect(visited).toContain("A");
      expect(visited).toContain("D");
      // D must come after both B and C
      expect(visited.indexOf("B")).toBeLessThan(visited.indexOf("D"));
      expect(visited.indexOf("C")).toBeLessThan(visited.indexOf("D"));
    });
    it("queue-drain-cycle-detected: cycle produces visitCount < total nodes", () => {
      // B -> C -> B (cycle); A -> B
      const visited: string[] = [];
      const inDegree = new Map([["A", 0], ["B", 2], ["C", 1]]);
      const adjacency = new Map([["A", ["B"]], ["B", ["C"]], ["C", ["B"]]]);
      const count = queueDrain(["A"], inDegree, adjacency, (n) => visited.push(n));
      expect(count).toBeLessThan(3);
    });
    it("queue-drain-parallel: two independent chains each process correctly", () => {
      // A -> B and C -> D (parallel)
      const visited: string[] = [];
      const inDegree = new Map([["A", 0], ["B", 1], ["C", 0], ["D", 1]]);
      const adjacency = new Map([["A", ["B"]], ["B", []], ["C", ["D"]], ["D", []]]);
      const count = queueDrain(["A", "C"], inDegree, adjacency, (n) => visited.push(n));
      expect(count).toBe(4);
      expect(visited).toContain("A");
      expect(visited).toContain("B");
      expect(visited).toContain("C");
      expect(visited).toContain("D");
    });
  });

  describe("base64-alphabet", () => {
    it("base64-empty: base64Encode([], false) returns empty string", () => {
      expect(base64Encode([], false)).toBe("");
    });
    it("base64-standard-known: base64Encode([77,97,110], false) returns 'TWFu' (RFC 4648 example)", () => {
      // 'Man' in ASCII is [77, 97, 110]; RFC 4648 Table 1 example
      expect(base64Encode([77, 97, 110], false)).toBe("TWFu");
    });
    it("base64-url-safe-known: bytes that produce '+' in standard return '-' in url-safe", () => {
      // Find input that produces '+' in standard base64. '+' is index 62 in standard alphabet.
      // We need 6-bit group == 62. E.g., [0xfb, 0xff, 0xff]:
      // i0 = 0xfb >> 2 = 0x3e = 62 -> '+'
      const standard = base64Encode([0xfb, 0xff, 0xff], false);
      expect(standard[0]).toBe("+");
      const urlSafe = base64Encode([0xfb, 0xff, 0xff], true);
      expect(urlSafe[0]).toBe("-");
    });
    it("base64-output-length: output length === (bytes.length / 3) * 4 for valid input", () => {
      expect(base64Encode([1, 2, 3], false)).toHaveLength(4);
      expect(base64Encode([1, 2, 3, 4, 5, 6], false)).toHaveLength(8);
    });
    it("base64-invalid-length: bytes.length not a multiple of 3 throws RangeError", () => {
      expect(() => base64Encode([1, 2], false)).toThrow(RangeError);
      expect(() => base64Encode([1], false)).toThrow(RangeError);
    });
    it("base64-byte-out-of-range: byte value 256 throws RangeError", () => {
      expect(() => base64Encode([256, 0, 0], false)).toThrow(RangeError);
    });
    it("base64-all-zeros: base64Encode([0,0,0], false) returns 'AAAA'", () => {
      expect(base64Encode([0, 0, 0], false)).toBe("AAAA");
    });
    it("base64-all-255: base64Encode([255,255,255], false) returns '////'", () => {
      expect(base64Encode([255, 255, 255], false)).toBe("////");
    });
  });

  describe("semver-component-parser", () => {
    it("semver-simple: parseSemver('1.2.3') returns correct components", () => {
      expect(parseSemver("1.2.3")).toEqual({ major: 1, minor: 2, patch: 3, prerelease: null, build: null });
    });
    it("semver-prerelease: parseSemver('1.0.0-alpha.1') returns prerelease 'alpha.1'", () => {
      const r = parseSemver("1.0.0-alpha.1");
      expect(r.prerelease).toBe("alpha.1");
      expect(r.build).toBeNull();
    });
    it("semver-build: parseSemver('1.0.0+build.42') returns build 'build.42'", () => {
      const r = parseSemver("1.0.0+build.42");
      expect(r.build).toBe("build.42");
      expect(r.prerelease).toBeNull();
    });
    it("semver-prerelease-and-build: parseSemver captures both prerelease and build", () => {
      const r = parseSemver("1.2.3-beta+exp.sha.5114f85");
      expect(r.prerelease).toBe("beta");
      expect(r.build).toBe("exp.sha.5114f85");
    });
    it("semver-zeros: parseSemver('0.0.0') returns all-zero components", () => {
      expect(parseSemver("0.0.0")).toEqual({ major: 0, minor: 0, patch: 0, prerelease: null, build: null });
    });
    it("semver-large-numbers: parseSemver('100.200.300') returns major=100, minor=200, patch=300", () => {
      const r = parseSemver("100.200.300");
      expect(r.major).toBe(100);
      expect(r.minor).toBe(200);
      expect(r.patch).toBe(300);
    });
    it("semver-invalid-no-dots: parseSemver('1') throws SyntaxError", () => {
      expect(() => parseSemver("1")).toThrow(SyntaxError);
    });
    it("semver-invalid-non-numeric: parseSemver('a.b.c') throws SyntaxError", () => {
      expect(() => parseSemver("a.b.c")).toThrow(SyntaxError);
    });
    it("semver-empty: parseSemver('') throws SyntaxError", () => {
      expect(() => parseSemver("")).toThrow(SyntaxError);
    });
  });
});

// ---------------------------------------------------------------------------
// Suite 5: Composition tests — listOfInts is the top-level end-to-end test
// ---------------------------------------------------------------------------

describe("listOfInts composition", () => {
  it("parses an empty list '[]'", () => {
    expect(listOfInts("[]")).toEqual([]);
  });

  it("parses a single-element list '[1]'", () => {
    expect(listOfInts("[1]")).toEqual([1]);
  });

  it("parses '[1,2,3]'", () => {
    expect(listOfInts("[1,2,3]")).toEqual([1, 2, 3]);
  });

  it("parses '[ 42 ]' with surrounding whitespace", () => {
    expect(listOfInts("[ 42 ]")).toEqual([42]);
  });

  it("parses '[  1 , 2  ,  3  ]' with varied whitespace", () => {
    expect(listOfInts("[  1 , 2  ,  3  ]")).toEqual([1, 2, 3]);
  });

  it("parses '[0]'", () => {
    expect(listOfInts("[0]")).toEqual([0]);
  });

  it("parses multi-digit integers '[10,200,3000]'", () => {
    expect(listOfInts("[10,200,3000]")).toEqual([10, 200, 3000]);
  });

  it("rejects '[1,2,' — incomplete list", () => {
    expect(() => listOfInts("[1,2,")).toThrow(SyntaxError);
  });

  it("rejects '[abc]' — non-digit content", () => {
    expect(() => listOfInts("[abc]")).toThrow(SyntaxError);
  });

  it("rejects '1,2,3]' — missing opening bracket", () => {
    expect(() => listOfInts("1,2,3]")).toThrow(SyntaxError);
  });

  it("rejects '[1]x' — trailing garbage", () => {
    expect(() => listOfInts("[1]x")).toThrow(SyntaxError);
  });

  it("rejects '' — empty string", () => {
    expect(() => listOfInts("")).toThrow(SyntaxError);
  });

  it("rejects '[1,2,3' — missing closing bracket", () => {
    expect(() => listOfInts("[1,2,3")).toThrow(SyntaxError);
  });
});

// ---------------------------------------------------------------------------
// Suite 6: End-to-end production sequence — seed + selectBlocks + getBlock + parse
// Compound-interaction test crossing multiple internal components:
// seedRegistry → registry.selectBlocks(specHash) → registry.getBlock(merkleRoot)
// → parseBlockTriplet (for spec) → listOfInts (function execution)
// ---------------------------------------------------------------------------

describe("end-to-end: seed → selectBlocks → getBlock → parse → compose", () => {
  let registryInstance: Awaited<ReturnType<typeof openRegistry>> | null = null;

  afterEach(async () => {
    if (registryInstance !== null) {
      await registryInstance.close();
      registryInstance = null;
    }
  });

  it("seeds registry, looks up list-of-ints by specHash, retrieves block, and parses '[1,2,3]'", async () => {
    const registry = await openRegistry(":memory:", {
      embeddings: createOfflineEmbeddingProvider(),
    });
    registryInstance = registry;

    // Step 1: Seed the registry
    const { stored, merkleRoots } = await seedRegistry(registry);
    expect(stored).toBe(26);
    expect(merkleRoots.length).toBe(26);

    // Step 2: Parse list-of-ints triplet to get its specHash
    const { parseBlockTriplet } = await import("@yakcc/ir");
    const listResult = parseBlockTriplet(blockDir("list-of-ints"));
    expect(listResult.validation.ok).toBe(true);

    // Step 3: Look up by specHash — content-address lookup via new T03 API
    const roots = await registry.selectBlocks(listResult.specHashValue);
    expect(roots.length).toBeGreaterThan(0);
    expect(roots).toContain(listResult.merkleRoot);

    // Step 4: Retrieve the full block row by merkleRoot
    const row = await registry.getBlock(listResult.merkleRoot);
    expect(row).not.toBeNull();
    if (row === null) throw new Error("list-of-ints block not found in registry");
    expect(row.blockMerkleRoot).toBe(listResult.merkleRoot);
    expect(row.level).toBe("L0");

    // Step 5: Use the block function to parse a real input — proving composition works
    const result = listOfInts("[1,2,3]");
    expect(result).toEqual([1, 2, 3]);

    // Step 6: Verify the merkleRoot is in the returned list
    expect(merkleRoots).toContain(listResult.merkleRoot);
  });

  it("verifies all blocks parse successfully via parseBlockTriplet after migration", async () => {
    const registry = await openRegistry(":memory:", {
      embeddings: createOfflineEmbeddingProvider(),
    });
    registryInstance = registry;

    const { parseBlockTriplet } = await import("@yakcc/ir");

    await seedRegistry(registry);

    for (const name of BLOCK_DIRS) {
      const result = parseBlockTriplet(blockDir(name));

      expect(result.validation.ok, `${name}/impl.ts failed strict-subset`).toBe(true);
      expect(result.spec, `${name} missing spec`).toBeDefined();
      expect(result.merkleRoot, `${name} missing merkleRoot`).toBeTruthy();
      expect(result.spec.level).toBe("L0");
      // timer-handle has effects (timer scheduling); queue-drain and memoize also have effects
      // (mutation and closure). All other blocks are pure with empty effects.
      const hasEffects = name === "timer-handle" || name === "queue-drain" || name === "memoize";
      if (!hasEffects) {
        expect(result.spec.effects, `${name} effects should be empty for pure blocks`).toEqual([]);
      }

      // Verify block is findable in registry
      const roots = await registry.selectBlocks(result.specHashValue);
      expect(roots, `${name} not found in registry`).toContain(result.merkleRoot);
    }
  });
});
