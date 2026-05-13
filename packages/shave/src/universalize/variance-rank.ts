// SPDX-License-Identifier: MIT
/**
 * @decision DEC-VARIANCE-WIRING-001
 * title: In-slice cluster ranking via @yakcc/variance at the registry-match decision site
 * status: decided
 * rationale:
 *   When `registry.findByCanonicalAstHash()` returns more than one BlockMerkleRoot
 *   for a given canonicalAstHash, the slicer historically picked `matches[0]` silently.
 *   This module replaces that silent drop with variance-scored cluster ranking:
 *
 *   Seam choice (Option B — in-slice at the cluster site):
 *     The cluster-selection decision happens inside slice() at the registry-match step.
 *     Option A (post-decompose pre-slice) was rejected: decompose() doesn't surface
 *     clusters; building a parallel registry-walk authority violates Sacred Practice #12.
 *     Option C (post-slice annotation) was rejected: it doesn't fix the silent-drop bug.
 *
 *   Translation step:
 *     - Candidate side: the caller's IntentCard is mapped to SpecYak via `specFromIntent`
 *       (DEC-VAR-004: translation lives in callers, variance consumes SpecYak only).
 *     - Registry side: `BlockTripletRow.specCanonicalBytes` (canonical JSON bytes) is
 *       decoded via `validateSpecYak(JSON.parse(TextDecoder.decode(bytes)))`.
 *
 *   Tiebreaker ordering:
 *     Highest `varianceScore.score` wins. Ties (|a - b| < 1e-9) fall back to the
 *     original first-returned order from `findByCanonicalAstHash` (deterministic,
 *     preserving the existing implicit ordering).
 *
 *   Loud-fail on malformed registry rows:
 *     If `specCanonicalBytes` fails to decode into a valid SpecYak for any candidate,
 *     a `VarianceCandidateMalformedError` is thrown with the failing merkleRoot in the
 *     message (Sacred Practice #5 — no silent fallback).
 *
 *   Single-candidate fast path:
 *     When `matches.length === 1`, `rankCluster()` is NOT called. The slicer proceeds
 *     as before: zero overhead, no `getBlock` calls, no `varianceScores` on the entry.
 *     Only multi-candidate sites allocate the scores array.
 *
 *   Weights:
 *     Always `DIMENSION_WEIGHTS` from `@yakcc/variance` (DEC-VAR-005 / -003: per-query
 *     weight overrides are out of scope; any weight change requires its own DEC).
 */

import { validateSpecYak } from "@yakcc/contracts";
import type { BlockMerkleRoot } from "@yakcc/contracts";
import { varianceScore } from "@yakcc/variance";
import type { DimensionScores } from "@yakcc/variance";
import type { IntentCard } from "../intent/types.js";
import { specFromIntent } from "../persist/spec-from-intent.js";
import type { ShaveRegistryView } from "../types.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * One variance-scored candidate in a multi-match cluster.
 * `score` is the weighted composite variance score in [0, 1].
 * `dimensions` is the per-dimension breakdown (security, behavioral, etc.).
 */
export interface VarianceScoreEntry {
  readonly merkleRoot: BlockMerkleRoot;
  readonly score: number;
  readonly dimensions: DimensionScores;
}

// ---------------------------------------------------------------------------
// Error type (Sacred Practice #5 — loud failure for malformed registry rows)
// ---------------------------------------------------------------------------

/**
 * Thrown when a candidate BlockTripletRow's `specCanonicalBytes` cannot be
 * decoded into a valid SpecYak. This indicates a malformed or corrupted
 * registry row — not a wiring failure.
 *
 * The failing `merkleRoot` is included in the message so callers and logs
 * can identify the specific row that is problematic.
 */
export class VarianceCandidateMalformedError extends Error {
  readonly merkleRoot: BlockMerkleRoot;

  constructor(merkleRoot: BlockMerkleRoot, cause: unknown) {
    super(
      `variance-rank: failed to decode specCanonicalBytes for merkleRoot="${merkleRoot}": ${String(cause)}`,
    );
    this.name = "VarianceCandidateMalformedError";
    this.merkleRoot = merkleRoot;
    // Preserve the original decode/validation error as cause.
    if (cause instanceof Error) {
      this.cause = cause;
    }
  }
}

// ---------------------------------------------------------------------------
// Internal decoder
// ---------------------------------------------------------------------------

const _decoder = new TextDecoder();

// ---------------------------------------------------------------------------
// Public API: rankCluster
// ---------------------------------------------------------------------------

/**
 * Rank a cluster of candidate registry matches by their variance score against
 * the caller's intent card.
 *
 * Called only when `matches.length > 1`. The single-candidate fast path is
 * handled by the callers (walkNodeStrict / walkNodeGlueAware) — this function
 * always receives at least 2 merkleRoots and always returns at least 2 entries.
 *
 * Algorithm:
 *   1. Map `intentCard` → SpecYak (canonical side) via `specFromIntent`.
 *   2. For each merkleRoot, fetch the BlockTripletRow from the registry
 *      (`registry.getBlock`). If the row is missing, treat it as malformed
 *      (loud-fail with VarianceCandidateMalformedError).
 *   3. Decode `specCanonicalBytes` → SpecYak (candidate side) via
 *      `JSON.parse(decoder.decode(bytes))` + `validateSpecYak`.
 *      On failure: throw VarianceCandidateMalformedError.
 *   4. Call `varianceScore(canonicalSpec, candidateSpec)` for each candidate.
 *   5. Sort descending by score. Ties (|a - b| < 1e-9) preserve the original
 *      order from `matches` (stable sort input order is the original order).
 *
 * @param intentCard       - The extracted intent card for the candidate being sliced.
 * @param canonicalAstHash - The canonical AST hash; used as the hash suffix in `specFromIntent`.
 * @param matchMerkleRoots - The merkleRoots returned by `findByCanonicalAstHash`.
 *                           Must have length >= 2 (single-match fast path is caller's responsibility).
 * @param registry         - Registry view used to fetch BlockTripletRow per candidate.
 * @returns Array of VarianceScoreEntry sorted by descending score (highest first).
 *          The first entry's merkleRoot is the one the slicer should use.
 * @throws VarianceCandidateMalformedError if any candidate row is missing or its
 *         specCanonicalBytes cannot be validated as SpecYak.
 */
export async function rankCluster(
  intentCard: IntentCard,
  canonicalAstHash: string,
  matchMerkleRoots: readonly BlockMerkleRoot[],
  registry: Pick<ShaveRegistryView, "getBlock">,
): Promise<readonly VarianceScoreEntry[]> {
  // Step 1: Translate IntentCard → SpecYak (canonical side).
  // specFromIntent is the authority for this translation (DEC-ATOM-PERSIST-001).
  const canonicalSpec = specFromIntent(intentCard, canonicalAstHash);

  // Step 2-4: Fetch + decode + score each candidate.
  // We collect scores in input order so the stable sort preserves original order for ties.
  const scored: VarianceScoreEntry[] = [];
  for (const merkleRoot of matchMerkleRoots) {
    // Fetch the BlockTripletRow — missing row is treated as malformed (Sacred Practice #5).
    const row = await registry.getBlock(merkleRoot);
    if (row === undefined) {
      throw new VarianceCandidateMalformedError(
        merkleRoot,
        new Error("getBlock returned undefined — row missing from registry"),
      );
    }

    // Decode specCanonicalBytes → SpecYak.
    // canonical JSON bytes via TextDecoder → JSON.parse → validateSpecYak.
    let candidateSpec: ReturnType<typeof validateSpecYak>;
    try {
      const jsonText = _decoder.decode(row.specCanonicalBytes);
      const parsed: unknown = JSON.parse(jsonText);
      candidateSpec = validateSpecYak(parsed);
    } catch (err) {
      throw new VarianceCandidateMalformedError(merkleRoot, err);
    }

    // Score: varianceScore uses DIMENSION_WEIGHTS (governance-locked per DEC-VAR-003/-005).
    const result = varianceScore(canonicalSpec, candidateSpec);

    scored.push({
      merkleRoot,
      score: result.score,
      dimensions: result.dimensions,
    });
  }

  // Step 5: Sort descending by score.
  // JavaScript's Array.prototype.sort is stable (ES2019+, V8/Node ≥12), so
  // entries with equal scores (|a - b| < 1e-9) preserve their original input
  // order — which is the original `matches` order from `findByCanonicalAstHash`.
  // This satisfies the deterministic-tiebreaker invariant (T4).
  scored.sort((a, b) => {
    const diff = b.score - a.score;
    // Treat differences smaller than 1e-9 as a tie (preserve original order).
    if (Math.abs(diff) < 1e-9) return 0;
    return diff;
  });

  return scored;
}
