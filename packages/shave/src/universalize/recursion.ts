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
 *
 * @decision DEC-SLICER-LOOP-CONTROL-FLOW-001
 * title: Loop with escaping continue/break is the atom; body is not decomposed
 * status: decided
 * rationale:
 *   Loop bodies containing continue/break (or labeled jumps targeting an
 *   enclosing loop) are not valid standalone TypeScript programs. Hashing
 *   such a fragment via canonicalAstHash() raises TS1313/1314 syntax
 *   diagnostics, which canonical-ast.ts correctly converts to
 *   CanonicalAstParseError. The fragment also has no self-contained
 *   behavioral contract — its semantics depend on the enclosing iteration
 *   target. We therefore treat the smallest enclosing iteration as the atom
 *   boundary: decomposableChildrenOf returns [] for a loop whose body has
 *   escaping control flow, and recurse() emits an AtomLeaf for the loop
 *   itself with atomTest.reason = "loop-with-escaping-cf".
 * alternatives:
 *   B (typed unsliceable sentinel): identical end-state; rejected as more
 *     plumbing than the policy warrants — no consumer needs the sentinel.
 *   C (rewrite continue->return at extraction time): rejected; changes
 *     semantics, breaks WI-V2-09 byte-identical bootstrap, and requires
 *     rewriting the call site of every shaved loop.
 * consequences:
 *   - Atom granularity coarsens for any function whose hot path is one big
 *     loop with continue/break. Affected yakcc files include storage.ts,
 *     assemble-candidate.ts, and recursion.ts itself; each becomes a single
 *     atom rather than an atom-per-loop-body-statement. Estimated impact:
 *     ~15-30% of yakcc functions decompose to one fewer level. Trade-off
 *     accepted — strictly better than the current state of total decompose
 *     failure on those functions.
 *   - Compatible with WI-V2-09 bootstrap: the loop is hashed as a whole, the
 *     same way on every pass.
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
// Context-safe hashing
// ---------------------------------------------------------------------------

/**
 * Statement SyntaxKinds that are syntactically invalid at file scope when
 * extracted as standalone source fragments. These statements are valid only
 * inside a function body (ReturnStatement), an iteration statement
 * (ContinueStatement), or an iteration/switch statement (BreakStatement).
 * Passing their source text to canonicalAstHash() as-is raises TS1108/1313/1314.
 *
 * When we encounter one of these as an atom leaf, we wrap its source text in
 * a synthetic function body before hashing. The wrapping is transparent to
 * consumers because emitCanonical targets the inner statement node, not the
 * wrapper — the hash is identical to what we'd get if we could hash the
 * statement standalone.
 *
 * NOTE: ContinueStatement and BreakStatement should normally be handled by the
 * loop pre-flight in recurse() and never reach this path. ReturnStatement,
 * ThrowStatement, and YieldExpression (as a statement) are the common cases.
 */
const CONTEXT_DEPENDENT_STATEMENT_KINDS = new Set([
  SyntaxKind.ReturnStatement,
  SyntaxKind.ContinueStatement,
  SyntaxKind.BreakStatement,
  SyntaxKind.YieldExpression,
]);

/**
 * Compute the canonical AST hash for a node, handling context-dependent
 * statements that cannot be parsed standalone as valid TypeScript files.
 *
 * Cases handled:
 *  - return/continue/break/yield as leaf statements: wrapped in a synthetic
 *    function body `function __w__() { <stmt> }` with a sourceRange targeting
 *    the inner statement, so the hash is identical to a standalone parse.
 *  - Loop nodes whose fragment contains escaping labeled break/continue: the
 *    fragment is not a valid standalone TS file (TS1364: break target unknown).
 *    Fallback: use the full source string with the node's byte range, which IS
 *    valid TS since the full source contains the enclosing label. emitCanonical
 *    targets only the inner loop node, so the hash is context-independent.
 *  - All other nodes: delegated to canonicalAstHash(nodeSource) directly.
 *
 * @param node       - The ts-morph Node being hashed (used for kind dispatch).
 * @param nodeSource - The source text slice for the node (source[start..end]).
 * @param fullSource - The complete source passed to decompose() — used as
 *                     context fallback for loop fragments with escaping labels.
 * @param start      - Byte offset of the node in fullSource.
 * @param end        - Byte end of the node in fullSource.
 */
function safeCanonicalAstHash(
  node: Node,
  nodeSource: string,
  fullSource: string,
  start: number,
  end: number,
): ReturnType<typeof canonicalAstHash> {
  const kind = node.getKind();

  if (CONTEXT_DEPENDENT_STATEMENT_KINDS.has(kind)) {
    // Wrap in a synthetic function so the statement is syntactically valid.
    // Fixed prefix length ensures the inner statement starts at a known offset.
    const PREFIX = "function __w__() { ";
    const wrapped = `${PREFIX}${nodeSource} }`;
    const innerStart = PREFIX.length;
    const innerEnd = PREFIX.length + nodeSource.length;
    return canonicalAstHash(wrapped, { start: innerStart, end: innerEnd });
  }

  if (LOOP_KINDS.has(kind)) {
    // Loop nodes can contain labeled break/continue targeting an outer label.
    // When hashed standalone those labels have no binding target → TS1364.
    // Try the fragment first (the common case: loop has only unlabeled CF).
    // If that fails, fall back to the full source with a sourceRange, which
    // is always valid TS and lets emitCanonical target only the loop subtree.
    try {
      return canonicalAstHash(nodeSource);
    } catch {
      // Fragment has escaping label reference — use full source + range.
      return canonicalAstHash(fullSource, { start, end });
    }
  }

  return canonicalAstHash(nodeSource);
}

// ---------------------------------------------------------------------------
// Loop control-flow escape predicate
// ---------------------------------------------------------------------------

/** SyntaxKinds that are loop iteration statements. */
const LOOP_KINDS = new Set([
  SyntaxKind.ForStatement,
  SyntaxKind.WhileStatement,
  SyntaxKind.DoStatement,
  SyntaxKind.ForInStatement,
  SyntaxKind.ForOfStatement,
]);

/** SyntaxKinds that are loop iteration statements OR switch (for unlabeled break). */
const BREAK_BINDING_KINDS = new Set([
  SyntaxKind.ForStatement,
  SyntaxKind.WhileStatement,
  SyntaxKind.DoStatement,
  SyntaxKind.ForInStatement,
  SyntaxKind.ForOfStatement,
  SyntaxKind.SwitchStatement,
]);

/**
 * Returns true if `blockNode` contains a `continue` or `break` (labeled or
 * unlabeled) whose target binding scope is OUTSIDE `blockNode` — i.e., the
 * statement would be an unbound jump if `blockNode`'s source were parsed
 * standalone via canonicalAstHash().
 *
 * Walk rule:
 *   unlabeled continue: binds to the nearest For/While/Do/ForIn/ForOf ancestor.
 *   unlabeled break:    binds to the nearest For/While/Do/ForIn/ForOf/Switch ancestor.
 *   labeled continue/break: binds to the nearest LabeledStatement ancestor
 *                           whose label text matches.
 *
 * If the binding ancestor starts before blockNode.start OR ends after
 * blockNode.end, the control flow escapes the block.
 *
 * @decision DEC-SLICER-LOOP-CONTROL-FLOW-001 (see file leading comment)
 */
function hasEscapingLoopControlFlow(blockNode: Node): boolean {
  const blockStart = blockNode.getStart();
  const blockEnd = blockNode.getEnd();

  let found = false;

  blockNode.forEachDescendant((descendant) => {
    if (found) return;

    const kind = descendant.getKind();

    if (kind === SyntaxKind.ContinueStatement || kind === SyntaxKind.BreakStatement) {
      const isContinue = kind === SyntaxKind.ContinueStatement;
      const bindingKinds = isContinue ? LOOP_KINDS : BREAK_BINDING_KINDS;

      // Extract label text if present (e.g. `break outer`)
      const labelNode = (descendant as Node & { getLabel?(): Node | undefined }).getLabel?.();
      const labelText = labelNode?.getText();

      // Walk ancestors upward to find the binding scope
      let cursor: Node | undefined = descendant.getParent();
      while (cursor !== undefined) {
        const cursorKind = cursor.getKind();

        if (labelText !== undefined) {
          // Labeled jump: look for matching LabeledStatement
          if (cursorKind === SyntaxKind.LabeledStatement) {
            const ls = cursor as Node & { getLabel(): Node };
            if (ls.getLabel().getText() === labelText) {
              // Found the binding scope — check if it's outside blockNode
              const cStart = cursor.getStart();
              const cEnd = cursor.getEnd();
              if (cStart < blockStart || cEnd > blockEnd) {
                found = true;
              }
              return; // stop walking ancestors for this jump
            }
          }
        } else {
          // Unlabeled jump: look for iteration or switch ancestor
          if (bindingKinds.has(cursorKind)) {
            const cStart = cursor.getStart();
            const cEnd = cursor.getEnd();
            if (cStart < blockStart || cEnd > blockEnd) {
              found = true;
            }
            return; // stop walking ancestors for this jump
          }
        }

        cursor = cursor.getParent();
      }
      // If no binding ancestor was found at all, the jump is unbound —
      // it definitely escapes the block.
      found = true;
    }
  });

  return found;
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
 * - ForStatement / WhileStatement / DoStatement → [statement (body)],
 *   unless the body Block has escaping continue/break; then [] (loop is atom).
 * - ForInStatement / ForOfStatement → [statement (body)],
 *   unless the body Block has escaping continue/break; then [] (loop is atom).
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

  // ForStatement, WhileStatement, DoStatement: the loop body —
  // but only when the body block has no escaping continue/break.
  // If it does, return [] so recurse() emits an AtomLeaf for the loop.
  // (DEC-SLICER-LOOP-CONTROL-FLOW-001)
  if (
    kind === SyntaxKind.ForStatement ||
    kind === SyntaxKind.WhileStatement ||
    kind === SyntaxKind.DoStatement
  ) {
    const loopNode = node as Node & { getStatement(): Node };
    const body = loopNode.getStatement();
    if (body.getKind() === SyntaxKind.Block && hasEscapingLoopControlFlow(body)) {
      return []; // loop is the atom; do not descend into body
    }
    return [body];
  }

  // ForInStatement, ForOfStatement: the loop body —
  // same escaping-CF check. (DEC-SLICER-LOOP-CONTROL-FLOW-001)
  if (kind === SyntaxKind.ForInStatement || kind === SyntaxKind.ForOfStatement) {
    const forInOf = node as Node & { getStatement(): Node };
    const body = forInOf.getStatement();
    if (body.getKind() === SyntaxKind.Block && hasEscapingLoopControlFlow(body)) {
      return []; // loop is the atom; do not descend into body
    }
    return [body];
  }

  // LabeledStatement: forward to the labeled body statement.
  // Without this, labeled loops (e.g. `outer: for (...)`) produce a
  // LabeledStatement node that has no decomposable children, throwing
  // DidNotReachAtomError even when the loop body is valid.
  if (kind === SyntaxKind.LabeledStatement) {
    const ls = node as Node & { getStatement(): Node };
    return [ls.getStatement()];
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
    const childHash = safeCanonicalAstHash(child, childSource, source, childStart, childEnd);
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

    // Hash is computed lazily — only when we know the node will become a
    // leaf or branch in the output tree. safeCanonicalAstHash wraps
    // context-dependent statements (return/continue/break) in a synthetic
    // function body so they can be parsed standalone without TS1108/1313/1314.
    const computeHash = () => safeCanonicalAstHash(node, nodeSource, source, start, end);

    // Pre-flight: a loop whose body has escaping continue/break IS the atom.
    // Short-circuit before isAtom() classification to avoid attempting to hash
    // the body block standalone (which would raise TS1313/1314 in canonical-ast.ts).
    // (DEC-SLICER-LOOP-CONTROL-FLOW-001)
    if (LOOP_KINDS.has(node.getKind())) {
      const loopNode = node as Node & { getStatement(): Node };
      const body = loopNode.getStatement();
      if (body.getKind() === SyntaxKind.Block && hasEscapingLoopControlFlow(body)) {
        leafCount += 1;
        const cfCount = options?.maxControlFlowBoundaries ?? 1;
        const leaf: AtomLeaf = {
          kind: "atom",
          sourceRange: { start, end },
          source: nodeSource,
          canonicalAstHash: computeHash(),
          atomTest: {
            isAtom: true,
            reason: "loop-with-escaping-cf",
            controlFlowBoundaryCount: cfCount,
          },
        };
        return leaf;
      }
    }

    const atomResult: AtomTestResult = await isAtom(node, source, registry, options);

    if (atomResult.isAtom) {
      // Supplemental check: isAtom()'s self-recognition guard can misfire when
      // a container node (e.g. SourceFile) has a single child whose source
      // range equals the parent's range. In that case the guard skips the
      // registry query for the child and returns isAtom=true incorrectly.
      // We compensate by querying the registry for each decomposable child
      // directly. If any child matches, we fall through to branch handling.
      const childMatched = await childMatchesRegistry(node, source, registry);
      if (!childMatched) {
        leafCount += 1;
        const leaf: AtomLeaf = {
          kind: "atom",
          sourceRange: { start, end },
          source: nodeSource,
          canonicalAstHash: computeHash(),
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
      canonicalAstHash: computeHash(),
      atomTest: atomResult,
      children: recursedChildren,
    };
    return branch;
  }

  const root = await recurse(file, 0);

  return { root, leafCount, maxDepth: maxObservedDepth };
}
