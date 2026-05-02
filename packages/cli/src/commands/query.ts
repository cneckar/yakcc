// SPDX-License-Identifier: MIT
// @decision DEC-CLI-QUERY-001
// title: yakcc query command — vector-search CLI surface
// status: accepted
// rationale: WI-025 adds a semantic vector-search path to the registry. The
//   `query` command exposes findCandidatesByIntent() from @yakcc/registry at
//   the CLI surface, parallel to the existing `search` command (which does
//   linear-scan structural matching). `query` is the right name because it
//   operates on an intent query (semantic/embedding-based), while `search`
//   operates on structural matching. Both commands remain; they complement
//   rather than replace each other. Free-text queries are converted to a
//   minimal IntentQuery (behavior-only, no inputs/outputs) so callers can
//   type `yakcc query "parse integer from string"` without authoring a spec.
//   Card-file input allows programmatic callers (e.g. WI-026 hook) to pass
//   a serialized IntentCard directly.

import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { openRegistry } from "@yakcc/registry";
import type { IntentQuery } from "@yakcc/registry";
import type { Logger } from "../index.js";
import { DEFAULT_REGISTRY_PATH } from "./registry-init.js";

/**
 * Truncate a string to at most `max` characters, appending "..." if truncated.
 */
function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 3)}...`;
}

/**
 * Handler for `yakcc query <query> [--top k] [--rerank] [--registry <p>] [--card-file <f>]`.
 *
 * <query> is a free-text behavior string (ignored when --card-file is given).
 * Prints ranked results as one line per match:
 *   <rank>. cosine=<dist> [structural=<score>] block=<merkleRoot[:12]> behavior="<truncated>"
 *
 * @param argv   - Remaining argv after `query` has been consumed (includes the positional).
 * @param logger - Output sink; defaults to CONSOLE_LOGGER via the caller.
 * @returns Process exit code (0 = success, 1 = error).
 */
export async function query(argv: readonly string[], logger: Logger): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...argv],
    options: {
      registry: { type: "string", short: "r" },
      top: { type: "string", short: "k" },
      rerank: { type: "boolean" },
      "card-file": { type: "string" },
    },
    allowPositionals: true,
    strict: true,
  });

  const registryPath = values.registry ?? DEFAULT_REGISTRY_PATH;
  const topRaw = values.top ?? "10";
  const top = Number.parseInt(topRaw, 10);
  if (Number.isNaN(top) || top < 1) {
    logger.error(`error: --top must be a positive integer, got: ${topRaw}`);
    return 1;
  }
  const rerank = values.rerank === true ? "structural" : "none";

  // Resolve the intent query.
  let intentQuery: IntentQuery;

  const cardFilePath = values["card-file"];
  if (cardFilePath !== undefined) {
    // --card-file: parse a JSON IntentCard (or IntentQuery) from disk.
    let cardJson: string;
    try {
      cardJson = readFileSync(cardFilePath, "utf-8");
    } catch (err) {
      logger.error(`error: cannot read card file ${cardFilePath}: ${String(err)}`);
      return 1;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(cardJson);
    } catch (err) {
      logger.error(`error: invalid JSON in card file ${cardFilePath}: ${String(err)}`);
      return 1;
    }
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      !("behavior" in parsed) ||
      typeof (parsed as Record<string, unknown>).behavior !== "string"
    ) {
      logger.error(
        `error: card file ${cardFilePath} must have a "behavior" string field (IntentCard or IntentQuery shape)`,
      );
      return 1;
    }
    const card = parsed as Record<string, unknown>;
    intentQuery = {
      behavior: card.behavior as string,
      inputs: Array.isArray(card.inputs) ? (card.inputs as IntentQuery["inputs"]) : [],
      outputs: Array.isArray(card.outputs) ? (card.outputs as IntentQuery["outputs"]) : [],
    };
  } else {
    // Free text: positional is the behavior string.
    const queryText = positionals[0];
    if (queryText === undefined || queryText === "") {
      logger.error("error: query requires a <query> argument (free text) or --card-file <path>");
      return 1;
    }
    // Synthesize a minimal IntentQuery with behavior only (no inputs/outputs).
    intentQuery = { behavior: queryText, inputs: [], outputs: [] };
  }

  // Open the registry and run the vector search.
  const registry = await openRegistry(registryPath).catch((err: unknown) => {
    logger.error(`error: failed to open registry at ${registryPath}: ${String(err)}`);
    return null;
  });
  if (registry === null) return 1;

  try {
    const results = await registry.findCandidatesByIntent(intentQuery, {
      k: top,
      rerank,
    });

    if (results.length === 0) {
      logger.log("no results found");
      return 0;
    }

    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      if (r === undefined) continue;

      // Extract behavior string from the spec canonical bytes for display.
      let behaviorStr = "";
      try {
        const spec = JSON.parse(Buffer.from(r.block.specCanonicalBytes).toString("utf-8")) as {
          behavior?: string;
        };
        behaviorStr = spec.behavior ?? r.block.specHash;
      } catch {
        behaviorStr = r.block.specHash;
      }

      const rank = i + 1;
      const cosStr = r.cosineDistance.toFixed(6);
      const blockShort = r.block.blockMerkleRoot.slice(0, 12);
      const behaviorTrunc = truncate(behaviorStr, 72);

      if (r.structuralScore !== undefined) {
        const structStr = r.structuralScore.toFixed(4);
        logger.log(
          `${rank}. cosine=${cosStr} structural=${structStr} block=${blockShort} behavior="${behaviorTrunc}"`,
        );
      } else {
        logger.log(`${rank}. cosine=${cosStr} block=${blockShort} behavior="${behaviorTrunc}"`);
      }
    }

    return 0;
  } finally {
    await registry.close();
  }
}
