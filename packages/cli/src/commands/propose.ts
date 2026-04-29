// @decision DEC-CLI-PROPOSE-001: propose reads a JSON ContractSpec file, derives its
// content-address, then calls registry.match() for exact lookup. On hit: prints the
// matched id and exits 0. On miss: prints the contract id plus a manual-authoring
// template instructing the caller to author the block and register it. Both paths exit 0.
// Status: implemented (WI-007)
// Rationale: v0 has no AI synthesis; an unmatched proposal kicks the manual-authoring
// flow (DEC-V0-SYNTH-003). The printed template gives the contract id and next-step
// guidance without fabricating a placeholder body.

import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { type ContractSpec, contractId } from "@yakcc/contracts";
import { type Registry, openRegistry } from "@yakcc/registry";
import type { Logger } from "../index.js";
import { DEFAULT_REGISTRY_PATH } from "./registry-init.js";

/**
 * Handler for `yakcc propose <contract-file> [--registry <p>]`.
 *
 * Reads a JSON ContractSpec, derives its ContractId, and checks the registry for
 * an exact match. Prints either `match: <id>` or a manual-authoring template.
 *
 * @param argv - Remaining argv after `propose` has been consumed (includes the positional).
 * @param logger - Output sink; defaults to console via the caller.
 * @returns Process exit code (0 = success, 1 = error).
 */
export async function propose(argv: readonly string[], logger: Logger): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...argv],
    options: {
      registry: { type: "string", short: "r" },
    },
    allowPositionals: true,
    strict: true,
  });

  const specFilePath = positionals[0];
  if (specFilePath === undefined || specFilePath === "") {
    logger.error("error: propose requires a <contract-file> argument");
    return 1;
  }

  const registryPath = values.registry ?? DEFAULT_REGISTRY_PATH;

  // Read and parse the contract spec file.
  let specJson: string;
  try {
    specJson = readFileSync(specFilePath, "utf-8");
  } catch (err) {
    logger.error(`error: cannot read spec file ${specFilePath}: ${String(err)}`);
    return 1;
  }

  let spec: ContractSpec;
  try {
    spec = JSON.parse(specJson) as ContractSpec;
  } catch (err) {
    logger.error(`error: invalid JSON in spec file ${specFilePath}: ${String(err)}`);
    return 1;
  }

  const id = contractId(spec);

  // Open the registry and check for a match.
  let registry: Registry;
  try {
    registry = await openRegistry(registryPath);
  } catch (err) {
    logger.error(`error: failed to open registry at ${registryPath}: ${String(err)}`);
    return 1;
  }

  try {
    const matchResult = await registry.match(spec);

    if (matchResult !== null) {
      logger.log(`match: ${matchResult.contract.id}`);
      return 0;
    }

    // No match — print a manual-authoring template.
    logger.log(`no match found for contract ${id}`);
    logger.log("");
    logger.log("contract spec:");
    logger.log(JSON.stringify(spec, null, 2));
    logger.log("");
    logger.log(
      "To register an implementation, author a strict-TypeScript block with a CONTRACT export",
    );
    logger.log(
      `matching the spec above, then run: yakcc block author <impl-file> --contract ${id}`,
    );
    return 0;
  } finally {
    await registry.close();
  }
}
