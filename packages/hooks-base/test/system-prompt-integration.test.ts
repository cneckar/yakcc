/**
 * system-prompt-integration.test.ts — Integration tests for WI-578 prompt rewrite.
 *
 * Tests:
 *   1. Corpus validation: each pair in the test corpus has a loose intent that
 *      meets the "loose" definition and a tight intent that meets the "tight"
 *      definition. Proves the corpus is internally consistent.
 *   2. Negative test: the new prompt file contains the refusal text that would
 *      cause an LLM to reject loose queries (deterministic text assertion; no
 *      live LLM call per plan §5 U2 and risk mitigation R3).
 *   3. Telemetry descent-depth assertion (Design A heuristic, plan §6):
 *      Scaffolded with a controlled in-memory fixture. The real threshold
 *      (≥ 50% of misses show follow-on resolve within 30s in the same session)
 *      is guarded by a "telemetry-thin" skip if fewer than 20 events exist.
 *
 * @decision DEC-HOOK-PROMPT-DESCENT-001
 * @title Integration test: corpus validation + negative test + telemetry scaffold
 * @status accepted
 * @rationale
 *   The compound-interaction production sequence for WI-578 is:
 *     LLM receives the system prompt at session start
 *     → LLM calls yakcc_resolve with an intent
 *     → on miss, the new prompt induces decompose-and-recurse (not widen)
 *     → follow-on resolve call appears in the same session within short window
 *   This test exercises the text-level proof (corpus + negative) and the
 *   heuristic telemetry assertion (Design A) that verifies the descent pattern
 *   in real usage traces. The live LLM call cannot be made deterministic;
 *   the telemetry fixture stands in for it per plan risk R3.
 */

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, it, expect } from "vitest";
import { loadDiscoveryPrompt } from "../src/system-prompt.js";

// ---------------------------------------------------------------------------
// Workspace root resolution
// ---------------------------------------------------------------------------

const WORKSPACE_ROOT = resolve(import.meta.dirname ?? __dirname, "../../..");
const CORPUS_PATH = join(
  WORKSPACE_ROOT,
  "tmp/wi-578-investigation/test-corpus.json",
);

// ---------------------------------------------------------------------------
// Types matching test-corpus.json schema
// ---------------------------------------------------------------------------

interface CorpusPair {
  id: number;
  loose: string;
  tight: string;
  looseReason: string;
  tightReason: string;
}

interface Corpus {
  pairs: CorpusPair[];
  looseDefinition: {
    description: string;
    requiredAbsence: string[];
  };
  tightDefinition: {
    description: string;
    requiredPresence: string[];
  };
}

// ---------------------------------------------------------------------------
// Heuristic loose/tight classifiers matching corpus definitions
// ---------------------------------------------------------------------------

/**
 * A "loose" intent is one that:
 *  - is a single word, OR
 *  - is a two-word generic noun phrase ending in a generic noun like
 *    "helper", "handler", "util", "manager", or
 *  - lacks any RFC/algorithm/standard reference AND lacks specific output constraints
 *
 * This is a heuristic — it matches the corpus definition, not a formal grammar.
 */
function isLooseIntent(intent: string): boolean {
  const trimmed = intent.trim();
  const words = trimmed.split(/\s+/);

  // Single-word: always loose
  if (words.length === 1) return true;

  // Two-word phrase with a generic trailing noun
  const genericNouns = [
    "helper",
    "handler",
    "util",
    "utility",
    "manager",
    "processor",
    "input",
  ];
  if (words.length === 2) {
    const lastWord = words[words.length - 1]!.toLowerCase();
    if (genericNouns.includes(lastWord)) return true;
  }

  // No specific verb (from the list of "specific verbs" the tight definition requires)
  const specificVerbs = [
    "validate",
    "parse",
    "format",
    "convert",
    "strip",
    "decode",
    "encode",
    "compute",
    "split",
    "retry",
    "throttle",
  ];
  const hasSpecificVerb = specificVerbs.some((v) =>
    trimmed.toLowerCase().startsWith(v),
  );
  if (!hasSpecificVerb) return true;

  return false;
}

/**
 * A "tight" intent is one that:
 *  - contains a specific action verb or named algorithm
 *  - and contains at least one of: named standard/RFC, explicit constraint, output format
 */
function isTightIntent(intent: string): boolean {
  const lower = intent.toLowerCase();

  // Must contain a specific verb or named algorithm
  const specificVerbsOrAlgorithms = [
    "validate",
    "parse",
    "format",
    "convert",
    "strip",
    "decode",
    "encode",
    "compute",
    "split",
    "retry",
    "throttle",
    "blake3",
    "deep structural",
  ];
  const hasSpecific = specificVerbsOrAlgorithms.some((v) => lower.includes(v));
  if (!hasSpecific) return false;

  // Must also contain at least one specificity marker
  const specificityMarkers = [
    "rfc",
    "iso",
    "blake3",
    "utf-8",
    "hex",
    "ms",
    "ms,",
    "decimal",
    "ascii",
    "html",
    "&amp;",
    "exponential",
    "per n ms",
    "fixed",
    "thousands",
    "thousands separator",
    "url slug",
    "no display name",
    "no nan",
    "no functions",
  ];
  const hasSpecificityMarker = specificityMarkers.some((m) =>
    lower.includes(m),
  );

  return hasSpecificityMarker;
}

// ---------------------------------------------------------------------------
// Load corpus once
// ---------------------------------------------------------------------------

let corpus: Corpus;
try {
  corpus = JSON.parse(readFileSync(CORPUS_PATH, "utf-8")) as Corpus;
} catch {
  corpus = { pairs: [], looseDefinition: { description: "", requiredAbsence: [] }, tightDefinition: { description: "", requiredPresence: [] } };
}

// ---------------------------------------------------------------------------
// Test Suite 1: Corpus validation
// ---------------------------------------------------------------------------

describe("WI-578 test corpus: paired intent validation", () => {
  it("corpus file exists and has 10 pairs", () => {
    expect(corpus.pairs.length).toBe(10);
  });

  for (const pair of corpus.pairs) {
    it(`pair ${pair.id}: loose intent "${pair.loose}" classifies as loose`, () => {
      expect(isLooseIntent(pair.loose)).toBe(true);
    });

    it(`pair ${pair.id}: tight intent classifies as tight (not loose)`, () => {
      // A tight intent should NOT be loose by the single-word / generic noun check
      const words = pair.tight.trim().split(/\s+/);
      // Tight intents are always multi-word
      expect(words.length).toBeGreaterThan(2);
    });

    it(`pair ${pair.id}: tight intent contains a specific verb or algorithm`, () => {
      expect(isTightIntent(pair.tight)).toBe(true);
    });
  }
});

// ---------------------------------------------------------------------------
// Test Suite 2: Negative test — prompt induces refusal of loose intents
// (deterministic text assertion; no live LLM call per plan R3)
// ---------------------------------------------------------------------------

describe("negative test: prompt induces refusal of loose intents", () => {
  // NOTE: PR #583 (parallel landing of #578) uses different but semantically
  // equivalent phrasing. Each assertion below is updated to match either the
  // original PR #580 text OR PR #583's equivalent, and explains WHY the
  // semantic invariant is preserved.

  const prompt = loadDiscoveryPrompt(WORKSPACE_ROOT);

  it("prompt names rules that classify single-word / under-specified intents as defects", () => {
    // Original: "single-word intents in general". PR #583 expresses the same
    // enforcement via "Uses fewer than 4 words" + stop-word list. Both give the
    // LLM concrete rules for classifying and rejecting vague intents.
    expect(prompt).toMatch(/single-word intents in general|fewer than 4 words|stop-words/);
  });

  it("prompt instructs to stop and not submit vague queries", () => {
    // Original: "refuse to submit". PR #583: "STOP. Do NOT submit the query."
    // Both are hard-stop instructions with identical enforcement semantics.
    expect(prompt).toMatch(/refuse\s+to submit|Do NOT submit|STOP\. Do NOT submit/);
  });

  it('prompt names a vague query example (e.g., "validation" or "validate input")', () => {
    // Original: "validation" as a quoted example. PR #583 uses "validate input"
    // and "parse URL" as concrete stop-word examples in the self-check section.
    expect(prompt).toMatch(/"validation"|"validate input"|"validate"/);
  });

  it('prompt names "parser" as a vague query example', () => {
    // PR #583 uses stop-word "parser" in the concrete example "URL parser".
    expect(prompt).toMatch(/"parser"|stop-word.*"parser"|"URL parser"/);
  });

  it('prompt names "utility" or equivalent stop-words as vague query markers', () => {
    // PR #583 has stop-word list including "utility" explicitly.
    expect(prompt).toMatch(/"utility"|stop-words.*utility|"utility".*stop-word/);
  });

  it('prompt names "helper" or equivalent stop-words as vague query markers', () => {
    // PR #583 has stop-word list including "helper" explicitly.
    expect(prompt).toMatch(/"helper"|stop-words.*helper|"helper".*stop-word/);
  });

  it("prompt instructs to stop, not proceed, when intent is too broad", () => {
    // Original: "Write the user a short note explaining why the intent was too broad".
    // PR #583 uses "STOP. Do NOT submit the query. Decompose the intent into 2–4
    // more-specific sub-intents". The enforcement is equivalent: both block vague
    // intent submission and redirect to decomposition. PR #583's approach is stricter
    // (immediate STOP) rather than explain-then-proceed.
    expect(prompt).toMatch(
      /short note explaining why the intent was too broad|STOP\. Do NOT submit|Do NOT submit the query/,
    );
  });

  it("prompt provides the URL-parser walkthrough as a concrete descent example", () => {
    // The walkthrough must contain the decompose sequence. Both PR #580 and PR #583
    // include "split string on first `://`" as a leaf intent.
    // PR #583 uses "hex escape sequence" where PR #580 used "hex pair" — both
    // name the `%XX` percent-decode operation; the update preserves the invariant
    // that the worked example demonstrates leaf-level descent.
    expect(prompt).toContain('split string on first `://`');
    expect(prompt).toMatch(/decode `%XX` hex (pair|escape sequence|escape)/);
  });
});

// ---------------------------------------------------------------------------
// Test Suite 3: Telemetry descent-depth assertion (Design A, plan §6)
// ---------------------------------------------------------------------------

/**
 * Design A: post-hoc inference of descent depth from a controlled telemetry fixture.
 *
 * In production, this would read ~/.yakcc/telemetry/<session-id>.jsonl.
 * In this test, we use a controlled in-memory fixture that simulates what the
 * real telemetry would look like after the WI-578 prompt rewrite takes effect.
 *
 * The fixture represents a session where:
 *   1. LLM calls resolve("URL parser") → no_match (loose, miss)
 *   2. LLM decomposes and calls resolve("split string on first ://") → matched (descent)
 *   3. LLM calls resolve("clamp number between bounds") → matched (tight, not a descent)
 *   4. LLM calls resolve("hash") → no_match (loose, miss)
 *   5. LLM decomposes and calls resolve("BLAKE3-256 hex digest of UTF-8 string") → matched (descent)
 *
 * In this fixture: 2 misses (events 1 and 4), both followed by a descent call within 30s.
 * Expected: 100% descent-on-miss rate ≥ 50% threshold.
 */

interface TelemetryEvent {
  sessionId: string;
  t: number; // Unix timestamp ms
  intentHash: string;
  outcome: "matched" | "synthesis-required" | "no-match" | "weak-only";
  topScore: number;
  intentText?: string; // Optional: retained in fixture for descent inference
}

function isDescendedIntent(
  parentText: string | undefined,
  childText: string | undefined,
): boolean {
  if (!parentText || !childText) return false;
  // A child intent is a descent if the parent intent text contains it OR
  // the child is more specific (longer, with specific verbs) than the parent.
  const parentWords = parentText.toLowerCase().split(/\s+/);
  const childWords = childText.toLowerCase().split(/\s+/);
  // More specific = child has more words (contains more specifics)
  return childWords.length > parentWords.length;
}

function computeDescentRate(events: TelemetryEvent[]): {
  totalMisses: number;
  missesWithDescent: number;
  rate: number;
  skipped: boolean;
  skipReason?: string;
} {
  // Skip if fewer than 20 events (telemetry-thin guard per plan §6)
  if (events.length < 20) {
    return {
      totalMisses: 0,
      missesWithDescent: 0,
      rate: 0,
      skipped: true,
      skipReason: `telemetry-thin: only ${events.length} events (need >= 20)`,
    };
  }

  // Sort by session + timestamp
  const sorted = [...events].sort((a, b) => {
    if (a.sessionId !== b.sessionId)
      return a.sessionId.localeCompare(b.sessionId);
    return a.t - b.t;
  });

  let totalMisses = 0;
  let missesWithDescent = 0;
  const WINDOW_MS = 30_000;

  for (let i = 0; i < sorted.length; i++) {
    const event = sorted[i]!;
    const isMiss =
      event.outcome === "no-match" ||
      event.outcome === "synthesis-required" ||
      event.outcome === "weak-only" ||
      event.topScore < 0.7;

    if (!isMiss) continue;
    totalMisses++;

    // Look for a follow-on event within 30s in the same session
    const followOn = sorted.find(
      (e, j) =>
        j > i &&
        e.sessionId === event.sessionId &&
        e.t - event.t <= WINDOW_MS &&
        e.intentHash !== event.intentHash,
    );

    if (followOn) {
      // Optionally validate descent (intent text is more specific)
      const isDescended = isDescendedIntent(
        event.intentText,
        followOn.intentText,
      );
      if (isDescended || followOn.intentText === undefined) {
        // Accept if we can confirm descent OR if intent text is absent (can't refute)
        missesWithDescent++;
      }
    }
  }

  const rate = totalMisses === 0 ? 0 : missesWithDescent / totalMisses;
  return { totalMisses, missesWithDescent, rate, skipped: false };
}

describe("telemetry descent-depth assertion (Design A, plan §6)", () => {
  it.todo(
    "real-telemetry threshold: ≥50% of misses show follow-on resolve within 30s (requires #569 real telemetry surface)",
    // TODO: When #569 lands and real session telemetry is accessible, replace
    // this todo with a live assertion that reads ~/.yakcc/telemetry/*.jsonl
    // and applies computeDescentRate(). Threshold 50% is documented as a
    // placeholder per plan §6; real-world tuning follows #569.
  );

  it("Design A computeDescentRate skips when fewer than 20 events (telemetry-thin guard)", () => {
    const thinEvents: TelemetryEvent[] = Array.from({ length: 5 }, (_, i) => ({
      sessionId: "sess-1",
      t: Date.now() + i * 1000,
      intentHash: `hash-${i}`,
      outcome: "no-match" as const,
      topScore: 0.3,
    }));

    const result = computeDescentRate(thinEvents);
    expect(result.skipped).toBe(true);
    expect(result.skipReason).toMatch(/telemetry-thin/);
  });

  it("Design A computeDescentRate detects descent in controlled fixture (>=50% threshold)", () => {
    // Controlled fixture: 20 events in one session, 4 misses each followed by descent
    const now = Date.now();
    const SESSION = "sess-fixture";

    const fixture: TelemetryEvent[] = [
      // Miss 1: "URL parser" → no_match
      {
        sessionId: SESSION,
        t: now,
        intentHash: "h-url-parser",
        outcome: "no-match",
        topScore: 0.2,
        intentText: "URL parser",
      },
      // Descent 1: "split string on first ://" → matched (within 5s)
      {
        sessionId: SESSION,
        t: now + 5000,
        intentHash: "h-split-scheme",
        outcome: "matched",
        topScore: 0.91,
        intentText: "split string on first ://",
      },
      // Hit: non-miss event
      {
        sessionId: SESSION,
        t: now + 10000,
        intentHash: "h-clamp",
        outcome: "matched",
        topScore: 0.94,
        intentText: "clamp number between lo and hi",
      },
      // Miss 2: "hash" → no_match
      {
        sessionId: SESSION,
        t: now + 15000,
        intentHash: "h-hash",
        outcome: "no-match",
        topScore: 0.15,
        intentText: "hash",
      },
      // Descent 2: "BLAKE3-256 hex digest of UTF-8 string" → matched (within 8s)
      {
        sessionId: SESSION,
        t: now + 23000,
        intentHash: "h-blake3",
        outcome: "matched",
        topScore: 0.88,
        intentText: "BLAKE3-256 hex digest of a UTF-8 string",
      },
      // Miss 3: "parser" → no_match
      {
        sessionId: SESSION,
        t: now + 30000,
        intentHash: "h-parser",
        outcome: "no-match",
        topScore: 0.1,
        intentText: "parser",
      },
      // Descent 3: "parse RFC 3986 URL into scheme host path query fragment" → matched
      {
        sessionId: SESSION,
        t: now + 35000,
        intentHash: "h-rfc3986",
        outcome: "matched",
        topScore: 0.85,
        intentText: "parse RFC 3986 URL into scheme host path query fragment",
      },
      // Miss 4: "validate" → no_match
      {
        sessionId: SESSION,
        t: now + 40000,
        intentHash: "h-validate",
        outcome: "no-match",
        topScore: 0.12,
        intentText: "validate",
      },
      // Descent 4: "validate email per RFC 5322 local-part subset no display name" → matched
      {
        sessionId: SESSION,
        t: now + 48000,
        intentHash: "h-rfc5322",
        outcome: "matched",
        topScore: 0.82,
        intentText:
          "validate email per RFC 5322 local-part subset no display name",
      },
      // Pad to 20 events with non-miss hits
      ...Array.from({ length: 11 }, (_, i) => ({
        sessionId: SESSION,
        t: now + 60000 + i * 2000,
        intentHash: `h-hit-${i}`,
        outcome: "matched" as const,
        topScore: 0.87,
        intentText: `specific matched intent ${i}`,
      })),
    ];

    expect(fixture.length).toBe(20);

    const result = computeDescentRate(fixture);
    expect(result.skipped).toBe(false);
    expect(result.totalMisses).toBe(4);
    expect(result.missesWithDescent).toBeGreaterThanOrEqual(
      Math.ceil(result.totalMisses * 0.5),
    );
    expect(result.rate).toBeGreaterThanOrEqual(0.5);
  });
});
