// SPDX-License-Identifier: MIT
// Vitest harness for index.props.ts
// Two-file pattern: this file is the thin vitest wrapper; the corpus lives in
// the sibling index.props.ts (vitest-free, hashable as a manifest artifact).

import * as fc from "fast-check";
import { it } from "vitest";
import {
  prop_collecting_logger_accumulates_multiple_lines,
  prop_collecting_logger_error_goes_to_errLines,
  prop_collecting_logger_log_goes_to_logLines,
  prop_runCli_help_flag_exits_0,
  prop_runCli_help_writes_to_logLines_not_errLines,
  prop_runCli_unknown_command_emits_error_message,
  prop_runCli_unknown_command_exits_1,
} from "./index.props.js";

it("property: prop_collecting_logger_log_goes_to_logLines", () => {
  fc.assert(prop_collecting_logger_log_goes_to_logLines);
});

it("property: prop_collecting_logger_error_goes_to_errLines", () => {
  fc.assert(prop_collecting_logger_error_goes_to_errLines);
});

it("property: prop_collecting_logger_accumulates_multiple_lines", () => {
  fc.assert(prop_collecting_logger_accumulates_multiple_lines);
});

it("property: prop_runCli_unknown_command_exits_1", async () => {
  await fc.assert(prop_runCli_unknown_command_exits_1);
});

it("property: prop_runCli_unknown_command_emits_error_message", async () => {
  await fc.assert(prop_runCli_unknown_command_emits_error_message);
});

it("property: prop_runCli_help_flag_exits_0", async () => {
  await fc.assert(prop_runCli_help_flag_exits_0);
});

it("property: prop_runCli_help_writes_to_logLines_not_errLines", async () => {
  await fc.assert(prop_runCli_help_writes_to_logLines_not_errLines);
});
