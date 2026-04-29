// @decision DEC-CLI-COMPILE-001: compile command reads the entry as either a 64-hex
// ContractId, a path to a JSON ContractSpec file, or a directory path. When a directory
// is given, it resolves to <dir>/contract.json and defaults --out to <dir>/dist. When a
// file path is given, contractId() derives the id from the spec. The assembled artifact
// is written to <out>/module.ts and <out>/manifest.json. assemble() receives
// knownContractIds from seedRegistry so the pre-scan can build the full stem index before
// DFS traversal.
// Status: updated (WI-009) — added directory path support for examples/
// Rationale: The directory form lets callers say `yakcc compile examples/parse-int-list`
// rather than `yakcc compile examples/parse-int-list/contract.json --out examples/parse-int-list/dist`,
// which matches the documented 15-minute path in the README.

import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { type Artifact, assemble } from "@yakcc/compile";
import {
  type ContractId,
  type ContractSpec,
  contractId,
  isValidContractId,
} from "@yakcc/contracts";
import { type Registry, openRegistry } from "@yakcc/registry";
import { seedRegistry } from "@yakcc/seeds";
import type { Logger } from "../index.js";
import { DEFAULT_REGISTRY_PATH } from "./registry-init.js";

/**
 * Handler for `yakcc compile <entry> [--registry <p>] [--out <dir>]`.
 *
 * <entry> is a ContractId (64-hex string) or a path to a JSON ContractSpec file.
 * Writes <out>/module.ts and <out>/manifest.json.
 *
 * @param argv - Remaining argv after `compile` has been consumed (includes the positional).
 * @param logger - Output sink; defaults to console via the caller.
 * @returns Process exit code (0 = success, 1 = error).
 */
export async function compile(argv: readonly string[], logger: Logger): Promise<number> {
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
      "error: compile requires an <entry> argument (ContractId, spec file, or directory)",
    );
    return 1;
  }

  const registryPath = values.registry ?? DEFAULT_REGISTRY_PATH;

  // Resolve the spec file path and output directory.
  // If entryArg is a directory, look for contract.json inside it and default
  // --out to <dir>/dist. Otherwise treat it as a spec file (or ContractId).
  let specFilePath: string | null = null;
  let outDir: string;

  if (!isValidContractId(entryArg)) {
    // Check whether the arg is a directory.
    let isDir = false;
    try {
      isDir = statSync(entryArg).isDirectory();
    } catch {
      // stat failed — not a directory (or doesn't exist); fall through to file path handling.
    }

    if (isDir) {
      specFilePath = join(entryArg, "contract.json");
      outDir = values.out ?? join(entryArg, "dist");
    } else {
      specFilePath = entryArg;
      outDir = values.out ?? "./yakcc-out";
    }
  } else {
    outDir = values.out ?? "./yakcc-out";
  }

  // Resolve the entry ContractId.
  let entryId: ContractId;
  if (isValidContractId(entryArg)) {
    entryId = entryArg as ContractId;
  } else {
    // Treat as a path to a JSON ContractSpec file (or resolved from directory above).
    const resolvedPath = specFilePath ?? entryArg;
    let specJson: string;
    try {
      specJson = readFileSync(resolvedPath, "utf-8");
    } catch (err) {
      logger.error(`error: cannot read spec file ${resolvedPath}: ${String(err)}`);
      return 1;
    }
    let spec: ContractSpec;
    try {
      spec = JSON.parse(specJson) as ContractSpec;
    } catch (err) {
      logger.error(`error: invalid JSON in spec file ${resolvedPath}: ${String(err)}`);
      return 1;
    }
    entryId = contractId(spec);
  }

  // Open the registry.
  let registry: Registry;
  try {
    registry = await openRegistry(registryPath);
  } catch (err) {
    logger.error(`error: failed to open registry at ${registryPath}: ${String(err)}`);
    return 1;
  }

  try {
    // Seed the registry and collect all contractIds for the pre-scan stem index.
    // seedRegistry is idempotent (INSERT OR IGNORE), so running it on an already-
    // seeded registry is safe and produces consistent knownContractIds.
    const seedResult = await seedRegistry(registry);

    // Assemble the artifact.
    let artifact: Artifact;
    try {
      artifact = await assemble(entryId, registry, undefined, {
        knownContractIds: seedResult.contractIds,
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
