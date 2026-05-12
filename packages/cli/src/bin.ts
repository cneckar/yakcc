#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Entry point for the `yakcc` CLI binary.
// Delegates to runCli and exits with the returned code.
// WI-005 wires the real command handlers.
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
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
 * @status accepted
 * @rationale Manual `file://${argv[1]}` string construction fails on Windows because
 *   Node's import.meta.url uses `file:///C:/...` (triple slash, forward slashes) while
 *   the manual concatenation produces `file://C:\...` (double slash, backslashes).
 *   Approach (a): `fileURLToPath(import.meta.url) === argv[1]` avoids URL construction
 *   entirely — both sides are OS-native paths that Node normalizes consistently on all
 *   platforms. This is simpler and more readable than approach (b) (pathToFileURL(argv[1])).
 *   Cross-platform safe: fileURLToPath() is the inverse of pathToFileURL() and is
 *   guaranteed to produce the same path format as process.argv[1] on every platform.
 *   Closes #274.
 */
// Guard dispatch on direct execution so this module can be imported without
// side effects. The fileURLToPath comparison matches only when Node runs this
// file directly; tests or other importers skip the dispatch.
if (fileURLToPath(import.meta.url) === process.argv[1]) {
  runCli(process.argv.slice(2)).then((code) => process.exit(code));
}
