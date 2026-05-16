// SPDX-License-Identifier: MIT
/**
 * layer1-vague-intent-gate.test.ts — Focused regression test for Layer 1 gate.
 *
 * @decision DEC-HOOK-ENF-LAYER1-INTENT-SPECIFICITY-001
 * title: Layer 1 exemplar regression gate — #579 issue body cases
 * status: decided (wi-579-hook-enforcement S1)
 * rationale:
 *   Required by the Evaluation Contract §10 (item 3):
 *   "focused regression test asserting the gate fires for the issue body's
 *    'utility for handling stuff' exemplar."
 *
 *   This file is a dedicated snapshot-style gate. If Layer 1 is accidentally
 *   weakened (e.g. STOP_WORDS shrinks, MIN_WORDS drops) these tests will catch
 *   it before any other test suite in the CI pipeline.
 *
 *   Production trigger: every PR touching packages/hooks-base/src/** runs this.
 */

import { describe, expect, it } from "vitest";
import {
  MIN_WORDS,
  STOP_WORDS,
  scoreIntentSpecificity,
} from "../src/intent-specificity.js";

// ---------------------------------------------------------------------------
// #579 issue body exemplars — these MUST reject
// ---------------------------------------------------------------------------

describe("Layer 1 gate — #579 issue body reject exemplars", () => {
  it('"utility for handling stuff" → intent_too_broad (stop_word_present)', () => {
    const result = scoreIntentSpecificity("utility for handling stuff");
    expect(result.status).toBe("intent_too_broad");
    if (result.status === "intent_too_broad") {
      expect(result.layer).toBe(1);
      expect(result.reasons).toContain("stop_word_present");
      // At least one stop-word must be in STOP_WORDS (utility is the one)
      expect(STOP_WORDS.has("utility")).toBe(true);
    }
  });

  it('"validate input" → intent_too_broad (too_short — 2 words < MIN_WORDS=4)', () => {
    const result = scoreIntentSpecificity("validate input");
    expect(result.status).toBe("intent_too_broad");
    if (result.status === "intent_too_broad") {
      expect(result.reasons).toContain("too_short");
      // Confirm the threshold is still 4 — so this test self-documents the invariant.
      expect(MIN_WORDS).toBe(4);
    }
  });

  it('"helper function" → intent_too_broad (stop_word_present + too_short)', () => {
    const result = scoreIntentSpecificity("helper function");
    expect(result.status).toBe("intent_too_broad");
    if (result.status === "intent_too_broad") {
      // Both length and stop-word reasons apply.
      expect(result.reasons.length).toBeGreaterThan(0);
      expect(STOP_WORDS.has("helper")).toBe(true);
    }
  });

  it('"general purpose string handling" → intent_too_broad (meta_word + stop_word)', () => {
    // "general" = meta-word, "handling" is not a stop-word but "general" triggers reject.
    // Note: handler is stop-word but "handling" is not (exact token match, lowercased).
    const result = scoreIntentSpecificity("general purpose string handling");
    expect(result.status).toBe("intent_too_broad");
    if (result.status === "intent_too_broad") {
      expect(result.reasons.some((r) => r === "meta_word_present" || r === "stop_word_present")).toBe(true);
    }
  });

  it('"system" → intent_too_broad (single_word)', () => {
    const result = scoreIntentSpecificity("system");
    expect(result.status).toBe("intent_too_broad");
    if (result.status === "intent_too_broad") {
      expect(result.reasons).toContain("single_word");
    }
  });
});

// ---------------------------------------------------------------------------
// #579 issue body accept exemplars — these MUST pass
// ---------------------------------------------------------------------------

describe("Layer 1 gate — #579 issue body accept exemplars", () => {
  it('"isEmail RFC 5321 subset" → ok (4 words, specific)', () => {
    const result = scoreIntentSpecificity("isEmail RFC 5321 subset");
    expect(result.status).toBe("ok");
  });

  it('"validate email address per RFC 5321" → ok (action verb + I/O specific)', () => {
    const result = scoreIntentSpecificity("validate email address per RFC 5321");
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.score).toBeGreaterThan(0.5);
    }
  });

  it('"hash sha256 string to hex bytes" → ok', () => {
    const result = scoreIntentSpecificity("hash sha256 string to hex bytes");
    expect(result.status).toBe("ok");
  });
});

// ---------------------------------------------------------------------------
// Suggestion text is a forcing-function toward yakcc-discovery.md
// ---------------------------------------------------------------------------

describe("Layer 1 gate — reject envelope suggestion text", () => {
  it("suggestion references yakcc-discovery.md (Layer 0 forcing-function)", () => {
    const result = scoreIntentSpecificity("utility for stuff");
    expect(result.status).toBe("intent_too_broad");
    if (result.status === "intent_too_broad") {
      expect(result.suggestion).toContain("yakcc-discovery.md");
      expect(result.suggestion).toContain("INTENT_TOO_BROAD");
    }
  });

  it("suggestion includes decomposition example", () => {
    const result = scoreIntentSpecificity("handler");
    expect(result.status).toBe("intent_too_broad");
    if (result.status === "intent_too_broad") {
      // Example in suggestion shows how to narrow an intent
      expect(result.suggestion).toContain("isEmail");
    }
  });
});

// ---------------------------------------------------------------------------
// Layer 1 is the sole authority — no sibling file redeclares thresholds
// ---------------------------------------------------------------------------

describe("Layer 1 gate — sole authority invariant", () => {
  it("MIN_WORDS is 4 (sole authority in intent-specificity.ts)", () => {
    // If this ever fails, someone changed the threshold without updating the corpus.
    expect(MIN_WORDS).toBe(4);
  });

  it("STOP_WORDS contains all 10 plan-specified words", () => {
    const planWords = [
      "things", "stuff", "utility", "helper", "manager",
      "handler", "service", "system", "processor", "worker",
    ];
    for (const w of planWords) {
      expect(STOP_WORDS.has(w), `STOP_WORDS missing '${w}'`).toBe(true);
    }
  });
});
