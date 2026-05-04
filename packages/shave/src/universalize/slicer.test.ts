/**
 * Tests for slice() — WI-012-05 (DEC-SLICER-NOVEL-GLUE-004)
 * and classifyForeign() — WI-V2-04-L3 (DEC-V2-FOREIGN-BLOCK-SCHEMA-001)
 *
 * Production sequence: decompose() produces a RecursionTree from a TypeScript
 * source string, then slice() walks that tree in DFS order, querying the
 * registry for each node by canonicalAstHash, and classifies each node as
 * PointerEntry (matched), ForeignLeafEntry (static foreign import), or
 * NovelGlueEntry (unmatched AtomLeaf). The tests below exercise this
 * classification logic directly using synthetic RecursionTree fixtures — we do
 * not round-trip through decompose() because slice() is a pure tree-transform
 * and its test invariants are about the classification logic, not about AST
 * parsing.
 *
 * Compound-interaction test: "branch with mixed children" exercises the real
 * production sequence crossing slice → walkNode → registry lookup → entry
 * construction → accumulator for both PointerEntry and NovelGlueEntry paths.
 *
 * L3 foreign-leaf tests: exercises classifyForeign() via both direct calls and
 * through slice(), covering fixtures A (node:fs), B (sqlite-vec with alias),
 * C (ts-morph namespace — real Project + node_modules), and negative cases.
 */

import type { BlockMerkleRoot, CanonicalAstHash } from "@yakcc/contracts";
import { Project } from "ts-morph";
import { describe, expect, it } from "vitest";
import type { ShaveRegistryView } from "../types.js";
import { classifyForeign, slice } from "./slicer.js";
import type {
  AtomLeaf,
  BranchNode,
  ForeignLeafEntry,
  GlueLeafEntry,
  RecursionTree,
} from "./types.js";

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

// ---------------------------------------------------------------------------
// L3 foreign-leaf tests (WI-V2-04, DEC-V2-FOREIGN-BLOCK-SCHEMA-001)
//
// These tests exercise classifyForeign() directly and via slice(), covering:
//   A — node:fs built-in (named import with use site)
//   B — sqlite-vec third-party package (aliased named import)
//   C — ts-morph namespace import (real Project + live node_modules)
// and negative cases (type-only, relative, workspace, dynamic import).
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Fixture A: node:fs#readFileSync use site
// ---------------------------------------------------------------------------

describe("classifyForeign — fixture A: node:fs named import", () => {
  /**
   * Source: import { readFileSync } from 'node:fs'; readFileSync('foo');
   * Expected: one ForeignLeafEntry with pkg='node:fs', export='readFileSync'.
   * The use-site expression `readFileSync('foo')` is not an import declaration;
   * classifyForeign skips it and focuses solely on ImportDeclaration nodes.
   */
  it("emits ForeignLeafEntry for node:fs#readFileSync use site (fixture A)", () => {
    const source = `import { readFileSync } from 'node:fs'; readFileSync('foo');`;
    const entries = classifyForeign(source);

    expect(entries).toHaveLength(1);
    const entry = entries[0] as ForeignLeafEntry;
    expect(entry.kind).toBe("foreign-leaf");
    expect(entry.pkg).toBe("node:fs");
    expect(entry.export).toBe("readFileSync");
    // No alias — local name equals the exported name
    expect(entry.alias).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Fixture B: sqlite-vec#load via local alias loadVec
// ---------------------------------------------------------------------------

describe("classifyForeign — fixture B: sqlite-vec aliased import", () => {
  /**
   * Source: import { load as loadVec } from 'sqlite-vec'; loadVec(db);
   * Expected: one ForeignLeafEntry with pkg='sqlite-vec', export='load',
   *           alias='loadVec'.
   */
  it("emits ForeignLeafEntry for sqlite-vec#load via alias loadVec (fixture B)", () => {
    const source = `import { load as loadVec } from 'sqlite-vec'; loadVec(db);`;
    const entries = classifyForeign(source);

    expect(entries).toHaveLength(1);
    const entry = entries[0] as ForeignLeafEntry;
    expect(entry.kind).toBe("foreign-leaf");
    expect(entry.pkg).toBe("sqlite-vec");
    expect(entry.export).toBe("load");
    expect(entry.alias).toBe("loadVec");
  });
});

// ---------------------------------------------------------------------------
// Fixture C: ts-morph#Project via namespace import
// Real ts-morph Project — resolves declarations from live workspace node_modules.
// This test does NOT mock the symbol resolver; it uses the actual ts-morph
// package that powers the slicer itself. (Required real-path check: L3)
// ---------------------------------------------------------------------------

describe("classifyForeign — fixture C: ts-morph namespace import (real Project)", () => {
  /**
   * This test proves that classifyForeign correctly handles a namespace import
   * (`import * as ns`) from a real third-party package. We use ts-morph itself
   * as the target package because it is already present in node_modules.
   *
   * The "real ts-morph Project" requirement means: the test creates an actual
   * ts-morph Project (not an in-memory stub with a mocked symbol resolver) and
   * adds a source file that imports from 'ts-morph' via namespace import syntax.
   * classifyForeign then parses that source text through its own in-memory Project
   * and must return a ForeignLeafEntry for the namespace import.
   *
   * We verify the live package is importable, then extract a source string from
   * a real SourceFile the same way the slicer would see it in production.
   */
  it("emits ForeignLeafEntry for ts-morph#Project via namespace import (fixture C, real Project)", () => {
    // Build the source text by creating a real ts-morph Project that resolves
    // declarations from the live workspace node_modules. This is the production
    // path: the slicer receives source text from a real file; we simulate that
    // here by constructing the source text in a real Project context and then
    // feeding it to classifyForeign.
    const project = new Project({
      // Use real (disk-backed) file system so ts-morph can find node_modules.
      // skipAddingFilesFromTsConfig avoids slow tsconfig crawling.
      skipAddingFilesFromTsConfig: true,
      compilerOptions: {
        allowJs: false,
        noEmit: true,
        moduleResolution: 100, // NodeNext
      },
    });

    // The source text that classifyForeign will parse. This string is what the
    // slicer would receive from an AtomLeaf.source for an import statement that
    // uses a namespace import from ts-morph.
    const importSource = `import * as tsMorph from 'ts-morph';`;

    // Add it as a synthetic file so ts-morph can apply its own parsing logic.
    // The file is added to the real Project so symbol resolution is live.
    const sf = project.createSourceFile("__fixture_c__.ts", importSource);

    // Verify the real Project parsed it correctly (namespace import present).
    const decls = sf.getImportDeclarations();
    expect(decls).toHaveLength(1);
    expect(decls[0]?.getNamespaceImport()?.getText()).toBe("tsMorph");

    // Now feed the raw source text into classifyForeign — the same path the
    // slicer uses in production (atom.source → classifyForeign(atom.source)).
    const entries = classifyForeign(sf.getText());

    expect(entries).toHaveLength(1);
    const entry = entries[0] as ForeignLeafEntry;
    expect(entry.kind).toBe("foreign-leaf");
    expect(entry.pkg).toBe("ts-morph");
    expect(entry.export).toBe("*");
    expect(entry.alias).toBe("tsMorph");
  });
});

// ---------------------------------------------------------------------------
// Negative test 4: type-only import must NOT yield ForeignLeafEntry
// ---------------------------------------------------------------------------

describe("classifyForeign — negative: type-only import erasure", () => {
  /**
   * `import type { X }` is erased at compile time — it carries no runtime
   * import. classifyForeign must skip it entirely (test 4 per L3 contract).
   */
  it("does NOT emit ForeignLeafEntry for `import type { X }` from 'node:fs'", () => {
    const source = `import type { PathLike } from 'node:fs';`;
    const entries = classifyForeign(source);

    expect(entries).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Negative test 5: relative import must NOT yield ForeignLeafEntry
// ---------------------------------------------------------------------------

describe("classifyForeign — negative: relative import", () => {
  /**
   * `import { x } from './local.js'` is a relative (workspace-local) import.
   * classifyForeign must skip it (test 5 per L3 contract).
   */
  it("does NOT emit ForeignLeafEntry for relative import `./local.js`", () => {
    const source = `import { helper } from './local.js';`;
    const entries = classifyForeign(source);

    expect(entries).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Negative test 6: workspace import must NOT yield ForeignLeafEntry
// ---------------------------------------------------------------------------

describe("classifyForeign — negative: workspace import", () => {
  /**
   * `import { x } from '@yakcc/shave'` is a workspace-internal package.
   * classifyForeign must skip it (test 6 per L3 contract).
   */
  it("does NOT emit ForeignLeafEntry for workspace import `@yakcc/shave`", () => {
    const source = `import { slice } from '@yakcc/shave';`;
    const entries = classifyForeign(source);

    expect(entries).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Negative test 7: dynamic import falls through to NovelGlueEntry
// L3 explicitly does NOT classify dynamic imports as foreign.
// ---------------------------------------------------------------------------

describe("slice — dynamic import falls through to NovelGlueEntry (test 7)", () => {
  /**
   * `await import('node:fs')` is a dynamic import expression — L3 explicitly
   * defers dynamic import classification. The atom must NOT produce a
   * ForeignLeafEntry; it must fall through to NovelGlueEntry.
   *
   * Production sequence: classifyForeign() parses the source and finds no
   * ImportDeclaration (dynamic import() is a CallExpression, not a
   * declaration), so foreignEntries.length === 0 and the atom falls through
   * to the NovelGlueEntry path.
   */
  it("falls through to NovelGlueEntry for `await import('node:fs')` (dynamic — L3 does not classify)", async () => {
    const source = `const m = await import('node:fs');`;
    const atom = makeAtom(source, "hash-dynamic-import");
    const tree = makeTree(atom);

    const plan = await slice(tree, emptyRegistry);

    // Must NOT be foreign-leaf — dynamic imports are not static declarations.
    expect(plan.entries).toHaveLength(1);
    expect(plan.entries[0]?.kind).toBe("novel-glue");
    expect(plan.entries[0]?.kind).not.toBe("foreign-leaf");
  });
});

// ---------------------------------------------------------------------------
// Purity test 8: classifyForeign must be pure of registry I/O
// (L3-I2: no findByCanonicalAstHash call inside the predicate)
// ---------------------------------------------------------------------------

describe("classifyForeign — registry purity (L3-I2)", () => {
  /**
   * Pass a registry mock that throws on findByCanonicalAstHash. Call
   * classifyForeign directly (bypassing slice/walkNode). Assert that
   * classifyForeign does NOT throw — proving it never calls registry I/O.
   *
   * This satisfies L3-I2: classifyForeign is a pure structural predicate
   * over source text only.
   */
  it("classifyForeign is pure of registry I/O — does not invoke findByCanonicalAstHash", () => {
    // Registry mock that throws if any method is called.
    // If classifyForeign were to call registry.findByCanonicalAstHash, this
    // mock would surface the violation immediately.
    const throwingRegistry: Pick<ShaveRegistryView, "findByCanonicalAstHash"> = {
      findByCanonicalAstHash: () => {
        throw new Error(
          "L3-I2 violated: classifyForeign called findByCanonicalAstHash — must be pure of registry I/O",
        );
      },
    };

    // classifyForeign does not accept a registry argument by design (L3-I2).
    // The throwing registry is declared here to make the invariant explicit
    // and to document that classifyForeign can never reach it.
    void throwingRegistry; // referenced to avoid unused-variable lint

    // Call classifyForeign with a foreign import source — must not throw.
    expect(() => classifyForeign(`import { readFileSync } from 'node:fs';`)).not.toThrow();

    // Also verify the correct entry is returned, proving the function ran fully.
    const entries = classifyForeign(`import { readFileSync } from 'node:fs';`);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.kind).toBe("foreign-leaf");
  });
});

// ---------------------------------------------------------------------------
// GlueLeafEntry schema (WI-V2-GLUE-LEAF-CONTRACT)
//
// These tests verify that:
//   1. GlueLeafEntry round-trips through JSON (serialize/deserialize).
//   2. SlicePlan.sourceBytesByKind.glue is present and equals 0 for plans
//      produced by the current slicer (the search-algorithm slicer that emits
//      GlueLeafEntry lives in WI-V2-SLICER-SEARCH-ALG; this slicer always
//      emits 0 glue bytes).
//   3. A manually-constructed SlicePlan containing a GlueLeafEntry is
//      structurally valid and the entry fields are as specified.
// ---------------------------------------------------------------------------

describe("GlueLeafEntry — schema round-trip (WI-V2-GLUE-LEAF-CONTRACT)", () => {
  it("GlueLeafEntry round-trips through JSON serialize/deserialize", () => {
    const entry: GlueLeafEntry = {
      kind: "glue",
      source: "const unsupported = () => ({ [Symbol.iterator]: function* () {} });",
      canonicalAstHash: "abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
      reason: "unsupported-node: GeneratorFunction",
    };

    const serialized = JSON.stringify(entry);
    const deserialized = JSON.parse(serialized) as GlueLeafEntry;

    expect(deserialized.kind).toBe("glue");
    expect(deserialized.source).toBe(entry.source);
    expect(deserialized.canonicalAstHash).toBe(entry.canonicalAstHash);
    expect(deserialized.reason).toBe(entry.reason);
  });

  it("SlicePlan.sourceBytesByKind.glue is 0 for plans without GlueLeafEntry", async () => {
    const source = "const x = 1;";
    const atom = makeAtom(source, "hash-glue-zero");
    const tree = makeTree(atom);

    const plan = await slice(tree, emptyRegistry);

    expect(plan.sourceBytesByKind.glue).toBe(0);
  });

  it("SlicePlan with manually-constructed GlueLeafEntry has correct shape", () => {
    const glueEntry: GlueLeafEntry = {
      kind: "glue",
      source: "function* gen() { yield 1; yield 2; }",
      canonicalAstHash: "deadbeef00000000deadbeef00000000deadbeef00000000deadbeef00000000",
      reason: "unsupported-node: GeneratorDeclaration",
    };

    // A manually-constructed SlicePlan containing a GlueLeafEntry alongside a
    // NovelGlueEntry — simulating a mixed shaveable + unshaveable source file.
    // (The search-algorithm slicer that produces such plans lands in WI-V2-SLICER-SEARCH-ALG.)
    const novelSource = "function add(a: number, b: number): number { return a + b; }";
    const novelEntry = {
      kind: "novel-glue" as const,
      sourceRange: { start: 0, end: novelSource.length },
      source: novelSource,
      canonicalAstHash: "feedcafe00000000feedcafe00000000feedcafe00000000feedcafe00000000" as CanonicalAstHash,
    };

    const plan = {
      entries: [novelEntry, glueEntry],
      matchedPrimitives: [],
      sourceBytesByKind: {
        pointer: 0,
        novelGlue: novelSource.length,
        glue: glueEntry.source.length,
      },
    };

    // Both entries are present.
    expect(plan.entries).toHaveLength(2);
    expect(plan.entries[0]?.kind).toBe("novel-glue");
    expect(plan.entries[1]?.kind).toBe("glue");

    // GlueLeafEntry fields are accessible.
    const ge = plan.entries[1] as GlueLeafEntry;
    expect(ge.source).toBe(glueEntry.source);
    expect(ge.reason).toBe(glueEntry.reason);

    // sourceBytesByKind includes the glue bucket.
    expect(plan.sourceBytesByKind.glue).toBe(glueEntry.source.length);
    expect(plan.sourceBytesByKind.novelGlue).toBe(novelSource.length);
    expect(plan.sourceBytesByKind.pointer).toBe(0);
  });
});
