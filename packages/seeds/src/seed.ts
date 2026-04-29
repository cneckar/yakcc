// @decision DEC-SEEDS-LOADER-001: seedRegistry reads block .ts source files from disk at runtime.
// Status: implemented (WI-006)
// Rationale: The source text of each block is needed to compute the blockId (BLAKE3 of source
// bytes) and to pass to parseBlock for validation. Reading the .ts files directly avoids
// maintaining a separate source-string constant in each block file (which biome rejects as
// noUnusedTemplateLiteral and is duplicative). The seed package is always invoked in a context
// where the source tree is present (tests via vitest, CLI via ts-node or tsx). Post-build
// dist-only invocation is not a v0 requirement.
//
// @decision DEC-SEEDS-BLOCKID-001: blockId is BLAKE3 over the raw source bytes, computed by
// @yakcc/registry's internal storage module. We derive it identically here via contractIdFromBytes
// applied to the source bytes so the Implementation record's blockId is consistent with what
// the registry would compute on store.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type Contract,
  type ContractId,
  contractIdFromBytes,
  contractId as deriveContractId,
} from "@yakcc/contracts";
import { parseBlock } from "@yakcc/ir";
import type { Implementation, Registry } from "@yakcc/registry";

// ---------------------------------------------------------------------------
// Block source file registry
// Each entry maps a block name to its .ts filename in src/blocks/.
// ---------------------------------------------------------------------------

const BLOCK_FILES = [
  "ascii-char.ts",
  "ascii-digit-set.ts",
  "bracket.ts",
  "char-code.ts",
  "comma.ts",
  "comma-separated-integers.ts",
  "digit.ts",
  "digit-or-throw.ts",
  "empty-list-content.ts",
  "eof-check.ts",
  "integer.ts",
  "list-of-ints.ts",
  "non-ascii-rejector.ts",
  "nonempty-list-content.ts",
  "optional-whitespace.ts",
  "peek-char.ts",
  "position-step.ts",
  "signed-integer.ts",
  "string-from-position.ts",
  "whitespace.ts",
] as const;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface SeedResult {
  readonly stored: number;
  readonly contractIds: ReadonlyArray<ContractId>;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Derive a blockId (hex string) from raw UTF-8 source bytes. Mirrors registry/storage.ts#implId. */
function blockIdFromSource(source: string): string {
  const bytes = new TextEncoder().encode(source);
  return contractIdFromBytes(bytes);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Seed a Registry with all blocks in the seed corpus.
 *
 * For each block:
 * 1. Reads the .ts source file from packages/seeds/src/blocks/.
 * 2. Parses and validates it via @yakcc/ir parseBlock.
 * 3. Derives the Contract (id from spec, empty evidence).
 * 4. Derives the Implementation (blockId from source bytes).
 * 5. Stores both in the registry.
 *
 * Returns the total stored count and the list of ContractIds in block-file order.
 *
 * @throws Error if any block source file is missing or fails strict-subset validation.
 */
export async function seedRegistry(registry: Registry): Promise<SeedResult> {
  // Resolve the blocks directory relative to this source file.
  // import.meta.url points to seed.ts (or seed.js post-build).
  // In both cases, ../blocks/ is the correct relative path.
  const blocksDir = join(dirname(fileURLToPath(import.meta.url)), "blocks");

  const contractIds: ContractId[] = [];
  let stored = 0;

  for (const filename of BLOCK_FILES) {
    const filePath = join(blocksDir, filename);
    const source = readFileSync(filePath, "utf-8");

    // blockPatterns: ["./"] enables extractComposition to recognise relative sibling
    // imports (import type { X } from "./sub-block.js") as sub-block composition
    // references, populating the provenance manifest without requiring the full
    // @yakcc/seeds/ package prefix that is unusable from within the package itself.
    const block = parseBlock(source, { blockPatterns: ["./"] });

    if (!block.validation.ok) {
      const msgs = block.validation.errors.map((e) => `${e.rule}: ${e.message}`).join("; ");
      throw new Error(`Block ${filename} failed strict-subset validation: ${msgs}`);
    }

    if (block.contractSpec === null || block.contract === null) {
      throw new Error(`Block ${filename} has no CONTRACT export`);
    }

    const contractId = block.contract;
    const evidenceId = deriveContractId(block.contractSpec); // re-derive via canonical serialization

    if (evidenceId !== contractId) {
      throw new Error(
        `Block ${filename}: contractId mismatch — derived ${contractId} vs re-derived ${evidenceId}`,
      );
    }

    const contract: Contract = {
      id: contractId,
      spec: block.contractSpec,
      evidence: { testHistory: [] },
    };

    const impl: Implementation = {
      source,
      blockId: blockIdFromSource(source),
      contractId,
    };

    await registry.store(contract, impl);
    contractIds.push(contractId);
    stored++;
  }

  return { stored, contractIds };
}
