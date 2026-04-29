// @decision DEC-CLI-SEARCH-001: search accepts either a path to a JSON ContractSpec file
// (search by spec) or free text (search by behavior string with other fields stubbed).
// Results are printed as "<contractId>  score=<float>  behavior=<truncated-80>" lines.
// Status: implemented (WI-007)
// Rationale: registry.search() takes a ContractSpec, not a raw string. For free-text
// queries, a minimal spec with behavior=<query> and sensible defaults for required fields
// provides a useful semantic search without requiring a full spec authoring step.

import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import type { ContractSpec } from "@yakcc/contracts";
import { type Registry, openRegistry } from "@yakcc/registry";
import type { Logger } from "../index.js";
import { DEFAULT_REGISTRY_PATH } from "./registry-init.js";

/** Stub non-functional properties used for free-text search queries. */
const FREE_TEXT_SPEC_DEFAULTS: Pick<
  ContractSpec,
  "inputs" | "outputs" | "guarantees" | "errorConditions" | "nonFunctional" | "propertyTests"
> = {
  inputs: [],
  outputs: [],
  guarantees: [],
  errorConditions: [],
  nonFunctional: { purity: "pure", threadSafety: "safe" },
  propertyTests: [],
};

/**
 * Truncate a string to at most `max` characters, appending "…" if truncated.
 */
function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

/**
 * Handler for `yakcc search <query> [--registry <p>] [--top <k>]`.
 *
 * <query> is either a path to a JSON ContractSpec file or a free-text behavior string.
 * Prints top-K results as "<contractId>  score=<float>  behavior=<truncated>" lines.
 *
 * @param argv - Remaining argv after `search` has been consumed (includes the positional).
 * @param logger - Output sink; defaults to console via the caller.
 * @returns Process exit code (0 = success, 1 = error).
 */
export async function search(argv: readonly string[], logger: Logger): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...argv],
    options: {
      registry: { type: "string", short: "r" },
      top: { type: "string", short: "k" },
    },
    allowPositionals: true,
    strict: true,
  });

  const query = positionals[0];
  if (query === undefined || query === "") {
    logger.error("error: search requires a <query> argument (spec file path or free text)");
    return 1;
  }

  const registryPath = values.registry ?? DEFAULT_REGISTRY_PATH;
  const topRaw = values.top ?? "10";
  const top = Number.parseInt(topRaw, 10);
  if (Number.isNaN(top) || top < 1) {
    logger.error(`error: --top must be a positive integer, got: ${topRaw}`);
    return 1;
  }

  // Resolve the query to a ContractSpec.
  let spec: ContractSpec;

  // Heuristic: if the query ends with .json or looks like a file path, treat as spec file.
  const looksLikePath = query.endsWith(".json") || query.startsWith("./") || query.startsWith("/");

  if (looksLikePath) {
    let specJson: string;
    try {
      specJson = readFileSync(query, "utf-8");
    } catch (err) {
      logger.error(`error: cannot read spec file ${query}: ${String(err)}`);
      return 1;
    }
    try {
      spec = JSON.parse(specJson) as ContractSpec;
    } catch (err) {
      logger.error(`error: invalid JSON in spec file ${query}: ${String(err)}`);
      return 1;
    }
  } else {
    // Free text — construct a minimal spec with behavior=<query>.
    spec = { ...FREE_TEXT_SPEC_DEFAULTS, behavior: query };
  }

  // Open the registry and run the search.
  let registry: Registry;
  try {
    registry = await openRegistry(registryPath);
  } catch (err) {
    logger.error(`error: failed to open registry at ${registryPath}: ${String(err)}`);
    return 1;
  }

  try {
    const candidates = await registry.search(spec, top);

    if (candidates.length === 0) {
      logger.log("no results found");
      return 0;
    }

    for (const candidate of candidates) {
      const { contract, score } = candidate.match;
      const behavior = truncate(contract.spec.behavior, 80);
      const scoreStr = score.toFixed(4);
      logger.log(`${contract.id}  score=${scoreStr}  behavior=${behavior}`);
    }

    return 0;
  } finally {
    await registry.close();
  }
}
