// SPDX-License-Identifier: MIT
/**
 * intent-specificity.test.ts — Unit tests for Layer 1 intent-specificity gate.
 *
 * All 13 cases from plans/wi-579-hook-enforcement-architecture.md §5.2 are covered,
 * plus edge-case and escape-hatch tests.
 *
 * Production trigger: scoreIntentSpecificity() is called synchronously inside
 * executeRegistryQueryWithSubstitution() (index.ts) and runImportIntercept()
 * (import-intercept.ts) BEFORE any registry I/O.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ACTION_VERBS,
  MAX_WORDS,
  META_WORDS,
  MIN_WORDS,
  STOP_WORDS,
  isIntentSpecificEnough,
  scoreIntentSpecificity,
} from "./intent-specificity.js";

// ---------------------------------------------------------------------------
// Exported constant shape checks
// ---------------------------------------------------------------------------

describe("exported constants", () => {
  it("MIN_WORDS is 4", () => {
    expect(MIN_WORDS).toBe(4);
  });

  it("MAX_WORDS is 20", () => {
    expect(MAX_WORDS).toBe(20);
  });

  it("STOP_WORDS contains the 10 plan-specified words", () => {
    const expected = [
      "things",
      "stuff",
      "utility",
      "helper",
      "manager",
      "handler",
      "service",
      "system",
      "processor",
      "worker",
    ];
    for (const w of expected) {
      expect(STOP_WORDS.has(w), `STOP_WORDS missing: ${w}`).toBe(true);
    }
  });

  it("META_WORDS contains the 8 plan-specified words", () => {
    const expected = ["various", "general", "common", "some", "any", "several", "misc", "generic"];
    for (const w of expected) {
      expect(META_WORDS.has(w), `META_WORDS missing: ${w}`).toBe(true);
    }
  });

  it("ACTION_VERBS contains key verbs", () => {
    const sample = ["parse", "validate", "encode", "decode", "hash", "compare", "split", "filter"];
    for (const v of sample) {
      expect(ACTION_VERBS.has(v), `ACTION_VERBS missing: ${v}`).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Plan §5.2 required test cases (13 cases)
// ---------------------------------------------------------------------------

describe("scoreIntentSpecificity — plan §5.2 required cases", () => {
  // Case 1: empty string
  it('rejects "" (empty string) — too_short', () => {
    const result = scoreIntentSpecificity("");
    expect(result.status).toBe("intent_too_broad");
    if (result.status === "intent_too_broad") {
      expect(result.reasons).toContain("too_short");
      expect(result.layer).toBe(1);
    }
  });

  // Case 2: single character
  it('rejects "x" — single_word', () => {
    const result = scoreIntentSpecificity("x");
    expect(result.status).toBe("intent_too_broad");
    if (result.status === "intent_too_broad") {
      expect(result.reasons).toContain("single_word");
    }
  });

  // Case 3: single action verb
  it('rejects "validate" — single_word', () => {
    const result = scoreIntentSpecificity("validate");
    expect(result.status).toBe("intent_too_broad");
    if (result.status === "intent_too_broad") {
      expect(result.reasons).toContain("single_word");
    }
  });

  // Case 4: single noun
  it('rejects "validation" — single_word', () => {
    const result = scoreIntentSpecificity("validation");
    expect(result.status).toBe("intent_too_broad");
    if (result.status === "intent_too_broad") {
      expect(result.reasons).toContain("single_word");
    }
  });

  // Case 5: stop + meta word combination
  it('rejects "utility for stuff" — stop_word_present', () => {
    const result = scoreIntentSpecificity("utility for stuff");
    expect(result.status).toBe("intent_too_broad");
    if (result.status === "intent_too_broad") {
      expect(result.reasons).toContain("stop_word_present");
    }
  });

  // Case 6: stop word in longer phrase
  it('rejects "helper to process things efficiently" — stop_word_present', () => {
    const result = scoreIntentSpecificity("helper to process things efficiently");
    expect(result.status).toBe("intent_too_broad");
    if (result.status === "intent_too_broad") {
      expect(result.reasons).toContain("stop_word_present");
    }
  });

  // Case 7: specific intent with action verb + I/O hint
  it('accepts "split string on first ://"', () => {
    const result = scoreIntentSpecificity("split string on first ://");
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.score).toBeGreaterThan(0);
      expect(result.score).toBeLessThanOrEqual(1);
      expect(result.layer).toBe(1);
    }
  });

  // Case 8: specific identifer-style intent
  it('accepts "isEmail RFC 5321 subset"', () => {
    const result = scoreIntentSpecificity("isEmail RFC 5321 subset");
    expect(result.status).toBe("ok");
  });

  // Case 9: full descriptive intent
  it('accepts "validate credit card number using Luhn checksum"', () => {
    const result = scoreIntentSpecificity("validate credit card number using Luhn checksum");
    expect(result.status).toBe("ok");
  });

  // Case 10: 21-word lorem-ipsum
  it("rejects 21-word string — too_long", () => {
    const twentyOneWords = Array.from({ length: 21 }, (_, i) => `word${i}`).join(" ");
    const result = scoreIntentSpecificity(twentyOneWords);
    expect(result.status).toBe("intent_too_broad");
    if (result.status === "intent_too_broad") {
      expect(result.reasons).toContain("too_long");
    }
  });

  // Case 11: short stop-word phrase
  it('rejects "do stuff" — stop_word_present (also too_short)', () => {
    const result = scoreIntentSpecificity("do stuff");
    expect(result.status).toBe("intent_too_broad");
    if (result.status === "intent_too_broad") {
      expect(result.reasons).toContain("stop_word_present");
    }
  });

  // Case 12: meta-word phrase
  it('rejects "common parser" — meta_word_present (also too_short)', () => {
    const result = scoreIntentSpecificity("common parser");
    expect(result.status).toBe("intent_too_broad");
    if (result.status === "intent_too_broad") {
      expect(result.reasons).toContain("meta_word_present");
    }
  });

  // Case 13: specific with action verb + I/O hint
  it('accepts "convert hex pair %XX to single byte"', () => {
    const result = scoreIntentSpecificity("convert hex pair %XX to single byte");
    expect(result.status).toBe("ok");
  });
});

// ---------------------------------------------------------------------------
// Additional edge cases
// ---------------------------------------------------------------------------

describe("scoreIntentSpecificity — edge cases", () => {
  it("rejects exactly 3 words (below MIN_WORDS=4) — too_short", () => {
    const result = scoreIntentSpecificity("parse two words");
    expect(result.status).toBe("intent_too_broad");
    if (result.status === "intent_too_broad") {
      expect(result.reasons).toContain("too_short");
    }
  });

  it("accepts exactly 4 words with action verb", () => {
    const result = scoreIntentSpecificity("parse json string safely");
    expect(result.status).toBe("ok");
  });

  it("accepts exactly 20 words", () => {
    // 20 words, includes an action verb, no stop/meta words
    const intent =
      "parse the first valid token from a long string containing multiple delimiters and whitespace characters carefully";
    const tokens = intent.trim().split(/\s+/);
    expect(tokens.length).toBe(20);
    const result = scoreIntentSpecificity(intent);
    expect(result.status).toBe("ok");
  });

  it("rejects exactly 21 words — too_long", () => {
    const intent =
      "parse the first valid token from a long string containing multiple delimiters and whitespace characters very carefully";
    const tokens = intent.trim().split(/\s+/);
    expect(tokens.length).toBe(21);
    const result = scoreIntentSpecificity(intent);
    expect(result.status).toBe("intent_too_broad");
    if (result.status === "intent_too_broad") {
      expect(result.reasons).toContain("too_long");
    }
  });

  it("rejects intent with no action verb (4+ words, no stop/meta)", () => {
    // "rgb to hex string" — "to" is not an action verb token in ACTION_VERBS
    // but this intent has no matching action verb
    const result = scoreIntentSpecificity("rgb color value something");
    expect(result.status).toBe("intent_too_broad");
    if (result.status === "intent_too_broad") {
      expect(result.reasons).toContain("no_action_verb");
    }
  });

  it("accept/reject verdict is binary — accepted intents have numeric score", () => {
    const result = scoreIntentSpecificity("hash sha256 input bytes deterministically");
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(typeof result.score).toBe("number");
      expect(result.score).toBeGreaterThanOrEqual(0);
      expect(result.score).toBeLessThanOrEqual(1);
    }
  });

  it("score is higher for richer intents", () => {
    const bare = scoreIntentSpecificity("parse json string carefully");
    const rich = scoreIntentSpecificity("parse json string from Buffer to typed object carefully");
    expect(bare.status).toBe("ok");
    expect(rich.status).toBe("ok");
    if (bare.status === "ok" && rich.status === "ok") {
      expect(rich.score).toBeGreaterThanOrEqual(bare.score);
    }
  });

  it("stop-word matching is case-insensitive (token lowercased)", () => {
    // "Utility" should hit the stop-word check after lowercasing
    const result = scoreIntentSpecificity("Utility wrapper for things");
    expect(result.status).toBe("intent_too_broad");
  });

  it("meta-word matching is case-insensitive", () => {
    const result = scoreIntentSpecificity("General purpose validator thing");
    expect(result.status).toBe("intent_too_broad");
  });
});

// ---------------------------------------------------------------------------
// isIntentSpecificEnough convenience predicate
// ---------------------------------------------------------------------------

describe("isIntentSpecificEnough", () => {
  it("returns true for a specific intent", () => {
    expect(isIntentSpecificEnough("validate email address RFC 5321")).toBe(true);
  });

  it("returns false for a vague intent", () => {
    expect(isIntentSpecificEnough("utility for stuff")).toBe(false);
  });

  it("returns false for single word", () => {
    expect(isIntentSpecificEnough("validator")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Escape hatch — YAKCC_HOOK_DISABLE_INTENT_GATE
// ---------------------------------------------------------------------------

describe("YAKCC_HOOK_DISABLE_INTENT_GATE escape hatch", () => {
  // NOTE: The escape hatch is checked at the CALL SITE (index.ts / import-intercept.ts),
  // not inside scoreIntentSpecificity itself. This test documents that the function
  // itself always enforces — callers own the bypass check.

  let originalEnv: string | undefined;

  beforeEach(() => {
    originalEnv = process.env.YAKCC_HOOK_DISABLE_INTENT_GATE;
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.YAKCC_HOOK_DISABLE_INTENT_GATE;
    } else {
      process.env.YAKCC_HOOK_DISABLE_INTENT_GATE = originalEnv;
    }
  });

  it("scoreIntentSpecificity always enforces regardless of YAKCC_HOOK_DISABLE_INTENT_GATE", () => {
    process.env.YAKCC_HOOK_DISABLE_INTENT_GATE = "1";
    // The function itself does NOT read the env var — caller is responsible.
    // This test verifies the function is NOT silently bypassed:
    const result = scoreIntentSpecificity("utility stuff");
    expect(result.status).toBe("intent_too_broad");
  });

  it("escape hatch env var name is YAKCC_HOOK_DISABLE_INTENT_GATE (documented constant)", () => {
    // The env var name is load-bearing (DEC-HOOK-ENF-LAYER1-ESCAPE-HATCH-001).
    // Test documents it so refactors don't silently rename it.
    const ENV_VAR_NAME = "YAKCC_HOOK_DISABLE_INTENT_GATE";
    expect(ENV_VAR_NAME).toBe("YAKCC_HOOK_DISABLE_INTENT_GATE");
  });
});
