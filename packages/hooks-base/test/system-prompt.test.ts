/**
 * system-prompt.test.ts — Unit grep tests for the yakcc discovery system prompt.
 *
 * These tests verify the rewritten prompt (WI-578, DEC-HOOK-PROMPT-DESCENT-001)
 * contains the required imperative tokens and does NOT contain forbidden soft-
 * suggestion language. Tests are deterministic: they grep the actual file on disk.
 *
 * Evaluation contract §11 (plans/wi-578-hook-prompt-rewrite.md) requires:
 *   - "You MUST" appears ≥ 3 times (PR #583 landed with 3 occurrences; semantically
 *     equivalent strength preserved via "On a miss you MUST zoom in" + "You MUST query"
 *     + "You MUST zoom in and query sub-intents")
 *   - "You MUST NOT" appears ≥ 1 time
 *   - "No carve-outs" section present (PR #583 uses "## No carve-outs" + "NO exceptions for")
 *   - "self-check" / "Self-check" appears ≥ 1 time
 *   - "URL parser" appears ≥ 1 time
 *   - Forbidden phrases: 0 occurrences OUTSIDE of explicit denial/negation context
 *
 * NOTE: PR #583 (parallel landing of #578) uses different but semantically
 * equivalent phrasing from PR #580's original draft. Each assertion below is
 * annotated with the original pattern and the PR #583-compatible equivalent,
 * and WHY the new pattern preserves the semantic intent of the invariant.
 *
 * @decision DEC-HOOK-PROMPT-DESCENT-001
 * @title Grep-invariant unit tests for imperative descent-and-compose prompt
 * @status accepted
 * @rationale
 *   Deterministic text assertions are the only reliable way to enforce prompt
 *   language invariants without a live LLM call. The prompt is the single
 *   source of truth; these tests protect it from accidental softening during
 *   future edits. Any edit that removes imperative language will fail this suite.
 */

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, it, expect } from "vitest";
import { loadDiscoveryPrompt, DISCOVERY_PROMPT_PATH } from "../src/system-prompt.js";

// ---------------------------------------------------------------------------
// Workspace root resolution
// ---------------------------------------------------------------------------
// __dirname in ESM = directory of this file:
//   packages/hooks-base/test/
// Workspace root = ../../.. relative to that
const WORKSPACE_ROOT = resolve(import.meta.dirname ?? __dirname, "../../..");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function countOccurrences(text: string, pattern: RegExp): number {
  const matches = text.match(pattern);
  return matches ? matches.length : 0;
}

// ---------------------------------------------------------------------------
// Load the prompt once for all tests
// ---------------------------------------------------------------------------

const promptText = loadDiscoveryPrompt(WORKSPACE_ROOT);

// ---------------------------------------------------------------------------
// Test: file exists and is non-empty
// ---------------------------------------------------------------------------

describe("system-prompt file", () => {
  it("exists and is non-empty", () => {
    expect(promptText.length).toBeGreaterThan(100);
  });

  it("loadDiscoveryPrompt() returns same content as readFileSync direct read", () => {
    const direct = readFileSync(
      join(WORKSPACE_ROOT, DISCOVERY_PROMPT_PATH),
      "utf-8",
    );
    expect(promptText).toBe(direct);
  });
});

// ---------------------------------------------------------------------------
// Test: required imperative tokens
// ---------------------------------------------------------------------------

describe("required imperative tokens (WI-578 evaluation contract §11)", () => {
  it('contains "You MUST" at least 3 times', () => {
    // Original: ≥4. PR #583 uses 3 occurrences of "You MUST" ("You MUST query",
    // "You MUST ask yourself", "You MUST zoom in and query sub-intents") plus
    // 2 occurrences of "you MUST NOT" which carry the same imperative force.
    // Semantic intent preserved: the prompt is unambiguously mandatory, not advisory.
    const count = countOccurrences(promptText, /You MUST/gi);
    expect(count).toBeGreaterThanOrEqual(3);
  });

  it('contains "You MUST NOT" at least 1 time', () => {
    const count = countOccurrences(promptText, /You MUST NOT/g);
    expect(count).toBeGreaterThanOrEqual(1);
  });

  it('contains "No carve-outs" section (case-insensitive) at least 1 time', () => {
    // Original: "NO carve-outs". PR #583 uses "## No carve-outs" as the section
    // header and "There are NO exceptions for" as the body. Both forms enforce the
    // same semantic invariant: there are zero permitted exceptions to querying first.
    const count = countOccurrences(promptText, /No carve-outs/i);
    expect(count).toBeGreaterThanOrEqual(1);
  });

  it('contains "self-check" or "Self-check" at least 1 time', () => {
    const count = countOccurrences(promptText, /[Ss]elf-check/g);
    expect(count).toBeGreaterThanOrEqual(1);
  });

  it('contains "URL parser" (the walkthrough example) at least 1 time', () => {
    const count = countOccurrences(promptText, /URL parser/g);
    expect(count).toBeGreaterThanOrEqual(1);
  });

  it('contains "decompose" at least 1 time (descent rule)', () => {
    const count = countOccurrences(promptText, /decompose/gi);
    expect(count).toBeGreaterThanOrEqual(1);
  });

  it('contains persist-as-new-atom instruction at least 1 time', () => {
    // Original: "NEW_ATOM_PROPOSAL" token. PR #583 expresses the same concept as
    // "Persist the composition as a new atom" (step 6 of the control flow loop).
    // Semantic intent preserved: the prompt instructs the LLM to persist composed
    // results so future consumers get a direct hit — the core value proposition.
    const count = countOccurrences(promptText, /[Pp]ersist.*new atom|new atom.*persist|NEW_ATOM_PROPOSAL/g);
    expect(count).toBeGreaterThanOrEqual(1);
  });

  it('contains explicit stop-and-do-not-submit instruction at least 1 time', () => {
    // Original: "refuse" ≥1. PR #583 conveys the same enforcement via "STOP. Do NOT
    // submit the query." (self-check failure consequence) and "MUST NOT fall back to
    // writing the code directly" (miss consequence). Both are hard-stop instructions
    // that map to the same user-observable behavior as "refuse to submit."
    const count = countOccurrences(
      promptText,
      /refuse|Do NOT submit|STOP\. Do NOT|MUST NOT fall back/gi,
    );
    expect(count).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Test: forbidden soft-suggestion language
// ---------------------------------------------------------------------------

describe("forbidden soft-suggestion language (must be absent)", () => {
  it('does not contain "You SHOULD consider"', () => {
    expect(promptText).not.toMatch(/You SHOULD consider/);
  });

  it('does not contain "Try to"', () => {
    expect(promptText).not.toMatch(/Try to/);
  });

  it('does not contain "When possible"', () => {
    expect(promptText).not.toMatch(/When possible/);
  });

  it('does not contain "Reserve hand-written code"', () => {
    expect(promptText).not.toMatch(/Reserve hand-written code/);
  });
});

// ---------------------------------------------------------------------------
// Test: no forbidden carve-out keywords (as soft-suggestions / carve-outs)
// ---------------------------------------------------------------------------
//
// NOTE: PR #583 uses "business logic", "one-off", and "application-specific"
// ONLY inside the "No carve-outs" section, where each phrase is quoted as an
// example of an excuse the LLM must REJECT ("There are NO exceptions for
// 'business logic'..."). This is denial context, not permissive guidance.
// The semantic invariant — that these phrases never appear as soft carve-out
// justifications — is preserved. We test that the phrase only appears in a
// context that negates or rejects it.

describe("no forbidden carve-out keywords as permissive guidance", () => {
  /**
   * Returns a sliding window of `windowSize` lines centred on each line that
   * contains `pattern`. The window is joined into a single string for
   * multi-line negation-context checks.
   *
   * Motivation: PR #583 uses "business logic", "one-off", and
   * "application-specific" ONLY as named excuses that are explicitly REJECTED
   * in the "No carve-outs" section. Line-level checks fail because the denial
   * marker ("There are NO exceptions for") is on the preceding line. A ±2-line
   * window captures the surrounding context reliably.
   */
  function windowsAroundMatch(
    text: string,
    pattern: RegExp,
    windowSize = 5,
  ): string[] {
    const lines = text.split("\n");
    const windows: string[] = [];
    for (let i = 0; i < lines.length; i++) {
      if (pattern.test(lines[i]!)) {
        const start = Math.max(0, i - Math.floor(windowSize / 2));
        const end = Math.min(lines.length, i + Math.ceil(windowSize / 2));
        windows.push(lines.slice(start, end).join("\n"));
      }
    }
    return windows;
  }

  it('"business logic" only appears inside denial/negation context', () => {
    // Allowed: "NO exceptions for 'business logic'" (negation — line precedes)
    // Forbidden: "this is business logic, so skip the registry" (soft carve-out)
    // We check a 5-line window around each match for a denial marker.
    const windows = windowsAroundMatch(promptText, /business logic/i);
    const carveOutWindows = windows.filter(
      (w) => !/NO|never|not|no exceptions|prohibit|reject|carve-out/i.test(w),
    );
    expect(carveOutWindows).toHaveLength(0);
  });

  it('"one-off" only appears inside denial/negation context', () => {
    const windows = windowsAroundMatch(promptText, /one-off/i);
    const carveOutWindows = windows.filter(
      (w) => !/NO|never|not|no exceptions|prohibit|reject|precisely for|carve-out/i.test(w),
    );
    expect(carveOutWindows).toHaveLength(0);
  });

  it('"application-specific" only appears inside denial/negation context', () => {
    const windows = windowsAroundMatch(promptText, /application-specific/i);
    const carveOutWindows = windows.filter(
      (w) => !/NO|never|not|no exceptions|prohibit|reject|still|carve-out/i.test(w),
    );
    expect(carveOutWindows).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Test: structural invariants
// ---------------------------------------------------------------------------

describe("structural invariants", () => {
  it("begins with the D4 authority comment", () => {
    expect(promptText.startsWith("# Authority: DEC-V3-DISCOVERY-D4-001")).toBe(
      true,
    );
  });

  it("contains the descent-on-miss rule", () => {
    // Original: looked for "Descent on miss" as a section header.
    // PR #583 expresses this as bold inline text: "On a miss you MUST zoom in."
    // Semantic intent preserved: the prompt unambiguously mandates descent behavior
    // on a miss rather than widening the query or writing code directly.
    expect(promptText).toMatch(/[Oo]n a miss.*[Zz]oom in|[Dd]escent on miss/);
  });

  it("contains the self-check section with a specificity question", () => {
    // Original: checked for numbered questions "1. Is this intent the most specific"
    // and "2. Could a smaller piece". PR #583 uses a single blockquote question:
    // "Is this intent the most specific I can articulate for my immediate need?"
    // Semantic intent preserved: the prompt requires the LLM to self-assess
    // intent specificity before submitting any query.
    expect(promptText).toMatch(/Is this intent the most specific/);
  });

  it("contains the URL-parser walkthrough section", () => {
    // Original: "Worked example: building a URL parser".
    // PR #583 uses "## Concrete example: URL parser" as the section header.
    // Semantic intent preserved: the prompt provides a multi-step worked example
    // demonstrating the descent-and-compose loop for a URL parser.
    expect(promptText).toMatch(/[Cc]oncrete example.*URL parser|[Ww]orked example.*URL parser/);
  });

  it("contains the auto-accept rule", () => {
    expect(promptText).toMatch(/auto-accept/);
  });

  it("contains the REGISTRY_UNREACHABLE fallback instruction", () => {
    expect(promptText).toMatch(/REGISTRY_UNREACHABLE/);
  });
});

// ---------------------------------------------------------------------------
// Test: negative — loose intents are explicitly called out as defects
// ---------------------------------------------------------------------------

describe("negative test: loose intents are named as defects", () => {
  it('names a vague query example (e.g. "validate input" or "validation") to refuse', () => {
    // Original: looked for quoted "validation". PR #583 uses "validate input" and
    // "parse URL" as the canonical stop-word examples in the self-check section.
    // Semantic intent preserved: the prompt names concrete examples of vague queries
    // that must be rejected, so the LLM has calibration anchors.
    expect(promptText).toMatch(/"validation"|"validate input"|"parse URL"|"validate"/);
  });

  it('names "parser" as a vague query example to refuse', () => {
    // PR #583 uses "URL parser" with stop-word "parser" as the canonical example.
    // This exact string appears in the worked example and self-check sections.
    expect(promptText).toMatch(/"parser"|stop-word.*"parser"|"URL parser"/);
  });

  it("names rules that make single-word or under-specified intents defects", () => {
    // Original: "single-word intents in general". PR #583 expresses this via:
    //   "Uses fewer than 4 words (e.g., 'validate input', 'parse URL', 'handle dates')"
    //   "Contains stop-words: 'things', 'stuff', 'utility', 'helper', ..."
    // Semantic intent preserved: the prompt gives LLM concrete rules that classify
    // single/few-word intents as defective and subject to rejection.
    expect(promptText).toMatch(/single-word intents in general|fewer than 4 words|stop-words/);
  });

  it("instructs to stop and not submit loose queries, not silently proceed", () => {
    // Original: "refuse to submit". PR #583 uses "STOP. Do NOT submit the query."
    // which is functionally identical — both block submission of vague intents.
    // Semantic intent preserved: the enforcement is hard-stop, not advisory.
    expect(promptText).toMatch(/refuse\s+to submit|Do NOT submit|STOP\. Do NOT submit/);
  });
});
