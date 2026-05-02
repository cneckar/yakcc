// SPDX-License-Identifier: MIT
// @decision DEC-CLI-SHAVE-001: shave command wraps @yakcc/shave.shave() for CLI consumption.
// Opens the registry via @yakcc/registry.openRegistry(), delegates all pipeline logic
// to shaveImpl(), and prints a human-readable summary. Error paths follow the
// established pattern from seed.ts and compile.ts: catch, log to logger.error(), return 1.
// Status: implemented (WI-014-02)
// Rationale: Keeps the CLI layer thin — argument parsing, registry open/close, and
// output formatting live here; pipeline logic stays in @yakcc/shave. Matches the
// `(argv, logger) → Promise<number>` contract shared by all yakcc commands.

import { resolve } from "node:path";
import { parseArgs } from "node:util";
import type { Registry } from "@yakcc/registry";
import { openRegistry } from "@yakcc/registry";
import { shave as shaveImpl } from "@yakcc/shave";
import type { Logger } from "../index.js";

/** Argument options descriptor for parseArgs — typed inline to avoid implicit any. */
const SHAVE_PARSE_OPTIONS = {
  registry: { type: "string" },
  offline: { type: "boolean", default: false },
  help: { type: "boolean", short: "h", default: false },
} as const;

/**
 * Handler for `yakcc shave <path> [--registry <p>] [--offline]`.
 *
 * Shaves a TypeScript source file: reads it, runs through the universalizer
 * (license gate → intent extraction → decompose → slice), and prints a summary
 * of the ShaveResult. The atoms array (each with placeholderId + sourceRange) is
 * printed; intent cards count and diagnostics are surfaced.
 *
 * @param argv    - Subcommand args after "shave" has been consumed (positional path + flags).
 * @param logger  - Output sink; defaults to CONSOLE_LOGGER via the caller.
 * @returns Promise<number> — 0 on success, 1 on error.
 */
export async function shave(argv: ReadonlyArray<string>, logger: Logger): Promise<number> {
  // Parse arguments — parseArgs throws on unknown flags, so wrap in try/catch.
  const parsed = (() => {
    try {
      return parseArgs({
        args: [...argv],
        allowPositionals: true,
        options: SHAVE_PARSE_OPTIONS,
      });
    } catch (err) {
      logger.error(`error: ${(err as Error).message}`);
      return null;
    }
  })();
  if (parsed === null) return 1;

  if (parsed.values.help) {
    logger.log(
      "Usage: yakcc shave <path> [--registry <p>] [--offline]\n" +
        "  Shave a source file into universalize result (atoms + intent + license).",
    );
    return 0;
  }

  const sourcePath = parsed.positionals[0];
  if (sourcePath === undefined) {
    logger.error("error: missing source path. Usage: yakcc shave <path>");
    return 1;
  }

  const registryPath = parsed.values.registry ?? ".yakcc/registry.sqlite";
  const offline = parsed.values.offline === true;

  let registry: Registry;
  try {
    registry = await openRegistry(resolve(registryPath));
  } catch (err) {
    logger.error(`error: failed to open registry at ${registryPath}: ${(err as Error).message}`);
    return 1;
  }

  // Adapt Registry → ShaveRegistryView (nullish mismatch on getBlock).
  const shaveRegistry = {
    selectBlocks: (specHash: Parameters<typeof registry.selectBlocks>[0]) =>
      registry.selectBlocks(specHash),
    getBlock: async (merkleRoot: Parameters<typeof registry.getBlock>[0]) => {
      const row = await registry.getBlock(merkleRoot);
      return row ?? undefined;
    },
    findByCanonicalAstHash: registry.findByCanonicalAstHash?.bind(registry),
  };

  try {
    const result = await shaveImpl(resolve(sourcePath), shaveRegistry, { offline });
    logger.log(`Shaved ${result.sourcePath}:`);
    logger.log(`  atoms: ${result.atoms.length}`);
    logger.log(`  intentCards: ${result.intentCards.length}`);
    if (result.atoms.length > 0) {
      logger.log("  atoms detail:");
      for (const atom of result.atoms) {
        logger.log(
          `    - ${atom.placeholderId} [${atom.sourceRange.start}..${atom.sourceRange.end}]`,
        );
      }
    }
    if (result.diagnostics.stubbed.length > 0) {
      logger.log(`  stubbed: ${result.diagnostics.stubbed.join(", ")}`);
    }
    return 0;
  } catch (err) {
    const e = err as Error;
    logger.error(`error: shave failed: ${e.message}`);
    return 1;
  } finally {
    await registry.close();
  }
}
