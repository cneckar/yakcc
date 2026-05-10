// SPDX-License-Identifier: MIT
// @decision DEC-CLI-PROPOSE-001: propose reads a JSON SpecYak file, derives its
// specHash, then calls registry.selectBlocks(specHash) for exact lookup. On hit:
// prints the matched merkle root and exits 0. On miss: prints a manual-authoring
// template. Both paths exit 0.
// Status: updated (WI-T05)
// Rationale: WI-T03 removed registry.match() and ContractId. The exact-match path
// now uses specHash() + selectBlocks() — the canonical T03 lookup API.
// v0 has no AI synthesis; an unmatched proposal kicks the manual-authoring
// flow (DEC-V0-SYNTH-003).

import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { type SpecYak, specHash } from "@yakcc/contracts";
import { type Registry, openRegistry } from "@yakcc/registry";
import type { Logger } from "../index.js";
import { DEFAULT_REGISTRY_PATH } from "./registry-init.js";

/**
 * Handler for `yakcc propose <spec-file> [--registry <p>]`.
 *
 * Reads a JSON SpecYak, derives its specHash, and checks the registry for
 * an exact match via selectBlocks. Prints either `match: <merkleRoot>` or a
 * manual-authoring template.
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

  // Read and parse the spec file.
  let specJson: string;
  try {
    specJson = readFileSync(specFilePath, "utf-8");
  } catch (err) {
    logger.error(`error: cannot read spec file ${specFilePath}: ${String(err)}`);
    return 1;
  }

  let spec: SpecYak;
  try {
    spec = JSON.parse(specJson) as SpecYak;
  } catch (err) {
    logger.error(`error: invalid JSON in spec file ${specFilePath}: ${String(err)}`);
    return 1;
  }

  const hash = specHash(spec);

  // Open the registry and check for a match.
  let registry: Registry;
  try {
    registry = await openRegistry(registryPath);
  } catch (err) {
    logger.error(`error: failed to open registry at ${registryPath}: ${String(err)}`);
    return 1;
  }

  try {
    const roots = await registry.selectBlocks(hash);

    if (roots.length > 0) {
      // Return the best matching block (first in selection order).
      logger.log(`match: ${roots[0]}`);
      return 0;
    }

    // No match — print a manual-authoring template.
    logger.log(`no match found for contract ${hash}`);
    logger.log("");
    logger.log("spec:");
    logger.log(JSON.stringify(spec, null, 2));
    logger.log("");
    logger.log("To register an implementation, author a block triplet (spec.yak, impl.ts, proof/)");
    logger.log("matching the spec above, then seed the registry.");
    return 0;
  } finally {
    await registry.close();
  }
}
