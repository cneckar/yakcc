// SPDX-License-Identifier: MIT
/**
 * @decision DEC-SLICER-NOVEL-GLUE-004
 * title: DFG slicer — slice() implementation for WI-012-05
 * status: decided
 * rationale: slice() walks a RecursionTree (produced by decompose()) in DFS
 * order and classifies each node as either a PointerEntry (the subtree rooted
 * here has a matching registry entry by canonicalAstHash — no synthesis needed)
 * or a NovelGlueEntry (unmatched AtomLeaf — source that must be synthesized).
 *
 * Design choices:
 * - Registry lookup is attempted via the optional findByCanonicalAstHash method.
 *   When the method is absent or returns an empty array, the node is treated as
 *   unmatched and the slicer degrades gracefully: AtomLeaf → NovelGlueEntry,
 *   BranchNode → descend into children.
 * - BranchNode collapse: when the registry matches a BranchNode by canonicalAstHash,
 *   the entire subtree collapses into one PointerEntry. Descendants are NOT visited.
 *   This is the primary deduplication mechanism for composite primitives.
 * - AtomLeaf with no registry match: first runs classifyForeign() to detect
 *   static import declarations from foreign packages. If the atom is a foreign
 *   import, one ForeignLeafEntry per binding is emitted (no synthesis attempted).
 *   Only when classifyForeign() returns no entries does the atom fall through to
 *   NovelGlueEntry. This ordering (registry → foreign → novel-glue) ensures that
 *   registry-pointer matches always take priority over foreign classification.
 *   (DEC-V2-FOREIGN-BLOCK-SCHEMA-001)
 * - matchedPrimitives deduplication: we track seen canonicalAstHash values and
 *   only append the first-seen (canonicalAstHash, merkleRoot) pair. This mirrors
 *   the "first BlockMerkleRoot from the result" rule applied per node.
 * - DFS order is guaranteed by the recursive descent: we visit a node before
 *   its children, and children are visited left-to-right (matching the order
 *   they appear in RecursionTree.root.children).
 * - sourceBytesByKind sums (sourceRange.end - sourceRange.start) for each entry
 *   kind. ForeignLeafEntry does not contribute to either counter (foreign deps
 *   are not synthesized, so they are not novel glue, nor matched registry bytes).
 * - The function signature accepts Pick<ShaveRegistryView, "findByCanonicalAstHash">
 *   rather than the full ShaveRegistryView to keep the slicer testable with a
 *   minimal stub and decoupled from the broader registry surface.
 *
 * @decision DEC-V2-FOREIGN-BLOCK-SCHEMA-001
 * title: classifyForeign — pure predicate for static foreign-import detection (L3)
 * status: decided
 * rationale: classifyForeign() must be pure of registry I/O (L3-I2) so that:
 *   (a) it can run inside walkNode without async overhead on every atom;
 *   (b) tests can call it directly with a registry that throws on
 *       findByCanonicalAstHash, proving registry purity (test 8).
 * The predicate creates an in-memory ts-morph Project, parses the atom's source
 * text, and walks ImportDeclaration nodes. It skips type-only imports
 * (isTypeOnly()), relative imports (starts with '.'), and workspace imports
 * (starts with WORKSPACE_PREFIX). Dynamic import() expressions are NOT handled
 * here — L3 spec explicitly defers them (test 7 falls through to NovelGlueEntry).
 * The node: prefix and workspace prefix are defined as named constants to avoid
 * hardcoding the same string at multiple sites (forbidden shortcut in L3 scope).
 */

import type { BlockMerkleRoot, CanonicalAstHash } from "@yakcc/contracts";
import { Project, ScriptKind } from "ts-morph";
import type { ShaveRegistryView } from "../types.js";
import type {
  BranchNode,
  ForeignLeafEntry,
  NovelGlueEntry,
  PointerEntry,
  RecursionNode,
  RecursionTree,
  SlicePlan,
  SlicePlanEntry,
} from "./types.js";

// ---------------------------------------------------------------------------
// Foreign-classification constants (single source of truth — L3 forbidden
// shortcut: no hardcoding of these strings at multiple sites)
// ---------------------------------------------------------------------------

/**
 * Prefix for Node.js built-in modules using the node: protocol.
 * Any specifier starting with this prefix is classified as foreign.
 */
const NODE_BUILTIN_PREFIX = "node:";

/**
 * Prefix for workspace-internal packages.
 * Any specifier starting with this prefix is NOT classified as foreign —
 * it is treated as local workspace code.
 */
const WORKSPACE_PREFIX = "@yakcc/";

// ---------------------------------------------------------------------------
// classifyForeign: pure predicate (L3-I2 — no registry I/O)
// ---------------------------------------------------------------------------

/**
 * Parse `source` as TypeScript and return a ForeignLeafEntry for each binding
 * imported from a foreign (non-workspace, non-relative) static import declaration.
 *
 * Returns an empty array when the source is not a foreign import declaration
 * (e.g. it is a relative import, a workspace import, a type-only import,
 * a dynamic import, or any other statement kind).
 *
 * Authority invariant L3-I2: this function MUST NOT call any registry method.
 * It is a pure structural predicate over source text only.
 *
 * Skips:
 *   - `import type { X }` — type-only erasure, no runtime import
 *   - `import { X } from './local'` — relative imports
 *   - `import { X } from '@yakcc/pkg'` — workspace imports
 *   - `await import('x')` — dynamic imports (L3 defers these; falls through
 *     to NovelGlueEntry as per test 7)
 *
 * @see DEC-V2-FOREIGN-BLOCK-SCHEMA-001
 */
export function classifyForeign(source: string): ForeignLeafEntry[] {
  // Use an in-memory Project so this function is pure of filesystem I/O.
  // skipAddingFilesFromTsConfig avoids slow tsconfig discovery.
  const project = new Project({
    useInMemoryFileSystem: true,
    skipAddingFilesFromTsConfig: true,
    compilerOptions: { allowJs: false, noEmit: true },
  });

  const sf = project.createSourceFile("__classify__.ts", source, {
    scriptKind: ScriptKind.TS,
  });

  const entries: ForeignLeafEntry[] = [];

  for (const decl of sf.getImportDeclarations()) {
    // Skip type-only imports — they are erased at compile time and carry no
    // runtime dependency. (Test 4: `import type { X }` must NOT yield a
    // ForeignLeafEntry.)
    if (decl.isTypeOnly()) continue;

    const specifier = decl.getModuleSpecifierValue();

    // Skip relative imports (./foo, ../bar). (Test 5)
    if (specifier.startsWith(".")) continue;

    // Skip workspace imports (@yakcc/...). (Test 6)
    if (specifier.startsWith(WORKSPACE_PREFIX)) continue;

    // All remaining specifiers are candidates for foreign classification:
    // - node: built-ins (node:fs, node:path, etc.)
    // - third-party npm packages (sqlite-vec, ts-morph, etc.)
    // A bare package name not starting with '.' or WORKSPACE_PREFIX is foreign.
    // The node: prefix is checked for completeness, but any non-relative,
    // non-workspace specifier (including bare names) is classified foreign.
    const isForeignSpecifier =
      specifier.startsWith(NODE_BUILTIN_PREFIX) || !specifier.startsWith("@yakcc/");

    if (!isForeignSpecifier) continue;

    const file = "__classify__.ts";
    const pos = decl.getStart();
    const lineAndCol = sf.getLineAndColumnAtPos(pos);
    const sourceLoc = {
      file,
      line: lineAndCol.line,
      column: lineAndCol.column,
    };

    // Namespace imports: `import * as ns from 'pkg'`
    const namespaceImport = decl.getNamespaceImport();
    if (namespaceImport !== undefined) {
      entries.push({
        kind: "foreign-leaf",
        pkg: specifier,
        export: "*",
        alias: namespaceImport.getText(),
        sourceLoc,
      });
      continue;
    }

    // Default import: `import Foo from 'pkg'`
    const defaultImport = decl.getDefaultImport();
    if (defaultImport !== undefined) {
      entries.push({
        kind: "foreign-leaf",
        pkg: specifier,
        export: "default",
        alias: defaultImport.getText(),
        sourceLoc,
      });
      // Named imports may coexist with default; fall through.
    }

    // Named imports: `import { A, B as C } from 'pkg'`
    for (const named of decl.getNamedImports()) {
      const exportedName = named.getName();
      const aliasNode = named.getAliasNode();
      const alias = aliasNode !== undefined ? aliasNode.getText() : undefined;
      entries.push({
        kind: "foreign-leaf",
        pkg: specifier,
        export: exportedName,
        // alias is only set when the local name differs from the export name
        alias: alias !== undefined && alias !== exportedName ? alias : undefined,
        sourceLoc,
      });
    }

    // Side-effect-only import: `import 'pkg'` (no bindings)
    if (
      defaultImport === undefined &&
      namespaceImport === undefined &&
      decl.getNamedImports().length === 0
    ) {
      entries.push({
        kind: "foreign-leaf",
        pkg: specifier,
        export: "side-effect",
        sourceLoc,
      });
    }
  }

  return entries;
}

// ---------------------------------------------------------------------------
// Internal accumulator (mutable, local to one slice() call)
// ---------------------------------------------------------------------------

interface SliceAccumulator {
  entries: SlicePlanEntry[];
  /** Tracks seen canonicalAstHash values to deduplicate matchedPrimitives. */
  matchedPrimitivesMap: Map<
    CanonicalAstHash,
    { canonicalAstHash: CanonicalAstHash; merkleRoot: BlockMerkleRoot }
  >;
  pointerBytes: number;
  novelGlueBytes: number;
}

// ---------------------------------------------------------------------------
// Internal DFS walker
// ---------------------------------------------------------------------------

/**
 * Recursively walk `node` in DFS order, querying the registry and appending
 * entries to `acc`. BranchNodes that match the registry collapse their entire
 * subtree into one PointerEntry. AtomLeaves that match emit PointerEntry.
 * Unmatched AtomLeaves are checked for foreign imports (classifyForeign) before
 * falling through to NovelGlueEntry. Unmatched BranchNodes descend.
 */
async function walkNode(
  node: RecursionNode,
  registry: Pick<ShaveRegistryView, "findByCanonicalAstHash">,
  acc: SliceAccumulator,
): Promise<void> {
  // Query registry — degrade gracefully when findByCanonicalAstHash is absent.
  const matches = await registry.findByCanonicalAstHash?.(node.canonicalAstHash);
  const firstMatch: BlockMerkleRoot | undefined =
    matches !== undefined && matches.length > 0 ? matches[0] : undefined;

  if (firstMatch !== undefined) {
    // Registry match: collapse this node (and any subtree) to a PointerEntry.
    // Descendants are NOT visited — the whole subtree is replaced by the pointer.
    const entry: PointerEntry = {
      kind: "pointer",
      sourceRange: node.sourceRange,
      merkleRoot: firstMatch,
      canonicalAstHash: node.canonicalAstHash,
      matchedBy: "canonical_ast_hash",
    };
    acc.entries.push(entry);
    acc.pointerBytes += node.sourceRange.end - node.sourceRange.start;

    // Deduplicate matchedPrimitives by canonicalAstHash (first-seen order).
    if (!acc.matchedPrimitivesMap.has(node.canonicalAstHash)) {
      acc.matchedPrimitivesMap.set(node.canonicalAstHash, {
        canonicalAstHash: node.canonicalAstHash,
        merkleRoot: firstMatch,
      });
    }
    return;
  }

  // No registry match — behaviour depends on node kind.
  if (node.kind === "atom") {
    // Attempt foreign-import classification BEFORE emitting NovelGlueEntry.
    // This is the L3 insertion point: registry → foreign → novel-glue.
    // classifyForeign is pure (L3-I2): it performs no registry I/O.
    const foreignEntries = classifyForeign(node.source);
    if (foreignEntries.length > 0) {
      // The atom is a foreign import declaration — push one ForeignLeafEntry
      // per binding. No NovelGlueEntry is emitted; no byte accounting is
      // needed (foreign deps are not synthesized).
      for (const fe of foreignEntries) {
        acc.entries.push(fe);
      }
      return;
    }

    // Unmatched AtomLeaf with no foreign classification → NovelGlueEntry.
    // intentCard is intentionally omitted: AtomLeaf in types.ts carries no
    // intentCard field. WI-012-06 is expected to wire intent extraction and
    // populate the optional intentCard field on NovelGlueEntry for each
    // unmatched atom via a follow-up pass over the NovelGlueEntry array.
    const entry: NovelGlueEntry = {
      kind: "novel-glue",
      sourceRange: node.sourceRange,
      source: node.source,
      canonicalAstHash: node.canonicalAstHash,
      // intentCard omitted — optional by design, wired in WI-012-06
    };
    acc.entries.push(entry);
    acc.novelGlueBytes += node.sourceRange.end - node.sourceRange.start;
  } else {
    // Unmatched BranchNode → descend into children in DFS left-to-right order.
    // The branch node itself does not produce an entry; only leaf nodes and
    // matched subtrees produce entries, preserving the non-overlapping-regions
    // invariant for SlicePlan.entries.
    const branch = node as BranchNode;
    for (const child of branch.children) {
      await walkNode(child, registry, acc);
    }
  }
}

// ---------------------------------------------------------------------------
// Public API: slice()
// ---------------------------------------------------------------------------

/**
 * Slice a RecursionTree into a SlicePlan by querying the registry for each
 * node by canonicalAstHash.
 *
 * Nodes that match the registry are collapsed into PointerEntry records —
 * no synthesis needed for those subtrees. Unmatched AtomLeaf nodes that
 * contain static foreign imports are emitted as ForeignLeafEntry records —
 * one per imported binding. All other unmatched AtomLeaf nodes become
 * NovelGlueEntry records — source code that must be synthesized as novel glue.
 *
 * The returned SlicePlan contains:
 *   - `entries`: PointerEntry | ForeignLeafEntry | NovelGlueEntry in DFS order.
 *   - `matchedPrimitives`: deduplicated (canonicalAstHash, merkleRoot) pairs
 *     for every PointerEntry, in first-seen order.
 *   - `sourceBytesByKind`: byte sums for pointer vs. novel-glue regions.
 *     ForeignLeafEntry bytes are not counted in either bucket.
 *
 * When `registry.findByCanonicalAstHash` is undefined, all nodes are treated
 * as unmatched and foreign-import classification still runs — AtomLeaves that
 * are foreign imports emit ForeignLeafEntry; others emit NovelGlueEntry.
 *
 * @param tree     - The RecursionTree produced by decompose().
 * @param registry - Registry view; findByCanonicalAstHash is optional.
 */
export async function slice(
  tree: RecursionTree,
  registry: Pick<ShaveRegistryView, "findByCanonicalAstHash">,
): Promise<SlicePlan> {
  const acc: SliceAccumulator = {
    entries: [],
    matchedPrimitivesMap: new Map(),
    pointerBytes: 0,
    novelGlueBytes: 0,
  };

  await walkNode(tree.root, registry, acc);

  return {
    entries: acc.entries,
    matchedPrimitives: [...acc.matchedPrimitivesMap.values()],
    sourceBytesByKind: {
      pointer: acc.pointerBytes,
      novelGlue: acc.novelGlueBytes,
    },
  };
}
