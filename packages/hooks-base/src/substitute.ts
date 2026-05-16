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

import type { SpecYak } from "@yakcc/contracts";
import type { CandidateMatch } from "@yakcc/registry";
import { enforceAtomSizeRatio, computeAtomComplexity, computeNeedComplexity } from "./atom-size-ratio.js";
import { getEnforcementConfig } from "./enforcement-config.js";
import type { DescentBypassWarning } from "./enforcement-types.js";

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

/**
 * Float-tolerance for the gap-threshold comparison.
 *
 * @decision DEC-HOOKS-BASE-SUBSTITUTE-SMALL-GAP-001
 * @title Float-tolerance buffer for AUTO_ACCEPT_GAP_THRESHOLD boundary
 * @status accepted
 * @rationale
 *   IEEE 754 double-precision arithmetic produces small representation errors
 *   on subtractions like `0.90 - 0.75` (evaluates to `0.15000000000000002`,
 *   one ULP above the mathematical 0.15). The D2 design intent is that gaps
 *   at the threshold boundary should NOT substitute (rejection is inclusive
 *   of the boundary). Without a tolerance, exact-boundary cases slip past
 *   the rejection check by ~2e-17 and incorrectly substitute. A 1e-9
 *   tolerance is ~7 orders of magnitude above Number.EPSILON and ~7 orders
 *   below the smallest meaningful score difference (combined scores are
 *   2 decimal places of practical resolution). This eliminates the IEEE
 *   boundary artifact without changing operator-observable behavior.
 *   Issue #342. Property: prop_decideToSubstitute_small_gap_is_false.
 */
const GAP_FLOAT_TOLERANCE = 1e-9;

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
  if (gap <= AUTO_ACCEPT_GAP_THRESHOLD + GAP_FLOAT_TOLERANCE) {
    // DEC-HOOKS-BASE-SUBSTITUTE-SMALL-GAP-001: boundary inclusivity under IEEE 754.
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
// Behavior-summary normalization — DEC-HOOK-BEHAVIOR-SUMMARY-EMIT-001
// ---------------------------------------------------------------------------

/**
 * Maximum rendered behavior-summary length, including ellipsis when truncated.
 * Chosen to keep the contract comment under ~200 chars even with long atom names
 * and guarantees — token-cost discipline per DEC-HOOK-PHASE-3-001.
 *
 * @decision DEC-HOOK-BEHAVIOR-SUMMARY-EMIT-001
 * @title Append normalized spec.behavior as inline trailer on contract comment
 * @status accepted
 * @rationale
 *   B5-coherence 2026-05-14 identified opaque-hash as the dominant failure mode
 *   (36/37 of 156 turns). The LLM treats yakcc:<hash> as a token with no semantic
 *   meaning in subsequent turns. Appending a normalized behavior summary binds
 *   the behavior anchor to the same comment line as the atom name and hash,
 *   enabling multi-turn LLM coherence without restructuring the existing token
 *   boundary (yakcc:<hash> remains intact and contiguous). Capped at 80 chars
 *   for token-cost discipline.
 *   Cross-reference: #610, DEC-HOOK-PHASE-3-001.
 */
const MAX_BEHAVIOR_SUMMARY_LENGTH = 80;

/**
 * Normalize and truncate spec.behavior for inline rendering.
 *
 * Returns null when the behavior field is missing, empty after trim, or only
 * whitespace — caller must omit the trailer in that case.
 *
 * Normalization steps (applied in order):
 *   1. Replace embedded newlines (\r, \n) with a single space (defense-in-depth;
 *      upstream canonicalization already prevents newlines, but we never trust it).
 *   2. Collapse runs of whitespace to a single space.
 *   3. Trim leading/trailing whitespace.
 *   4. If length > MAX_BEHAVIOR_SUMMARY_LENGTH, truncate to 77 chars + "...".
 *
 * @decision DEC-HOOK-BEHAVIOR-SUMMARY-EMIT-001
 * @param raw - The raw spec.behavior string (may be undefined).
 * @returns Normalized behavior summary, or null when the field is absent/empty.
 */
export function normalizeBehaviorForEmit(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  const collapsed = raw.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
  if (collapsed.length === 0) return null;
  if (collapsed.length <= MAX_BEHAVIOR_SUMMARY_LENGTH) return collapsed;
  return `${collapsed.slice(0, MAX_BEHAVIOR_SUMMARY_LENGTH - 3)}...`;
}

// ---------------------------------------------------------------------------
// Contract comment rendering — Phase 3 D-HOOK-4
// ---------------------------------------------------------------------------

/**
 * @decision DEC-HOOK-PHASE-3-001
 * @title Phase 3 contract comment: format, placement, and content selection
 * @status accepted
 * @rationale
 *   D-HOOK-4 specifies that the hook prepends an inline contract comment above
 *   the atom import statement so the LLM can reason about the substitution in
 *   subsequent turns without an additional tool call.
 *
 *   FORMAT CHOICE (`// @atom <name> (<signature>; <key-guarantee>) — yakcc:<hash[:8]>`):
 *   The format is intentionally compact (~60–120 chars) to minimise context-window
 *   cost while providing the minimum information for routine multi-turn coherence:
 *     - `<name>`: immediate identifier — the LLM can reference it without guessing.
 *     - `<signature>`: type-level summary (`(in1, in2) => out`) — tells the LLM
 *       whether the atom's I/O contract matches its intended usage without requiring
 *       a `yakcc_resolve` call.
 *     - `<key-guarantee>`: FIRST guarantee in canonical order — the single most
 *       salient behavioral commitment. Emitting all guarantees would bloat the
 *       comment; emitting none would leave the LLM unable to reason about
 *       correctness. "First in canonical order" is deterministic and operator-
 *       controllable: the spec author controls ordering.
 *     - `yakcc:<hash[:8]>`: uniquely identifies the block for `yakcc_resolve`
 *       lookups; 8 hex chars provides 2^32 collision resistance — sufficient
 *       for a per-session reference, not a permanent identity. The full root is
 *       in telemetry and can be retrieved via `yakcc_resolve` if needed.
 *
 *   WHY OMIT THE PARENTHETICAL WHEN GUARANTEES IS EMPTY:
 *   Rendering `// @atom name (() => out; )` with a trailing semicolon would be
 *   syntactically surprising and regex-unfriendly (B5 failure mode: brittle parsing
 *   in agent prompts). When guarantees[] is empty or absent, the semicolon and
 *   key-guarantee are omitted entirely, yielding `// @atom name (() => out)`.
 *
 *   WHY ABOVE-IMPORT (NOT ABOVE CALL SITE):
 *   TS convention documents import-level bindings at the import declaration, not
 *   at each call site. Placing the comment above the import makes it visible to
 *   any reader scanning for where `atomName` is introduced, matches JSDoc placement
 *   conventions, and avoids duplicating the comment across multiple call sites.
 *
 *   Cross-reference: DEC-HOOK-LAYER-001 D-HOOK-4, DEC-V3-DISCOVERY-D4-001.
 */

/**
 * Render the D-HOOK-4 inline contract comment for a substituted atom.
 *
 * Format: `// @atom <atomName> (<signature>; <key-guarantee>) — yakcc:<hash[:8]>`
 * When `spec.guarantees` is empty or absent, the `; <key-guarantee>` portion
 * is omitted to avoid a trailing-semicolon artifact.
 *
 * @param atomName - The atom's function name (from BindingShape.atomName).
 * @param atomHash - Full BlockMerkleRoot; only the first 8 chars are emitted.
 * @param spec     - The atom's SpecYak contract (provides inputs, outputs, guarantees).
 * @returns Single-line comment string (no trailing newline).
 */
export function renderContractComment(atomName: string, atomHash: string, spec: SpecYak): string {
  // Build <signature>: input types joined by ", " + " => " + first output type.
  // Zero inputs: rendered as "()" before "=>" so the result is "() => out".
  const inputParts = spec.inputs.map((p) => p.type);
  const inputTypes = inputParts.length === 0 ? "()" : inputParts.join(", ");
  const outputType = spec.outputs[0]?.type ?? "void";
  const signature = `${inputTypes} => ${outputType}`;

  // Build <key-guarantee>: first guarantee description, or absent.
  const firstGuarantee = spec.guarantees?.[0]?.description;
  const parenthetical = firstGuarantee !== undefined && firstGuarantee.length > 0
    ? `(${signature}; ${firstGuarantee})`
    : `(${signature})`;

  // Truncate hash to first 8 characters per DEC-HOOK-PHASE-3-001.
  const shortHash = atomHash.slice(0, 8);

  const base = `// @atom ${atomName} ${parenthetical} — yakcc:${shortHash}`;

  // Append normalized behavior summary when present (DEC-HOOK-BEHAVIOR-SUMMARY-EMIT-001).
  // The yakcc:<hash> token boundary is preserved — we only add trailing text inside the comment.
  const behavior = normalizeBehaviorForEmit(spec.behavior);
  if (behavior === null) return base;
  return `${base} — ${behavior}`;
}

// ---------------------------------------------------------------------------
// Substitution rendering
// ---------------------------------------------------------------------------

/**
 * Generate the substituted source text for a registry atom.
 *
 * When `spec` is provided (Phase 3), produces a three-line fragment:
 *   // @atom <atomName> (<signature>; <key-guarantee>) — yakcc:<hash[:8]>
 *   import { <atomName> } from "@yakcc/atoms/<atomName>";
 *   const <name> = <atomName>(<args...>);
 *
 * When `spec` is absent (Phase 2 backward-compat), produces the two-line fragment:
 *   import { <atomName> } from "@yakcc/atoms/<atomName>";
 *   const <name> = <atomName>(<args...>);
 *
 * @decision DEC-HOOK-PHASE-2-001 (A): import path convention
 *   The import path is `@yakcc/atoms/<atomName>`. This is the official yakcc atom
 *   distribution channel. See the module-level @decision for full rationale.
 *
 * @decision DEC-HOOK-PHASE-3-001 (cross-reference)
 *   Contract comment is placed ABOVE the import, not above the call site.
 *   See renderContractComment() for full rationale.
 *
 * @param atomHash      - BlockMerkleRoot of the substituted atom (first 8 chars used
 *                        in the contract comment; full value retained for telemetry).
 * @param _originalCode - The agent's original code (kept for telemetry and future
 *                        diff-based verification; not used in rendering today).
 * @param binding       - Extracted binding shape from the original code.
 * @param spec          - Optional SpecYak contract data. When present, the D-HOOK-4
 *                        contract comment is prepended above the import line.
 *                        When absent, the output is the two-line Phase 2 fragment
 *                        (backward-compatible; callers that don't yet pass SpecYak
 *                        data continue to work unchanged).
 * @returns Substituted source text (contract comment if spec provided + import + binding).
 */
export function renderSubstitution(
  atomHash: string,
  _originalCode: string,
  binding: BindingShape,
  spec?: SpecYak | undefined,
): string {
  const { name, args, atomName } = binding;
  const importPath = `@yakcc/atoms/${atomName}`;
  const argList = args.join(", ");

  const importLine = `import { ${atomName} } from "${importPath}";`;
  const bindingLine = `const ${name} = ${atomName}(${argList});`;

  if (spec !== undefined) {
    const contractComment = renderContractComment(atomName, atomHash, spec);
    return `${contractComment}\n${importLine}\n${bindingLine}`;
  }

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
      readonly reason:
        | "no-candidates"
        | "score-below-threshold"
        | "gap-too-small"
        | "binding-extract-failed"
        | "disabled"
        | "atom-size-too-large"; // Layer 3 reject (DEC-HOOK-ENF-LAYER3-ATOM-SIZE-RATIO-001)
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
      /**
       * Layer 4 advisory warning (DEC-HOOK-ENF-LAYER4-DESCENT-TRACKING-001).
       *
       * Present when the substitution succeeded but the descent depth for the
       * winning candidate's binding was below minDepth and the intent did not
       * match any shallowAllowPattern. null when no warning was triggered or
       * when descent tracking is disabled.
       *
       * NON-BLOCKING: the substitution proceeds regardless of this field.
       * Callers should forward this to telemetry and may surface it to
       * observability tooling.
       */
      readonly descentBypassWarning: DescentBypassWarning | null;
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

  // Step 2: Layer 3 atom-size ratio gate (DEC-HOOK-ENF-LAYER3-ATOM-SIZE-RATIO-001).
  // Runs BETWEEN the D2 auto-accept gate AND renderSubstitution — the single plug
  // point per Layer 3 spec. Only runs when disableGate is false.
  const l3cfg = getEnforcementConfig().layer3;
  if (!l3cfg.disableGate) {
    const best = candidates[0];
    if (best !== undefined) {
      // Build AtomLike from the winning candidate's spec block.
      // specCanonicalBytes → SpecYak is attempted; on failure, use zero-complexity
      // proxy so the gate is conservative (does not reject on spec parse errors).
      let specForL3: SpecYak | undefined;
      try {
        const { validateSpecYak } = await import("@yakcc/contracts");
        const specJson = new TextDecoder().decode(best.block.specCanonicalBytes);
        specForL3 = validateSpecYak(JSON.parse(specJson));
      } catch {
        specForL3 = undefined;
      }

      const atomLike = {
        spec: specForL3 ?? { inputs: [], outputs: [], guarantees: [] } as unknown as SpecYak,
        // exportedSurface: number of named exports — v1 proxy: outputs.length.
        exportedSurface: specForL3?.outputs?.length ?? 0,
        // transitiveDeps: not yet exposed by @yakcc/registry; default 0 in v1.
        transitiveDeps: 0,
      };

      // Need-side analysis: derive from originalCode (simple token scan; full
      // ts-morph scan is deferred to v2 when the call-site AST is available).
      // v1 proxy: bindingsUsed = 1 (the caller uses the atom), statementCount =
      // number of semicolons + block-statements in originalCode (rough proxy).
      const statementCount = Math.max(1, (originalCode.match(/;/g) ?? []).length);
      const callSite = { bindingsUsed: 1, statementCount };

      const l3Result = enforceAtomSizeRatio(atomLike, callSite, l3cfg);
      if (l3Result.status === "atom-size-too-large") {
        return { substituted: false, reason: "atom-size-too-large" };
      }
    }
  }

  // Step 3: Extract the binding shape from the original code.
  // Lazy-import to avoid circular references; @yakcc/ir is a peer package.
  const { extractBindingShape } = await import("@yakcc/ir");
  const binding = extractBindingShape(originalCode);
  if (binding === null) {
    return { substituted: false, reason: "binding-extract-failed" };
  }

  // Step 4: Layer 4 — descent-depth advisory warning (DEC-HOOK-ENF-LAYER4-DESCENT-TRACKING-001).
  // Runs AFTER Layer 3 (which may reject) and BEFORE rendering. Advisory only: never rejects.
  // The binding name is the atomName from the extracted shape (most precise identifier).
  // WI-600 / DEC-HOOK-ENF-LAYER4-KEY-CANONICAL-001: descent-tracker.ts now canonicalizes keys
  // internally on atomName only ("binding::binding"), so the packageName passed here is ignored
  // in the actual storage key. Passing atomName as both packageName and binding is correct:
  // import-intercept records misses via recordMiss(moduleSpecifier, bindingName) but the
  // canonical key ignores moduleSpecifier. Both sides converge on "atomName::atomName".
  let descentBypassWarning: DescentBypassWarning | null = null;
  try {
    const l4cfg = getEnforcementConfig().layer4;
    if (!l4cfg.disableTracking) {
      const { getAdvisoryWarning } = await import("./descent-tracker.js");
      // Use atomName as the packageName proxy (v1). Future: derive from candidate block metadata.
      const packageName = binding.atomName;
      descentBypassWarning = getAdvisoryWarning(packageName, binding.atomName, originalCode, l4cfg);
    }
  } catch {
    // Layer 4 failure must not affect substitution (observe-don't-mutate).
    descentBypassWarning = null;
  }

  // Step 5: Attempt to recover SpecYak from the winning candidate's specCanonicalBytes.
  // specCanonicalBytes is a UTF-8-encoded canonical JSON blob (see canonicalize.ts).
  // If parsing/validation fails we fall through to the two-line Phase 2 rendering
  // (no contract comment) rather than failing the substitution entirely.
  let spec: SpecYak | undefined;
  const winningBlock = candidates[0]?.block;
  if (winningBlock !== undefined) {
    try {
      const { validateSpecYak } = await import("@yakcc/contracts");
      const specJson = new TextDecoder().decode(winningBlock.specCanonicalBytes);
      spec = validateSpecYak(JSON.parse(specJson));
    } catch {
      // Spec parse failure is non-fatal — Phase 2 two-line output is the fallback.
      spec = undefined;
    }
  }

  // Step 6: Render the substitution (with contract comment if spec was recovered).
  const substitutedCode = renderSubstitution(decision.atomHash, originalCode, binding, spec);

  return {
    substituted: true,
    substitutedCode,
    atomHash: decision.atomHash,
    top1Score: decision.top1Score,
    top1Gap: decision.top1Gap,
    descentBypassWarning,
  };
}
