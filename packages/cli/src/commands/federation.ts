// @decision DEC-CLI-FEDERATION-001: federation command — thin CLI wrapper around
// @yakcc/federation public surface (mirrorRegistry, serveRegistry, pullBlock,
// createHttpTransport) and @yakcc/registry (openRegistry).
// Status: implemented (WI-020 Slice G)
// Rationale: Follows the established (argv, logger) → Promise<number> contract from
// seed.ts/shave.ts. Transport injection seam (opts.transport) enables unit tests
// without network I/O. Serve path accepts noBlock option so tests can obtain the
// ServeHandle without blocking on SIGINT. Output is JSON (mirror report) or
// concise summary lines (pull) to keep the CLI output useful without dumping base64.
//
// @decision DEC-CLI-FEDERATION-IMPORTS-001: federation.ts imports ONLY from
// @yakcc/federation and @yakcc/registry. No direct @yakcc/contracts, @yakcc/shave,
// @yakcc/compile, or any other workspace package is imported here.
// Status: decided (WI-020 Slice G)
// Rationale: The federation surface is the single authority for federation logic;
// the CLI is a thin dispatch layer that should not bypass the public API.
//
// @decision DEC-NO-OWNERSHIP-011: No ownership fields anywhere.
// Status: decided (MASTER_PLAN.md DEC-NO-OWNERSHIP-011)
//
// @decision DEC-V1-WAVE-1-SCOPE-001: F1 read-only mirror only. No push/auth.
// Status: decided (MASTER_PLAN.md DEC-V1-WAVE-1-SCOPE-001)

import { parseArgs } from "node:util";
import type { BlockMerkleRoot } from "@yakcc/contracts";
import {
  SchemaVersionMismatchError,
  createHttpTransport,
  mirrorRegistry,
  pullBlock,
  serveRegistry,
} from "@yakcc/federation";
import type { ServeHandle, Transport } from "@yakcc/federation";
import type { Registry } from "@yakcc/registry";
import { openRegistry } from "@yakcc/registry";
import type { Logger } from "../index.js";

// ---------------------------------------------------------------------------
// Internal seam options (for test injection — not exposed in CLI args)
// ---------------------------------------------------------------------------

/**
 * Internal options for runFederation.
 * Callers may inject these in tests to bypass network I/O and SIGINT waiting.
 */
export interface FederationOptions {
  /**
   * Transport to use for mirror/pull operations.
   * Default: createHttpTransport() (real HTTP).
   * Tests inject a stub Transport to avoid network I/O.
   */
  transport?: Transport;
  /**
   * When true, the serve subcommand starts the server and returns the
   * ServeHandle immediately without registering SIGINT/SIGTERM handlers or
   * blocking indefinitely.
   * Default: false (production — blocks until signal).
   */
  noBlock?: boolean;
}

// ---------------------------------------------------------------------------
// Usage text
// ---------------------------------------------------------------------------

/** Print federation subcommand usage to logger.log. */
export function printFederationUsage(logger: Logger): void {
  logger.log(
    [
      "Usage: yakcc federation <subcommand> [options]",
      "",
      "Subcommands:",
      "  serve   --registry <db-path> [--port <n>] [--host <h>]",
      "             Start a read-only HTTP registry server",
      "  mirror  --remote <url> --registry <db-path>",
      "             Mirror all blocks from a remote registry peer",
      "  pull    --remote <url> --root <merkleRoot> --registry <db-path>",
      "             Pull a single block triplet from a remote peer",
    ].join("\n"),
  );
}

// ---------------------------------------------------------------------------
// Subcommand: serve
// ---------------------------------------------------------------------------

/**
 * Run `yakcc federation serve`.
 *
 * In production (opts.noBlock === false, the default), binds the port and then
 * waits on SIGINT/SIGTERM, calling handle.close() and exiting 0 on receipt.
 *
 * In test mode (opts.noBlock === true), binds and returns immediately with exit
 * code 0. The caller obtains the ServeHandle via the returned value of
 * runFederationServe() directly (not via process signals).
 *
 * Returns the ServeHandle so tests can interact with the running server.
 *
 * @param argv   - Args after "serve" has been consumed.
 * @param logger - Output sink.
 * @param opts   - Internal options (noBlock for test isolation).
 * @returns { code: number; handle: ServeHandle | null }
 */
export async function runFederationServe(
  argv: readonly string[],
  logger: Logger,
  opts?: FederationOptions,
): Promise<{ code: number; handle: ServeHandle | null }> {
  const parsed = (() => {
    try {
      return parseArgs({
        args: [...argv],
        allowPositionals: false,
        options: {
          registry: { type: "string" },
          port: { type: "string" },
          host: { type: "string" },
        },
      });
    } catch (err) {
      logger.error(`error: ${(err as Error).message}`);
      return null;
    }
  })();
  if (parsed === null) return { code: 1, handle: null };

  const registryPath = parsed.values.registry;
  if (registryPath === undefined || registryPath === "") {
    logger.error("error: --registry <db-path> is required for 'federation serve'");
    return { code: 1, handle: null };
  }

  const portArg = parsed.values.port;
  const port = portArg !== undefined ? Number.parseInt(portArg, 10) : 0;
  if (portArg !== undefined && (Number.isNaN(port) || port < 0 || port > 65535)) {
    logger.error(`error: invalid --port value: ${portArg}`);
    return { code: 1, handle: null };
  }

  const host = parsed.values.host ?? "127.0.0.1";

  let registry: Registry;
  try {
    registry = await openRegistry(registryPath);
  } catch (err) {
    logger.error(`error: failed to open registry at ${registryPath}: ${String(err)}`);
    return { code: 1, handle: null };
  }

  let handle: ServeHandle;
  try {
    handle = await serveRegistry(registry, { port, host });
  } catch (err) {
    logger.error(`error: failed to start server: ${String(err)}`);
    await registry.close();
    return { code: 1, handle: null };
  }

  logger.log(`federation serve: listening at ${handle.url}`);

  if (opts?.noBlock === true) {
    // Test path: return immediately with the handle so the caller can interact
    // with the server and call handle.close() themselves.
    return { code: 0, handle };
  }

  // Production path: wait on SIGINT/SIGTERM.
  await new Promise<void>((resolve) => {
    const shutdown = (): void => {
      handle
        .close()
        .then(() => {
          registry.close().finally(resolve);
        })
        .catch(resolve);
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });

  return { code: 0, handle };
}

// ---------------------------------------------------------------------------
// Subcommand: mirror
// ---------------------------------------------------------------------------

/**
 * Run `yakcc federation mirror`.
 * Mirrors all blocks from the remote peer into the local registry.
 * Prints the MirrorReport as JSON (two-space indent) to logger.log.
 * Exits 0 on success (even if failures[] is non-empty — those are recoverable).
 * Exits 1 only on a thrown error (e.g. SchemaVersionMismatchError).
 *
 * @param argv   - Args after "mirror" has been consumed.
 * @param logger - Output sink.
 * @param opts   - Internal options (transport for test injection).
 * @returns Process exit code.
 */
async function runFederationMirror(
  argv: readonly string[],
  logger: Logger,
  opts?: FederationOptions,
): Promise<number> {
  const parsed = (() => {
    try {
      return parseArgs({
        args: [...argv],
        allowPositionals: false,
        options: {
          remote: { type: "string" },
          registry: { type: "string" },
        },
      });
    } catch (err) {
      logger.error(`error: ${(err as Error).message}`);
      return null;
    }
  })();
  if (parsed === null) return 1;

  const remote = parsed.values.remote;
  if (remote === undefined || remote === "") {
    logger.error("error: --remote <url> is required for 'federation mirror'");
    return 1;
  }

  const registryPath = parsed.values.registry;
  if (registryPath === undefined || registryPath === "") {
    logger.error("error: --registry <db-path> is required for 'federation mirror'");
    return 1;
  }

  let registry: Registry;
  try {
    registry = await openRegistry(registryPath);
  } catch (err) {
    logger.error(`error: failed to open registry at ${registryPath}: ${String(err)}`);
    return 1;
  }

  // Resolve transport: injected (tests) or real HTTP (production).
  const transport = opts?.transport ?? createHttpTransport();

  try {
    const report = await mirrorRegistry(remote, registry, transport);
    logger.log(JSON.stringify(report, null, 2));
    return 0;
  } catch (err) {
    if (err instanceof SchemaVersionMismatchError) {
      logger.error(`error: schema version mismatch: ${err.message}`);
    } else {
      logger.error(`error: mirror failed: ${String(err)}`);
    }
    return 1;
  } finally {
    await registry.close();
  }
}

// ---------------------------------------------------------------------------
// Subcommand: pull
// ---------------------------------------------------------------------------

/**
 * Run `yakcc federation pull`.
 * Pulls a single block from the remote peer, integrity-checks it, and prints
 * a concise summary (blockMerkleRoot + specHash) to logger.log.
 * Does NOT persist to the registry — pull is a read-only diagnostic verb.
 *
 * @param argv   - Args after "pull" has been consumed.
 * @param logger - Output sink.
 * @param opts   - Internal options (transport for test injection).
 * @returns Process exit code.
 */
async function runFederationPull(
  argv: readonly string[],
  logger: Logger,
  opts?: FederationOptions,
): Promise<number> {
  const parsed = (() => {
    try {
      return parseArgs({
        args: [...argv],
        allowPositionals: false,
        options: {
          remote: { type: "string" },
          root: { type: "string" },
          registry: { type: "string" },
        },
      });
    } catch (err) {
      logger.error(`error: ${(err as Error).message}`);
      return null;
    }
  })();
  if (parsed === null) return 1;

  const remote = parsed.values.remote;
  if (remote === undefined || remote === "") {
    logger.error("error: --remote <url> is required for 'federation pull'");
    return 1;
  }

  const root = parsed.values.root;
  if (root === undefined || root === "") {
    logger.error("error: --root <merkleRoot> is required for 'federation pull'");
    return 1;
  }

  // Note: --registry is accepted (for future persistence) but not required for
  // the current read-only diagnostic pull path. We keep the flag defined so the
  // CLI surface is stable for future WI that adds persist-on-pull.

  // Resolve transport: injected (tests) or real HTTP (production).
  const transport = opts?.transport ?? createHttpTransport();

  try {
    const row = await pullBlock(remote as BlockMerkleRoot, root as BlockMerkleRoot, { transport });
    logger.log("pulled block:");
    logger.log(`  blockMerkleRoot: ${row.blockMerkleRoot}`);
    logger.log(`  specHash:        ${row.specHash}`);
    return 0;
  } catch (err) {
    logger.error(`error: pull failed: ${String(err)}`);
    return 1;
  }
}

// ---------------------------------------------------------------------------
// Public dispatch entry point
// ---------------------------------------------------------------------------

/**
 * Run `yakcc federation <subcommand> [args]`.
 *
 * Dispatches to serve/mirror/pull based on args[0].
 * Unknown subcommand → print usage, return 1.
 *
 * opts is an internal test-injection seam — production callers (index.ts) pass
 * no opts and get the real HTTP transport + blocking SIGINT behaviour.
 *
 * @param args - Remaining args after "federation" has been consumed (args[0] = subcommand).
 * @param logger - Output sink; defaults to CONSOLE_LOGGER via the caller in index.ts.
 * @param opts - Internal options for test injection (transport, noBlock).
 * @returns Promise<number> — process exit code.
 */
export async function runFederation(
  args: string[],
  logger: Logger,
  opts?: FederationOptions,
): Promise<number> {
  const [sub, ...rest] = args;

  switch (sub) {
    case "serve": {
      const result = await runFederationServe(rest, logger, opts);
      return result.code;
    }

    case "mirror": {
      return runFederationMirror(rest, logger, opts);
    }

    case "pull": {
      return runFederationPull(rest, logger, opts);
    }

    default: {
      printFederationUsage(logger);
      return 1;
    }
  }
}
