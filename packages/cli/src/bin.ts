#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Entry point for the `yakcc` CLI binary.
// Delegates to runCli and exits with the returned code.
// WI-005 wires the real command handlers.
import { fileURLToPath } from "node:url";
import { runCli } from "./index.js";

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
