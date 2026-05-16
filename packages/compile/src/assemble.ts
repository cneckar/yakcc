// SPDX-License-Identifier: MIT
// @decision DEC-COMPILE-ASSEMBLE-003: assemble() builds the SubBlockResolver by
// calling registry.selectBlocks(specHash) for each sub-block import path extracted
// from the entry block's implSource. The specHash is derived from the import path
// stem using a stem→specHash index pre-built by fetching known BlockMerkleRoots.
// Status: implemented (WI-T04); supersedes DEC-COMPILE-ASSEMBLE-001 and
// DEC-COMPILE-ASSEMBLE-RESOLVER-002 (ContractId-based stem index, WI-005).
// The old ContractId/stem/parseBlock pre-scan is deleted per Sacred Practice #12.
// Rationale: With the triplet migration, every block in the registry is identified by
// BlockMerkleRoot. Sub-block import paths in impl.ts (e.g. "@yakcc/seeds/blocks/digit")
// carry no direct BlockMerkleRoot; they encode a module-path reference that resolves
// through the spec_hash index. assemble() therefore:
//   1. Fetches the entry BlockTripletRow via registry.getBlock(entry).
//   2. Extracts sub-block import specifiers from the row's implSource (same heuristic
//      as resolveComposition's extractSubBlockImports).
//   3. For each specifier, derives a candidate SpecHash by looking up which registered
//      blocks have an implSource export name matching the path stem — OR, if the caller
//      supplies knownMerkleRoots, pre-builds a stem→specHash index upfront from those
//      rows. selectBlocks(specHash) then returns the ordered candidate list and assemble
//      picks the first (best) result per the registry's selection ordering.
//   4. The SubBlockResolver closure calls selectBlocks(specHash) and returns the first
//      candidate BlockMerkleRoot, or null if none found.
//
// The byte-identical re-emit invariant is preserved: given an unchanged registry,
// selectBlocks always returns the same ordered list for the same specHash, so the
// same BlockMerkleRoot is always chosen, producing the same resolution order and
// the same emitted artifact.

import type { BlockMerkleRoot, Granularity, SpecHash } from "@yakcc/contracts";
import { DEFAULT_GRANULARITY } from "@yakcc/contracts";
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
 * knownMerkleRoots — an optional iterable of BlockMerkleRoots already present in
 * the registry. When provided, assemble() pre-fetches all their BlockTripletRows to
 * build a stem → SpecHash index before the DFS traversal. This is required for
 * corpora that use relative import paths (e.g. "./bracket.js") where the stem
 * encodes a function name that must be matched against stored impl sources to derive
 * the SpecHash needed for selectBlocks().
 *
 * When omitted, assemble() attempts to resolve sub-block refs using only the
 * entry block's own implSource imports (typically insufficient for corpora that
 * use relative import paths, since the SpecHash is unknown without fetching rows).
 *
 * granularity — atom-specificity dial (1 = tightest, 5 = loosest).
 * Defaults to DEFAULT_GRANULARITY (3). Per-level semantics are calibrated from
 * B9 (#446) and B4 (#188) sweep data; the dial is accepted here so the CLI and
 * hook layers can pass it through now, even before per-level behaviour is wired.
 * See @decision DEC-WI463-GRANULARITY-001 in @yakcc/contracts/src/granularity.ts.
 */
export interface AssembleOptions {
  readonly knownMerkleRoots?: Iterable<BlockMerkleRoot>;
  readonly granularity?: Granularity;
}

/** @internal Resolve the effective granularity from AssembleOptions. */
export function resolveGranularity(opts: AssembleOptions | undefined): Granularity {
  return opts?.granularity ?? DEFAULT_GRANULARITY;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Extract the filename stem from an import path.
 *
 * Examples:
 *   "./bracket.js"               → "bracket"
 *   "@yakcc/seeds/blocks/bracket" → "bracket"
 *   "./non-ascii-rejector.js"    → "non-ascii-rejector"
 */
function importPathStem(importedFrom: string): string {
  const lastSlash = importedFrom.lastIndexOf("/");
  const base = lastSlash >= 0 ? importedFrom.slice(lastSlash + 1) : importedFrom;
  return base.endsWith(".js") ? base.slice(0, -3) : base;
}

/**
 * Convert a kebab-case filename stem to camelCase.
 *
 * The seeds corpus uses kebab-case filenames (non-ascii-rejector) but exports
 * camelCase function names (nonAsciiRejector). Matching requires normalisation.
 *
 * Example: "non-ascii-rejector" → "nonAsciiRejector"
 */
function stemToCamelCase(stem: string): string {
  return stem.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
}

/**
 * Extract the primary exported function name from a block impl source.
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

// ---------------------------------------------------------------------------
// Internal: build the stem → SpecHash index from known merkle roots
// ---------------------------------------------------------------------------

/**
 * Pre-scan a set of known BlockMerkleRoots to build a stem → SpecHash index.
 *
 * For each known root, fetches the BlockTripletRow from the registry and indexes
 * by the exported function name extracted from implSource (camelCase primary key)
 * and the raw stem (kebab-case fallback). This enables the SubBlockResolver to
 * map import-path stems to SpecHashes for selectBlocks() lookup.
 *
 * Returns the completed stem → SpecHash index.
 */
async function buildStemSpecHashIndex(
  knownRoots: ReadonlyArray<BlockMerkleRoot>,
  registry: Registry,
): Promise<Map<string, SpecHash>> {
  const index = new Map<string, SpecHash>();

  for (const root of knownRoots) {
    const row = await registry.getBlock(root);
    if (row === null) continue;

    const fnName = extractFunctionName(row.implSource);
    if (fnName !== null) {
      // Primary key: camelCase function name (matches the most import stems).
      index.set(fnName, row.specHash);
    }
    // No secondary stem key needed: extractFunctionName covers the canonical case.
    // If a corpus uses kebab-case function names (unusual), the camelCase conversion
    // in the resolver will handle the normalisation.
  }

  return index;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Assemble a runnable TypeScript module from the entry block's composition graph.
 *
 * Steps:
 *   1. Pre-build a stem → SpecHash index from knownMerkleRoots (if supplied).
 *   2. Construct a SubBlockResolver that maps import-path stems to BlockMerkleRoots
 *      via stem → SpecHash → registry.selectBlocks(specHash) → first candidate.
 *   3. Run resolveComposition() with that SubBlockResolver.
 *   4. Emit the assembled source via the backend (defaults to tsBackend()).
 *   5. Build the ProvenanceManifest via buildManifest().
 *   6. Return Artifact { source, manifest }.
 *
 * Byte-identical re-emit: given an unchanged registry, selectBlocks always returns
 * the same ordered list for the same specHash (deterministic ordering per T03's
 * selection algorithm), so the same BlockMerkleRoot is always chosen, the same
 * resolution order results, and the emitted artifact and manifest are byte-identical.
 *
 * @throws ResolutionError if any block in the composition graph is missing or cyclic.
 */
export async function assemble(
  entry: BlockMerkleRoot,
  registry: Registry,
  backend: Backend = tsBackend(),
  options: AssembleOptions = {},
): Promise<Artifact> {
  // Step 1: pre-build stem → SpecHash index from known roots.
  const knownRoots: ReadonlyArray<BlockMerkleRoot> = options.knownMerkleRoots
    ? [...options.knownMerkleRoots]
    : [];
  const stemSpecHashIndex = await buildStemSpecHashIndex(knownRoots, registry);

  // Step 2: SubBlockResolver — maps import path to BlockMerkleRoot via selectBlocks.
  const subBlockResolver = async (importedFrom: string): Promise<BlockMerkleRoot | null> => {
    const stem = importPathStem(importedFrom);
    const camel = stemToCamelCase(stem);

    // Try camelCase first (primary), then raw stem (fallback for unusual names).
    const specHashValue = stemSpecHashIndex.get(camel) ?? stemSpecHashIndex.get(stem) ?? null;
    if (specHashValue === null) return null;

    // selectBlocks returns candidates in deterministic selection order (T03).
    const candidates = await registry.selectBlocks(specHashValue);
    return candidates[0] ?? null;
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
