// @decision DEC-SEEDS-LOADER-T05-001: seedRegistry enumerates block directories.
// Status: implemented (WI-T05)
// Rationale: WI-T05 migrates each block from a single .ts file with an embedded
// CONTRACT literal to a directory triplet (spec.yak, impl.ts, proof/). The
// BLOCK_FILES hand-maintained list is replaced by directory enumeration via
// readdirSync (Sacred Practice #12 — no parallel mechanism). Each directory is
// parsed via parseBlockTriplet from @yakcc/ir, which validates spec.yak, runs
// the strict-subset validator on impl.ts, and derives the BlockMerkleRoot.
// The result is stored via registry.storeBlock(row: BlockTripletRow).
//
// @decision DEC-SEEDS-STOREBLOCK-T05-002: seedRegistry builds BlockTripletRow
// from BlockTripletParseResult for storeBlock.
// Status: implemented (WI-T05)
// Rationale: storeBlock requires specCanonicalBytes (BLAKE3(canonicalize(spec))),
// specHash (derived by parseBlockTriplet as specHashValue), implSource, and
// proofManifestJson. All are available from BlockTripletParseResult. The
// canonicalize() function from @yakcc/contracts is used to compute the canonical
// bytes; this matches how the registry's storeBlock() internally verifies integrity.
// createdAt is set to 0 so the registry uses Date.now() (DEC-STORAGE-IDEMPOTENT-001).

import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type BlockMerkleRoot,
  type CanonicalAstHash,
  type SpecHash,
  canonicalAstHash,
  canonicalize,
} from "@yakcc/contracts";
import { parseBlockTriplet } from "@yakcc/ir";
import type { BlockTripletRow, Registry } from "@yakcc/registry";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface SeedResult {
  readonly stored: number;
  readonly merkleRoots: ReadonlyArray<BlockMerkleRoot>;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Seed a Registry with all blocks in the seed corpus.
 *
 * Enumerates directories under packages/seeds/src/blocks/, calls
 * parseBlockTriplet on each, then stores the result via registry.storeBlock.
 *
 * For each block directory:
 * 1. parseBlockTriplet reads spec.yak, impl.ts, proof/manifest.json.
 * 2. Validates spec.yak via validateSpecYak (throws TypeError on failure).
 * 3. Runs the strict-subset validator on impl.ts (result.validation.ok).
 * 4. Builds a BlockTripletRow with blockMerkleRoot, specHash, specCanonicalBytes,
 *    implSource, proofManifestJson, level, and createdAt=0.
 * 5. Calls registry.storeBlock(row) — idempotent (INSERT OR IGNORE).
 *
 * Returns stored count and the list of BlockMerkleRoots in directory order.
 *
 * @throws Error if any block directory fails spec validation, strict-subset
 *   validation, or has a missing/malformed proof/manifest.json.
 */
export async function seedRegistry(registry: Registry): Promise<SeedResult> {
  const blocksDir = join(dirname(fileURLToPath(import.meta.url)), "blocks");

  // Enumerate block directories (directories only, sorted for determinism)
  const entries = readdirSync(blocksDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();

  const merkleRoots: BlockMerkleRoot[] = [];
  let stored = 0;

  for (const name of entries) {
    const blockDir = join(blocksDir, name);

    // Parse the triplet (reads spec.yak, impl.ts, proof/manifest.json, artifact bytes).
    // No extra blockPatterns needed: the @yakcc/ir isBlockImport builtin already
    // recognises "@yakcc/seeds/" as a block-import prefix, and composition imports
    // in impl.ts files use "@yakcc/seeds/blocks/<name>" (WI-T05-fix).
    const result = parseBlockTriplet(blockDir);

    if (!result.validation.ok) {
      const msgs = result.validation.errors.map((e) => `${e.rule}: ${e.message}`).join("; ");
      throw new Error(`Block ${name} failed strict-subset validation: ${msgs}`);
    }

    // Build specCanonicalBytes: BLAKE3(canonicalize(spec.yak)) — matches what
    // storeBlock uses internally for embedding and integrity verification.
    const specCanonicalBytes = canonicalize(
      result.spec as unknown as Parameters<typeof canonicalize>[0],
    );

    const row: BlockTripletRow = {
      blockMerkleRoot: result.merkleRoot,
      specHash: result.specHashValue as SpecHash,
      specCanonicalBytes,
      implSource: result.implSource,
      proofManifestJson: JSON.stringify(result.manifest),
      level: result.spec.level,
      // createdAt=0 signals the registry to use Date.now() (DEC-STORAGE-IDEMPOTENT-001)
      createdAt: 0,
      // canonicalAstHash is the content-address of the implementation AST,
      // used for cross-spec reuse detection (DEC-REGISTRY-CANONICAL-AST-HASH-001).
      canonicalAstHash: canonicalAstHash(result.implSource) as CanonicalAstHash,
      // artifact bytes parsed from proof/ by parseBlockTriplet — required by
      // BlockTripletRow (DEC-V1-FEDERATION-WIRE-ARTIFACTS-002).
      artifacts: result.artifacts,
    };

    await registry.storeBlock(row);
    merkleRoots.push(result.merkleRoot);
    stored++;
  }

  return { stored, merkleRoots };
}
