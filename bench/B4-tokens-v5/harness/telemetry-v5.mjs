// SPDX-License-Identifier: MIT
// bench/B4-tokens-v5/harness/telemetry-v5.mjs
//
// Raw-trace writer + offline derived-metrics derivation.
// PROTOCOL.md §3: "persist the complete per-rep transcript to JSONL BEFORE deriving anything."
//
// DEC-BENCH-B4-V5-TELEMETRY-001: raw trace first, derive offline.
// The raw trace is the source of truth. Derived metrics are computed here without
// re-spending API budget. This separation means unforeseen questions can be answered
// from the stored trace.
//
// REQ-TOKENS (PROTOCOL.md §2): sum usage across EVERY turn.
// The v4 bug: phase2-v4.mjs:328-329 logged only the final turn's usage — losing all
// intermediate tool-call turns. This module always sums across all turns.
//
// Exports:
//   TraceWriter    — writes per-turn JSONL trace lines + rep_meta
//   deriveMetrics  — compute derived metrics from an array of trace turns

import { appendFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

// Thresholds (PROTOCOL.md §3.2, DEC-BENCH-B4-V5-THRESHOLD-001)
// The executable authority (resolve.ts) applies 0.92 + gap 0.15.
// We also capture the doc's 0.85 threshold for discrepancy quantification.
const AUTO_ACCEPT_THRESHOLD = 0.92;
const AUTO_ACCEPT_GAP       = 0.15;
const DOC_THRESHOLD         = 0.85;

// ─── TraceWriter ─────────────────────────────────────────────────────────────

export class TraceWriter {
  /**
   * @param {{ dir: string, runId: string }} opts
   */
  constructor({ dir, runId }) {
    this.dir = dir;
    this.runId = runId;
    this.tracePath = join(dir, `${runId}.trace.jsonl`);
    mkdirSync(dir, { recursive: true });
  }

  /**
   * Append one turn line to the JSONL trace.
   * Schema per PROTOCOL.md §3.1.
   *
   * @param {{
   *   run_id: string,
   *   task_id: string,
   *   cell_id: string,
   *   model_id: string,
   *   arm: string,
   *   rep: number,
   *   turn_index: number,
   *   request: {
   *     system_prompt_hash: string,
   *     tools_present: boolean,
   *     max_tokens: number,
   *     temperature: number,
   *     messages_digest: string,
   *   },
   *   response: {
   *     stop_reason: string,
   *     content_blocks: unknown[],
   *     usage: {
   *       input_tokens: number,
   *       output_tokens: number,
   *       cache_read_input_tokens: number,
   *       cache_creation_input_tokens: number,
   *     },
   *   },
   *   tool_results?: unknown[],
   *   wall_ms: number,
   *   ts: string,
   * }} line
   */
  appendTurn(line) {
    appendFileSync(this.tracePath, JSON.stringify({ ...line, _type: 'turn' }) + '\n', 'utf8');
  }

  /**
   * Append the rep_meta line (one per rep, after all turns).
   * Schema per PROTOCOL.md §3.4.
   */
  appendRepMeta(meta) {
    appendFileSync(this.tracePath, JSON.stringify({ ...meta, _type: 'rep_meta' }) + '\n', 'utf8');
  }

  get path() { return this.tracePath; }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function sha256Hex(text) {
  return createHash('sha256').update(text).digest('hex');
}

/**
 * Derive confidence tier from a resolve envelope (production contract).
 * Mirrors resolve.ts:deriveConfidenceTier.
 *
 * @param {{ top_score?: number, gap_to_2nd?: number, n_candidates: number }} tierInfo
 * @returns {'auto_accept' | 'candidate_list' | 'no_candidates'}
 */
function deriveTier({ top_score, gap_to_2nd, n_candidates }) {
  if (n_candidates === 0) return 'no_candidates';
  if (
    top_score !== undefined &&
    top_score > AUTO_ACCEPT_THRESHOLD &&
    (gap_to_2nd === undefined || gap_to_2nd > AUTO_ACCEPT_GAP)
  ) return 'auto_accept';
  return 'candidate_list';
}

/**
 * Detect whether a text block contains a yakcc compile emission.
 * Pattern: `yakcc compile <atom_id>` anywhere in text.
 */
function extractYakccCompileAtomId(text) {
  const m = text.match(/yakcc\s+compile\s+([\w\-./]+)/);
  return m ? m[1] : null;
}

/**
 * Detect triplet emission in model text (first code block or spec.yak mention).
 * Pattern: presence of spec.yak or "emit-atom" in the response.
 */
function hasTripletEmission(contentBlocks) {
  for (const block of contentBlocks) {
    if (block.type !== 'text') continue;
    if (/spec\.yak|emit-atom|impl\.ts|proof\//.test(block.text)) return true;
  }
  return false;
}

// ─── deriveMetrics ────────────────────────────────────────────────────────────

/**
 * Compute derived metrics from an array of raw trace turns for one rep.
 *
 * This is the offline derivation (PROTOCOL.md §3.2). It takes the turns array
 * (as written by TraceWriter.appendTurn) and produces the full derived JSON.
 *
 * REQ-TOKENS: tokens_total_output = Σ turn.response.usage.output_tokens across ALL turns.
 * This is the v4 fix — v4 only read the last turn.
 *
 * @param {{
 *   turns: Array<{
 *     turn_index: number,
 *     response: {
 *       stop_reason: string,
 *       content_blocks: unknown[],
 *       usage: {
 *         input_tokens: number,
 *         output_tokens: number,
 *         cache_read_input_tokens: number,
 *         cache_creation_input_tokens: number,
 *       }
 *     },
 *     tool_results?: Array<{ tool_use_id: string, intent?: string, envelope?: unknown }>,
 *     wall_ms: number,
 *   }>,
 *   arm: string,
 *   repMeta?: Record<string, unknown>,
 * }} opts
 * @returns {Record<string, unknown>} derived metrics
 */
export function deriveMetrics({ turns, arm, repMeta = {} }) {
  const isHooked = arm === 'hooked';

  // ── Per-turn usage rows ────────────────────────────────────────────────────
  const perTurnUsage = turns.map((t) => ({
    turn_index:             t.turn_index,
    input_tokens:           t.response.usage?.input_tokens            ?? 0,
    output_tokens:          t.response.usage?.output_tokens           ?? 0,
    cache_read_input_tokens: t.response.usage?.cache_read_input_tokens ?? 0,
    cache_creation_input_tokens: t.response.usage?.cache_creation_input_tokens ?? 0,
    stop_reason:            t.response.stop_reason,
    had_tool_use:           (t.response.content_blocks ?? []).some((b) => b.type === 'tool_use'),
    wall_ms:                t.wall_ms,
  }));

  // ── REQ-TOKENS: sum across ALL turns (v4 fix) ─────────────────────────────
  const tokens_total_input             = perTurnUsage.reduce((s, t) => s + t.input_tokens,            0);
  const tokens_total_output            = perTurnUsage.reduce((s, t) => s + t.output_tokens,           0);
  const cache_read_total               = perTurnUsage.reduce((s, t) => s + t.cache_read_input_tokens, 0);
  const cache_creation_total           = perTurnUsage.reduce((s, t) => s + t.cache_creation_input_tokens, 0);

  // v4-bug comparison: what v4 would have reported (last-turn only)
  const lastTurn = turns[turns.length - 1];
  const v4_last_turn_only_input  = lastTurn?.response.usage?.input_tokens  ?? 0;
  const v4_last_turn_only_output = lastTurn?.response.usage?.output_tokens ?? 0;

  // ── Token phases ──────────────────────────────────────────────────────────
  // resolve_phase = turns where the model called yakcc_resolve (tool_use stop)
  // emission_phase = turns after the last tool_use (final answer generation)
  const resolvePhaseIdx = perTurnUsage.filter((t) => t.had_tool_use).map((t) => t.turn_index);
  const tokens_resolve_phase = perTurnUsage
    .filter((t) => resolvePhaseIdx.includes(t.turn_index))
    .reduce((s, t) => s + t.output_tokens, 0);
  const tokens_emission_phase = perTurnUsage
    .filter((t) => !resolvePhaseIdx.includes(t.turn_index))
    .reduce((s, t) => s + t.output_tokens, 0);

  // thinking tokens: sum text blocks with "thinking" type
  let thinking_tokens = 0;
  for (const t of turns) {
    for (const b of t.response.content_blocks ?? []) {
      if (b.type === 'thinking') thinking_tokens += b.thinking?.length ?? 0;
    }
  }

  // max_tokens truncation
  const max_tokens_truncated = turns.some((t) => t.response.stop_reason === 'max_tokens');

  // ── Intent card tokens ────────────────────────────────────────────────────
  // Count tokens in tool_use blocks (the IntentCard submitted by the model)
  let intent_card_tokens = 0;
  let tool_result_tokens = 0;
  for (const t of turns) {
    for (const b of t.response.content_blocks ?? []) {
      if (b.type === 'tool_use') {
        intent_card_tokens += JSON.stringify(b.input ?? {}).length;
      }
    }
    for (const tr of t.tool_results ?? []) {
      tool_result_tokens += JSON.stringify(tr.envelope ?? tr).length;
    }
  }
  // Normalize to rough token estimate: ~4 chars per token
  intent_card_tokens = Math.round(intent_card_tokens / 4);
  tool_result_tokens = Math.round(tool_result_tokens / 4);

  // ── Resolve envelope analysis ─────────────────────────────────────────────
  // Collect all yakcc_resolve envelopes from tool_results
  const resolveEnvelopes = [];
  for (const t of turns) {
    for (const tr of t.tool_results ?? []) {
      if (tr.envelope && typeof tr.envelope === 'object' && 'confidence_tier' in tr.envelope) {
        resolveEnvelopes.push(tr.envelope);
      }
    }
  }

  const firstEnvelope = resolveEnvelopes[0] ?? null;
  const candidates = firstEnvelope?.candidates ?? [];
  const n_candidates = candidates.length;
  const top_score = candidates[0]?.score ?? null;
  const gap_to_2nd = n_candidates >= 2 ? (top_score ?? 0) - (candidates[1]?.score ?? 0) : null;
  const tier_returned = firstEnvelope?.confidence_tier ?? null;

  // Threshold capture: both the production rule (0.92+gap0.15) and the doc's 0.85 rule
  const threshold_auto_accept_production = top_score !== null && top_score > AUTO_ACCEPT_THRESHOLD &&
    (gap_to_2nd === null || gap_to_2nd > AUTO_ACCEPT_GAP);
  const threshold_auto_accept_doc_085    = top_score !== null && top_score > DOC_THRESHOLD;
  const n_above_threshold_production     = candidates.filter((c) => c.score > AUTO_ACCEPT_THRESHOLD).length;
  const n_above_threshold_doc_085        = candidates.filter((c) => c.score > DOC_THRESHOLD).length;

  // ── Flow class ─────────────────────────────────────────────────────────────
  // resolve_before_any_code: did yakcc_resolve precede the first code block?
  const firstCodeTurnIdx = (() => {
    for (const t of turns) {
      for (const b of t.response.content_blocks ?? []) {
        if (b.type === 'text' && /```/.test(b.text)) return t.turn_index;
      }
    }
    return null;
  })();
  const firstResolveTurnIdx = resolvePhaseIdx[0] ?? null;
  const resolve_before_any_code = firstResolveTurnIdx !== null &&
    (firstCodeTurnIdx === null || firstResolveTurnIdx < firstCodeTurnIdx);

  // Detect model's action given the tier
  let model_action_given_tier = null;
  if (tier_returned) {
    const allText = turns.flatMap((t) =>
      (t.response.content_blocks ?? []).filter((b) => b.type === 'text').map((b) => b.text)
    ).join('\n');
    const hasCompile = extractYakccCompileAtomId(allText) !== null;
    const hasTriplet = hasTripletEmission(turns.flatMap((t) => t.response.content_blocks ?? []));
    if (tier_returned === 'auto_accept' && hasCompile) {
      model_action_given_tier = 'accepted_auto';
    } else if (tier_returned === 'candidate_list' && hasCompile) {
      model_action_given_tier = 'picked_from_list';
    } else if ((tier_returned === 'candidate_list') && !hasCompile) {
      model_action_given_tier = 'authored_despite_candidate';
    } else if (tier_returned === 'no_candidates' && hasTriplet) {
      model_action_given_tier = 'triplet_emitted';
    } else {
      model_action_given_tier = 'unknown';
    }
  }

  // flow_class derivation
  let flow_class;
  if (!isHooked) {
    flow_class = 'cold_unhooked';
  } else if (resolveEnvelopes.length === 0) {
    flow_class = 'ignored_tool';
  } else if (tier_returned === 'no_candidates') {
    flow_class = 'cold_miss_authored';
  } else if (tier_returned === 'auto_accept' && model_action_given_tier === 'accepted_auto') {
    flow_class = 'followed';
  } else if (tier_returned === 'candidate_list' && model_action_given_tier === 'authored_despite_candidate') {
    flow_class = 'resolved_then_ignored';
  } else if (hasTripletEmission(turns.flatMap((t) => t.response.content_blocks ?? []))) {
    // malformed: model issued tool call but response is neither compile nor clean triplet
    flow_class = 'malformed';
  } else {
    flow_class = 'followed';
  }

  // path_class
  let path_class;
  if (!isHooked) {
    path_class = 'cold_unhooked';
  } else if (tier_returned === 'auto_accept') {
    path_class = 'hot_hit';
  } else if (tier_returned === 'candidate_list') {
    path_class = 'warm_candidate_list';
  } else {
    path_class = 'cold_miss';
  }

  // ── Failure taxonomy ──────────────────────────────────────────────────────
  // Priority: model_ignored_candidate > below_threshold (behavioral override wins).
  // A model that resolves a usable candidate but authors anyway is a distinct failure
  // class from simply getting a below-threshold result.
  let failure_class = 'none';
  if (tier_returned === 'no_candidates') {
    failure_class = 'no_candidate';
  } else if (flow_class === 'resolved_then_ignored') {
    // Model saw a candidate but chose to author its own implementation
    failure_class = 'model_ignored_candidate';
  } else if (tier_returned === 'candidate_list' && top_score !== null && top_score < AUTO_ACCEPT_THRESHOLD) {
    failure_class = 'below_threshold';
  }
  // substituted_but_failed and triplet_malformed are filled in by the harness after oracle runs

  return {
    // REQ-TOKENS totals
    tokens_total_input,
    tokens_total_output,
    cache_read_total,
    cache_creation_total,

    // v4-bug comparison (for regression proof)
    v4_last_turn_only_output,
    v4_last_turn_only_input,
    turns_count: turns.length,

    // Per-turn usage
    per_turn_usage: perTurnUsage,

    // Phase tokens
    tokens_resolve_phase,
    tokens_emission_phase,
    intent_card_tokens,
    tool_result_tokens,
    thinking_tokens,
    max_tokens_truncated,
    cache_read_total_prompt: cache_read_total,
    cache_creation_total_prompt: cache_creation_total,

    // Tier behaviour
    tier_returned,
    top_score,
    gap_to_2nd,
    n_candidates,
    threshold_auto_accept_production,
    threshold_auto_accept_doc_085,
    n_above_threshold_production,
    n_above_threshold_doc_085,
    model_action_given_tier,

    // Flow adherence
    flow_class,
    path_class,
    resolve_before_any_code,

    // Failure taxonomy (substitution/triplet fields filled by harness)
    failure_class,
    substituted: false,
    substituted_atom_id: null,
    substitution_oracle_passed: null,
    triplet_wellformed: null,
    triplet_emit_exit_code: null,
    triplet_oracle_passed: null,
  };
}
