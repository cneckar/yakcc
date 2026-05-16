// SPDX-License-Identifier: MIT
//
// @decision DEC-HOOK-ENF-LAYER1-INTENT-SPECIFICITY-001
// title: Layer 1 intent-specificity gate — pure heuristic scorer and binary enforcer
// status: decided (wi-579-hook-enforcement S1)
// rationale:
//   Layer 1 is the earliest defensive position: it runs before any registry query.
//   A binary accept/reject prevents oversized result sets, polluted registry hits,
//   and short-circuited descent loops from ever reaching Layers 2–5.
//
//   The decision algorithm is deterministic and pure (no I/O, no async).
//   The score (0..1) is telemetry-only — Layer 5 (drift detection, S5) aggregates
//   it in a rolling window. The accept/reject verdict is binary.
//
//   Escape hatch: YAKCC_HOOK_DISABLE_INTENT_GATE=1 bypasses this layer entirely.
//   Default behavior is ENFORCE. The env var is for breakglass and test isolation only.
//   @decision DEC-HOOK-ENF-LAYER1-ESCAPE-HATCH-001
//
//   Cross-reference: plans/wi-579-hook-enforcement-architecture.md §5.2

import type { IntentSpecificityResult } from "./enforcement-types.js";

export type { IntentSpecificityResult } from "./enforcement-types.js";
export type { IntentAcceptEnvelope, IntentRejectEnvelope, IntentRejectReason } from "./enforcement-types.js";

// ---------------------------------------------------------------------------
// Threshold constants — sole authority per plan §10 invariants
// ---------------------------------------------------------------------------

/**
 * Minimum number of whitespace-tokenized words an intent must have.
 * Intents shorter than this are categorically underspecified.
 *
 * @decision DEC-HOOK-ENF-LAYER1-MIN-WORDS-001
 * Value 4 matches the lower bound in the #579 issue body.
 */
export const MIN_WORDS = 4;

/**
 * Maximum number of whitespace-tokenized words an intent may have.
 * Intents longer than this are likely copy-paste artifacts or doc blobs.
 *
 * @decision DEC-HOOK-ENF-LAYER1-MAX-WORDS-001
 * Value 20 matches the upper bound in the #579 issue body.
 */
export const MAX_WORDS = 20;

// ---------------------------------------------------------------------------
// Stop-word list
// ---------------------------------------------------------------------------

/**
 * Stop-words that signal a generic, non-specific intent.
 * Any intent whose token list contains one of these strings (exact token match,
 * lowercased) is rejected with reason "stop_word_present".
 *
 * @decision DEC-HOOK-ENF-LAYER1-STOP-WORDS-001
 * The base 8 from #579 body + `processor` and `worker` for additional breadth.
 * Do NOT add entries here without a companion corpus row in enforcement-eval-corpus.json.
 */
export const STOP_WORDS: ReadonlySet<string> = new Set([
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
]);

// ---------------------------------------------------------------------------
// Meta-word list
// ---------------------------------------------------------------------------

/**
 * Meta-words that signal vague, catch-all intent framing.
 * Any intent whose token list contains one of these strings (exact token match,
 * lowercased) is rejected with reason "meta_word_present".
 *
 * @decision DEC-HOOK-ENF-LAYER1-META-WORDS-001
 * The base 4 from #579 body + `any`, `several`, `misc`, `generic` for breadth.
 */
export const META_WORDS: ReadonlySet<string> = new Set([
  "various",
  "general",
  "common",
  "some",
  "any",
  "several",
  "misc",
  "generic",
]);

// ---------------------------------------------------------------------------
// Action-verb allowlist
// ---------------------------------------------------------------------------

/**
 * Curated set of action verbs. An intent must contain at least one token
 * that exactly matches (lowercased) an entry here to pass the action-verb check.
 *
 * @decision DEC-HOOK-ENF-LAYER1-ACTION-VERBS-001
 * Positive signal complements the negative stop/meta-word heuristics.
 * Verbs are all lowercase; comparison is done after lowercasing the token.
 * The list covers the most common atom operations in the yakcc registry corpus.
 * "isemail", "isuuid", etc. are not in this list because they are nouns used
 * as function names — they pass through the word-count and stop/meta checks
 * without needing an action verb (the intent "isEmail RFC 5321 subset" has
 * the implicit verb "validate" encoded in the "is-" prefix — it passes because
 * it has ≥4 words and no stop/meta words, not because of this check).
 *
 * If an intent consistently fails the action-verb check incorrectly, add the
 * verb here and add a companion corpus row.
 */
export const ACTION_VERBS: ReadonlySet<string> = new Set([
  "parse",
  "validate",
  "encode",
  "decode",
  "hash",
  "compare",
  "split",
  "join",
  "filter",
  "map",
  "reduce",
  "sort",
  "find",
  "match",
  "extract",
  "convert",
  "serialize",
  "deserialize",
  "normalize",
  "sanitize",
  "format",
  "render",
  "build",
  "emit",
  "read",
  "write",
  "append",
  "prepend",
  "trim",
  "pad",
  "slice",
  "chunk",
  "flatten",
  "merge",
  "diff",
  "patch",
  "compress",
  "decompress",
  "encrypt",
  "decrypt",
  "sign",
  "verify",
  "generate",
  "create",
  "delete",
  "update",
  "insert",
  "select",
  "query",
  "scan",
  "index",
  "tokenize",
  "lex",
  "compile",
  "transpile",
  "transform",
  "project",
  "fold",
  "unfold",
  "group",
  "partition",
  "zip",
  "unzip",
  "pack",
  "unpack",
  "escape",
  "unescape",
  "quote",
  "unquote",
  "wrap",
  "unwrap",
  "resolve",
  "reject",
  "retry",
  "throttle",
  "debounce",
  "batch",
  "stream",
  "pipe",
  "fork",
  "join",
  "collect",
  "drain",
  "flush",
  "reset",
  "clamp",
  "lerp",
  "round",
  "truncate",
  "abs",
  "sum",
  "count",
  "measure",
]);

// ---------------------------------------------------------------------------
// I/O hint detection helpers (advisory — raises score only)
// ---------------------------------------------------------------------------

/**
 * Patterns that signal I/O specificity in an intent string.
 * These are advisory: they raise the specificity score but do NOT gate accept/reject.
 *
 * @decision DEC-HOOK-ENF-LAYER1-IO-HINT-001
 * Patterns: colon followed by a type token, "from " substring, "to " substring,
 * or a parenthesized signature "(...)".
 */
const IO_HINT_PATTERNS: readonly RegExp[] = [
  /:\s*(string|number|boolean|object|array|Uint8Array|Buffer|Date|bigint|symbol|null|undefined|void|never)\b/i,
  /\bfrom\s+/i,
  /\bto\s+/i,
  /\(.*\)/,
];

function hasIoHint(intent: string): boolean {
  return IO_HINT_PATTERNS.some((pattern) => pattern.test(intent));
}

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

/**
 * Tokenize an intent string into lowercase words by splitting on whitespace.
 * Punctuation attached to words is stripped before matching (e.g. "string," → "string").
 */
function tokenize(intent: string): readonly string[] {
  return intent
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 0)
    .map((t) => t.toLowerCase().replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, ""));
}

// ---------------------------------------------------------------------------
// Scoring formula
// ---------------------------------------------------------------------------

/**
 * Compute the advisory specificity score for an accepted intent (0..1).
 *
 * Score = clamp01(
 *   0.5
 *   + 0.1  if has_io_hint
 *   + 0.1  if wordCount ∈ [6, 14]
 *   + min(0.3, 0.05 * count_of_specific_tokens)
 * )
 *
 * where specific_tokens = tokens that are in ACTION_VERBS or have length > 6.
 * This rewards richer, more descriptive intents without blocking on word length.
 *
 * The score is telemetry-only; Layer 5 aggregates it in a rolling window.
 */
function computeScore(intent: string, tokens: readonly string[]): number {
  const wordCount = tokens.length;
  const ioBonus = hasIoHint(intent) ? 0.1 : 0;
  const lengthBonus = wordCount >= 6 && wordCount <= 14 ? 0.1 : 0;

  const specificTokenCount = tokens.filter(
    (t) => ACTION_VERBS.has(t) || t.length > 6,
  ).length;
  const specificityBonus = Math.min(0.3, 0.05 * specificTokenCount);

  const raw = 0.5 + ioBonus + lengthBonus + specificityBonus;
  return Math.max(0, Math.min(1, raw));
}

// ---------------------------------------------------------------------------
// Reject envelope builder
// ---------------------------------------------------------------------------

const SUGGESTION_TEXT =
  "INTENT_TOO_BROAD: intent failed specificity gate.\n" +
  "Refusing to query the registry. Per docs/system-prompts/yakcc-discovery.md,\n" +
  "decompose this into specific sub-intents and resubmit each.\n" +
  'Example: "validation" → "isEmail (RFC 5321 subset)", "isUUID v4",\n' +
  '"validateCreditCard (Luhn)".';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Score and gate an intent string through Layer 1 specificity rules.
 *
 * Returns an IntentSpecificityResult discriminated union:
 *   - { layer: 1, status: "ok", score }          — intent is specific enough; proceed.
 *   - { layer: 1, status: "intent_too_broad", reasons, suggestion } — reject; do NOT query.
 *
 * This function is pure (no I/O, no async). It is safe to call synchronously
 * in the hot hook path. All threshold constants are declared in this file and
 * imported nowhere else — this file is the single authority.
 *
 * Escape hatch: YAKCC_HOOK_DISABLE_INTENT_GATE=1 bypasses this layer at the
 * call site in index.ts and import-intercept.ts; this function itself does NOT
 * check the env var (callers own the bypass check).
 *
 * @decision DEC-HOOK-ENF-LAYER1-INTENT-SPECIFICITY-001
 */
export function scoreIntentSpecificity(intent: string): IntentSpecificityResult {
  const tokens = tokenize(intent);
  const wordCount = tokens.length;
  const reasons: Array<import("./enforcement-types.js").IntentRejectReason> = [];

  // --- Single-word check (always reject, regardless of which word) ---
  // @decision DEC-HOOK-ENF-LAYER1-SINGLE-WORD-001
  if (wordCount === 1) {
    reasons.push("single_word");
    return {
      layer: 1,
      status: "intent_too_broad",
      reasons,
      suggestion: SUGGESTION_TEXT,
    };
  }

  // --- Length checks ---
  if (wordCount === 0 || wordCount < MIN_WORDS) {
    // @decision DEC-HOOK-ENF-LAYER1-MIN-WORDS-001
    reasons.push("too_short");
  }
  if (wordCount > MAX_WORDS) {
    // @decision DEC-HOOK-ENF-LAYER1-MAX-WORDS-001
    reasons.push("too_long");
  }

  // --- Stop-word check ---
  // @decision DEC-HOOK-ENF-LAYER1-STOP-WORDS-001
  for (const token of tokens) {
    if (STOP_WORDS.has(token)) {
      reasons.push("stop_word_present");
      break;
    }
  }

  // --- Meta-word check ---
  // @decision DEC-HOOK-ENF-LAYER1-META-WORDS-001
  for (const token of tokens) {
    if (META_WORDS.has(token)) {
      reasons.push("meta_word_present");
      break;
    }
  }

  // --- Action-verb check (only when length is valid and no stop/meta) ---
  // We run this even when other reasons are present to capture a complete
  // reason set for telemetry — but it can only produce a reject if nothing
  // else already did AND the word-count bracket is valid.
  // @decision DEC-HOOK-ENF-LAYER1-ACTION-VERBS-001
  const hasActionVerb = tokens.some((t) => ACTION_VERBS.has(t));

  // Boolean-predicate prefix signal: tokens starting with "is", "has", or "can"
  // encode an implicit action verb ("isEmail" ≈ "validates email").
  // Per plan §5.2: "isEmail RFC 5321 subset" accepts because the 'is-' prefix
  // encodes the validation intent — it does not require a standalone action verb.
  // This check is separate from ACTION_VERBS so the list stays pure verb forms.
  // @decision DEC-HOOK-ENF-LAYER1-PREDICATE-PREFIX-001
  // title: is/has/can prefix tokens count as implicit action verbs
  // status: decided (wi-579-hook-enforcement S1)
  // rationale:
  //   TypeScript boolean predicates (isEmail, isUUID, hasProperty, canRetry) encode
  //   the action verb as a morphological prefix. Requiring a standalone action verb
  //   for these intents would reject all "isX/hasX" registry queries, which contradicts
  //   the plan §5.2 exemplar ("isEmail RFC 5321 subset" → accept).
  //   Cross-reference: plans/wi-579-hook-enforcement-architecture.md §5.2
  const hasBooleanPrefixVerb = tokens.some(
    (t) => t.startsWith("is") && t.length > 2 ||
           t.startsWith("has") && t.length > 3 ||
           t.startsWith("can") && t.length > 3,
  );

  // If no stop/meta/length reason yet, check for missing action verb.
  if (reasons.length === 0 && !hasActionVerb && !hasBooleanPrefixVerb) {
    reasons.push("no_action_verb");
  }

  // --- Final verdict ---
  if (reasons.length > 0) {
    return {
      layer: 1,
      status: "intent_too_broad",
      reasons: reasons as readonly import("./enforcement-types.js").IntentRejectReason[],
      suggestion: SUGGESTION_TEXT,
    };
  }

  // ACCEPT — compute advisory score.
  return {
    layer: 1,
    status: "ok",
    score: computeScore(intent, tokens),
  };
}

/**
 * Convenience predicate: returns true when the intent passes the specificity gate.
 *
 * Equivalent to `scoreIntentSpecificity(intent).status === "ok"` but signals
 * intent (boolean gate) vs. the full scored result.
 */
export function isIntentSpecificEnough(intent: string): boolean {
  return scoreIntentSpecificity(intent).status === "ok";
}
