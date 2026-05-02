// SPDX-License-Identifier: MIT
// @decision DEC-CLI-REGISTRY-INIT-001: registry-init creates parent dirs with mkdirSync
// and delegates to openRegistry() from @yakcc/registry. Idempotent: opening a DB that
// already exists at the current schema_version is a no-op (schema migrations run only
// on version mismatch). The command prints a deterministic message in both cases.
// Status: implemented (WI-007)
// Rationale: openRegistry() calls applyMigrations(), which is idempotent. A second call
// on an already-initialized file returns normally. There is no separate "check if exists"
// path — we just open and close, and the migration mechanism gives us idempotency for free.

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import { type Registry, openRegistry } from "@yakcc/registry";
import type { Logger } from "../index.js";

/** Default registry path, relative to cwd. */
export const DEFAULT_REGISTRY_PATH = ".yakcc/registry.sqlite";

/**
 * Handler for `yakcc registry init [--path <path>]`.
 *
 * Creates the parent directory if missing, then opens (or creates) the SQLite
 * registry. Prints a deterministic message and exits 0.
 *
 * @param argv - Remaining argv after `registry init` has been consumed.
 * @param logger - Output sink; defaults to console via the caller.
 * @returns Process exit code (0 = success, 1 = error).
 */
export async function registryInit(argv: readonly string[], logger: Logger): Promise<number> {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      path: { type: "string", short: "p" },
    },
    allowPositionals: false,
    strict: true,
  });

  const registryPath = values.path ?? DEFAULT_REGISTRY_PATH;

  // Ensure parent directory exists.
  const parent = dirname(registryPath);
  mkdirSync(parent, { recursive: true });

  // Open (or create) the registry — applyMigrations() inside is idempotent.
  let registry: Registry;
  try {
    registry = await openRegistry(registryPath);
  } catch (err) {
    logger.error(`error: failed to open registry at ${registryPath}: ${String(err)}`);
    return 1;
  }

  await registry.close();

  logger.log(`registry initialized at ${registryPath}`);
  return 0;
}
