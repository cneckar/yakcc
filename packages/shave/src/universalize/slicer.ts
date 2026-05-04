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
 *
 * @decision DEC-V2-SLICER-SEARCH-001
 * title: Glue-aware slicer search algorithm (L2)
 * status: decided
 * rationale:
 *   Under shaveMode:'glue-aware', the slicer applies the IR strict-subset
 *   predicate (validateStrictSubset from @yakcc/ir) per-subgraph instead of
 *   per-file. Nodes that pass the predicate are emitted as shaveable atoms
 *   (NovelGlueEntry or PointerEntry). Nodes that fail become GlueLeafEntry
 *   (verbatim source, project-local, NOT stored in the registry).
 *
 *   Key design decisions:
 *
 *   1. TOP-DOWN TRAVERSAL: The search proceeds top-down. At each node, the
 *      predicate is applied first. If it passes, the node is a maximal shaveable
 *      subgraph — we do NOT recurse further into its children. If it fails, we
 *      recurse into children to find the largest shaveable pieces within.
 *      Rationale: top-down finds the LARGEST (maximal) shaveable units first.
 *      Bottom-up would find many small atoms inside large shaveable functions,
 *      producing over-fragmented output. Top-down is also deterministic and
 *      O(n) in AST size (no backtracking needed).
 *
 *   2. MAXIMAL-SUBGRAPH DISCIPLINE — OPTION (A): When a BranchNode fails the
 *      predicate, we recurse into its children rather than emitting a single
 *      GlueLeafEntry for the whole branch (option b). This harvests the largest
 *      shaveable pieces from within the un-shaveable parent. A GlueLeafEntry is
 *      only emitted for AtomLeaf nodes that fail (we cannot recurse further).
 *      Per DEC-V2-GLUE-AWARE-SHAVE-001, the parent does NOT emit a separate
 *      GlueLeafEntry — that would overlap with its children's entries.
 *      Rationale: option (a) maximizes the fraction of source that becomes
 *      registry-eligible atoms. Option (b) (swallow everything) wastes shaveable
 *      code inside un-shaveable functions.
 *
 *   3. DEFAULT MODE: shaveMode defaults to 'strict' for backward compatibility.
 *      New callers should pass shaveMode:'glue-aware'. The rollout strategy is:
 *      existing test suite passes unchanged (strict mode), new glue-aware tests
 *      use the explicit option. When the compile pipeline is updated (L3), the
 *      universalize() entry point will flip the default to 'glue-aware'.
 *
 *   4. DETERMINISM GUARANTEE: The slicer is deterministic because:
 *      (a) validateStrictSubset is a pure function of source text (same input →
 *          same ValidationResult);
 *      (b) the RecursionTree is immutable and DFS traversal order is fixed;
 *      (c) GlueLeafEntry.reason is derived from the first validation error
 *          message, which is deterministic for a given source.
 *      Re-running slice() on the same tree + same mode produces a byte-identical
 *      SlicePlan.
 *
 *   5. SACRED PRACTICE #5 PRESERVED: GlueLeafEntry is for "shaveable in principle
 *      but not by this IR subset" cases. Genuinely malformed AST (e.g. unparseable
 *      source that makes ts-morph throw) still propagates as an error — glue-emit
 *      is not a blanket exception handler.
 *
 * @see DEC-V2-GLUE-AWARE-SHAVE-001 (architectural decision)
 */

import type { BlockMerkleRoot, CanonicalAstHash } from "@yakcc/contracts";
import { validateStrictSubset } from "@yakcc/ir";
import { Project, ScriptKind } from "ts-morph";
import type { ShaveRegistryView } from "../types.js";
import type {
  BranchNode,
  ForeignLeafEntry,
  GlueLeafEntry,
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
// Slicer options
// ---------------------------------------------------------------------------

/**
 * Options for the slice() function.
 *
 * @see DEC-V2-SLICER-SEARCH-001 (mode flag rollout strategy)
 */
export interface SliceOptions {
  /**
   * Controls how the slicer handles nodes that are not in the registry.
   *
   * - `'strict'` (default): Legacy behavior. Unmatched atoms become NovelGlueEntry
   *   regardless of whether they pass the IR strict-subset predicate. This is the
   *   pre-L2 behavior; all existing callers implicitly use this mode.
   *
   * - `'glue-aware'`: New behavior introduced by L2. The slicer applies the IR
   *   strict-subset predicate per-subgraph. Nodes that pass become NovelGlueEntry
   *   (shaveable atoms); nodes that fail become GlueLeafEntry (verbatim, project-local).
   *   BranchNodes that fail recurse into children to harvest maximal shaveable
   *   sub-subgraphs (option a per DEC-V2-SLICER-SEARCH-001).
   *
   * The default is `'strict'` for backward compatibility. New callers (e.g. the
   * compile pipeline after L3 lands) should use `'glue-aware'`.
   *
   * @see DEC-V2-SLICER-SEARCH-001
   * @see DEC-V2-GLUE-AWARE-SHAVE-001
   */
  readonly shaveMode?: "strict" | "glue-aware";
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
  /** Bytes in GlueLeafEntry regions. Non-zero under glue-aware mode. */
  glueBytes: number;
}

// ---------------------------------------------------------------------------
// Internal DFS walker — strict mode
// ---------------------------------------------------------------------------

/**
 * Recursively walk `node` in DFS order (strict mode), querying the registry
 * and appending entries to `acc`. Behavior is identical to the pre-L2 slicer:
 * BranchNodes that match the registry collapse into PointerEntry; unmatched
 * AtomLeaves are checked for foreign imports before falling through to
 * NovelGlueEntry; unmatched BranchNodes descend into children.
 *
 * This function is the backward-compatible path; it never emits GlueLeafEntry.
 */
async function walkNodeStrict(
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
      await walkNodeStrict(child, registry, acc);
    }
  }
}

// ---------------------------------------------------------------------------
// Internal DFS walker — glue-aware mode
// ---------------------------------------------------------------------------

/**
 * Recursively walk `node` in DFS order (glue-aware mode). Applies the IR
 * strict-subset predicate per-subgraph to find maximal shaveable subgraphs.
 *
 * Algorithm (DEC-V2-SLICER-SEARCH-001):
 *   1. Check registry first (same as strict mode). Registry match → PointerEntry,
 *      subtree collapsed. This preserves the "registry match takes priority" rule.
 *   2. For unmatched nodes: apply validateStrictSubset to the node's source.
 *      - If passes: the node is a maximal shaveable subgraph.
 *        - AtomLeaf: foreign check → ForeignLeafEntry or NovelGlueEntry.
 *        - BranchNode: emit NovelGlueEntry for the branch (don't recurse — the
 *          whole branch is shaveable as a unit).
 *      - If fails: the node is un-shaveable.
 *        - AtomLeaf: emit GlueLeafEntry (verbatim, project-local).
 *        - BranchNode: recurse into children (option a — find maximal pieces).
 *          The branch itself does NOT emit a GlueLeafEntry; only leaf-level
 *          un-shaveable nodes emit GlueLeafEntry to avoid overlapping entries.
 *
 * @see DEC-V2-SLICER-SEARCH-001
 * @see DEC-V2-GLUE-AWARE-SHAVE-001
 */
async function walkNodeGlueAware(
  node: RecursionNode,
  registry: Pick<ShaveRegistryView, "findByCanonicalAstHash">,
  acc: SliceAccumulator,
): Promise<void> {
  // Step 1: Registry lookup (same priority as strict mode).
  const matches = await registry.findByCanonicalAstHash?.(node.canonicalAstHash);
  const firstMatch: BlockMerkleRoot | undefined =
    matches !== undefined && matches.length > 0 ? matches[0] : undefined;

  if (firstMatch !== undefined) {
    const entry: PointerEntry = {
      kind: "pointer",
      sourceRange: node.sourceRange,
      merkleRoot: firstMatch,
      canonicalAstHash: node.canonicalAstHash,
      matchedBy: "canonical_ast_hash",
    };
    acc.entries.push(entry);
    acc.pointerBytes += node.sourceRange.end - node.sourceRange.start;

    if (!acc.matchedPrimitivesMap.has(node.canonicalAstHash)) {
      acc.matchedPrimitivesMap.set(node.canonicalAstHash, {
        canonicalAstHash: node.canonicalAstHash,
        merkleRoot: firstMatch,
      });
    }
    return;
  }

  // Step 2a: Foreign-import classification for AtomLeaf nodes runs BEFORE the
  // strict-subset predicate. This preserves the ordering: registry → foreign →
  // strict-subset → glue. Foreign imports (e.g. `import { readFileSync } from
  // 'node:fs'`) fail the strict-subset predicate (no-untyped-imports fires in
  // the in-memory project context), so we must classify them as foreign first.
  if (node.kind === "atom") {
    const foreignEntries = classifyForeign(node.source);
    if (foreignEntries.length > 0) {
      for (const fe of foreignEntries) {
        acc.entries.push(fe);
      }
      return;
    }
  }

  // Step 2b: Strict-subset predicate — applied per-subgraph.
  const validation = validateStrictSubset(node.source);

  if (validation.ok) {
    // Node passes the strict-subset predicate → maximal shaveable subgraph.
    if (node.kind === "atom") {
      // Shaveable atom → NovelGlueEntry.
      const entry: NovelGlueEntry = {
        kind: "novel-glue",
        sourceRange: node.sourceRange,
        source: node.source,
        canonicalAstHash: node.canonicalAstHash,
      };
      acc.entries.push(entry);
      acc.novelGlueBytes += node.sourceRange.end - node.sourceRange.start;
    } else {
      // Shaveable BranchNode: the whole branch is a maximal shaveable unit.
      // Emit as NovelGlueEntry and do NOT recurse — recursing would fragment
      // the shaveable tree into smaller pieces (violating maximal-subgraph discipline).
      //
      // NOTE: BranchNode.source is the full branch text. This branch passed
      // the strict-subset predicate, so it's shaveable as a whole unit.
      // We intentionally do not apply foreign-import classification here —
      // branch nodes are composite and their import content is handled at the
      // AtomLeaf level when we do recurse (which we're not doing here).
      const branch = node as BranchNode;
      const entry: NovelGlueEntry = {
        kind: "novel-glue",
        sourceRange: branch.sourceRange,
        source: branch.source,
        canonicalAstHash: branch.canonicalAstHash,
      };
      acc.entries.push(entry);
      acc.novelGlueBytes += branch.sourceRange.end - branch.sourceRange.start;
    }
    return;
  }

  // Node fails the strict-subset predicate.
  // Build a human-readable reason from the first validation error.
  const firstError =
    !validation.ok && validation.errors.length > 0 ? validation.errors[0] : undefined;
  const reason =
    firstError !== undefined
      ? `${firstError.rule}: ${firstError.message}`
      : "strict-subset-failure";

  if (node.kind === "atom") {
    // AtomLeaf fails → emit GlueLeafEntry (we cannot recurse further).
    // Sacred Practice #5: source is preserved verbatim; we do NOT transform it.
    const entry: GlueLeafEntry = {
      kind: "glue",
      source: node.source,
      canonicalAstHash: node.canonicalAstHash,
      reason,
    };
    acc.entries.push(entry);
    acc.glueBytes += node.sourceRange.end - node.sourceRange.start;
  } else {
    // BranchNode fails → recurse into children (option a: find maximal shaveable pieces).
    // The branch itself does NOT emit a GlueLeafEntry — that would create entries
    // overlapping with its children's entries, violating the non-overlapping invariant.
    // Instead, each child is visited independently and classified by its own predicate.
    const branch = node as BranchNode;
    for (const child of branch.children) {
      await walkNodeGlueAware(child, registry, acc);
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
 * Under `shaveMode: 'glue-aware'` (L2), the IR strict-subset predicate is
 * additionally applied per-subgraph. Nodes that fail the predicate become
 * GlueLeafEntry records (verbatim source, project-local, not in the registry).
 * Shaveable children of un-shaveable BranchNodes are emitted as atoms (option a
 * per DEC-V2-SLICER-SEARCH-001 — maximal-subgraph discipline).
 *
 * The returned SlicePlan contains:
 *   - `entries`: PointerEntry | ForeignLeafEntry | NovelGlueEntry | GlueLeafEntry
 *     in DFS order.
 *   - `matchedPrimitives`: deduplicated (canonicalAstHash, merkleRoot) pairs
 *     for every PointerEntry, in first-seen order.
 *   - `sourceBytesByKind`: byte sums for pointer vs. novel-glue vs. glue regions.
 *     ForeignLeafEntry bytes are not counted in any bucket.
 *
 * When `registry.findByCanonicalAstHash` is undefined, all nodes are treated
 * as unmatched and foreign-import classification still runs — AtomLeaves that
 * are foreign imports emit ForeignLeafEntry; others emit NovelGlueEntry (strict)
 * or NovelGlueEntry/GlueLeafEntry (glue-aware).
 *
 * @param tree     - The RecursionTree produced by decompose().
 * @param registry - Registry view; findByCanonicalAstHash is optional.
 * @param options  - Optional slicer options; see SliceOptions.
 *
 * @see DEC-V2-SLICER-SEARCH-001
 * @see DEC-V2-GLUE-AWARE-SHAVE-001
 */
export async function slice(
  tree: RecursionTree,
  registry: Pick<ShaveRegistryView, "findByCanonicalAstHash">,
  options?: SliceOptions,
): Promise<SlicePlan> {
  const acc: SliceAccumulator = {
    entries: [],
    matchedPrimitivesMap: new Map(),
    pointerBytes: 0,
    novelGlueBytes: 0,
    glueBytes: 0,
  };

  const mode = options?.shaveMode ?? "strict";

  if (mode === "glue-aware") {
    await walkNodeGlueAware(tree.root, registry, acc);
  } else {
    await walkNodeStrict(tree.root, registry, acc);
  }

  return {
    entries: acc.entries,
    matchedPrimitives: [...acc.matchedPrimitivesMap.values()],
    sourceBytesByKind: {
      pointer: acc.pointerBytes,
      novelGlue: acc.novelGlueBytes,
      glue: acc.glueBytes,
    },
  };
}
