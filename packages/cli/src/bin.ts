#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Entry point for the `yakcc` CLI binary.
// Delegates to runCli and exits with the returned code.
// WI-005 wires the real command handlers.
import { runCli } from "./index.js";

runCli(process.argv.slice(2)).then((code) => process.exit(code));
