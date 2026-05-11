// SPDX-License-Identifier: MIT
// load-corpus.ts — corpus enumeration helper for the v2 self-shave PoC.
//
// @decision DEC-V2-CORPUS-MANIFEST-LOCATION-001
// @title corpus.manifest.json lives in examples/v2-self-shave-poc/, NOT under bootstrap/
// @status accepted
// @rationale bootstrap/ is reserved for the byte-deterministic CI-owned shave manifest
//   (expected-roots.json) per DEC-BOOTSTRAP-MANIFEST-ACCUMULATE-001. The PoC corpus
//   manifest is a separate artifact whose canonical home is the example directory it
//   documents. It is reproducible from `yakcc bootstrap` + this helper.
//
// This module is a READ-ONLY consumer of @yakcc/registry. It uses the public
// Registry interface exclusively — no direct SQLite access, no parallel storage
// reader (Sacred Practice #12, invariant I2 in the A1 Evaluation Contract).
//
// Production sequence:
//   1. `yakcc bootstrap` populates bootstrap/yakcc.registry.sqlite
//   2. Caller opens the registry via openRegistry() from @yakcc/registry
//   3. loadCorpusFromRegistry(registry) enumerates all atoms
//   4. Serialise corpus.atoms → corpus.manifest.json (sorted by blockMerkleRoot)
//
// Deferred: DEC-V2-CORPUS-DISTRIBUTION-001 (SQLite checked-in vs reproducible)
//   → A2's Evaluation Contract will close that DEC.
// Deferred: DEC-V2-COMPILE-SELF-EQ-001 (functional vs byte equivalence)
//   → A2/A3's Evaluation Contracts will close that DEC.

import type { BlockMerkleRoot } from "@yakcc/contracts";
import type { Registry } from "@yakcc/registry";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Discriminated kind for a corpus atom.
 *
 * - 'local'   — a yakcc-shaved block from the repo source tree
 * - 'foreign' — an opaque foreign npm/Node leaf block
 * - 'glue'    — any block whose kind field is absent or unrecognised
 *               (pre-migration-6 rows; treated as glue for corpus purposes)
 *
 * The 'glue' bucket is a forward-compatible catch-all. It should be empty
 * for fully-migrated registries but must not be omitted (I2 invariant:
 * skipping foreign-block enumeration is forbidden per the Evaluation Contract).
 */
export type AtomKind = "local" | "foreign" | "glue";

/**
 * One atom entry in the Corpus.
 *
 * blockMerkleRoot is always a 64-character lowercase hex string (the BLAKE3
 * content address of the full block triplet). packageName is the source
 * package for local atoms (derived from the foreignPkg field for foreign atoms,
 * or 'unknown' when unavailable). kind discriminates the three atom classes.
 */
export interface CorpusAtom {
  /** 64-char lowercase hex BLAKE3 content address. */
  readonly blockMerkleRoot: BlockMerkleRoot;
  /**
   * Package name for this atom.
   * - For 'foreign' atoms: the foreignPkg value (e.g. 'node:fs', 'ts-morph').
   * - For 'local'/'glue' atoms: 'unknown' (the registry does not store source
   *   package provenance; that mapping lives in bootstrap/expected-roots.json
   *   source paths, which A2 will cross-reference).
   */
  readonly packageName: string;
  /** Atom kind. */
  readonly kind: AtomKind;
}

/**
 * The full enumerated corpus from one registry snapshot.
 *
 * atoms is sorted ascending by blockMerkleRoot (determinism contract: same
 * registry state → same JSON serialisation on any machine).
 */
export interface Corpus {
  /** All atoms sorted ascending by blockMerkleRoot. */
  readonly atoms: readonly CorpusAtom[];
}

// ---------------------------------------------------------------------------
// loadCorpusFromRegistry
// ---------------------------------------------------------------------------

/**
 * Enumerate every atom in the given registry and return a deterministic Corpus.
 *
 * Uses the @yakcc/registry public API exclusively:
 *   - registry.exportManifest() to list all blockMerkleRoots
 *   - registry.getBlock(root) to hydrate the kind/foreignPkg fields
 *
 * The registry must already be open. The caller owns the lifecycle (open/close).
 * This function is read-only: it never calls storeBlock or any mutating method.
 *
 * Determinism contract: calling this function twice on the same open registry
 * in the same process always returns a byte-identical JSON serialisation when
 * the result is passed through JSON.stringify with the same replacer/space.
 *
 * Fails loudly if the registry cannot be enumerated (Sacred Practice #5).
 *
 * @param registry - An open Registry handle from openRegistry().
 * @returns Promise<Corpus> — all atoms sorted ascending by blockMerkleRoot.
 */
export async function loadCorpusFromRegistry(registry: Registry): Promise<Corpus> {
  // Step 1: enumerate all blockMerkleRoots via exportManifest().
  // exportManifest() is the stable public enumeration primitive — it returns
  // every stored block sorted by blockMerkleRoot ASC (the load-bearing
  // determinism contract for DEC-V2-BOOTSTRAP-MANIFEST-001).
  const manifestEntries = await registry.exportManifest();

  // Step 2: hydrate kind and foreignPkg for each entry.
  // We must NOT skip foreign blocks (Evaluation Contract forbidden shortcut F2:
  // "Bypassing @yakcc/registry and reading the SQLite file directly" is forbidden;
  // skipping foreign-block enumeration would be equivalent in effect).
  const atoms: CorpusAtom[] = [];

  for (const entry of manifestEntries) {
    const block = await registry.getBlock(entry.blockMerkleRoot);

    // getBlock() returns null only when the block is absent — this should never
    // happen here because we're iterating exportManifest()'s output, but we fail
    // loudly if it does (Sacred Practice #5: no silent fallback).
    if (block === null) {
      throw new Error(
        `loadCorpusFromRegistry: registry inconsistency — exportManifest() listed blockMerkleRoot ${entry.blockMerkleRoot} but getBlock() returned null. This indicates a corrupted or concurrently-modified registry.`,
      );
    }

    // Map kind field to AtomKind.
    // 'kind' may be undefined for pre-migration-6 rows (they have no kind column
    // value in older registries); treat those as 'glue' per the type contract.
    let kind: AtomKind;
    if (block.kind === "local") {
      kind = "local";
    } else if (block.kind === "foreign") {
      kind = "foreign";
    } else {
      // Includes undefined (pre-migration-6) and any future unrecognised value.
      kind = "glue";
    }

    // Derive packageName:
    // - foreign atoms: use foreignPkg (always non-null for kind='foreign' per L2-I3)
    // - local/glue atoms: 'unknown' (source package mapping is not stored in the
    //   blocks table; A2 will cross-reference expected-roots.json source paths)
    const packageName =
      kind === "foreign" && block.foreignPkg != null ? block.foreignPkg : "unknown";

    atoms.push({
      blockMerkleRoot: entry.blockMerkleRoot,
      packageName,
      kind,
    });
  }

  // Step 3: sort ascending by blockMerkleRoot.
  // exportManifest() already returns entries in this order, but we re-sort to
  // make the determinism contract explicit and robust to future API changes.
  atoms.sort((a, b) => a.blockMerkleRoot.localeCompare(b.blockMerkleRoot));

  return { atoms };
}
