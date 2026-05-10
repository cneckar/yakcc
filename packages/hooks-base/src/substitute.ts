// SPDX-License-Identifier: MIT
/**
 * substitute.ts — Decide-to-substitute logic and substitution rendering (Phase 2).
 *
 * @decision DEC-HOOK-PHASE-2-001
 * @title Phase 2 substitution: decide logic, rendering, and import-path convention
 * @status accepted
 * @rationale
 *   Phase 2 extends the observe-only Phase 1 pipeline with actual code substitution.
 *   Three sub-decisions are captured here:
 *
 *   (A) IMPORT PATH CONVENTION: `@yakcc/atoms/<atomName>`
 *       Candidates are identified by their atom name extracted from the binding shape.
 *       The import path `@yakcc/atoms/<atomName>` is a well-known convention (similar
 *       to `@yakcc/contracts`, `@yakcc/registry`, etc.) that allows bundlers and the
 *       yakcc CLI to resolve atoms without a runtime registry lookup per import.
 *       Alternative (registry-relative path like `~/.yakcc/atoms/<hash>.js`) was
 *       rejected because:
 *       (a) It ties the import to a local file-system layout that varies by machine.
 *       (b) It breaks standard TypeScript module resolution.
 *       (c) It cannot be statically analyzed by the project's tsconfig.
 *       The `@yakcc/atoms/` prefix is the approved atom distribution channel for v0.5+.
 *       Cross-reference: DEC-HOOK-LAYER-001 (parent), DEC-V3-DISCOVERY-D2-001 (auto-accept).
 *
 *   (B) BINDING-EXTRACTION STRATEGY (for this module):
 *       This module's renderSubstitution() accepts a pre-extracted BindingShape
 *       (from extractBindingShape() in @yakcc/ir). This separation keeps rendering
 *       pure and independently testable. renderSubstitution() does NOT call ts-morph
 *       directly — it just templates the already-extracted information.
 *       Cross-reference: ast-binding.ts in @yakcc/ir.
 *
 *   (C) SUBSTITUTION INVOCATION POLICY: every Edit/Write/MultiEdit call
 *       When a tool call intercepts an emission, substitution is attempted for every
 *       `Edit`, `Write`, and `MultiEdit` tool. We do NOT use a heuristic pre-filter
 *       (e.g. "only attempt if intent text contains a known keyword") because:
 *       (a) Pre-filters introduce false negatives (missed substitutions) that are
 *           harder to measure and fix than false positives.
 *       (b) The D-HOOK-3 latency budget (≤200ms) is enforced by fallthrough, not by
 *           skipping substitution attempts.
 *       The escape hatch `YAKCC_HOOK_DISABLE_SUBSTITUTE=1` is the per-session override.
 *
 *   Cross-reference:
 *     DEC-HOOK-LAYER-001 (D-HOOK-2 tool-call rewrite, D-HOOK-3 latency)
 *     DEC-V3-DISCOVERY-D2-001 (auto-accept rule: top-1 > 0.85 AND gap > 0.15)
 *     DEC-V3-DISCOVERY-D3-001 (cornerstone #4: cosine alone never triggers substitution;
 *       the structural filter is binary — this module's combinedScore uses the CORRECTED
 *       formula post DEC-V3-DISCOVERY-CALIBRATION-FIX-002: combinedScore = 1 - d²/4)
 */

import type { CandidateMatch } from "@yakcc/registry";

// ---------------------------------------------------------------------------
// Score constants — D2 auto-accept thresholds
// ---------------------------------------------------------------------------

/**
 * D2 auto-accept rule: top-1 combinedScore must exceed this threshold.
 * Defined in DEC-V3-DISCOVERY-D2-001 as 0.85.
 */
export const AUTO_ACCEPT_SCORE_THRESHOLD = 0.85;

/**
 * D2 auto-accept rule: gap between top-1 and top-2 combinedScore must exceed this.
 * Defined in DEC-V3-DISCOVERY-D2-001 as 0.15.
 */
export const AUTO_ACCEPT_GAP_THRESHOLD = 0.15;

// ---------------------------------------------------------------------------
// Score conversion — L2 distance to combinedScore
// ---------------------------------------------------------------------------

/**
 * Convert a CandidateMatch array's cosineDistance values to combinedScore values.
 *
 * @decision DEC-V3-DISCOVERY-CALIBRATION-FIX-002 (cross-reference)
 * sqlite-vec returns L2 Euclidean distance, not cosine distance. The field is
 * named `cosineDistance` throughout the codebase for historical reasons. The
 * correct formula for unit-normalized vectors is:
 *   combinedScore = 1 - L2²/4 = (1 + cos(θ)) / 2
 *
 * Range: combinedScore ∈ [0, 1]
 *   d = 0   → combinedScore = 1.0 (identical)
 *   d = √2  → combinedScore = 0.5 (orthogonal)
 *   d = 2   → combinedScore = 0.0 (antipodal)
 *
 * @param candidates - Array of CandidateMatch from findCandidatesByIntent().
 * @returns Array of combinedScore values in [0, 1], one per candidate, same order.
 */
export function candidatesToCombinedScores(candidates: readonly CandidateMatch[]): number[] {
  return candidates.map((c) => {
    const d = c.cosineDistance;
    return Math.max(0, Math.min(1, 1 - (d * d) / 4));
  });
}

// ---------------------------------------------------------------------------
// Decide-to-substitute logic — D2 auto-accept rule
// ---------------------------------------------------------------------------

/**
 * Result of decideToSubstitute().
 *
 * substitute=false: fall through to original code (Phase 1 passthrough behaviour).
 * substitute=true:  top-1 candidate meets D2 thresholds; atomHash is the
 *                   CandidateMatch.block.blockMerkleRoot of the winning candidate.
 */
export type SubstituteDecision =
  | { readonly substitute: false }
  | { readonly substitute: true; readonly atomHash: string; readonly top1Score: number; readonly top1Gap: number };

/**
 * Apply D2's auto-accept rule to a ranked candidate list.
 *
 * Implements the rule from DEC-V3-DISCOVERY-D2-001:
 *   Substitute if and only if:
 *     1. candidates[0].combinedScore > AUTO_ACCEPT_SCORE_THRESHOLD (0.85)
 *     2. gap(top-1, top-2) > AUTO_ACCEPT_GAP_THRESHOLD (0.15)
 *        where gap = top1Score - top2Score (0 if no top-2 candidate).
 *        NOTE: when there is no top-2, gap = top1Score (compared against 0), which
 *        is always > 0.15 when top1Score > 0.85 — a single strong candidate auto-accepts.
 *
 * @decision DEC-HOOK-PHASE-2-001 (B): cosine alone never triggers substitution.
 *   Candidates reaching this function have already passed the structural filter
 *   (rerank="structural" in executeRegistryQuery). The combinedScore here is the
 *   semantic similarity component; the structural gate is binary (DEC-V3-DISCOVERY-D3-001
 *   cornerstone #4). Only candidates that cleared the structural filter are eligible.
 *
 * @param candidates - Ordered array of CandidateMatch from findCandidatesByIntent()
 *                     with rerank="structural". Order: best first (ascending cosineDistance
 *                     or descending combined rank if structural rerank was applied).
 * @returns SubstituteDecision.
 */
export function decideToSubstitute(candidates: readonly CandidateMatch[]): SubstituteDecision {
  if (candidates.length === 0) {
    return { substitute: false };
  }

  const scores = candidatesToCombinedScores(candidates);
  const top1Score = scores[0] ?? 0;

  // D2 condition 1: top-1 must be above the score threshold.
  if (top1Score <= AUTO_ACCEPT_SCORE_THRESHOLD) {
    return { substitute: false };
  }

  // D2 condition 2: gap to top-2 must be above the gap threshold.
  // When there is no top-2, gap = top1Score (distance to 0).
  const top2Score = scores[1] ?? 0;
  const gap = top1Score - top2Score;
  if (gap <= AUTO_ACCEPT_GAP_THRESHOLD) {
    return { substitute: false };
  }

  const best = candidates[0];
  if (best === undefined) {
    return { substitute: false };
  }

  return {
    substitute: true,
    atomHash: best.block.blockMerkleRoot,
    top1Score,
    top1Gap: gap,
  };
}

// ---------------------------------------------------------------------------
// BindingShape — input to renderSubstitution()
// ---------------------------------------------------------------------------

/**
 * The extracted binding shape from an agent-emitted code snippet.
 * Produced by extractBindingShape() in @yakcc/ir.
 *
 * atomName is the function name from the original call expression — it becomes
 * the named import and the import path segment.
 */
export interface BindingShape {
  /** Variable name in the binding: `const <name> = fn(...)`. */
  readonly name: string;
  /** Arguments as source-text strings: `fn(<args[0]>, <args[1]>, ...)`. */
  readonly args: readonly string[];
  /** Function name from the original call: `const x = <atomName>(...)`. */
  readonly atomName: string;
}

// ---------------------------------------------------------------------------
// Substitution rendering
// ---------------------------------------------------------------------------

/**
 * Generate the substituted source text for a registry atom.
 *
 * Produces a two-line fragment:
 *   import { <atomName> } from "@yakcc/atoms/<atomName>";
 *   const <name> = <atomName>(<args...>);
 *
 * @decision DEC-HOOK-PHASE-2-001 (A): import path convention
 *   The import path is `@yakcc/atoms/<atomName>`. This is the official yakcc atom
 *   distribution channel. See the module-level @decision for full rationale.
 *
 * @param atomHash      - BlockMerkleRoot of the substituted atom (used for telemetry;
 *                        NOT included in the rendered output — the import path is
 *                        derived from atomName, not the content hash).
 * @param _originalCode - The agent's original code (kept for telemetry and future
 *                        diff-based verification; not used in rendering today).
 * @param binding       - Extracted binding shape from the original code.
 * @returns Substituted source text (import + binding statement).
 */
export function renderSubstitution(
  atomHash: string,
  _originalCode: string,
  binding: BindingShape,
): string {
  // atomHash is intentionally unused in the rendered output (it drives telemetry).
  // The rendered code uses atomName for the import path per DEC-HOOK-PHASE-2-001(A).
  void atomHash;

  const { name, args, atomName } = binding;
  const importPath = `@yakcc/atoms/${atomName}`;
  const argList = args.join(", ");

  const importLine = `import { ${atomName} } from "${importPath}";`;
  const bindingLine = `const ${name} = ${atomName}(${argList});`;

  return `${importLine}\n${bindingLine}`;
}

// ---------------------------------------------------------------------------
// executeSubstitution — full wired flow (L2)
// ---------------------------------------------------------------------------

/**
 * Result of executeSubstitution().
 *
 * substituted=false: fall through to original code unchanged.
 * substituted=true:  substitutedCode contains the rendered substitution;
 *                    atomHash, top1Score, top1Gap are for telemetry.
 */
export type SubstitutionResult =
  | {
      readonly substituted: false;
      /** Reason for not substituting — aids telemetry and debugging. */
      readonly reason: "no-candidates" | "score-below-threshold" | "gap-too-small" | "binding-extract-failed" | "disabled";
    }
  | {
      readonly substituted: true;
      /** The fully rendered substitution text (import + binding). */
      readonly substitutedCode: string;
      /** BlockMerkleRoot of the substituted atom. */
      readonly atomHash: string;
      /** combinedScore of the top-1 candidate. */
      readonly top1Score: number;
      /** Gap between top-1 and top-2 combinedScore. */
      readonly top1Gap: number;
    };

/**
 * Execute the full substitution pipeline: decide → extract binding → render.
 *
 * This is the single entry point that wires together:
 *   1. decideToSubstitute(candidates) — D2 auto-accept rule
 *   2. extractBindingShape(originalCode) — AST binding extraction via ts-morph
 *   3. renderSubstitution(atomHash, originalCode, binding) — import + call generation
 *
 * Returns substituted=false when any stage fails to produce a result, preserving
 * the Phase 1 observe-don't-mutate fallback path.
 *
 * The YAKCC_HOOK_DISABLE_SUBSTITUTE=1 env var bypasses substitution entirely
 * (soft-launch escape hatch per #217 spec, DEC-HOOK-PHASE-2-001-C).
 *
 * @param candidates   - Ordered candidates from findCandidatesByIntent().
 * @param originalCode - The agent's emitted code (single declaration snippet).
 * @returns SubstitutionResult.
 */
export async function executeSubstitution(
  candidates: readonly CandidateMatch[],
  originalCode: string,
): Promise<SubstitutionResult> {
  // Soft-launch escape hatch — YAKCC_HOOK_DISABLE_SUBSTITUTE=1 bypasses all substitution.
  if (process.env.YAKCC_HOOK_DISABLE_SUBSTITUTE === "1") {
    return { substituted: false, reason: "disabled" };
  }

  // Step 1: D2 decide-to-substitute gate.
  const decision = decideToSubstitute(candidates);
  if (!decision.substitute) {
    if (candidates.length === 0) {
      return { substituted: false, reason: "no-candidates" };
    }
    const scores = candidatesToCombinedScores(candidates);
    const top1 = scores[0] ?? 0;
    if (top1 <= AUTO_ACCEPT_SCORE_THRESHOLD) {
      return { substituted: false, reason: "score-below-threshold" };
    }
    return { substituted: false, reason: "gap-too-small" };
  }

  // Step 2: Extract the binding shape from the original code.
  // Lazy-import to avoid circular references; @yakcc/ir is a peer package.
  const { extractBindingShape } = await import("@yakcc/ir");
  const binding = extractBindingShape(originalCode);
  if (binding === null) {
    return { substituted: false, reason: "binding-extract-failed" };
  }

  // Step 3: Render the substitution.
  const substitutedCode = renderSubstitution(decision.atomHash, originalCode, binding);

  return {
    substituted: true,
    substitutedCode,
    atomHash: decision.atomHash,
    top1Score: decision.top1Score,
    top1Gap: decision.top1Gap,
  };
}
