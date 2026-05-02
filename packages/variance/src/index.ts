// SPDX-License-Identifier: MIT
// ---------------------------------------------------------------------------
// @decision DEC-VAR-001: 7-dimension framing reconciled to 5 canonical weights
// Status: proposed
// Rationale: The original planning surface described 7 qualitative dimensions.
// MASTER_PLAN.md §WI-011 reduces these to 5 measurable, weighted dimensions
// that map cleanly onto SpecYak fields. The remaining 2 were merged into
// "behavioral" to avoid phantom precision in weight tuning.
// ---------------------------------------------------------------------------
// @decision DEC-VAR-002: Star-topology rules — safety = ∩, behavioral = majority-vote, capability = ∪.
// Status: proposed
// Rationale: Safety must shrink to the intersection so no merged contract
// drops a precondition or loses a CWE clearance. Behavioral adopts majority
// vote so dominant correct postconditions survive without requiring unanimity.
// Capability takes the union so no required effect is silently elided.
// Empty-input is refused (RangeError) because zero-contributor merge is
// undefined under star-topology rules.
// ---------------------------------------------------------------------------
// @decision DEC-VAR-003: CWE_474_FAMILY is canonical; updates require governance review.
// Status: proposed
// Rationale: The CWE family table is a security-sensitive policy surface.
// Unilateral edits to the detect predicates could silently weaken security
// scoring. Updates must go through the authority registry and decision log.
// ---------------------------------------------------------------------------
// @decision DEC-VAR-004: Variance consumes SpecYak only; IntentCard → SpecYak translation lives in callers.
// Status: proposed
// Rationale: Keeping variance pure of IntentCard prevents a circular
// dependency on @yakcc/shave and maintains the leaf-package invariant.
// Callers (WI-012, WI-014) own the translation step.
// ---------------------------------------------------------------------------
// @decision DEC-VAR-005: At v0.7, behavior prose is weight-0 in behavioral dimension.
// Status: proposed
// Rationale: Prose comparison requires semantic similarity that cannot be
// computed without an embedding model. Variance is a pure-function leaf with
// no LLM/I/O access. Postcondition Jaccard provides a structural proxy.
// Behavior field is preserved in applyContractDesignRules tie-break output.
// ---------------------------------------------------------------------------

import type { SpecYak } from "@yakcc/contracts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type VarianceDimension =
  | "security"
  | "behavioral"
  | "error_handling"
  | "performance"
  | "interface";

export interface DimensionScores {
  readonly security: number;
  readonly behavioral: number;
  readonly error_handling: number;
  readonly performance: number;
  readonly interface: number;
}

export const DIMENSION_WEIGHTS: Readonly<Record<VarianceDimension, number>> = {
  security: 0.35,
  behavioral: 0.25,
  error_handling: 0.2,
  performance: 0.1,
  interface: 0.1,
};

export interface VarianceOptions {
  readonly weights?: Readonly<Record<VarianceDimension, number>>;
}

export interface VarianceResult {
  readonly score: number;
  readonly dimensions: DimensionScores;
  readonly weights: Readonly<Record<VarianceDimension, number>>;
}

export type CweId = `CWE-${number}`;

export interface CwePattern {
  readonly cwe: CweId;
  readonly title: string;
  readonly detect: (spec: SpecYak) => boolean;
}

export interface CweMapping {
  readonly cwesPresent: readonly CweId[];
  readonly cwesClear: readonly CweId[];
}

export interface MergedContract {
  readonly safety: {
    readonly preconditions: readonly string[];
    readonly invariants: readonly string[];
    readonly cweClear: readonly CweId[];
  };
  readonly behavioral: {
    readonly postconditions: readonly string[];
    readonly behavior?: string | undefined;
  };
  readonly capability: {
    readonly effects: readonly string[];
  };
  readonly source: {
    readonly contributorCount: number;
    readonly tieBreaks: readonly TieBreakRecord[];
  };
}

export interface TieBreakRecord {
  readonly field: string;
  readonly candidates: readonly string[];
  readonly resolution: "first_lexicographic" | "all_kept";
}

// ---------------------------------------------------------------------------
// Module-level weight invariant (asserted at load; never silenced)
// ---------------------------------------------------------------------------

const __weightSum = Object.values(DIMENSION_WEIGHTS).reduce((a, b) => a + b, 0);
if (Math.abs(__weightSum - 1.0) > 1e-9) {
  throw new Error(`DIMENSION_WEIGHTS must sum to 1.0 (got ${__weightSum})`);
}

// ---------------------------------------------------------------------------
// Internal utilities
// ---------------------------------------------------------------------------

/**
 * Normalize a string for Jaccard comparison:
 * lowercase, collapse whitespace, strip terminal punctuation.
 */
function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.;!?,]+$/, "");
}

/**
 * Jaccard similarity between two sets of strings.
 * Both-empty → 1.0 (perfect agreement on "nothing declared").
 */
function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 && b.size === 0) return 1.0;
  let intersectionSize = 0;
  for (const item of a) {
    if (b.has(item)) intersectionSize++;
  }
  const unionSize = a.size + b.size - intersectionSize;
  return unionSize === 0 ? 1.0 : intersectionSize / unionSize;
}

// ---------------------------------------------------------------------------
// CWE-474 family (DEC-VAR-003: canonical; governance review required for updates)
// ---------------------------------------------------------------------------
// Detection predicates are adapted to actual SpecYak fields (see spec-yak.ts):
//   - effects: readonly string[] — declared object-capability requirements
//   - preconditions: readonly string[] — input assertions
//   - postconditions: readonly string[] — output guarantees
//   - errorConditions?: ReadonlyArray<{description,errorType?}> — declared errors
//   - nonFunctional?.purity: string — "pure"|"io"|"stateful"|"nondeterministic"
// CWE-474: Use of Function with Inconsistent Implementations —
//   detected when effects are empty yet purity is not "pure", indicating
//   implementation-inconsistency risk (I/O disguised as pure).
// CWE-440: Expected Behavior Violation —
//   detected when postconditions are empty, i.e. no correctness guarantee declared.
// CWE-573: Improper Following of Specification by Caller —
//   detected when preconditions are empty, implying the caller has no
//   documented constraints to follow.
// CWE-684: Incorrect Provision of Specified Functionality —
//   detected when errorConditions are absent and preconditions are non-empty,
//   implying the block may reject inputs without documented error behavior.
// CWE-710: Improper Adherence to Coding Standards —
//   detected when no nonFunctional properties are declared, which weakens
//   auditability and standard adherence.
// ---------------------------------------------------------------------------

export const CWE_474_FAMILY: readonly CwePattern[] = [
  {
    cwe: "CWE-474",
    title: "Use of Function with Inconsistent Implementations",
    detect: (spec: SpecYak): boolean => {
      // Risk: effects are empty yet purity is not "pure", suggesting hidden I/O.
      const hasDeclaredEffects = spec.effects.length > 0;
      const claimsPure = spec.nonFunctional?.purity === "pure";
      // Present if: no effects declared AND not explicitly claiming purity.
      // A pure function with no effects is fine; an impure function with no
      // declared effects is a consistency risk.
      return !hasDeclaredEffects && !claimsPure;
    },
  },
  {
    cwe: "CWE-440",
    title: "Expected Behavior Violation",
    detect: (spec: SpecYak): boolean => {
      // Present if no postconditions are declared — no output guarantee exists.
      return spec.postconditions.length === 0;
    },
  },
  {
    cwe: "CWE-573",
    title: "Improper Following of Specification by Caller",
    detect: (spec: SpecYak): boolean => {
      // Present if no preconditions are declared — caller has no constraints.
      return spec.preconditions.length === 0;
    },
  },
  {
    cwe: "CWE-684",
    title: "Incorrect Provision of Specified Functionality",
    detect: (spec: SpecYak): boolean => {
      // Present if preconditions exist but no error behavior is documented.
      // The block can reject inputs but provides no documented error contract.
      const hasPreconditions = spec.preconditions.length > 0;
      const hasErrorConditions =
        spec.errorConditions !== undefined && spec.errorConditions.length > 0;
      return hasPreconditions && !hasErrorConditions;
    },
  },
  {
    cwe: "CWE-710",
    title: "Improper Adherence to Coding Standards",
    detect: (spec: SpecYak): boolean => {
      // Present if no nonFunctional properties are declared at all.
      return spec.nonFunctional === undefined;
    },
  },
] as const;

// ---------------------------------------------------------------------------
// Per-dimension scorers
// ---------------------------------------------------------------------------

/**
 * Security dimension: CWE-474 family overlap between canonical and candidate.
 *
 * Formula:
 *   present(s) = { c ∈ CWE_474_FAMILY : c.detect(s) }
 *   clear(s)   = CWE_474_FAMILY ∖ present(s)
 *   security   = (|present(c) ∩ present(d)| + |clear(c) ∩ clear(d)|) / |CWE_474_FAMILY|
 *
 * This measures agreement on which CWEs are present AND which are clear —
 * not absolute risk, but structural alignment between two specs.
 * (DEC-VAR-003: forbidden shortcut — must not score as 1 - present/total)
 */
function scoreSecurity(canonical: SpecYak, candidate: SpecYak): number {
  let overlapPresent = 0;
  let overlapClear = 0;
  for (const pattern of CWE_474_FAMILY) {
    const inCanonical = pattern.detect(canonical);
    const inCandidate = pattern.detect(candidate);
    if (inCanonical && inCandidate) overlapPresent++;
    if (!inCanonical && !inCandidate) overlapClear++;
  }
  return (overlapPresent + overlapClear) / CWE_474_FAMILY.length;
}

/**
 * Behavioral dimension: Jaccard similarity over normalized postconditions.
 *
 * Behavior prose (SpecYak.behavior) is excluded per DEC-VAR-005:
 * prose comparison requires semantic embedding (LLM) which is forbidden in
 * this leaf package.
 *
 * Both-empty → 1.0 (both declare no output guarantees; fully aligned).
 */
function scoreBehavioral(canonical: SpecYak, candidate: SpecYak): number {
  const a = new Set(canonical.postconditions.map(normalize));
  const b = new Set(candidate.postconditions.map(normalize));
  return jaccard(a, b);
}

/**
 * Error-handling dimension: Jaccard over normalized error descriptions,
 * with half-credit contribution from errorType.
 *
 * SpecYak.errorConditions is an optional v0-lift field. Policy when absent:
 * - Both absent → 1.0 (both declined to specify; fully aligned).
 * - One absent → 0.0 for that comparison side (one side declined the claim).
 *
 * When both present, score = 0.7 * jaccard(descriptions) + 0.3 * jaccard(types).
 * This weights description-level agreement more than type-label agreement.
 */
function scoreErrorHandling(canonical: SpecYak, candidate: SpecYak): number {
  const cErrs = canonical.errorConditions;
  const dErrs = candidate.errorConditions;

  // Both absent: both declined to specify error behavior. Perfect alignment.
  if ((cErrs === undefined || cErrs.length === 0) && (dErrs === undefined || dErrs.length === 0)) {
    return 1.0;
  }

  // One absent: one side declined. Score 0.0 — no basis for overlap.
  if (cErrs === undefined || cErrs.length === 0) return 0.0;
  if (dErrs === undefined || dErrs.length === 0) return 0.0;

  const descA = new Set(cErrs.map((e) => normalize(e.description)));
  const descB = new Set(dErrs.map((e) => normalize(e.description)));
  const descScore = jaccard(descA, descB);

  const typeA = new Set(
    cErrs.filter((e) => e.errorType !== undefined).map((e) => normalize(e.errorType as string)),
  );
  const typeB = new Set(
    dErrs.filter((e) => e.errorType !== undefined).map((e) => normalize(e.errorType as string)),
  );
  const typeScore = jaccard(typeA, typeB);

  return 0.7 * descScore + 0.3 * typeScore;
}

/**
 * Performance dimension: structural comparison of nonFunctional time/space claims.
 *
 * Policy for absent fields:
 * - Both spec.nonFunctional absent → 1.0 (both declined; fully aligned).
 * - One spec.nonFunctional absent → that side contributes 0 to time and space
 *   comparisons (one side declined to claim; the claim is unmatched).
 * - Within a present nonFunctional, absent time/space fields → 1.0 for that
 *   sub-comparison (both declining that sub-claim is perfect alignment).
 *
 * Score = 0.5 * timeScore + 0.5 * spaceScore.
 */
function scorePerformance(canonical: SpecYak, candidate: SpecYak): number {
  const cNF = canonical.nonFunctional;
  const dNF = candidate.nonFunctional;

  if (cNF === undefined && dNF === undefined) return 1.0;
  if (cNF === undefined || dNF === undefined) {
    // One side declined all non-functional claims. Both time and space are 0.
    return 0.0;
  }

  // Both nonFunctional present. Compare time and space claims.
  const timeScore = stringFieldMatch(cNF.time, dNF.time);
  const spaceScore = stringFieldMatch(cNF.space, dNF.space);
  return 0.5 * timeScore + 0.5 * spaceScore;
}

/**
 * Compare two optional string claims.
 * - Both absent → 1.0 (both declined; aligned).
 * - One absent → 0.0 (one side declined; not comparable).
 * - Both present → 1.0 if normalized strings match, else 0.0.
 */
function stringFieldMatch(a: string | undefined, b: string | undefined): number {
  if (a === undefined && b === undefined) return 1.0;
  if (a === undefined || b === undefined) return 0.0;
  return normalize(a) === normalize(b) ? 1.0 : 0.0;
}

/**
 * Interface dimension: parameter Jaccard similarity.
 *
 * Score = 0.5 * jaccard(inputs) + 0.5 * jaccard(outputs)
 *
 * Parameter identity key: `${normalize(name)}::${normalize(type)}`
 * Both-empty → 1.0 per the general Jaccard rule.
 */
function scoreInterface(canonical: SpecYak, candidate: SpecYak): number {
  const paramKey = (p: { readonly name: string; readonly type: string }) =>
    `${normalize(p.name)}::${normalize(p.type)}`;

  const inA = new Set(canonical.inputs.map(paramKey));
  const inB = new Set(candidate.inputs.map(paramKey));
  const outA = new Set(canonical.outputs.map(paramKey));
  const outB = new Set(candidate.outputs.map(paramKey));

  return 0.5 * jaccard(inA, inB) + 0.5 * jaccard(outA, outB);
}

// ---------------------------------------------------------------------------
// Public functions
// ---------------------------------------------------------------------------

/**
 * Compute per-dimension variance scores between a canonical spec and a candidate.
 *
 * All scores are in [0, 1] where 1.0 indicates perfect alignment.
 * Score symmetry is not guaranteed for all dimensions but is preserved for
 * the full varianceScore (weights are symmetric by construction).
 */
export function compareDimensions(canonical: SpecYak, candidate: SpecYak): DimensionScores {
  return {
    security: scoreSecurity(canonical, candidate),
    behavioral: scoreBehavioral(canonical, candidate),
    error_handling: scoreErrorHandling(canonical, candidate),
    performance: scorePerformance(canonical, candidate),
    interface: scoreInterface(canonical, candidate),
  };
}

/**
 * Compute the weighted composite variance score between two SpecYak specs.
 *
 * Returns a VarianceResult with:
 *   score: weighted sum of dimension scores (in [0, 1])
 *   dimensions: per-dimension breakdown
 *   weights: the weights used (default or caller-supplied)
 *
 * Throws RangeError if caller-supplied weights:
 *   - are missing any of the 5 dimension keys
 *   - do not sum to 1.0 within 1e-9
 */
export function varianceScore(
  canonical: SpecYak,
  candidate: SpecYak,
  options?: VarianceOptions,
): VarianceResult {
  let weights: Readonly<Record<VarianceDimension, number>> = DIMENSION_WEIGHTS;

  if (options?.weights !== undefined) {
    const suppliedWeights = options.weights;
    const dims: readonly VarianceDimension[] = [
      "security",
      "behavioral",
      "error_handling",
      "performance",
      "interface",
    ];
    for (const dim of dims) {
      if (!(dim in suppliedWeights)) {
        throw new RangeError(`varianceScore: supplied weights missing dimension "${dim}"`);
      }
    }
    const sum = Object.values(suppliedWeights).reduce((acc: number, v: number) => acc + v, 0);
    if (Math.abs(sum - 1.0) > 1e-9) {
      throw new RangeError(`varianceScore: supplied weights must sum to 1.0 (got ${sum})`);
    }
    weights = suppliedWeights;
  }

  const dimensions = compareDimensions(canonical, candidate);
  const score =
    weights.security * dimensions.security +
    weights.behavioral * dimensions.behavioral +
    weights.error_handling * dimensions.error_handling +
    weights.performance * dimensions.performance +
    weights.interface * dimensions.interface;

  return { score, dimensions, weights };
}

/**
 * Map a SpecYak spec against the CWE-474 family, returning which CWEs are
 * present (detected) and which are clear (not detected).
 */
export function mapCweFamily(spec: SpecYak): CweMapping {
  const cwesPresent: CweId[] = [];
  const cwesClear: CweId[] = [];
  for (const pattern of CWE_474_FAMILY) {
    if (pattern.detect(spec)) {
      cwesPresent.push(pattern.cwe);
    } else {
      cwesClear.push(pattern.cwe);
    }
  }
  return { cwesPresent, cwesClear };
}

/**
 * Apply star-topology contract design rules to merge N SpecYak specs.
 *
 * Rules (DEC-VAR-002):
 *   safety.preconditions  = intersection (all N must agree)
 *   safety.invariants     = intersection (all N must agree)
 *   safety.cweClear       = intersection of CWE-clear sets (all N must clear)
 *   behavioral.postconditions = majority vote (≥ ceil(N/2) contributors)
 *   behavioral.behavior   = first lexicographic among non-empty values (tie-break logged)
 *   capability.effects    = union of all declared effects
 *
 * Throws RangeError on empty input (zero-contributor merge is undefined).
 *
 * For N=1, all postconditions/preconditions/effects pass through unchanged,
 * and no tie-break occurs.
 */
export function applyContractDesignRules(specs: readonly SpecYak[]): MergedContract {
  if (specs.length === 0) {
    throw new RangeError(
      "applyContractDesignRules: requires at least one spec (empty input is undefined under star-topology rules)",
    );
  }

  const n = specs.length;
  const tieBreaks: TieBreakRecord[] = [];

  // Safety: preconditions = intersection
  const preconditionsIntersection = intersectStringArrays(
    specs.map((s) => s.preconditions.map(normalize)),
  );

  // Safety: invariants = intersection
  const invariantsIntersection = intersectStringArrays(
    specs.map((s) => s.invariants.map(normalize)),
  );

  // Safety: cweClear = intersection of each spec's clear set
  const cweClearIntersection = intersectCweSets(specs.map((s) => mapCweFamily(s).cwesClear));

  // Behavioral: postconditions = majority vote (≥ ceil(N/2))
  const majorityThreshold = Math.ceil(n / 2);
  const postconditionCounts = new Map<string, number>();
  for (const spec of specs) {
    for (const pc of spec.postconditions) {
      const key = normalize(pc);
      postconditionCounts.set(key, (postconditionCounts.get(key) ?? 0) + 1);
    }
  }
  const majorityPostconditions: string[] = [];
  for (const [key, count] of postconditionCounts) {
    if (count >= majorityThreshold) {
      majorityPostconditions.push(key);
    }
  }
  majorityPostconditions.sort();

  // Behavioral: behavior prose — first lexicographic among non-empty values
  const behaviorCandidates = specs
    .map((s) => s.behavior)
    .filter((b): b is string => b !== undefined && b.length > 0)
    .sort();

  let behaviorValue: string | undefined;
  if (behaviorCandidates.length > 0) {
    behaviorValue = behaviorCandidates[0];
    if (behaviorCandidates.length > 1) {
      tieBreaks.push({
        field: "behavior",
        candidates: behaviorCandidates,
        resolution: "first_lexicographic",
      });
    }
  }

  // Capability: effects = union of all declared effects
  const effectsUnion = new Set<string>();
  for (const spec of specs) {
    for (const effect of spec.effects) {
      effectsUnion.add(normalize(effect));
    }
  }

  return {
    safety: {
      preconditions: preconditionsIntersection,
      invariants: invariantsIntersection,
      cweClear: cweClearIntersection,
    },
    behavioral: {
      postconditions: majorityPostconditions,
      behavior: behaviorValue,
    },
    capability: {
      effects: Array.from(effectsUnion).sort(),
    },
    source: {
      contributorCount: n,
      tieBreaks,
    },
  };
}

// ---------------------------------------------------------------------------
// Private merge helpers
// ---------------------------------------------------------------------------

/**
 * Compute the intersection of multiple arrays of normalized strings.
 * An item survives if it appears in ALL input arrays.
 * Empty input → empty result.
 */
function intersectStringArrays(arrays: readonly string[][]): readonly string[] {
  if (arrays.length === 0) return [];
  const [first, ...rest] = arrays;
  if (first === undefined) return [];
  const result: string[] = [];
  for (const item of first) {
    if (rest.every((arr) => arr.includes(item))) {
      result.push(item);
    }
  }
  return result;
}

/**
 * Compute the intersection of multiple arrays of CweIds.
 * A CWE survives if it is clear in ALL specs.
 */
function intersectCweSets(arrays: readonly (readonly CweId[])[]): readonly CweId[] {
  if (arrays.length === 0) return [];
  const [first, ...rest] = arrays;
  if (first === undefined) return [];
  return first.filter((cwe) => rest.every((arr) => arr.includes(cwe)));
}
