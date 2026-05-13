// SPDX-License-Identifier: MIT
// @decision DEC-CLI-REGISTRY-EXPORT-001: registry-export uses SQLite VACUUM INTO for a
// clean, defragmented, portable copy of the source registry. The output is signing-ready
// for the registry.yakcc.com deploy pipeline (#371).
// Status: implemented (#371 Slice 2)
// Rationale: VACUUM INTO is the SQLite-canonical way to produce a portable copy. It
// compacts free pages, normalizes the file format, and is faster than dump-and-restore
// for our typical registry sizes. Single-quote escaping in the inlined output path is
// required because VACUUM INTO does not support SQL parameter binding for filenames.
//
// Better-sqlite3 access: pnpm isolates better-sqlite3 to @yakcc/registry's node_modules.
// We resolve it via createRequire anchored to the registry package's own source root so
// that both production CJS and vitest ESM (which aliases @yakcc/registry to source) follow
// the same resolution path. This avoids adding better-sqlite3 as a direct CLI dep.
// Same approach as packages/cli/src/bin.ts (createRequire pattern).

import { existsSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { Logger } from "../index.js";
import { DEFAULT_REGISTRY_PATH } from "./registry-init.js";

// Resolve better-sqlite3 from @yakcc/registry's package root, where it is a
// declared direct dependency. The URL is constructed relative to this source
// file so it correctly navigates to the registry package in the monorepo tree.
// Under vitest source-alias mode this still resolves to the same physical
// node_modules/better-sqlite3 that openRegistry uses at runtime.
//
// Path breakdown from packages/cli/src/commands/ (this file's directory):
//   ../      → packages/cli/src/
//   ../../   → packages/cli/
//   ../../../ → packages/           ← need THREE levels up to reach the monorepo root
//   ../../../registry/src/index.ts → packages/registry/src/index.ts ✓
const _registryModuleUrl = new URL("../../../registry/src/index.ts", import.meta.url).href;
const _req = createRequire(_registryModuleUrl);

// Minimal structural interface — only the methods we call are typed.
// Avoids depending on @types/better-sqlite3 which is outside CLI's type scope.
type MinimalDb = {
  prepare(sql: string): { get(): unknown };
  exec(sql: string): void;
  close(): void;
};

/**
 * Handler for `yakcc registry export --to <path> [--from <path>]`.
 *
 * Exports the source registry as a clean canonical SQLite via VACUUM INTO.
 * The output is portable, defragmented, and ready for upload to a federation
 * peer (e.g. registry.yakcc.com). The source is opened read-write because
 * VACUUM INTO requires an exclusive lock, but no row mutations occur.
 *
 * @param argv - Remaining argv after `registry export` has been consumed.
 * @param logger - Output sink.
 * @returns Process exit code (0 success, 1 error).
 */
export async function registryExport(argv: readonly string[], logger: Logger): Promise<number> {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      to: { type: "string" },
      from: { type: "string", default: DEFAULT_REGISTRY_PATH },
    },
    strict: true,
    allowPositionals: false,
  });

  if (values.to === undefined) {
    logger.error("error: --to <path> is required for 'registry export'");
    return 1;
  }

  const sourcePath = resolve(values.from as string);
  const outputPath = resolve(values.to);

  if (!existsSync(sourcePath)) {
    logger.error(`error: source registry not found at ${sourcePath}`);
    return 1;
  }

  mkdirSync(dirname(outputPath), { recursive: true });

  // VACUUM INTO does not accept SQL parameter binding for filenames; the path
  // is inlined. Escape any single quotes in the path by doubling them per
  // SQLite's string-literal rules.
  const escapedOutputPath = outputPath.replace(/'/g, "''");

  // Load the native binding. Failure here means the pnpm isolation path is broken
  // or the native addon was not built — emit a clear message before giving up.
  let Database: { new (path: string): MinimalDb };
  try {
    // createRequire returns `unknown`; we extract the constructor through a
    // typed intermediate to avoid a bare `any` cast that Biome rejects.
    type BsqliteModule = {
      default?: { new (path: string): MinimalDb };
      new?(path: string): MinimalDb;
    };
    const mod = _req("better-sqlite3") as BsqliteModule;
    Database = (mod.default ?? mod) as { new (path: string): MinimalDb };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`error: could not load better-sqlite3 native binding: ${msg}`);
    return 1;
  }

  // Open the source registry. Failure here means the file is not a valid SQLite
  // database (e.g. corrupted header) despite passing the existsSync check above.
  let db: MinimalDb;
  try {
    db = new Database(sourcePath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`error: could not open source registry at ${sourcePath}: ${msg}`);
    return 1;
  }

  try {
    // Optional: report block count for operator visibility. Wrapped in try/catch
    // so an unexpected schema variant doesn't fail the export.
    let blockCount: number | null = null;
    try {
      const row = db.prepare("SELECT count(*) as n FROM blocks").get() as { n: number } | undefined;
      if (row && typeof row.n === "number") blockCount = row.n;
    } catch (_) {
      // canonical table name differs in schema variants; skip count silently
    }

    db.exec(`VACUUM INTO '${escapedOutputPath}'`);

    const suffix = blockCount === null ? "" : ` (${blockCount} blocks)`;
    logger.log(`registry exported${suffix}: ${sourcePath} → ${outputPath}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`error: VACUUM INTO failed (${outputPath}): ${msg}`);
    return 1;
  } finally {
    db.close();
  }

  return 0;
}
