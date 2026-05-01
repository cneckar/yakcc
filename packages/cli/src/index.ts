// @decision DEC-CLI-INDEX-001: runCli() is the single public entry point for the yakcc
// CLI. It dispatches on argv[0] (command) and argv[1] (subcommand for multi-word
// commands like "registry init"). Each command handler is a real function calling into
// the workspace packages — no stubs, no shelling out to yakcc sub-processes.
// Uses node:util.parseArgs — no external argparse dependency (DEC-V0-CLI-004).
// Status: implemented (WI-007)
// Rationale: Thin dispatch layer that stays out of the way of each command's own
// argument parsing. The split between index.ts (routing) and commands/*.ts (logic)
// keeps each command independently testable and replaceable.
//
// @decision DEC-CLI-LOGGER-001: Commands accept an optional Logger parameter rather
// than calling console.log/error directly. The production default is CONSOLE_LOGGER
// which delegates to the real console. Tests pass a CollectingLogger that records
// output in a plain array — no mocks, no spies needed.
// Status: implemented (WI-007)
// Rationale: Enables output verification in integration tests without mocking internal
// code (Sacred Practice #5). The Logger interface is minimal: log() for stdout-level
// messages, error() for stderr-level messages. All command signatures remain stable;
// the logger is an optional final parameter defaulting to CONSOLE_LOGGER.

import { compile } from "./commands/compile.js";
import { hooksClaudeCodeInstall } from "./commands/hooks-install.js";
import { propose } from "./commands/propose.js";
import { registryInit } from "./commands/registry-init.js";
import { search } from "./commands/search.js";
import { seed } from "./commands/seed.js";
import { shave } from "./commands/shave.js";

// Re-export ContractId for callers who import from @yakcc/cli.
export type { ContractId } from "@yakcc/contracts";

// ---------------------------------------------------------------------------
// Logger interface
// ---------------------------------------------------------------------------

/**
 * Minimal output interface for CLI commands.
 *
 * The production default (CONSOLE_LOGGER) delegates to console.log/console.error.
 * Tests inject a CollectingLogger to capture lines without mocking.
 */
export interface Logger {
  log(message: string): void;
  error(message: string): void;
}

/** Production logger — delegates to the real process console. */
export const CONSOLE_LOGGER: Logger = {
  log: (message: string) => {
    console.log(message);
  },
  error: (message: string) => {
    console.error(message);
  },
};

/**
 * In-memory logger for integration tests.
 * Collects all log/error lines in plain arrays — no mocking required.
 */
export class CollectingLogger implements Logger {
  readonly logLines: string[] = [];
  readonly errLines: string[] = [];

  log(message: string): void {
    this.logLines.push(message);
  }

  error(message: string): void {
    this.errLines.push(message);
  }
}

// ---------------------------------------------------------------------------
// Usage text
// ---------------------------------------------------------------------------

function printUsage(logger: Logger): void {
  logger.log(`yakcc — content-addressed basic-block registry

USAGE
  yakcc <command> [options]

COMMANDS
  registry init [--path <p>]          Initialize a registry (default: .yakcc/registry.sqlite)
  compile <entry> [--registry <p>]    Assemble a module from a contract id, spec file, or directory
               [--out <dir>]          Output directory (default: ./yakcc-out or <dir>/dist)
  propose <contract-file>             Check registry for a matching contract
          [--registry <p>]
  search <query> [--registry <p>]     Search registry by spec file or free text
         [--top <k>]                  Max results (default: 10)
  seed [--registry <p>]               Ingest the seed corpus into the registry
  shave <path> [--registry <p>]       Shave a TS source file into atoms via universalize
        [--offline]
  hooks claude-code install           Install /yakcc slash command for Claude Code
                [--target <dir>]      Target project directory (default: .)

FLAGS
  --help, -h                          Print this help and exit

EXIT CODES
  0  success
  1  usage or runtime error
`);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run the yakcc CLI with the given argument vector.
 *
 * Dispatches on the first positional token (command) and, for multi-word
 * commands, the second token (subcommand). Each command handler calls into
 * the real workspace packages and returns an exit code.
 *
 * @param argv - Arguments after the binary name (i.e. process.argv.slice(2)).
 * @param logger - Output sink; defaults to CONSOLE_LOGGER (the real console).
 * @returns Promise<number> — 0 on success, non-zero on error.
 */
export async function runCli(
  argv: ReadonlyArray<string>,
  logger: Logger = CONSOLE_LOGGER,
): Promise<number> {
  const [command, subcommand, ...rest] = argv;

  switch (command) {
    case "registry": {
      if (subcommand === "init") {
        return registryInit(rest, logger);
      }
      logger.error(
        `error: unknown registry subcommand: ${subcommand ?? "(none)"}. Did you mean 'registry init'?`,
      );
      return 1;
    }

    case "compile": {
      // subcommand is the first positional for compile (the entry arg).
      const compileArgv = subcommand !== undefined ? [subcommand, ...rest] : rest;
      return compile(compileArgv, logger);
    }

    case "propose": {
      const proposeArgv = subcommand !== undefined ? [subcommand, ...rest] : rest;
      return propose(proposeArgv, logger);
    }

    case "search": {
      const searchArgv = subcommand !== undefined ? [subcommand, ...rest] : rest;
      return search(searchArgv, logger);
    }

    case "seed": {
      // seed has no positional; subcommand may be a flag like --registry.
      const seedArgv = subcommand !== undefined ? [subcommand, ...rest] : rest;
      return seed(seedArgv, logger);
    }

    case "shave": {
      const shaveArgv = subcommand !== undefined ? [subcommand, ...rest] : rest;
      return shave(shaveArgv, logger);
    }

    case "hooks": {
      // `yakcc hooks claude-code install [--target <dir>]`
      if (subcommand === "claude-code") {
        const [hooksSub, ...hooksRest] = rest;
        if (hooksSub === "install") {
          return hooksClaudeCodeInstall(hooksRest, logger);
        }
        logger.error(
          `error: unknown hooks claude-code subcommand: ${hooksSub ?? "(none)"}. Did you mean 'hooks claude-code install'?`,
        );
        return 1;
      }
      logger.error(
        `error: unknown hooks subcommand: ${subcommand ?? "(none)"}. Did you mean 'hooks claude-code install'?`,
      );
      return 1;
    }

    case undefined:
    case "--help":
    case "-h": {
      printUsage(logger);
      return 0;
    }

    default: {
      logger.error(`error: unknown command: ${command}`);
      logger.error("Run 'yakcc --help' for usage.");
      return 1;
    }
  }
}
