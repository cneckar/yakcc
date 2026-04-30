/**
 * @decision DEC-ATOM-TEST-003
 * Title: AST atom-test predicate.
 * Status: proposed (MASTER_PLAN.md governance edit deferred).
 * Rationale: isAtom() is the load-bearing gate for the WI-012 universalizer
 * recursion. "Did not reach atoms" = WI-012 reviewer hard failure. The
 * predicate uses two criteria applied in order:
 *   1. Control-flow boundary count: walk all descendants and count CF nodes.
 *      If count > maxControlFlowBoundaries (default 1), the candidate is
 *      composite — not atomic.
 *   2. Known-primitive sub-statement check: for each top-level statement child
 *      of the node, compute canonicalAstHash over its source range and query
 *      the registry. A hit means the candidate contains a known primitive and
 *      is therefore composite.
 * If both criteria pass, the node is atomic.
 * Algorithm choice: at-most-N control-flow boundaries AND no top-level
 * statement matching an existing primitive in the registry by canonicalAstHash.
 */

import { canonicalAstHash } from "@yakcc/contracts";
import type { CanonicalAstHash } from "@yakcc/contracts";
import { type Node, SyntaxKind } from "ts-morph";
import type { ShaveRegistryView } from "../types.js";
import type { AtomTestOptions, AtomTestResult } from "./types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_MAX_CF_BOUNDARIES = 1;

/**
 * The set of SyntaxKinds that count as control-flow boundaries when walking
 * the descendants of a candidate node.
 *
 * ConditionalExpression (ternary) is included because it branches execution
 * in a semantically meaningful way even though it is an expression, not a
 * statement. TryStatement is included because catch/finally create alternative
 * execution paths.
 */
const CF_BOUNDARY_KINDS = new Set<SyntaxKind>([
  SyntaxKind.IfStatement,
  SyntaxKind.ForStatement,
  SyntaxKind.ForInStatement,
  SyntaxKind.ForOfStatement,
  SyntaxKind.WhileStatement,
  SyntaxKind.DoStatement,
  SyntaxKind.SwitchStatement,
  SyntaxKind.TryStatement,
  SyntaxKind.ConditionalExpression,
]);

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Count the number of control-flow boundary nodes within all descendants of
 * `node` (inclusive of `node` itself if it is a CF node).
 *
 * Uses ts-morph's `forEachDescendant` which performs a depth-first walk and
 * handles all node kinds without manual recursion.
 */
function countControlFlowBoundaries(node: Node): number {
  let count = 0;
  // Count the root node itself if it is a CF kind.
  if (CF_BOUNDARY_KINDS.has(node.getKind())) {
    count++;
  }
  node.forEachDescendant((descendant) => {
    if (CF_BOUNDARY_KINDS.has(descendant.getKind())) {
      count++;
    }
  });
  return count;
}

/**
 * Extract the top-level statement children of `node`.
 *
 * "Top-level" means direct statement children of the body, not all
 * descendants. The following node kinds are handled:
 *   - SourceFile → getStatements()
 *   - Block → getStatements()
 *   - FunctionDeclaration / FunctionExpression / ArrowFunction →
 *     if the body is a Block, its statements; otherwise empty (expression body)
 *   - MethodDeclaration / Constructor / GetAccessor / SetAccessor →
 *     body?.getStatements() if available
 *   - Anything else → [] (expression-level nodes have no sub-statements)
 *
 * Returning [] for expression-level nodes means isAtom() will not invoke
 * findByCanonicalAstHash at all for them, and will simply return atomic when
 * the CF count is within bounds.
 */
function getTopLevelStatements(node: Node): Node[] {
  const kind = node.getKind();

  // SourceFile
  if (kind === SyntaxKind.SourceFile) {
    return (node as Parameters<typeof getTopLevelStatements>[0] & { getStatements(): Node[] })
      .getStatements()
      .slice();
  }

  // Block
  if (kind === SyntaxKind.Block) {
    return (node as Parameters<typeof getTopLevelStatements>[0] & { getStatements(): Node[] })
      .getStatements()
      .slice();
  }

  // Function-like nodes with a body
  if (
    kind === SyntaxKind.FunctionDeclaration ||
    kind === SyntaxKind.FunctionExpression ||
    kind === SyntaxKind.ArrowFunction ||
    kind === SyntaxKind.MethodDeclaration ||
    kind === SyntaxKind.Constructor ||
    kind === SyntaxKind.GetAccessor ||
    kind === SyntaxKind.SetAccessor
  ) {
    // ts-morph exposes getBody() on function-like nodes; the body may be a
    // Block or (for arrow functions) an expression.
    const fnNode = node as Node & { getBody?(): Node | undefined };
    const body = fnNode.getBody?.();
    if (body !== undefined && body.getKind() === SyntaxKind.Block) {
      return (body as Node & { getStatements(): Node[] }).getStatements().slice();
    }
    // Expression-body arrow function — no statements to decompose further.
    return [];
  }

  // All other node kinds (expressions, declarations without bodies, etc.)
  return [];
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Determine whether `node` is an "atom" in the WI-012 universalizer recursion.
 *
 * A node is atomic when:
 *   1. Its total control-flow boundary count ≤ maxControlFlowBoundaries (default 1).
 *   2. None of its top-level statement children match an existing primitive in
 *      the registry by canonicalAstHash (i.e. could be replaced by a known block).
 *
 * When criterion 1 fails, returns immediately without querying the registry.
 * When a sub-statement matches the registry, returns the first match with
 * matchedPrimitive populated.
 *
 * @param node     - The ts-morph Node to test.
 * @param source   - The full source text of the file `node` was parsed from.
 *                   Required to compute canonicalAstHash for sub-ranges.
 * @param registry - Registry view providing findByCanonicalAstHash.
 *                   Only the narrow `findByCanonicalAstHash` method is used.
 * @param options  - Optional tuning parameters (maxControlFlowBoundaries).
 */
export async function isAtom(
  node: Node,
  source: string,
  registry: Pick<ShaveRegistryView, "findByCanonicalAstHash">,
  options?: AtomTestOptions,
): Promise<AtomTestResult> {
  const maxCF = options?.maxControlFlowBoundaries ?? DEFAULT_MAX_CF_BOUNDARIES;

  // --- Criterion 1: control-flow boundary count ---
  const cfCount = countControlFlowBoundaries(node);
  if (cfCount > maxCF) {
    return {
      isAtom: false,
      reason: "too-many-cf-boundaries",
      controlFlowBoundaryCount: cfCount,
    };
  }

  // --- Criterion 2: known-primitive sub-statement check ---
  const statements = getTopLevelStatements(node);

  // Compute the candidate's own range to skip if a sub-statement IS the node.
  const nodeStart = node.getStart();
  const nodeEnd = node.getEnd();

  for (const stmt of statements) {
    const stmtStart = stmt.getStart();
    const stmtEnd = stmt.getEnd();

    // Skip if the statement is the entire candidate (avoid self-recognition).
    if (stmtStart === nodeStart && stmtEnd === nodeEnd) {
      continue;
    }

    const subHash: CanonicalAstHash = canonicalAstHash(source, {
      start: stmtStart,
      end: stmtEnd,
    });

    const matches = await registry.findByCanonicalAstHash?.(subHash);

    if (matches !== undefined && matches.length > 0) {
      const firstMatch = matches[0];
      if (firstMatch === undefined) continue;
      return {
        isAtom: false,
        reason: "contains-known-primitive",
        controlFlowBoundaryCount: cfCount,
        matchedPrimitive: {
          merkleRoot: firstMatch,
          canonicalAstHash: subHash,
          subRange: { start: stmtStart, end: stmtEnd },
        },
      };
    }
  }

  // Both criteria passed — the node is atomic.
  return {
    isAtom: true,
    reason: "atomic",
    controlFlowBoundaryCount: cfCount,
  };
}
