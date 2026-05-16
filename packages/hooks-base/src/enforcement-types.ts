// SPDX-License-Identifier: MIT
//
// @decision DEC-HOOK-ENF-ENVELOPES-001
// title: Single-source-of-truth envelope shapes for Layers 1–5
// status: decided (wi-579-hook-enforcement S1)
// rationale:
//   All enforcement layers (1–5) share discriminated-union envelopes defined here.
//   Layers consume each other via these types — never via duplicated string constants
//   or sibling-module reaches. Adding a new layer is an additive edit to this file
//   per Sacred Practice 12: no breaking shape change for existing consumers.
//
//   All envelopes carry a discriminant `layer` field so multiplexed telemetry
//   can route them without a second type predicate.
//
//   Cross-reference: plans/wi-579-hook-enforcement-architecture.md §5.1

// ---------------------------------------------------------------------------
// Layer 1 — intent specificity gate
// ---------------------------------------------------------------------------

/**
 * Reasons a Layer 1 intent-specificity check can produce a REJECT verdict.
 *
 * Multiple reasons may apply simultaneously (e.g. single_word implies both
 * too_short and the word itself being on the stop-word list).
 *
 * @decision DEC-HOOK-ENF-LAYER1-INTENT-SPECIFICITY-001
 */
export type IntentRejectReason =
  | "too_short" // word count < MIN_WORDS (4)
  | "too_long" // word count > MAX_WORDS (20)
  | "stop_word_present" // a token matched the STOP_WORDS set
  | "no_action_verb" // no token matched the ACTION_VERBS allowlist
  | "no_io_specifics" // advisory only — does NOT reject on its own (raises score)
  | "meta_word_present" // a token matched the META_WORDS set
  | "single_word"; // wordCount === 1 (always reject regardless of word)

/**
 * Layer 1 REJECT envelope: the intent was too broad and the registry query
 * was refused. Callers must NOT proceed to query the registry when they
 * receive this envelope.
 */
export interface IntentRejectEnvelope {
  readonly layer: 1;
  readonly status: "intent_too_broad";
  /** All reject reasons that applied (at least one when status = intent_too_broad). */
  readonly reasons: readonly IntentRejectReason[];
  /**
   * Forcing-function text surface to the LLM.
   * References docs/system-prompts/yakcc-discovery.md as the authoritative source
   * for the descent-and-compose discipline (Layer 0, PR #580).
   */
  readonly suggestion: string;
}

/**
 * Layer 1 ACCEPT envelope: the intent passed the specificity gate. The
 * registry query may proceed.
 *
 * score is telemetry-only (0..1). Layer 5 (drift detection) aggregates
 * it in a rolling window; the accept/reject decision itself is binary.
 */
export interface IntentAcceptEnvelope {
  readonly layer: 1;
  readonly status: "ok";
  /** Specificity score 0..1 — telemetry only; does not affect accept/reject. */
  readonly score: number;
}

/** Discriminated union result of scoreIntentSpecificity(). */
export type IntentSpecificityResult = IntentAcceptEnvelope | IntentRejectEnvelope;

// ---------------------------------------------------------------------------
// Layer 2 — result-set size enforcement (wi-590-s2-layer2)
// ---------------------------------------------------------------------------

/**
 * Layer 2 ACCEPT envelope: result-set size is within configured bounds.
 *
 * @decision DEC-HOOK-ENF-LAYER2-RESULT-SET-SIZE-001
 */
export interface ResultSetAcceptEnvelope {
  readonly layer: 2;
  readonly status: "ok";
  /**
   * Number of candidates in the "confident" band (combinedScore >= confidentThreshold).
   * Zero when no candidates meet the threshold.
   */
  readonly confidentCount: number;
  /**
   * Total number of candidates evaluated (all score bands).
   */
  readonly totalCount: number;
}

/**
 * Reasons a Layer 2 result-set size check can produce a REJECT verdict.
 *
 * @decision DEC-HOOK-ENF-LAYER2-RESULT-SET-SIZE-001
 */
export type ResultSetRejectReason =
  | "too_many_confident" // confidentCount > maxConfident
  | "too_many_overall";  // totalCount > maxOverall

/**
 * Layer 2 REJECT envelope: the result set was too large.
 *
 * When this envelope is returned, callers MUST NOT use the candidates as a
 * direct match — the result set is ambiguous. The intent should be decomposed
 * or narrowed before resubmitting.
 *
 * @decision DEC-HOOK-ENF-LAYER2-RESULT-SET-SIZE-001
 */
export interface ResultSetRejectEnvelope {
  readonly layer: 2;
  readonly status: "result_set_too_large";
  /** All reject reasons that applied (at least one when status = result_set_too_large). */
  readonly reasons: readonly ResultSetRejectReason[];
  /**
   * Number of candidates in the confident band at time of rejection.
   */
  readonly confidentCount: number;
  /**
   * Total number of candidates at time of rejection.
   */
  readonly totalCount: number;
  /**
   * Thresholds that were violated (for telemetry / debugging).
   */
  readonly maxConfident: number;
  readonly maxOverall: number;
  /**
   * Forcing-function suggestion surfaced to the LLM.
   */
  readonly suggestion: string;
}

/** Discriminated union result of scoreResultSetSize(). */
export type ResultSetSizeResult = ResultSetAcceptEnvelope | ResultSetRejectEnvelope;

// ---------------------------------------------------------------------------
// Layers 3–5 placeholders — additive per Sacred Practice 12
//
// S3..S5 implementers append their envelope types here. No existing shape
// changes. This comment block documents the extension point so future
// implementers know where to add.
//
// S3 will export: AtomSizeEnvelope (ok | atom_oversized)
// S4 will export: DescentTrackingEnvelope (ok | descent_bypass_warning)
// S5 will export: DriftEnvelope (ok | drift_alert)
// ---------------------------------------------------------------------------
