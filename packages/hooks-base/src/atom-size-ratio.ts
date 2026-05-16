// SPDX-License-Identifier: MIT
//
// @decision DEC-HOOK-ENF-LAYER3-ATOM-SIZE-RATIO-001
// title: Layer 3 atom-size ratio enforcement — config-driven substitution-time gate
// status: decided (wi-591-s3-layer3)
// rationale:
//   Layer 3 runs at substitution time — between the D2 auto-accept gate and
//   renderSubstitution — to prevent substituting a "lodash-shaped" atom (high
//   complexity, many exports, many transitive dependencies) when the immediate call
//   site only needs a small fraction of what the atom provides.
//
//   The gate computes two complexity proxies:
//     atomComplexity  = transitiveNodes + 5 * exportedSurface + 2 * transitiveDeps
//     needComplexity  = max(1, bindingsUsed * statementCount)
//   and rejects when atomComplexity / needComplexity > ratioThreshold.
//
//   In v1, transitiveNodes is approximated from the spec's
//   inputs.length + outputs.length + guarantees.length because the shaved-IR node
//   count is not yet exposed by @yakcc/registry. This proxy is documented explicitly
//   so v2 can swap it for the real count without changing the gate interface.
//
//   Key design decisions:
//   - ALL thresholds (ratioThreshold, minFloor) come exclusively from
//     getEnforcementConfig().layer3 (DEC-HOOK-ENF-CONFIG-001). Nothing hardcoded.
//   - Atoms with atomComplexity < minFloor skip the ratio check. This prevents
//     false positives on micro-atoms (DEC-HOOK-ENF-LAYER3-MIN-FLOOR-001).
//   - The gate is pure (no I/O, no async) — safe to call synchronously in the
//     hot substitution path.
//   - Escape hatch: YAKCC_HOOK_DISABLE_ATOM_SIZE_GATE=1 → layer3.disableGate=true.
//     Checked by the caller in substitute.ts; this module does NOT check env vars.
//
//   Plug-in point: substitute.ts::executeSubstitution, between the auto-accept gate
//   and the renderSubstitution call. This is the ONLY place Layer 3 runs
//   (single plug point per Layer 3 spec).
//
//   Cross-reference:
//     enforcement-config.ts — threshold authority (DEC-HOOK-ENF-CONFIG-001)
//     enforcement-types.ts  — AtomSizeAcceptEnvelope, AtomSizeRejectEnvelope
//     substitute.ts         — single plug point
//     plans/wi-579-s3-layer3-atom-size-ratio.md

import type { SpecYak } from "@yakcc/contracts";
import type { AtomSizeRatioResult } from "./enforcement-types.js";
import { getEnforcementConfig } from "./enforcement-config.js";

// ---------------------------------------------------------------------------
// AtomLike — minimal interface consumed by computeAtomComplexity
// ---------------------------------------------------------------------------

/**
 * Minimal subset of a registry atom needed for Layer 3 complexity scoring.
 *
 * In the substitution pipeline, this is satisfied by the SpecYak + transitive
 * dependency count fields from the winning candidate's block row.
 */
export interface AtomLike {
  /** SpecYak contract — provides inputs, outputs, guarantees for the proxy count. */
  readonly spec: SpecYak;
  /**
   * Number of named exports on this atom.
   * In v1, this is derived from spec.outputs.length (the exported value count).
   * In v2, use the registry's stored export-count when exposed.
   */
  readonly exportedSurface: number;
  /**
   * Transitive dependency count from the registry provenance row.
   * Defaults to 0 when the registry has not stored provenance for this block.
   */
  readonly transitiveDeps: number;
}

// ---------------------------------------------------------------------------
// CallSiteAnalysis — need-side complexity inputs
// ---------------------------------------------------------------------------

/**
 * Call-site analysis inputs for needComplexity.
 *
 * In the substitution pipeline, these are derived from the originalCode snippet
 * (ast-scan of the binding call). The caller (substitute.ts) extracts these
 * before invoking enforceAtomSizeRatio.
 */
export interface CallSiteAnalysis {
  /**
   * Number of identifiers from the atom's export list referenced in the call-site code.
   * Minimum 1 when the call site references the atom at all.
   */
  readonly bindingsUsed: number;
  /**
   * AST statement count under the calling function body containing the binding reference.
   * Proxy for "how much code does the caller actually need from this atom?"
   * Minimum 1 to avoid division by zero in ratio computation.
   */
  readonly statementCount: number;
}

// ---------------------------------------------------------------------------
// Complexity proxy computations
// ---------------------------------------------------------------------------

/**
 * Compute the atom-side complexity proxy from an AtomLike.
 *
 * Formula (v1 proxy, per plans/wi-579-hook-enforcement-architecture.md §5.4):
 *   atomComplexity = transitiveNodes + 5 * exportedSurface + 2 * transitiveDeps
 *
 * where transitiveNodes = spec.inputs.length + spec.outputs.length + spec.guarantees.length
 * (v1 approximation; v2 will use the real shaved-IR node count from @yakcc/registry).
 *
 * @decision DEC-HOOK-ENF-LAYER3-ATOM-SIZE-RATIO-001
 * The 5× weight on exportedSurface reflects that each named export imposes a
 * structural coupling cost on callers (they must understand, import, and test it).
 * The 2× weight on transitiveDeps penalises deep dependency trees that bring
 * indirect complexity. Both multipliers match the spec table in §5.4.
 */
export function computeAtomComplexity(atom: AtomLike): number {
  const transitiveNodes =
    (atom.spec.inputs?.length ?? 0) +
    (atom.spec.outputs?.length ?? 0) +
    (atom.spec.guarantees?.length ?? 0);

  return transitiveNodes + 5 * atom.exportedSurface + 2 * atom.transitiveDeps;
}

/**
 * Compute the need-side complexity proxy from a CallSiteAnalysis.
 *
 * Formula: needComplexity = max(1, bindingsUsed * statementCount)
 *
 * The max(1, …) floor ensures that a degenerate call site (0 bindings, 0
 * statements — e.g. a placeholder) never produces a 0 denominator and inflates
 * the ratio to infinity.
 *
 * @decision DEC-HOOK-ENF-LAYER3-ATOM-SIZE-RATIO-001
 */
export function computeNeedComplexity(callSite: CallSiteAnalysis): number {
  return Math.max(1, callSite.bindingsUsed * callSite.statementCount);
}

// ---------------------------------------------------------------------------
// Enforcement — public API
// ---------------------------------------------------------------------------

/**
 * Evaluate whether a candidate atom's complexity is proportionate to the
 * immediate call-site need.
 *
 * Returns an AtomSizeRatioResult discriminated union:
 *   - { layer: 3, status: "ok", atomComplexity, needComplexity, ratio }
 *       — within configured bounds; proceed to renderSubstitution.
 *   - { layer: 3, status: "atom-size-too-large", atomComplexity, needComplexity, ratio, … }
 *       — atom is too complex for the immediate need; do NOT substitute.
 *
 * All thresholds are read from getEnforcementConfig().layer3 at call time
 * (DEC-HOOK-ENF-CONFIG-001). Tests may use setConfigOverride() /
 * resetConfigOverride() from enforcement-config.ts to inject controlled configs.
 *
 * Bypass conditions (status always "ok"):
 *   (a) atomComplexity < minFloor — micro-atom, ratio check irrelevant.
 *   (b) Escape hatch: caller sets layer3.disableGate=true before calling
 *       (checked in substitute.ts; this function does NOT check env vars).
 *
 * @param atom     - AtomLike describing the candidate atom.
 * @param callSite - CallSiteAnalysis from the original code snippet.
 * @param config   - Optional Layer3Config override (used in tests; production
 *                   callers omit this and rely on getEnforcementConfig()).
 *
 * @decision DEC-HOOK-ENF-LAYER3-ATOM-SIZE-RATIO-001
 */
export function enforceAtomSizeRatio(
  atom: AtomLike,
  callSite: CallSiteAnalysis,
  config?: import("./enforcement-config.js").Layer3Config,
): AtomSizeRatioResult {
  const cfg = config ?? getEnforcementConfig().layer3;
  const { ratioThreshold, minFloor } = cfg;

  const atomComplexity = computeAtomComplexity(atom);
  const needComplexity = computeNeedComplexity(callSite);
  const ratio = atomComplexity / needComplexity;

  // Bypass: atom is too small to trigger the ratio check.
  if (atomComplexity < minFloor) {
    return {
      layer: 3,
      status: "ok",
      atomComplexity,
      needComplexity,
      ratio,
      bypassed: true,
    };
  }

  // Reject: ratio exceeds configured threshold.
  if (ratio > ratioThreshold) {
    return {
      layer: 3,
      status: "atom-size-too-large",
      atomComplexity,
      needComplexity,
      ratio,
      ratioThreshold,
      suggestion:
        `ATOM_OVERSIZED: candidate atom complexity ~${atomComplexity} vs immediate need ~${needComplexity} (ratio ${ratio.toFixed(1)}x).\n` +
        `Refusing to substitute. Decompose the immediate need into sub-atoms and re-query each.`,
    };
  }

  return {
    layer: 3,
    status: "ok",
    atomComplexity,
    needComplexity,
    ratio,
    bypassed: false,
  };
}

/**
 * Convenience predicate: returns true when the atom-size ratio check passes.
 *
 * Equivalent to `enforceAtomSizeRatio(atom, callSite, config).status === "ok"`.
 */
export function isAtomSizeOk(
  atom: AtomLike,
  callSite: CallSiteAnalysis,
  config?: import("./enforcement-config.js").Layer3Config,
): boolean {
  return enforceAtomSizeRatio(atom, callSite, config).status === "ok";
}
