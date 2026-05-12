#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Entry point for the `yakcc` CLI binary.
// Delegates to runCli and exits with the returned code.
// WI-005 wires the real command handlers.
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runCli } from "./index.js";
import { patchSqliteDatabase } from "./pkg-native-compat.js";

// Apply the pkg snapshot .so extraction patch before any registry command can
// call db.loadExtension().  better-sqlite3 is a CJS module; we use createRequire
// to access it so that patchSqliteDatabase receives the real Database constructor.
// This is a no-op when running from source (insideSnapshot returns false).
{
  const _require = createRequire(import.meta.url);
  try {
    // better-sqlite3 is a CJS module; require() returns the Database
    // constructor directly (not wrapped in { default: ... }).
    const Database = _require("better-sqlite3") as {
      prototype: { loadExtension?: (...a: unknown[]) => unknown };
    };
    patchSqliteDatabase(Database);
  } catch (err) {
    // better-sqlite3 not available at patch time; skip silently.
    // The patch is best-effort: if it can't load here, the native
    // addon may not be in the snapshot either, and the real error
    // will surface when the command runs.
    // Set YAKCC_DEBUG=1 to surface this warning for troubleshooting.
    if (process.env.YAKCC_DEBUG && err instanceof Error) {
      console.warn(`[yakcc] pkg-native-compat patch skipped: ${err.message}`);
    }
  }
}

/**
 * @decision DEC-CLI-BIN-MAIN-MODULE-001
 * @title Cross-platform main-module guard using fileURLToPath
 * @status superseded
 * @rationale Superseded by DEC-CLI-BIN-MAIN-MODULE-GUARD-WINDOWS-001. The original
 *   fileURLToPath(import.meta.url) === process.argv[1] guard was a correct fix for
 *   #274 but does not cover symlinks, Windows case-insensitive drive letters (C:\ vs c:\),
 *   or 8.3 short-name forms (PROGRA~1 vs Program Files). See new decision below.
 */

/**
 * @decision DEC-CLI-BIN-MAIN-MODULE-GUARD-WINDOWS-001
 * @title Defense-in-depth main-module guard: realpathSync normalizes path before comparison
 * @status accepted
 * @rationale WI-ALPHA-WINDOWS-BIN-JS (#385): the original fileURLToPath guard (DEC-CLI-BIN-MAIN-MODULE-001)
 *   is functionally correct for the typical `node bin.js` invocation but leaves open three
 *   Windows edge cases: (1) symlink-to-bin.js where process.argv[1] is the symlink path
 *   and import.meta.url is the real path; (2) case-insensitive drive letter normalization
 *   (C:\foo vs c:\foo); (3) 8.3 short-name forms (PROGRA~1 vs Program Files).
 *   realpathSync resolves all three: it canonicalizes symlinks, normalizes case on
 *   case-insensitive filesystems, and resolves 8.3 short names. fileURLToPath handles
 *   the file:///C:/... drive-letter URL form on Windows. The byte-string comparison
 *   after both transforms is platform-agnostic.
 *   FORBIDDEN: NO try-catch around the comparison itself — that re-introduces the
 *   silent-no-op failure mode that #274 was filed to defeat. Only the ENOENT case
 *   (process.argv[1] path does not exist, e.g. node -e "...") falls back to URL comparison.
 *   PRESERVES: WI-361 patchSqliteDatabase invocation above; this guard is a separate concern.
 */
// Guard dispatch on direct execution so this module can be imported without
// side effects. realpathSync(fileURLToPath(...)) normalizes case + symlinks +
// 8.3 short-names on Windows; fileURLToPath handles the file:/// drive-letter form.
// Both sides resolve to OS-native canonical paths before the byte comparison.
function isMainModule(): boolean {
  try {
    const thisFile = realpathSync(fileURLToPath(import.meta.url));
    const entryFile = process.argv[1] ? realpathSync(process.argv[1]) : "";
    return thisFile === entryFile;
  } catch (err) {
    // realpathSync throws ENOENT when the path does not exist (e.g. node -e "...").
    // Fall back to URL string comparison ONLY for the not-found case.
    // Do NOT catch other errors (e.g. EACCES, EPERM) — propagate them.
    if (err instanceof Error && (err as NodeJS.ErrnoException).code === "ENOENT") {
      return import.meta.url === pathToFileURL(process.argv[1] ?? "").href;
    }
    throw err;
  }
}

if (isMainModule()) {
  runCli(process.argv.slice(2)).then((code) => process.exit(code));
}
