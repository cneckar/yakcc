// @decision DEC-COMPILE-ASSEMBLE-001: assemble() builds the SubBlockResolver by
// scanning all implementations stored in the registry — it calls getImplementation for
// every contractId in the resolved corpus and builds a map from import-path stem to
// ContractId. The scan requires a seed set of known contractIds to bootstrap the
// stem index, because the Registry has no listAll() method and sub-block contractIds
// cannot be derived from import-path strings alone (the paths contain only filename
// stems, not content-addresses).
// Status: implemented (WI-005)
// Rationale: The Registry interface is bounded to getContract and getImplementation;
// listAll() is explicitly out of scope. To resolve the full transitive closure,
// assemble() accepts an optional AssembleOptions.knownContractIds iterable that seeds
// the stem index before the DFS traversal. When the caller supplies seedResult.contractIds
// (from @yakcc/seeds), all sub-block stems are indexed upfront and the DFS succeeds.
// Without knownContractIds, only blocks reachable via DFS from already-indexed stems
// are resolved (entry-only for the seeds corpus, since sub-block stems are unknown).
//
// @decision DEC-COMPILE-ASSEMBLE-RESOLVER-002: The SubBlockResolver matches import paths
// by extracting the filename stem from the importedFrom path (e.g. "./bracket.js" →
// "bracket") and comparing it against the function name exported by each registered
// block. This works because the seeds corpus uses the convention that each block file
// exports a function named identically to its filename stem.
// Status: implemented (WI-005)
// Rationale: The seeds blocks use relative "./X.js" imports and the filename stem equals
// the exported function name (bracket.ts exports bracket, integer.ts exports integer,
// etc.). A map from stem → ContractId built by fetching each block's source is
// sufficient to resolve all sub-block refs in the corpus. The compiler does not need to
// know the block file paths on disk.

import type { ContractId } from "@yakcc/contracts";
import { parseBlock } from "@yakcc/ir";
import type { Registry } from "@yakcc/registry";
import type { ProvenanceManifest } from "./manifest.js";
import { buildManifest } from "./manifest.js";
import { ResolutionError, type ResolutionResult, resolveComposition } from "./resolve.js";
import { tsBackend } from "./ts-backend.js";
import type { Backend } from "./ts-backend.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * The output of one assembly pass: source text of the composed module plus
 * a provenance manifest listing every block used.
 *
 * No author, signature, or ownership fields — DEC-NO-OWNERSHIP-011.
 */
export interface Artifact {
  /** The emitted module source text. */
  readonly source: string;
  readonly manifest: ProvenanceManifest;
}

/**
 * Options for assemble().
 *
 * knownContractIds — an optional iterable of contractIds already present in the
 * registry. When provided, assemble() pre-fetches all their implementations to
 * build a complete stem → ContractId index before the DFS traversal. This is
 * required for corpora that use relative import paths (e.g. "./bracket.js") where
 * the registry has no listAll() method and sub-block contractIds cannot be derived
 * from import-path strings alone.
 *
 * When omitted, assemble() resolves only the blocks reachable via DFS from the
 * entry block's already-indexed stems (typically just the entry itself for the
 * seeds corpus, since sub-block stems are unknown without a seed set).
 */
export interface AssembleOptions {
  readonly knownContractIds?: Iterable<ContractId>;
}

// ---------------------------------------------------------------------------
// Internal: sub-block resolver builder
// ---------------------------------------------------------------------------

/**
 * Extract the filename stem from an import path.
 *
 * Examples:
 *   "./bracket.js"          → "bracket"
 *   "@yakcc/seeds/blocks/bracket" → "bracket"
 *   "./non-ascii-rejector.js" → "non-ascii-rejector"
 */
function importPathStem(importedFrom: string): string {
  // Strip leading "./" or package prefix, then strip trailing ".js" extension.
  const lastSlash = importedFrom.lastIndexOf("/");
  const base = lastSlash >= 0 ? importedFrom.slice(lastSlash + 1) : importedFrom;
  return base.endsWith(".js") ? base.slice(0, -3) : base;
}

/**
 * Extract the primary exported function name from a block source.
 *
 * Scans for the first "export function <name>" or "export async function <name>" line.
 * Returns null if none found.
 */
function extractFunctionName(source: string): string | null {
  for (const line of source.split("\n")) {
    const match = line.match(/^export\s+(?:async\s+)?function\s+(\w+)\s*[(<]/);
    if (match?.[1] !== undefined) return match[1];
  }
  return null;
}

/**
 * Build a map from filename stem → ContractId by scanning a set of already-resolved
 * block sources.
 *
 * For each block source, we parse it with parseBlock() to get the ContractId (from the
 * CONTRACT export), then also extract the exported function name to derive the stem.
 * We additionally use the importedFrom stem → function name convention of the seeds
 * corpus: stem = function name (with camelCase vs kebab-case handled by normalisation).
 */
function buildStemIndex(
  blocks: ReadonlyMap<ContractId, { readonly source: string }>,
): Map<string, ContractId> {
  const index = new Map<string, ContractId>();

  for (const [contractId, block] of blocks) {
    // Index by the exported function name (camelCase).
    const fnName = extractFunctionName(block.source);
    if (fnName !== null) {
      index.set(fnName, contractId);
    }

    // Also extract the block's own ContractId from source for cross-checking.
    const parsed = parseBlock(block.source);
    if (parsed.contract !== null && parsed.contract === contractId) {
      // contractId already in the map; the fnName entry is the primary key.
    }
  }

  return index;
}

/**
 * Normalise a filename stem to camelCase to match the exported function name convention.
 *
 * The seeds corpus uses kebab-case filenames (non-ascii-rejector.ts) but exports
 * camelCase function names (nonAsciiRejector). This converts kebab-case to camelCase.
 *
 * Example: "non-ascii-rejector" → "nonAsciiRejector"
 */
function stemToCamelCase(stem: string): string {
  return stem.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
}

// ---------------------------------------------------------------------------
// Internal: pre-scan the registry for the entry block's transitive corpus
// ---------------------------------------------------------------------------

/**
 * Perform a pre-scan of the registry to build a stem → ContractId index.
 *
 * Phase 1 (seed): if `knownContractIds` is provided, fetch every listed
 * implementation and index it by exported function name. This populates the
 * stem index for the full corpus before any DFS traversal begins, solving the
 * bootstrapping problem where the entry block's sub-block refs cannot be resolved
 * without first knowing the sub-blocks' contractIds.
 *
 * Phase 2 (entry BFS): starting from `entry`, walk sub-block composition refs
 * and enqueue any contractIds resolvable from the current index. This handles
 * corpora that don't provide knownContractIds by resolving whatever is reachable.
 *
 * Returns the completed stem → ContractId index and the source map (contractId → source).
 */
async function preScanCorpus(
  entry: ContractId,
  registry: Registry,
  knownContractIds: ReadonlyArray<ContractId>,
): Promise<{ stemIndex: Map<string, ContractId>; sourceMap: Map<ContractId, string> }> {
  const sourceMap = new Map<ContractId, string>();
  const stemIndex = new Map<string, ContractId>();

  // Phase 1: if caller supplied known contractIds, fetch and index them all upfront.
  // This populates stemIndex with all corpus blocks before the entry-BFS phase,
  // enabling sub-block ref lookup to succeed for the seeds corpus.
  for (const id of knownContractIds) {
    const impl = await registry.getImplementation(id);
    if (impl === null) continue;
    sourceMap.set(id, impl.source);
    const fnName = extractFunctionName(impl.source);
    if (fnName !== null) {
      stemIndex.set(fnName, id);
    }
  }

  // Phase 2: BFS from the entry block, resolving sub-block refs via the index.
  const queue: ContractId[] = [entry];
  const visited = new Set<ContractId>();

  while (queue.length > 0) {
    const id = queue.shift();
    if (id === undefined || visited.has(id)) continue;
    visited.add(id);

    // Fetch if not already fetched in Phase 1.
    if (!sourceMap.has(id)) {
      const impl = await registry.getImplementation(id);
      if (impl === null) continue; // missing — will be caught by DFS traversal
      sourceMap.set(id, impl.source);
      const fnName = extractFunctionName(impl.source);
      if (fnName !== null) {
        stemIndex.set(fnName, id);
      }
    }

    const source = sourceMap.get(id);
    if (source === undefined) continue;

    // Find sub-block refs and enqueue contractIds resolvable from the current index.
    const block = parseBlock(source, {
      blockPatterns: ["./", "@yakcc/seeds/", "@yakcc/blocks/"],
    });

    for (const ref of block.composition) {
      const stem = importPathStem(ref.importedFrom);
      const camel = stemToCamelCase(stem);

      const subId = stemIndex.get(camel) ?? stemIndex.get(stem) ?? null;
      if (subId !== null && !visited.has(subId)) {
        queue.push(subId);
      }
    }
  }

  return { stemIndex, sourceMap };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Assemble a runnable TypeScript module from the entry contract's composition graph.
 *
 * Steps:
 *   1. Pre-scan the registry to build a stem → ContractId index. If options.knownContractIds
 *      is provided, all listed blocks are fetched upfront (Phase 1), then a BFS from the
 *      entry block expands via resolved sub-block refs (Phase 2). Without knownContractIds,
 *      only Phase 2 runs (entry-only resolution for corpora with relative import paths).
 *   2. Run resolveComposition() with a SubBlockResolver backed by that index.
 *   3. Emit the assembled source via the backend (defaults to tsBackend()).
 *   4. Build the ProvenanceManifest via buildManifest().
 *   5. Return Artifact { source, manifest }.
 *
 * @throws ResolutionError if any block in the composition graph is missing or cyclic.
 */
export async function assemble(
  entry: ContractId,
  registry: Registry,
  backend: Backend = tsBackend(),
  options: AssembleOptions = {},
): Promise<Artifact> {
  // Step 1: pre-scan to build the stem → ContractId index.
  const knownIds: ReadonlyArray<ContractId> = options.knownContractIds
    ? [...options.knownContractIds]
    : [];
  const { stemIndex } = await preScanCorpus(entry, registry, knownIds);

  // Step 2: SubBlockResolver backed by the pre-built index.
  const subBlockResolver = async (importedFrom: string): Promise<ContractId | null> => {
    const stem = importPathStem(importedFrom);
    const camel = stemToCamelCase(stem);
    return stemIndex.get(camel) ?? stemIndex.get(stem) ?? null;
  };

  // Step 3: resolve the composition graph.
  let resolution: ResolutionResult;
  try {
    resolution = await resolveComposition(entry, registry, subBlockResolver);
  } catch (err) {
    if (err instanceof ResolutionError) throw err;
    throw new Error(`Assembly failed: ${String(err)}`);
  }

  // Step 4: emit source.
  const source = await backend.emit(resolution);

  // Step 5: build provenance manifest.
  const manifest = await buildManifest(resolution, registry);

  return { source, manifest };
}
