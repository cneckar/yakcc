/**
 * system-prompt.test.ts — Unit grep tests for the yakcc discovery system prompt.
 *
 * These tests verify the rewritten prompt (WI-578, DEC-HOOK-PROMPT-DESCENT-001)
 * contains the required imperative tokens and does NOT contain forbidden soft-
 * suggestion language. Tests are deterministic: they grep the actual file on disk.
 *
 * Evaluation contract §11 (plans/wi-578-hook-prompt-rewrite.md) requires:
 *   - "You MUST" appears ≥ 4 times
 *   - "You MUST NOT" appears ≥ 1 time
 *   - "NO carve-outs" appears ≥ 1 time
 *   - "self-check" / "Self-check" appears ≥ 1 time
 *   - "URL parser" appears ≥ 1 time
 *   - Forbidden phrases: 0 occurrences each
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
  it('contains "You MUST" at least 4 times', () => {
    const count = countOccurrences(promptText, /You MUST/g);
    expect(count).toBeGreaterThanOrEqual(4);
  });

  it('contains "You MUST NOT" at least 1 time', () => {
    const count = countOccurrences(promptText, /You MUST NOT/g);
    expect(count).toBeGreaterThanOrEqual(1);
  });

  it('contains "NO carve-outs" at least 1 time', () => {
    const count = countOccurrences(promptText, /NO carve-outs/g);
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

  it('contains "NEW_ATOM_PROPOSAL" at least 1 time', () => {
    const count = countOccurrences(promptText, /NEW_ATOM_PROPOSAL/g);
    expect(count).toBeGreaterThanOrEqual(1);
  });

  it('contains "refuse" at least 1 time (explicit refusal of loose intents)', () => {
    const count = countOccurrences(promptText, /refuse/gi);
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
// Test: no forbidden carve-out keywords
// ---------------------------------------------------------------------------

describe("no forbidden carve-out keywords", () => {
  it('does not contain "business logic" (case-insensitive)', () => {
    expect(promptText).not.toMatch(/business logic/i);
  });

  it('does not contain "one-off" (case-insensitive)', () => {
    expect(promptText).not.toMatch(/one-off/i);
  });

  it('does not contain "application-specific" (case-insensitive)', () => {
    expect(promptText).not.toMatch(/application-specific/i);
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

  it("contains the descent-on-miss rule header", () => {
    expect(promptText).toMatch(/Descent on miss/);
  });

  it("contains the self-check section with two numbered questions", () => {
    // The self-check section has "1." and "2." questions
    expect(promptText).toMatch(/1\. Is this intent the most specific/);
    expect(promptText).toMatch(/2\. Could a smaller piece/);
  });

  it("contains the URL-parser walkthrough section header", () => {
    expect(promptText).toMatch(/Worked example: building a URL parser/);
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
  it('names "validation" as a vague query example to refuse', () => {
    expect(promptText).toMatch(/"validation"/);
  });

  it('names "parser" as a vague query example to refuse', () => {
    expect(promptText).toMatch(/"parser"/);
  });

  it('names single-word intents as refuse triggers in general', () => {
    expect(promptText).toMatch(/single-word intents in general/);
  });

  it("instructs to refuse loose queries, not silently proceed", () => {
    // The prompt must contain 'refuse to submit' — the explicit refusal instruction
    expect(promptText).toMatch(/refuse\s+to submit/);
  });
});
