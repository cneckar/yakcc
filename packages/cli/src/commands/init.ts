// SPDX-License-Identifier: MIT
//
// init.ts — handler for `yakcc init [--target <dir>] [--peer <url>]`
//
// First-30-seconds surface for v0.5 GTM. Wraps the existing `registry init`
// and `hooks claude-code install` commands into a single entry point so a
// developer with a fresh TS project needs exactly one command to get started.
//
// @decision DEC-CLI-INIT-001
// title: Config-file format, transitive hook install, auto-seed policy
// status: accepted (WI-V05-INIT-COMMAND #204)
// rationale:
//   CONFIG FORMAT: `.yakccrc.json` at the target directory root (not inside
//   `.yakcc/`). Rationale — keeps the project config visible at the repo root
//   alongside package.json, .eslintrc, etc. Avoids nesting user-facing config
//   inside the data directory. Alternative `.yakcc/config.json` was rejected
//   because it conflates operational data (SQLite, telemetry) with project
//   configuration. Inline `package.json yakcc:` key was rejected because yakcc
//   is not always used inside a Node.js project.
//
//   TRANSITIVE HOOK INSTALL: yes — `yakcc init` calls `hooksClaudeCodeInstall`
//   directly (not via shell subprocess). Rationale — composing the real
//   function call ensures the same code path that `yakcc hooks claude-code
//   install` exercises; no duplication, no subprocess overhead, no PATH
//   dependency at init time. DEC-CLI-INDEX-001 establishes the pattern: each
//   command is a callable function, not a subprocess.
//
//   AUTO-SEED POLICY: no auto-seed — `yakcc init` creates an empty SQLite
//   registry and prints a next-step hint. Rationale — the seed corpus is a
//   yakcc-monorepo artifact and should not be silently ingested into every new
//   project. The user decides whether to seed (e.g. they may only want their
//   own project's atoms). `yakcc seed` is documented in the next-steps output.
//
//   PEER REGISTRATION: when `--peer <url>` is provided, init writes the peer
//   URL into `.yakccrc.json` under `federation.peers[]` and immediately runs
//   `yakcc federation mirror` against it. This gives the user a populated
//   registry from their team peer on first boot. URL validation is strict (must
//   be http: or https:) to fail fast on typos.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import type { Logger } from "../index.js";
import { hooksClaudeCodeInstall } from "./hooks-install.js";
import { registryInit } from "./registry-init.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Subdirectory for all yakcc operational data: DB, telemetry, etc. */
const YAKCC_DIR = ".yakcc";

/** Subdirs created inside .yakcc/ by init. */
const YAKCC_SUBDIRS = ["registry", "telemetry", "config"] as const;

/** Default registry path relative to target. */
const DEFAULT_REGISTRY_SUBPATH = ".yakcc/registry.sqlite";

/** Config file written at the project root (see DEC-CLI-INIT-001). */
const RC_FILENAME = ".yakccrc.json";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Shape of the .yakccrc.json written by init. */
interface YakccRc {
  version: 1;
  registry: {
    path: string;
  };
  federation?: {
    peers: string[];
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Read .yakccrc.json from target directory, or return null if absent/corrupt.
 */
function readRc(targetDir: string): YakccRc | null {
  const rcPath = join(targetDir, RC_FILENAME);
  if (!existsSync(rcPath)) return null;
  try {
    return JSON.parse(readFileSync(rcPath, "utf-8")) as YakccRc;
  } catch {
    return null;
  }
}

/** Write .yakccrc.json to target directory. */
function writeRc(targetDir: string, rc: YakccRc): void {
  writeFileSync(join(targetDir, RC_FILENAME), `${JSON.stringify(rc, null, 2)}\n`, "utf-8");
}

/**
 * Validate a peer URL string: must be http:// or https://.
 * Returns null on success, an error message on failure.
 */
function validatePeerUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return `peer URL must use http or https scheme, got: ${parsed.protocol}`;
    }
    return null;
  } catch {
    return `invalid peer URL: ${url}`;
  }
}

// ---------------------------------------------------------------------------
// Command handler
// ---------------------------------------------------------------------------

/**
 * Handler for `yakcc init [--target <dir>] [--peer <url>]`.
 *
 * Steps performed (in order):
 *  1. Create `.yakcc/` directory with standard subdirectories.
 *  2. Call `registryInit` to create `.yakcc/registry.sqlite` (idempotent).
 *  3. Call `hooksClaudeCodeInstall` to wire `.claude/settings.json` (idempotent).
 *  4. If `--peer <url>`: register peer in `.yakccrc.json` and mirror blocks.
 *  5. Write starter `.yakccrc.json` with sensible defaults.
 *  6. Print next-steps guidance.
 *
 * Idempotency: existing `.yakcc/` is detected; registry and hook install are
 * themselves idempotent; `.yakccrc.json` is merged (peer list appended, not
 * replaced).
 *
 * @param argv   - Remaining argv after `init` has been consumed.
 * @param logger - Output sink; defaults to CONSOLE_LOGGER in production.
 * @returns Process exit code (0 = success, 1 = error).
 */
export async function init(argv: readonly string[], logger: Logger): Promise<number> {
  // -------------------------------------------------------------------------
  // 1. Parse arguments
  // -------------------------------------------------------------------------

  let parsed: ReturnType<
    typeof parseArgs<{
      options: {
        target: { type: "string"; short: "t" };
        peer: { type: "string" };
      };
    }>
  >;

  try {
    parsed = parseArgs({
      args: [...argv],
      options: {
        target: { type: "string", short: "t" },
        peer: { type: "string" },
      },
      allowPositionals: false,
      strict: true,
    });
  } catch (err) {
    logger.error(`error: ${(err as Error).message}`);
    logger.error("Usage: yakcc init [--target <dir>] [--peer <url>]");
    return 1;
  }

  const targetDir = parsed.values.target ?? ".";
  const peerUrl = parsed.values.peer;

  // -------------------------------------------------------------------------
  // 2. Validate peer URL (fail fast before touching the filesystem)
  // -------------------------------------------------------------------------

  if (peerUrl !== undefined) {
    const urlError = validatePeerUrl(peerUrl);
    if (urlError !== null) {
      logger.error(`error: ${urlError}`);
      return 1;
    }
  }

  // -------------------------------------------------------------------------
  // 3. Create .yakcc/ directory with standard subdirectories
  // -------------------------------------------------------------------------

  const yakccDir = join(targetDir, YAKCC_DIR);
  const yakccDirExists = existsSync(yakccDir);

  try {
    mkdirSync(yakccDir, { recursive: true });
    for (const sub of YAKCC_SUBDIRS) {
      mkdirSync(join(yakccDir, sub), { recursive: true });
    }
  } catch (err) {
    logger.error(`error: cannot create ${yakccDir}: ${String(err)}`);
    return 1;
  }

  if (yakccDirExists) {
    logger.log("  .yakcc/  (already exists — skipping directory creation)");
  } else {
    logger.log("  .yakcc/  created");
  }

  // -------------------------------------------------------------------------
  // 4. Initialize the registry (idempotent via openRegistry/applyMigrations)
  // -------------------------------------------------------------------------

  const registryPath = join(targetDir, DEFAULT_REGISTRY_SUBPATH);
  const registryCode = await registryInit(["--path", registryPath], logger);
  if (registryCode !== 0) {
    return registryCode;
  }

  // -------------------------------------------------------------------------
  // 5. Install Claude Code hook (idempotent via settings.json read-modify-write)
  // -------------------------------------------------------------------------

  const installCode = await hooksClaudeCodeInstall(["--target", targetDir], logger);
  if (installCode !== 0) {
    return installCode;
  }

  // -------------------------------------------------------------------------
  // 6. Write / update .yakccrc.json
  // -------------------------------------------------------------------------

  const existingRc = readRc(targetDir);

  let rc: YakccRc;
  if (existingRc !== null) {
    // Merge: keep existing fields; append peer if not already present.
    rc = existingRc;
    if (peerUrl !== undefined) {
      if (rc.federation === undefined) {
        rc = { ...rc, federation: { peers: [peerUrl] } };
      } else if (!rc.federation.peers.includes(peerUrl)) {
        rc = { ...rc, federation: { peers: [...rc.federation.peers, peerUrl] } };
      }
    }
  } else {
    // Fresh init: build the starter config.
    rc = {
      version: 1,
      registry: { path: DEFAULT_REGISTRY_SUBPATH },
      ...(peerUrl !== undefined ? { federation: { peers: [peerUrl] } } : {}),
    };
  }

  try {
    writeRc(targetDir, rc);
  } catch (err) {
    logger.error(`error: cannot write ${join(targetDir, RC_FILENAME)}: ${String(err)}`);
    return 1;
  }

  logger.log(`  ${RC_FILENAME}  written`);

  // -------------------------------------------------------------------------
  // 7. Mirror peer (if --peer provided)
  // -------------------------------------------------------------------------

  if (peerUrl !== undefined) {
    logger.log(`  mirroring blocks from peer: ${peerUrl}`);
    // Lazy import to avoid importing runFederation at the top level — it pulls
    // in @yakcc/federation which is only needed when --peer is provided.
    const { runFederation } = await import("./federation.js");
    const mirrorCode = await runFederation(
      ["mirror", "--remote", peerUrl, "--registry", registryPath],
      logger,
    );
    if (mirrorCode !== 0) {
      logger.error(`warning: mirror from ${peerUrl} failed (exit ${mirrorCode}) — continuing`);
      // Non-fatal: the registry is initialized; the user can re-run federation mirror later.
    }
  }

  // -------------------------------------------------------------------------
  // 8. Print next-steps guidance
  // -------------------------------------------------------------------------

  logger.log("");
  logger.log("yakcc initialized. Next steps:");
  logger.log("");
  logger.log("  # Ingest the yakcc seed corpus (optional)");
  logger.log("  yakcc seed");
  logger.log("");
  logger.log("  # Shave your own TypeScript source files into registry atoms");
  logger.log("  yakcc shave src/my-utils.ts");
  logger.log("");
  logger.log("  # Semantic search");
  logger.log('  yakcc query "<describe what you need>"');
  logger.log("");
  logger.log("  See docs/USING_YAKCC.md for the full guide.");

  return 0;
}
