// SPDX-License-Identifier: MIT
// @decision DEC-ATOM-TEST-003: Atom-test predicate types.
// Title: AST atom-test predicate type surface for WI-012-03.
// Status: proposed (MASTER_PLAN.md governance edit deferred).
// Rationale: AtomTestOptions, AtomTestReason, and AtomTestResult are the
// stable contract between isAtom() (WI-012-03) and the DFG decomposition
// recursion (WI-012-04). Keeping them in this sub-module types file avoids
// circular imports: the top-level types.ts imports from this file, not
// vice versa, matching the existing re-export pattern for CandidateBlock.

// @decision DEC-RECURSION-005: Decomposition recursion types.
// Title: RecursionTree, RecursionNode, AtomLeaf, BranchNode, RecursionOptions
// Status: proposed
// Rationale: These types form the stable contract for the decompose() function
// (WI-012-04). AtomLeaf and BranchNode together describe the recursive tree
// produced by walking the AST top-down. RecursionOptions extends AtomTestOptions
// so callers have a single options object for the full decompose() call.

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
 * "loop-with-escaping-cf"     — the loop body contains continue/break/labeled-
 *                               jump whose binding scope is outside the body;
 *                               the loop is treated as the atom boundary.
 *                               (DEC-SLICER-LOOP-CONTROL-FLOW-001)
 */
export type AtomTestReason =
  | "atomic"
  | "too-many-cf-boundaries"
  | "contains-known-primitive"
  | "non-decomposable-non-atom"
  | "loop-with-escaping-cf";

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

// ---------------------------------------------------------------------------
// Decomposition recursion types (WI-012-04)
// ---------------------------------------------------------------------------

/**
 * A leaf node in the recursion tree — a node classified as atomic by isAtom().
 * Carries the source text, range, content-address hash, and the AtomTestResult
 * that caused it to be classified as an atom.
 */
export interface AtomLeaf {
  readonly kind: "atom";
  readonly sourceRange: { readonly start: number; readonly end: number };
  readonly source: string;
  readonly canonicalAstHash: CanonicalAstHash;
  readonly atomTest: AtomTestResult;
}

/**
 * An internal (branch) node in the recursion tree — a node classified as
 * non-atomic that was decomposed into children by decomposableChildrenOf().
 */
export interface BranchNode {
  readonly kind: "branch";
  readonly sourceRange: { readonly start: number; readonly end: number };
  readonly source: string;
  readonly canonicalAstHash: CanonicalAstHash;
  readonly atomTest: AtomTestResult;
  readonly children: readonly RecursionNode[];
}

/** A node in the recursion tree produced by decompose(). */
export type RecursionNode = AtomLeaf | BranchNode;

/**
 * The complete recursion tree returned by decompose().
 *
 * `leafCount` counts the number of AtomLeaf nodes in the tree.
 * `maxDepth` records the deepest depth actually reached during recursion
 * (0 means only the root was visited; the root was an atom).
 */
export interface RecursionTree {
  readonly root: RecursionNode;
  readonly leafCount: number;
  readonly maxDepth: number;
}

/**
 * Options for decompose(). Extends AtomTestOptions so callers pass a single
 * object that controls both the atom-test predicate and the recursion itself.
 */
export interface RecursionOptions extends AtomTestOptions {
  /**
   * Hard upper bound on tree depth. decompose() throws RecursionDepthExceededError
   * when the recursion would descend past this limit. Default: 8.
   */
  readonly maxDepth?: number;
}

// ---------------------------------------------------------------------------
// DFG slicer types (WI-012-05, WI-V2-04-L3)
// ---------------------------------------------------------------------------

// @decision DEC-SLICER-NOVEL-GLUE-004: DFG slicer type surface.
// Title: SlicePlan, SlicePlanEntry, PointerEntry, NovelGlueEntry for WI-012-05.
// Status: proposed
// Rationale: The slicer produces a SlicePlan that classifies each node in the
// RecursionTree as either a PointerEntry (matches an existing primitive in the
// registry by canonicalAstHash) or a NovelGlueEntry (unmatched leaf — new code
// that must be synthesized). SlicePlan carries both the entries and convenience
// statistics for reviewer dashboards. The intentCard field on NovelGlueEntry is
// optional because only AtomLeaf nodes carry one (branch nodes may not).

// @decision DEC-V2-FOREIGN-BLOCK-SCHEMA-001
// Title: ForeignLeafEntry — L3 foreign-import classification variant in SlicePlanEntry.
// Status: decided
// Rationale: Static import declarations from packages outside the workspace
// (node: builtins and npm packages not under @yakcc/) represent foreign
// dependencies — code the slicer should NOT attempt to synthesize as
// NovelGlueEntry. ForeignLeafEntry is added to the SlicePlanEntry discriminated
// union so downstream consumers (L4 provenance manifest, L5 --foreign-policy
// flag) can inspect foreign refs without treating them as unknown novel glue.
//
// Authority invariant L3-I1: this is the single canonical location for
// ForeignLeafEntry. Consumers must import from this module.
//
// Fields:
//   pkg       — module specifier (e.g. 'node:fs', 'sqlite-vec', 'ts-morph')
//   export    — imported binding name (e.g. 'readFileSync', 'load', 'Project')
//   alias     — local alias if the import used `as <alias>` (e.g. 'loadVec')
//   dtsHash   — optional SHA-256 of the resolved .d.ts text; populated when
//               the declaration file is accessible at classify time.
//   sourceLoc — optional source location of the import declaration.
//
// Out of scope for L3: provenance manifest wiring (L4), CLI flag (L4),
// fixture files (L5), dynamic import() classification (deferred per L3-I2).

import type { IntentCard } from "../intent/types.js";

/**
 * A node in the recursion tree that matched an existing primitive in the registry
 * by canonicalAstHash. The entire subtree rooted here is replaced by a pointer
 * to the registered block — no synthesis required.
 */
export interface PointerEntry {
  readonly kind: "pointer";
  readonly sourceRange: { readonly start: number; readonly end: number };
  readonly merkleRoot: BlockMerkleRoot;
  readonly canonicalAstHash: CanonicalAstHash;
  readonly matchedBy: "canonical_ast_hash";
}

/**
 * An unmatched AtomLeaf node — source code that does not exist in the registry
 * and must be synthesized as novel glue. This is the only code path that
 * produces new implementations.
 *
 * The `intentCard` field is optional: AtomLeaf nodes may carry one if the caller
 * ran intent extraction; branch nodes never produce NovelGlueEntry.
 */
export interface NovelGlueEntry {
  readonly kind: "novel-glue";
  readonly sourceRange: { readonly start: number; readonly end: number };
  readonly source: string;
  readonly canonicalAstHash: CanonicalAstHash;
  /** Optional intent card if available (atom leaves carry one); branches may omit. */
  readonly intentCard?: IntentCard;
}

/**
 * An AtomLeaf node that was classified as a foreign import — a static import
 * declaration referencing a package outside the workspace. These atoms are NOT
 * novel glue and must not be synthesized. L4 wires them into the provenance
 * manifest; L4 also adds --foreign-policy CLI support.
 *
 * Authority invariant L3-I1: ForeignLeafEntry is the canonical type for foreign
 * import classification. It is exported exclusively from this module.
 *
 * @see DEC-V2-FOREIGN-BLOCK-SCHEMA-001
 */
export interface ForeignLeafEntry {
  readonly kind: "foreign-leaf";
  /** Module specifier as written in the source, e.g. 'node:fs', 'sqlite-vec'. */
  readonly pkg: string;
  /** Imported binding name, e.g. 'readFileSync', 'Project', 'default'. */
  readonly export: string;
  /**
   * Local alias when the binding was renamed with `as <alias>`.
   * Undefined when the local name equals the exported name.
   */
  readonly alias?: string | undefined;
  /**
   * SHA-256 hex of the resolved .d.ts text, when resolvable at classify time.
   * Undefined when the declaration file is not accessible (e.g. in-memory FS).
   */
  readonly dtsHash?: string | undefined;
  /** Source location of the import declaration (file-relative). */
  readonly sourceLoc?:
    | { readonly file: string; readonly line: number; readonly column: number }
    | undefined;
}

/**
 * A subgraph that the slicer could not shave into atoms — preserved verbatim
 * in the project's source tree, NOT stored in the registry.
 *
 * Under DEC-V2-GLUE-AWARE-SHAVE-001, unsupported AST nodes that would previously
 * have thrown LoweringError("unsupported-node") instead emit GlueLeafEntry. The
 * slicer becomes a search algorithm: shave-what-shaves, emit glue for the rest.
 *
 * GlueLeafEntry is NOT stored in the registry (glue is project-local). It travels
 * in the slice plan only so the compile pipeline knows where the boundary is.
 *
 * @decision DEC-V2-GLUE-AWARE-SHAVE-001
 * @decision DEC-V2-GLUE-LEAF-CONTRACT-001
 * title: GlueLeafEntry type contract for the glue-aware slice plan
 * status: decided (WI-V2-GLUE-LEAF-CONTRACT)
 * rationale:
 *   The "glue" triplet variant (per DEC-V2-GLUE-AWARE-SHAVE-001) must be
 *   represented in the SlicePlan union so downstream consumers (compile pipeline,
 *   CLI, provenance manifest) can inspect glue boundaries without re-running the
 *   slicer. GlueLeafEntry is the canonical type. It is NOT a registry entry;
 *   consumers must not attempt to look it up by canonicalAstHash in the registry.
 *   canonicalAstHash is present for deduplication and audit only.
 */
export interface GlueLeafEntry {
  readonly kind: "glue";
  /** Verbatim source bytes of the unsupported subgraph. */
  readonly source: string;
  /** BLAKE3/canonical hash of the AST — for deduplication and audit only. NOT a registry key. */
  readonly canonicalAstHash: string;
  /** Human-readable explanation of why this subgraph was not shaveable. */
  readonly reason: string;
}

/** A discriminated union of all slicer output kinds. */
export type SlicePlanEntry = PointerEntry | NovelGlueEntry | ForeignLeafEntry | GlueLeafEntry;

/**
 * The complete slice plan produced by slice(). Contains the classified entries
 * in DFS order, a convenience list of matched primitives, and byte-level
 * statistics for reviewer dashboards.
 */
export interface SlicePlan {
  readonly entries: readonly SlicePlanEntry[];
  /** All BlockMerkleRoots referenced by PointerEntry — convenience. */
  readonly matchedPrimitives: readonly {
    readonly canonicalAstHash: CanonicalAstHash;
    readonly merkleRoot: BlockMerkleRoot;
  }[];
  /**
   * Bytes accounted by pointer vs. novel glue vs. glue regions, for reviewer dashboards.
   * ForeignLeafEntry bytes are not counted in any bucket.
   * glue is zero until WI-V2-SLICER-SEARCH-ALG lands the search-algorithm slicer.
   */
  readonly sourceBytesByKind: {
    readonly pointer: number;
    readonly novelGlue: number;
    readonly glue: number;
  };
}
