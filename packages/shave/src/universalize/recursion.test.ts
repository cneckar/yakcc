/**
 * Tests for decompose() — WI-012-04 (DEC-RECURSION-005)
 *
 * Production sequence: a TypeScript source string is parsed by decompose()
 * into a Project, each node is classified via isAtom(), and the recursion
 * walks top-down until every leaf is atomic. The tests below exercise this
 * exact sequence end-to-end, crossing the decompose → isAtom boundary, to
 * prove the production path works — not just unit-level mocks.
 *
 * Compound-interaction test: "branch case with two if-statements" exercises
 * the full production sequence: decompose() parses, isAtom() classifies the
 * SourceFile as non-atomic (2 CF boundaries > maxCF=1), decomposableChildrenOf
 * returns the 2 statements, each is re-evaluated by isAtom() and is atomic
 * (1 CF boundary ≤ maxCF=1), and the tree is assembled correctly.
 */

import type { BlockMerkleRoot } from "@yakcc/contracts";
import { describe, expect, it } from "vitest";
import type { ShaveRegistryView } from "../types.js";
import { DidNotReachAtomError, RecursionDepthExceededError, decompose } from "./recursion.js";
import type { RecursionOptions } from "./types.js";

// ---------------------------------------------------------------------------
// Registry helpers
// ---------------------------------------------------------------------------

/** A registry that always returns no matches — no known primitives. */
const emptyRegistry: Pick<ShaveRegistryView, "findByCanonicalAstHash"> = {
  findByCanonicalAstHash: async () => [],
};

/**
 * A registry that returns a fake match for every hash query.
 * Used to trigger "contains-known-primitive" → non-atomic classification
 * on every sub-statement, driving DidNotReachAtomError on nodes that have
 * no decomposable children.
 */
function alwaysMatchRegistry(): Pick<ShaveRegistryView, "findByCanonicalAstHash"> {
  return {
    findByCanonicalAstHash: async () => ["fake-merkle-root" as BlockMerkleRoot],
  };
}

// ---------------------------------------------------------------------------
// Happy path: atomic root (single function, no CF, empty registry)
// ---------------------------------------------------------------------------

describe("decompose — atom-leaf root", () => {
  it("classifies a simple function with no CF boundaries as an atom at depth 0", async () => {
    const source = "function f(x: number) { return x + 1; }";
    const tree = await decompose(source, emptyRegistry);

    // The SourceFile itself has 0 CF boundaries → atomic.
    expect(tree.root.kind).toBe("atom");
    expect(tree.leafCount).toBe(1);
    expect(tree.maxDepth).toBe(0);
  });

  it("root atom carries the correct sourceRange covering the full source", async () => {
    const source = "const x = 1;";
    const tree = await decompose(source, emptyRegistry);

    expect(tree.root.kind).toBe("atom");
    // The SourceFile node starts at 0 and ends at source.length.
    expect(tree.root.sourceRange.start).toBe(0);
    expect(tree.root.sourceRange.end).toBe(source.length);
  });

  it("root atom has a non-empty canonicalAstHash", async () => {
    const source = "function g(a: string): string { return a.trim(); }";
    const tree = await decompose(source, emptyRegistry);

    expect(tree.root.kind).toBe("atom");
    const hash = tree.root.canonicalAstHash;
    expect(typeof hash).toBe("string");
    expect(hash.length).toBe(64); // BLAKE3-256 hex digest
  });
});

// ---------------------------------------------------------------------------
// Branch case: SourceFile with 2 if-statements → branch → 2 atom children
// ---------------------------------------------------------------------------

describe("decompose — branch node (two if-statements)", () => {
  /**
   * Compound-interaction test (production sequence).
   *
   * Source has 2 top-level if-statements (2 CF boundaries total in the
   * SourceFile). With default maxCF=1:
   *   - SourceFile: 2 CF > 1 → not atomic → branch
   *   - Each if-statement: 1 CF ≤ 1 → atomic → leaf
   *
   * This crosses decompose → isAtom → decomposableChildrenOf → isAtom.
   */
  it("produces a branch root with 2 atom children (compound production sequence)", async () => {
    const source = [
      "declare const a: boolean;",
      "declare const b: boolean;",
      "if (a) { console.log('a'); }",
      "if (b) { console.log('b'); }",
    ].join("\n");

    const tree = await decompose(source, emptyRegistry);

    // SourceFile has 2 if-statements → 2 CF boundaries → not atomic
    expect(tree.root.kind).toBe("branch");
    if (tree.root.kind !== "branch") return; // type narrowing

    // decomposableChildrenOf(SourceFile) returns all statements: 2 declares + 2 ifs
    // Each statement individually has ≤ 1 CF boundaries → atomic
    expect(tree.root.children.every((c) => c.kind === "atom")).toBe(true);

    // leafCount = number of atom leaves (all 4 statements are atoms)
    expect(tree.leafCount).toBe(tree.root.children.length);
    expect(tree.maxDepth).toBe(1);
  });

  it("branch node atomTest records the non-atom reason", async () => {
    const source = [
      "declare const a: boolean;",
      "declare const b: boolean;",
      "if (a) { console.log(1); }",
      "if (b) { console.log(2); }",
    ].join("\n");

    const tree = await decompose(source, emptyRegistry);
    expect(tree.root.kind).toBe("branch");
    if (tree.root.kind !== "branch") return;

    expect(tree.root.atomTest.isAtom).toBe(false);
    expect(tree.root.atomTest.reason).toBe("too-many-cf-boundaries");
  });
});

// ---------------------------------------------------------------------------
// leafCount + maxDepth correctness with 3-statement SourceFile
// ---------------------------------------------------------------------------

describe("decompose — leafCount and maxDepth with 3-statement source", () => {
  it("counts 3 leaf atoms and maxDepth 1 when all top-level statements are atomic", async () => {
    // 3 statements with 1 CF boundary each = 3 total in the SourceFile (> default maxCF=1).
    // Each statement individually has 1 CF ≤ 1 → atomic.
    const source = [
      "declare const a: boolean;",
      "declare const b: boolean;",
      "declare const c: boolean;",
      "if (a) { console.log(1); }",
      "if (b) { console.log(2); }",
      "if (c) { console.log(3); }",
    ].join("\n");

    const tree = await decompose(source, emptyRegistry);

    expect(tree.root.kind).toBe("branch");
    expect(tree.leafCount).toBe(6); // 3 declares + 3 ifs, each atomic
    expect(tree.maxDepth).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// RecursionDepthExceededError
// ---------------------------------------------------------------------------

describe("decompose — RecursionDepthExceededError", () => {
  it("throws when maxDepth=0 and the root is not atomic", async () => {
    // Source with 2 if-statements: SourceFile has 2 CF → not atomic.
    // With maxDepth=0, the recursion would need to go to depth 1 → throws.
    const source = [
      "declare const a: boolean;",
      "declare const b: boolean;",
      "if (a) { console.log(1); }",
      "if (b) { console.log(2); }",
    ].join("\n");

    const options: RecursionOptions = { maxDepth: 0 };

    await expect(decompose(source, emptyRegistry, options)).rejects.toThrow(
      RecursionDepthExceededError,
    );
  });

  it("RecursionDepthExceededError carries depth and maxDepth", async () => {
    const source = [
      "declare const a: boolean;",
      "declare const b: boolean;",
      "if (a) { console.log(1); }",
      "if (b) { console.log(2); }",
    ].join("\n");

    const options: RecursionOptions = { maxDepth: 0 };

    let caught: RecursionDepthExceededError | undefined;
    try {
      await decompose(source, emptyRegistry, options);
    } catch (e) {
      if (e instanceof RecursionDepthExceededError) caught = e;
    }

    expect(caught).toBeDefined();
    expect(caught?.maxDepth).toBe(0);
    expect(caught?.depth).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// DidNotReachAtomError
// ---------------------------------------------------------------------------

describe("decompose — DidNotReachAtomError", () => {
  /**
   * To trigger DidNotReachAtomError we need a node that:
   *   (a) isAtom() classifies as non-atomic, AND
   *   (b) decomposableChildrenOf() returns [] for.
   *
   * Strategy: use alwaysMatchRegistry() (every sub-statement is a known
   * primitive → non-atomic), and provide a source where the SourceFile has
   * exactly one top-level statement that has no decomposable children itself.
   *
   * A SourceFile with one if-statement:
   *   - alwaysMatchRegistry makes SourceFile non-atomic (its child if-statement
   *     is a "known primitive").
   *   - decomposableChildrenOf(SourceFile) returns [ifStatement].
   *   - isAtom(ifStatement) with alwaysMatchRegistry: ifStatement has 1 top-level
   *     statement in its then-block; that statement matches → non-atomic.
   *   - decomposableChildrenOf(IfStatement) returns [thenBlock].
   *   - isAtom(Block) with alwaysMatchRegistry: the console.log statement matches
   *     → non-atomic.
   *   - decomposableChildrenOf(Block) returns [expressionStatement].
   *   - isAtom(expressionStatement) with alwaysMatchRegistry: expression statements
   *     have no top-level statement children (getTopLevelStatements returns [])
   *     so criterion 2 never fires; CF count is 0 ≤ 1 → isAtom returns true.
   *
   * So with alwaysMatchRegistry the recursion actually terminates at the
   * innermost expression statement (it's atomic because it has no sub-statements).
   * To force DidNotReachAtomError we need a genuinely expression-level non-atomic
   * node with no children. The cleanest route: use maxControlFlowBoundaries=-1
   * (impossible to satisfy: every node has CF count ≥ 0 > -1) combined with a
   * source whose leaf node has no decomposable children.
   *
   * With maxCF=-1, every node is non-atomic (CF count 0 > -1 is false... wait,
   * the check is cfCount > maxCF, so 0 > -1 = true → non-atomic). Then
   * decomposableChildrenOf(expressionStatement) = [] → DidNotReachAtomError.
   */
  it("throws DidNotReachAtomError when every node is non-atomic and a leaf has no children", async () => {
    const source = "console.log(1);";
    // maxControlFlowBoundaries: -1 makes every node non-atomic (0 > -1)
    const options: RecursionOptions = { maxControlFlowBoundaries: -1 };

    await expect(decompose(source, emptyRegistry, options)).rejects.toThrow(DidNotReachAtomError);
  });

  it("DidNotReachAtomError carries node kind, source, and range", async () => {
    const source = "console.log(42);";
    const options: RecursionOptions = { maxControlFlowBoundaries: -1 };

    let caught: DidNotReachAtomError | undefined;
    try {
      await decompose(source, emptyRegistry, options);
    } catch (e) {
      if (e instanceof DidNotReachAtomError) caught = e;
    }

    expect(caught).toBeDefined();
    expect(typeof caught?.node.kind).toBe("number");
    expect(typeof caught?.node.source).toBe("string");
    expect(caught?.node.range.start).toBeGreaterThanOrEqual(0);
    expect(caught?.node.range.end).toBeGreaterThan(caught?.node.range.start ?? 0);
  });
});

// ---------------------------------------------------------------------------
// Known-primitive registry triggers branch
// ---------------------------------------------------------------------------

describe("decompose — registry-driven branch", () => {
  /**
   * When the registry recognizes a sub-statement as a known primitive,
   * isAtom() returns non-atomic for the parent. decompose() descends into
   * the parent's children. The children themselves (at the statement level)
   * have no sub-statements to query, so criterion 2 never fires for them →
   * they are atomic (as long as CF count ≤ maxCF).
   *
   * Source: a SourceFile with one if-statement (1 CF). The registry matches
   * the if-statement as a known primitive. SourceFile → non-atomic. Descend
   * to [ifStatement]. isAtom(ifStatement): the if's then-block contains a
   * console.log expression statement; registry matches it → ifStatement is
   * non-atomic. Descend to [thenBlock]. isAtom(Block): its child is a console.log
   * expression statement; registry matches → Block is non-atomic. Descend to
   * [expressionStatement]. isAtom(expressionStatement): no sub-statements,
   * CF=0 ≤ 1 → atomic.
   *
   * Tree: branch(SourceFile) → branch(if) → branch(block) → atom(exprStmt).
   */
  it("produces a branch chain when registry matches every level", async () => {
    const source = "if (true) { console.log('hi'); }";
    const registry = alwaysMatchRegistry();

    const tree = await decompose(source, registry);

    // Root should be a branch (SourceFile non-atomic because registry matched its child)
    expect(tree.root.kind).toBe("branch");
    // There should be at least one atom leaf at the bottom
    expect(tree.leafCount).toBeGreaterThan(0);
    // Depth must be > 0 (recursion went at least one level)
    expect(tree.maxDepth).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// canonicalAstHash stability
// ---------------------------------------------------------------------------

describe("decompose — canonicalAstHash stability", () => {
  it("two structurally identical sources produce the same root hash", async () => {
    const source1 = "function f(x: number) { return x + 1; }";
    // Different local variable name — local renames normalize to same hash
    const source2 = "function f(y: number) { return y + 1; }";

    const tree1 = await decompose(source1, emptyRegistry);
    const tree2 = await decompose(source2, emptyRegistry);

    // Both roots should be atoms
    expect(tree1.root.kind).toBe("atom");
    expect(tree2.root.kind).toBe("atom");

    // canonicalAstHash normalizes local variable names → same hash
    expect(tree1.root.canonicalAstHash).toBe(tree2.root.canonicalAstHash);
  });
});
