#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Entry point for the `yakcc` CLI binary.
// Delegates to runCli and exits with the returned code.
// WI-005 wires the real command handlers.
import { runCli } from "./index.js";

// Strategy A (same as strict-subset-cli.ts): guard dispatch on direct execution
// so this module can be imported without side effects. The import.meta.url check
// matches only when Node runs this file directly; tests or other importers skip
// the dispatch. Runtime behaviour when invoked as the CLI binary is byte-identical.
if (import.meta.url === `file://${process.argv[1]}`) {
  runCli(process.argv.slice(2)).then((code) => process.exit(code));
}
