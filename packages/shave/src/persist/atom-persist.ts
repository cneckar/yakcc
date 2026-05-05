// SPDX-License-Identifier: MIT
// @decision DEC-ATOM-PERSIST-001
// title: persistNovelGlueAtom persists novel atoms to the registry as BlockTripletRows
// status: decided
// rationale:
//   - Persistence is opt-in via ShaveRegistryView.storeBlock (optional method):
//     when storeBlock is absent the entry is left untouched and no error is raised.
//     This lets read-only registry views (e.g. the test mock with only findByCanonicalAstHash)
//     be used without modification.
//   - Only NovelGlueEntries with an intentCard persist; PointerEntries reference
//     existing blocks in the registry and do not produce new rows.
//   - Entries without an intentCard (deep leaves in multi-leaf trees per
//     DEC-UNIVERSALIZE-WIRING-001) are skipped. Future work: per-leaf intent
//     extraction for multi-leaf trees.
//   - WI-016: Property-test corpus is extracted via extractCorpus() before buildTriplet().
//     The CorpusResult is passed to buildTriplet() as the canonical artifact source.
//     The bootstrap placeholder (empty bytes) is no longer the silent default.
//   - Corpus extraction source preference: upstream-test (a) > documented-usage (b) > ai-derived (c).
//     cacheDir is forwarded from PersistOptions when provided, enabling source (c).
//   - Effect declaration is empty (atoms are pure-by-default at this stage;
//     effect inference is a future pass).
//   - The signature takes Registry (full interface) not ShaveRegistryView because
//     persistence requires storeBlock, which isn't in the read-only view. Callers
//     that have a full Registry pass it directly.

import type { BlockMerkleRoot, CanonicalAstHash } from "@yakcc/contracts";
import type { BlockTripletRow } from "@yakcc/registry";
import type { Registry } from "@yakcc/registry";
import { extractCorpus } from "../corpus/index.js";
import type { CorpusAtomSpec, CorpusExtractionOptions } from "../corpus/index.js";
import type { IntentCard } from "../intent/types.js";
import type { NovelGlueEntry } from "../universalize/types.js";
import { buildTriplet } from "./triplet.js";

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/**
 * Options for persistNovelGlueAtom() and maybePersistNovelGlueAtom().
 */
export interface PersistOptions {
  /**
   * Root cache directory for corpus extraction source (c) — AI-derived synthesis.
   * When provided, the AI-derived cache path is attempted after (a) and (b).
   * When omitted, source (c) is skipped (sources (a) and (b) are always available).
   */
  readonly cacheDir?: string | undefined;

  /**
   * Corpus extraction options forwarded to extractCorpus().
   * Use to disable individual sources (e.g. for testing).
   */
  readonly corpusOptions?: CorpusExtractionOptions | undefined;

  // @decision DEC-REGISTRY-PARENT-BLOCK-004
  // title: parentBlockRoot is the canonical lineage field on PersistOptions
  // status: decided (WI-017)
  // rationale:
  //   The parent_block_root column on the blocks table (added in WI-014-04) is
  //   the single authority for recursion-tree lineage. To avoid a sidecar table or
  //   in-memory map, lineage is injected via PersistOptions.parentBlockRoot and
  //   written directly into BlockTripletRow.parentBlockRoot on each persist call.
  //   No re-derivation of the parent merkle root is performed here — callers supply
  //   the literal BlockMerkleRoot returned by a prior persistNovelGlueAtom call.
  //   This preserves content-address purity: the parent reference is row metadata,
  //   not part of the child block's content address computation.
  /**
   * BlockMerkleRoot of the recursion-tree parent from which this atom was shaved.
   *
   * - `null` (or omitted) → this block is the root of its recursion tree.
   * - non-null → the caller supplies the LITERAL merkle root returned by a prior
   *   persistNovelGlueAtom call for the parent atom.
   *
   * The value is written directly to BlockTripletRow.parentBlockRoot. It is NOT
   * part of the block's content address — it is registry row metadata only.
   */
  readonly parentBlockRoot?: BlockMerkleRoot | null | undefined;

  /**
   * Absolute path of the source file being shaved (WI-V2-07-PREFLIGHT L8).
   *
   * When provided, persistNovelGlueAtom derives the sibling *.props.ts path by
   * replacing the .ts extension with .props.ts and passes it to extractCorpus()
   * as atomSpec.propsFilePath. This enables props-file corpus source (0) — the
   * highest-priority source — when a sibling .props.ts exists and contains a
   * matching prop_<atomName>_ export.
   *
   * When omitted, source (0) is silently skipped and extraction falls through to
   * upstream-test (a), documented-usage (b), and ai-derived (c) in priority order.
   */
  readonly sourceFilePath?: string | undefined;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Persist a NovelGlueEntry as a block triplet row in the registry.
 *
 * Returns the BlockMerkleRoot of the persisted block, or undefined if the
 * entry was skipped (no intentCard).
 *
 * Skips persistence without error when:
 *   - entry.intentCard is undefined (deep leaf in a multi-leaf tree).
 *
 * @param entry      - The NovelGlueEntry from the slicer. Must carry an intentCard
 *                     for persistence; entries without one are skipped.
 * @param registry   - Full Registry interface (requires storeBlock). For callers
 *                     with a read-only view, use the opt-in path in shave() instead.
 * @param options    - Optional persistence options (cacheDir for corpus source c).
 */
export async function persistNovelGlueAtom(
  entry: NovelGlueEntry,
  registry: Registry,
  options?: PersistOptions,
): Promise<BlockMerkleRoot | undefined> {
  // Skip atoms without an intent card — deep leaves in multi-leaf trees do not
  // carry one (per DEC-UNIVERSALIZE-WIRING-001; future WI populates per-leaf cards).
  const intentCard: IntentCard | undefined = entry.intentCard;
  if (intentCard === undefined) {
    return undefined;
  }

  // WI-016: Extract the property-test corpus before building the triplet.
  // The corpus result carries the artifact bytes that become the "property_tests"
  // entry in the ProofManifest, making the BlockMerkleRoot content-dependent on
  // the actual test corpus (not empty bytes).
  //
  // WI-V2-07-PREFLIGHT L8: derive sibling .props.ts path from sourceFilePath.
  // When sourceFilePath is provided, replace the .ts extension with .props.ts
  // so that extractCorpus() can attempt source (0) props-file extraction first.
  const propsFilePath = options?.sourceFilePath?.replace(/\.ts$/, ".props.ts");
  const atomSpec: CorpusAtomSpec = {
    source: entry.source,
    intentCard,
    cacheDir: options?.cacheDir,
    propsFilePath,
  };
  const corpusResult = await extractCorpus(atomSpec, options?.corpusOptions);

  // Build the full block triplet with the extracted corpus.
  const triplet = buildTriplet(intentCard, entry.source, entry.canonicalAstHash, corpusResult);

  // Construct the BlockTripletRow for registry storage.
  // parentBlockRoot is row metadata (lineage), not part of the content address —
  // per DEC-REGISTRY-PARENT-BLOCK-004. It defaults to null for root atoms.
  //
  // DEC-V1-FEDERATION-WIRE-ARTIFACTS-002: artifacts is the SAME Map that buildTriplet
  // passed to blockMerkleRoot() — forwarded here unchanged, no copy or re-derivation.
  const row: BlockTripletRow = {
    blockMerkleRoot: triplet.merkleRoot,
    specHash: triplet.specHash,
    specCanonicalBytes: triplet.specCanonicalBytes,
    implSource: triplet.impl,
    proofManifestJson: JSON.stringify(triplet.manifest),
    artifacts: triplet.artifacts,
    level: "L0",
    createdAt: Date.now(),
    canonicalAstHash: entry.canonicalAstHash,
    parentBlockRoot: options?.parentBlockRoot ?? null,
  };

  // Persist to registry. storeBlock is idempotent: storing the same
  // blockMerkleRoot twice is a no-op (per Registry contract).
  await registry.storeBlock(row);

  return triplet.merkleRoot;
}

/**
 * Opt-in persistence path for use within shave().
 *
 * Checks whether the registry view supports storeBlock and, if so, calls
 * persistNovelGlueAtom. Returns undefined when the view does not support
 * persistence (graceful degradation, no error).
 *
 * This is separate from persistNovelGlueAtom so that shave() can work with
 * a ShaveRegistryView (which may not implement storeBlock) while the direct
 * persistNovelGlueAtom API accepts the full Registry interface.
 *
 * @param entry      - The NovelGlueEntry to potentially persist.
 * @param registry   - A registry view that optionally supports storeBlock.
 * @param options    - Optional persistence options forwarded to persistNovelGlueAtom.
 */
export async function maybePersistNovelGlueAtom(
  entry: NovelGlueEntry,
  registry: { storeBlock?: Registry["storeBlock"] } & {
    findByCanonicalAstHash?: (hash: CanonicalAstHash) => Promise<readonly BlockMerkleRoot[]>;
  },
  options?: PersistOptions,
): Promise<BlockMerkleRoot | undefined> {
  if (typeof registry.storeBlock !== "function") {
    return undefined;
  }

  // Delegate to the full Registry path. We cast here because the duck-typed
  // registry satisfies the storeBlock contract even if it doesn't implement
  // every Registry method. Only storeBlock is called in this flow.
  return persistNovelGlueAtom(entry, registry as unknown as Registry, options);
}
