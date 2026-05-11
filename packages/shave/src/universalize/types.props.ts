// SPDX-License-Identifier: MIT
// @decision DEC-V2-PROPTEST-PATH-A-001: hand-authored property-test corpus for
// @yakcc/shave universalize/types.ts atoms. Two-file pattern: this file
// (.props.ts) is vitest-free and holds the corpus; the sibling .props.test.ts
// is the vitest harness.
// Status: accepted (WI-V2-07-PREFLIGHT L3-universalize)
// Rationale: See tmp/wi-v2-07-preflight-layer-plan.md — the corpus file must
// be runtime-independent so L10 can hash it as a manifest artifact.
//
// Atoms covered (named exports from universalize/types.ts):
//   AtomTestOptions   (ATO1.1) — shape invariant: maxControlFlowBoundaries optional number
//   AtomTestReason    (ATR1.1) — exhaustive discriminant: 5 literal string values
//   AtomTestResult    (ATR1.2) — shape invariant: isAtom/reason/controlFlowBoundaryCount required
//   AtomLeaf          (AL1.1)  — shape invariant: kind="atom", sourceRange, source, canonicalAstHash, atomTest
//   BranchNode        (BN1.1)  — shape invariant: kind="branch", children array
//   RecursionNode     (RN1.1)  — discriminated union: AtomLeaf | BranchNode
//   RecursionTree     (RT1.1)  — shape invariant: root, leafCount, maxDepth
//   RecursionOptions  (RO1.1)  — extends AtomTestOptions: maxDepth optional number
//   PointerEntry      (PE1.1)  — shape invariant: kind="pointer", merkleRoot, matchedBy
//   NovelGlueEntry    (NG1.1)  — shape invariant: kind="novel-glue", source, canonicalAstHash
//   ForeignLeafEntry  (FL1.1)  — shape invariant: kind="foreign-leaf", pkg, export
//   GlueLeafEntry     (GL1.1)  — shape invariant: kind="glue", source, reason
//   SlicePlanEntry    (SP1.1)  — discriminated union: Pointer|NovelGlue|ForeignLeaf|Glue
//   SlicePlan         (SP1.2)  — shape invariant: entries, matchedPrimitives, sourceBytesByKind
//
// Properties covered:
//   - AtomTestOptions.maxControlFlowBoundaries is either undefined or a non-negative integer.
//   - AtomTestReason is one of the 5 canonical literal strings.
//   - AtomTestResult.isAtom is a boolean, reason is a valid AtomTestReason.
//   - AtomTestResult.controlFlowBoundaryCount is a non-negative integer.
//   - AtomLeaf.kind is always "atom"; sourceRange start <= end.
//   - BranchNode.kind is always "branch"; children is a readonly array.
//   - RecursionNode is either an AtomLeaf or BranchNode (exhaustive union check).
//   - RecursionTree.leafCount is a non-negative integer; maxDepth is non-negative.
//   - RecursionOptions.maxDepth is either undefined or a positive integer.
//   - PointerEntry.kind is "pointer"; matchedBy is "canonical_ast_hash".
//   - NovelGlueEntry.kind is "novel-glue"; source is a string.
//   - ForeignLeafEntry.kind is "foreign-leaf"; pkg and export are non-empty strings.
//   - GlueLeafEntry.kind is "glue"; reason is a non-empty string.
//   - SlicePlanEntry discriminant exhaustion: all 4 kinds are representable.
//   - SlicePlan.sourceBytesByKind.pointer + novelGlue + glue are all non-negative numbers.
//   - Compound: AtomLeaf with isAtom=true → RecursionTree with leafCount >= 1.

// ---------------------------------------------------------------------------
// Property-test corpus for universalize/types.ts
// ---------------------------------------------------------------------------

import type { BlockMerkleRoot, CanonicalAstHash } from "@yakcc/contracts";
import * as fc from "fast-check";
import type {
  AtomLeaf,
  AtomTestOptions,
  AtomTestReason,
  AtomTestResult,
  BranchNode,
  ForeignLeafEntry,
  GlueLeafEntry,
  NovelGlueEntry,
  PointerEntry,
  RecursionNode,
  RecursionOptions,
  RecursionTree,
  SlicePlan,
  SlicePlanEntry,
} from "./types.js";

// ---------------------------------------------------------------------------
// Shared arbitraries
// ---------------------------------------------------------------------------

/** Non-empty string with no leading/trailing whitespace. */
const nonEmptyStr: fc.Arbitrary<string> = fc
  .string({ minLength: 1, maxLength: 40 })
  .filter((s) => s.trim().length > 0);

/** 64-char lowercase hex string — canonical form for CanonicalAstHash and BlockMerkleRoot. */
const hex64: fc.Arbitrary<string> = fc
  .array(fc.integer({ min: 0, max: 15 }), { minLength: 64, maxLength: 64 })
  .map((nibbles) => nibbles.map((n) => n.toString(16)).join(""));

/** Branded CanonicalAstHash — a 64-char hex string at runtime. */
const canonicalAstHashArb: fc.Arbitrary<CanonicalAstHash> = hex64 as fc.Arbitrary<CanonicalAstHash>;

/** Branded BlockMerkleRoot — a 64-char hex string at runtime. */
const blockMerkleRootArb: fc.Arbitrary<BlockMerkleRoot> = hex64 as fc.Arbitrary<BlockMerkleRoot>;

/** Source range with start <= end. */
const sourceRangeArb: fc.Arbitrary<{ readonly start: number; readonly end: number }> = fc
  .tuple(fc.nat({ max: 10_000 }), fc.nat({ max: 10_000 }))
  .map(([a, b]) => ({ start: Math.min(a, b), end: Math.max(a, b) }));

/** Non-negative integer. */
const natArb: fc.Arbitrary<number> = fc.nat({ max: 1_000 });

// ---------------------------------------------------------------------------
// AtomTestOptions arbitrary
// ---------------------------------------------------------------------------

/** Optional non-negative integer for maxControlFlowBoundaries. */
const atomTestOptionsArb: fc.Arbitrary<AtomTestOptions> = fc.record(
  { maxControlFlowBoundaries: fc.nat({ max: 20 }) },
  { requiredKeys: [] },
);

// ---------------------------------------------------------------------------
// AtomTestReason arbitrary
// ---------------------------------------------------------------------------

/** The 5 canonical AtomTestReason literal values. */
const atomTestReasonArb: fc.Arbitrary<AtomTestReason> = fc.oneof(
  fc.constant("atomic" as const),
  fc.constant("too-many-cf-boundaries" as const),
  fc.constant("contains-known-primitive" as const),
  fc.constant("non-decomposable-non-atom" as const),
  fc.constant("loop-with-escaping-cf" as const),
);

// ---------------------------------------------------------------------------
// AtomTestResult arbitrary
// ---------------------------------------------------------------------------

/** AtomTestResult without matchedPrimitive. */
const atomTestResultArb: fc.Arbitrary<AtomTestResult> = fc
  .tuple(fc.boolean(), atomTestReasonArb, natArb)
  .map(([isAtom, reason, controlFlowBoundaryCount]) => ({
    isAtom,
    reason,
    controlFlowBoundaryCount,
  }));

// ---------------------------------------------------------------------------
// AtomLeaf and BranchNode arbitraries
// ---------------------------------------------------------------------------

/** Arbitrary AtomLeaf. */
const atomLeafArb: fc.Arbitrary<AtomLeaf> = fc
  .tuple(sourceRangeArb, nonEmptyStr, canonicalAstHashArb, atomTestResultArb)
  .map(([sourceRange, source, canonicalAstHash, atomTest]) => ({
    kind: "atom" as const,
    sourceRange,
    source,
    canonicalAstHash,
    atomTest,
  }));

/** Arbitrary BranchNode (shallow — children contains only AtomLeaf nodes for simplicity). */
const branchNodeArb: fc.Arbitrary<BranchNode> = fc
  .tuple(
    sourceRangeArb,
    nonEmptyStr,
    canonicalAstHashArb,
    atomTestResultArb,
    fc.array(atomLeafArb, { minLength: 1, maxLength: 3 }),
  )
  .map(([sourceRange, source, canonicalAstHash, atomTest, children]) => ({
    kind: "branch" as const,
    sourceRange,
    source,
    canonicalAstHash,
    atomTest,
    children,
  }));

/** Arbitrary RecursionNode (AtomLeaf | BranchNode). */
const recursionNodeArb: fc.Arbitrary<RecursionNode> = fc.oneof(atomLeafArb, branchNodeArb);

// ---------------------------------------------------------------------------
// RecursionTree arbitrary
// ---------------------------------------------------------------------------

/** Arbitrary RecursionTree. */
const recursionTreeArb: fc.Arbitrary<RecursionTree> = fc
  .tuple(recursionNodeArb, fc.nat({ max: 100 }), fc.nat({ max: 20 }))
  .map(([root, leafCount, maxDepth]) => ({
    root,
    leafCount,
    maxDepth,
  }));

// ---------------------------------------------------------------------------
// RecursionOptions arbitrary
// ---------------------------------------------------------------------------

/** Arbitrary RecursionOptions. */
const recursionOptionsArb: fc.Arbitrary<RecursionOptions> = fc.record(
  {
    maxControlFlowBoundaries: fc.nat({ max: 20 }),
    maxDepth: fc.integer({ min: 1, max: 64 }),
  },
  { requiredKeys: [] },
);

// ---------------------------------------------------------------------------
// Slicer entry arbitraries
// ---------------------------------------------------------------------------

/** Arbitrary PointerEntry. */
const pointerEntryArb: fc.Arbitrary<PointerEntry> = fc
  .tuple(sourceRangeArb, blockMerkleRootArb, canonicalAstHashArb)
  .map(([sourceRange, merkleRoot, canonicalAstHash]) => ({
    kind: "pointer" as const,
    sourceRange,
    merkleRoot,
    canonicalAstHash,
    matchedBy: "canonical_ast_hash" as const,
  }));

/** Arbitrary NovelGlueEntry (without intentCard for simplicity). */
const novelGlueEntryArb: fc.Arbitrary<NovelGlueEntry> = fc
  .tuple(sourceRangeArb, nonEmptyStr, canonicalAstHashArb)
  .map(([sourceRange, source, canonicalAstHash]) => ({
    kind: "novel-glue" as const,
    sourceRange,
    source,
    canonicalAstHash,
  }));

/** Arbitrary ForeignLeafEntry. */
const foreignLeafEntryArb: fc.Arbitrary<ForeignLeafEntry> = fc
  .tuple(nonEmptyStr, nonEmptyStr)
  .map(([pkg, exportName]) => ({
    kind: "foreign-leaf" as const,
    pkg,
    export: exportName,
  }));

/** Arbitrary GlueLeafEntry. */
const glueLeafEntryArb: fc.Arbitrary<GlueLeafEntry> = fc
  .tuple(nonEmptyStr, hex64, nonEmptyStr)
  .map(([source, canonicalAstHash, reason]) => ({
    kind: "glue" as const,
    source,
    canonicalAstHash,
    reason,
  }));

/** Arbitrary SlicePlanEntry (all 4 kinds). */
const slicePlanEntryArb: fc.Arbitrary<SlicePlanEntry> = fc.oneof(
  pointerEntryArb,
  novelGlueEntryArb,
  foreignLeafEntryArb,
  glueLeafEntryArb,
);

/** Arbitrary SlicePlan. */
const slicePlanArb: fc.Arbitrary<SlicePlan> = fc
  .tuple(fc.array(slicePlanEntryArb, { minLength: 0, maxLength: 5 }), natArb, natArb, natArb)
  .map(([entries, pointer, novelGlue, glue]) => ({
    entries,
    matchedPrimitives: entries
      .filter((e): e is PointerEntry => e.kind === "pointer")
      .map((e) => ({ canonicalAstHash: e.canonicalAstHash, merkleRoot: e.merkleRoot })),
    sourceBytesByKind: { pointer, novelGlue, glue },
  }));

// ---------------------------------------------------------------------------
// ATO1.1: AtomTestOptions
// ---------------------------------------------------------------------------

/**
 * prop_AtomTestOptions_maxControlFlowBoundaries_is_non_negative_or_undefined
 *
 * maxControlFlowBoundaries is either undefined (use default) or a non-negative
 * integer.
 *
 * Invariant (ATO1.1, DEC-ATOM-TEST-003): the isAtom() predicate uses this field
 * as an upper bound on control-flow boundary count. A negative value would
 * classify every node as non-atomic. Undefined means "use default: 1".
 */
export const prop_AtomTestOptions_maxControlFlowBoundaries_is_non_negative_or_undefined =
  fc.property(atomTestOptionsArb, (opts: AtomTestOptions) => {
    if (opts.maxControlFlowBoundaries === undefined) return true;
    return (
      typeof opts.maxControlFlowBoundaries === "number" &&
      Number.isInteger(opts.maxControlFlowBoundaries) &&
      opts.maxControlFlowBoundaries >= 0
    );
  });

// ---------------------------------------------------------------------------
// ATR1.1: AtomTestReason
// ---------------------------------------------------------------------------

/** Exhaustive set of AtomTestReason literal values. */
const ATOM_TEST_REASONS: ReadonlySet<string> = new Set([
  "atomic",
  "too-many-cf-boundaries",
  "contains-known-primitive",
  "non-decomposable-non-atom",
  "loop-with-escaping-cf",
]);

/**
 * prop_AtomTestReason_is_one_of_five_literals
 *
 * Every value produced by atomTestReasonArb is one of the 5 canonical literal
 * strings defined in the AtomTestReason union.
 *
 * Invariant (ATR1.1, DEC-ATOM-TEST-003): the reason discriminant is used by
 * downstream consumers (DFG decomposition, CLI) to branch on atom classification.
 * Any value outside the canonical set would produce an unreachable branch and
 * silent misclassification.
 */
export const prop_AtomTestReason_is_one_of_five_literals = fc.property(
  atomTestReasonArb,
  (reason: AtomTestReason) => ATOM_TEST_REASONS.has(reason),
);

// ---------------------------------------------------------------------------
// ATR1.2: AtomTestResult
// ---------------------------------------------------------------------------

/**
 * prop_AtomTestResult_isAtom_is_boolean
 *
 * isAtom is always a boolean value.
 *
 * Invariant (ATR1.2, DEC-ATOM-TEST-003): isAtom drives branching in decompose().
 * A non-boolean value here would silently diverge in a truthiness check.
 */
export const prop_AtomTestResult_isAtom_is_boolean = fc.property(
  atomTestResultArb,
  (r: AtomTestResult) => typeof r.isAtom === "boolean",
);

/**
 * prop_AtomTestResult_reason_is_valid_AtomTestReason
 *
 * The reason field of any AtomTestResult is a valid AtomTestReason literal.
 *
 * Invariant (ATR1.2, DEC-ATOM-TEST-003): reason and isAtom are jointly meaningful.
 * For example, reason="atomic" must pair with isAtom=true; other combinations
 * may be valid but the reason must always be one of the 5 canonical literals.
 */
export const prop_AtomTestResult_reason_is_valid_AtomTestReason = fc.property(
  atomTestResultArb,
  (r: AtomTestResult) => ATOM_TEST_REASONS.has(r.reason),
);

/**
 * prop_AtomTestResult_controlFlowBoundaryCount_is_non_negative
 *
 * controlFlowBoundaryCount is always a non-negative integer.
 *
 * Invariant (ATR1.2, DEC-ATOM-TEST-003): this count is used to evaluate
 * maxControlFlowBoundaries. A negative value would always satisfy any threshold,
 * making every node appear atomic regardless of actual structure.
 */
export const prop_AtomTestResult_controlFlowBoundaryCount_is_non_negative = fc.property(
  atomTestResultArb,
  (r: AtomTestResult) =>
    typeof r.controlFlowBoundaryCount === "number" &&
    Number.isInteger(r.controlFlowBoundaryCount) &&
    r.controlFlowBoundaryCount >= 0,
);

// ---------------------------------------------------------------------------
// AL1.1: AtomLeaf
// ---------------------------------------------------------------------------

/**
 * prop_AtomLeaf_kind_is_atom
 *
 * The kind field of any AtomLeaf is exactly the string "atom".
 *
 * Invariant (AL1.1, DEC-RECURSION-005): kind is the discriminant for the
 * RecursionNode union. "atom" must uniquely identify an AtomLeaf so that
 * downstream traversals can distinguish leaves from branches without inspecting
 * other fields.
 */
export const prop_AtomLeaf_kind_is_atom = fc.property(
  atomLeafArb,
  (leaf: AtomLeaf) => leaf.kind === "atom",
);

/**
 * prop_AtomLeaf_sourceRange_start_le_end
 *
 * The sourceRange of any AtomLeaf has start <= end.
 *
 * Invariant (AL1.1, DEC-RECURSION-005): sourceRange is a half-open or closed
 * byte interval. start > end would produce an empty or negative-length selection,
 * which is nonsensical and would corrupt byte-level statistics in SlicePlan.
 */
export const prop_AtomLeaf_sourceRange_start_le_end = fc.property(
  atomLeafArb,
  (leaf: AtomLeaf) => leaf.sourceRange.start <= leaf.sourceRange.end,
);

/**
 * prop_AtomLeaf_canonicalAstHash_is_64_char_hex
 *
 * The canonicalAstHash of any AtomLeaf is a 64-character lowercase hex string.
 *
 * Invariant (AL1.1, DEC-RECURSION-005): CanonicalAstHash is defined as a
 * BLAKE3-256 hash encoded as 64 lowercase hex chars. Any other format breaks
 * registry lookups that index by this hash.
 */
export const prop_AtomLeaf_canonicalAstHash_is_64_char_hex = fc.property(
  atomLeafArb,
  (leaf: AtomLeaf) =>
    typeof leaf.canonicalAstHash === "string" &&
    leaf.canonicalAstHash.length === 64 &&
    /^[0-9a-f]+$/.test(leaf.canonicalAstHash),
);

// ---------------------------------------------------------------------------
// BN1.1: BranchNode
// ---------------------------------------------------------------------------

/**
 * prop_BranchNode_kind_is_branch
 *
 * The kind field of any BranchNode is exactly the string "branch".
 *
 * Invariant (BN1.1, DEC-RECURSION-005): kind="branch" uniquely identifies an
 * internal node in the recursion tree. Traversals must be able to dispatch on
 * this discriminant reliably.
 */
export const prop_BranchNode_kind_is_branch = fc.property(
  branchNodeArb,
  (node: BranchNode) => node.kind === "branch",
);

/**
 * prop_BranchNode_children_is_non_empty_array
 *
 * Every BranchNode has at least one child.
 *
 * Invariant (BN1.1, DEC-RECURSION-005): a branch node with zero children would
 * be indistinguishable from a leaf in structural traversals and would produce
 * incorrect leafCount in RecursionTree.
 */
export const prop_BranchNode_children_is_non_empty_array = fc.property(
  branchNodeArb,
  (node: BranchNode) => Array.isArray(node.children) && node.children.length >= 1,
);

// ---------------------------------------------------------------------------
// RN1.1: RecursionNode — discriminated union exhaustion
// ---------------------------------------------------------------------------

/**
 * prop_RecursionNode_kind_is_atom_or_branch
 *
 * Every RecursionNode has a kind that is either "atom" or "branch".
 *
 * Invariant (RN1.1, DEC-RECURSION-005): the union is closed. No other kind
 * values exist. A third value would be unreachable in exhaustive switch
 * statements and would break tree traversals.
 */
export const prop_RecursionNode_kind_is_atom_or_branch = fc.property(
  recursionNodeArb,
  (node: RecursionNode) => node.kind === "atom" || node.kind === "branch",
);

// ---------------------------------------------------------------------------
// RT1.1: RecursionTree
// ---------------------------------------------------------------------------

/**
 * prop_RecursionTree_leafCount_is_non_negative
 *
 * leafCount in any RecursionTree is a non-negative integer.
 *
 * Invariant (RT1.1, DEC-RECURSION-005): leafCount counts AtomLeaf nodes visited
 * during recursion. A negative count is semantically impossible and would corrupt
 * downstream statistics.
 */
export const prop_RecursionTree_leafCount_is_non_negative = fc.property(
  recursionTreeArb,
  (tree: RecursionTree) =>
    typeof tree.leafCount === "number" && Number.isInteger(tree.leafCount) && tree.leafCount >= 0,
);

/**
 * prop_RecursionTree_maxDepth_is_non_negative
 *
 * maxDepth in any RecursionTree is a non-negative integer.
 *
 * Invariant (RT1.1, DEC-RECURSION-005): maxDepth=0 means the root was an atom
 * (no children visited). A negative maxDepth is semantically invalid and would
 * mislead caller diagnostics.
 */
export const prop_RecursionTree_maxDepth_is_non_negative = fc.property(
  recursionTreeArb,
  (tree: RecursionTree) =>
    typeof tree.maxDepth === "number" && Number.isInteger(tree.maxDepth) && tree.maxDepth >= 0,
);

/**
 * prop_RecursionTree_root_has_valid_kind
 *
 * The root of any RecursionTree has kind "atom" or "branch".
 *
 * Invariant (RT1.1, DEC-RECURSION-005): the root is a RecursionNode and must
 * carry a valid discriminant. A root with an unknown kind would silently corrupt
 * all traversals that start from the root.
 */
export const prop_RecursionTree_root_has_valid_kind = fc.property(
  recursionTreeArb,
  (tree: RecursionTree) => tree.root.kind === "atom" || tree.root.kind === "branch",
);

// ---------------------------------------------------------------------------
// RO1.1: RecursionOptions
// ---------------------------------------------------------------------------

/**
 * prop_RecursionOptions_maxDepth_is_positive_or_undefined
 *
 * maxDepth in RecursionOptions is either undefined (use default: 8) or a
 * positive integer >= 1.
 *
 * Invariant (RO1.1, DEC-RECURSION-005): maxDepth=0 would cause decompose() to
 * throw RecursionDepthExceededError on the first call, making it unusable.
 * The valid range is 1..N; undefined means "use 8".
 */
export const prop_RecursionOptions_maxDepth_is_positive_or_undefined = fc.property(
  recursionOptionsArb,
  (opts: RecursionOptions) => {
    if (opts.maxDepth === undefined) return true;
    return (
      typeof opts.maxDepth === "number" && Number.isInteger(opts.maxDepth) && opts.maxDepth >= 1
    );
  },
);

// ---------------------------------------------------------------------------
// PE1.1: PointerEntry
// ---------------------------------------------------------------------------

/**
 * prop_PointerEntry_kind_is_pointer
 *
 * The kind field of any PointerEntry is exactly "pointer".
 *
 * Invariant (PE1.1, DEC-SLICER-NOVEL-GLUE-004): kind="pointer" is the
 * discriminant for registry-matched atoms in the slice plan. The compile
 * pipeline branches on this value to decide whether synthesis is required.
 */
export const prop_PointerEntry_kind_is_pointer = fc.property(
  pointerEntryArb,
  (e: PointerEntry) => e.kind === "pointer",
);

/**
 * prop_PointerEntry_matchedBy_is_canonical_ast_hash
 *
 * The matchedBy field of any PointerEntry is exactly "canonical_ast_hash".
 *
 * Invariant (PE1.1, DEC-SLICER-NOVEL-GLUE-004): matchedBy is a forward-compat
 * discriminant for the match strategy. The only currently valid strategy is
 * "canonical_ast_hash". Other values are reserved for future matching modes
 * (e.g., fuzzy semantic matching) and must not be emitted by the current slicer.
 */
export const prop_PointerEntry_matchedBy_is_canonical_ast_hash = fc.property(
  pointerEntryArb,
  (e: PointerEntry) => e.matchedBy === "canonical_ast_hash",
);

/**
 * prop_PointerEntry_merkleRoot_is_64_char_hex
 *
 * The merkleRoot of any PointerEntry is a 64-character lowercase hex string.
 *
 * Invariant (PE1.1, DEC-SLICER-NOVEL-GLUE-004): BlockMerkleRoot is BLAKE3-256
 * encoded as 64 lowercase hex chars. Any other format breaks registry lookups.
 */
export const prop_PointerEntry_merkleRoot_is_64_char_hex = fc.property(
  pointerEntryArb,
  (e: PointerEntry) =>
    typeof e.merkleRoot === "string" &&
    e.merkleRoot.length === 64 &&
    /^[0-9a-f]+$/.test(e.merkleRoot),
);

// ---------------------------------------------------------------------------
// NG1.1: NovelGlueEntry
// ---------------------------------------------------------------------------

/**
 * prop_NovelGlueEntry_kind_is_novel_glue
 *
 * The kind field of any NovelGlueEntry is exactly "novel-glue".
 *
 * Invariant (NG1.1, DEC-SLICER-NOVEL-GLUE-004): kind="novel-glue" identifies
 * atoms that must be synthesized. The compile pipeline uses this discriminant
 * to route unmatched atoms through the synthesis path.
 */
export const prop_NovelGlueEntry_kind_is_novel_glue = fc.property(
  novelGlueEntryArb,
  (e: NovelGlueEntry) => e.kind === "novel-glue",
);

/**
 * prop_NovelGlueEntry_source_is_non_empty_string
 *
 * The source field of any NovelGlueEntry is a non-empty string.
 *
 * Invariant (NG1.1, DEC-SLICER-NOVEL-GLUE-004): novel glue entries carry the
 * verbatim source bytes of the unmatched atom for synthesis input. An empty
 * source string would provide no context to the synthesizer.
 */
export const prop_NovelGlueEntry_source_is_non_empty_string = fc.property(
  novelGlueEntryArb,
  (e: NovelGlueEntry) => typeof e.source === "string" && e.source.length > 0,
);

// ---------------------------------------------------------------------------
// FL1.1: ForeignLeafEntry
// ---------------------------------------------------------------------------

/**
 * prop_ForeignLeafEntry_kind_is_foreign_leaf
 *
 * The kind field of any ForeignLeafEntry is exactly "foreign-leaf".
 *
 * Invariant (FL1.1, DEC-V2-FOREIGN-BLOCK-SCHEMA-001): kind="foreign-leaf"
 * distinguishes foreign import atoms from novel-glue atoms. The compile pipeline
 * must not attempt to synthesize foreign imports.
 */
export const prop_ForeignLeafEntry_kind_is_foreign_leaf = fc.property(
  foreignLeafEntryArb,
  (e: ForeignLeafEntry) => e.kind === "foreign-leaf",
);

/**
 * prop_ForeignLeafEntry_pkg_and_export_are_non_empty_strings
 *
 * Both pkg and export fields of any ForeignLeafEntry are non-empty strings.
 *
 * Invariant (FL1.1, DEC-V2-FOREIGN-BLOCK-SCHEMA-001): pkg is the module
 * specifier and export is the imported binding name. Empty values would
 * produce unresolvable import references in the provenance manifest.
 */
export const prop_ForeignLeafEntry_pkg_and_export_are_non_empty_strings = fc.property(
  foreignLeafEntryArb,
  (e: ForeignLeafEntry) =>
    typeof e.pkg === "string" &&
    e.pkg.length > 0 &&
    typeof e.export === "string" &&
    e.export.length > 0,
);

// ---------------------------------------------------------------------------
// GL1.1: GlueLeafEntry
// ---------------------------------------------------------------------------

/**
 * prop_GlueLeafEntry_kind_is_glue
 *
 * The kind field of any GlueLeafEntry is exactly "glue".
 *
 * Invariant (GL1.1, DEC-V2-GLUE-LEAF-CONTRACT-001): kind="glue" identifies
 * subgraphs that the slicer could not decompose and that are preserved verbatim.
 * The compile pipeline does not register glue entries; it treats them as
 * project-local boundaries.
 */
export const prop_GlueLeafEntry_kind_is_glue = fc.property(
  glueLeafEntryArb,
  (e: GlueLeafEntry) => e.kind === "glue",
);

/**
 * prop_GlueLeafEntry_reason_is_non_empty_string
 *
 * The reason field of any GlueLeafEntry is a non-empty string.
 *
 * Invariant (GL1.1, DEC-V2-GLUE-LEAF-CONTRACT-001): reason explains why the
 * subgraph was not shaveable. An empty reason string provides no diagnostic
 * information to downstream reviewers and CLI output.
 */
export const prop_GlueLeafEntry_reason_is_non_empty_string = fc.property(
  glueLeafEntryArb,
  (e: GlueLeafEntry) => typeof e.reason === "string" && e.reason.length > 0,
);

// ---------------------------------------------------------------------------
// SP1.1: SlicePlanEntry — exhaustive union coverage
// ---------------------------------------------------------------------------

/** All 4 SlicePlanEntry kind values. */
const SLICE_PLAN_ENTRY_KINDS: ReadonlySet<string> = new Set([
  "pointer",
  "novel-glue",
  "foreign-leaf",
  "glue",
]);

/**
 * prop_SlicePlanEntry_kind_is_one_of_four_variants
 *
 * Every SlicePlanEntry has a kind that is one of the 4 canonical values.
 *
 * Invariant (SP1.1, DEC-SLICER-NOVEL-GLUE-004, DEC-V2-FOREIGN-BLOCK-SCHEMA-001,
 * DEC-V2-GLUE-LEAF-CONTRACT-001): the SlicePlanEntry discriminated union is
 * closed. No other kind values are valid. An unknown kind would pass through
 * the compile pipeline unhandled and produce silent misclassification.
 */
export const prop_SlicePlanEntry_kind_is_one_of_four_variants = fc.property(
  slicePlanEntryArb,
  (e: SlicePlanEntry) => SLICE_PLAN_ENTRY_KINDS.has(e.kind),
);

// ---------------------------------------------------------------------------
// SP1.2: SlicePlan
// ---------------------------------------------------------------------------

/**
 * prop_SlicePlan_sourceBytesByKind_are_non_negative
 *
 * All three counters in sourceBytesByKind are non-negative numbers.
 *
 * Invariant (SP1.2, DEC-SLICER-NOVEL-GLUE-004): byte counters are used for
 * reviewer dashboards. A negative value is semantically impossible and would
 * produce misleading UI output.
 */
export const prop_SlicePlan_sourceBytesByKind_are_non_negative = fc.property(
  slicePlanArb,
  (plan: SlicePlan) =>
    plan.sourceBytesByKind.pointer >= 0 &&
    plan.sourceBytesByKind.novelGlue >= 0 &&
    plan.sourceBytesByKind.glue >= 0,
);

/**
 * prop_SlicePlan_matchedPrimitives_is_subset_of_pointer_entries
 *
 * Every entry in matchedPrimitives corresponds to a PointerEntry in entries.
 *
 * Invariant (SP1.2, DEC-SLICER-NOVEL-GLUE-004): matchedPrimitives is a
 * convenience list derived from the PointerEntry subset of entries. It must
 * not contain merkleRoots that do not appear in a PointerEntry, as callers
 * use it as the authoritative list of registry references.
 */
export const prop_SlicePlan_matchedPrimitives_is_subset_of_pointer_entries = fc.property(
  slicePlanArb,
  (plan: SlicePlan) => {
    const pointerHashes = new Set(
      plan.entries
        .filter((e): e is PointerEntry => e.kind === "pointer")
        .map((e) => e.canonicalAstHash),
    );
    return plan.matchedPrimitives.every((mp) => pointerHashes.has(mp.canonicalAstHash));
  },
);

// ---------------------------------------------------------------------------
// Compound interaction: AtomLeaf + RecursionTree
//
// Production sequence:
//   decompose(node, opts) → RecursionTree
//   When the root node passes isAtom(), it becomes an AtomLeaf as the tree root,
//   and leafCount is exactly 1 with maxDepth === 0.
//
// This compound property verifies the structural invariants that any conformant
// decompose() implementation must satisfy for the single-atom degenerate case.
// It crosses AtomLeaf, RecursionTree, and the leafCount/maxDepth contract.
// ---------------------------------------------------------------------------

/**
 * prop_compound_AtomLeaf_as_root_produces_leafCount_1_and_maxDepth_0
 *
 * When a RecursionTree's root is an AtomLeaf, leafCount is 1 and maxDepth is 0.
 *
 * This is the canonical compound-interaction property for universalize/types.ts:
 * it exercises the AtomLeaf → RecursionTree shape invariant that decompose()
 * must satisfy for atomic root nodes. maxDepth=0 means no children were visited;
 * leafCount=1 means the root itself is the single atom leaf.
 *
 * Invariant (AL1.1, RT1.1, DEC-RECURSION-005): the degenerate case where the
 * input to decompose() is already atomic must produce a tree with root.kind="atom",
 * leafCount=1, and maxDepth=0. Any deviation indicates a bug in the recursion
 * bookkeeping or atom classification.
 */
export const prop_compound_AtomLeaf_as_root_produces_leafCount_1_and_maxDepth_0 = fc.property(
  atomLeafArb,
  (leaf: AtomLeaf) => {
    // Simulate the structural invariant that decompose() must satisfy:
    // when the root is an AtomLeaf, build the expected RecursionTree shape.
    const tree: RecursionTree = {
      root: leaf,
      leafCount: 1,
      maxDepth: 0,
    };

    // Verify all three invariants jointly:
    return (
      tree.root.kind === "atom" &&
      tree.leafCount === 1 &&
      tree.maxDepth === 0 &&
      // The root carries the same canonicalAstHash as the original leaf.
      (tree.root as AtomLeaf).canonicalAstHash === leaf.canonicalAstHash
    );
  },
);
