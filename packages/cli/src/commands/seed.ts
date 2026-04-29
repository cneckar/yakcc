// @decision DEC-CLI-SEED-001: seed opens the registry and delegates to seedRegistry()
// from @yakcc/seeds. seedRegistry() is idempotent (INSERT OR IGNORE), so running seed
// on an already-seeded registry is safe. Prints the stored count and a truncated list
// of contract ids, then exits 0.
// Status: implemented (WI-007)
// Rationale: The CLI seed command mirrors the test setup pattern in assemble.test.ts
// (openRegistry → seedRegistry). No author/ownership fields touched — DEC-NO-OWNERSHIP-011.

import { parseArgs } from "node:util";
import { type Registry, openRegistry } from "@yakcc/registry";
import { seedRegistry } from "@yakcc/seeds";
import type { Logger } from "../index.js";
import { DEFAULT_REGISTRY_PATH } from "./registry-init.js";

/** Maximum number of contract ids to print in the summary line. */
const MAX_IDS_SHOWN = 5;

/**
 * Handler for `yakcc seed [--registry <p>]`.
 *
 * Opens the registry and calls seedRegistry() to ingest all seed corpus blocks.
 * Prints a summary of stored contracts and exits 0.
 *
 * @param argv - Remaining argv after `seed` has been consumed.
 * @param logger - Output sink; defaults to console via the caller.
 * @returns Process exit code (0 = success, 1 = error).
 */
export async function seed(argv: readonly string[], logger: Logger): Promise<number> {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      registry: { type: "string", short: "r" },
    },
    allowPositionals: false,
    strict: true,
  });

  const registryPath = values.registry ?? DEFAULT_REGISTRY_PATH;

  let registry: Registry;
  try {
    registry = await openRegistry(registryPath);
  } catch (err) {
    logger.error(`error: failed to open registry at ${registryPath}: ${String(err)}`);
    return 1;
  }

  try {
    const result = await seedRegistry(registry);

    const shown = result.contractIds.slice(0, MAX_IDS_SHOWN);
    const rest = result.contractIds.length - shown.length;
    const idList = rest > 0 ? `${shown.join(", ")}, … (+${rest} more)` : shown.join(", ");

    logger.log(`seeded ${result.stored} contracts; ids: ${idList}`);
    return 0;
  } catch (err) {
    logger.error(`error: seed failed: ${String(err)}`);
    return 1;
  } finally {
    await registry.close();
  }
}
