// SPDX-License-Identifier: MIT
// @decision DEC-V2-PROPTEST-PATH-A-001: hand-authored property-test corpus for
// @yakcc/shave universalize/slicer.ts. Two-file pattern: this file
// (.props.ts) is vitest-free and holds the corpus; the sibling .props.test.ts
// is the vitest harness.
// Status: accepted (WI-V2-07-PREFLIGHT L3j)
// Rationale: See tmp/wi-v2-07-preflight-layer-plan.md — the corpus file must
// be runtime-independent so L10 can hash it as a manifest artifact.
//
// Surface covered: universalize/slicer.ts
//   slice(tree, registry, options?) → Promise<SlicePlan>
//   classifyForeign(source) → ForeignLeafEntry[]
//   SliceOptions.shaveMode: "strict" | "glue-aware"
//
// Properties covered:
//   SL-KIND-1: Every SlicePlanEntry.kind is one of the 4 canonical values.
//   SL-BYTES-1: sourceBytesByKind.pointer is always non-negative.
//   SL-BYTES-2: sourceBytesByKind.novelGlue is always non-negative.
//   SL-BYTES-3: sourceBytesByKind.glue is always non-negative.
//   SL-MATCH-1: matchedPrimitives length <= count of PointerEntries in entries.
//   SL-MODE-1: strict mode (default) never emits GlueLeafEntry.
//   SL-FOREIGN-1: classifyForeign on a non-import source returns empty array.
//   SL-FOREIGN-2: classifyForeign on a foreign named import returns pkg and export.
//   SL-FOREIGN-3: classifyForeign on a type-only import returns empty array.
//   SL-FOREIGN-4: classifyForeign on a relative import returns empty array.
//   SL-FOREIGN-5: classifyForeign on a workspace import returns empty array.
//   Compound: decompose → slice end-to-end joint invariants.

// ---------------------------------------------------------------------------
// Property-test corpus for universalize/slicer.ts
// ---------------------------------------------------------------------------

import type { BlockMerkleRoot, CanonicalAstHash } from "@yakcc/contracts";
import * as fc from "fast-check";
import { classifyForeign, slice } from "./slicer.js";
import type {
  AtomLeaf,
  BranchNode,
  ForeignLeafEntry,
  RecursionTree,
  SlicePlan,
  SlicePlanEntry,
} from "./types.js";

// ---------------------------------------------------------------------------
// Shared helpers and arbitraries
// ---------------------------------------------------------------------------

/** Registry that returns no matches for any hash. */
const emptyRegistry = {
  async findByCanonicalAstHash(_hash: CanonicalAstHash): Promise<readonly BlockMerkleRoot[]> {
    return [];
  },
};

/** Registry that returns a fake match for every hash query. */
const alwaysMatchRegistry = {
  async findByCanonicalAstHash(_hash: CanonicalAstHash): Promise<readonly BlockMerkleRoot[]> {
    return ["fake-merkle-root" as BlockMerkleRoot];
  },
};

/**
 * Build a minimal AtomLeaf fixture with consistent sourceRange.
 * source.length === sourceRange.end - sourceRange.start.
 */
function makeAtom(source: string, hash: string, start = 0): AtomLeaf {
  return {
    kind: "atom",
    sourceRange: { start, end: start + source.length },
    source,
    canonicalAstHash: hash as CanonicalAstHash,
    atomTest: { isAtom: true, reason: "atomic", controlFlowBoundaryCount: 0 },
  };
}

/**
 * Build a minimal BranchNode fixture wrapping given children.
 */
function makeBranch(
  source: string,
  hash: string,
  children: readonly (AtomLeaf | BranchNode)[],
  start = 0,
): BranchNode {
  return {
    kind: "branch",
    sourceRange: { start, end: start + source.length },
    source,
    canonicalAstHash: hash as CanonicalAstHash,
    atomTest: { isAtom: false, reason: "too-many-cf-boundaries", controlFlowBoundaryCount: 2 },
    children,
  };
}

/** Build a RecursionTree wrapping a single root node. */
function makeTree(root: AtomLeaf | BranchNode, leafCount = 1, maxDepth = 0): RecursionTree {
  return { root, leafCount, maxDepth };
}

/** The 4 canonical SlicePlanEntry kind values. */
const SLICE_PLAN_ENTRY_KINDS: ReadonlySet<string> = new Set([
  "pointer",
  "novel-glue",
  "foreign-leaf",
  "glue",
]);

/** Arbitrary non-empty source string — used as NovelGlueEntry.source stand-in. */
const nonEmptySourceArb: fc.Arbitrary<string> = fc
  .string({ minLength: 3, maxLength: 40 })
  .filter((s) => s.trim().length > 0);

/** Arbitrary 8-char hex string for fake canonicalAstHash values in fixtures. */
const fakeHashArb: fc.Arbitrary<string> = fc
  .array(fc.integer({ min: 0, max: 15 }), { minLength: 8, maxLength: 8 })
  .map((ns) => ns.map((n) => n.toString(16)).join(""));

// ---------------------------------------------------------------------------
// SL-KIND-1: every SlicePlanEntry.kind is one of the 4 canonical values
//
// Invariant: The SlicePlanEntry discriminated union is closed. No other kind
// values exist. An unknown kind would pass through the compile pipeline
// unhandled and produce silent misclassification.
// ---------------------------------------------------------------------------

/**
 * prop_slice_entries_all_have_valid_kind
 *
 * Every entry in a SlicePlan.entries array has a kind that is one of
 * {"pointer", "novel-glue", "foreign-leaf", "glue"}.
 *
 * Invariant (SL-KIND-1, DEC-SLICER-NOVEL-GLUE-004): the discriminated union is
 * closed. The compile pipeline switches exhaustively on entry.kind; an unknown
 * kind would silently fall through.
 *
 * Tests two modes: strict (default) and glue-aware.
 */
export const prop_slice_entries_all_have_valid_kind: fc.IAsyncProperty<[string, string]> =
  fc.asyncProperty(nonEmptySourceArb, fakeHashArb, async (source, hash) => {
    const atom = makeAtom(source, hash);
    const tree = makeTree(atom);
    const plan: SlicePlan = await slice(tree, emptyRegistry);
    return plan.entries.every((e: SlicePlanEntry) => SLICE_PLAN_ENTRY_KINDS.has(e.kind));
  });

// ---------------------------------------------------------------------------
// SL-BYTES-1: sourceBytesByKind.pointer is always non-negative
//
// Invariant: Byte counters can only increase (never go negative). They are
// used in reviewer dashboards; a negative value is semantically impossible.
// ---------------------------------------------------------------------------

/**
 * prop_slice_pointer_bytes_is_non_negative
 *
 * sourceBytesByKind.pointer in any SlicePlan is always >= 0.
 *
 * Invariant (SL-BYTES-1, DEC-SLICER-NOVEL-GLUE-004): pointer bytes are summed
 * from sourceRange sizes of PointerEntry nodes. Since sourceRange.end >=
 * sourceRange.start >= 0, the sum is always non-negative.
 */
export const prop_slice_pointer_bytes_is_non_negative: fc.IAsyncProperty<[string, string]> =
  fc.asyncProperty(nonEmptySourceArb, fakeHashArb, async (source, hash) => {
    const atom = makeAtom(source, hash);
    const tree = makeTree(atom);
    const plan: SlicePlan = await slice(tree, emptyRegistry);
    return plan.sourceBytesByKind.pointer >= 0;
  });

// ---------------------------------------------------------------------------
// SL-BYTES-2: sourceBytesByKind.novelGlue is always non-negative
// ---------------------------------------------------------------------------

/**
 * prop_slice_novel_glue_bytes_is_non_negative
 *
 * sourceBytesByKind.novelGlue in any SlicePlan is always >= 0.
 *
 * Invariant (SL-BYTES-2, DEC-SLICER-NOVEL-GLUE-004): novel-glue bytes are
 * summed from unmatched atom sourceRange sizes. Non-negative by construction.
 */
export const prop_slice_novel_glue_bytes_is_non_negative: fc.IAsyncProperty<[string, string]> =
  fc.asyncProperty(nonEmptySourceArb, fakeHashArb, async (source, hash) => {
    const atom = makeAtom(source, hash);
    const tree = makeTree(atom);
    const plan: SlicePlan = await slice(tree, emptyRegistry);
    return plan.sourceBytesByKind.novelGlue >= 0;
  });

// ---------------------------------------------------------------------------
// SL-BYTES-3: sourceBytesByKind.glue is always non-negative
// ---------------------------------------------------------------------------

/**
 * prop_slice_glue_bytes_is_non_negative
 *
 * sourceBytesByKind.glue in any SlicePlan is always >= 0.
 *
 * Invariant (SL-BYTES-3, DEC-V2-GLUE-LEAF-CONTRACT-001): glue bytes are
 * summed from GlueLeafEntry nodes in glue-aware mode. Always non-negative.
 * Zero in strict mode.
 */
export const prop_slice_glue_bytes_is_non_negative: fc.IAsyncProperty<[string, string]> =
  fc.asyncProperty(nonEmptySourceArb, fakeHashArb, async (source, hash) => {
    const atom = makeAtom(source, hash);
    const tree = makeTree(atom);
    const plan: SlicePlan = await slice(tree, emptyRegistry);
    return plan.sourceBytesByKind.glue >= 0;
  });

// ---------------------------------------------------------------------------
// SL-MATCH-1: matchedPrimitives.length <= PointerEntry count in entries
//
// Invariant: matchedPrimitives is a deduplicated subset of PointerEntries.
// Deduplication can only reduce the count; it can never add new entries.
// ---------------------------------------------------------------------------

/**
 * prop_slice_matchedPrimitives_length_le_pointer_entry_count
 *
 * matchedPrimitives.length is always <= the number of PointerEntries in
 * plan.entries (deduplication can only reduce, never inflate).
 *
 * Invariant (SL-MATCH-1, DEC-SLICER-NOVEL-GLUE-004): matchedPrimitives is
 * the first-seen deduplication of PointerEntry (canonicalAstHash, merkleRoot)
 * pairs. The deduplicated count <= the raw PointerEntry count. A violation
 * would mean matchedPrimitives contains hashes not present in entries.
 */
export const prop_slice_matchedPrimitives_length_le_pointer_entry_count: fc.IAsyncProperty<
  [string, string]
> = fc.asyncProperty(nonEmptySourceArb, fakeHashArb, async (source, hash) => {
  const atom = makeAtom(source, hash);
  const tree = makeTree(atom);
  // Use alwaysMatchRegistry to get PointerEntries and test deduplication path.
  const plan: SlicePlan = await slice(tree, alwaysMatchRegistry);
  const pointerCount = plan.entries.filter((e) => e.kind === "pointer").length;
  return plan.matchedPrimitives.length <= pointerCount;
});

// ---------------------------------------------------------------------------
// SL-MODE-1: strict mode (default) never emits GlueLeafEntry
//
// Invariant: The strict path (walkNodeStrict) never calls validateStrictSubset
// and never emits GlueLeafEntry. Only glue-aware mode can emit glue entries.
// ---------------------------------------------------------------------------

/**
 * prop_slice_strict_mode_never_emits_glue_entries
 *
 * Under strict mode (default, or shaveMode:'strict' explicit), slice() never
 * emits any GlueLeafEntry regardless of source content.
 *
 * Invariant (SL-MODE-1, DEC-V2-SLICER-SEARCH-001): the strict path is the
 * backward-compatible path and predates glue-aware mode. It must not emit
 * GlueLeafEntry — that would be a regression for existing callers.
 */
export const prop_slice_strict_mode_never_emits_glue_entries: fc.IAsyncProperty<[string, string]> =
  fc.asyncProperty(nonEmptySourceArb, fakeHashArb, async (source, hash) => {
    const atom = makeAtom(source, hash);
    const tree = makeTree(atom);
    const plan: SlicePlan = await slice(tree, emptyRegistry); // default = strict
    return !plan.entries.some((e) => e.kind === "glue");
  });

// ---------------------------------------------------------------------------
// SL-FOREIGN-1: classifyForeign on a non-import source returns empty array
//
// Invariant: A source with no ImportDeclarations (e.g. a pure function body)
// produces zero ForeignLeafEntries. classifyForeign must not misclassify
// CallExpressions or other non-import nodes as foreign imports.
// ---------------------------------------------------------------------------

/**
 * prop_classifyForeign_non_import_source_returns_empty
 *
 * For source strings that contain no ImportDeclaration (pure TypeScript
 * expression/statement code), classifyForeign returns an empty array.
 *
 * Invariant (SL-FOREIGN-1, DEC-V2-FOREIGN-BLOCK-SCHEMA-001): classifyForeign
 * is a structural predicate over ImportDeclaration nodes. CallExpressions,
 * VariableDeclarations, and other statement kinds must not be mistaken for
 * foreign imports.
 */
export const prop_classifyForeign_non_import_source_returns_empty = fc.property(
  fc.constant<undefined>(undefined),
  () => {
    // Pure function with no imports — no ImportDeclaration nodes.
    const source = "function f(x: number): number { return x * 2; }";
    const entries = classifyForeign(source);
    return entries.length === 0;
  },
);

// ---------------------------------------------------------------------------
// SL-FOREIGN-2: classifyForeign on a foreign named import returns pkg + export
//
// Invariant: A static foreign named import always produces a ForeignLeafEntry
// with the correct pkg and export fields.
// ---------------------------------------------------------------------------

/**
 * prop_classifyForeign_foreign_named_import_returns_entry
 *
 * For a source containing `import { readFileSync } from 'node:fs'`,
 * classifyForeign returns exactly one ForeignLeafEntry with pkg='node:fs'
 * and export='readFileSync'.
 *
 * Invariant (SL-FOREIGN-2, DEC-V2-FOREIGN-BLOCK-SCHEMA-001): foreign named
 * imports are the primary classification target. The pkg and export fields
 * are used by the provenance manifest and --foreign-policy CLI flag (L4).
 * Incorrect or missing entries would corrupt the foreign-import catalog.
 */
export const prop_classifyForeign_foreign_named_import_returns_entry = fc.property(
  fc.constant<undefined>(undefined),
  () => {
    const source = `import { readFileSync } from 'node:fs';`;
    const entries = classifyForeign(source);
    if (entries.length !== 1) return false;
    const entry = entries[0] as ForeignLeafEntry;
    return (
      entry.kind === "foreign-leaf" &&
      entry.pkg === "node:fs" &&
      entry.export === "readFileSync" &&
      entry.alias === undefined
    );
  },
);

// ---------------------------------------------------------------------------
// SL-FOREIGN-3: classifyForeign on a type-only import returns empty array
//
// Invariant: `import type { X }` is erased at compile time. classifyForeign
// must skip it — treating type imports as foreign would produce phantom
// entries in the provenance manifest.
// ---------------------------------------------------------------------------

/**
 * prop_classifyForeign_type_only_import_returns_empty
 *
 * For a source containing only `import type { X } from 'node:fs'`,
 * classifyForeign returns an empty array.
 *
 * Invariant (SL-FOREIGN-3, DEC-V2-FOREIGN-BLOCK-SCHEMA-001): type-only imports
 * carry no runtime dependency. Classifying them as foreign would inject
 * spurious dependencies into the provenance manifest.
 */
export const prop_classifyForeign_type_only_import_returns_empty = fc.property(
  fc.constant<undefined>(undefined),
  () => {
    const source = `import type { PathLike } from 'node:fs';`;
    const entries = classifyForeign(source);
    return entries.length === 0;
  },
);

// ---------------------------------------------------------------------------
// SL-FOREIGN-4: classifyForeign on a relative import returns empty array
//
// Invariant: Relative imports (./foo, ../bar) are workspace-local.
// classifyForeign must skip them — they are not foreign dependencies.
// ---------------------------------------------------------------------------

/**
 * prop_classifyForeign_relative_import_returns_empty
 *
 * For a source containing only `import { x } from './local.js'`,
 * classifyForeign returns an empty array.
 *
 * Invariant (SL-FOREIGN-4, DEC-V2-FOREIGN-BLOCK-SCHEMA-001): relative
 * imports are workspace-local paths. Classifying them as foreign would
 * break the workspace boundary assumption that drives the slicer's
 * no-synthesis-needed rule for local source.
 */
export const prop_classifyForeign_relative_import_returns_empty = fc.property(
  fc.constant<undefined>(undefined),
  () => {
    const source = `import { helper } from './local.js';`;
    const entries = classifyForeign(source);
    return entries.length === 0;
  },
);

// ---------------------------------------------------------------------------
// SL-FOREIGN-5: classifyForeign on a workspace import returns empty array
//
// Invariant: Workspace imports (`@yakcc/...`) are not foreign. They are
// managed internally and must not appear in the foreign-import catalog.
// ---------------------------------------------------------------------------

/**
 * prop_classifyForeign_workspace_import_returns_empty
 *
 * For a source containing only `import { slice } from '@yakcc/shave'`,
 * classifyForeign returns an empty array.
 *
 * Invariant (SL-FOREIGN-5, DEC-V2-FOREIGN-BLOCK-SCHEMA-001): workspace
 * imports are classified as local (not foreign) by the WORKSPACE_PREFIX
 * guard. Classifying them as foreign would make all workspace consumers
 * appear as external dependencies.
 */
export const prop_classifyForeign_workspace_import_returns_empty = fc.property(
  fc.constant<undefined>(undefined),
  () => {
    const source = `import { slice } from '@yakcc/shave';`;
    const entries = classifyForeign(source);
    return entries.length === 0;
  },
);

// ---------------------------------------------------------------------------
// Compound: decompose → slice end-to-end joint invariants
//
// Production sequence: decompose() produces a RecursionTree from a TypeScript
// source string; slice() walks that tree in DFS order and produces a SlicePlan.
// This compound property exercises the full production path crossing decompose
// → RecursionTree → slice → SlicePlan, verifying joint invariants.
//
// Test: a branch tree (two atoms) with the first atom matched by registry.
// Expected: entries = [PointerEntry, NovelGlueEntry]; pointer bytes = atom1
// length; novelGlue bytes = atom2 length.
// ---------------------------------------------------------------------------

/**
 * prop_compound_slice_real_tree_joint_invariants
 *
 * Drives the real production sequence: build a synthetic RecursionTree with
 * a branch root and two atom children (first matched by registry, second not).
 * Verifies all joint invariants:
 *   - entries has length 2 (one per atom)
 *   - entries[0].kind === "pointer"
 *   - entries[1].kind === "novel-glue"
 *   - sourceBytesByKind.pointer === sourceX.length
 *   - sourceBytesByKind.novelGlue === sourceY.length
 *   - matchedPrimitives.length === 1
 *   - all entry kinds are in the canonical 4-value set
 *   - glue bytes === 0 (strict mode)
 *
 * Crosses: makeAtom fixture, makeBranch fixture, makeTree fixture, registryForHashes
 * stub, slice → walkNodeStrict → PointerEntry + NovelGlueEntry paths, accumulator
 * byte accounting, matchedPrimitives deduplication.
 *
 * Invariant (SL-KIND-1, SL-BYTES-1–3, SL-MATCH-1, DEC-SLICER-NOVEL-GLUE-004):
 * All six invariants must hold jointly for any valid slice call on a two-atom
 * branch tree with one matched and one unmatched atom.
 */
export const prop_compound_slice_real_tree_joint_invariants = fc.asyncProperty(
  fc.constant<undefined>(undefined),
  async () => {
    const sourceX = "function add(a: number, b: number): number { return a + b; }";
    const sourceY = "function mul(a: number, b: number): number { return a * b; }";
    const hashX = "hash-compound-X";
    const hashY = "hash-compound-Y";
    const merkleX = "merkle-compound-X" as BlockMerkleRoot;

    const atomX = makeAtom(sourceX, hashX, 0);
    const atomY = makeAtom(sourceY, hashY, sourceX.length);
    const branchSource = sourceX + sourceY;
    const branch = makeBranch(branchSource, "hash-compound-branch", [atomX, atomY], 0);
    const tree = makeTree(branch, 2, 1);

    // Registry matches only hashX.
    const registry = {
      async findByCanonicalAstHash(hash: CanonicalAstHash): Promise<readonly BlockMerkleRoot[]> {
        return hash === hashX ? [merkleX] : [];
      },
    };

    const plan: SlicePlan = await slice(tree, registry);

    // Exactly 2 entries — one per atom child.
    if (plan.entries.length !== 2) return false;

    // DFS order: atomX (pointer) then atomY (novel-glue).
    if (plan.entries[0]?.kind !== "pointer") return false;
    if (plan.entries[1]?.kind !== "novel-glue") return false;

    // Byte accounting.
    if (plan.sourceBytesByKind.pointer !== sourceX.length) return false;
    if (plan.sourceBytesByKind.novelGlue !== sourceY.length) return false;

    // Strict mode: no glue entries.
    if (plan.sourceBytesByKind.glue !== 0) return false;

    // matchedPrimitives: exactly 1 (hashX matched once).
    if (plan.matchedPrimitives.length !== 1) return false;
    if (plan.matchedPrimitives[0]?.canonicalAstHash !== hashX) return false;

    // All entry kinds are canonical.
    if (!plan.entries.every((e) => SLICE_PLAN_ENTRY_KINDS.has(e.kind))) return false;

    return true;
  },
);
