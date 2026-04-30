/**
 * @decision DEC-RECURSION-005
 * title: Decomposition recursion algorithm
 * status: proposed
 * rationale: Walks the AST top-down. At each node calls isAtom from WI-012-03.
 * If atomic, returns AtomLeaf. If not atomic, descends to "decomposable children"
 * (top-level statements for SourceFile/Block/function bodies; the branches of
 * control-flow nodes for IfStatement etc.). Recurses with depth+1. Throws
 * RecursionDepthExceededError if depth exceeds maxDepth. Throws
 * DidNotReachAtomError when a non-atomic node has no decomposable children —
 * the load-bearing failure mode the WI-012 reviewer gates on.
 *
 * Design choices:
 * - decompose() creates its own ts-morph Project. isAtom() also creates one
 *   internally in atom-test.ts. To avoid double-parsing overhead the node
 *   passed to isAtom() must be from the same Project instance created here;
 *   we therefore call isAtom() with the already-parsed Node objects directly.
 * - canonicalAstHash() from @yakcc/contracts creates its own Project to hash
 *   a source fragment. We call it with the slice of source text at the node's
 *   range so the hash is scoped to the fragment, avoiding "range-spans-multiple-
 *   nodes" errors that occur when passing a sub-range of a larger file.
 * - decomposableChildrenOf() implements the structural decomposition policy:
 *   which sub-nodes does the recursion descend into when a node is non-atomic?
 *   Expression-level nodes that cannot be decomposed further return []; if
 *   isAtom() incorrectly classifies them as non-atomic, DidNotReachAtomError fires.
 */

import { canonicalAstHash } from "@yakcc/contracts";
import { type Node, Project, ScriptKind, SyntaxKind } from "ts-morph";
import type { ShaveRegistryView } from "../types.js";
import { isAtom } from "./atom-test.js";
import type {
  AtomLeaf,
  AtomTestResult,
  BranchNode,
  RecursionNode,
  RecursionOptions,
  RecursionTree,
} from "./types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_MAX_DEPTH = 8;

// ---------------------------------------------------------------------------
// Error classes
// ---------------------------------------------------------------------------

/**
 * Thrown when decompose() encounters a non-atomic node that has no
 * decomposable children. This is the load-bearing failure mode: it means the
 * source contains a construct that isAtom() considers non-atomic but that
 * decomposableChildrenOf() cannot descend into further.
 *
 * The most common trigger: a registry that classifies every node as a known
 * primitive (isAtom returns false for every sub-statement) combined with a
 * leaf-level node that has no structural children to recurse into.
 */
export class DidNotReachAtomError extends Error {
  constructor(
    message: string,
    public readonly node: {
      readonly kind: number;
      readonly source: string;
      readonly range: { readonly start: number; readonly end: number };
    },
  ) {
    super(message);
    this.name = "DidNotReachAtomError";
  }
}

/**
 * Thrown when the recursion depth would exceed options.maxDepth (default 8).
 * This prevents infinite recursion on pathological AST shapes.
 */
export class RecursionDepthExceededError extends Error {
  constructor(
    public readonly depth: number,
    public readonly maxDepth: number,
  ) {
    super(`Recursion depth ${depth} exceeded maxDepth ${maxDepth}`);
    this.name = "RecursionDepthExceededError";
  }
}

// ---------------------------------------------------------------------------
// decomposableChildrenOf
// ---------------------------------------------------------------------------

/**
 * Return the AST nodes the recursion should descend into when `node` is
 * non-atomic. This is the structural decomposition policy:
 *
 * - SourceFile → its top-level statements.
 * - Block → its statements.
 * - FunctionDeclaration / FunctionExpression / ArrowFunction /
 *   MethodDeclaration / Constructor / GetAccessor / SetAccessor →
 *   if the body is a Block, its statements; else [] (expression body).
 * - IfStatement → [thenStatement, elseStatement?].
 * - ForStatement / WhileStatement / DoStatement → [statement (body)].
 * - ForInStatement / ForOfStatement → [statement (body)].
 * - SwitchStatement → all statements from all CaseClauses concatenated.
 * - TryStatement → [tryBlock, catchBlock?, finallyBlock?].
 * - ConditionalExpression (ternary) → [] (expression-level; should be atomic).
 * - Default → [] (no further decomposition; DidNotReachAtomError fires if
 *   isAtom classified this node as non-atomic).
 */
function decomposableChildrenOf(node: Node): readonly Node[] {
  const kind = node.getKind();

  // SourceFile
  if (kind === SyntaxKind.SourceFile) {
    return (node as Node & { getStatements(): Node[] }).getStatements();
  }

  // Block
  if (kind === SyntaxKind.Block) {
    return (node as Node & { getStatements(): Node[] }).getStatements();
  }

  // Function-like nodes: descend into body statements
  if (
    kind === SyntaxKind.FunctionDeclaration ||
    kind === SyntaxKind.FunctionExpression ||
    kind === SyntaxKind.ArrowFunction ||
    kind === SyntaxKind.MethodDeclaration ||
    kind === SyntaxKind.Constructor ||
    kind === SyntaxKind.GetAccessor ||
    kind === SyntaxKind.SetAccessor
  ) {
    const fnNode = node as Node & { getBody?(): Node | undefined };
    const body = fnNode.getBody?.();
    if (body !== undefined && body.getKind() === SyntaxKind.Block) {
      return (body as Node & { getStatements(): Node[] }).getStatements();
    }
    // Expression-body arrow function — not further decomposable.
    return [];
  }

  // IfStatement: then-branch and optional else-branch
  if (kind === SyntaxKind.IfStatement) {
    const ifNode = node as Node & {
      getThenStatement(): Node;
      getElseStatement(): Node | undefined;
    };
    const branches: Node[] = [ifNode.getThenStatement()];
    const elseStmt = ifNode.getElseStatement();
    if (elseStmt !== undefined) {
      branches.push(elseStmt);
    }
    return branches;
  }

  // ForStatement, WhileStatement, DoStatement: the loop body
  if (
    kind === SyntaxKind.ForStatement ||
    kind === SyntaxKind.WhileStatement ||
    kind === SyntaxKind.DoStatement
  ) {
    const loopNode = node as Node & { getStatement(): Node };
    return [loopNode.getStatement()];
  }

  // ForInStatement, ForOfStatement: the loop body
  if (kind === SyntaxKind.ForInStatement || kind === SyntaxKind.ForOfStatement) {
    const forInOf = node as Node & { getStatement(): Node };
    return [forInOf.getStatement()];
  }

  // SwitchStatement: flatten all case clause statements
  if (kind === SyntaxKind.SwitchStatement) {
    const sw = node as Node & {
      getCaseBlock(): Node & {
        getClauses(): Array<Node & { getStatements(): Node[] }>;
      };
    };
    const clauses = sw.getCaseBlock().getClauses();
    const result: Node[] = [];
    for (const clause of clauses) {
      result.push(...clause.getStatements());
    }
    return result;
  }

  // TryStatement: try block, catch block, finally block
  if (kind === SyntaxKind.TryStatement) {
    const tryNode = node as Node & {
      getTryBlock(): Node;
      getCatchClause(): (Node & { getBlock(): Node }) | undefined;
      getFinallyBlock(): Node | undefined;
    };
    const result: Node[] = [tryNode.getTryBlock()];
    const catchClause = tryNode.getCatchClause();
    if (catchClause !== undefined) {
      result.push(catchClause.getBlock());
    }
    const finallyBlock = tryNode.getFinallyBlock();
    if (finallyBlock !== undefined) {
      result.push(finallyBlock);
    }
    return result;
  }

  // All other nodes (expressions, type nodes, etc.) — not decomposable.
  return [];
}

// ---------------------------------------------------------------------------
// Supplemental registry check
// ---------------------------------------------------------------------------

/**
 * Returns true when any decomposable child of `node` matches the registry by
 * canonicalAstHash. This supplements isAtom()'s criterion 2 to handle the
 * edge case where isAtom()'s self-recognition guard fires incorrectly:
 * when a SourceFile (or Block) has a single child whose source range equals
 * the parent's range, isAtom() skips the registry query for that child via
 * its `stmtStart === nodeStart && stmtEnd === nodeEnd` guard. This guard was
 * designed to avoid self-recognition but misfires when the single child
 * spans the same character range as the container.
 *
 * This check is only invoked when isAtom() returns {isAtom: true} AND the
 * node has decomposable children — the scenario where the guard can misfire.
 *
 * @decision DEC-RECURSION-005-SUPPLEMENT
 * title: Supplemental registry check for same-range container nodes
 * status: decided
 * rationale: atom-test.ts's self-recognition guard is in a forbidden file;
 * this local supplement in recursion.ts corrects the misfiring case without
 * modifying the atom-test predicate.
 */
async function childMatchesRegistry(
  node: Node,
  source: string,
  registry: Pick<ShaveRegistryView, "findByCanonicalAstHash">,
): Promise<boolean> {
  const children = decomposableChildrenOf(node);
  if (children.length === 0) return false;

  for (const child of children) {
    const childStart = child.getStart();
    const childEnd = child.getEnd();
    const childSource = source.slice(childStart, childEnd);
    const childHash = canonicalAstHash(childSource);
    const matches = await registry.findByCanonicalAstHash?.(childHash);
    if (matches !== undefined && matches.length > 0) {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Public API: decompose()
// ---------------------------------------------------------------------------

/**
 * Decompose a TypeScript source string into a RecursionTree by walking the
 * AST top-down, classifying each node via isAtom(), and recursing into
 * non-atomic nodes' decomposable children.
 *
 * The recursion bottoms out at atomic nodes (AtomLeaf) or throws when it
 * encounters a non-atomic node with no decomposable children
 * (DidNotReachAtomError).
 *
 * @param source   - Full TypeScript source text to decompose.
 * @param registry - Registry view used by isAtom() for known-primitive checks.
 * @param options  - Tuning: maxDepth (default 8), maxControlFlowBoundaries (default 1).
 *
 * @throws {RecursionDepthExceededError} When depth exceeds options.maxDepth.
 * @throws {DidNotReachAtomError}        When a non-atomic node has no children.
 */
export async function decompose(
  source: string,
  registry: Pick<ShaveRegistryView, "findByCanonicalAstHash">,
  options?: RecursionOptions,
): Promise<RecursionTree> {
  const project = new Project({
    useInMemoryFileSystem: true,
    compilerOptions: { allowJs: false, noEmit: true },
  });
  const file = project.createSourceFile("anonymous.ts", source, {
    scriptKind: ScriptKind.TS,
  });

  const maxDepth = options?.maxDepth ?? DEFAULT_MAX_DEPTH;

  let leafCount = 0;
  let maxObservedDepth = 0;

  async function recurse(node: Node, depth: number): Promise<RecursionNode> {
    if (depth > maxDepth) {
      throw new RecursionDepthExceededError(depth, maxDepth);
    }
    if (depth > maxObservedDepth) {
      maxObservedDepth = depth;
    }

    const start = node.getStart();
    const end = node.getEnd();
    const nodeSource = source.slice(start, end);

    // Compute canonical hash for this node's source fragment.
    // We pass the fragment's own source text (not the full file with a range)
    // to avoid the "range-spans-multiple-nodes" error that canonicalAstHash
    // can throw when a range doesn't align to a single AST node in the full file.
    const hash = canonicalAstHash(nodeSource);

    const atomResult: AtomTestResult = await isAtom(node, source, registry, options);

    if (atomResult.isAtom) {
      // Supplemental check: isAtom()'s self-recognition guard can misfire when
      // a container node (e.g. SourceFile) has a single child whose source
      // range equals the parent's range. In that case the guard skips the
      // registry query for the child and returns isAtom=true incorrectly.
      // We compensate by querying the registry for each decomposable child
      // directly. If any child matches, we fall through to branch recursion.
      const childMatched = await childMatchesRegistry(node, source, registry);
      if (!childMatched) {
        leafCount += 1;
        const leaf: AtomLeaf = {
          kind: "atom",
          sourceRange: { start, end },
          source: nodeSource,
          canonicalAstHash: hash,
          atomTest: atomResult,
        };
        return leaf;
      }
      // A child matched — fall through to branch handling below.
    }

    const children = decomposableChildrenOf(node);

    if (children.length === 0) {
      throw new DidNotReachAtomError(
        `Node at [${start},${end}) (kind=${node.getKindName()}) is not atomic and has no decomposable children`,
        {
          kind: node.getKind(),
          source: nodeSource,
          range: { start, end },
        },
      );
    }

    const recursedChildren: RecursionNode[] = [];
    for (const child of children) {
      recursedChildren.push(await recurse(child, depth + 1));
    }

    const branch: BranchNode = {
      kind: "branch",
      sourceRange: { start, end },
      source: nodeSource,
      canonicalAstHash: hash,
      atomTest: atomResult,
      children: recursedChildren,
    };
    return branch;
  }

  const root = await recurse(file, 0);

  return { root, leafCount, maxDepth: maxObservedDepth };
}
