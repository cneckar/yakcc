// SPDX-License-Identifier: MIT
// @decision DEC-CLI-SEARCH-001: search accepts either a path to a JSON SpecYak file
// (search by spec) or free text (search by behavior string with other fields stubbed).
// Results are printed as "<merkleRoot[:8]>  score=<float>  behavior=<truncated-80>" lines.
// Status: updated (WI-T05)
// Rationale: WI-T03 removed registry.search() and the ContractSpec-based vector search.
// The search command now uses seedRegistry() to enumerate all corpus blocks, calls
// structuralMatch(query, candidate) for each, and returns top-K by score. This is a
// linear scan over the seed corpus (20 blocks); acceptable for v0.6 scope.
// The v0 has no embedding-based search; a corpus-scan with structural scoring
// is the correct minimal implementation (DEC-V0-SYNTH-003).

import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { parseGranularity } from "@yakcc/contracts";
import type { SpecYak } from "@yakcc/contracts";
import { type RegistryOptions, openRegistry, structuralMatch } from "@yakcc/registry";
import { seedRegistry } from "@yakcc/seeds";
import type { Logger } from "../index.js";
import { DEFAULT_REGISTRY_PATH } from "./registry-init.js";

/** Internal options for search — not exposed in CLI args. */
export interface SearchOptions {
  embeddings?: RegistryOptions["embeddings"];
}

/** Stub non-functional properties used for free-text search queries. */
const FREE_TEXT_SPEC_DEFAULTS: Partial<SpecYak> = {
  inputs: [],
  outputs: [],
  preconditions: [],
  postconditions: [],
  invariants: [],
  effects: [],
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
 * <query> is either a path to a JSON SpecYak file or a free-text behavior string.
 * Prints top-K results as "<merkleRoot[:8]>  score=<float>  behavior=<truncated>" lines.
 *
 * @param argv - Remaining argv after `search` has been consumed (includes the positional).
 * @param logger - Output sink; defaults to console via the caller.
 * @returns Process exit code (0 = success, 1 = error).
 */
export async function search(
  argv: readonly string[],
  logger: Logger,
  opts?: SearchOptions,
): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...argv],
    options: {
      registry: { type: "string", short: "r" },
      top: { type: "string", short: "k" },
      granularity: { type: "string", short: "g" },
    },
    allowPositionals: true,
    strict: true,
  });

  const query = positionals[0];
  if (query === undefined || query === "") {
    logger.error("error: search requires a <query> argument (spec file path or free text)");
    return 1;
  }

  const granularityRaw = values.granularity;
  if (granularityRaw !== undefined && parseGranularity(granularityRaw) === null) {
    logger.error(
      `error: --granularity must be an integer between 1 and 5 (got ${JSON.stringify(granularityRaw)})`,
    );
    return 1;
  }

  const registryPath = values.registry ?? DEFAULT_REGISTRY_PATH;
  const topRaw = values.top ?? "10";
  const top = Number.parseInt(topRaw, 10);
  if (Number.isNaN(top) || top < 1) {
    logger.error(`error: --top must be a positive integer, got: ${topRaw}`);
    return 1;
  }

  // Resolve the query to a SpecYak.
  let querySpec: SpecYak;

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
      querySpec = JSON.parse(specJson) as SpecYak;
    } catch (err) {
      logger.error(`error: invalid JSON in spec file ${query}: ${String(err)}`);
      return 1;
    }
  } else {
    // Free text — construct a minimal spec with behavior=<query>.
    querySpec = {
      ...FREE_TEXT_SPEC_DEFAULTS,
      behavior: query,
      name: "query",
      level: "L0",
    } as SpecYak;
  }

  // Open the registry, seed it, then scan all corpus blocks for structural matches.
  const registry = await openRegistry(registryPath, { embeddings: opts?.embeddings }).catch(
    (err: unknown) => {
      logger.error(`error: failed to open registry at ${registryPath}: ${String(err)}`);
      return null;
    },
  );
  if (registry === null) return 1;

  try {
    const seedResult = await seedRegistry(registry);

    // Score each block's spec against the query spec using structuralMatch.
    const scored: Array<{ root: string; score: number; behavior: string }> = [];
    for (const merkleRoot of seedResult.merkleRoots) {
      const row = await registry.getBlock(merkleRoot);
      if (row === null) continue;
      // Parse the spec from canonical bytes.
      let blockSpec: SpecYak;
      try {
        blockSpec = JSON.parse(Buffer.from(row.specCanonicalBytes).toString("utf-8")) as SpecYak;
      } catch {
        continue;
      }
      const matchResult = structuralMatch(querySpec, blockSpec);
      // structuralMatch returns { matches: true } for exact/superset hits or
      // { matches: false, reasons } for mismatches. Score by match quality.
      // v0 scoring: any structural hit scores 1.0; mismatch scores 0 (excluded).
      const score = matchResult.matches ? 1.0 : 0;
      if (score > 0) {
        scored.push({ root: merkleRoot, score, behavior: blockSpec.behavior ?? "" });
      }
    }

    // Sort by descending score, then take top-K.
    scored.sort((a, b) => b.score - a.score);
    const results = scored.slice(0, top);

    if (results.length === 0) {
      logger.log("no results found");
      return 0;
    }

    for (const { root, score, behavior } of results) {
      const behaviorStr = truncate(behavior, 80);
      const scoreStr = score.toFixed(4);
      logger.log(`${root.slice(0, 8)}  score=${scoreStr}  behavior=${behaviorStr}`);
    }

    return 0;
  } finally {
    await registry.close();
  }
}
