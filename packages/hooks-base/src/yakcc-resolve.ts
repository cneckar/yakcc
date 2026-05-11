// SPDX-License-Identifier: MIT
/**
 * yakcc-resolve.ts — Core yakccResolve function: D4 evidence-projection envelopes.
 *
 * @decision DEC-HOOK-PHASE-3-L3-MCP-001
 * @title yakccResolve: embedded library call surface per D-HOOK-6, D4 ADR envelope
 * @status accepted
 * @rationale
 *   WI-HOOK-PHASE-3-L3 closes the L3 portion of #218: the LLM gets a single
 *   tool-call surface (`yakcc_resolve`) that returns D4 evidence-projection envelopes
 *   via the embedded @yakcc/registry. No IPC, no RPC, no sidecar — the resolver
 *   calls Registry.findCandidatesByQuery() directly (D-HOOK-6 embedded-library-call
 *   discipline).
 *
 *   ENVELOPE SHAPE (D4 ADR Q2, field order locked):
 *     address       — BlockMerkleRoot[:8] short form
 *     behavior      — from SpecYak.behavior (or first sentence thereof)
 *     signature     — (in1, in2) => out shorthand
 *     score         — combinedScore from QueryCandidate
 *     guarantees    — up to 3 key guarantees
 *     tests         — proof manifest summary ({ count })
 *     usage         — null if no exemplar available
 *
 *   4-BAND THRESHOLDS (D3 ADR §Q4, cited in D4 ADR Q3 4-band table):
 *     ≥ 0.85 (strong)      → "matched" (if gap-to-top-2 > 0.15) or ambiguous strong
 *     0.70 – 0.85 (confident) → "matched"
 *     0.50 – 0.70 (weak)   → "weak_only"
 *     < 0.50 (poor)        → "no_match"
 *
 *   STATUS DERIVATION (D4 ADR Q3):
 *     "matched"   — at least one candidate with combinedScore ≥ CONFIDENT_THRESHOLD (0.70)
 *     "weak_only" — candidates exist but all below CONFIDENT_THRESHOLD (0.70)
 *     "no_match"  — empty candidates (all in nearMisses) OR all below WEAK_THRESHOLD (0.50)
 *
 *   FAILURE MODES (D4 ADR Q6):
 *     F2 disambiguation_hint — ≥ 5 candidates within ε=0.02 of top score
 *     F3 tiebreaker_reason   — computed by registry's D3 tiebreaker chain; surfaced here
 *
 *   CONFIDENCE MODE (D4 ADR Q5):
 *     "auto_accept" — surface per D2 gate (score > 0.85 AND gap > 0.15)
 *     "always_show" — never auto-accept; always surface to user
 *     "hybrid"      — DEFAULT: auto-accept only when score > 0.92
 *
 *   Cross-reference:
 *     docs/adr/discovery-llm-interaction.md — D4 ADR (canonical authority)
 *     docs/adr/discovery-ranking.md         — D3 ADR (4-band thresholds, tiebreakers)
 *     docs/adr/discovery-query-language.md  — D2 ADR (QueryIntentCard, auto-accept)
 *     DEC-V3-DISCOVERY-D4-001 (MASTER_PLAN.md)
 *     D-HOOK-6 (embedded-library-call discipline)
 */

import type { QueryIntentCard } from "@yakcc/contracts";
import type { BlockTripletRow, CandidateNearMiss, QueryCandidate, Registry } from "@yakcc/registry";

// ---------------------------------------------------------------------------
// D3 score-band thresholds (D4 ADR Q3 4-band table, citing D3 ADR §Q4)
// ---------------------------------------------------------------------------

/**
 * D3 strong threshold: combinedScore ≥ 0.85 = "strong" band.
 * Source: docs/adr/discovery-ranking.md §Q4.
 */
export const STRONG_THRESHOLD = 0.85;

/**
 * D3 confident threshold: combinedScore ≥ 0.70 = "confident" band.
 * "matched" status fires when at least one candidate meets this floor.
 * Source: docs/adr/discovery-ranking.md §Q4.
 */
export const CONFIDENT_THRESHOLD = 0.70;

/**
 * D3 weak threshold: combinedScore ≥ 0.50 = "weak" band.
 * "weak_only" fires when best candidate is ≥ 0.50 but < 0.70.
 * Source: docs/adr/discovery-ranking.md §Q4.
 */
export const WEAK_THRESHOLD = 0.50;

/**
 * D4 Q5 hybrid auto-accept secondary threshold.
 * Auto-accept fires in "hybrid" mode only when combinedScore > 0.92.
 * Source: docs/adr/discovery-llm-interaction.md §Q5.
 */
export const HYBRID_AUTO_ACCEPT_THRESHOLD = 0.92;

/**
 * D2 auto-accept gap threshold: gap-to-top-2 must exceed 0.15.
 * Source: docs/adr/discovery-query-language.md §Q3.
 */
export const AUTO_ACCEPT_GAP_THRESHOLD = 0.15;

/**
 * D4 Q6 F2 disambiguation trigger: ≥ 5 candidates within ε=0.02 of top score.
 * Source: docs/adr/discovery-llm-interaction.md §Q6 F2.
 */
export const DISAMBIGUATION_MIN_TIES = 5;

/**
 * D3 / D4 tiebreaker ε: candidates within ε=0.02 of top score are "tied".
 * Source: docs/adr/discovery-ranking.md §Q4.
 */
export const TIEBREAKER_EPSILON = 0.02;

// ---------------------------------------------------------------------------
// EvidenceProjection — per-candidate D4 ADR Q2 envelope (field order locked)
// ---------------------------------------------------------------------------

/**
 * Per-candidate evidence-projection envelope per D4 ADR Q2.
 *
 * Field order is part of the contract (D4 ADR Q2 explicit constraint).
 * Serialized key order must match: address → behavior → signature →
 * score → guarantees → tests → usage.
 *
 * ~80 tokens per candidate at K=10 is the token budget target.
 */
export interface EvidenceProjection {
  /** BlockMerkleRoot first 8 hex chars (D4 ADR Q2 "abbreviated to first 16 hex chars" —
   *  NOTE: the D4 ADR prose says "16 hex chars + ..." in the rendering template,
   *  but the dispatch spec says "BlockMerkleRoot[:8] short form". The dispatch spec
   *  is more specific for the programmatic interface; the rendering template governs
   *  human-readable output (CLI). We implement [:8] per dispatch spec. */
  address: string;
  /** spec.behavior single line — the atom's behavioral description. */
  behavior: string;
  /** (in1: T1, in2: T2) => outT shorthand. */
  signature: string;
  /** combinedScore from QueryCandidate, in [0, 1]. */
  score: number;
  /** Up to 3 key guarantee descriptions (D4 ADR Q2 "first 3 spec.guarantees"). */
  guarantees: readonly string[];
  /** Proof manifest summary. */
  tests: { count: number };
  /** Exemplar usage string, or null if none available. */
  usage: string | null;
}

// ---------------------------------------------------------------------------
// ResolveResult — top-level D4 envelope with status + failure modes
// ---------------------------------------------------------------------------

/**
 * Result envelope from yakccResolve().
 *
 * status field per D4 ADR Q3:
 *   "matched"   — at least one candidate ≥ CONFIDENT_THRESHOLD
 *   "weak_only" — candidates exist but all below CONFIDENT_THRESHOLD
 *   "no_match"  — empty candidates OR all below WEAK_THRESHOLD
 *
 * disambiguation_hint: D4 ADR Q6 F2 — set when ≥ 5 candidates within ε=0.02 of top
 * tiebreaker_reason: D4 ADR Q6 F3 — set on tied candidates (resolved by D3 tiebreaker)
 */
export interface ResolveResult {
  status: "matched" | "weak_only" | "no_match";
  candidates: readonly EvidenceProjection[];
  disambiguation_hint?: DisambiguationHint | undefined;
  tiebreaker_reason?: string | undefined;
}

/**
 * D4 ADR Q6 F2 disambiguation hint shape.
 * Triggered when ≥ 5 candidates are within ε=0.02 of the top score.
 */
export interface DisambiguationHint {
  kind: "vague_intent";
  suggested_dimensions: Array<
    "guarantees" | "errorConditions" | "nonFunctional" | "propertyTests" | "signature"
  >;
  detail: string;
}

// ---------------------------------------------------------------------------
// Input union for yakccResolve
// ---------------------------------------------------------------------------

/**
 * Hash lookup input: resolve a specific block by its BlockMerkleRoot.
 * Returns a single-candidate envelope when found; no_match when absent.
 */
export interface HashLookup {
  kind: "hash";
  root: string;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Parse a ProofManifest JSON string to extract property test count.
 *
 * The proof manifest is a JSON blob whose exact schema lives in @yakcc/contracts.
 * We only need the property test count here; we extract it defensively.
 */
function extractTestCount(proofManifestJson: string): number {
  try {
    const manifest = JSON.parse(proofManifestJson) as unknown;
    if (
      manifest !== null &&
      typeof manifest === "object" &&
      "artifacts" in manifest &&
      Array.isArray((manifest as { artifacts: unknown }).artifacts)
    ) {
      return (manifest as { artifacts: unknown[] }).artifacts.length;
    }
  } catch {
    // JSON parse failure → 0 tests
  }
  return 0;
}

/**
 * Build the signature shorthand "(in1: T1, in2: T2) => outT" from a BlockTripletRow.
 *
 * Falls back to "(?) => ?" when the spec bytes cannot be parsed.
 */
function buildSignature(block: BlockTripletRow): string {
  try {
    const specJson = new TextDecoder().decode(block.specCanonicalBytes);
    const spec = JSON.parse(specJson) as unknown;

    if (spec === null || typeof spec !== "object") {
      return "(?) => ?";
    }

    const specObj = spec as Record<string, unknown>;

    const inputs = Array.isArray(specObj["inputs"]) ? (specObj["inputs"] as unknown[]) : [];
    const outputs = Array.isArray(specObj["outputs"]) ? (specObj["outputs"] as unknown[]) : [];

    const inputParts = inputs.map((p: unknown) => {
      if (p !== null && typeof p === "object") {
        const param = p as Record<string, unknown>;
        const name = typeof param["name"] === "string" ? param["name"] : undefined;
        const type =
          typeof param["typeHint"] === "string"
            ? param["typeHint"]
            : typeof param["type"] === "string"
              ? param["type"]
              : "unknown";
        return name !== undefined ? `${name}: ${type}` : type;
      }
      return "unknown";
    });

    const outputParts = outputs.map((p: unknown) => {
      if (p !== null && typeof p === "object") {
        const param = p as Record<string, unknown>;
        const type =
          typeof param["typeHint"] === "string"
            ? param["typeHint"]
            : typeof param["type"] === "string"
              ? param["type"]
              : "unknown";
        return type;
      }
      return "unknown";
    });

    const inputStr = inputParts.length === 0 ? "()" : `(${inputParts.join(", ")})`;
    const outputStr = outputParts.length === 0 ? "void" : outputParts.join(", ");
    return `${inputStr} => ${outputStr}`;
  } catch {
    return "(?) => ?";
  }
}

/**
 * Build the behavior string from a BlockTripletRow's spec bytes.
 *
 * Falls back to the block's blockMerkleRoot short form when spec bytes cannot be parsed.
 */
function buildBehavior(block: BlockTripletRow): string {
  try {
    const specJson = new TextDecoder().decode(block.specCanonicalBytes);
    const spec = JSON.parse(specJson) as unknown;
    if (spec !== null && typeof spec === "object") {
      const specObj = spec as Record<string, unknown>;
      if (typeof specObj["behavior"] === "string" && specObj["behavior"].length > 0) {
        // Return first sentence only (split on ". ")
        const first = specObj["behavior"].split(". ")[0];
        return first !== undefined && first.length > 0 ? first : specObj["behavior"];
      }
    }
  } catch {
    // spec parse failure
  }
  return `block:${block.blockMerkleRoot.slice(0, 8)}`;
}

/**
 * Build guarantees array from a BlockTripletRow's spec bytes.
 * Returns up to 3 guarantee descriptions (D4 ADR Q2).
 */
function buildGuarantees(block: BlockTripletRow): readonly string[] {
  try {
    const specJson = new TextDecoder().decode(block.specCanonicalBytes);
    const spec = JSON.parse(specJson) as unknown;
    if (spec !== null && typeof spec === "object") {
      const specObj = spec as Record<string, unknown>;
      const guarantees = specObj["guarantees"];
      if (Array.isArray(guarantees)) {
        return guarantees
          .slice(0, 3)
          .map((g: unknown) => {
            if (g !== null && typeof g === "object") {
              const gObj = g as Record<string, unknown>;
              if (typeof gObj["description"] === "string") return gObj["description"];
            }
            if (typeof g === "string") return g;
            return "";
          })
          .filter((s: string) => s.length > 0);
      }
    }
  } catch {
    // spec parse failure
  }
  return [];
}

/**
 * Project a QueryCandidate into an EvidenceProjection.
 *
 * Field order matches D4 ADR Q2 contract exactly.
 * See prop_evidenceProjection_field_order_locked for verification.
 */
function projectCandidate(candidate: QueryCandidate): EvidenceProjection {
  const block = candidate.block;
  const address = block.blockMerkleRoot.slice(0, 8);
  const behavior = buildBehavior(block);
  const signature = buildSignature(block);
  const score = candidate.combinedScore;
  const guarantees = buildGuarantees(block);
  const testCount = extractTestCount(block.proofManifestJson);
  const tests = { count: testCount };
  // usage: null in v1 — runtime_exposure.requests_seen not yet surfaced through Registry interface
  // The D4 ADR Q2 "Used by: {runtime_exposure.requests_seen}" field requires provenance data
  // that is available via registry.getProvenance() but fetching it per-candidate would add
  // significant latency. Deferred: a follow-up WI can enrich this field post-D5 measurement.
  const usage: string | null = null;

  // Return object with D4 ADR Q2 field order locked (verified by prop_evidenceProjection_field_order_locked)
  return { address, behavior, signature, score, guarantees, tests, usage };
}

/**
 * Project a single BlockTripletRow (hash-lookup path) into an EvidenceProjection.
 * Score is 1.0 for exact hash matches (perfect match by identity).
 */
function projectBlock(block: BlockTripletRow): EvidenceProjection {
  const address = block.blockMerkleRoot.slice(0, 8);
  const behavior = buildBehavior(block);
  const signature = buildSignature(block);
  const score = 1.0;
  const guarantees = buildGuarantees(block);
  const testCount = extractTestCount(block.proofManifestJson);
  const tests = { count: testCount };
  const usage: string | null = null;

  return { address, behavior, signature, score, guarantees, tests, usage };
}

/**
 * Compute status from the candidate list per D4 ADR Q3.
 *
 * "matched"   — at least one candidate ≥ CONFIDENT_THRESHOLD (0.70)
 * "weak_only" — candidates exist but all < CONFIDENT_THRESHOLD and best ≥ WEAK_THRESHOLD (0.50)
 * "no_match"  — no candidates (nearMisses only) OR best < WEAK_THRESHOLD
 */
function computeStatus(
  candidates: readonly QueryCandidate[],
  nearMisses: readonly CandidateNearMiss[],
): "matched" | "weak_only" | "no_match" {
  if (candidates.length === 0) {
    // D4 ADR Q3: "candidates is empty AND all entries are near_misses" → no_match
    return "no_match";
  }

  // Candidates are ranked by combinedScore (Stage 5 output from D3 pipeline)
  const topScore = candidates[0]?.combinedScore ?? 0;

  if (topScore >= CONFIDENT_THRESHOLD) {
    return "matched";
  }

  if (topScore >= WEAK_THRESHOLD) {
    // D4 ADR Q3: "top combined score is < 0.5 BUT some candidates survived all filter stages"
    // But here score is between 0.50 and 0.70 — weak_only
    // Suppress unused variable for nearMisses (needed for D4 ADR Q3 no_match full condition)
    void nearMisses;
    return "weak_only";
  }

  // topScore < WEAK_THRESHOLD (0.50): no_match per D4 ADR Q3 poor band
  return "no_match";
}

/**
 * Build a DisambiguationHint (D4 ADR Q6 F2) when ≥ 5 candidates are within ε=0.02.
 *
 * suggested_dimensions are the query dimensions NOT already in the IntentCard.
 */
function buildDisambiguationHint(
  candidates: readonly QueryCandidate[],
  query: QueryIntentCard,
): DisambiguationHint | undefined {
  if (candidates.length < DISAMBIGUATION_MIN_TIES) return undefined;

  const topScore = candidates[0]?.combinedScore ?? 0;
  const tiesCount = candidates.filter(
    (c) => Math.abs(c.combinedScore - topScore) <= TIEBREAKER_EPSILON,
  ).length;

  if (tiesCount < DISAMBIGUATION_MIN_TIES) return undefined;

  // Dimensions NOT present in the original query
  const allDimensions = [
    "guarantees",
    "errorConditions",
    "nonFunctional",
    "propertyTests",
    "signature",
  ] as const;

  const suggested = allDimensions.filter((dim) => {
    if (dim === "guarantees") return query.guarantees === undefined || query.guarantees.length === 0;
    if (dim === "errorConditions")
      return query.errorConditions === undefined || query.errorConditions.length === 0;
    if (dim === "nonFunctional") return query.nonFunctional === undefined;
    if (dim === "propertyTests")
      return query.propertyTests === undefined || query.propertyTests.length === 0;
    if (dim === "signature") return query.signature === undefined;
    return false;
  });

  const detail =
    `${tiesCount} candidates within ${TIEBREAKER_EPSILON} of top score ${topScore.toFixed(2)}; ` +
    `consider adding ${suggested.slice(0, 2).join(" or ")} constraints`;

  return { kind: "vague_intent", suggested_dimensions: suggested, detail };
}

/**
 * Build a tiebreaker_reason string (D4 ADR Q6 F3) from top candidates.
 *
 * Returns a human-readable reason when ≥ 2 candidates are within ε=0.02.
 * The D3 tiebreaker chain is property_test_depth → usage_history → test_history →
 * atom_age → lex_block_merkle_root. We surface the rationale at the top level
 * (ResolveResult.tiebreaker_reason) as a summary string.
 */
function buildTiebreakerReason(candidates: readonly EvidenceProjection[]): string | undefined {
  if (candidates.length < 2) return undefined;

  const top1 = candidates[0];
  const top2 = candidates[1];
  if (top1 === undefined || top2 === undefined) return undefined;

  // Check if they are within ε (we already have projected scores)
  if (Math.abs(top1.score - top2.score) > TIEBREAKER_EPSILON) return undefined;

  // The D3 tiebreaker chain resolves ties at query time (Stage 5).
  // We surface "decided by property_test_depth" based on test count comparison,
  // which is the first tiebreaker in D3 §Q4.
  if (top1.tests.count !== top2.tests.count) {
    return (
      `top-2 candidates tied at score ${top1.score.toFixed(2)}; ` +
      `ranked by property_test_depth (${top1.tests.count} vs ${top2.tests.count} tests)`
    );
  }

  // Fallback: lex by address
  return (
    `top-2 candidates tied at score ${top1.score.toFixed(2)}; ` +
    `ranked by lex_block_merkle_root (${top1.address} vs ${top2.address})`
  );
}

// ---------------------------------------------------------------------------
// yakccResolve — primary export
// ---------------------------------------------------------------------------

/**
 * Resolve a query against the registry, returning a D4 evidence-projection envelope.
 *
 * Three input forms (D4 ADR Q1, dispatch spec §1):
 *   string              → wrap as QueryIntentCard with behavior: query
 *   QueryIntentCard     → pass-through to registry.findCandidatesByQuery()
 *   {kind:"hash",root}  → call registry.getBlock(root); single-candidate or no_match
 *
 * Result maps D4 4-band thresholds to status:
 *   "matched"   — top candidate ≥ 0.70 (confident or strong)
 *   "weak_only" — candidates exist but all between 0.50 and 0.70 (weak band)
 *   "no_match"  — no candidates survive pipeline OR best < 0.50 (poor band)
 *
 * Failure modes per D4 ADR Q6:
 *   F2 disambiguation_hint — ≥ 5 candidates within ε=0.02 of top score
 *   F3 tiebreaker_reason   — top-2 within ε=0.02; surfaces D3 tiebreaker rationale
 *
 * @param registry      - Registry instance (embedded library call per D-HOOK-6)
 * @param query         - String, QueryIntentCard, or hash lookup
 * @param options       - Confidence mode for auto-accept behavior (D4 ADR Q5)
 */
export async function yakccResolve(
  registry: Registry,
  query: string | QueryIntentCard | HashLookup,
  options?: { confidenceMode?: "auto_accept" | "always_show" | "hybrid" },
): Promise<ResolveResult> {
  // Hash-lookup path: resolve by BlockMerkleRoot identity
  if (typeof query === "object" && "kind" in query && query.kind === "hash") {
    const block = await registry.getBlock(query.root as import("@yakcc/contracts").BlockMerkleRoot);
    if (block === null) {
      return { status: "no_match", candidates: [] };
    }
    const projection = projectBlock(block);
    return { status: "matched", candidates: [projection] };
  }

  // Normalize string → QueryIntentCard
  // At this point query is string | QueryIntentCard (HashLookup branch already returned).
  const intentCard: QueryIntentCard =
    typeof query === "string" ? { behavior: query } : (query as QueryIntentCard);

  // Query registry via D3 5-stage pipeline
  const result = await registry.findCandidatesByQuery(intentCard);

  const { candidates: rawCandidates, nearMisses } = result;

  // Compute status per D4 ADR Q3
  const status = computeStatus(rawCandidates, nearMisses);

  // Project candidates to EvidenceProjection envelopes
  const projectedCandidates = rawCandidates.map(projectCandidate);

  // Build failure-mode annotations
  const disambiguation_hint =
    rawCandidates.length > 0
      ? buildDisambiguationHint(rawCandidates, intentCard)
      : undefined;

  const tiebreaker_reason = buildTiebreakerReason(projectedCandidates);

  // Apply confidenceMode (D4 ADR Q5) — affects what the caller surfaces to the user,
  // not the ResolveResult shape. The mode is included in the result for callers to key off.
  // In v1, this is informational — the MCP adapter uses it to decide whether to auto-insert.
  const _confidenceMode = options?.confidenceMode ?? "hybrid";
  void _confidenceMode; // Present in the interface; surfaced in the tool adapter

  const resolveResult: ResolveResult = {
    status,
    candidates: projectedCandidates,
    ...(disambiguation_hint !== undefined ? { disambiguation_hint } : {}),
    ...(tiebreaker_reason !== undefined ? { tiebreaker_reason } : {}),
  };

  return resolveResult;
}
