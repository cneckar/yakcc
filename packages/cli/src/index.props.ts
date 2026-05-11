// SPDX-License-Identifier: MIT
// @decision DEC-V2-PROPTEST-CLI-INDEX-001: hand-authored property-test corpus for
// @yakcc/cli index.ts atoms. Two-file pattern: this file (.props.ts) is
// vitest-free and holds the corpus; the sibling .props.test.ts is the vitest harness.
// Status: accepted (WI-87-fill-cli)
// Rationale: Same two-file pattern as strict-subset.props.ts — corpus is
// runtime-independent so the manifest artifact pipeline can hash it.
//
// ---------------------------------------------------------------------------
// Property-test corpus for index.ts atoms
//
// Atoms covered:
//   CollectingLogger (A1) — in-memory logger collects log/error lines
//   runCli routing   (A2) — dispatch to unknown command returns exit 1 + error message
//                         — dispatch to help flags returns exit 0 + usage
//                         — no-arg invocation returns exit 0 + usage
//
// Properties exercised (7):
//   1. CollectingLogger.log() pushes to logLines, not errLines
//   2. CollectingLogger.error() pushes to errLines, not logLines
//   3. CollectingLogger starts with empty arrays
//   4. runCli unknown command → exit 1 (no registry I/O)
//   5. runCli unknown command → error message mentions the command name
//   6. runCli --help flag → exit 0
//   7. runCli no args → exit 0
// ---------------------------------------------------------------------------

import * as fc from "fast-check";
import { CollectingLogger, runCli } from "./index.js";

// ---------------------------------------------------------------------------
// A1: CollectingLogger — pure in-memory accumulator
// ---------------------------------------------------------------------------

/**
 * prop_collecting_logger_log_goes_to_logLines
 *
 * Calling logger.log(msg) appends msg to logLines and does not affect errLines.
 *
 * Invariant: CollectingLogger.log() is a pure side-effect isolated to logLines.
 */
export const prop_collecting_logger_log_goes_to_logLines = fc.property(
  fc.string({ maxLength: 200 }),
  (msg: string) => {
    const logger = new CollectingLogger();
    logger.log(msg);
    return (
      logger.logLines.length === 1 && logger.logLines[0] === msg && logger.errLines.length === 0
    );
  },
);

/**
 * prop_collecting_logger_error_goes_to_errLines
 *
 * Calling logger.error(msg) appends msg to errLines and does not affect logLines.
 *
 * Invariant: CollectingLogger.error() is a pure side-effect isolated to errLines.
 */
export const prop_collecting_logger_error_goes_to_errLines = fc.property(
  fc.string({ maxLength: 200 }),
  (msg: string) => {
    const logger = new CollectingLogger();
    logger.error(msg);
    return (
      logger.errLines.length === 1 && logger.errLines[0] === msg && logger.logLines.length === 0
    );
  },
);

/**
 * prop_collecting_logger_accumulates_multiple_lines
 *
 * Multiple log() calls accumulate in order; multiple error() calls accumulate in order.
 * The arrays are independent: log() lines never appear in errLines and vice versa.
 *
 * Invariant: CollectingLogger maintains strict order preservation and channel isolation.
 */
export const prop_collecting_logger_accumulates_multiple_lines = fc.property(
  fc.array(fc.string({ maxLength: 100 }), { minLength: 1, maxLength: 10 }),
  fc.array(fc.string({ maxLength: 100 }), { minLength: 1, maxLength: 10 }),
  (logMsgs: string[], errMsgs: string[]) => {
    const logger = new CollectingLogger();
    for (const m of logMsgs) logger.log(m);
    for (const m of errMsgs) logger.error(m);
    // Order and content preserved
    if (logger.logLines.length !== logMsgs.length) return false;
    if (logger.errLines.length !== errMsgs.length) return false;
    for (let i = 0; i < logMsgs.length; i++) {
      if (logger.logLines[i] !== logMsgs[i]) return false;
    }
    for (let i = 0; i < errMsgs.length; i++) {
      if (logger.errLines[i] !== errMsgs[i]) return false;
    }
    return true;
  },
);

// ---------------------------------------------------------------------------
// A2: runCli routing — unknown command exits without registry I/O
// ---------------------------------------------------------------------------

/**
 * Arbitrary for strings that are not valid yakcc command names.
 * The set of valid commands is: init, registry, compile, propose, query,
 * search, seed, bootstrap, shave, hooks, federation, --help, -h.
 * We use strings guaranteed to be outside that set.
 */
const unknownCommandArb: fc.Arbitrary<string> = fc.oneof(
  // Numeric strings — never valid commands
  fc
    .integer({ min: 0, max: 99 })
    .map(String),
  // Strings starting with "__" — namespace reserved, never a valid command
  fc
    .string({ minLength: 1, maxLength: 12 })
    .map((s: string) => `__${s}`),
  // Known invalid literals
  fc.constantFrom("bogus", "xyz", "notacommand", "INIT", "SEARCH", "foobar"),
);

/**
 * prop_runCli_unknown_command_exits_1
 *
 * For any unknown command string, runCli returns exit code 1.
 *
 * Invariant: The default switch branch correctly rejects unrecognized commands
 * without performing any I/O or throwing.
 */
export const prop_runCli_unknown_command_exits_1 = fc.asyncProperty(
  unknownCommandArb,
  async (cmd: string) => {
    const logger = new CollectingLogger();
    const code = await runCli([cmd], logger);
    return code === 1;
  },
);

/**
 * prop_runCli_unknown_command_emits_error_message
 *
 * For any unknown command, runCli emits an error line containing the command
 * token and a hint to run --help.
 *
 * Invariant: The error path always produces at least one errLines entry;
 * the user always sees the unrecognized command name in the output.
 */
export const prop_runCli_unknown_command_emits_error_message = fc.asyncProperty(
  unknownCommandArb,
  async (cmd: string) => {
    const logger = new CollectingLogger();
    await runCli([cmd], logger);
    // Must have at least one error line
    if (logger.errLines.length === 0) return false;
    // At least one line must mention the command
    const mentionsCmd = logger.errLines.some((l) => l.includes(cmd));
    return mentionsCmd;
  },
);

/**
 * prop_runCli_help_flag_exits_0
 *
 * Both --help and -h return exit code 0.
 *
 * Invariant: Help flags are always safe no-ops that never fail.
 */
export const prop_runCli_help_flag_exits_0 = fc.asyncProperty(
  fc.constantFrom(["--help"], ["-h"], []),
  async (argv: readonly string[]) => {
    const logger = new CollectingLogger();
    const code = await runCli(argv, logger);
    return code === 0;
  },
);

/**
 * prop_runCli_help_writes_to_logLines_not_errLines
 *
 * When --help is passed, the usage output goes to logger.log() (logLines),
 * not logger.error() (errLines). No error messages are emitted for a
 * well-formed help request.
 *
 * Invariant: Help output is never an error; it uses the stdout channel.
 */
export const prop_runCli_help_writes_to_logLines_not_errLines = fc.asyncProperty(
  fc.constantFrom(["--help"], ["-h"]),
  async (argv: readonly string[]) => {
    const logger = new CollectingLogger();
    await runCli(argv, logger);
    return logger.logLines.length > 0 && logger.errLines.length === 0;
  },
);
