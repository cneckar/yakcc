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
//   - Property-test corpus is empty at L0 bootstrap (ProofManifest has one
//     "property_tests" artifact with empty bytes). The real corpus is WI-013-03.
//   - Effect declaration is empty (atoms are pure-by-default at this stage;
//     effect inference is a future pass).
//   - The signature takes Registry (full interface) not ShaveRegistryView because
//     persistence requires storeBlock, which isn't in the read-only view. Callers
//     that have a full Registry pass it directly.

import type { BlockMerkleRoot, CanonicalAstHash } from "@yakcc/contracts";
import type { BlockTripletRow } from "@yakcc/registry";
import type { Registry } from "@yakcc/registry";
import type { IntentCard } from "../intent/types.js";
import type { NovelGlueEntry } from "../universalize/types.js";
import { buildTriplet } from "./triplet.js";

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
 */
export async function persistNovelGlueAtom(
  entry: NovelGlueEntry,
  registry: Registry,
): Promise<BlockMerkleRoot | undefined> {
  // Skip atoms without an intent card — deep leaves in multi-leaf trees do not
  // carry one (per DEC-UNIVERSALIZE-WIRING-001; future WI populates per-leaf cards).
  const intentCard: IntentCard | undefined = entry.intentCard;
  if (intentCard === undefined) {
    return undefined;
  }

  // Build the full block triplet.
  const triplet = buildTriplet(intentCard, entry.source, entry.canonicalAstHash);

  // Construct the BlockTripletRow for registry storage.
  const row: BlockTripletRow = {
    blockMerkleRoot: triplet.merkleRoot,
    specHash: triplet.specHash,
    specCanonicalBytes: triplet.specCanonicalBytes,
    implSource: triplet.impl,
    proofManifestJson: JSON.stringify(triplet.manifest),
    level: "L0",
    createdAt: Date.now(),
    canonicalAstHash: entry.canonicalAstHash,
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
 */
export async function maybePersistNovelGlueAtom(
  entry: NovelGlueEntry,
  registry: { storeBlock?: Registry["storeBlock"] } & {
    findByCanonicalAstHash?: (hash: CanonicalAstHash) => Promise<readonly BlockMerkleRoot[]>;
  },
): Promise<BlockMerkleRoot | undefined> {
  if (typeof registry.storeBlock !== "function") {
    return undefined;
  }

  // Delegate to the full Registry path. We cast here because the duck-typed
  // registry satisfies the storeBlock contract even if it doesn't implement
  // every Registry method. Only storeBlock is called in this flow.
  return persistNovelGlueAtom(entry, registry as unknown as Registry);
}
