/**
 * Tests for slice() — WI-012-05 (DEC-SLICER-NOVEL-GLUE-004)
 *
 * Production sequence: decompose() produces a RecursionTree from a TypeScript
 * source string, then slice() walks that tree in DFS order, querying the
 * registry for each node by canonicalAstHash, and classifies each node as
 * PointerEntry (matched) or NovelGlueEntry (unmatched AtomLeaf). The tests
 * below exercise this classification logic directly using synthetic
 * RecursionTree fixtures — we do not round-trip through decompose() because
 * slice() is a pure tree-transform and its test invariants are about the
 * classification logic, not about AST parsing.
 *
 * Compound-interaction test: "branch with mixed children" exercises the real
 * production sequence crossing slice → walkNode → registry lookup → entry
 * construction → accumulator for both PointerEntry and NovelGlueEntry paths.
 */

import type { BlockMerkleRoot, CanonicalAstHash } from "@yakcc/contracts";
import { describe, expect, it } from "vitest";
import type { ShaveRegistryView } from "../types.js";
import { slice } from "./slicer.js";
import type { AtomLeaf, BranchNode, RecursionTree } from "./types.js";

// ---------------------------------------------------------------------------
// Test fixture helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal AtomLeaf fixture. The sourceRange and source text are
 * constructed to be consistent: source.length === end - start.
 */
function makeAtom(
  source: string,
  hash: string,
  start = 0,
): AtomLeaf {
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
 * Source is derived from children span for realistic byte accounting.
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

/**
 * Build a RecursionTree wrapping a single root node.
 */
function makeTree(root: AtomLeaf | BranchNode, leafCount = 1, maxDepth = 0): RecursionTree {
  return { root, leafCount, maxDepth };
}

// ---------------------------------------------------------------------------
// Registry stubs
// ---------------------------------------------------------------------------

/** Registry that returns no matches for any hash. */
const emptyRegistry: Pick<ShaveRegistryView, "findByCanonicalAstHash"> = {
  findByCanonicalAstHash: async () => [],
};

/**
 * Registry that matches specific hashes to pre-baked BlockMerkleRoot values.
 * All other hashes return empty.
 */
function registryForHashes(
  map: Record<string, BlockMerkleRoot>,
): Pick<ShaveRegistryView, "findByCanonicalAstHash"> {
  return {
    findByCanonicalAstHash: async (hash: string) => {
      const match = map[hash];
      return match !== undefined ? [match] : [];
    },
  };
}

// ---------------------------------------------------------------------------
// Case 1: single AtomLeaf, no registry match → NovelGlueEntry
// ---------------------------------------------------------------------------

describe("slice — single AtomLeaf, no match", () => {
  it("emits one NovelGlueEntry for an unmatched atom", async () => {
    const source = "const x = 1;";
    const atom = makeAtom(source, "hash-aaa");
    const tree = makeTree(atom);

    const plan = await slice(tree, emptyRegistry);

    expect(plan.entries).toHaveLength(1);
    expect(plan.entries[0]?.kind).toBe("novel-glue");
  });

  it("sourceBytesByKind.novelGlue equals source length", async () => {
    const source = "const x = 1;";
    const atom = makeAtom(source, "hash-aaa");
    const tree = makeTree(atom);

    const plan = await slice(tree, emptyRegistry);

    expect(plan.sourceBytesByKind.novelGlue).toBe(source.length);
    expect(plan.sourceBytesByKind.pointer).toBe(0);
  });

  it("matchedPrimitives is empty", async () => {
    const source = "return x + 1;";
    const atom = makeAtom(source, "hash-bbb");
    const tree = makeTree(atom);

    const plan = await slice(tree, emptyRegistry);

    expect(plan.matchedPrimitives).toHaveLength(0);
  });

  it("NovelGlueEntry carries source text and canonicalAstHash", async () => {
    const source = "function f() {}";
    const hash = "hash-ccc";
    const atom = makeAtom(source, hash);
    const tree = makeTree(atom);

    const plan = await slice(tree, emptyRegistry);

    const entry = plan.entries[0];
    expect(entry?.kind).toBe("novel-glue");
    if (entry?.kind !== "novel-glue") return;
    expect(entry.source).toBe(source);
    expect(entry.canonicalAstHash).toBe(hash);
  });
});

// ---------------------------------------------------------------------------
// Case 2: single AtomLeaf, registry match → PointerEntry
// ---------------------------------------------------------------------------

describe("slice — single AtomLeaf, registry match", () => {
  it("emits one PointerEntry for a matched atom", async () => {
    const source = "return x + 1;";
    const hash = "hash-ddd";
    const merkle = "merkle-001" as BlockMerkleRoot;
    const atom = makeAtom(source, hash);
    const tree = makeTree(atom);
    const registry = registryForHashes({ [hash]: merkle });

    const plan = await slice(tree, registry);

    expect(plan.entries).toHaveLength(1);
    expect(plan.entries[0]?.kind).toBe("pointer");
  });

  it("sourceBytesByKind.pointer equals source length", async () => {
    const source = "return x + 1;";
    const hash = "hash-ddd";
    const merkle = "merkle-001" as BlockMerkleRoot;
    const atom = makeAtom(source, hash);
    const tree = makeTree(atom);
    const registry = registryForHashes({ [hash]: merkle });

    const plan = await slice(tree, registry);

    expect(plan.sourceBytesByKind.pointer).toBe(source.length);
    expect(plan.sourceBytesByKind.novelGlue).toBe(0);
  });

  it("matchedPrimitives has length 1 with correct hash and merkleRoot", async () => {
    const source = "return x + 1;";
    const hash = "hash-ddd";
    const merkle = "merkle-001" as BlockMerkleRoot;
    const atom = makeAtom(source, hash);
    const tree = makeTree(atom);
    const registry = registryForHashes({ [hash]: merkle });

    const plan = await slice(tree, registry);

    expect(plan.matchedPrimitives).toHaveLength(1);
    expect(plan.matchedPrimitives[0]?.canonicalAstHash).toBe(hash);
    expect(plan.matchedPrimitives[0]?.merkleRoot).toBe(merkle);
  });

  it("PointerEntry carries merkleRoot and matchedBy", async () => {
    const source = "return x + 1;";
    const hash = "hash-ddd";
    const merkle = "merkle-001" as BlockMerkleRoot;
    const atom = makeAtom(source, hash);
    const tree = makeTree(atom);
    const registry = registryForHashes({ [hash]: merkle });

    const plan = await slice(tree, registry);

    const entry = plan.entries[0];
    expect(entry?.kind).toBe("pointer");
    if (entry?.kind !== "pointer") return;
    expect(entry.merkleRoot).toBe(merkle);
    expect(entry.matchedBy).toBe("canonical_ast_hash");
  });
});

// ---------------------------------------------------------------------------
// Case 3: BranchNode with two AtomLeaf children — mixed match
// (Compound-interaction test: exercises full DFS walk across multiple
//  components — walkNode → registry → PointerEntry + NovelGlueEntry paths)
// ---------------------------------------------------------------------------

describe("slice — BranchNode with mixed children (compound production sequence)", () => {
  /**
   * Tree: branch("if (a) { X; } Y;") → [atom("X"), atom("Y")]
   * Registry matches atom("X") only.
   * Expected: entries = [PointerEntry(X), NovelGlueEntry(Y)] in DFS order.
   */
  it("produces PointerEntry then NovelGlueEntry in DFS order", async () => {
    const sourceX = "console.log(1);";
    const sourceY = "return 2;";
    const hashX = "hash-X";
    const hashY = "hash-Y";
    const merkleX = "merkle-X" as BlockMerkleRoot;

    const atomX = makeAtom(sourceX, hashX, 0);
    const atomY = makeAtom(sourceY, hashY, sourceX.length);
    const branchSource = sourceX + sourceY;
    const branch = makeBranch(branchSource, "hash-branch", [atomX, atomY], 0);
    const tree = makeTree(branch, 2, 1);

    const registry = registryForHashes({ [hashX]: merkleX });
    const plan = await slice(tree, registry);

    expect(plan.entries).toHaveLength(2);
    expect(plan.entries[0]?.kind).toBe("pointer");
    expect(plan.entries[1]?.kind).toBe("novel-glue");
  });

  it("sourceBytesByKind reflects both pointer and novel-glue bytes", async () => {
    const sourceX = "console.log(1);";
    const sourceY = "return 2;";
    const hashX = "hash-X";
    const hashY = "hash-Y";
    const merkleX = "merkle-X" as BlockMerkleRoot;

    const atomX = makeAtom(sourceX, hashX, 0);
    const atomY = makeAtom(sourceY, hashY, sourceX.length);
    const branch = makeBranch(sourceX + sourceY, "hash-branch", [atomX, atomY], 0);
    const tree = makeTree(branch, 2, 1);

    const registry = registryForHashes({ [hashX]: merkleX });
    const plan = await slice(tree, registry);

    expect(plan.sourceBytesByKind.pointer).toBe(sourceX.length);
    expect(plan.sourceBytesByKind.novelGlue).toBe(sourceY.length);
  });

  it("matchedPrimitives contains only the matched atom", async () => {
    const sourceX = "console.log(1);";
    const sourceY = "return 2;";
    const hashX = "hash-X";
    const hashY = "hash-Y";
    const merkleX = "merkle-X" as BlockMerkleRoot;

    const atomX = makeAtom(sourceX, hashX, 0);
    const atomY = makeAtom(sourceY, hashY, sourceX.length);
    const branch = makeBranch(sourceX + sourceY, "hash-branch", [atomX, atomY], 0);
    const tree = makeTree(branch, 2, 1);

    const registry = registryForHashes({ [hashX]: merkleX });
    const plan = await slice(tree, registry);

    expect(plan.matchedPrimitives).toHaveLength(1);
    expect(plan.matchedPrimitives[0]?.canonicalAstHash).toBe(hashX);
  });
});

// ---------------------------------------------------------------------------
// Case 4: BranchNode itself matches registry → entire subtree collapsed
// ---------------------------------------------------------------------------

describe("slice — BranchNode matches registry (subtree collapse)", () => {
  it("emits one PointerEntry for the branch and does NOT visit children", async () => {
    const sourceX = "console.log(1);";
    const sourceY = "return 2;";
    const hashX = "hash-X";
    const hashY = "hash-Y";
    const hashBranch = "hash-branch-match";
    const merkleBranch = "merkle-branch" as BlockMerkleRoot;

    const atomX = makeAtom(sourceX, hashX, 0);
    const atomY = makeAtom(sourceY, hashY, sourceX.length);
    const branchSource = sourceX + sourceY;
    const branch = makeBranch(branchSource, hashBranch, [atomX, atomY], 0);
    const tree = makeTree(branch, 2, 1);

    // Registry matches the BRANCH by hash, not the children
    const registry = registryForHashes({ [hashBranch]: merkleBranch });
    const plan = await slice(tree, registry);

    // Only one entry — the branch collapsed, children not visited
    expect(plan.entries).toHaveLength(1);
    expect(plan.entries[0]?.kind).toBe("pointer");
  });

  it("collapsed PointerEntry covers the full branch source range", async () => {
    const sourceX = "console.log(1);";
    const sourceY = "return 2;";
    const branchSource = sourceX + sourceY;
    const hashBranch = "hash-branch-match";
    const merkleBranch = "merkle-branch" as BlockMerkleRoot;

    const atomX = makeAtom(sourceX, "hash-X", 0);
    const atomY = makeAtom(sourceY, "hash-Y", sourceX.length);
    const branch = makeBranch(branchSource, hashBranch, [atomX, atomY], 0);
    const tree = makeTree(branch, 2, 1);

    const registry = registryForHashes({ [hashBranch]: merkleBranch });
    const plan = await slice(tree, registry);

    const entry = plan.entries[0];
    expect(entry?.kind).toBe("pointer");
    if (entry?.kind !== "pointer") return;
    expect(entry.sourceRange.start).toBe(0);
    expect(entry.sourceRange.end).toBe(branchSource.length);
  });

  it("pointer bytes = branch source length (entire subtree accounted)", async () => {
    const branchSource = "console.log(1);return 2;";
    const hashBranch = "hash-branch-match";
    const merkleBranch = "merkle-branch" as BlockMerkleRoot;

    const atomX = makeAtom("console.log(1);", "hash-X", 0);
    const atomY = makeAtom("return 2;", "hash-Y", 15);
    const branch = makeBranch(branchSource, hashBranch, [atomX, atomY], 0);
    const tree = makeTree(branch, 2, 1);

    const registry = registryForHashes({ [hashBranch]: merkleBranch });
    const plan = await slice(tree, registry);

    expect(plan.sourceBytesByKind.pointer).toBe(branchSource.length);
    expect(plan.sourceBytesByKind.novelGlue).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Case 5: Registry without findByCanonicalAstHash → all NovelGlueEntry
// ---------------------------------------------------------------------------

describe("slice — registry without findByCanonicalAstHash", () => {
  it("does not throw and treats all atoms as novel glue", async () => {
    // Registry omits the optional method entirely
    const registryWithoutMethod: Pick<ShaveRegistryView, "findByCanonicalAstHash"> = {} as Pick<
      ShaveRegistryView,
      "findByCanonicalAstHash"
    >;

    const source = "const x = 1;";
    const atom = makeAtom(source, "hash-zzz");
    const tree = makeTree(atom);

    await expect(slice(tree, registryWithoutMethod)).resolves.toBeDefined();
    const plan = await slice(tree, registryWithoutMethod);

    expect(plan.entries).toHaveLength(1);
    expect(plan.entries[0]?.kind).toBe("novel-glue");
    expect(plan.matchedPrimitives).toHaveLength(0);
  });

  it("sourceBytesByKind.novelGlue covers the full source", async () => {
    const registryWithoutMethod: Pick<ShaveRegistryView, "findByCanonicalAstHash"> = {} as Pick<
      ShaveRegistryView,
      "findByCanonicalAstHash"
    >;

    const source = "function f() { return 42; }";
    const atom = makeAtom(source, "hash-yyy");
    const tree = makeTree(atom);

    const plan = await slice(tree, registryWithoutMethod);
    expect(plan.sourceBytesByKind.novelGlue).toBe(source.length);
    expect(plan.sourceBytesByKind.pointer).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Case 6: matchedPrimitives deduplication
// ---------------------------------------------------------------------------

describe("slice — matchedPrimitives deduplication", () => {
  /**
   * Two leaves with the same canonicalAstHash both match → one entry in
   * matchedPrimitives (first-seen order preserved).
   *
   * Tree: branch → [atomA(hash-dup), atomB(hash-dup)]
   * Both atoms share the same canonicalAstHash and match the registry.
   */
  it("two matched leaves with the same hash produce one matchedPrimitive entry", async () => {
    const sharedHash = "hash-dup";
    const merkle = "merkle-dup" as BlockMerkleRoot;
    const sourceA = "return 1;";
    const sourceB = "return 2;";

    const atomA = makeAtom(sourceA, sharedHash, 0);
    const atomB = makeAtom(sourceB, sharedHash, sourceA.length);
    const branch = makeBranch(sourceA + sourceB, "hash-branch-dup", [atomA, atomB], 0);
    const tree = makeTree(branch, 2, 1);

    const registry = registryForHashes({ [sharedHash]: merkle });
    const plan = await slice(tree, registry);

    // Both leaves emit PointerEntry — two entries total
    expect(plan.entries).toHaveLength(2);
    expect(plan.entries[0]?.kind).toBe("pointer");
    expect(plan.entries[1]?.kind).toBe("pointer");

    // But matchedPrimitives is deduplicated — only one entry
    expect(plan.matchedPrimitives).toHaveLength(1);
    expect(plan.matchedPrimitives[0]?.canonicalAstHash).toBe(sharedHash);
    expect(plan.matchedPrimitives[0]?.merkleRoot).toBe(merkle);
  });

  it("first-seen merkleRoot is preserved when the same hash matches twice", async () => {
    const sharedHash = "hash-dup2";
    const merkleFirst = "merkle-first" as BlockMerkleRoot;

    const sourceA = "const a = 1;";
    const sourceB = "const b = 2;";
    const atomA = makeAtom(sourceA, sharedHash, 0);
    const atomB = makeAtom(sourceB, sharedHash, sourceA.length);
    const branch = makeBranch(sourceA + sourceB, "hash-branch-dup2", [atomA, atomB], 0);
    const tree = makeTree(branch, 2, 1);

    // Registry returns merkleFirst for the shared hash
    const registry = registryForHashes({ [sharedHash]: merkleFirst });
    const plan = await slice(tree, registry);

    expect(plan.matchedPrimitives[0]?.merkleRoot).toBe(merkleFirst);
  });

  it("distinct hashes produce distinct matchedPrimitive entries", async () => {
    const hashA = "hash-distinct-A";
    const hashB = "hash-distinct-B";
    const merkleA = "merkle-A" as BlockMerkleRoot;
    const merkleB = "merkle-B" as BlockMerkleRoot;

    const sourceA = "return 1;";
    const sourceB = "return 2;";
    const atomA = makeAtom(sourceA, hashA, 0);
    const atomB = makeAtom(sourceB, hashB, sourceA.length);
    const branch = makeBranch(sourceA + sourceB, "hash-branch-distinct", [atomA, atomB], 0);
    const tree = makeTree(branch, 2, 1);

    const registry = registryForHashes({ [hashA]: merkleA, [hashB]: merkleB });
    const plan = await slice(tree, registry);

    expect(plan.matchedPrimitives).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Case 7: DFS order preserved across nested branch
// ---------------------------------------------------------------------------

describe("slice — DFS order for nested tree", () => {
  /**
   * Tree: outer-branch → [inner-branch → [atomA, atomB], atomC]
   * Registry matches atomA only.
   * DFS order: atomA(pointer), atomB(novel-glue), atomC(novel-glue).
   */
  it("emits entries in DFS order across a nested branch", async () => {
    const hashA = "hash-A-match";
    const hashB = "hash-B-no";
    const hashC = "hash-C-no";
    const merkleA = "merkle-A" as BlockMerkleRoot;

    const sourceA = "return 1;";
    const sourceB = "return 2;";
    const sourceC = "return 3;";

    const atomA = makeAtom(sourceA, hashA, 0);
    const atomB = makeAtom(sourceB, hashB, sourceA.length);
    const atomC = makeAtom(sourceC, hashC, sourceA.length + sourceB.length);

    const innerBranch = makeBranch(sourceA + sourceB, "hash-inner", [atomA, atomB], 0);
    const outerSource = sourceA + sourceB + sourceC;
    const outerBranch = makeBranch(outerSource, "hash-outer", [innerBranch, atomC], 0);
    const tree = makeTree(outerBranch, 3, 2);

    const registry = registryForHashes({ [hashA]: merkleA });
    const plan = await slice(tree, registry);

    expect(plan.entries).toHaveLength(3);
    expect(plan.entries[0]?.kind).toBe("pointer");   // atomA — first visited
    expect(plan.entries[1]?.kind).toBe("novel-glue"); // atomB
    expect(plan.entries[2]?.kind).toBe("novel-glue"); // atomC
  });
});
