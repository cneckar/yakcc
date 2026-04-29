// @decision DEC-CLI-COMPILE-001: compile command reads the entry as either a 64-hex
// ContractId or a path to a JSON ContractSpec file. When a path is given, contractId()
// derives the id from the spec. The assembled artifact is written to <out>/module.ts
// and <out>/manifest.json. assemble() receives knownContractIds from seedRegistry so
// the pre-scan can build the full stem index before DFS traversal.
// Status: implemented (WI-007)
// Rationale: The compile engine requires knownContractIds to resolve relative sub-block
// imports (DEC-COMPILE-ASSEMBLE-001). The CLI seeds the registry and passes the resulting
// contractIds as AssembleOptions.knownContractIds — mirroring the pattern in assemble.test.ts.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
    logger.error("error: compile requires an <entry> argument (ContractId or spec file path)");
    return 1;
  }

  const registryPath = values.registry ?? DEFAULT_REGISTRY_PATH;
  const outDir = values.out ?? "./yakcc-out";

  // Resolve the entry ContractId.
  let entryId: ContractId;
  if (isValidContractId(entryArg)) {
    entryId = entryArg as ContractId;
  } else {
    // Treat as a path to a JSON ContractSpec file.
    let specJson: string;
    try {
      specJson = readFileSync(entryArg, "utf-8");
    } catch (err) {
      logger.error(`error: cannot read spec file ${entryArg}: ${String(err)}`);
      return 1;
    }
    let spec: ContractSpec;
    try {
      spec = JSON.parse(specJson) as ContractSpec;
    } catch (err) {
      logger.error(`error: invalid JSON in spec file ${entryArg}: ${String(err)}`);
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
