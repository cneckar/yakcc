// SPDX-License-Identifier: MIT
// @decision DEC-CLI-COMPILE-001: compile command reads the entry as either a BlockMerkleRoot
// (64-hex string), a path to a JSON SpecYak file, or a directory path. When a directory
// is given, it resolves to <dir>/spec.yak and defaults --out to <dir>/dist. When a
// spec file path is given, specHash() derives the specHash, selectBlocks() fetches all
// satisfying BlockMerkleRoots, and the first is used as the entry. The assembled artifact
// is written to <out>/module.ts and <out>/manifest.json. assemble() receives
// knownMerkleRoots from seedRegistry so the pre-scan can build the full stem index before
// DFS traversal.
// Status: updated (WI-T06)
// Rationale: WI-T06 migrated the demo from contract.json to spec.yak (triplet shape).
// The directory resolver now looks for spec.yak exclusively — contract.json is deleted
// (Sacred Practice #12: no parallel mechanisms, DEC-WI009-SUBSUMED-021).
// WI-T03/T04 migrated the compile/registry API from ContractId to BlockMerkleRoot.
// The entry resolution calls selectBlocks(specHash) to find the matching BlockMerkleRoot.

import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { type Artifact, assemble } from "@yakcc/compile";
import { type BlockMerkleRoot, type SpecYak, specHash } from "@yakcc/contracts";
import { type Registry, type RegistryOptions, openRegistry } from "@yakcc/registry";
import { seedRegistry } from "@yakcc/seeds";
import type { Logger } from "../index.js";
import { DEFAULT_REGISTRY_PATH } from "./registry-init.js";

/** A 64-hex string that may be a BlockMerkleRoot. */
function isHex64(s: string): boolean {
  return /^[0-9a-f]{64}$/i.test(s);
}

/** Internal options for compile. Tests inject embeddings to avoid network I/O. */
export interface CompileOptions {
  embeddings?: RegistryOptions["embeddings"];
}

/**
 * Handler for `yakcc compile <entry> [--registry <p>] [--out <dir>]`.
 *
 * <entry> is a BlockMerkleRoot (64-hex string), a path to a JSON SpecYak file,
 * or a directory path containing spec.yak.
 * Writes <out>/module.ts and <out>/manifest.json.
 *
 * @param argv - Remaining argv after `compile` has been consumed (includes the positional).
 * @param logger - Output sink; defaults to console via the caller.
 * @param opts - Internal options (embeddings for test injection).
 * @returns Process exit code (0 = success, 1 = error).
 */
export async function compile(argv: readonly string[], logger: Logger, opts?: CompileOptions): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...argv],
    options: {
      registry: { type: "string", short: "r" },
      out: { type: "string", short: "o" },
    },
    allowPositionals: true,
    strict: true,
  });

  const entryArg = positionals[0];
  if (entryArg === undefined || entryArg === "") {
    logger.error(
      "error: compile requires an <entry> argument (BlockMerkleRoot, spec file, or directory)",
    );
    return 1;
  }

  const registryPath = values.registry ?? DEFAULT_REGISTRY_PATH;

  // Resolve the spec file path and output directory.
  // If entryArg is a directory, look for spec.yak inside it and default
  // --out to <dir>/dist. Otherwise treat it as a spec file (or BlockMerkleRoot).
  let specFilePath: string | null = null;
  let outDir: string;

  if (!isHex64(entryArg)) {
    // Check whether the arg is a directory.
    let isDir = false;
    try {
      isDir = statSync(entryArg).isDirectory();
    } catch {
      // stat failed — not a directory (or doesn't exist); fall through to file path handling.
    }

    if (isDir) {
      specFilePath = join(entryArg, "spec.yak");
      outDir = values.out ?? join(entryArg, "dist");
    } else {
      specFilePath = entryArg;
      outDir = values.out ?? "./yakcc-out";
    }
  } else {
    outDir = values.out ?? "./yakcc-out";
  }

  // Open the registry.
  let registry: Registry;
  try {
    registry = await openRegistry(registryPath, { embeddings: opts?.embeddings });
  } catch (err) {
    logger.error(`error: failed to open registry at ${registryPath}: ${String(err)}`);
    return 1;
  }

  try {
    // Seed the registry and collect all merkle roots for the pre-scan stem index.
    // seedRegistry is idempotent (INSERT OR IGNORE), so running it on an already-
    // seeded registry is safe and produces consistent knownMerkleRoots.
    const seedResult = await seedRegistry(registry);

    // Resolve the entry BlockMerkleRoot.
    let entryRoot: BlockMerkleRoot;
    if (isHex64(entryArg)) {
      // Treat as a BlockMerkleRoot directly.
      entryRoot = entryArg as BlockMerkleRoot;
    } else {
      // Treat as a path to a JSON SpecYak file (or resolved from directory above).
      const resolvedPath = specFilePath ?? entryArg;
      let specJson: string;
      try {
        specJson = readFileSync(resolvedPath, "utf-8");
      } catch (err) {
        logger.error(`error: cannot read spec file ${resolvedPath}: ${String(err)}`);
        return 1;
      }
      let spec: SpecYak;
      try {
        spec = JSON.parse(specJson) as SpecYak;
      } catch (err) {
        logger.error(`error: invalid JSON in spec file ${resolvedPath}: ${String(err)}`);
        return 1;
      }
      const hash = specHash(spec);
      const roots = await registry.selectBlocks(hash);
      if (roots.length === 0) {
        logger.error(`error: no block found for spec in ${resolvedPath} (specHash=${hash})`);
        return 1;
      }
      entryRoot = roots[0] as BlockMerkleRoot;
    }

    // Assemble the artifact.
    let artifact: Artifact;
    try {
      artifact = await assemble(entryRoot, registry, undefined, {
        knownMerkleRoots: seedResult.merkleRoots,
      });
    } catch (err) {
      logger.error(`error: assembly failed: ${String(err)}`);
      return 1;
    }

    // Write output files.
    mkdirSync(outDir, { recursive: true });
    const modulePath = join(outDir, "module.ts");
    const manifestPath = join(outDir, "manifest.json");
    writeFileSync(modulePath, artifact.source, "utf-8");
    writeFileSync(manifestPath, JSON.stringify(artifact.manifest, null, 2), "utf-8");

    const blockCount = artifact.manifest.entries.length;
    logger.log(`compiled ${blockCount} blocks → ${modulePath}; manifest at ${manifestPath}`);
    return 0;
  } finally {
    await registry.close();
  }
}
