// @decision DEC-ATOM-TEST-003: Atom-test predicate types.
// Title: AST atom-test predicate type surface for WI-012-03.
// Status: proposed (MASTER_PLAN.md governance edit deferred).
// Rationale: AtomTestOptions, AtomTestReason, and AtomTestResult are the
// stable contract between isAtom() (WI-012-03) and the DFG decomposition
// recursion (WI-012-04). Keeping them in this sub-module types file avoids
// circular imports: the top-level types.ts imports from this file, not
// vice versa, matching the existing re-export pattern for CandidateBlock.

// Universalize sub-module types.
// Re-exports the slicer-facing types from the top-level types module so that
// WI-012's DFG slicer can import from this sub-path without a circular
// dependency on the full public API surface.

export type {
  CandidateBlock,
  UniversalizeResult,
  UniversalizeSlicePlanEntry,
} from "../types.js";

// ---------------------------------------------------------------------------
// Atom-test types (WI-012-03)
// ---------------------------------------------------------------------------

import type { BlockMerkleRoot, CanonicalAstHash } from "@yakcc/contracts";

// Re-export so consumers of this sub-path don't need to import from contracts.
export type { BlockMerkleRoot, CanonicalAstHash };

/**
 * Options for the isAtom() predicate.
 *
 * @see isAtom
 */
export interface AtomTestOptions {
  /**
   * Maximum allowed control-flow boundaries in an atom body.
   * A node with a count strictly greater than this threshold is not atomic.
   * Default: 1.
   */
  readonly maxControlFlowBoundaries?: number;
}

/**
 * The reason an isAtom() call returned its verdict.
 *
 * "atomic"                    — the node passes all atom criteria.
 * "too-many-cf-boundaries"    — exceeded maxControlFlowBoundaries.
 * "contains-known-primitive"  — a sub-statement matched a registry entry.
 * "non-decomposable-non-atom" — reserved for WI-012-04; never emitted here.
 */
export type AtomTestReason =
  | "atomic"
  | "too-many-cf-boundaries"
  | "contains-known-primitive"
  | "non-decomposable-non-atom";

/**
 * The result returned by isAtom().
 */
export interface AtomTestResult {
  readonly isAtom: boolean;
  readonly reason: AtomTestReason;
  readonly controlFlowBoundaryCount: number;
  /**
   * Set when reason === "contains-known-primitive".
   * Identifies the first sub-statement that matched a registry entry.
   */
  readonly matchedPrimitive?: {
    readonly merkleRoot: BlockMerkleRoot;
    readonly canonicalAstHash: CanonicalAstHash;
    readonly subRange: { readonly start: number; readonly end: number };
  };
}
