/**
 * @decision DEC-SLICER-NOVEL-GLUE-004
 * title: DFG slicer — slice() implementation for WI-012-05
 * status: decided
 * rationale: slice() walks a RecursionTree (produced by decompose()) in DFS
 * order and classifies each node as either a PointerEntry (the subtree rooted
 * here has a matching registry entry by canonicalAstHash — no synthesis needed)
 * or a NovelGlueEntry (unmatched AtomLeaf — source that must be synthesized).
 *
 * Design choices:
 * - Registry lookup is attempted via the optional findByCanonicalAstHash method.
 *   When the method is absent or returns an empty array, the node is treated as
 *   unmatched and the slicer degrades gracefully: AtomLeaf → NovelGlueEntry,
 *   BranchNode → descend into children.
 * - BranchNode collapse: when the registry matches a BranchNode by canonicalAstHash,
 *   the entire subtree collapses into one PointerEntry. Descendants are NOT visited.
 *   This is the primary deduplication mechanism for composite primitives.
 * - AtomLeaf with no registry match: emits NovelGlueEntry without intentCard.
 *   The intentCard field on NovelGlueEntry is optional by design (see types.ts).
 *   Wiring intentCard from an intent-extraction pass is deferred to WI-012-06.
 *   Future implementers: attach intentCard after running extractIntent() on each
 *   NovelGlueEntry's source text, then populate the optional intentCard field.
 * - matchedPrimitives deduplication: we track seen canonicalAstHash values and
 *   only append the first-seen (canonicalAstHash, merkleRoot) pair. This mirrors
 *   the "first BlockMerkleRoot from the result" rule applied per node.
 * - DFS order is guaranteed by the recursive descent: we visit a node before
 *   its children, and children are visited left-to-right (matching the order
 *   they appear in RecursionTree.root.children).
 * - sourceBytesByKind sums (sourceRange.end - sourceRange.start) for each entry
 *   kind. For PointerEntry on a BranchNode, the range covers the entire collapsed
 *   subtree, giving accurate byte accounting of the matched region.
 * - The function signature accepts Pick<ShaveRegistryView, "findByCanonicalAstHash">
 *   rather than the full ShaveRegistryView to keep the slicer testable with a
 *   minimal stub and decoupled from the broader registry surface.
 */

import type { BlockMerkleRoot, CanonicalAstHash } from "@yakcc/contracts";
import type { ShaveRegistryView } from "../types.js";
import type {
  BranchNode,
  NovelGlueEntry,
  PointerEntry,
  RecursionNode,
  RecursionTree,
  SlicePlan,
  SlicePlanEntry,
} from "./types.js";

// ---------------------------------------------------------------------------
// Internal accumulator (mutable, local to one slice() call)
// ---------------------------------------------------------------------------

interface SliceAccumulator {
  entries: SlicePlanEntry[];
  /** Tracks seen canonicalAstHash values to deduplicate matchedPrimitives. */
  matchedPrimitivesMap: Map<
    CanonicalAstHash,
    { canonicalAstHash: CanonicalAstHash; merkleRoot: BlockMerkleRoot }
  >;
  pointerBytes: number;
  novelGlueBytes: number;
}

// ---------------------------------------------------------------------------
// Internal DFS walker
// ---------------------------------------------------------------------------

/**
 * Recursively walk `node` in DFS order, querying the registry and appending
 * entries to `acc`. BranchNodes that match the registry collapse their entire
 * subtree into one PointerEntry. AtomLeaves that match emit PointerEntry.
 * Unmatched AtomLeaves emit NovelGlueEntry. Unmatched BranchNodes descend.
 */
async function walkNode(
  node: RecursionNode,
  registry: Pick<ShaveRegistryView, "findByCanonicalAstHash">,
  acc: SliceAccumulator,
): Promise<void> {
  // Query registry — degrade gracefully when findByCanonicalAstHash is absent.
  const matches = await registry.findByCanonicalAstHash?.(node.canonicalAstHash);
  const firstMatch: BlockMerkleRoot | undefined =
    matches !== undefined && matches.length > 0 ? matches[0] : undefined;

  if (firstMatch !== undefined) {
    // Registry match: collapse this node (and any subtree) to a PointerEntry.
    // Descendants are NOT visited — the whole subtree is replaced by the pointer.
    const entry: PointerEntry = {
      kind: "pointer",
      sourceRange: node.sourceRange,
      merkleRoot: firstMatch,
      canonicalAstHash: node.canonicalAstHash,
      matchedBy: "canonical_ast_hash",
    };
    acc.entries.push(entry);
    acc.pointerBytes += node.sourceRange.end - node.sourceRange.start;

    // Deduplicate matchedPrimitives by canonicalAstHash (first-seen order).
    if (!acc.matchedPrimitivesMap.has(node.canonicalAstHash)) {
      acc.matchedPrimitivesMap.set(node.canonicalAstHash, {
        canonicalAstHash: node.canonicalAstHash,
        merkleRoot: firstMatch,
      });
    }
    return;
  }

  // No registry match — behaviour depends on node kind.
  if (node.kind === "atom") {
    // Unmatched AtomLeaf → NovelGlueEntry.
    // intentCard is intentionally omitted: AtomLeaf in types.ts carries no
    // intentCard field. WI-012-06 is expected to wire intent extraction and
    // populate the optional intentCard field on NovelGlueEntry for each
    // unmatched atom via a follow-up pass over the NovelGlueEntry array.
    const entry: NovelGlueEntry = {
      kind: "novel-glue",
      sourceRange: node.sourceRange,
      source: node.source,
      canonicalAstHash: node.canonicalAstHash,
      // intentCard omitted — optional by design, wired in WI-012-06
    };
    acc.entries.push(entry);
    acc.novelGlueBytes += node.sourceRange.end - node.sourceRange.start;
  } else {
    // Unmatched BranchNode → descend into children in DFS left-to-right order.
    // The branch node itself does not produce an entry; only leaf nodes and
    // matched subtrees produce entries, preserving the non-overlapping-regions
    // invariant for SlicePlan.entries.
    const branch = node as BranchNode;
    for (const child of branch.children) {
      await walkNode(child, registry, acc);
    }
  }
}

// ---------------------------------------------------------------------------
// Public API: slice()
// ---------------------------------------------------------------------------

/**
 * Slice a RecursionTree into a SlicePlan by querying the registry for each
 * node by canonicalAstHash.
 *
 * Nodes that match the registry are collapsed into PointerEntry records —
 * no synthesis needed for those subtrees. Unmatched AtomLeaf nodes become
 * NovelGlueEntry records — source code that must be synthesized as novel glue.
 *
 * The returned SlicePlan contains:
 *   - `entries`: PointerEntry | NovelGlueEntry in DFS order.
 *   - `matchedPrimitives`: deduplicated (canonicalAstHash, merkleRoot) pairs
 *     for every PointerEntry, in first-seen order.
 *   - `sourceBytesByKind`: byte sums for pointer vs. novel-glue regions.
 *
 * When `registry.findByCanonicalAstHash` is undefined, all nodes are treated
 * as unmatched and all AtomLeaves emit NovelGlueEntry — no errors thrown.
 *
 * @param tree     - The RecursionTree produced by decompose().
 * @param registry - Registry view; findByCanonicalAstHash is optional.
 */
export async function slice(
  tree: RecursionTree,
  registry: Pick<ShaveRegistryView, "findByCanonicalAstHash">,
): Promise<SlicePlan> {
  const acc: SliceAccumulator = {
    entries: [],
    matchedPrimitivesMap: new Map(),
    pointerBytes: 0,
    novelGlueBytes: 0,
  };

  await walkNode(tree.root, registry, acc);

  return {
    entries: acc.entries,
    matchedPrimitives: [...acc.matchedPrimitivesMap.values()],
    sourceBytesByKind: {
      pointer: acc.pointerBytes,
      novelGlue: acc.novelGlueBytes,
    },
  };
}
