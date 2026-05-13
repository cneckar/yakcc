// SPDX-License-Identifier: MIT
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
 *
 * @decision DEC-SLICER-FN-SCOPED-CF-001
 * title: Non-leaf fragments containing escaping return/await/yield wrap in
 *        synthetic function for canonical hashing
 * status: decided
 * rationale:
 *   Existing safeCanonicalAstHash wraps leaf return/break/continue/yield
 *   statements. But non-leaf nodes (IfStatement, TryStatement, Block) often
 *   CONTAIN such constructs whose binding scope is the enclosing function —
 *   outside the extracted fragment. Hashing the fragment standalone fails
 *   with TS1108/TS1308. Strategy: pre-flight detection of escaping
 *   function-scoped constructs in the node's descendants; wrap in the
 *   appropriate synthetic function flavor (function* for yield, async
 *   function for await, function for return). emitCanonical targets the
 *   inner range so the hash is identical to a hypothetical "parse in original
 *   context" outcome.
 * consequences:
 *   - Survey shows this fix flips ~44 of 117 yakcc-self-shave failures from
 *     canonical-ast errors to successful decompose. Brings yakcc-on-yakcc
 *     success rate from 59.8% baseline (post-WI-033) toward ~97%.
 *   - Compatible with WI-V2-09 byte-identical bootstrap: wrap is deterministic
 *     and emitCanonical scoping ensures hashes are wrap-independent.
 *   - No public-API surface change; entirely internal to recursion.ts.
 *
 * @decision DEC-SLICER-CHILDREN-CLASS-EXPR-VAR-001
 * title: ClassDeclaration / ExpressionStatement / VariableStatement /
 *        CallExpression decompose to natural sub-nodes
 * status: decided
 * rationale:
 *   WI-034's audit found 5 of the 9 remaining yakcc-self-shave failures were
 *   did-not-reach-atom on ClassDeclaration / ExpressionStatement /
 *   VariableStatement nodes, which had no decomposableChildrenOf policy.
 *   Adding the natural sub-node enumeration (class members, wrapped
 *   expression, declaration initializers) lets the slicer descend through
 *   these container shapes and find atoms at the next level. No new wrap or
 *   hash machinery — the existing safeCanonicalAstHash already handles the
 *   result.
 *   A CallExpression branch was added as well (WI-036 iterative discovery):
 *   descending ExpressionStatement / VariableStatement exposed CallExpression
 *   nodes (e.g. db.transaction(fn), sorted.sort(comparator)) whose function
 *   arguments are ArrowFunction or FunctionExpression — i.e. they carry
 *   decomposable behavior. The branch descends only into function-like args.
 * consequences:
 *   - yakcc-self-shave success: 92.3% → 94.0% (110/117).
 *   - packages/contracts/src/ + packages/registry/src/ subset reaches 100%
 *     (13/13), unblocking brother session's WI-V2-01 first-contact bootstrap
 *     demo without per-file workarounds.
 *   - PropertyDeclaration with initializer also decomposes — class fields
 *     that bind closures or arrow functions become decomposable. Property
 *     declarations without initializers (interface-shape fields) skipped.
 *   - Remaining 7 failures: 2 ReturnStatement (giant non-leaf, deferred),
 *     2 ConditionalExpression (expression-level), 1 BinaryExpression
 *     (expression-level), 1 await-outside-async edge case, 1 B-014 parser.
 *   - Compatible with WI-V2-09 byte-identical bootstrap: deterministic node
 *     enumeration, same shape on every pass.
 *
 * @decision DEC-SLICER-CHILDREN-EXPR-LEVEL-001
 * title: ConditionalExpression / BinaryExpression / ReturnStatement decompose
 *        to natural sub-expressions
 * status: decided
 * rationale:
 *   WI-036 added decompose policies for container statements (Class, ExprStmt,
 *   VarStmt). WI-037 extends to expression-level constructs (ternary, binary
 *   ops) and return-with-expression that the slicer would otherwise hit
 *   did-not-reach-atom on. The default `return []` branch was overly
 *   conservative for these well-defined node shapes. Closes the slicer-policy
 *   arc; remaining slicer failures (if any) require either canonical-ast
 *   changes or per-file investigation.
 *   - ConditionalExpression: ternary `cond ? then : else` — decompose to
 *     [condition, whenTrue, whenFalse].
 *   - BinaryExpression: `left op right` — decompose to [left, right].
 *   - ReturnStatement with expression: `return <expr>` — decompose to [expr].
 *     A bare `return;` (no expression) falls through to the leaf wrapper in
 *     safeCanonicalAstHash. This handles the federation/serve.ts close() shape:
 *     `return new Promise<void>((resolve, reject) => { ... })` — the slicer
 *     descends into the arrow fn passed to Promise rather than treating the
 *     entire return as an unsliceable atom.
 * consequences:
 *   - yakcc-self-shave success: 94% -> 99-100%.
 *   - WI-V2-01 bootstrap can now run on substantially all yakcc source
 *     without per-file workarounds, unlocking real two-pass equivalence
 *     measurement.
 *   - Compatible with WI-V2-09 byte-identical bootstrap: deterministic node
 *     enumeration, same shape on every pass.
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

/**
 * @decision DEC-SLICER-MAX-DEPTH-001
 * title: Raise default maxDepth from 8 to 24 for real-world code
 * status: decided
 * rationale:
 *   v0.7's default maxDepth=8 was set when the slicer rarely descended past
 *   3-4 levels (small atomic functions only). Post WI-036/037 the slicer
 *   legitimately descends through Promise chains, IIFE wrappers, and deeply
 *   nested object literals — real-world code easily reaches depth 10-15.
 *   3 of 4 yakcc-self-shave failures at WI-037 close were depth-exceeded on
 *   legit code, not infinite recursion. Raising to 24 gives meaningful
 *   headroom while still catching pathological cases. Callers needing a
 *   tighter ceiling can pass maxDepth explicitly via RecursionOptions.
 * consequences:
 *   - yakcc-self-shave: 96.6% -> 99.x% (3 files unblocked).
 *   - No production impact: legitimately deep code now decomposes; nothing
 *     that previously succeeded now fails.
 */
const DEFAULT_MAX_DEPTH = 24;

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
 *  - Non-leaf nodes containing escaping return/await/yield (DEC-SLICER-FN-SCOPED-CF-001):
 *    walk descendants; if any return/await/yield escapes its binding function
 *    scope, wrap nodeSource in the appropriate synthetic function flavor
 *    (function* for yield, async function for await, function for return).
 *    Fall back to full-source + range if the wrap still fails.
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
    //
    // Choose the right wrapper flavor based on whether the statement contains
    // escaping await/yield constructs that require an async/generator context:
    //   - YieldExpression → function* __w__()
    //   - AwaitExpression (escaping) → async function __w__()
    //   - plain return/continue/break → function __w__()
    //
    // Without this, `return await x;` inside `function __w__() { ... }` raises
    // TS1308 (await outside async), which is the root cause of the pull.ts
    // canonical-ast--await failure (WI-038 sub-task b).
    const escapes = detectEscapingFunctionScopedConstructs(node);
    const PREFIX = escapes.yield
      ? "function* __w__() { "
      : escapes.await
        ? "async function __w__() { "
        : "function __w__() { ";
    const wrapped = `${PREFIX}${nodeSource} }`;
    const innerStart = PREFIX.length;
    const innerEnd = PREFIX.length + nodeSource.length;
    try {
      return canonicalAstHash(wrapped, { start: innerStart, end: innerEnd });
    } catch {
      // Wrap still failed (e.g. super references or nested generator context).
      // Fall back to full-source + range, which preserves all binding scopes.
      return canonicalAstHash(fullSource, { start, end });
    }
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

  // DEC-SLICER-FN-SCOPED-CF-001: non-leaf nodes containing escaping
  // return/await/yield whose binding function scope is outside the extracted
  // fragment. Detect and wrap in the appropriate synthetic function flavor.
  const escapes = detectEscapingFunctionScopedConstructs(node);
  if (escapes.return || escapes.await || escapes.yield) {
    const prefix = escapes.yield
      ? "function* __w__() { "
      : escapes.await
        ? "async function __w__() { "
        : "function __w__() { ";
    const wrapped = `${prefix}${nodeSource} }`;
    try {
      return canonicalAstHash(wrapped, {
        start: prefix.length,
        end: prefix.length + nodeSource.length,
      });
    } catch {
      // Wrap still failed (e.g. super references, nested generator context).
      // Fall through to full-source fallback below.
    }
  }

  // Last resort: try standalone first; if it fails use full source + range.
  // Full source always contains the original binding scopes so it is valid TS;
  // emitCanonical targets only the node's range, keeping the hash context-free.
  try {
    return canonicalAstHash(nodeSource);
  } catch {
    return canonicalAstHash(fullSource, { start, end });
  }
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
// Function-scoped control-flow escape predicate (DEC-SLICER-FN-SCOPED-CF-001)
// ---------------------------------------------------------------------------

/**
 * SyntaxKinds that introduce a function boundary — a new binding scope for
 * return, await, and yield. ArrowFunctions bind return implicitly; they bind
 * await/yield only when marked async/generator. All entries here are treated
 * as binding scopes for ReturnStatement regardless.
 */
const FUNCTION_KINDS = new Set([
  SyntaxKind.FunctionDeclaration,
  SyntaxKind.FunctionExpression,
  SyntaxKind.ArrowFunction,
  SyntaxKind.MethodDeclaration,
  SyntaxKind.Constructor,
  SyntaxKind.GetAccessor,
  SyntaxKind.SetAccessor,
]);

/**
 * Returns true if `node` is an async function-like.
 *
 * Uses three layered checks to handle all ts-morph node shapes robustly:
 *
 * 1. ts-morph isAsync() — the canonical check for FunctionDeclaration,
 *    FunctionExpression, ArrowFunction, MethodDeclaration. Preferred because it
 *    targets the correct node level: for `const f = async (x) => { await x; }`
 *    the AsyncKeyword lives on the ArrowFunction, not the VariableDeclaration.
 *    Wrapped in try/catch: some ts-morph node types have `isAsync` as a property
 *    at the TypeScript type level but throw at runtime (e.g. certain
 *    MethodDeclaration shorthand forms on ObjectLiteralExpression). The catch
 *    prevents a crash and falls through to the modifier scan.
 *
 * 2. getModifiers() scan — checks the modifier list for AsyncKeyword. Handles
 *    async method-shorthand on object literals (`{ async foo() { await x; } }`)
 *    where isAsync() may not be implemented but the AsyncKeyword appears as a
 *    modifier. Also covers edge cases where isAsync() throws.
 *
 * 3. getFirstChildIfKind(AsyncKeyword) — last resort for any remaining node
 *    kind where the async keyword appears as a direct child token but neither
 *    isAsync() nor getModifiers() found it.
 *
 * This layered approach fixes the `canonical-ast--await` failure on
 * packages/federation/src/pull.ts (WI-038 sub-task b).
 */
function nodeIsAsync(node: Node): boolean {
  // Layer 1: ts-morph isAsync() — canonical API, wrapped in try/catch.
  const asAsyncable = node as Node & { isAsync?(): boolean };
  if (typeof asAsyncable.isAsync === "function") {
    try {
      if (asAsyncable.isAsync()) return true;
    } catch {
      // Some node kinds don't actually implement isAsync() at runtime;
      // fall through to modifier scan.
    }
  }
  // Layer 2: getModifiers() — handles async-method-shorthand on object literals
  // and other cases where isAsync() is absent or throws.
  const withModifiers = node as Node & { getModifiers?(): readonly Node[] };
  const mods = withModifiers.getModifiers?.();
  if (mods !== undefined) {
    for (const m of mods) {
      if (m.getKind() === SyntaxKind.AsyncKeyword) return true;
    }
  }
  // Layer 3: explicit AsyncKeyword as first child token — last resort.
  const asyncKw = (
    node as Node & { getFirstChildIfKind?(k: SyntaxKind): Node | undefined }
  ).getFirstChildIfKind?.(SyntaxKind.AsyncKeyword);
  return asyncKw !== undefined;
}

/**
 * Returns true if `node` is a generator function (has an asterisk token).
 * Used to distinguish plain/async functions from generators when detecting
 * escaping yield expressions.
 */
function nodeIsGenerator(node: Node): boolean {
  const asterisk = (node as Node & { getAsteriskToken?(): Node | undefined }).getAsteriskToken?.();
  return asterisk !== undefined;
}

/**
 * Walk ancestors of `descendant` looking for the nearest function-kind node
 * that satisfies the `variant` requirement. Returns true if such an ancestor
 * is found AND lies entirely within [blockStart, blockEnd] (i.e. it is
 * "inside" the block being hashed, so the construct is bound locally).
 *
 * @param descendant - The return/await/yield node.
 * @param blockStart - Inclusive start of the extracted block.
 * @param blockEnd   - Exclusive end of the extracted block.
 * @param variant    - "async" requires nodeIsAsync, "generator" requires
 *                     nodeIsGenerator, undefined accepts any function kind.
 */
function hasEnclosingBindingInside(
  descendant: Node,
  blockStart: number,
  blockEnd: number,
  variant: "async" | "generator" | undefined,
): boolean {
  let cursor: Node | undefined = descendant.getParent();
  while (cursor !== undefined) {
    if (FUNCTION_KINDS.has(cursor.getKind())) {
      // For async/generator detection, require the relevant marker.
      if (variant === "async" && !nodeIsAsync(cursor)) {
        cursor = cursor.getParent();
        continue;
      }
      if (variant === "generator" && !nodeIsGenerator(cursor)) {
        cursor = cursor.getParent();
        continue;
      }
      // Found a qualifying function ancestor — is it inside the block?
      return cursor.getStart() >= blockStart && cursor.getEnd() <= blockEnd;
    }
    cursor = cursor.getParent();
  }
  // No qualifying function ancestor found at all → construct is unbound.
  return false;
}

/**
 * Scan `node`'s descendants for return/await/yield constructs whose binding
 * function scope lies OUTSIDE `node`. Returns a flag object indicating which
 * flavors were found.
 *
 * Rules:
 *  - ReturnStatement: binding scope = nearest enclosing function (any kind).
 *  - AwaitExpression: binding scope = nearest enclosing async function.
 *  - YieldExpression: binding scope = nearest enclosing generator function.
 *
 * If the binding ancestor either does not exist or lies outside the node's
 * range, the construct "escapes" — hashing the fragment standalone would fail.
 *
 * @decision DEC-SLICER-FN-SCOPED-CF-001 (see file leading comment)
 */
function detectEscapingFunctionScopedConstructs(node: Node): {
  return: boolean;
  await: boolean;
  yield: boolean;
} {
  const blockStart = node.getStart();
  const blockEnd = node.getEnd();
  let hasReturn = false;
  let hasAwait = false;
  let hasYield = false;

  node.forEachDescendant((d) => {
    // Short-circuit once all three flags are set.
    if (hasReturn && hasAwait && hasYield) return;

    const k = d.getKind();

    if (!hasReturn && k === SyntaxKind.ReturnStatement) {
      if (!hasEnclosingBindingInside(d, blockStart, blockEnd, undefined)) {
        hasReturn = true;
      }
    }
    if (!hasAwait && k === SyntaxKind.AwaitExpression) {
      if (!hasEnclosingBindingInside(d, blockStart, blockEnd, "async")) {
        hasAwait = true;
      }
    }
    if (!hasYield && k === SyntaxKind.YieldExpression) {
      if (!hasEnclosingBindingInside(d, blockStart, blockEnd, "generator")) {
        hasYield = true;
      }
    }
  });

  return { return: hasReturn, await: hasAwait, yield: hasYield };
}

// ---------------------------------------------------------------------------
// Callee unwrapper helper (DEC-SLICER-CALLEE-OBJ-LITERAL-001)
// ---------------------------------------------------------------------------

/**
 * Unwrap the callee of a CallExpression to find the first node that
 * `decomposableChildrenOf` can usefully recurse into. Returns `undefined`
 * when the callee chain contains nothing worth descending into.
 *
 * Handles three shapes in priority order:
 *
 * 1. **IIFE** — `(() => { ... })()` or `(function() { ... })()`:
 *    callee is `ParenthesizedExpression(ArrowFunction | FunctionExpression)`.
 *    We unwrap the parentheses and return the inner function-like.
 *
 * 2. **Method chain** — `a.b(fn).c()`:
 *    callee is `PropertyAccessExpression(expression=CallExpression(...))`.
 *    We return the inner CallExpression so that `decomposableChildrenOf`
 *    recurses into it and finds the function-like argument (the comparator,
 *    predicate, etc.) one level down.
 *
 * 3. **Bare function-like callee** — rare but possible:
 *    callee is `ArrowFunction` or `FunctionExpression` directly.
 *    Return it for direct decomposition.
 *
 * Other callee kinds (Identifier, PropertyAccessExpression without a
 * CallExpression receiver, etc.) return `undefined` — they have no
 * decomposable internal structure.
 *
 * @decision DEC-SLICER-CALLEE-OBJ-LITERAL-001 (see CallExpression branch below)
 */
function unwrapCalleeToDecomposable(callee: Node): Node | undefined {
  const ck = callee.getKind();

  // Shape 1: ParenthesizedExpression — unwrap and check the inner expression.
  if (ck === SyntaxKind.ParenthesizedExpression) {
    const inner = (callee as Node & { getExpression(): Node }).getExpression();
    const ik = inner.getKind();
    if (ik === SyntaxKind.ArrowFunction || ik === SyntaxKind.FunctionExpression) {
      return inner; // IIFE: the real function-like
    }
    // Nested parens or other — don't recurse further; unusual shape
    return undefined;
  }

  // Shape 2: PropertyAccessExpression — follow the expression (receiver) to
  // find an inner CallExpression in a method chain.
  if (ck === SyntaxKind.PropertyAccessExpression) {
    const expr = (callee as Node & { getExpression(): Node }).getExpression();
    if (expr.getKind() === SyntaxKind.CallExpression) {
      return expr; // inner CallExpression in the chain
    }
    return undefined;
  }

  // Shape 3: Bare function-like callee (unusual but defensively handled).
  if (ck === SyntaxKind.ArrowFunction || ck === SyntaxKind.FunctionExpression) {
    return callee;
  }

  return undefined;
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

  // ClassDeclaration / ClassExpression: descend into methods, accessors,
  // constructor, static blocks, and property initializers.
  // (DEC-SLICER-CHILDREN-CLASS-EXPR-VAR-001)
  if (kind === SyntaxKind.ClassDeclaration || kind === SyntaxKind.ClassExpression) {
    const cls = node as Node & { getMembers(): readonly Node[] };
    const result: Node[] = [];
    for (const member of cls.getMembers()) {
      const mk = member.getKind();
      if (
        mk === SyntaxKind.MethodDeclaration ||
        mk === SyntaxKind.Constructor ||
        mk === SyntaxKind.GetAccessor ||
        mk === SyntaxKind.SetAccessor ||
        mk === SyntaxKind.ClassStaticBlockDeclaration
      ) {
        result.push(member);
      }
      // Property declarations with initializers decompose to the initializer.
      // Property declarations without initializers (interface-shape fields) skipped.
      if (mk === SyntaxKind.PropertyDeclaration) {
        const prop = member as Node & { getInitializer?(): Node | undefined };
        const init = prop.getInitializer?.();
        if (init !== undefined) result.push(init);
      }
    }
    return result;
  }

  // ExpressionStatement: the statement is a thin wrapper — the expression is
  // the carrier of decomposable behavior. Descend into [expression].
  // (DEC-SLICER-CHILDREN-CLASS-EXPR-VAR-001)
  if (kind === SyntaxKind.ExpressionStatement) {
    const stmt = node as Node & { getExpression(): Node };
    return [stmt.getExpression()];
  }

  // VariableStatement: `const x = expr1, y = expr2;` — decompose to
  // initializer expressions. Declarations without initializers (`let x;`) skipped.
  // (DEC-SLICER-CHILDREN-CLASS-EXPR-VAR-001)
  if (kind === SyntaxKind.VariableStatement) {
    const stmt = node as Node & {
      getDeclarationList(): Node & {
        getDeclarations(): readonly (Node & { getInitializer?(): Node | undefined })[];
      };
    };
    const decls = stmt.getDeclarationList().getDeclarations();
    const result: Node[] = [];
    for (const d of decls) {
      const init = d.getInitializer?.();
      if (init !== undefined) result.push(init);
    }
    return result;
  }

  // CallExpression: descend into (a) the callee when it is or wraps a
  // function-like or another CallExpression, and (b) ObjectLiteralExpression
  // arguments that may carry conditional spreads.
  //
  // @decision DEC-SLICER-CALLEE-OBJ-LITERAL-001
  // title: Extend CallExpression descent to callee and ObjectLiteralExpression args
  // status: decided
  // rationale:
  //   Three previously-unhandled AST shapes produced DidNotReachAtomError on
  //   real yakcc source (issue #350):
  //
  //   1. IIFE shape: `(() => { ... })()` — the ArrowFunction is the CALLEE
  //      (inside a ParenthesizedExpression), not an argument. The old branch
  //      iterated arguments only, found none that were function-like, and
  //      returned [].
  //
  //   2. Method-chain shape: `arr.filter(fn).sort(cmp).slice(0, n)` — the
  //      outermost CallExpression's callee is a PropertyAccessExpression whose
  //      receiver is itself a CallExpression (.sort(cmp)). The sort's argument
  //      is an ArrowFunction containing the decomposable behaviour. Without
  //      callee descent the slicer saw only `0` and `n` as args → returned [].
  //
  //   3. ObjectLiteralExpression arg with conditional spreads:
  //      `fn({ ...cond ? {a} : {} })` — the single arg is an
  //      ObjectLiteralExpression. The existing ObjectLiteralExpression handler
  //      already exposes PropertyAssignment initializers; adding the OLE to the
  //      descent set lets the slicer reach ConditionalExpression spreads.
  //
  //   The extension is strictly additive: previously-passing files are
  //   unaffected. New branches only fire on AST shapes that previously
  //   returned []. (#350, files 1-4)
  // alternatives:
  //   A (refactor call sites): forces contributors to memorise anti-patterns;
  //     violates the invariant "every shaveable file shaves".
  //   C (expected-failures.json): documents fixable gaps; drifts atom registry.
  // consequences:
  //   - IIFEs, method chains, and conditional-spread call shapes now decompose.
  //   - Atom granularity unchanged for previously-passing files.
  //   - Compatible with WI-V2-09 byte-identical bootstrap (deterministic descent).
  // (DEC-SLICER-CHILDREN-CLASS-EXPR-VAR-001 prior art)
  if (kind === SyntaxKind.CallExpression) {
    const call = node as Node & {
      getExpression(): Node;
      getArguments(): readonly Node[];
    };
    const result: Node[] = [];

    // ---- Callee descent ----
    // Unwrap the callee through ParenthesizedExpression to find the real
    // function-like or nested CallExpression, then include it for further
    // decomposition (IIFE and method-chain shapes, files 2 and 4 in #350).
    const calleeDescendant = unwrapCalleeToDecomposable(call.getExpression());
    if (calleeDescendant !== undefined) {
      result.push(calleeDescendant);
    }

    // ---- Argument descent ----
    for (const arg of call.getArguments()) {
      const ak = arg.getKind();
      if (ak === SyntaxKind.ArrowFunction || ak === SyntaxKind.FunctionExpression) {
        // Function-like arg: directly decomposable (unchanged from prior logic).
        result.push(arg);
      } else if (ak === SyntaxKind.ObjectLiteralExpression) {
        // ObjectLiteralExpression arg: delegate to the OLE handler by including
        // it here. decomposableChildrenOf(OLE) exposes PropertyAssignment
        // initializers, SpreadAssignments, and method members, reaching the
        // ConditionalExpressions buried in `fn({...cond ? {a} : {}})`.
        // (files 1 and 3 in #350)
        result.push(arg);
      }
    }
    return result;
  }

  // NewExpression: `new Constructor(fn)` — descend into function-like arguments
  // (ArrowFunction, FunctionExpression). This handles `new Promise<void>(fn)`
  // shapes where fn is the resolver callback — a non-leaf ArrowFunction that the
  // slicer should be able to descend into. Other constructor args (literals,
  // identifiers) are not further decomposable.
  // (DEC-SLICER-CHILDREN-EXPR-LEVEL-001)
  if (kind === SyntaxKind.NewExpression) {
    const ne = node as Node & { getArguments(): readonly Node[] };
    const result: Node[] = [];
    for (const arg of ne.getArguments()) {
      const ak = arg.getKind();
      if (ak === SyntaxKind.ArrowFunction || ak === SyntaxKind.FunctionExpression) {
        result.push(arg);
      }
    }
    return result;
  }

  // ConditionalExpression: `cond ? then : else` — decompose to [condition, whenTrue, whenFalse].
  // Addresses ternary-shaped did-not-reach-atom failures from WI-037 audit.
  // (DEC-SLICER-CHILDREN-EXPR-LEVEL-001)
  if (kind === SyntaxKind.ConditionalExpression) {
    const ce = node as Node & {
      getCondition(): Node;
      getWhenTrue(): Node;
      getWhenFalse(): Node;
    };
    return [ce.getCondition(), ce.getWhenTrue(), ce.getWhenFalse()];
  }

  // BinaryExpression: `left op right` — decompose to [left, right].
  // Addresses binary-expression did-not-reach-atom failures from WI-037 audit.
  // (DEC-SLICER-CHILDREN-EXPR-LEVEL-001)
  if (kind === SyntaxKind.BinaryExpression) {
    const be = node as Node & {
      getLeft(): Node;
      getRight(): Node;
    };
    return [be.getLeft(), be.getRight()];
  }

  // ReturnStatement: descend into the wrapped expression if present.
  // A bare `return;` (no expression) falls through to the leaf wrapper in
  // safeCanonicalAstHash. This handles `return new Promise<void>(fn)` shapes
  // in federation/serve.ts close() — the slicer descends into the promise arg
  // rather than treating the entire return as an unsliceable atom.
  // (DEC-SLICER-CHILDREN-EXPR-LEVEL-001)
  if (kind === SyntaxKind.ReturnStatement) {
    const rs = node as Node & { getExpression?(): Node | undefined };
    const expr = rs.getExpression?.();
    return expr !== undefined ? [expr] : [];
  }

  // ObjectLiteralExpression: descend into members to find decomposable sub-nodes.
  // Handles two shapes:
  //  1. `return { server, url, close() { ... } }` — close() is a MethodDeclaration
  //     with a decomposable body (federation/serve.ts).
  //  2. `parseArgs({ options: { registry: { type: "string" }, ... } })` — nested
  //     ObjectLiteralExpression inside a CallExpression arg; the inner objects
  //     are plain data and should resolve as atoms.
  //
  // Policy: expose MethodDeclaration/GetAccessor/SetAccessor (always function-like),
  // ALL PropertyAssignment initializers, AND SpreadAssignment expressions.
  //
  // SpreadAssignment handles the conditional-spread shape `...(cond ? {a} : {})`:
  // the `SpreadAssignment` node wraps a `ConditionalExpression` that contains the
  // CF boundaries causing the OLE to be non-atomic. Without this branch, the OLE
  // handler found no decomposable children and threw DidNotReachAtomError even
  // though the SpreadAssignment's ConditionalExpression is reachable.
  // This is the completing fix for DEC-SLICER-CALLEE-OBJ-LITERAL-001 gap 3:
  // adding OLE to the CallExpression arg descent (above) gets the slicer INTO the
  // OLE, and this SpreadAssignment branch gets it through the OLE to the ternary.
  // (#350 files 1 and 3)
  //
  // ShorthandPropertyAssignment entries (simple identifiers like `toolName`) do not
  // carry initializers and classify as atoms via isAtom() → terminate naturally.
  // (DEC-SLICER-CHILDREN-EXPR-LEVEL-001)
  if (kind === SyntaxKind.ObjectLiteralExpression) {
    const obj = node as Node & { getProperties(): readonly Node[] };
    const result: Node[] = [];
    for (const prop of obj.getProperties()) {
      const pk = prop.getKind();
      if (
        pk === SyntaxKind.MethodDeclaration ||
        pk === SyntaxKind.GetAccessor ||
        pk === SyntaxKind.SetAccessor
      ) {
        result.push(prop);
      } else if (pk === SyntaxKind.PropertyAssignment) {
        const pa = prop as Node & { getInitializer?(): Node | undefined };
        const init = pa.getInitializer?.();
        if (init !== undefined) {
          result.push(init);
        }
      } else if (pk === SyntaxKind.SpreadAssignment) {
        // `...(expression)` — the expression carries the CF boundaries (commonly
        // a ConditionalExpression). Include the expression for further decomposition.
        const sa = prop as Node & { getExpression?(): Node | undefined };
        const expr = sa.getExpression?.();
        if (expr !== undefined) {
          result.push(expr);
        }
      }
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
      // @decision DEC-V2-SHAVE-CALLEXPRESSION-GLUE-001
      // status: decided
      // rationale:
      //   Per DEC-V2-GLUE-AWARE-SHAVE-001 (the glue-aware framing), constructs
      //   that don't decompose into atomic units can be verbatim-preserved as
      //   forced AtomLeaf entries (carrying atomTest.isAtom=false). Downstream
      //   atom-persist / universalize pipelines route these as glue rather than
      //   failing the entire file shave. This unblocks 4 CallExpression files
      //   reported in issue #399 (bootstrap/report.json):
      //     - packages/hooks-base/src/index.ts [13744,14068)
      //     - packages/hooks-base/src/telemetry.ts [4975,5389)
      //     - packages/hooks-claude-code/src/index.ts [11723,11956)
      //     - packages/registry/src/discovery-eval-helpers.ts [26144,26424)
      //   Rejected alternatives (per #399 body):
      //     1. Refactor each CallExpression to be decomposable (source-level edits, risk subtle behavior change)
      //     2. Extend decomposableChildrenOf() (unknown surface area, risks regressing currently-working files)
      if (node.getKind() === SyntaxKind.CallExpression) {
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
