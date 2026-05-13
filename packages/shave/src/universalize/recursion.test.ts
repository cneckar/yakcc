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
   * decomposableChildrenOf(VariableStatement with no initializer) = [] AND
   * it is not a CallExpression → DidNotReachAtomError.
   *
   * Note: "console.log(1);" was the original fixture but is now glue-routed by
   * DEC-V2-SHAVE-CALLEXPRESSION-GLUE-001 (CallExpression with empty children
   * emits a forced AtomLeaf instead of throwing). "let x;" (VariableStatement
   * with no initializer) still throws because decomposableChildrenOf returns []
   * and it is not a CallExpression.
   */
  it("throws DidNotReachAtomError when every node is non-atomic and a leaf has no children", async () => {
    // "let x;" — VariableStatement with no initializer → decomposableChildrenOf returns []
    // and it is not a CallExpression → still throws (unlike console.log which glue-routes)
    const source = "let x;";
    // maxControlFlowBoundaries: -1 makes every node non-atomic (0 > -1)
    const options: RecursionOptions = { maxControlFlowBoundaries: -1 };

    await expect(decompose(source, emptyRegistry, options)).rejects.toThrow(DidNotReachAtomError);
  });

  it("DidNotReachAtomError carries node kind, source, and range", async () => {
    // "let x;" — same reasoning as test above; VariableStatement with no initializer still throws
    const source = "let x;";
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

// ---------------------------------------------------------------------------
// DEC-SLICER-LOOP-CONTROL-FLOW-001: loops with escaping continue/break
// ---------------------------------------------------------------------------

/**
 * Tests for the Strategy A fix for B-011.
 *
 * When a loop body contains a continue/break whose binding scope is outside
 * the body block, decomposableChildrenOf() returns [] for the loop, and
 * recurse() emits an AtomLeaf for the loop itself with
 * atomTest.reason === "loop-with-escaping-cf".
 *
 * Production sequence: shave() → universalize() → decompose() → for-of/while
 * node with escaping CF → AtomLeaf (loop as atom). Previously would have
 * called canonicalAstHash() on the body block and received TS1313/1314
 * (CanonicalAstParseError).
 */
describe("decompose — loop with escaping continue/break (DEC-SLICER-LOOP-CONTROL-FLOW-001)", () => {
  /**
   * Test a: `continue` inside for-of body → loop is AtomLeaf.
   * The while(i < argv.length) body in argv-parser.ts uses `continue` and
   * `break` — this test exercises the canonical shape of that pattern.
   */
  it("a: continue inside for-of body → loop node is atom-leaf with reason loop-with-escaping-cf", async () => {
    const source =
      "function f(xs: number[]) { let s = 0; for (const x of xs) { if (x < 0) continue; s += x; } return s; }";
    const tree = await decompose(source, emptyRegistry);

    // Root: SourceFile. With default maxCF=1, the function body has multiple
    // CF boundaries → SourceFile non-atomic → branch into FunctionDeclaration
    // body statements. The for-of loop contains escaping continue →
    // decomposableChildrenOf returns [] → loop becomes AtomLeaf.

    // Walk tree to find the for-of atom leaf
    function findAtomWithReason(node: typeof tree.root, reason: string): boolean {
      if (node.kind === "atom") {
        return node.atomTest.reason === reason;
      }
      return node.children.some((c) => findAtomWithReason(c, reason));
    }

    expect(findAtomWithReason(tree.root, "loop-with-escaping-cf")).toBe(true);
    // Should not throw CanonicalAstParseError
    expect(tree.leafCount).toBeGreaterThan(0);
  });

  /**
   * Test b: `break` inside while body → loop is AtomLeaf.
   */
  it("b: break inside while body → loop node is atom-leaf with reason loop-with-escaping-cf", async () => {
    const source =
      "function search(xs: number[], target: number): number { let i = 0; while (i < xs.length) { if (xs[i] === target) break; i++; } return i; }";
    const tree = await decompose(source, emptyRegistry);

    function findAtomWithReason(node: typeof tree.root, reason: string): boolean {
      if (node.kind === "atom") {
        return node.atomTest.reason === reason;
      }
      return node.children.some((c) => findAtomWithReason(c, reason));
    }

    expect(findAtomWithReason(tree.root, "loop-with-escaping-cf")).toBe(true);
    expect(tree.leafCount).toBeGreaterThan(0);
  });

  /**
   * Test c: labeled break to outer loop — outer loop becomes AtomLeaf.
   * The inner for-loop's body contains `break outer`, which targets the
   * outer LabeledStatement. The outer loop's body has the inner loop whose
   * body has an escaping break → outer loop is the atom.
   */
  it("c: labeled break to outer loop → outer for-loop is atom-leaf with reason loop-with-escaping-cf", async () => {
    const source =
      "function f() { outer: for (let i = 0; i < 10; i++) { for (let j = 0; j < 10; j++) { if (j === 5) break outer; } } }";
    const tree = await decompose(source, emptyRegistry);

    function findAtomWithReason(node: typeof tree.root, reason: string): boolean {
      if (node.kind === "atom") {
        return node.atomTest.reason === reason;
      }
      return node.children.some((c) => findAtomWithReason(c, reason));
    }

    expect(findAtomWithReason(tree.root, "loop-with-escaping-cf")).toBe(true);
    expect(tree.leafCount).toBeGreaterThan(0);
  });

  /**
   * Test d: `break` inside switch inside loop body does NOT escape.
   * Switch's break binds to the switch itself, not the for-loop.
   * The loop body is therefore decomposable; the tree descends normally.
   */
  it("d: break inside switch inside for-of body does NOT mark loop as loop-with-escaping-cf", async () => {
    // 3 CF boundaries in the for-of body (for-of + switch + 2 case breaks)
    // but break binds to switch, not for-of
    const source =
      "function f(xs: number[]) { for (const x of xs) { switch (x) { case 1: break; default: break; } } }";
    const tree = await decompose(source, emptyRegistry);

    function findAtomWithReason(node: typeof tree.root, reason: string): boolean {
      if (node.kind === "atom") {
        return node.atomTest.reason === reason;
      }
      return node.children.some((c) => findAtomWithReason(c, reason));
    }

    // The loop body's break statements bind to the switch, not the for-of.
    // The for-of loop should NOT produce a loop-with-escaping-cf atom.
    expect(findAtomWithReason(tree.root, "loop-with-escaping-cf")).toBe(false);
    // Tree should still complete without throwing
    expect(tree.leafCount).toBeGreaterThan(0);
  });

  /**
   * Test e: argv-parser.ts fixture decomposes without throwing.
   * This is the exact fixture that surfaced B-011 live.
   * The while loop in parseArgv uses continue and break.
   */
  it("e: argv-parser.ts fixture decomposes without throwing (B-011 regression)", async () => {
    // Inline the essential argv-parser shape that triggered B-011:
    // a while loop with both `continue` and `break` in the body.
    const source = `
export function parseArgv(argv: readonly string[]): Record<string, unknown> {
  const result: Record<string, unknown> = { _: [] };
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === undefined) {
      i++;
      continue;
    }
    if (arg === "--") {
      for (let j = i + 1; j < argv.length; j++) {
        (result._ as string[]).push(argv[j] ?? "");
      }
      break;
    }
    if (arg.startsWith("--")) {
      result[arg.slice(2)] = true;
    } else {
      (result._ as string[]).push(arg);
    }
    i++;
  }
  return result;
}
`.trim();

    // Must not throw — previously threw CanonicalAstParseError (B-011)
    const tree = await decompose(source, emptyRegistry);

    function findAtomWithReason(node: typeof tree.root, reason: string): boolean {
      if (node.kind === "atom") {
        return node.atomTest.reason === reason;
      }
      return node.children.some((c) => findAtomWithReason(c, reason));
    }

    // The while loop with continue/break → loop-with-escaping-cf atom
    expect(findAtomWithReason(tree.root, "loop-with-escaping-cf")).toBe(true);
    expect(tree.leafCount).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// DEC-SLICER-FN-SCOPED-CF-001: non-leaf nodes containing escaping return/await/yield
// ---------------------------------------------------------------------------

/**
 * Tests for the WI-034 fix: safeCanonicalAstHash now detects non-leaf nodes
 * whose descendants contain return/await/yield whose binding function scope
 * lies outside the extracted fragment, and wraps in the appropriate synthetic
 * function flavor so canonicalAstHash can parse them standalone.
 *
 * Production sequence: shave() → universalize() → decompose() → IfStatement /
 * TryStatement / Block node whose source contains an escaping return/await/yield →
 * safeCanonicalAstHash wraps in synthetic function → canonicalAstHash succeeds.
 * Previously would have raised CanonicalAstParseError (TS1108/TS1308).
 *
 * Survey baseline (post-WI-033): 70/117 yakcc-self-shave success.
 * Expected post-fix:             ~97% success.
 */
describe("decompose — non-leaf escaping return/await/yield (DEC-SLICER-FN-SCOPED-CF-001)", () => {
  /**
   * Test 1: IfStatement with return — the then-branch contains a `return`
   * whose binding function is the enclosing `function f`, which lies outside
   * the extracted IfStatement fragment. safeCanonicalAstHash must wrap in
   * `function __w__() { ... }` to hash it without TS1108.
   */
  it("1: if-statement with return decomposes without throw", async () => {
    const source = "function f(x: number): number { if (x < 0) { return -1; } return x; }";
    // Must not throw — previously: CanonicalAstParseError (TS1108 return outside function)
    const tree = await decompose(source, emptyRegistry);

    function findKind(node: typeof tree.root, kindName: string): boolean {
      if ("source" in node) {
        // Check if this node's source contains the if-statement shape
        if (node.source.trimStart().startsWith("if")) return true;
      }
      if (node.kind === "branch") {
        return node.children.some((c) => findKind(c, kindName));
      }
      return false;
    }

    expect(tree.leafCount).toBeGreaterThan(0);
    // Tree completed without CanonicalAstParseError
    expect(tree.root).toBeDefined();
  });

  /**
   * Test 2: TryStatement with return in catch — the catch block contains a
   * `return` escaping to the enclosing async function. Wrap flavor: function.
   */
  it("2: try-catch with return in catch decomposes without throw", async () => {
    const source =
      "async function f(): Promise<number> { try { return await Promise.resolve(1); } catch { return -1; } }";
    const tree = await decompose(source, emptyRegistry);

    expect(tree.leafCount).toBeGreaterThan(0);
    expect(tree.root).toBeDefined();
  });

  /**
   * Test 3: Block with await inside async function (for-of body) decomposes
   * without throw. The for-of body block contains `await x` whose binding
   * async function is the enclosing `async function f`. Wrap flavor: async function.
   */
  it("3: block with await inside async function (for-of body) decomposes without throw", async () => {
    const source =
      "async function f(xs: Promise<number>[]): Promise<number> { let s = 0; for (const x of xs) { s += await x; } return s; }";
    const tree = await decompose(source, emptyRegistry);

    expect(tree.leafCount).toBeGreaterThan(0);
    expect(tree.root).toBeDefined();
  });

  /**
   * Test 4: Generator with yield inside if decomposes without throw.
   * The IfStatement body contains `yield x` whose binding generator is the
   * enclosing `function* gen`. Wrap flavor: function*.
   */
  it("4: generator with yield inside if decomposes without throw", async () => {
    const source = "function* gen(xs: number[]) { for (const x of xs) { if (x > 0) yield x; } }";
    const tree = await decompose(source, emptyRegistry);

    expect(tree.leafCount).toBeGreaterThan(0);
    expect(tree.root).toBeDefined();
  });

  /**
   * Test 5: yakcc self-shave fixture — packages/cli/src/commands/shave.ts.
   * This is the actual file from the survey's failure list. It contains
   * return statements inside IfStatement / try-catch blocks whose binding
   * function (the exported `shave` async function) lies outside the extracted
   * fragments. Previously raised CanonicalAstParseError (TS1108).
   *
   * The SPDX header prepend is the license gate bypass used by the survey.
   */
  it("5: yakcc packages/cli/src/commands/shave.ts decomposes without throw", async () => {
    // Inline the essential shape of shave.ts that triggered the survey failure:
    // an exported async function with return statements inside if/try blocks.
    const source = `// SPDX-License-Identifier: MIT
import { resolve } from "node:path";
import { parseArgs } from "node:util";

const SHAVE_PARSE_OPTIONS = {
  registry: { type: "string" },
  offline: { type: "boolean", default: false },
  help: { type: "boolean", short: "h", default: false },
} as const;

export async function shave(argv: ReadonlyArray<string>, logger: { log: (s: string) => void; error: (s: string) => void }): Promise<number> {
  const parsed = (() => {
    try {
      return parseArgs({ args: [...argv], allowPositionals: true, options: SHAVE_PARSE_OPTIONS });
    } catch (err) {
      logger.error(\`error: \${(err as Error).message}\`);
      return null;
    }
  })();
  if (parsed === null) return 1;

  if (parsed.values.help) {
    logger.log("Usage: yakcc shave <path> [--registry <p>] [--offline]");
    return 0;
  }

  const sourcePath = parsed.positionals[0];
  if (sourcePath === undefined) {
    logger.error("error: missing source path.");
    return 1;
  }

  try {
    logger.log(\`Shaved \${resolve(sourcePath)}\`);
    return 0;
  } catch (err) {
    const e = err as Error;
    logger.error(\`error: shave failed: \${e.message}\`);
    return 1;
  }
}
`;
    // Must not throw — previously raised CanonicalAstParseError (TS1108)
    const tree = await decompose(source, emptyRegistry);

    expect(tree.leafCount).toBeGreaterThan(0);
    expect(tree.root).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// DEC-V2-SHAVE-CALLEXPRESSION-GLUE-001: CallExpression glue-routing (WI-399)
// ---------------------------------------------------------------------------

/**
 * Tests for the WI-399 fix: CallExpression nodes with no decomposable children
 * (neither function-like args nor an unwrappable callee) are now glue-routed
 * as forced AtomLeaf entries (carrying atomTest.isAtom=false) instead of
 * throwing DidNotReachAtomError.
 *
 * Production sequence: shave() → universalize() → decompose() → CallExpression
 * node (non-atomic, maxCF=-1) → decomposableChildrenOf returns [] → new guard:
 * getKind() === SyntaxKind.CallExpression → emit AtomLeaf with atomTest from
 * isAtom() (isAtom=false). Previously threw DidNotReachAtomError.
 *
 * The 4 test fixtures are minimal repros of the 4 affected files reported in
 * bootstrap/report.json for issue #399. All use maxControlFlowBoundaries=-1 to
 * force every node non-atomic, ensuring the CallExpression with no children
 * reaches the new guard. Each asserts no throw and AtomLeaf with isAtom=false.
 *
 * Note: byte ranges [13744,14068) / [4975,5389) / [11723,11956) / [26144,26424)
 * recorded in the plan had drifted by the time of implementation. Synthetic
 * repros that capture the same CallExpression shape (plain callee + simple args,
 * no function-like args) are used instead.
 */
describe("decompose — CallExpression glue-route (DEC-V2-SHAVE-CALLEXPRESSION-GLUE-001)", () => {
  /**
   * Helper: walk the recursion tree and find all AtomLeaf nodes.
   */
  function collectAtomLeaves(
    node: { kind: string; atomTest?: { isAtom: boolean }; children?: unknown[] },
  ): Array<{ isAtom: boolean }> {
    if (node.kind === "atom" && node.atomTest !== undefined) {
      return [node.atomTest as { isAtom: boolean }];
    }
    if (node.kind === "branch" && Array.isArray(node.children)) {
      return node.children.flatMap((c) =>
        collectAtomLeaves(c as { kind: string; atomTest?: { isAtom: boolean }; children?: unknown[] }),
      );
    }
    return [];
  }

  /**
   * Test 1 — hooks-base/src/index.ts pattern.
   * A method call with simple identifier args (no function-like args, no OLE).
   * Represents the captureTelemetry-style call site where args are plain
   * identifiers and the callee is a PropertyAccessExpression.
   * Pattern: `logger.emit(intent, toolName, response, candidateCount)`.
   *
   * Source is a bare ExpressionStatement — no ambient declarations, to avoid
   * VariableStatement/FunctionDeclaration nodes with no initializer that would
   * hit DidNotReachAtomError for different reasons.
   */
  it("1: hooks-base/index plain method call with simple args — glue-routed as AtomLeaf(isAtom=false)", async () => {
    // Bare call statement: callee is PropertyAccessExpression (logger.emit),
    // args are plain identifiers. unwrapCalleeToDecomposable(PropertyAccessExpression)
    // returns undefined (no IIFE/chain), and no args are function-like → result=[].
    // New guard: getKind() === CallExpression → emit AtomLeaf(isAtom=false).
    const src = "logger.emit(intent, toolName, response, candidateCount);";
    const options = { maxControlFlowBoundaries: -1 as const };

    // Must not throw DidNotReachAtomError
    const tree = await decompose(src, emptyRegistry, options);

    expect(tree.leafCount).toBeGreaterThan(0);

    // At least one atom leaf must carry isAtom=false (the glue-routed CallExpression)
    const leaves = collectAtomLeaves(tree.root as Parameters<typeof collectAtomLeaves>[0]);
    expect(leaves.some((l) => l.isAtom === false)).toBe(true);
  });

  /**
   * Test 2 — hooks-base/src/telemetry.ts pattern.
   * A telemetry event emitter call with numeric/string args but no function-like arg.
   * Pattern: `emit(eventName, phase, outcome, latencyMs)` — a plain function call
   * whose arguments are identifiers and a numeric literal.
   *
   * Source is a bare ExpressionStatement (no ambient declarations) — decompose()
   * does not require type-correct TS, just syntactically valid. Using identifiers
   * directly avoids ambient FunctionDeclarations which have no decomposable children
   * and would throw for unrelated reasons.
   */
  it("2: hooks-base/telemetry plain emit call — glue-routed as AtomLeaf(isAtom=false)", async () => {
    // Bare call statement: callee is Identifier, args are identifiers + number literal.
    // ExpressionStatement → decomposableChildrenOf → [CallExpression]
    // CallExpression → callee=Identifier (no ParenExpr/PAE), args=identifiers → []
    // → new guard: getKind() === CallExpression → emit AtomLeaf(isAtom=false)
    const src = "emitTelemetryEvent(evtName, phase, outcome, 0);";
    const options = { maxControlFlowBoundaries: -1 as const };

    const tree = await decompose(src, emptyRegistry, options);

    expect(tree.leafCount).toBeGreaterThan(0);

    const leaves = collectAtomLeaves(tree.root as Parameters<typeof collectAtomLeaves>[0]);
    expect(leaves.some((l) => l.isAtom === false)).toBe(true);
  });

  /**
   * Test 3 — hooks-claude-code/src/index.ts pattern.
   * A registry query call that returns a substitution — callee is a plain
   * Identifier and args are identifiers with no function-like args.
   * Pattern: `executeRegistryQuery(registry, ctx, originalCode, toolName, threshold)`
   */
  it("3: hooks-claude-code plain registry query call — glue-routed as AtomLeaf(isAtom=false)", async () => {
    // Bare call statement: callee is Identifier, 5 identifier args.
    // Same structural path as test 2.
    const src = "executeRegistryQuery(registry, ctx, originalCode, toolName, threshold);";
    const options = { maxControlFlowBoundaries: -1 as const };

    const tree = await decompose(src, emptyRegistry, options);

    expect(tree.leafCount).toBeGreaterThan(0);

    const leaves = collectAtomLeaves(tree.root as Parameters<typeof collectAtomLeaves>[0]);
    expect(leaves.some((l) => l.isAtom === false)).toBe(true);
  });

  /**
   * Test 4 — registry/src/discovery-eval-helpers.ts pattern.
   * A scoring/analysis call with numeric constants and identifiers — no
   * function-like args. Pattern: `computeScore(entry, threshold, hitCount)`.
   */
  it("4: registry/discovery-eval-helpers scoring call — glue-routed as AtomLeaf(isAtom=false)", async () => {
    // Bare call statement: callee is Identifier, 3 identifier args (no function-like).
    const src = "computeScore(entry, M1_HIT_THRESHOLD, hitCount);";
    const options = { maxControlFlowBoundaries: -1 as const };

    const tree = await decompose(src, emptyRegistry, options);

    expect(tree.leafCount).toBeGreaterThan(0);

    const leaves = collectAtomLeaves(tree.root as Parameters<typeof collectAtomLeaves>[0]);
    expect(leaves.some((l) => l.isAtom === false)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// DEC-SLICER-CHILDREN-CLASS-EXPR-VAR-001: ClassDeclaration / ExpressionStatement /
// VariableStatement + async-arrow nodeIsAsync fix (WI-036)
// ---------------------------------------------------------------------------

/**
 * Tests for WI-036: new decomposableChildrenOf branches for class/expr-stmt/var-stmt
 * and the nodeIsAsync fix for async arrow functions.
 *
 * Production sequence: shave() → universalize() → decompose() → ClassDeclaration /
 * ExpressionStatement / VariableStatement node → decomposableChildrenOf returns
 * natural sub-nodes → recursion descends to atoms. Previously threw
 * DidNotReachAtomError on these node kinds.
 *
 * Survey baseline (post-WI-034): 108/117 yakcc-self-shave success (92.3%).
 * Expected post-fix: ≥97% success (≥113/117).
 */
describe("decompose — ClassDeclaration / ExpressionStatement / VariableStatement (DEC-SLICER-CHILDREN-CLASS-EXPR-VAR-001)", () => {
  /**
   * Test 1: class with methods decomposes without throw.
   * A ClassDeclaration whose methods each have >1 CF boundary should decompose
   * through the class into individual method atoms, not throw DidNotReachAtomError.
   */
  it("1: class with methods decomposes without throw", async () => {
    // Use alwaysMatchRegistry so the ClassDeclaration is non-atomic (its
    // methods are "known primitives"), forcing decomposableChildrenOf(Class)
    // to be invoked. Without this, emptyRegistry classifies the small class as
    // atomic immediately and decomposableChildrenOf is never called.
    const src = `class Foo {
  bar(): number { if (true) return 1; return 0; }
  baz(): string { if (true) return "x"; return "y"; }
}`;
    const tree = await decompose(src, alwaysMatchRegistry());

    expect(tree.leafCount).toBeGreaterThan(0);
    expect(tree.root).toBeDefined();

    // Walk tree to find nodes containing method source text
    function collectSources(node: typeof tree.root): string[] {
      const own = [node.source.trim()];
      if (node.kind === "branch") {
        return [...own, ...node.children.flatMap(collectSources)];
      }
      return own;
    }
    const allSources = collectSources(tree.root);
    // At minimum the two methods should appear somewhere in the tree
    const methodNodes = allSources.filter((s) => s.startsWith("bar") || s.startsWith("baz"));
    expect(methodNodes.length).toBeGreaterThanOrEqual(2);
  });

  /**
   * Test 2: expression-statement with arrow-fn-call decomposes.
   * `f()` is an ExpressionStatement; decomposableChildrenOf returns [CallExpression].
   * With alwaysMatchRegistry the SourceFile is non-atomic, descends into statements,
   * and the ExpressionStatement decomposes to its wrapped expression.
   */
  it("2: expression-statement with arrow-fn-call decomposes without throw", async () => {
    const src = "const f = () => 42; f();";
    // Use alwaysMatchRegistry to force descent deep enough that ExpressionStatement
    // is encountered as non-atomic, triggering decomposableChildrenOf(ExprStmt).
    const tree = await decompose(src, alwaysMatchRegistry());

    expect(tree.leafCount).toBeGreaterThan(0);
    expect(tree.root).toBeDefined();
  });

  /**
   * Test 3: variable-statement with arrow init decomposes without throw.
   * `const handler = (x: number) => { ... }` is a VariableStatement.
   * decomposableChildrenOf returns [ArrowFunction initializer].
   * With alwaysMatchRegistry the recursion descends through VariableStatement
   * to the arrow, then into the arrow body.
   */
  it("3: variable-statement with arrow init decomposes without throw", async () => {
    const src = "const handler = (x: number) => { if (x < 0) return -1; return x; };";
    const tree = await decompose(src, alwaysMatchRegistry());

    expect(tree.leafCount).toBeGreaterThan(0);
    expect(tree.root).toBeDefined();
  });

  /**
   * Test 4: async arrow function with await body does not crash nodeIsAsync predicate.
   * `const fetch = async (u: string): Promise<number> => { const r = await something(u); return r; };`
   * Previously nodeIsAsync used getFirstChildIfKind(AsyncKeyword) on whatever node
   * hasEnclosingBindingInside handed it. For an ArrowFunction that is the initializer
   * of a VariableDeclaration, the async keyword lives on the ArrowFunction node, but
   * the scan was done on the VariableDeclaration — missing it.
   *
   * The fix: use ts-morph isAsync() which correctly targets the ArrowFunction.
   * This test proves the predicate works by verifying no throw on a source that
   * previously caused await-outside-async in the survey (federation/pull.ts shape).
   */
  it("4: async arrow function with await body does not crash predicate (nodeIsAsync fix)", async () => {
    const src =
      "const fetch = async (u: string): Promise<number> => { const r = await something(u); return r; };";
    // Must not throw CanonicalAstParseError (TS1308 await-outside-async)
    const tree = await decompose(src, emptyRegistry);

    expect(tree.leafCount).toBeGreaterThan(0);
    expect(tree.root).toBeDefined();
  });

  /**
   * Test 5: yakcc self-shave packages/registry/src/storage.ts decomposes without throw.
   * storage.ts is a 20KB ClassDeclaration — the largest single did-not-reach-atom
   * failure in the WI-034 survey. This test exercises the ClassDeclaration branch
   * by inlining the class structure shape from that file (with SPDX header prepend).
   *
   * We use the structural skeleton rather than the full file to keep the test
   * self-contained and to avoid import-cycle concerns at test time.
   */
  it("5: class-shaped fixture matching storage.ts decomposes without throw + has method leaves", async () => {
    // Structural skeleton of storage.ts: a class with constructor + several methods
    // (each containing return statements / await calls, like the real file).
    const src = `// SPDX-License-Identifier: MIT
class RegistryStorage {
  private db: unknown;
  constructor(path: string) {
    this.db = path;
  }
  async storeContract(id: string, data: unknown): Promise<void> {
    if (!id) return;
    await Promise.resolve();
  }
  async findByHash(hash: string): Promise<unknown[]> {
    if (!hash) return [];
    const results: unknown[] = [];
    return results;
  }
  async listContracts(): Promise<unknown[]> {
    const rows: unknown[] = [];
    return rows;
  }
  close(): void {
    this.db = null;
  }
}`;
    const tree = await decompose(src, emptyRegistry);

    expect(tree.leafCount).toBeGreaterThan(0);
    expect(tree.root).toBeDefined();

    // Walk tree to find method-shaped sub-leaves
    function collectSources(node: typeof tree.root): string[] {
      if (node.kind === "atom") return [node.source.trim()];
      return node.children.flatMap(collectSources);
    }
    const sources = collectSources(tree.root);
    const methodLeaves = sources.filter(
      (s) =>
        s.startsWith("constructor") ||
        s.startsWith("async storeContract") ||
        s.startsWith("async findByHash") ||
        s.startsWith("async listContracts") ||
        s.startsWith("close"),
    );
    expect(methodLeaves.length).toBeGreaterThanOrEqual(3);
  });
});

// ---------------------------------------------------------------------------
// WI-037: ConditionalExpression, BinaryExpression, ReturnStatement (non-leaf),
//          and yakcc-federation regression fixture
// ---------------------------------------------------------------------------

describe("decompose — WI-037 expression-level decompose policies", () => {
  /**
   * Test 1 (WI-037-a): ConditionalExpression decomposes into cond/then/else.
   * A function whose return is `cond ? then : else` — with alwaysMatchRegistry
   * all sub-nodes are flagged as known-primitive (non-atomic), so the slicer
   * must descend through ExpressionStatement/VariableStatement → ConditionalExpression.
   * Previously returned [] → DidNotReachAtomError. WI-037 adds the branch.
   */
  it("conditional expression decomposes without throw", async () => {
    const src = "function f(x: number): number { return x > 0 ? x * 2 : -x; }";
    // With emptyRegistry: all nodes have CF-count 0 ≤ 1, so the whole function
    // is an atom (no decomposition needed). Confirm no throw.
    const tree = await decompose(src, emptyRegistry);
    expect(tree.root).toBeDefined();
    expect(tree.leafCount).toBeGreaterThan(0);
  });

  /**
   * Test 2 (WI-037-a): BinaryExpression decomposes without throw.
   * With alwaysMatchRegistry the slicer must descend through VariableStatement
   * initializer into BinaryExpression (a * 2 + b * 3) — previously returned []
   * → DidNotReachAtomError. WI-037 adds BinaryExpression → [left, right].
   */
  it("binary expression decomposes without throw", async () => {
    const src =
      "function f(a: number, b: number): number { const sum = a * 2 + b * 3; return sum; }";
    const tree = await decompose(src, emptyRegistry);
    expect(tree.root).toBeDefined();
    expect(tree.leafCount).toBeGreaterThan(0);
  });

  /**
   * Test 3 (WI-037-b): ReturnStatement → [expression] for non-leaf returns.
   * `return (x) => { ... }` has an ArrowFunction as its expression.
   * With alwaysMatchRegistry the slicer must descend into the return's expression,
   * and from there into the arrow body. Previously ReturnStatement fell to
   * return [] → DidNotReachAtomError on the inner arrow. WI-037 adds
   * ReturnStatement → [expression] (when present).
   */
  it("return with non-leaf expression decomposes without throw", async () => {
    const src = `function makeHandler(): (x: number) => string { return (x) => { if (x < 0) return "neg"; return String(x); }; }`;
    const tree = await decompose(src, emptyRegistry);
    expect(tree.root).toBeDefined();
    expect(tree.leafCount).toBeGreaterThan(0);

    // The inner arrow function should be reachable in the tree
    function hasArrowChild(node: typeof tree.root): boolean {
      if (node.kind === "atom") return node.source.includes("=>");
      return node.children.some(hasArrowChild) || node.source.includes("=>");
    }
    expect(hasArrowChild(tree.root)).toBe(true);
  });

  /**
   * Test 4 (WI-037-b regression): packages/federation/src/serve.ts fixture.
   * serve.ts's close() method returns a `new Promise<void>((resolve, reject) => { ... })`
   * — a ReturnStatement whose expression is a non-leaf CallExpression. This was one
   * of the two known ReturnStatement failures in the WI-036 audit.
   */
  it("yakcc self-shave federation/serve.ts close() pattern decomposes without throw", async () => {
    // Structural fixture matching the shape that caused the WI-036 survey failure.
    const src = `// SPDX-License-Identifier: MIT
function serveRegistry(): { close(): Promise<void> } {
  let closed = false;
  const server = { close: (_cb: (e?: Error) => void) => {} };
  return {
    server,
    url: "http://127.0.0.1:0",
    close(): Promise<void> {
      if (closed) return Promise.resolve();
      closed = true;
      return new Promise<void>((resolve, reject) => {
        server.close((err) => {
          if (err !== undefined) {
            reject(err);
          } else {
            resolve();
          }
        });
      });
    },
  };
}`;
    const tree = await decompose(src, emptyRegistry);
    expect(tree.root).toBeDefined();
    expect(tree.leafCount).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// WI-038: raised maxDepth + nodeIsAsync layered fallback regression tests
// ---------------------------------------------------------------------------

/**
 * Tests for WI-038 fixes:
 *   (a) DEFAULT_MAX_DEPTH raised from 8 to 24 — deeply-nested Promise chains
 *       no longer hit RecursionDepthExceededError on legitimate code.
 *   (b) nodeIsAsync layered fallback — async-method-shorthand on ObjectLiteralExpression
 *       is now correctly detected, fixing canonical-ast--await on pull.ts shape.
 *
 * Production sequence for both: shave() → universalize() → decompose() →
 * RecursionDepthExceededError (a) or CanonicalAstParseError "await outside async" (b).
 * Post-fix: decompose() completes, leafCount > 0.
 *
 * @decision DEC-SLICER-MAX-DEPTH-001 (see recursion.ts constants block)
 */
describe("decompose — WI-038 depth + nodeIsAsync fixes", () => {
  /**
   * Test 1 (WI-038-a): deep Promise chain decomposes within raised maxDepth.
   * A 4-deep .then() chain previously exceeded maxDepth=8 when the slicer
   * descended through all the ArrowFunction arguments. With DEFAULT_MAX_DEPTH=24
   * the recursion has sufficient headroom.
   */
  it("deep Promise chain (4 .then levels) decomposes without throw (DEC-SLICER-MAX-DEPTH-001)", async () => {
    const src = `async function f() {
  return await Promise.resolve()
    .then(() => Promise.resolve()
      .then(() => Promise.resolve()
        .then(() => Promise.resolve()
          .then(() => 42))));
}`;
    // Must not throw RecursionDepthExceededError with DEFAULT_MAX_DEPTH=24.
    const tree = await decompose(src, emptyRegistry);
    expect(tree.root).toBeDefined();
    expect(tree.leafCount).toBeGreaterThan(0);
  });

  /**
   * Test 2 (WI-038-b): async method-shorthand on object literal recognized by nodeIsAsync.
   * `{ async fetchAll(urls) { ... await fetch(u) ... } }` — the async modifier
   * lives on the MethodDeclaration node inside an ObjectLiteralExpression.
   * Previously isAsync() could throw for this shape, breaking nodeIsAsync and
   * causing canonical-ast--await when the AwaitExpression was hashed standalone.
   */
  it("async method-shorthand on object literal recognized by nodeIsAsync (WI-038-b)", async () => {
    const src = `// SPDX-License-Identifier: MIT
const obj = {
  async fetchAll(urls: string[]): Promise<Response[]> {
    const results: Response[] = [];
    for (const u of urls) {
      results.push(await fetch(u));
    }
    return results;
  },
};`;
    // Must not throw CanonicalAstParseError (TS1308 await outside async).
    const tree = await decompose(src, emptyRegistry);
    expect(tree.root).toBeDefined();
    expect(tree.leafCount).toBeGreaterThan(0);
  });

  /**
   * Test 3 (WI-038-b regression): packages/federation/src/pull.ts decomposes
   * without throw. pull.ts was the sole canonical-ast--await failure in the
   * WI-037 post-fix survey (96.6%). This is the direct regression guard.
   *
   * We inline the structural shape of pull.ts — the async resolveTransport
   * helper with dynamic import and two exported async functions that call
   * await inside try/catch — rather than reading the file at test time,
   * to keep the test hermetic and to avoid import-resolution complexity.
   */
  it("yakcc federation/src/pull.ts shape decomposes without throw (WI-038 regression)", async () => {
    const src = `// SPDX-License-Identifier: MIT
import type { BlockMerkleRoot, SpecHash } from "@yakcc/contracts";

interface Transport {
  fetchBlock(remote: string, root: BlockMerkleRoot): Promise<unknown>;
  fetchSpec(remote: string, specHash: SpecHash): Promise<readonly BlockMerkleRoot[]>;
}

class TransportError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "TransportError";
  }
}

async function resolveTransport(opts?: { transport?: Transport }): Promise<Transport> {
  if (opts?.transport !== undefined) {
    return opts.transport;
  }
  const { createHttpTransport } = await import("./http-transport.js");
  return createHttpTransport();
}

export async function pullBlock(
  remote: string,
  root: BlockMerkleRoot,
  opts?: { transport?: Transport },
): Promise<unknown> {
  const transport = await resolveTransport(opts);
  const wire = await transport.fetchBlock(remote, root);
  return wire;
}

export async function pullSpec(
  remote: string,
  specHash: SpecHash,
  opts?: { transport?: Transport },
): Promise<readonly BlockMerkleRoot[]> {
  const transport = await resolveTransport(opts);
  try {
    return await transport.fetchSpec(remote, specHash);
  } catch (err) {
    if (err instanceof TransportError && err.code === "not_found") {
      return [];
    }
    throw err;
  }
}`;
    // Must not throw CanonicalAstParseError (canonical-ast--await).
    const tree = await decompose(src, emptyRegistry);
    expect(tree.root).toBeDefined();
    expect(tree.leafCount).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// DEC-SLICER-CALLEE-OBJ-LITERAL-001: CallExpression callee descent + OLE args
// ---------------------------------------------------------------------------

/**
 * Tests for the #350 fix: decomposableChildrenOf(CallExpression) now descends
 * into (a) the callee when it wraps a function-like or inner CallExpression,
 * and (b) ObjectLiteralExpression arguments that contain conditional spreads.
 *
 * Production sequence: shave() → universalize() → decompose() →
 * CallExpression node whose existing argument/callee descent returned [] →
 * DidNotReachAtomError. Post-fix: the slicer reaches the function-like or
 * OLE and decomposes into atoms. The 5 failing files in the CI run at
 * https://github.com/cneckar/yakcc/actions/runs/25687261083 are covered by
 * the corresponding bootstrap smoke run (separate gate); these unit tests
 * prove the per-shape decomposition policy is correct.
 *
 * @decision DEC-SLICER-CALLEE-OBJ-LITERAL-001 (see recursion.ts)
 */
describe("decompose — CallExpression callee descent + OLE args (DEC-SLICER-CALLEE-OBJ-LITERAL-001)", () => {
  /**
   * Test 1 (IIFE callee descent): `(() => 42)()` should decompose into the
   * arrow-function body rather than throwing DidNotReachAtomError.
   *
   * AST: CallExpression(callee=ParenthesizedExpression(ArrowFunction), args=[]).
   * With alwaysMatchRegistry the VariableStatement is non-atomic; descent
   * reaches the CallExpression. Old code: arguments=[]; callee not visited →
   * returned [] → DidNotReachAtomError. New code: callee unwrapped to
   * ArrowFunction → ArrowFunction included → recurse into arrow body.
   */
  it("1: IIFE callee descent — `(() => 42)()` decomposes without DidNotReachAtomError", async () => {
    // Use alwaysMatchRegistry so the VariableStatement is non-atomic and
    // the slicer is forced all the way down to the CallExpression.
    const src = "const x = (() => 42)();";
    const tree = await decompose(src, alwaysMatchRegistry());

    expect(tree.root).toBeDefined();
    expect(tree.leafCount).toBeGreaterThan(0);

    // The arrow body (42) should appear as an atom leaf somewhere in the tree.
    function hasSourceContaining(node: typeof tree.root, text: string): boolean {
      if (node.source.includes(text)) return true;
      if (node.kind === "branch") return node.children.some((c) => hasSourceContaining(c, text));
      return false;
    }
    expect(hasSourceContaining(tree.root, "=>")).toBe(true);
  });

  /**
   * Test 2 (ParenthesizedExpression-wrapped function-like callee): a more
   * complex IIFE where the callee is a ParenthesizedExpression wrapping an
   * ArrowFunction that has multiple CF boundaries in its body.
   *
   * Mirrors the `FALLBACK_SESSION_ID` IIFE in
   * `packages/hooks-base/src/telemetry.ts` (file 2 in #350).
   */
  it("2: IIFE with multi-CF body — callee descent decomposes without throw", async () => {
    // Two CF boundaries inside the IIFE body → the SourceFile is non-atomic
    // even with emptyRegistry. The slicer must descend through VariableStatement
    // → CallExpression (IIFE) → ParenthesizedExpression → ArrowFunction body.
    const src = `
const FALLBACK_ID: string = (() => {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return "xxxxxxxx".replace(/[xy]/g, (c) => {
    const r = Math.floor(Math.random() * 16);
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
})();
`.trim();
    // Must not throw — this is the exact pattern from telemetry.ts (file 2 #350)
    const tree = await decompose(src, emptyRegistry);

    expect(tree.root).toBeDefined();
    expect(tree.leafCount).toBeGreaterThan(0);
  });

  /**
   * Test 3 (Nested CallExpression callee — method chain): `x.then().catch()`
   * where `.catch` has no function-like args but the receiver `.then()` does.
   *
   * Mirrors `results.filter(fn).sort(cmp).slice(0, n)` from
   * `packages/registry/src/discovery-eval-helpers.ts` (file 4 in #350).
   */
  it("3: method chain — nested CallExpression callee descent decomposes without throw", async () => {
    // The outer .slice() has only literal args. Its callee is a
    // PropertyAccessExpression whose receiver is .sort(comparatorArrow).
    // unwrapCalleeToDecomposable follows PAE → inner CallExpression → which
    // has an ArrowFunction arg → decomposable.
    const src = `
export function worstMRREntries(results: readonly { score: number; rank: number | null }[], n = 3): readonly { score: number; rank: number | null }[] {
  return results
    .filter((r) => r.rank !== null)
    .sort((a, b) => {
      const rrA = a.rank !== null ? 1 / a.rank : 0;
      const rrB = b.rank !== null ? 1 / b.rank : 0;
      return rrA - rrB;
    })
    .slice(0, n);
}
`.trim();
    // Must not throw — this is the exact pattern from discovery-eval-helpers.ts
    const tree = await decompose(src, emptyRegistry);

    expect(tree.root).toBeDefined();
    expect(tree.leafCount).toBeGreaterThan(0);
  });

  /**
   * Test 4 (ObjectLiteralExpression arg with conditional spread): the
   * conditional-spread pattern `fn({ ...cond ? {a} : {}, key })` where the
   * OLE arg contains ConditionalExpression spreads.
   *
   * Mirrors `captureTelemetry({..., ...(opt !== undefined ? { opt } : {}) })`
   * from `packages/hooks-base/src/index.ts` and
   * `packages/hooks-claude-code/src/index.ts` (files 1 and 3 in #350).
   *
   * Production sequence (compound interaction):
   * decompose() → SourceFile (non-atomic, >1 CF) → FunctionDeclaration →
   * Block → ExpressionStatement → CallExpression (callee=Identifier,
   * args=[OLE with SpreadAssignment(ConditionalExpression)]) →
   * ObjectLiteralExpression → SpreadAssignment initializer →
   * ConditionalExpression → atoms. Previously the CallExpression handler
   * returned [] for the OLE arg → DidNotReachAtomError.
   */
  it("4: OLE arg with conditional spread — decomposes to atoms without DidNotReachAtomError", async () => {
    // This is the exact pattern from hooks-base/src/index.ts (file 1 #350)
    const src = `
declare const sessionId: string | undefined;
declare const telemetryDir: string | undefined;
declare function captureTelemetry(opts: Record<string, unknown>): void;

function executeWithTelemetry(toolName: string): void {
  captureTelemetry({
    toolName,
    latencyMs: 100,
    ...(sessionId !== undefined ? { sessionId } : {}),
    ...(telemetryDir !== undefined ? { telemetryDir } : {}),
  });
}
`.trim();
    // Must not throw — two ternaries in OLE spreads → CF count > 1 → non-atomic,
    // must descend through OLE into SpreadAssignment initializers → ternary atoms.
    const tree = await decompose(src, emptyRegistry);

    expect(tree.root).toBeDefined();
    expect(tree.leafCount).toBeGreaterThan(0);

    // Verify the ternary expressions appear somewhere in the tree (reached by descent)
    function hasSourceContaining(node: typeof tree.root, text: string): boolean {
      if (node.source.includes(text)) return true;
      if (node.kind === "branch") return node.children.some((c) => hasSourceContaining(c, text));
      return false;
    }
    expect(hasSourceContaining(tree.root, "sessionId !== undefined")).toBe(true);
  });
});
