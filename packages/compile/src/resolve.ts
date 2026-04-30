// @decision DEC-COMPILE-RESOLVE-002: resolveComposition traverses the composition
// graph depth-first using BlockMerkleRoot as the node identity (WI-T04).
// Status: implemented (WI-T04); supersedes DEC-COMPILE-RESOLVE-001 (ContractId-based,
// WI-005). The old ContractId-based resolver is deleted; no dual-authority coexistence
// (Sacred Practice #12).
// Rationale: After the triplet migration (T01-T03), every block in the registry is
// identified by its BlockMerkleRoot. Sub-block composition references in impl.ts are
// "import type" lines whose module specifier paths are resolved to BlockMerkleRoots
// via the SubBlockResolver callback (backed by registry.selectBlocks(specHash) in
// assemble()). The DFS therefore:
//   1. Fetches BlockTripletRow via registry.getBlock(merkleRoot).
//   2. Extracts sub-block import paths from the row's implSource by scanning for
//      "import type" lines whose specifier starts with "./" or "@yakcc/seeds/" or
//      "@yakcc/blocks/" — the same heuristic as @yakcc/ir's extractComposition.
//      We do NOT call parseBlockTriplet from disk here; the impl source is already
//      in the registry row.
//   3. Resolves each import path to a BlockMerkleRoot via the SubBlockResolver.
//   4. Recurses (post-order DFS) into each resolved sub-block.
//
// Cycle detection uses a Set<BlockMerkleRoot> tracking the current DFS path.
// Topological order is preserved: leaves appear before parents.

import type { BlockMerkleRoot, SpecHash } from "@yakcc/contracts";
import type { Registry } from "@yakcc/registry";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * A fully resolved block: its BlockMerkleRoot, impl source text, spec hash,
 * and direct sub-block deps (by BlockMerkleRoot).
 */
export interface ResolvedBlock {
  readonly merkleRoot: BlockMerkleRoot;
  readonly specHash: SpecHash;
  readonly source: string;
  readonly subBlocks: ReadonlyArray<BlockMerkleRoot>;
}

/**
 * The result of a full composition-graph traversal starting from an entry block.
 *
 * `blocks` is the complete transitive closure (merkleRoot → ResolvedBlock).
 * `order` is topological (leaves first, entry last).
 */
export interface ResolutionResult {
  readonly entry: BlockMerkleRoot;
  readonly blocks: ReadonlyMap<BlockMerkleRoot, ResolvedBlock>;
  readonly order: ReadonlyArray<BlockMerkleRoot>;
}

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

export type ResolutionErrorKind =
  | "missing-block" // block not found in registry by merkle root
  | "cycle" // directed cycle in the composition graph
  | "invalid-block"; // block fetched but implSource is malformed

/**
 * Thrown by resolveComposition when traversal cannot complete.
 */
export class ResolutionError extends Error {
  readonly kind: ResolutionErrorKind;
  readonly merkleRoot: BlockMerkleRoot;

  constructor(opts: {
    readonly kind: ResolutionErrorKind;
    readonly merkleRoot: BlockMerkleRoot;
    readonly message: string;
  }) {
    super(opts.message);
    this.name = "ResolutionError";
    this.kind = opts.kind;
    this.merkleRoot = opts.merkleRoot;
  }
}

// ---------------------------------------------------------------------------
// Sub-block resolver callback type
// ---------------------------------------------------------------------------

/**
 * Maps a sub-block import path (e.g. "@yakcc/seeds/blocks/digit" or "./bracket.js")
 * to the BlockMerkleRoot of the chosen block, or null to skip the reference.
 *
 * Provided by assemble() so the composition traversal stays decoupled from
 * knowledge about how the registry is indexed. The resolver is backed by
 * registry.selectBlocks(specHash) in the assemble() implementation.
 */
export type SubBlockResolver = (importedFrom: string) => Promise<BlockMerkleRoot | null>;

// ---------------------------------------------------------------------------
// Internal: extract sub-block import paths from implSource
// ---------------------------------------------------------------------------

/**
 * Regex that matches "import type { ... } from '...'" lines whose specifier
 * starts with "./" or "@yakcc/seeds/" or "@yakcc/blocks/".
 *
 * Mirrors the heuristic in @yakcc/ir's extractComposition (block-parser.ts).
 * These are the intra-corpus sub-block composition references.
 */
const SUB_BLOCK_IMPORT_RE =
  /^import\s+type\s+\{[^}]*\}\s+from\s+["'](\.\/|@yakcc\/seeds\/|@yakcc\/blocks\/)([^"']*)["'];?\s*$/;

/**
 * Extract all sub-block import module specifiers from an impl.ts source string.
 *
 * Returns specifier strings in declaration order. Duplicates are included;
 * the DFS will skip already-visited blocks.
 */
function extractSubBlockImports(implSource: string): string[] {
  const specifiers: string[] = [];
  for (const line of implSource.split("\n")) {
    const match = line.match(SUB_BLOCK_IMPORT_RE);
    if (match !== null) {
      // Reconstruct the full specifier (prefix + suffix)
      const prefix = match[1] ?? "";
      const suffix = match[2] ?? "";
      specifiers.push(`${prefix}${suffix}`);
    }
  }
  return specifiers;
}

// ---------------------------------------------------------------------------
// Internal DFS state
// ---------------------------------------------------------------------------

interface DfsState {
  readonly registry: Registry;
  readonly subBlockResolver: SubBlockResolver;
  readonly blocks: Map<BlockMerkleRoot, ResolvedBlock>;
  readonly order: BlockMerkleRoot[];
  /** Roots currently on the DFS stack — used for cycle detection. */
  readonly path: Set<BlockMerkleRoot>;
}

// ---------------------------------------------------------------------------
// Internal: visit one node
// ---------------------------------------------------------------------------

async function visitBlock(merkleRoot: BlockMerkleRoot, state: DfsState): Promise<void> {
  // Already resolved (DAG share) — skip.
  if (state.blocks.has(merkleRoot)) return;

  // Cycle: this merkleRoot is already on the current DFS path.
  if (state.path.has(merkleRoot)) {
    throw new ResolutionError({
      kind: "cycle",
      merkleRoot,
      message: `Composition cycle detected involving block ${merkleRoot}`,
    });
  }

  // Fetch the block triplet row from the registry.
  const row = await state.registry.getBlock(merkleRoot);
  if (row === null) {
    throw new ResolutionError({
      kind: "missing-block",
      merkleRoot,
      message: `Block ${merkleRoot} not found in registry`,
    });
  }

  // Push onto the DFS path before recursing into children.
  state.path.add(merkleRoot);

  // Extract sub-block import paths from the stored impl source.
  const importPaths = extractSubBlockImports(row.implSource);
  const subBlockRoots: BlockMerkleRoot[] = [];

  for (const importedFrom of importPaths) {
    const subRoot = await state.subBlockResolver(importedFrom);
    if (subRoot === null) continue; // resolver returned null → skip

    subBlockRoots.push(subRoot);
    await visitBlock(subRoot, state);
  }

  // Pop from DFS path.
  state.path.delete(merkleRoot);

  // Post-order: record this block after all its children are recorded.
  state.blocks.set(merkleRoot, {
    merkleRoot,
    specHash: row.specHash,
    source: row.implSource,
    subBlocks: subBlockRoots,
  });
  state.order.push(merkleRoot);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Traverse the composition graph starting from `entry` and resolve the transitive
 * closure of all referenced blocks from the registry.
 *
 * `subBlockResolver` maps sub-block import paths to BlockMerkleRoots. Return null
 * from the resolver to skip a reference (silently). Throw from the resolver to
 * propagate a hard lookup failure.
 *
 * @throws ResolutionError kind "missing-block" — block not found in registry.
 * @throws ResolutionError kind "cycle" — directed cycle in composition graph.
 */
export async function resolveComposition(
  entry: BlockMerkleRoot,
  registry: Registry,
  subBlockResolver: SubBlockResolver,
): Promise<ResolutionResult> {
  const state: DfsState = {
    registry,
    subBlockResolver,
    blocks: new Map(),
    order: [],
    path: new Set(),
  };

  await visitBlock(entry, state);

  return {
    entry,
    blocks: state.blocks,
    order: state.order,
  };
}
