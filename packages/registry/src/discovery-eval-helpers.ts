// SPDX-License-Identifier: MIT
/**
 * @decision DEC-V3-DISCOVERY-D5-HARNESS-001
 * @title Evaluation harness helpers — D5 metric computation (M1..M5) + corpus schema
 * @status accepted
 * @rationale
 *   This module implements the D5 ADR (docs/adr/discovery-quality-measurement.md) metric
 *   computation functions for the discovery evaluation harness. Five decisions are captured here:
 *
 *   1. INLINE CORPUS SHAPE (5–10 entries, bootstrap baseline WI):
 *      The bootstrap corpus includes 7 entries: 5 seed-derived from the 20 seed blocks
 *      (ascii-char, digit, bracket, comma, integer) and 2 synthetic tasks (clamp + haversine
 *      negative-space). This subset was chosen to exercise:
 *        - The M1 "did we surface anything?" path (seed-derived positive entries)
 *        - The M2/M4 "did top-1 match?" path (well-defined single-answer queries)
 *        - The M5 "poor band" path (haversine negative-space ensures poor-band coverage)
 *      Selection rationale: seed blocks chosen are the simplest, most distinctive specs in
 *      the seed corpus; their behavior strings are maximally distinct, which matters for
 *      BLAKE3-based offline provider testing (DEC-CI-OFFLINE-001).
 *
 *   2. OFFLINE PROVIDER BASELINE INTERPRETATION:
 *      Per DEC-CI-OFFLINE-001, this harness uses the offline BLAKE3 provider for
 *      deterministic CI runs. The offline provider produces vectors from BLAKE3 hashes, NOT
 *      semantic embeddings — similar behavior strings do NOT produce nearby vectors. Therefore:
 *        - M1–M4 baseline numbers with the offline provider measure hash-space proximity, not
 *          semantic quality. They will be low (likely M1 < M1_HIT_THRESHOLD) because queries
 *          embedding "Parse a digit" do not hash-close to the canonical JSON embedded at store time.
 *        - The "real" M1..M5 baseline against DEC-EMBED-010 (transformers.js local provider) is
 *          the operator-meaningful measurement. That baseline is produced by running the harness
 *          with DISCOVERY_EVAL_PROVIDER=local (see measurement-first-decision.md).
 *        - CI gates use offline provider for reproducibility. Local provider is operator's tool.
 *
 *   3. RELIABILITY DIAGRAM DEFERRAL:
 *      The reliability diagram artifact (Q4 of D5 ADR) is implemented in this WI as the
 *      `computeReliabilityDiagram()` function. Emission to `tmp/discovery-eval/` is gated on
 *      the `DISCOVERY_EVAL_REPORT=1` environment variable. The actual file write is done in
 *      `discovery-eval.test.ts` via the `emitReliabilityDiagram()` helper exported here.
 *      Full corpus expansion (>=30 seed-derived + >=20 synthetic) defers to WI-V3-DISCOVERY-D5-CORPUS-SEED.
 *
 *   4. NEGATIVE-SPACE HANDLING:
 *      Entries with `expectedAtom: null` are negative-space queries. For such entries:
 *        - M1: top-1 combinedScore < M1_HIT_THRESHOLD is the EXPECTED outcome (no hit expected).
 *          M1 counts the ACTUAL score, so a negative-space entry where top-1 >= M1_HIT_THRESHOLD
 *          still counts as a "hit" (false hit). Per ADR Q1, M1 measures ALL queries including
 *          negative-space ones.
 *        - M2, M4 (MRR): skip for null expectedAtom (no correct atom exists).
 *        - M3 (Recall@K): skip for null expectedAtom.
 *
 *   5. COSINE DISTANCE TO COMBINED SCORE MAPPING:
 *      The existing `findCandidatesByIntent` path returns `cosineDistance` (lower = more similar).
 *      The D5 ADR's M1 threshold is based on D3's `combinedScore` (in [0, 1], higher = better).
 *      Linear mapping: combinedScore = max(0, 1 - cosineDistance/2). For unit-sphere vectors,
 *      cosineDistance in [0, 2] maps to combinedScore in [0, 1]. The D3 band boundaries translate:
 *        strong:    combinedScore >= 0.85
 *        confident: combinedScore >= 0.70
 *        weak:      combinedScore >= 0.50
 *        poor:      combinedScore <  0.50
 *
 * @decision DEC-V3-DISCOVERY-CALIBRATION-FIX-001
 * @title M1 hit-rate threshold calibration — lower from 0.50 to M1_HIT_THRESHOLD (0.40)
 * @status superseded — see DEC-V3-DISCOVERY-CALIBRATION-FIX-002 at `cosineDistanceToCombinedScore` below
 * @supersession-note
 *   The diagnosis below ("store/query text asymmetry") was incorrect. The actual bug is
 *   that sqlite-vec vec0 returns L2 Euclidean distance (not cosine), but the formula `1 - d/2`
 *   was applied to it as if it were cosine distance. Lowering the threshold to 0.40 was an
 *   incorrect fix for the actual bug. PR #268 / DEC-V3-DISCOVERY-CALIBRATION-FIX-002 fixes
 *   the formula to `1 - d²/4` (the correct L2 → combinedScore mapping for unit-normalized
 *   vectors) and restores the threshold to 0.50. The diagnosis below is preserved for
 *   audit-trail purposes; the code reflects the corrected -002 fix.
 * @rationale
 *   PR #254 surfaced M1=0% with M2=80%/M3=100%/M4≈0.88 under the local semantic provider.
 *   Investigation (tmp/discovery-eval/calibration-investigation.md, HEAD 31192ca) showed
 *   all correct top-1 hits produce cosineDistance in [1.02, 1.16] → combinedScore in [0.42, 0.49].
 *   All 4/4 correct hits score above 0.40 but none reach 0.50.
 *
 *   ROOT CAUSE: `storeBlock` embeds `canonicalizeText(spec)` (full canonical JSON including
 *   guarantees, errorConditions, nonFunctional, propertyTests), while `findCandidatesByIntent`
 *   embeds only `behavior + "\n" + params` (DEC-VECTOR-RETRIEVAL-002 comment in storage.ts).
 *   This store/query text asymmetry makes all cosine distances cluster around 1.0–1.2 even for
 *   semantically correct matches. The formula `1 - d/2` is mathematically correct for [0,2]
 *   input; the issue is the systematic d > 1.0 due to text-space mismatch.
 *
 *   PATH CHOICE: Path (b) — amend the D5 M1 threshold (not the D3 formula).
 *   - Path (a) rejected: `1 - d/2` is geometrically correct for unit-sphere cosine distances.
 *     Changing it would produce wrong semantics when the query/storage symmetry is fixed in
 *     WI-V3-DISCOVERY-IMPL-QUERY (at which point correct hits will produce d < 0.5).
 *   - Path (b) accepted: The M1 threshold is a D5 calibration knob (D5 ADR Q1: "above-threshold
 *     semantics revisit hook"). Lowering to 0.40 captures all empirically observed correct hits
 *     while remaining higher than incorrect hits from the non-matching queries.
 *
 *   SYMMETRY PRESERVATION (DEC-VECTOR-RETRIEVAL-002): The formula `1 - d/2` is unchanged.
 *   Only the threshold for "did we surface a hit?" shifts from 0.50 to 0.40. The query-side
 *   and storage-side derivations remain symmetric at the embedding level; only the evaluation
 *   criterion changes. When WI-V3-DISCOVERY-IMPL-QUERY fixes the store/query text asymmetry,
 *   re-run the harness and re-calibrate the threshold (likely back to 0.50 or higher).
 *
 *   M5 SCOPE FIX (issue #255): M5 (Brier per band) is now computed on the full corpus (all
 *   9 entries) in BOTH the live test and the baseline JSON. Previously the live test filtered
 *   to seed-derived (5 entries) while the JSON used all 9, producing M5=0.30 vs M5=0.04 for
 *   the same metric. Standardized to full corpus everywhere; `m5_corpus` field added to
 *   BaselineMeasurement to document which corpus subset was used.
 *
 *   Cross-references:
 *     DEC-V3-DISCOVERY-D3-001 (discovery-ranking.md) — formula unchanged; note about text
 *       asymmetry added to When-to-revisit section.
 *     DEC-V3-DISCOVERY-D5-001 (discovery-quality-measurement.md) — Q1 amended with new
 *       M1_HIT_THRESHOLD value and rationale.
 *     DEC-VECTOR-RETRIEVAL-002 (storage.ts) — store/query text symmetry gap; fix deferred
 *       to WI-V3-DISCOVERY-IMPL-QUERY.
 */

import type { QueryIntentCard, Registry } from "./index.js";

// ---------------------------------------------------------------------------
// D5 ADR corpus schema types (Q2 — verbatim from the ADR)
// ---------------------------------------------------------------------------

/**
 * The QueryIntentCard shape used in benchmark entries.
 * This is a structural subset of the full QueryIntentCard from D2 ADR.
 * Only `behavior` is required; other fields are optional per D2.
 */
export interface BenchmarkQueryCard {
  /** Freeform description of the desired behavior (required). */
  readonly behavior: string;
  /** Optional signature with named inputs/outputs. */
  readonly signature?: {
    readonly inputs?: ReadonlyArray<{ readonly name: string; readonly type: string }>;
    readonly outputs?: ReadonlyArray<{ readonly name: string; readonly type: string }>;
  };
  /** Optional guarantees text for multi-dimensional querying. */
  readonly guarantees?: readonly string[];
  /** Optional error conditions for multi-dimensional querying. */
  readonly errorConditions?: readonly string[];
}

/**
 * One entry in a benchmark corpus file (Q2 of D5 ADR).
 */
export interface BenchmarkEntry {
  /** Stable identifier; must be unique within the file. */
  readonly id: string;
  /** Source label; must match the file name. */
  readonly source: "seed-derived" | "synthetic-tasks" | "captured-sessions";
  /** The QueryIntentCard the LLM (or harness) would issue. */
  readonly query: BenchmarkQueryCard;
  /**
   * The expected top-1 atom by BlockMerkleRoot.
   * null for negative-space queries (no atom is correct).
   */
  readonly expectedAtom: string | null;
  /**
   * Optional: acceptable alternates for Recall@K.
   * If omitted, only expectedAtom counts as correct.
   */
  readonly acceptableAtoms?: readonly string[];
  /** Free-form note describing why this entry exists. */
  readonly rationale: string;
}

/**
 * The top-level structure of a benchmark corpus JSON file (Q2 of D5 ADR).
 */
export interface BenchmarkFile {
  /** Schema version; bump on incompatible schema changes. */
  readonly version: 1;
  /** Source label (matches BenchmarkEntry.source for all entries). */
  readonly source: BenchmarkEntry["source"];
  /** Date the file was last edited (YYYY-MM-DD). */
  readonly lastUpdated: string;
  /** All entries in this file. */
  readonly entries: readonly BenchmarkEntry[];
}

/**
 * An entry in pending.json tracking registry coverage gaps (Q5 of D5 ADR).
 */
export interface PendingEntry {
  /** Stable identifier (e.g. "pending-haversine-001"). */
  readonly id: string;
  /** The QueryIntentCard that did not produce a satisfactory result. */
  readonly query: BenchmarkQueryCard;
  /** Top-K candidates the system returned, captured at time of addition. */
  readonly returnedCandidates: readonly {
    readonly blockMerkleRoot: string;
    readonly combinedScore: number;
    readonly band: "strong" | "confident" | "weak" | "poor";
    readonly perDimensionScores?: Record<string, number>;
  }[];
  /** CandidateNearMiss array (D3 §Q6) explaining filter failures. */
  readonly nearMisses: readonly {
    readonly blockMerkleRoot: string;
    readonly failedAtLayer: "structural" | "strictness" | "property_test" | "min_score";
    readonly failureReason: string;
  }[];
  /** Why this entry was added. */
  readonly diagnosis: string;
  /** The action that would close this entry. */
  readonly proposedAction: string;
  /** Date added (YYYY-MM-DD). */
  readonly addedAt: string;
  /** Set when gap is closed; null while still pending. */
  readonly retiredAt: string | null;
  /** Commit SHA or PR number that closed this entry; null while pending. */
  readonly retiredBy: string | null;
}

// ---------------------------------------------------------------------------
// Score band conversion (D3 ADR — cosineDistance to combinedScore)
// ---------------------------------------------------------------------------

/**
 * Score band names as defined in D3 ADR.
 */
export type ScoreBand = "strong" | "confident" | "weak" | "poor";

/**
 * Convert a vec0 distance value to D3's combinedScore.
 *
 * @decision DEC-V3-DISCOVERY-CALIBRATION-FIX-002
 * @title L2-as-cosine units bug — correct the score-mapping formula
 * @status accepted
 * @rationale
 *   sqlite-vec's `vec0` virtual table returns **L2 Euclidean distance** by default
 *   (no `distance=cosine` specifier on the column declaration in `schema.ts`).
 *   The previous formula `1 - d/2` was the correct mapping if `d` were cosine
 *   distance — but it isn't. For unit-normalized vectors, the identity is
 *   `cosine_distance = (L2)² / 2`, so the correct mapping from L2 distance to
 *   combinedScore is `1 - L2²/4 = (1 + cos(θ)) / 2`.
 *
 *   PR #267 (DEC-V3-DISCOVERY-CALIBRATION-FIX-001) misdiagnosed the M1=0% bug
 *   surfaced in PR #254 as a "store/query text asymmetry" issue and lowered the
 *   threshold from 0.50 to 0.40 to compensate. The actual bug was the formula
 *   treating L2 distance as cosine distance. Empirical evidence:
 *     - PR #267 observed cosine distances on correct hits in [1.02, 1.16].
 *       That range is impossible for actual cosine distance on a hit but IS
 *       consistent with L2 distance for vectors with cos(θ) ≈ 0.3.
 *     - PR #268 (this fix) on the offline BLAKE3 provider with the corrected
 *       formula recovered M1 to 100% — only possible if the formula was the
 *       single bug for that provider's symmetric-text-derivation case.
 *
 *   The parameter is still named `cosineDistance` because that's what the
 *   `CandidateMatch.cosineDistance` field is named throughout the codebase.
 *   Renaming the field would cascade through many call sites; we keep the name
 *   and document the L2 reality here. The variable holds whatever vec0 returns
 *   from `SELECT distance FROM contract_embeddings WHERE embedding MATCH ?`.
 *
 *   This DEC supersedes the formula-related portions of
 *   DEC-V3-DISCOVERY-CALIBRATION-FIX-001 (file header). The threshold portion
 *   of -001 is reverted: M1_HIT_THRESHOLD returns to 0.50 (D3 ADR Q5's
 *   weak-band entry boundary).
 *
 *   Cross-references:
 *     DEC-V3-DISCOVERY-D3-001 (discovery-ranking.md) — D3 ADR's [0,1] band
 *       boundaries are now correctly reproduced by this formula.
 *     DEC-V3-DISCOVERY-D5-001 (discovery-quality-measurement.md) — D5 Q1
 *       threshold value reverts to 0.50 alongside this fix.
 *     DEC-V3-INITIATIVE-002 (MASTER_PLAN.md) — this fix removes the
 *       store/query symmetry framing as the PRIMARY contamination source;
 *       sample-size framing remains.
 *     DEC-VECTOR-RETRIEVAL-002 — store/query text derivation difference is a
 *       SECONDARY concern (real but not the dominant cause of M1=0%).
 *
 * For unit-normalized vectors, L2 distance d ∈ [0, 2]:
 *   d = 0    → combinedScore = 1.0  (identical vectors)
 *   d = √2   → combinedScore = 0.5  (orthogonal vectors, cos(θ) = 0)
 *   d = 2    → combinedScore = 0.0  (antipodal vectors, cos(θ) = -1)
 */
export function cosineDistanceToCombinedScore(cosineDistance: number): number {
  return Math.max(0, Math.min(1, 1 - (cosineDistance * cosineDistance) / 4));
}

/**
 * Assign a D3 score band to a combinedScore.
 *
 * Band boundaries (D3 ADR §Q5):
 *   strong:    combinedScore in [0.85, 1.00]
 *   confident: combinedScore in [0.70, 0.85)
 *   weak:      combinedScore in [0.50, 0.70)
 *   poor:      combinedScore in [0.00, 0.50)
 */
export function assignScoreBand(combinedScore: number): ScoreBand {
  if (combinedScore >= 0.85) return "strong";
  if (combinedScore >= 0.7) return "confident";
  if (combinedScore >= 0.5) return "weak";
  return "poor";
}

/** Band midpoints as defined in D5 ADR Q1 / Q4. */
export const BAND_MIDPOINTS: Record<ScoreBand, number> = {
  strong: 0.925,
  confident: 0.775,
  weak: 0.6,
  poor: 0.25,
};

/**
 * M1 hit-rate threshold — combinedScore value at or above which a query counts as a "hit".
 *
 * @decision DEC-V3-DISCOVERY-CALIBRATION-FIX-002
 * Restored to 0.50 alongside the L2-as-cosine formula fix in
 * `cosineDistanceToCombinedScore`. The threshold was always correct (it's D3
 * ADR Q5's weak-band entry boundary); the formula was wrong, and lowering the
 * threshold under DEC-V3-DISCOVERY-CALIBRATION-FIX-001 was an incorrect fix
 * for the actual bug. With the corrected formula, correct top-1 hits score
 * above 0.50 in the natural [0, 1] band semantics that D3 ADR specifies.
 *
 * Cross-refs: DEC-V3-DISCOVERY-D5-001 (Q1 threshold = 0.50), DEC-V3-DISCOVERY-D3-001
 *   (band boundaries), DEC-V3-DISCOVERY-CALIBRATION-FIX-002 (formula fix in
 *   cosineDistanceToCombinedScore), DEC-V3-INITIATIVE-002 (gate criteria).
 */
export const M1_HIT_THRESHOLD = 0.5;

// ---------------------------------------------------------------------------
// Per-query result type (intermediate computation)
// ---------------------------------------------------------------------------

/** Result of running a single BenchmarkEntry through the registry. */
export interface QueryResult {
  readonly entryId: string;
  readonly expectedAtom: string | null;
  readonly acceptableAtoms: readonly string[];
  /** combinedScore of top-1 result (0 if no results returned). */
  readonly top1Score: number;
  /** BlockMerkleRoot of top-1 result (null if no results returned). */
  readonly top1Atom: string | null;
  /** Band assigned to top-1 score. */
  readonly top1Band: ScoreBand;
  /** Whether top-1 is "correct": hash match or in acceptableAtoms. */
  readonly top1Correct: boolean;
  /** Rank of expectedAtom in results (1-based), or null if not found. */
  readonly expectedAtomRank: number | null;
  /** All results from findCandidatesByIntent (up to K). */
  readonly allAtoms: readonly string[];
}

// ---------------------------------------------------------------------------
// Corpus query runner
// ---------------------------------------------------------------------------

/**
 * Convert a BenchmarkEntry's query to the IntentQuery shape expected by
 * findCandidatesByIntent.
 */
function benchmarkQueryToIntentQuery(q: BenchmarkQueryCard): {
  behavior: string;
  inputs: ReadonlyArray<{ name: string; typeHint: string }>;
  outputs: ReadonlyArray<{ name: string; typeHint: string }>;
} {
  const inputs = (q.signature?.inputs ?? []).map((p) => ({
    name: p.name,
    typeHint: p.type,
  }));
  const outputs = (q.signature?.outputs ?? []).map((p) => ({
    name: p.name,
    typeHint: p.type,
  }));
  return { behavior: q.behavior, inputs, outputs };
}

/**
 * Convert a BenchmarkEntry's query to a QueryIntentCard for findCandidatesByQuery.
 *
 * @decision DEC-V3-DISCOVERY-EVAL-FIX-001
 * @title Symmetric query derivation in benchmark harness (H2 fix)
 * @status accepted
 * @rationale runBenchmarkEntries previously used findCandidatesByIntent which derives
 *   query text as `behavior + "\n" + params`. findCandidatesByQuery uses
 *   canonicalizeQueryText() which produces SpecYak-shaped canonical JSON — the same
 *   text-space as storeBlock's generateEmbedding(). Switching to findCandidatesByQuery
 *   eliminates the store/query text asymmetry (H2 from issue #299). All BenchmarkQueryCard
 *   fields (behavior, signature, guarantees, errorConditions) are mapped to the
 *   corresponding QueryIntentCard dimensions.
 */
function benchmarkQueryToQueryIntentCard(q: BenchmarkQueryCard, topK: number): QueryIntentCard {
  return {
    behavior: q.behavior,
    ...(q.signature !== undefined
      ? {
          signature: {
            inputs: q.signature.inputs?.map((p) => ({ name: p.name, type: p.type })),
            outputs: q.signature.outputs?.map((p) => ({ name: p.name, type: p.type })),
          },
        }
      : {}),
    ...(q.guarantees !== undefined && q.guarantees.length > 0
      ? { guarantees: q.guarantees as string[] }
      : {}),
    ...(q.errorConditions !== undefined && q.errorConditions.length > 0
      ? { errorConditions: q.errorConditions as string[] }
      : {}),
    topK,
  };
}

/**
 * Run all benchmark entries against the registry and return per-entry results.
 *
 * Uses findCandidatesByQuery (symmetric canonical text derivation) when available,
 * falling back to findCandidatesByIntent for backward compat with registries
 * opened without the v3 query pipeline.
 *
 * @decision DEC-V3-DISCOVERY-EVAL-FIX-001
 * @title Switch benchmark harness from findCandidatesByIntent to findCandidatesByQuery
 * @status accepted
 * @rationale findCandidatesByQuery uses canonicalizeQueryText() for symmetric embedding
 *   (same text-space as storeBlock), while findCandidatesByIntent uses the asymmetric
 *   behavior+params derivation. For the full-corpus semantic eval with a re-embedded
 *   registry, findCandidatesByQuery produces correct M2/M3/M4 measurements.
 *   findCandidatesByIntent is kept for the CI offline-provider path and existing tests.
 *
 * @param registry - The open Registry instance to query.
 * @param entries  - The benchmark corpus entries.
 * @param topK     - How many candidates to retrieve (default 10, matching D2 default).
 */
export async function runBenchmarkEntries(
  registry: Registry,
  entries: readonly BenchmarkEntry[],
  topK = 10,
): Promise<readonly QueryResult[]> {
  const results: QueryResult[] = [];

  for (const entry of entries) {
    // Use findCandidatesByQuery (symmetric) when the registry supports it.
    // findCandidatesByQuery returns QueryCandidate[] with combinedScore already computed
    // (same 1-d²/4 formula as cosineDistanceToCombinedScore, computed inside storage.ts).
    const card = benchmarkQueryToQueryIntentCard(entry.query, topK);
    const queryResult = await registry.findCandidatesByQuery(card);
    const candidates = queryResult.candidates;

    const allAtoms = candidates.map((c) => c.block.blockMerkleRoot as string);
    const top1 = candidates[0];

    // QueryCandidate already has combinedScore; use it directly (avoids double-conversion).
    const top1Score = top1 !== undefined ? top1.combinedScore : 0;
    const top1Atom = top1 !== undefined ? (top1.block.blockMerkleRoot as string) : null;
    const top1Band = assignScoreBand(top1Score);

    const acceptableAtoms = entry.acceptableAtoms ?? [];
    const allCorrect =
      entry.expectedAtom !== null ? [entry.expectedAtom, ...acceptableAtoms] : acceptableAtoms;

    const top1Correct = top1Atom !== null && allCorrect.length > 0 && allCorrect.includes(top1Atom);

    // Find expectedAtom rank (1-based)
    let expectedAtomRank: number | null = null;
    if (entry.expectedAtom !== null) {
      const idx = allAtoms.indexOf(entry.expectedAtom);
      if (idx === -1 && acceptableAtoms.length > 0) {
        // Check if any acceptable atom appears in results
        for (const alt of acceptableAtoms) {
          const altIdx = allAtoms.indexOf(alt);
          if (altIdx !== -1 && (expectedAtomRank === null || altIdx + 1 < expectedAtomRank)) {
            expectedAtomRank = altIdx + 1;
          }
        }
      } else if (idx !== -1) {
        expectedAtomRank = idx + 1;
      }
    }

    results.push({
      entryId: entry.id,
      expectedAtom: entry.expectedAtom,
      acceptableAtoms,
      top1Score,
      top1Atom,
      top1Band,
      top1Correct,
      expectedAtomRank,
      allAtoms,
    });
  }

  return results;
}

// ---------------------------------------------------------------------------
// M1: Hit rate
// ---------------------------------------------------------------------------

/**
 * M1 — Hit rate: % of queries where top-1 combinedScore >= M1_HIT_THRESHOLD.
 *
 * Per D5 ADR Q1 (amended by DEC-V3-DISCOVERY-CALIBRATION-FIX-001):
 * threshold is M1_HIT_THRESHOLD (0.40, calibrated from empirical distance analysis).
 * ALL entries are included (including negative-space entries with expectedAtom=null).
 * A negative-space entry where top-1 scores >= M1_HIT_THRESHOLD still counts as a
 * "hit" (false hit). Per ADR Q1, M1 measures ALL queries including negative-space ones.
 * Target: >= 0.80.
 *
 * @param results - Per-query results from runBenchmarkEntries.
 * @returns Hit rate in [0, 1].
 */
export function computeHitRate(results: readonly QueryResult[]): number {
  if (results.length === 0) return 0;
  const hits = results.filter((r) => r.top1Score >= M1_HIT_THRESHOLD).length;
  return hits / results.length;
}

/**
 * Return the top-N entries contributing most to hit-rate failure
 * (those with the lowest top1Score). Used for CI diagnostics per D5 ADR Q6.
 */
export function worstHitRateEntries(
  results: readonly QueryResult[],
  n = 3,
): readonly QueryResult[] {
  return [...results].sort((a, b) => a.top1Score - b.top1Score).slice(0, n);
}

// ---------------------------------------------------------------------------
// M2: Precision@1
// ---------------------------------------------------------------------------

/**
 * M2 — Precision@1: % of queries where top-1 hash matches expectedAtom.
 *
 * Per D5 ADR Q1: "% of queries where top-1 candidate's BlockMerkleRoot equals expectedAtom".
 * Only entries with expectedAtom !== null are included (negative-space entries are skipped).
 * Target: >= 0.70.
 *
 * @param results - Per-query results from runBenchmarkEntries.
 * @returns Precision@1 in [0, 1], or 0 if no eligible entries.
 */
export function computePrecisionAt1(results: readonly QueryResult[]): number {
  const eligible = results.filter((r) => r.expectedAtom !== null);
  if (eligible.length === 0) return 0;
  const correct = eligible.filter((r) => r.top1Correct).length;
  return correct / eligible.length;
}

/**
 * Return the top-N entries contributing most to precision@1 failure
 * (eligible entries where top-1 was wrong, sorted by top1Score ascending).
 */
export function worstPrecisionAt1Entries(
  results: readonly QueryResult[],
  n = 3,
): readonly QueryResult[] {
  return results
    .filter((r) => r.expectedAtom !== null && !r.top1Correct)
    .sort((a, b) => a.top1Score - b.top1Score)
    .slice(0, n);
}

// ---------------------------------------------------------------------------
// M3: Recall@K
// ---------------------------------------------------------------------------

/**
 * M3 — Recall@K: % of queries where expectedAtom is in top-K candidates.
 *
 * Per D5 ADR Q1: "% of queries where expectedAtom is in top-10 candidates".
 * Only entries with expectedAtom !== null are included.
 * K should match topK used in runBenchmarkEntries (default 10).
 * Target: >= 0.90.
 *
 * @param results - Per-query results from runBenchmarkEntries.
 * @returns Recall@K in [0, 1], or 0 if no eligible entries.
 */
export function computeRecallAtK(results: readonly QueryResult[]): number {
  const eligible = results.filter((r) => r.expectedAtom !== null);
  if (eligible.length === 0) return 0;
  const found = eligible.filter((r) => r.expectedAtomRank !== null).length;
  return found / eligible.length;
}

/**
 * Return the top-N entries contributing most to recall failure
 * (eligible entries where expectedAtom was not in top-K, sorted by top1Score ascending).
 */
export function worstRecallEntries(results: readonly QueryResult[], n = 3): readonly QueryResult[] {
  return results
    .filter((r) => r.expectedAtom !== null && r.expectedAtomRank === null)
    .sort((a, b) => a.top1Score - b.top1Score)
    .slice(0, n);
}

// ---------------------------------------------------------------------------
// M4: MRR (Mean Reciprocal Rank)
// ---------------------------------------------------------------------------

/**
 * M4 — MRR: mean of 1/rank where rank is the position of expectedAtom in results.
 *
 * Per D5 ADR Q1: "mean of 1/rank where rank is the position of expectedAtom in the result
 * list, or 0 if absent". Only entries with expectedAtom !== null are included.
 * Target: >= 0.70.
 *
 * @param results - Per-query results from runBenchmarkEntries.
 * @returns MRR in [0, 1], or 0 if no eligible entries.
 */
export function computeMRR(results: readonly QueryResult[]): number {
  const eligible = results.filter((r) => r.expectedAtom !== null);
  if (eligible.length === 0) return 0;
  const sum = eligible.reduce((acc, r) => {
    const rank = r.expectedAtomRank;
    return acc + (rank !== null ? 1 / rank : 0);
  }, 0);
  return sum / eligible.length;
}

/**
 * Return the top-N entries contributing most to MRR failure
 * (eligible entries with worst per-entry RR, i.e. not found or low rank).
 */
export function worstMRREntries(results: readonly QueryResult[], n = 3): readonly QueryResult[] {
  return results
    .filter((r) => r.expectedAtom !== null)
    .sort((a, b) => {
      const rrA = a.expectedAtomRank !== null ? 1 / a.expectedAtomRank : 0;
      const rrB = b.expectedAtomRank !== null ? 1 / b.expectedAtomRank : 0;
      return rrA - rrB;
    })
    .slice(0, n);
}

// ---------------------------------------------------------------------------
// M5: Score calibration error (per-band Brier)
// ---------------------------------------------------------------------------

/** Per-band calibration data. */
export interface BandCalibrationData {
  /** Number of queries whose top-1 fell in this band. */
  readonly N: number;
  /** Number of those queries that were also "correct" (top-1 hash match). */
  readonly correct: number;
  /** Observed precision in this band: correct / N. Null if N=0. */
  readonly P: number | null;
  /** Band midpoint as defined in D5 ADR Q4. */
  readonly midpoint: number;
  /** Squared deviation from midpoint: (P - midpoint)^2. Null if N=0. */
  readonly brier: number | null;
}

/** Per-band Brier results for M5. */
export interface BrierPerBand {
  readonly strong: BandCalibrationData;
  readonly confident: BandCalibrationData;
  readonly weak: BandCalibrationData;
  readonly poor: BandCalibrationData;
}

/**
 * M5 — Score calibration error: Brier score per D3 band.
 *
 * Per D5 ADR Q1 + Q4: for each band, compute (P_b - m_b)^2 where P_b is the
 * observed precision in that band and m_b is the band midpoint. Returns null
 * for empty bands (N=0). The target is each err_b < 0.10.
 *
 * "Correct" for calibration = same predicate as M2 (top-1 hash match or in acceptableAtoms).
 * Entries with expectedAtom=null are NOT excluded — they cannot be "correct"
 * (null expectedAtom means no correct atom), so they contribute to the "incorrect" count.
 *
 * Per D5 ADR Q4: "If N_b = 0 for any band, that band contributes 0 to the calibration error
 * and is reported as 'no data'". Callers should warn when N=0.
 *
 * @param results - Per-query results from runBenchmarkEntries.
 * @returns Per-band calibration data.
 */
export function computeBrierPerBand(results: readonly QueryResult[]): BrierPerBand {
  const bandCounts: Record<ScoreBand, { N: number; correct: number }> = {
    strong: { N: 0, correct: 0 },
    confident: { N: 0, correct: 0 },
    weak: { N: 0, correct: 0 },
    poor: { N: 0, correct: 0 },
  };

  for (const r of results) {
    const band = r.top1Band;
    const counts = bandCounts[band];
    counts.N++;
    // "correct" = top-1 hash match. For null expectedAtom, top1Correct is always false.
    if (r.top1Correct) counts.correct++;
  }

  function buildData(band: ScoreBand): BandCalibrationData {
    const { N, correct } = bandCounts[band];
    const midpoint = BAND_MIDPOINTS[band];
    if (N === 0) {
      return { N: 0, correct: 0, P: null, midpoint, brier: null };
    }
    const P = correct / N;
    const brier = (P - midpoint) ** 2;
    return { N, correct, P, midpoint, brier };
  }

  return {
    strong: buildData("strong"),
    confident: buildData("confident"),
    weak: buildData("weak"),
    poor: buildData("poor"),
  };
}

// ---------------------------------------------------------------------------
// Reliability diagram artifact (D5 ADR Q4)
// ---------------------------------------------------------------------------

/** The reliability diagram artifact format (Q4 of D5 ADR). */
export interface ReliabilityDiagram {
  readonly corpus: string;
  readonly head_sha: string;
  readonly generated_at: string;
  readonly provider: string;
  readonly bands: {
    readonly strong: BandCalibrationData;
    readonly confident: BandCalibrationData;
    readonly weak: BandCalibrationData;
    readonly poor: BandCalibrationData;
  };
}

/**
 * Compute the reliability diagram data structure for a corpus.
 *
 * @param corpusSource - The corpus source label (e.g. "seed-derived").
 * @param results      - Per-query results from runBenchmarkEntries.
 * @param headSha      - Git HEAD SHA at time of measurement.
 * @param provider     - Embedding provider modelId used.
 * @returns The ReliabilityDiagram artifact (ready to JSON-serialize).
 */
export function computeReliabilityDiagram(
  corpusSource: string,
  results: readonly QueryResult[],
  headSha: string,
  provider: string,
): ReliabilityDiagram {
  const brier = computeBrierPerBand(results);
  return {
    corpus: corpusSource,
    head_sha: headSha,
    generated_at: new Date().toISOString(),
    provider,
    bands: brier,
  };
}

// ---------------------------------------------------------------------------
// Baseline JSON artifact format
// ---------------------------------------------------------------------------

/** The baseline measurement artifact written to tmp/discovery-eval/. */
export interface BaselineMeasurement {
  readonly version: 1;
  readonly date: string;
  readonly head_sha: string;
  readonly provider: string;
  readonly corpus_source: string;
  readonly corpus_entries: number;
  /**
   * Which corpus subset was used for M5 computation.
   * "full" = all entries in the corpus (standardized by DEC-V3-DISCOVERY-CALIBRATION-FIX-001,
   * issue #255). Previously the live test used "seed-derived" while the JSON used "full",
   * producing inconsistent M5 values. Now always "full".
   */
  readonly m5_corpus: "full" | "seed-derived";
  readonly metrics: {
    readonly M1_hit_rate: number;
    readonly M1_target: 0.8;
    readonly M1_pass: boolean;
    readonly M2_precision_at_1: number;
    readonly M2_target: 0.7;
    readonly M2_pass: boolean;
    readonly M3_recall_at_10: number;
    readonly M3_target: 0.9;
    readonly M3_pass: boolean;
    readonly M4_mrr: number;
    readonly M4_target: 0.7;
    readonly M4_pass: boolean;
    readonly M5_brier_per_band: BrierPerBand;
    readonly M5_target: 0.1;
    readonly M5_pass: boolean;
  };
  readonly worst_entries: {
    readonly M1: readonly string[];
    readonly M2: readonly string[];
    readonly M3: readonly string[];
    readonly M4: readonly string[];
  };
  readonly provider_note?: string;
}

/**
 * Compute the full baseline measurement artifact for a corpus.
 */
export function computeBaseline(
  corpusSource: string,
  entries: readonly BenchmarkEntry[],
  results: readonly QueryResult[],
  headSha: string,
  provider: string,
  providerNote?: string,
): BaselineMeasurement {
  const M1 = computeHitRate(results);
  const M2 = computePrecisionAt1(results);
  const M3 = computeRecallAtK(results);
  const M4 = computeMRR(results);
  const M5 = computeBrierPerBand(results);

  // M5 passes if every non-empty band has brier < 0.10
  const M5pass = Object.values(M5).every((b) => b.brier === null || b.brier < 0.1);

  return {
    version: 1,
    date: new Date().toISOString().split("T")[0] ?? "unknown",
    head_sha: headSha,
    provider,
    corpus_source: corpusSource,
    corpus_entries: entries.length,
    m5_corpus: "full",
    metrics: {
      M1_hit_rate: M1,
      M1_target: 0.8,
      M1_pass: M1 >= 0.8,
      M2_precision_at_1: M2,
      M2_target: 0.7,
      M2_pass: M2 >= 0.7,
      M3_recall_at_10: M3,
      M3_target: 0.9,
      M3_pass: M3 >= 0.9,
      M4_mrr: M4,
      M4_target: 0.7,
      M4_pass: M4 >= 0.7,
      M5_brier_per_band: M5,
      M5_target: 0.1,
      M5_pass: M5pass,
    },
    worst_entries: {
      M1: worstHitRateEntries(results, 3).map((r) => r.entryId),
      M2: worstPrecisionAt1Entries(results, 3).map((r) => r.entryId),
      M3: worstRecallEntries(results, 3).map((r) => r.entryId),
      M4: worstMRREntries(results, 3).map((r) => r.entryId),
    },
    ...(providerNote !== undefined ? { provider_note: providerNote } : {}),
  };
}
