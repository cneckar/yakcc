// SPDX-License-Identifier: MIT
//
// bench/B5-coherence/llm-judge.mjs
// B5 coherence benchmark — Tier-2 LLM-as-judge integration
//
// @decision DEC-BENCH-B5-SLICE2-001
// @title B5 Slice 2: LLM-as-judge for ambiguous Tier-1 cases
// @status accepted
// @rationale
//   The Tier-1 programmatic classifier (rubric-eval.mjs) reliably catches score-1
//   (re-emission) and score-3 (opaque-hash) failures because they are structural
//   properties detectable by pattern matching. It is unreliable for:
//     - Score 2 (hallucinated): requires reasoning about whether a prose claim
//       contradicts the atom's semantic contract. Pattern matching cannot assess this.
//     - Score 4 (minor-slip): requires understanding parameter ordering context
//       across turns. Heuristic detection produces false positives.
//   
//   This module implements Tier-2: pass score-2 and score-4 candidates to a Claude
//   Opus 4.7 judge with a frozen prompt template (judge-prompt.md). The judge
//   re-scores with access to the full multi-turn transcript and atom context.
//
//   Blind discipline:
//     Arm letters (A/B) are randomly assigned per run in rubric-eval.mjs. This module
//     receives only the arm letter, never the condition (hook-enabled/hook-disabled).
//     The judge prompt uses "arm_A" / "arm_B" labels — never condition labels. This
//     prevents the judge from being influenced by knowledge of which arm uses the hook.
//
//   API key gate:
//     ANTHROPIC_API_KEY must be set. If absent, returns { status: "skipped_no_api_key" }.
//     This allows the slice2 offline baseline to run without any API access, with all
//     judge scores replaced by the Tier-1 programmatic score.
//
//   Model and parameters:
//     - Model: claude-opus-4-7 (authoritative reasoning for ambiguous cases)
//     - Temperature: 0 (deterministic; judge output must be reproducible)
//     - Retry policy: exponential backoff, 2 retries (1s → 2s delays)
//
//   Constraints honored:
//     - @anthropic-ai/sdk is NOT in root package.json; it is a bench-local dep in
//       bench/B5-coherence/package.json. This module uses dynamic import() so the
//       SDK is only loaded when an API key is present.
//     - No fabricated API responses. If the API call fails after retries, the Tier-1
//       score is used (judge_status: "tier1_fallback").
//
//   Cross-reference:
//     judge-prompt.md (frozen judge prompt template)
//     rubric-eval.mjs (Tier-1 classifier; dispatches to this module)
//     RUBRIC.md (scoring spec)
//     DEC-BENCH-B5-SLICE2-001 (this decision)
//     #189 (B5 parent issue)

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Frozen judge prompt — loaded once at module init
// ---------------------------------------------------------------------------

let _judgePrompt = null;

function loadJudgePrompt() {
  if (_judgePrompt !== null) return _judgePrompt;
  const promptPath = join(__dirname, "judge-prompt.md");
  _judgePrompt = readFileSync(promptPath, "utf8");
  return _judgePrompt;
}

// ---------------------------------------------------------------------------
// Delay helper for exponential backoff
// ---------------------------------------------------------------------------

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Anthropic SDK loader — dynamic import, gated on API key presence
// ---------------------------------------------------------------------------

let _anthropicSdk = null;

async function loadAnthropicSdk() {
  if (_anthropicSdk !== null) return _anthropicSdk;
  // Dynamic import so the SDK is not required when ANTHROPIC_API_KEY is absent.
  // The SDK lives in bench/B5-coherence/package.json, not root deps.
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  _anthropicSdk = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
  });
  return _anthropicSdk;
}

// ---------------------------------------------------------------------------
// Judge invocation with exponential backoff
// ---------------------------------------------------------------------------

/**
 * Call the Claude Opus 4.7 judge with a rendered prompt.
 * Retries on transient errors: 1s delay on first retry, 2s on second.
 *
 * @param {string} userPrompt - Fully rendered judge prompt for this transcript
 * @returns {Promise<string>} The judge's raw text response
 * @throws After exhausting retries
 */
async function callJudge(userPrompt) {
  const client = await loadAnthropicSdk();
  const delays = [1000, 2000];

  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      const response = await client.messages.create({
        model: "claude-opus-4-7",
        max_tokens: 1024,
        temperature: 0,
        messages: [
          {
            role: "user",
            content: userPrompt,
          },
        ],
      });

      const block = response.content.find(b => b.type === "text");
      if (!block) throw new Error("No text block in judge response");
      return block.text;
    } catch (err) {
      if (attempt < delays.length) {
        const waitMs = delays[attempt];
        process.stderr.write(
          `JUDGE retry ${attempt + 1}/${delays.length}: ${err.message} (waiting ${waitMs}ms)\n`
        );
        await delay(waitMs);
      } else {
        throw err;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Prompt rendering
// ---------------------------------------------------------------------------

/**
 * Render the frozen judge prompt template with conversation-specific context.
 *
 * Placeholders substituted:
 *   {{ARM_LABEL}}          — "arm_A" or "arm_B" (never condition names)
 *   {{CATEGORY}}           — conversation category
 *   {{ATOM_NAMES}}         — comma-joined list of expected atoms
 *   {{TRANSCRIPT}}         — formatted multi-turn transcript
 *   {{TIER1_SCORE}}        — Tier-1 programmatic score (for judge context)
 *   {{TIER1_FAILURE_MODE}} — Tier-1 failure mode or "none"
 *   {{TIER1_DETAILS}}      — Tier-1 classifier details string
 *
 * @param {object} params
 * @param {string} params.armLabel - "arm_A" or "arm_B"
 * @param {string} params.category - conversation category
 * @param {string[]} params.atomNames - expected atoms
 * @param {object[]} params.transcript - array of {role, content, turnIndex} objects
 * @param {number} params.tier1Score - Tier-1 score for the ambiguous turn
 * @param {string|null} params.tier1FailureMode - Tier-1 failure mode
 * @param {string} params.tier1Details - Tier-1 details string
 * @param {number} params.turnIndex - which turn is being judged
 * @returns {string} Rendered prompt ready for the judge
 */
function renderJudgePrompt(params) {
  const template = loadJudgePrompt();

  // Format the transcript up to and including the turn under review
  const relevantTurns = params.transcript.filter(
    t => t.turnIndex <= params.turnIndex
  );
  const formattedTranscript = relevantTurns
    .map(t => `[Turn ${t.turnIndex}] ${t.role.toUpperCase()}:\n${t.content}`)
    .join("\n\n---\n\n");

  return template
    .replace(/\{\{ARM_LABEL\}\}/g, params.armLabel)
    .replace(/\{\{CATEGORY\}\}/g, params.category)
    .replace(/\{\{ATOM_NAMES\}\}/g, params.atomNames.join(", "))
    .replace(/\{\{TRANSCRIPT\}\}/g, formattedTranscript)
    .replace(/\{\{TIER1_SCORE\}\}/g, String(params.tier1Score))
    .replace(/\{\{TIER1_FAILURE_MODE\}\}/g, params.tier1FailureMode ?? "none")
    .replace(/\{\{TIER1_DETAILS\}\}/g, params.tier1Details)
    .replace(/\{\{TURN_INDEX\}\}/g, String(params.turnIndex));
}

// ---------------------------------------------------------------------------
// Judge response parser
// ---------------------------------------------------------------------------

/**
 * Parse the judge's text response into a structured score record.
 * The judge is instructed to emit a JSON block; we extract it.
 *
 * Expected judge output (anywhere in the response):
 *   ```json
 *   {
 *     "score": 4,
 *     "failureMode": null,
 *     "confidence": "high",
 *     "rationale": "..."
 *   }
 *   ```
 *
 * Falls back to tier1Score if parsing fails.
 *
 * @param {string} judgeText - Raw text from the judge
 * @param {number} tier1Score - Fallback score
 * @param {string|null} tier1FailureMode - Fallback failure mode
 * @returns {{ score: number, failureMode: string|null, confidence: string, rationale: string, parsed: boolean }}
 */
function parseJudgeResponse(judgeText, tier1Score, tier1FailureMode) {
  // Try to extract a JSON block
  const jsonMatch = judgeText.match(/```json\s*([\s\S]*?)```/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[1]);
      if (typeof parsed.score === "number" && parsed.score >= 0 && parsed.score <= 5) {
        return {
          score: parsed.score,
          failureMode: parsed.failureMode ?? null,
          confidence: parsed.confidence ?? "unknown",
          rationale: parsed.rationale ?? "",
          parsed: true,
        };
      }
    } catch (_) {
      // Fall through to tier1 fallback
    }
  }

  // Try inline JSON (no code fence)
  const inlineMatch = judgeText.match(/\{[\s\S]*"score"\s*:\s*(\d+)[\s\S]*\}/);
  if (inlineMatch) {
    try {
      const parsed = JSON.parse(inlineMatch[0]);
      if (typeof parsed.score === "number" && parsed.score >= 0 && parsed.score <= 5) {
        return {
          score: parsed.score,
          failureMode: parsed.failureMode ?? null,
          confidence: parsed.confidence ?? "unknown",
          rationale: parsed.rationale ?? "",
          parsed: true,
        };
      }
    } catch (_) {
      // Fall through
    }
  }

  // Fallback: use tier1 score, flag as unparseable
  return {
    score: tier1Score,
    failureMode: tier1FailureMode,
    confidence: "unparseable",
    rationale: `Failed to parse judge response: ${judgeText.slice(0, 200)}`,
    parsed: false,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Score a single transcript turn using the LLM judge.
 *
 * This is the main export. Called by rubric-eval.mjs for Tier-2 scoring when
 * the Tier-1 classifier returns score 2 (hallucinated) or score 4 (minor-slip).
 *
 * Gate behavior:
 *   - If ANTHROPIC_API_KEY is not set: returns { status: "skipped_no_api_key" }
 *   - If the API call fails after retries: returns { status: "tier1_fallback", ... }
 *   - On success: returns { status: "judged", score, failureMode, confidence, rationale }
 *
 * @param {object} params
 * @param {string} params.armLabel - "arm_A" or "arm_B"
 * @param {string} params.category - conversation category
 * @param {string[]} params.atomNames - expected atoms for this conversation
 * @param {object[]} params.transcript - full transcript array up to scored turn
 * @param {number} params.tier1Score - Tier-1 score (2 or 4, the ambiguous cases)
 * @param {string|null} params.tier1FailureMode - Tier-1 failure mode
 * @param {string} params.tier1Details - Tier-1 details string
 * @param {number} params.turnIndex - turn index under review
 * @returns {Promise<object>} Judge result record
 */
export async function scoreTranscriptWithLLMJudge(params) {
  // API key gate — no key means no judge
  if (!process.env.ANTHROPIC_API_KEY) {
    return { status: "skipped_no_api_key" };
  }

  try {
    const userPrompt = renderJudgePrompt(params);
    const judgeText = await callJudge(userPrompt);
    const result = parseJudgeResponse(judgeText, params.tier1Score, params.tier1FailureMode);

    return {
      status: result.parsed ? "judged" : "tier1_fallback",
      score: result.score,
      failureMode: result.failureMode,
      confidence: result.confidence,
      rationale: result.rationale,
      tier1Score: params.tier1Score,
      tier1FailureMode: params.tier1FailureMode,
      rawJudgeText: judgeText,
    };
  } catch (err) {
    process.stderr.write(`JUDGE ERROR turn ${params.turnIndex} ${params.armLabel}: ${err.message}\n`);
    return {
      status: "tier1_fallback",
      score: params.tier1Score,
      failureMode: params.tier1FailureMode,
      confidence: "api_error",
      rationale: `Judge API error after retries: ${err.message}`,
      tier1Score: params.tier1Score,
      tier1FailureMode: params.tier1FailureMode,
    };
  }
}
