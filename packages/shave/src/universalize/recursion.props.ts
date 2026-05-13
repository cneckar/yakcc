// SPDX-License-Identifier: MIT
// @decision DEC-V2-PROPTEST-PATH-A-001: hand-authored property-test corpus for
// @yakcc/shave universalize/recursion.ts. Two-file pattern: this file
// (.props.ts) is vitest-free and holds the corpus; the sibling .props.test.ts
// is the vitest harness.
// Status: accepted (WI-V2-07-PREFLIGHT L3j)
// Rationale: See tmp/wi-v2-07-preflight-layer-plan.md — the corpus file must
// be runtime-independent so L10 can hash it as a manifest artifact.
//
// Surface covered: universalize/recursion.ts
//   decompose(source, registry, options?) → Promise<RecursionTree>
//   DidNotReachAtomError, RecursionDepthExceededError (error classes)
//
// Properties covered:
//   DEC-REC-P1: leafCount is always a positive integer for any non-throwing call.
//   DEC-REC-P2: maxDepth is always a non-negative integer.
//   DEC-REC-P3: root.kind is "atom" or "branch" (RecursionNode exhaustion).
//   DEC-REC-P4: root.kind === "atom" implies leafCount === 1 and maxDepth === 0.
//   DEC-REC-P5: root.canonicalAstHash is a 64-char lowercase hex string.
//   DEC-REC-P6: RecursionDepthExceededError carries depth > maxDepth.
//   DEC-REC-P7: DidNotReachAtomError carries node.range.start < node.range.end.
//   DEC-REC-P8: empty-registry + 0-CF source always produces atom root.
//   Compound: real source → decompose → RecursionTree joint invariants.

// ---------------------------------------------------------------------------
// Property-test corpus for universalize/recursion.ts
// ---------------------------------------------------------------------------

import type { BlockMerkleRoot, CanonicalAstHash } from "@yakcc/contracts";
import * as fc from "fast-check";
import { DidNotReachAtomError, RecursionDepthExceededError, decompose } from "./recursion.js";
import type { RecursionNode, RecursionTree } from "./types.js";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Registry that always returns no matches — no known primitives. */
const emptyRegistry = {
  async findByCanonicalAstHash(_hash: CanonicalAstHash): Promise<readonly BlockMerkleRoot[]> {
    return [];
  },
};

/**
 * A TypeScript source with exactly 0 control-flow boundaries.
 * decompose() on this source with the empty registry must always produce an
 * atom leaf at the root.
 */
const ZERO_CF_SOURCE = "function f(x: number) { return x + 1; }";

/**
 * A TypeScript source with exactly 1 control-flow boundary (single if).
 * With default maxControlFlowBoundaries=1, the SourceFile is atomic.
 * With maxControlFlowBoundaries=0, the SourceFile is not atomic → branch.
 */
const ONE_CF_SOURCE = "function f(x: number) { if (x > 0) return x; return 0; }";

/**
 * A TypeScript source with 2 top-level if-statements (2 CF boundaries at the
 * SourceFile level). With default maxCF=1, the SourceFile is not atomic → branch.
 * Each if-statement has 1 CF boundary and is individually atomic.
 */
const TWO_IF_SOURCE = [
  "declare const a: boolean;",
  "declare const b: boolean;",
  "if (a) { console.log(1); }",
  "if (b) { console.log(2); }",
].join("\n");

/** Arbitrary non-negative integer for maxControlFlowBoundaries (0–5). */
const natCFArb: fc.Arbitrary<number> = fc.nat({ max: 5 });

/**
 * Walk a RecursionTree recursively and count all AtomLeaf nodes.
 * Used to verify leafCount is consistent with the actual tree shape.
 */
function countLeaves(node: RecursionNode): number {
  if (node.kind === "atom") return 1;
  return node.children.reduce((sum, child) => sum + countLeaves(child), 0);
}

/**
 * Walk a RecursionTree recursively and compute the maximum depth reached.
 * The root is at depth 0.
 */
function computeMaxDepth(node: RecursionNode, depth = 0): number {
  if (node.kind === "atom") return depth;
  return Math.max(...node.children.map((c) => computeMaxDepth(c, depth + 1)));
}

// ---------------------------------------------------------------------------
// DEC-REC-P1: leafCount is always a positive integer for any non-throwing call
//
// Invariant: decompose() counts AtomLeaf nodes during recursion. A successful
// call must have visited at least one atom. leafCount=0 would indicate the
// recursion produced a structurally empty tree, which is unreachable.
// ---------------------------------------------------------------------------

/**
 * prop_decompose_leafCount_is_positive_integer
 *
 * For the 0-CF source with the empty registry and any maxCF in {0..5},
 * decompose() completes without throwing and produces leafCount >= 1.
 *
 * Invariant (DEC-REC-P1, DEC-RECURSION-005): every successful decompose() call
 * visits at least one AtomLeaf. A zero leafCount is structurally impossible —
 * every recursion path terminates at an atom or throws.
 */
export const prop_decompose_leafCount_is_positive_integer: fc.IAsyncProperty<[number]> =
  fc.asyncProperty(natCFArb, async (maxCF) => {
    const tree: RecursionTree = await decompose(ZERO_CF_SOURCE, emptyRegistry, {
      maxControlFlowBoundaries: maxCF,
    });
    return (
      typeof tree.leafCount === "number" && Number.isInteger(tree.leafCount) && tree.leafCount >= 1
    );
  });

// ---------------------------------------------------------------------------
// DEC-REC-P2: maxDepth is always a non-negative integer
//
// Invariant: maxDepth=0 means the root was an atom (no children visited).
// A negative maxDepth is semantically impossible.
// ---------------------------------------------------------------------------

/**
 * prop_decompose_maxDepth_is_non_negative
 *
 * For any successful decompose() call on a simple source, maxDepth is a
 * non-negative integer.
 *
 * Invariant (DEC-REC-P2, DEC-RECURSION-005): maxDepth tracks the deepest
 * recursion level reached. A negative value is unreachable: depth starts at
 * 0 and only ever increases.
 */
export const prop_decompose_maxDepth_is_non_negative: fc.IAsyncProperty<[number]> =
  fc.asyncProperty(natCFArb, async (maxCF) => {
    const tree: RecursionTree = await decompose(ZERO_CF_SOURCE, emptyRegistry, {
      maxControlFlowBoundaries: maxCF,
    });
    return (
      typeof tree.maxDepth === "number" && Number.isInteger(tree.maxDepth) && tree.maxDepth >= 0
    );
  });

// ---------------------------------------------------------------------------
// DEC-REC-P3: root.kind is "atom" or "branch"
//
// Invariant: The root of any RecursionTree is a RecursionNode — either an
// AtomLeaf or a BranchNode. No other kind is valid.
// ---------------------------------------------------------------------------

/**
 * prop_decompose_root_kind_is_atom_or_branch
 *
 * The root node of any RecursionTree produced by decompose() has kind "atom"
 * or "branch" — never any other value.
 *
 * Invariant (DEC-REC-P3, DEC-RECURSION-005): the root is always a RecursionNode.
 * A root with an unknown kind would break all tree traversals that dispatch on
 * root.kind.
 */
export const prop_decompose_root_kind_is_atom_or_branch: fc.IAsyncProperty<[number]> =
  fc.asyncProperty(natCFArb, async (maxCF) => {
    const tree: RecursionTree = await decompose(ZERO_CF_SOURCE, emptyRegistry, {
      maxControlFlowBoundaries: maxCF,
    });
    return tree.root.kind === "atom" || tree.root.kind === "branch";
  });

// ---------------------------------------------------------------------------
// DEC-REC-P4: root.kind === "atom" implies leafCount === 1 and maxDepth === 0
//
// Invariant: When the SourceFile itself is atomic (0 CF boundaries), the
// recursion terminates immediately at the root. leafCount must be 1 and
// maxDepth must be 0.
// ---------------------------------------------------------------------------

/**
 * prop_decompose_atom_root_implies_leafCount_1_maxDepth_0
 *
 * For the 0-CF source and any maxCF >= 0, the root is always an atom, and
 * the resulting tree has leafCount=1 and maxDepth=0.
 *
 * Invariant (DEC-REC-P4, DEC-RECURSION-005): the degenerate case — the input
 * is already atomic. leafCount=1 and maxDepth=0 are the canonical indicators
 * that no recursion occurred beyond the root.
 */
export const prop_decompose_atom_root_implies_leafCount_1_maxDepth_0: fc.IAsyncProperty<[number]> =
  fc.asyncProperty(natCFArb, async (maxCF) => {
    const tree: RecursionTree = await decompose(ZERO_CF_SOURCE, emptyRegistry, {
      maxControlFlowBoundaries: maxCF,
    });
    if (tree.root.kind !== "atom") return true; // only check when root is atom
    return tree.leafCount === 1 && tree.maxDepth === 0;
  });

// ---------------------------------------------------------------------------
// DEC-REC-P5: root.canonicalAstHash is a 64-char lowercase hex string
//
// Invariant: The canonicalAstHash at the root is a BLAKE3-256 hex digest.
// Its format is load-bearing for registry lookups and manifest hashing.
// ---------------------------------------------------------------------------

/**
 * prop_decompose_root_canonicalAstHash_is_64_char_hex
 *
 * The canonicalAstHash on the root node of any RecursionTree is a 64-character
 * lowercase hex string (BLAKE3-256 encoding).
 *
 * Invariant (DEC-REC-P5, DEC-RECURSION-005): registry lookups and provenance
 * manifests index by this hash. Any format deviation (wrong length, uppercase,
 * non-hex chars) would corrupt index integrity.
 */
export const prop_decompose_root_canonicalAstHash_is_64_char_hex: fc.IAsyncProperty<[number]> =
  fc.asyncProperty(natCFArb, async (maxCF) => {
    const tree: RecursionTree = await decompose(ZERO_CF_SOURCE, emptyRegistry, {
      maxControlFlowBoundaries: maxCF,
    });
    const h = tree.root.canonicalAstHash;
    return typeof h === "string" && h.length === 64 && /^[0-9a-f]+$/.test(h);
  });

// ---------------------------------------------------------------------------
// DEC-REC-P6: RecursionDepthExceededError.depth > RecursionDepthExceededError.maxDepth
//
// Invariant: The error is thrown when depth > maxDepth. The error object must
// carry consistent values — depth is strictly greater than maxDepth.
// ---------------------------------------------------------------------------

/**
 * prop_RecursionDepthExceededError_depth_exceeds_maxDepth
 *
 * When decompose() throws RecursionDepthExceededError, the error's .depth
 * field is strictly greater than its .maxDepth field.
 *
 * Invariant (DEC-REC-P6, DEC-RECURSION-005): the guard `if (depth > maxDepth)`
 * precedes the throw. Therefore depth > maxDepth is always true at throw time.
 * An error with depth <= maxDepth indicates the guard condition was not respected.
 */
export const prop_RecursionDepthExceededError_depth_exceeds_maxDepth = fc.asyncProperty(
  fc.constant<undefined>(undefined),
  async () => {
    // TWO_IF_SOURCE has SourceFile with 2 CF → not atomic with maxCF=1.
    // maxDepth=0 forces the throw immediately when the recursion tries depth 1.
    let caught: RecursionDepthExceededError | undefined;
    try {
      await decompose(TWO_IF_SOURCE, emptyRegistry, { maxDepth: 0 });
    } catch (e) {
      if (e instanceof RecursionDepthExceededError) caught = e;
    }
    if (caught === undefined) return false; // must throw
    return caught.depth > caught.maxDepth;
  },
);

// ---------------------------------------------------------------------------
// DEC-REC-P7: DidNotReachAtomError.node.range is a valid non-empty interval
//
// Invariant: The error is thrown on a real node that has a positive source
// extent. A zero-width range would indicate a phantom node.
// ---------------------------------------------------------------------------

/**
 * prop_DidNotReachAtomError_node_range_is_valid
 *
 * When decompose() throws DidNotReachAtomError, the error's node.range has
 * start < end (a positive-width source interval).
 *
 * Invariant (DEC-REC-P7, DEC-RECURSION-005): DidNotReachAtomError is thrown on
 * a concrete AST node. Every concrete node has a non-zero source span. A range
 * where start >= end would indicate a phantom or zero-width node, which is not
 * a valid AST node kind.
 */
export const prop_DidNotReachAtomError_node_range_is_valid = fc.asyncProperty(
  fc.constant<undefined>(undefined),
  async () => {
    // VariableStatement with no initializer → decomposableChildrenOf returns [] AND
    // not a CallExpression → DidNotReachAtomError. (Previously used "console.log(1);"
    // which now glue-routes per DEC-V2-SHAVE-CALLEXPRESSION-GLUE-001.)
    let caught: DidNotReachAtomError | undefined;
    try {
      await decompose("let x;", emptyRegistry, {
        maxControlFlowBoundaries: -1,
      });
    } catch (e) {
      if (e instanceof DidNotReachAtomError) caught = e;
    }
    if (caught === undefined) return false; // must throw
    return (
      typeof caught.node.range.start === "number" &&
      typeof caught.node.range.end === "number" &&
      caught.node.range.start >= 0 &&
      caught.node.range.end > caught.node.range.start
    );
  },
);

// ---------------------------------------------------------------------------
// DEC-REC-P8: empty registry + 0-CF source → always atom root for all maxCF
//
// Invariant: A source with 0 control-flow boundaries always classifies as
// atomic regardless of maxCF threshold. The registry is never consulted.
// ---------------------------------------------------------------------------

/**
 * prop_decompose_zero_cf_always_produces_atom_root
 *
 * For a 0-CF source, an empty registry, and any maxCF in {0..5}, decompose()
 * produces a tree whose root.kind === "atom".
 *
 * Invariant (DEC-REC-P8, AT-CF-1, DEC-RECURSION-005): 0 CF boundaries never
 * exceed any non-negative threshold. The registry is never consulted because
 * criterion 1 passes. A branch root here indicates a regression in CF counting.
 */
export const prop_decompose_zero_cf_always_produces_atom_root: fc.IAsyncProperty<[number]> =
  fc.asyncProperty(natCFArb, async (maxCF) => {
    const tree: RecursionTree = await decompose(ZERO_CF_SOURCE, emptyRegistry, {
      maxControlFlowBoundaries: maxCF,
    });
    return tree.root.kind === "atom";
  });

// ---------------------------------------------------------------------------
// Compound: real source → decompose → RecursionTree joint invariants
//
// Production sequence: a TypeScript source string is parsed by decompose()
// into a Project; each node is classified via isAtom(); the recursion walks
// top-down until every leaf is atomic. This compound property exercises the
// full path crossing decompose → isAtom → decomposableChildrenOf → tree build.
//
// Test: TWO_IF_SOURCE with maxCF=1 (default) → branch root + 4 atom children.
// ---------------------------------------------------------------------------

/**
 * prop_compound_decompose_real_parse_branch_and_atom_invariants
 *
 * Drives the real production sequence end-to-end for a source with 2
 * top-level if-statements (2 CF boundaries at SourceFile level). With default
 * maxCF=1:
 *   - SourceFile: 2 CF > 1 → not atomic → branch
 *   - Each statement: ≤ 1 CF → atomic → leaf
 *
 * Verifies joint invariants:
 *   - root.kind === "branch"
 *   - leafCount >= 1 (must have at least one atom descendant)
 *   - maxDepth >= 1 (recursion went at least one level)
 *   - countLeaves(root) === leafCount (internal consistency)
 *   - root.canonicalAstHash is 64-char lowercase hex
 *
 * Crosses: ts-morph Project construction, SourceFile parse, isAtom() CF walk,
 * decomposableChildrenOf() dispatch, result tree assembly, leafCount/maxDepth
 * bookkeeping.
 *
 * Invariant (DEC-REC-P1–P5, DEC-RECURSION-005): all five leaf/depth/kind/hash
 * invariants must hold jointly for any successful decompose() call that produces
 * a branch tree.
 */
export const prop_compound_decompose_real_parse_branch_and_atom_invariants = fc.asyncProperty(
  fc.constant<undefined>(undefined),
  async () => {
    // TWO_IF_SOURCE: 2 CF boundaries at SourceFile level → branch root.
    const tree: RecursionTree = await decompose(TWO_IF_SOURCE, emptyRegistry);

    // P3: root.kind is "atom" or "branch"
    if (tree.root.kind !== "atom" && tree.root.kind !== "branch") return false;

    // For this source the root must be a branch (2 CF > default maxCF=1).
    if (tree.root.kind !== "branch") return false;

    // P1: leafCount >= 1
    if (tree.leafCount < 1) return false;

    // P2: maxDepth >= 0; for a branch tree it must be >= 1
    if (tree.maxDepth < 1) return false;

    // Internal consistency: count leaves matches declared leafCount.
    if (countLeaves(tree.root) !== tree.leafCount) return false;

    // Internal consistency: computed maxDepth matches declared maxDepth.
    if (computeMaxDepth(tree.root) !== tree.maxDepth) return false;

    // P5: root.canonicalAstHash is 64-char lowercase hex
    const h = tree.root.canonicalAstHash;
    if (typeof h !== "string" || h.length !== 64 || !/^[0-9a-f]+$/.test(h)) return false;

    // All joint invariants satisfied.
    return true;
  },
);

// ---------------------------------------------------------------------------
// Additional: canonicalAstHash stability across two calls
//
// Invariant: decompose() is deterministic. Two calls on the same source with
// the same options produce roots with the same canonicalAstHash.
// ---------------------------------------------------------------------------

/**
 * prop_decompose_canonicalAstHash_is_stable_across_calls
 *
 * Two successive decompose() calls on the same source string produce root
 * nodes with identical canonicalAstHash values.
 *
 * Invariant (DEC-REC-P5, DEC-RECURSION-005): canonicalAstHash is derived from
 * the BLAKE3 hash of the normalized AST. It must be deterministic — same input
 * bytes and same AST normalization → same hash on every call. Hash instability
 * would break registry lookups and cross-session provenance manifests.
 */
export const prop_decompose_canonicalAstHash_is_stable_across_calls = fc.asyncProperty(
  fc.constant<undefined>(undefined),
  async () => {
    const tree1 = await decompose(ONE_CF_SOURCE, emptyRegistry);
    const tree2 = await decompose(ONE_CF_SOURCE, emptyRegistry);
    return tree1.root.canonicalAstHash === tree2.root.canonicalAstHash;
  },
);
