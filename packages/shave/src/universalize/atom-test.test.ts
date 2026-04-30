/**
 * @decision DEC-ATOM-TEST-003
 * Title: Tests for the isAtom() predicate (WI-012-03).
 * Status: proposed.
 * Rationale: Tests exercise the full production sequence:
 *   parse source with ts-morph → extract root node → call isAtom() →
 *   get AtomTestResult. This is the compound-interaction test required by
 *   the implementer contract: it crosses the ts-morph AST layer, the
 *   canonicalAstHash computation, and the registry stub in one sequence.
 */

import type { BlockMerkleRoot, CanonicalAstHash } from "@yakcc/contracts";
import { Project, ScriptKind } from "ts-morph";
import { describe, expect, it } from "vitest";
import { isAtom } from "./atom-test.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Parse `source` with ts-morph and return the first top-level statement's
 * Node. Useful for tests that want to pass an expression-statement node
 * rather than the entire SourceFile.
 */
function parseFirstStatement(source: string) {
  const project = new Project({
    useInMemoryFileSystem: true,
    compilerOptions: { allowJs: false, noEmit: true, skipLibCheck: true },
  });
  const file = project.createSourceFile("test.ts", source, {
    scriptKind: ScriptKind.TS,
  });
  return { file, source };
}

/**
 * Parse `source` and return the SourceFile node.
 * Most tests use the SourceFile as the candidate node.
 */
function parseSource(source: string) {
  return parseFirstStatement(source);
}

/**
 * Build a mock registry that returns a fixed set of BlockMerkleRoot arrays
 * keyed on CanonicalAstHash.
 */
function mockRegistry(matches: Map<CanonicalAstHash, BlockMerkleRoot[]>) {
  return {
    async findByCanonicalAstHash(hash: CanonicalAstHash): Promise<readonly BlockMerkleRoot[]> {
      return matches.get(hash) ?? [];
    },
  };
}

/** A registry that always returns an empty array. */
const emptyRegistry = mockRegistry(new Map());

// ---------------------------------------------------------------------------
// Control-flow boundary tests
// ---------------------------------------------------------------------------

describe("isAtom — control-flow boundary counting", () => {
  it("simple return — 0 CF boundaries → atomic", async () => {
    const { file, source } = parseSource("function f(x: number) { return x + 1; }");
    const result = await isAtom(file, source, emptyRegistry);
    expect(result.isAtom).toBe(true);
    expect(result.reason).toBe("atomic");
    expect(result.controlFlowBoundaryCount).toBe(0);
  });

  it("single if statement — 1 CF boundary → atomic (default max=1)", async () => {
    const { file, source } = parseSource(
      "function f(x: number) { if (x > 0) return x; return 0; }",
    );
    const result = await isAtom(file, source, emptyRegistry);
    expect(result.isAtom).toBe(true);
    expect(result.reason).toBe("atomic");
    expect(result.controlFlowBoundaryCount).toBe(1);
  });

  it("if + for — 2 CF boundaries → too-many-cf-boundaries (default max=1)", async () => {
    const { file, source } = parseSource(
      "function f(x: number) { if (x > 0) { for (let i = 0; i < 10; i++) {} } return 0; }",
    );
    const result = await isAtom(file, source, emptyRegistry);
    expect(result.isAtom).toBe(false);
    expect(result.reason).toBe("too-many-cf-boundaries");
    expect(result.controlFlowBoundaryCount).toBe(2);
  });

  it("ternary expression — 1 CF boundary (ConditionalExpression) → atomic at default max=1", async () => {
    const { file, source } = parseSource("function f(x: number) { return x > 0 ? x : 0; }");
    const result = await isAtom(file, source, emptyRegistry);
    expect(result.isAtom).toBe(true);
    expect(result.reason).toBe("atomic");
    expect(result.controlFlowBoundaryCount).toBe(1);
  });

  it("simple return with maxControlFlowBoundaries: 0 → atomic (0 boundaries)", async () => {
    const { file, source } = parseSource("function f(x: number) { return x + 1; }");
    const result = await isAtom(file, source, emptyRegistry, { maxControlFlowBoundaries: 0 });
    expect(result.isAtom).toBe(true);
    expect(result.reason).toBe("atomic");
    expect(result.controlFlowBoundaryCount).toBe(0);
  });

  it("if statement with maxControlFlowBoundaries: 0 → too-many-cf-boundaries", async () => {
    const { file, source } = parseSource(
      "function f(x: number) { if (x > 0) return x; return 0; }",
    );
    const result = await isAtom(file, source, emptyRegistry, { maxControlFlowBoundaries: 0 });
    expect(result.isAtom).toBe(false);
    expect(result.reason).toBe("too-many-cf-boundaries");
    expect(result.controlFlowBoundaryCount).toBe(1);
  });

  it("if + for with maxControlFlowBoundaries: 2 → atomic (2 ≤ 2)", async () => {
    const { file, source } = parseSource(
      "function f(x: number) { if (x > 0) { for (let i = 0; i < 10; i++) {} } return 0; }",
    );
    const result = await isAtom(file, source, emptyRegistry, { maxControlFlowBoundaries: 2 });
    expect(result.isAtom).toBe(true);
    expect(result.reason).toBe("atomic");
    expect(result.controlFlowBoundaryCount).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Known-primitive sub-statement tests
// ---------------------------------------------------------------------------

describe("isAtom — known-primitive detection", () => {
  /**
   * Compound-interaction test: exercises the real production sequence end-to-end
   * across ts-morph parsing, isAtom() CF counting, canonicalAstHash sub-range
   * hashing, and registry stub lookup in one call.
   *
   * We pre-compute the canonicalAstHash of the first statement of a two-statement
   * function and seed the mock registry with a hit for that hash. isAtom() must
   * find it and return contains-known-primitive with matchedPrimitive populated.
   */
  it("first statement matches known primitive → contains-known-primitive", async () => {
    // Two-statement function — first statement is `const y = x * 2;`
    const source = "function f(x: number) { const y = x * 2; return y + 1; }";
    const { file } = parseSource(source);

    // isAtom is called on the FunctionDeclaration node (not SourceFile) so
    // getTopLevelStatements returns the body's statements. If we passed the
    // SourceFile, its only top-level child IS the FunctionDeclaration whose
    // range spans the whole file — the self-recognition guard fires and the
    // registry is never queried.
    const fnDecl = file.getFunctions()[0];
    if (fnDecl === undefined) throw new Error("expected fnDecl");

    // Pre-compute the canonical hash of just the first body statement.
    const { canonicalAstHash: computeHash } = await import("@yakcc/contracts");

    const body = fnDecl.getBody();
    if (body === undefined) throw new Error("expected body");
    const stmts = (body as { getStatements(): import("ts-morph").Node[] }).getStatements();
    expect(stmts.length).toBe(2);
    const firstStmt = stmts[0];
    if (firstStmt === undefined) throw new Error("expected firstStmt");
    const firstHash = computeHash(source, {
      start: firstStmt.getStart(),
      end: firstStmt.getEnd(),
    });

    const fakeMerkleRoot = "aabbcc" as BlockMerkleRoot;
    const registry = mockRegistry(new Map([[firstHash, [fakeMerkleRoot]]]));

    // Call isAtom on the FunctionDeclaration, not the SourceFile.
    const result = await isAtom(fnDecl, source, registry);
    expect(result.isAtom).toBe(false);
    expect(result.reason).toBe("contains-known-primitive");
    expect(result.controlFlowBoundaryCount).toBe(0);
    expect(result.matchedPrimitive).toBeDefined();
    expect(result.matchedPrimitive?.merkleRoot).toBe(fakeMerkleRoot);
    expect(result.matchedPrimitive?.canonicalAstHash).toBe(firstHash);
    expect(result.matchedPrimitive?.subRange.start).toBe(firstStmt.getStart());
    expect(result.matchedPrimitive?.subRange.end).toBe(firstStmt.getEnd());
  });

  it("same function but registry returns [] → atomic", async () => {
    const source = "function f(x: number) { const y = x * 2; return y + 1; }";
    const { file } = parseSource(source);

    const result = await isAtom(file, source, emptyRegistry);
    expect(result.isAtom).toBe(true);
    expect(result.reason).toBe("atomic");
    expect(result.matchedPrimitive).toBeUndefined();
  });

  it("second statement matches → contains-known-primitive pointing to second stmt", async () => {
    const source = "function f(x: number) { const y = x * 2; return y + 1; }";
    const { file } = parseSource(source);

    const { canonicalAstHash: computeHash } = await import("@yakcc/contracts");

    // Call isAtom on the FunctionDeclaration (same reasoning as the first-stmt test).
    const fnDecl = file.getFunctions()[0];
    if (fnDecl === undefined) throw new Error("expected fnDecl");
    const body = fnDecl.getBody() as { getStatements(): import("ts-morph").Node[] };
    const stmts = body.getStatements();
    const secondStmt = stmts[1];
    if (secondStmt === undefined) throw new Error("expected secondStmt");
    const secondHash = computeHash(source, {
      start: secondStmt.getStart(),
      end: secondStmt.getEnd(),
    });

    const fakeMerkleRoot = "ddeeff" as BlockMerkleRoot;
    const registry = mockRegistry(new Map([[secondHash, [fakeMerkleRoot]]]));

    const result = await isAtom(fnDecl, source, registry);
    expect(result.isAtom).toBe(false);
    expect(result.reason).toBe("contains-known-primitive");
    expect(result.matchedPrimitive).toBeDefined();
    expect(result.matchedPrimitive?.merkleRoot).toBe(fakeMerkleRoot);
    expect(result.matchedPrimitive?.subRange.start).toBe(secondStmt.getStart());
    expect(result.matchedPrimitive?.subRange.end).toBe(secondStmt.getEnd());
  });

  it("expression-only source file — no sub-statements → atomic without invoking registry", async () => {
    // A single BinaryExpression at the statement level. As a SourceFile this
    // has one ExpressionStatement child, but that child IS the only statement
    // and equals the source's full range, so no registry call is made.
    // We verify atomicity and that matchedPrimitive is absent.
    const source = "1 + 2;";
    const { file } = parseSource(source);

    // Wire a registry that would fail the test if called for anything.
    let registryCalled = false;
    const spy = {
      async findByCanonicalAstHash(_hash: CanonicalAstHash): Promise<readonly BlockMerkleRoot[]> {
        registryCalled = true;
        return [];
      },
    };

    // For a SourceFile, getTopLevelStatements returns the one ExpressionStatement.
    // Its range equals [file.getStart()..file.getEnd()] only when the source
    // has exactly one statement covering the entire file. In that edge case the
    // self-recognition guard fires and the registry is not called.
    const result = await isAtom(file, source, spy);
    expect(result.isAtom).toBe(true);
    expect(result.reason).toBe("atomic");
    expect(registryCalled).toBe(false);
  });
});
