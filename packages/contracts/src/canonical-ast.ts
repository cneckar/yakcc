// SPDX-License-Identifier: MIT
/**
 * @decision DEC-AST-CANON-001: Canonical AST hashing uses ts-morph + canonical print + local-rename.
 * Status: proposed (MASTER_PLAN.md edits are out of scope for WI-012-01)
 * Rationale: ts-morph wraps the TypeScript compiler API and provides a stable, high-level
 * AST walker with a built-in printer that handles comment stripping and whitespace normalization
 * via `Node.print({ removeComments: true })`. This avoids hand-rolling a TypeScript printer
 * and stays version-stable as long as ts-morph's output contract holds. The alternative —
 * the raw TypeScript compiler API — was rejected because it is already used by ts-morph
 * internally, and exposing it directly would create a parallel authority for AST traversal.
 * Local-only identifiers are renamed to positional placeholders (__v0, __v1, ...) in
 * declaration order so that semantically equivalent functions with different local variable
 * names hash identically, while exported names and public API surface remain verbatim.
 */

import { blake3 } from "@noble/hashes/blake3.js";
import { Project, ScriptKind, SyntaxKind, ts } from "ts-morph";
import type { Node, SourceFile } from "ts-morph";

// ---------------------------------------------------------------------------
// Branded type
// ---------------------------------------------------------------------------

/**
 * A 64-character lowercase hex BLAKE3-256 digest of the canonical AST form of
 * a TypeScript source fragment. Two source fragments are structurally equivalent
 * (modulo comments, whitespace, and local variable renaming) iff their
 * CanonicalAstHash values are equal.
 */
export type CanonicalAstHash = string & { readonly __brand: "CanonicalAstHash" };

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

/**
 * Thrown when `canonicalAstHash` cannot produce a canonical hash because the
 * source is syntactically invalid or the requested range spans multiple AST nodes.
 */
export class CanonicalAstParseError extends Error {
  constructor(
    message: string,
    public readonly diagnostics: readonly string[],
  ) {
    super(message);
    this.name = "CanonicalAstParseError";
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const TEXT_ENCODER = new TextEncoder();

/** Convert a Uint8Array to a lowercase hex string. */
function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Find the smallest single Node in `file` whose [getStart(), getEnd()]
 * covers the entirety of [range.start, range.end).
 *
 * Uses a depth-first walk: if a node's span covers the range, try its children;
 * the deepest single-node cover is the result. If no single node covers the
 * range (i.e. the range straddles a sibling boundary), throw.
 */
function findEnclosingNode(
  file: SourceFile,
  range: { readonly start: number; readonly end: number },
): Node {
  // SyntaxList is an internal grouping node that cannot be printed directly
  // (ts-morph's printer throws "Unhandled SyntaxKind: SyntaxList"). Skip it
  // when it covers the range — use its parent instead.
  const UNPRINTABLE_KINDS = new Set([SyntaxKind.SyntaxList]);

  function walk(node: Node): Node | undefined {
    const nodeStart = node.getStart();
    const nodeEnd = node.getEnd();
    if (nodeStart > range.start || nodeEnd < range.end) {
      return undefined; // node does not cover the range
    }
    // This node covers the range. Try children to find a tighter cover.
    for (const child of node.getChildren()) {
      const result = walk(child);
      if (result !== undefined) return result;
    }
    // Skip unprintable internal nodes — they cannot be used as a hash root.
    if (UNPRINTABLE_KINDS.has(node.getKind())) {
      return undefined;
    }
    return node; // this is the tightest printable covering node
  }

  const result = walk(file);

  if (result === undefined) {
    throw new CanonicalAstParseError("range-spans-multiple-nodes", []);
  }

  // If the tightest covering node is the SourceFile itself, but the range does
  // not cover the full source (i.e. [range.start, range.end) is a strict
  // sub-range of [file.getStart(), file.getEnd())), then no single meaningful
  // sub-node covers the requested range — the range straddles multiple siblings.
  // Throw to prevent the caller from silently getting a hash of the whole file
  // when they asked for a sub-range.
  if (
    result.getKind() === SyntaxKind.SourceFile &&
    (range.start > file.getStart() || range.end < file.getEnd())
  ) {
    throw new CanonicalAstParseError("range-spans-multiple-nodes", []);
  }

  return result;
}

/**
 * Check whether an AST node carries an `export` modifier using the raw
 * TypeScript compiler API (always available via ts-morph's re-exported `ts`).
 *
 * `ts.canHaveModifiers` guards the call so we don't ask for modifiers on node
 * kinds that TypeScript disallows (e.g. token nodes, literals).
 */
function hasExportModifier(node: Node): boolean {
  const compilerNode = node.compilerNode;
  if (!ts.canHaveModifiers(compilerNode)) return false;
  const mods = ts.getModifiers(compilerNode);
  if (mods === undefined) return false;
  return mods.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
}

/**
 * Determine whether a binding declared at `declarationNode` is "local-only"
 * within `root`, meaning:
 *   - It is declared inside the root sub-tree.
 *   - It is NOT exported from the root sub-tree (no `export` modifier on its
 *     declaration or its containing statement).
 *   - It is NOT a parameter of an exported function/method.
 *   - It is NOT a property name on an object literal or JSX attribute.
 *   - It is NOT a type parameter name.
 *   - The declaration is a variable/binding element or parameter of a
 *     non-exported function.
 *
 * Conservative: when in doubt, return false (keep original name).
 */
function isLocalBinding(declarationNode: Node, root: Node): boolean {
  // Must be within the root sub-tree
  const declStart = declarationNode.getStart();
  const declEnd = declarationNode.getEnd();
  const rootStart = root.getStart();
  const rootEnd = root.getEnd();
  if (declStart < rootStart || declEnd > rootEnd) return false;

  const kind = declarationNode.getKind();

  // Only rename bindings from variable declarations and parameters of non-exported functions.
  if (
    kind !== SyntaxKind.VariableDeclaration &&
    kind !== SyntaxKind.Parameter &&
    kind !== SyntaxKind.BindingElement
  ) {
    return false;
  }

  // For parameters: only rename if the containing function is NOT exported.
  if (kind === SyntaxKind.Parameter) {
    let ancestor: Node | undefined = declarationNode.getParent();
    while (ancestor !== undefined) {
      const ancestorKind = ancestor.getKind();
      if (
        ancestorKind === SyntaxKind.FunctionDeclaration ||
        ancestorKind === SyntaxKind.FunctionExpression ||
        ancestorKind === SyntaxKind.ArrowFunction ||
        ancestorKind === SyntaxKind.MethodDeclaration
      ) {
        // Check for export modifier on the function/method itself
        if (hasExportModifier(ancestor)) return false;
        // Also check the parent statement for export (e.g. `export function f`)
        const parentOfFn = ancestor.getParent();
        if (parentOfFn !== undefined && hasExportModifier(parentOfFn)) return false;
        break;
      }
      ancestor = ancestor.getParent();
    }
  }

  // For variable declarations: check the containing VariableStatement for export.
  if (kind === SyntaxKind.VariableDeclaration || kind === SyntaxKind.BindingElement) {
    let ancestor: Node | undefined = declarationNode.getParent();
    while (ancestor !== undefined) {
      const ancestorKind = ancestor.getKind();
      if (ancestorKind === SyntaxKind.VariableStatement) {
        if (hasExportModifier(ancestor)) return false;
        break;
      }
      // Stop at function/arrow/class boundaries — the declaration is local to that scope
      if (
        ancestorKind === SyntaxKind.FunctionDeclaration ||
        ancestorKind === SyntaxKind.FunctionExpression ||
        ancestorKind === SyntaxKind.ArrowFunction ||
        ancestorKind === SyntaxKind.MethodDeclaration ||
        ancestorKind === SyntaxKind.ClassDeclaration ||
        ancestorKind === SyntaxKind.SourceFile
      ) {
        break;
      }
      ancestor = ancestor.getParent();
    }
  }

  return true;
}

/**
 * Collect a mapping from original local binding name → placeholder name
 * (__v0, __v1, ...) in declaration order within `root`.
 *
 * Walks the AST looking for identifier nodes that are binding names
 * (declarations), not references. Each unique name that qualifies as local
 * gets a sequentially assigned placeholder.
 */
function collectLocalRenames(root: Node): Map<string, string> {
  const renames = new Map<string, string>();
  let counter = 0;

  function walk(node: Node): void {
    const kind = node.getKind();

    if (
      kind === SyntaxKind.VariableDeclaration ||
      kind === SyntaxKind.Parameter ||
      kind === SyntaxKind.BindingElement
    ) {
      // The name child of a VariableDeclaration / Parameter is the binding identifier
      const nameNode = (node as { getNameNode?: () => Node | undefined }).getNameNode?.();
      if (nameNode !== undefined && nameNode.getKind() === SyntaxKind.Identifier) {
        const name = nameNode.getText();
        if (!renames.has(name) && isLocalBinding(node, root)) {
          renames.set(name, `__v${counter++}`);
        }
      }
    }

    for (const child of node.getChildren()) {
      walk(child);
    }
  }

  walk(root);
  return renames;
}

/**
 * Emit canonical text for `root` by:
 *   1. Printing the node with comment removal via ts-morph's built-in printer.
 *   2. Applying local-rename substitutions via whole-word regex replacement.
 *
 * The ts-morph printer handles whitespace normalization and comment stripping;
 * we only post-process for local renames.
 */
function emitCanonical(root: Node, renames: Map<string, string>): string {
  // Use ts-morph's built-in printer with removeComments flag.
  // For a SourceFile, print() returns the full source text without comments.
  // For a sub-node, print() returns just that node's text.
  let text = root.print({ removeComments: true });

  // Apply local renames: whole-word replacement to avoid replacing substrings.
  // Process in a stable order (insertion order of the Map is declaration order).
  for (const [original, placeholder] of renames) {
    // Escape special regex characters in the original name
    const escaped = original.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`\\b${escaped}\\b`, "g");
    text = text.replace(re, placeholder);
  }

  return text;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Compute a canonical AST hash for a TypeScript source fragment.
 *
 * The hash is deterministic: two source strings that are structurally equivalent
 * modulo comments, whitespace normalization, and local identifier renaming will
 * produce the same hash.
 *
 * @param source - The TypeScript source text to hash.
 * @param sourceRange - Optional byte range `[start, end)` within `source`.
 *   When provided, `canonicalAstHash` walks the AST to find the smallest single
 *   Node covering the range and hashes only that node. If the range straddles
 *   multiple top-level nodes, `CanonicalAstParseError` is thrown.
 *
 * @throws {CanonicalAstParseError} If the source contains TypeScript errors, or
 *   if `sourceRange` spans multiple AST nodes, or if `sourceRange` is outside
 *   the source bounds.
 */
export function canonicalAstHash(
  source: string,
  sourceRange?: { readonly start: number; readonly end: number },
): CanonicalAstHash {
  // Validate range bounds eagerly before parsing.
  if (sourceRange !== undefined) {
    if (
      sourceRange.start < 0 ||
      sourceRange.end > source.length ||
      sourceRange.start > sourceRange.end
    ) {
      throw new CanonicalAstParseError("range-out-of-bounds", []);
    }
  }

  // Phase 1: Parse the source in-memory with ts-morph.
  const project = new Project({
    useInMemoryFileSystem: true,
    compilerOptions: {
      allowJs: false,
      noEmit: true,
      skipLibCheck: true,
    },
  });

  const file = project.createSourceFile("anonymous.ts", source, {
    scriptKind: ScriptKind.TS,
  });

  // Collect only SYNTAX diagnostics (TypeScript error codes 1000–1999).
  //
  // We intentionally exclude semantic errors such as "Cannot find module X"
  // (TS2307) and "Cannot find name Y" (TS2304). Those arise from the isolated
  // in-memory parse context that has no access to node_modules; they do NOT
  // indicate that the source text is structurally malformed. Callers hash
  // real-world TypeScript files that freely import from external packages.
  //
  // Syntax errors (1xxx) are the only class that can make the AST too broken
  // to print deterministically; they are the correct gate here.
  const syntaxDiagnostics = file
    .getPreEmitDiagnostics()
    .filter(
      (d) =>
        d.getCategory() === ts.DiagnosticCategory.Error &&
        d.getCode() >= 1000 &&
        d.getCode() < 2000,
    );

  if (syntaxDiagnostics.length > 0) {
    const messages = syntaxDiagnostics.map((d) => {
      const msg = d.getMessageText();
      return typeof msg === "string" ? msg : msg.getMessageText();
    });
    throw new CanonicalAstParseError(
      `TypeScript syntax error(s) in source: ${messages[0] ?? "unknown error"}`,
      messages,
    );
  }

  // Phase 2: Determine root node.
  const root: Node = sourceRange !== undefined ? findEnclosingNode(file, sourceRange) : file;

  // Phase 3: Collect local renames within the root.
  const renames = collectLocalRenames(root);

  // Phase 4: Emit canonical text.
  const canonical = emitCanonical(root, renames);

  // Phase 5: Hash via BLAKE3.
  const digest = blake3(TEXT_ENCODER.encode(canonical));
  return bytesToHex(digest) as CanonicalAstHash;
}
