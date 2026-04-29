// @decision DEC-COMPILE-RESOLVE-001: resolveComposition traverses the composition graph
// depth-first, using registry.getImplementation(contractId) to fetch each block's source,
// then parseBlock() to extract sub-block references, then recursing into each.
// Status: implemented (WI-005)
// Rationale: The compile engine must assemble the transitive closure of all blocks
// referenced by the entry contract. Depth-first post-order traversal naturally produces
// topological order (leaves first, entry last) — each block appears before any block
// that depends on it. Cycle detection uses a Set<ContractId> tracking the current DFS
// path (ancestors); a node encountered while still on the path is a cycle.
//
// Sub-block references come from parseBlock().composition[i].importedFrom — a module
// specifier like "./bracket.js" or "@yakcc/seeds/blocks/bracket". Because the seeds
// corpus uses "import type { X } from './X.js'" (relative paths) and resolveContractIds
// is not yet implemented in @yakcc/ir, SubBlockReference.contract is always null.
// resolveComposition therefore accepts a SubBlockResolver callback that maps an
// importedFrom path to a ContractId; the caller (assemble()) provides this mapping
// by scanning the registry or by reading seed block sources.

import type { ContractId } from "@yakcc/contracts";
import { parseBlock } from "@yakcc/ir";
import type { Registry } from "@yakcc/registry";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * A fully resolved block: its ContractId, source text, and direct sub-block deps.
 */
export interface ResolvedBlock {
  readonly contractId: ContractId;
  readonly source: string;
  readonly subBlocks: ReadonlyArray<ContractId>;
}

/**
 * The result of a full composition-graph traversal starting from an entry contract.
 *
 * `blocks` is the complete transitive closure (contractId → ResolvedBlock).
 * `order` is topological (leaves first, entry last).
 */
export interface ResolutionResult {
  readonly entry: ContractId;
  readonly blocks: ReadonlyMap<ContractId, ResolvedBlock>;
  readonly order: ReadonlyArray<ContractId>;
}

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

export type ResolutionErrorKind =
  | "missing-block" // implementation not found in registry
  | "missing-contract" // contract id not found in registry
  | "cycle" // directed cycle in the composition graph
  | "invalid-block"; // parseBlock strict-subset validation failed

/**
 * Thrown by resolveComposition when traversal cannot complete.
 */
export class ResolutionError extends Error {
  readonly kind: ResolutionErrorKind;
  readonly contractId: ContractId;

  constructor(opts: {
    readonly kind: ResolutionErrorKind;
    readonly contractId: ContractId;
    readonly message: string;
  }) {
    super(opts.message);
    this.name = "ResolutionError";
    this.kind = opts.kind;
    this.contractId = opts.contractId;
  }
}

// ---------------------------------------------------------------------------
// Sub-block resolver callback type
// ---------------------------------------------------------------------------

/**
 * Maps a sub-block import path (e.g. "./bracket.js") to the ContractId of the
 * referenced block, or null to skip the reference.
 *
 * Provided by assemble() so the composition traversal stays decoupled from
 * knowledge about where block sources live on disk or how the registry is indexed.
 */
export type SubBlockResolver = (importedFrom: string) => Promise<ContractId | null>;

// ---------------------------------------------------------------------------
// Internal DFS state
// ---------------------------------------------------------------------------

interface DfsState {
  readonly registry: Registry;
  readonly subBlockResolver: SubBlockResolver;
  readonly blocks: Map<ContractId, ResolvedBlock>;
  readonly order: ContractId[];
  /** Contracts currently on the DFS stack — used for cycle detection. */
  readonly path: Set<ContractId>;
}

// ---------------------------------------------------------------------------
// Internal: visit one node
// ---------------------------------------------------------------------------

async function visitBlock(contractId: ContractId, state: DfsState): Promise<void> {
  // Already resolved (DAG share) — skip.
  if (state.blocks.has(contractId)) return;

  // Cycle: this contractId is already on the current DFS path.
  if (state.path.has(contractId)) {
    throw new ResolutionError({
      kind: "cycle",
      contractId,
      message: `Composition cycle detected involving contract ${contractId}`,
    });
  }

  // Fetch the implementation source from the registry.
  const impl = await state.registry.getImplementation(contractId);
  if (impl === null) {
    // Distinguish "contract unknown" from "contract exists, no implementation".
    const contract = await state.registry.getContract(contractId);
    if (contract === null) {
      throw new ResolutionError({
        kind: "missing-contract",
        contractId,
        message: `Contract ${contractId} not found in registry`,
      });
    }
    throw new ResolutionError({
      kind: "missing-block",
      contractId,
      message: `No implementation found for contract ${contractId}`,
    });
  }

  // Parse to extract sub-block composition references.
  const block = parseBlock(impl.source, {
    blockPatterns: ["./", "@yakcc/seeds/", "@yakcc/blocks/"],
  });

  if (!block.validation.ok) {
    throw new ResolutionError({
      kind: "invalid-block",
      contractId,
      message: `Block ${contractId} failed strict-subset validation: ${block.validation.errors.map((e) => e.message).join("; ")}`,
    });
  }

  // Push onto the DFS path before recursing into children.
  state.path.add(contractId);

  const subBlockIds: ContractId[] = [];

  for (const ref of block.composition) {
    const subId = await state.subBlockResolver(ref.importedFrom);
    if (subId === null) continue; // resolver returned null → skip

    subBlockIds.push(subId);
    await visitBlock(subId, state);
  }

  // Pop from DFS path.
  state.path.delete(contractId);

  // Post-order: record this block after all its children are recorded.
  state.blocks.set(contractId, {
    contractId,
    source: impl.source,
    subBlocks: subBlockIds,
  });
  state.order.push(contractId);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Traverse the composition graph starting from `entry` and resolve the transitive
 * closure of all referenced blocks from the registry.
 *
 * `subBlockResolver` maps sub-block import paths to ContractIds. Return null from
 * the resolver to skip a reference (silently). Throw from the resolver to propagate
 * a hard lookup failure.
 *
 * @throws ResolutionError kind "missing-contract" — entry not in registry.
 * @throws ResolutionError kind "missing-block" — contract exists but no implementation.
 * @throws ResolutionError kind "cycle" — directed cycle in composition graph.
 * @throws ResolutionError kind "invalid-block" — strict-subset validation failed.
 */
export async function resolveComposition(
  entry: ContractId,
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
