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
//   - Entries without an intentCard are skipped. For NovelGlueEntries this
//     should not occur in practice: WI-031 (commit `8dfb44b`, 2026-05-01)
//     calls extractIntent per novel-glue entry for multi-leaf trees (see
//     DEC-UNIVERSALIZE-MULTI-LEAF-INTENT-001). The intentCard field remains
//     optional on NovelGlueEntry for forward-compat with PointerEntry /
//     ForeignLeafEntry kinds that carry no intent slot.
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

  /**
   * Absolute path to the source file being processed.
   *
   * When provided, the props-file corpus extractor looks for a sibling
   * `<stem>.props.ts` file (replacing the `.ts` extension). If found and it
   * contains matching `prop_<atom>_*` exports, the props-file content is used
   * as the corpus artifact (highest priority, WI-V2-07-L8).
   *
   * Forwarded from shave()'s `sourcePath` parameter. Omitting this disables
   * the props-file source for this atom.
   */
  readonly sourceFilePath?: string | undefined;

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
   * Source-file provenance context forwarded from ShaveOptions.sourceContext.
   *
   * When provided, the persisted BlockTripletRow carries sourcePkg, sourceFile,
   * and sourceOffset so the registry can record where the atom was shaved from.
   * When absent (undefined), the row is stored with null provenance — correct for
   * interactive shaves and non-bootstrap runners.
   *
   * Forwarded from ShaveOptions.sourceContext via shave() → maybePersistNovelGlueAtom
   * → persistNovelGlueAtom without modification.
   *
   * @decision DEC-V2-REGISTRY-SOURCE-FILE-PROVENANCE-001
   * @scope WI-V2-REGISTRY-SOURCE-FILE-PROVENANCE P1
   */
  readonly sourceContext?:
    | {
        readonly sourcePkg: string;
        readonly sourceFile: string;
        readonly sourceOffset: number | null;
      }
    | undefined;
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
  // Skip atoms without an intent card — this is the defensive safety net for
  // non-NovelGlue entry kinds (PointerEntry, ForeignLeafEntry) that have no
  // intentCard slot. Per WI-031 (DEC-UNIVERSALIZE-MULTI-LEAF-INTENT-001),
  // novel-glue entries in multi-leaf trees DO carry per-leaf cards; this branch
  // is not expected to fire for them in the normal pipeline.
  const intentCard: IntentCard | undefined = entry.intentCard;
  if (intentCard === undefined) {
    return undefined;
  }

  // WI-016: Extract the property-test corpus before building the triplet.
  // The corpus result carries the artifact bytes that become the "property_tests"
  // entry in the ProofManifest, making the BlockMerkleRoot content-dependent on
  // the actual test corpus (not empty bytes).
  //
  // WI-V2-07-L8: derive propsFilePath from sourceFilePath when provided.
  // The props-file extractor (highest-priority source) will check for matching
  // prop_<atom>_* exports in the sibling *.props.ts before falling through
  // to upstream-test source-(a).
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
  //
  // DEC-V2-REGISTRY-SOURCE-FILE-PROVENANCE-001: sourceContext fields are forwarded
  // from PersistOptions.sourceContext when provided by the bootstrap walker.
  // When absent (undefined), all three provenance fields default to null — correct
  // for interactive shaves and non-bootstrap runners. INSERT OR IGNORE in storeBlock
  // ensures first-observed-wins: a second store with null does not clobber existing
  // non-null provenance.
  const sc = options?.sourceContext;
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
    // Provenance fields — null when not supplied by the caller.
    sourcePkg: sc?.sourcePkg ?? null,
    sourceFile: sc?.sourceFile ?? null,
    sourceOffset: sc?.sourceOffset ?? null,
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
