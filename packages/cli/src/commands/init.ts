// SPDX-License-Identifier: MIT
//
// init.ts — handler for `yakcc init [options]`
//
// First-30-seconds surface for v0.5 GTM. Single command that:
//   1. Creates .yakcc/ directory layout
//   2. Initializes the SQLite registry
//   3. Auto-detects installed IDEs and installs hooks for each
//   4. Seeds the bootstrap corpus (unless --no-seed)
//   5. Writes .yakccrc.json with mode + installedHooks fields
//   6. Prints a concise ≤6-line summary
//
// @decision DEC-CLI-INIT-001
// title: Config-file format, transitive hook install, auto-seed policy
// status: superseded-by-addendum (WI-V05-INIT-COMMAND #204; amended by DEC-CLI-INIT-002)
// rationale:
//   CONFIG FORMAT: `.yakccrc.json` at the target directory root (not inside
//   `.yakcc/`). Rationale — keeps the project config visible at the repo root
//   alongside package.json, .eslintrc, etc. Avoids nesting user-facing config
//   inside the data directory. Alternative `.yakcc/config.json` was rejected
//   because it conflates operational data (SQLite, telemetry) with project
//   configuration. Inline `package.json yakcc:` key was rejected because yakcc
//   is not always used inside a Node.js project.
//
//   TRANSITIVE HOOK INSTALL: yes — `yakcc init` calls each IDE's install function
//   directly (not via shell subprocess). Rationale — composing the real
//   function call ensures the same code path that `yakcc hooks <ide> install`
//   exercises; no duplication, no subprocess overhead, no PATH dependency.
//   DEC-CLI-INDEX-001 establishes the pattern: each command is a callable
//   function, not a subprocess. DEC-CLI-INIT-002 extends this to all four IDEs.
//
//   AUTO-SEED POLICY: changed by DEC-CLI-INIT-002 — `yakcc init` now calls
//   `seedYakccCorpus` by default (the bootstrap corpus, ~3k+ atoms). `--no-seed`
//   is the opt-out that restores the pre-DEC-CLI-INIT-002 quiet-init shape.
//
//   PEER REGISTRATION: when `--peer <url>` is provided, init writes the peer
//   URL into `.yakccrc.json` under `federation.peers[]` and immediately runs
//   `yakcc federation mirror` against it. This gives the user a populated
//   registry from their team peer on first boot. URL validation is strict (must
//   be http: or https:) to fail fast on typos.
//
// @decision DEC-CLI-INIT-002
// title: Single-command `yakcc init` collapses init+seed+hooks-install into one entry;
//        auto-detects IDEs; supersedes the no-auto-seed clause of DEC-CLI-INIT-001
// status: accepted (WI-656-S1)
// rationale:
//   Operator decision 2026-05-17 to collapse the first-touch surface. Every
//   user-facing first-impression flows through `yakcc init`. The 6 new flags
//   (--local, --airgapped, --peer, --skip-hooks, --ide, --no-seed) allow precise
//   control without breaking backward compat for existing --target and --peer usage.
//   IDE auto-detection uses DEC-CLI-IDE-DETECT-SEMANTICS-001 (config-dir probe).
//   Installer dispatch uses a thin table (DEC-CLI-IDE-INSTALLER-DISPATCH-001).
//   Backward compat preserved: --target and --peer semantics unchanged.

import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { type Registry, openRegistry } from "@yakcc/registry";
import type { Logger } from "../index.js";
import { type IdeName, KNOWN_IDE_NAMES, detectInstalledIdes } from "../lib/ide-detect.js";
import { RC_FILENAME, type YakccRc, readRc, writeRc } from "../lib/yakccrc.js";
import { hooksAiderInstall } from "./hooks-aider-install.js";
import { hooksClineInstall } from "./hooks-cline-install.js";
import { hooksContinueInstall } from "./hooks-continue-install.js";
import { hooksCursorInstall } from "./hooks-cursor-install.js";
import { hooksClaudeCodeInstall } from "./hooks-install.js";
import { hooksWindsurfInstall } from "./hooks-windsurf-install.js";
import { registryInit } from "./registry-init.js";
import { seedYakccCorpus } from "./seed-yakcc.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Subdirectory for all yakcc operational data: DB, telemetry, etc. */
const YAKCC_DIR = ".yakcc";

/** Subdirs created inside .yakcc/ by init. */
const YAKCC_SUBDIRS = ["registry", "telemetry", "config"] as const;

/** Default registry path relative to target. */
const DEFAULT_REGISTRY_SUBPATH = ".yakcc/registry.sqlite";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Mode written to .yakccrc.json.
 *
 * - "local": default; no federation peer, offline-first.
 * - "airgapped": explicit offline intent; semantically equivalent to "local"
 *   today (see NG2 — no yakcc.dev server yet); written for forward-compat.
 * - "global": --peer <url> was provided; will mirror from that peer on init.
 */
type YakccMode = "local" | "airgapped" | "global";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

/**
 * Parse a comma-separated --ide value into a list of IdeName.
 * Returns { ok: IdeName[] } on success or { err: string } on invalid input.
 */
function parseIdeList(raw: string): { ok: IdeName[] } | { err: string } {
  const parts = raw.split(",").map((s) => s.trim().toLowerCase());
  const invalid = parts.filter((p) => !(KNOWN_IDE_NAMES as readonly string[]).includes(p));
  if (invalid.length > 0) {
    return {
      err:
        `unknown IDE name(s): ${invalid.join(", ")}. ` +
        `Known IDEs: ${KNOWN_IDE_NAMES.join(", ")}`,
    };
  }
  return { ok: parts as IdeName[] };
}

// ---------------------------------------------------------------------------
// IDE installer dispatch table
//
// @decision DEC-CLI-IDE-INSTALLER-DISPATCH-001
// title: Per-IDE installer functions called via a thin dispatch table inside init.ts,
//        NOT via a generic HookInstaller interface
// status: accepted (WI-656-S1)
// rationale:
//   Generic interface would force the lowest common denominator (marker-file only)
//   and demote Claude Code's rich settings.json wiring. Per-IDE installers preserve
//   surface-specific semantics. The dispatch table is kept here (not in ide-detect.ts)
//   because it depends on the installer imports, and ide-detect.ts must remain pure
//   (no I/O dependencies beyond existsSync).
// ---------------------------------------------------------------------------

/**
 * Install the yakcc hook for a single IDE into the target project directory.
 *
 * For claude-code and cursor this writes a settings.json hook entry (rich wiring).
 * For cline and continue this writes a marker file (surface not yet stable).
 *
 * The cline and continue installers accept an optional overrideDir for test isolation.
 * In production (no overrideDir) they default to os.homedir()-derived paths.
 */
async function installHookForIde(
  ide: IdeName,
  targetDir: string,
  logger: Logger,
  overrideHome?: string,
): Promise<void> {
  const { homedir } = await import("node:os");
  const home = overrideHome ?? homedir();

  switch (ide) {
    case "claude-code": {
      const code = await hooksClaudeCodeInstall(["--target", targetDir], logger);
      if (code !== 0) throw new Error(`claude-code hook install failed (exit ${code})`);
      break;
    }
    case "cursor": {
      const code = await hooksCursorInstall(["--target", targetDir], logger);
      if (code !== 0) throw new Error(`cursor hook install failed (exit ${code})`);
      break;
    }
    case "cline": {
      const { join } = await import("node:path");
      const clineDir = join(home, ".config", "cline");
      const code = await hooksClineInstall([], logger, clineDir, targetDir);
      if (code !== 0) throw new Error(`cline hook install failed (exit ${code})`);
      break;
    }
    case "continue": {
      const { join } = await import("node:path");
      const continueDir = join(home, ".continue");
      const code = await hooksContinueInstall([], logger, continueDir, targetDir);
      if (code !== 0) throw new Error(`continue hook install failed (exit ${code})`);
      break;
    }
    case "windsurf": {
      const code = await hooksWindsurfInstall(["--target", targetDir], logger);
      if (code !== 0) throw new Error(`windsurf hook install failed (exit ${code})`);
      break;
    }
    case "aider": {
      const { join } = await import("node:path");
      const aiderDir = join(home, ".aider");
      const code = await hooksAiderInstall([], logger, aiderDir, targetDir);
      if (code !== 0) throw new Error(`aider hook install failed (exit ${code})`);
      break;
    }
  }
}

// ---------------------------------------------------------------------------
// InitOptions — internal injection seam
// ---------------------------------------------------------------------------

/**
 * Internal options for `init`. Tests inject these to avoid network I/O and
 * provide the bootstrap corpus path.
 */
export interface InitOptions {
  /**
   * Override the home directory used for IDE detection and cline/continue
   * installer default dirs. When omitted, os.homedir() is used.
   * Used by tests to inject a fake HOME without mutating process state.
   */
  overrideHome?: string;
  /**
   * Override path to the bootstrap corpus sqlite for --yakcc seed mode.
   * Forwarded to seedYakccCorpus() (DEC-CLI-SEED-YAKCC-001).
   */
  corpusPath?: string;
}

// ---------------------------------------------------------------------------
// Command handler
// ---------------------------------------------------------------------------

/**
 * Handler for `yakcc init [--target <dir>] [--peer <url>] [--local] [--airgapped]
 *                         [--skip-hooks] [--ide <comma-list>] [--no-seed]`.
 *
 * Steps performed (in order):
 *  1. Parse and validate arguments.
 *  2. Create `.yakcc/` directory with standard subdirectories.
 *  3. Call `registryInit` to create `.yakcc/registry.sqlite` (idempotent).
 *  4. IDE hook installation (unless --skip-hooks):
 *     a. If `--ide <list>`: install for each IDE in the explicit list.
 *     b. Otherwise: auto-detect via detectInstalledIdes() and install for each.
 *  5. Seed the bootstrap corpus (unless --no-seed).
 *  6. If `--peer <url>`: register peer in `.yakccrc.json` and mirror blocks.
 *  7. Write / update `.yakccrc.json` with mode + installedHooks additive fields.
 *  8. Print concise summary (≤6 lines on happy path, G6).
 *
 * Idempotency: existing `.yakcc/` is detected; registry and hook installs are
 * themselves idempotent; `.yakccrc.json` is merged (peer list appended, not
 * replaced; installedHooks merged).
 *
 * @param argv   - Remaining argv after `init` has been consumed.
 * @param logger - Output sink; defaults to CONSOLE_LOGGER in production.
 * @param opts   - Internal options (home override, corpus path for tests).
 * @returns Process exit code (0 = success, 1 = error).
 */
export async function init(
  argv: readonly string[],
  logger: Logger,
  opts?: InitOptions,
): Promise<number> {
  // -------------------------------------------------------------------------
  // 1. Parse arguments
  // -------------------------------------------------------------------------

  let parsed: ReturnType<
    typeof parseArgs<{
      options: {
        target: { type: "string"; short: "t" };
        peer: { type: "string" };
        local: { type: "boolean" };
        airgapped: { type: "boolean" };
        "skip-hooks": { type: "boolean" };
        ide: { type: "string" };
        "no-seed": { type: "boolean" };
      };
    }>
  >;

  try {
    parsed = parseArgs({
      args: [...argv],
      options: {
        target: { type: "string", short: "t" },
        peer: { type: "string" },
        local: { type: "boolean" },
        airgapped: { type: "boolean" },
        "skip-hooks": { type: "boolean" },
        ide: { type: "string" },
        "no-seed": { type: "boolean" },
      },
      allowPositionals: false,
      strict: true,
    });
  } catch (err) {
    logger.error(`error: ${(err as Error).message}`);
    logger.error("Usage: yakcc init [--target <dir>] [--peer <url>] [--local] [--airgapped]");
    logger.error(
      "                  [--skip-hooks] [--ide <claude-code|cursor|cline|continue|windsurf|aider,...>] [--no-seed]",
    );
    return 1;
  }

  const targetDir = parsed.values.target ?? ".";
  const peerUrl = parsed.values.peer;
  const isAirgapped = parsed.values.airgapped === true;
  const skipHooks = parsed.values["skip-hooks"] === true;
  const noSeed = parsed.values["no-seed"] === true;
  const ideRaw = parsed.values.ide;

  // Determine mode (written to .yakccrc.json for forward-compat).
  // Priority: --airgapped > --peer (implies global) > --local > default (local).
  let mode: YakccMode = "local";
  if (isAirgapped) {
    mode = "airgapped";
  } else if (peerUrl !== undefined) {
    mode = "global";
  } else if (parsed.values.local === true) {
    mode = "local";
  }

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
  // 3. Validate --ide list (fail fast before touching the filesystem)
  // -------------------------------------------------------------------------

  let explicitIdes: IdeName[] | null = null;
  if (ideRaw !== undefined) {
    const parseResult = parseIdeList(ideRaw);
    if ("err" in parseResult) {
      logger.error(`error: ${parseResult.err}`);
      return 1;
    }
    explicitIdes = parseResult.ok;
  }

  // -------------------------------------------------------------------------
  // 4. Create .yakcc/ directory with standard subdirectories
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
  // 5. Initialize the registry (idempotent via openRegistry/applyMigrations)
  // -------------------------------------------------------------------------

  const registryPath = join(targetDir, DEFAULT_REGISTRY_SUBPATH);
  const registryCode = await registryInit(["--path", registryPath], logger);
  if (registryCode !== 0) {
    return registryCode;
  }

  // -------------------------------------------------------------------------
  // 6. IDE hook installation (DEC-CLI-IDE-INSTALLER-DISPATCH-001)
  //
  // If --skip-hooks: skip all hook installation.
  // If --ide <list>: install only the specified IDEs (no auto-detect).
  // Otherwise: auto-detect via detectInstalledIdes() and install each.
  // -------------------------------------------------------------------------

  const installedHooks: string[] = [];

  if (!skipHooks) {
    let idesToInstall: IdeName[];

    if (explicitIdes !== null) {
      idesToInstall = explicitIdes;
    } else {
      // Auto-detect: pass overrideHome so tests can control the probe paths.
      const detected = detectInstalledIdes(opts?.overrideHome);
      idesToInstall = detected.map((d) => d.name);
    }

    for (const ide of idesToInstall) {
      try {
        await installHookForIde(ide, targetDir, logger, opts?.overrideHome);
        installedHooks.push(ide);
      } catch (err) {
        logger.error(`warning: ${String(err)} — continuing`);
        // Non-fatal: the registry is initialized; other hooks may still succeed.
      }
    }
  }

  // -------------------------------------------------------------------------
  // 7. Seed bootstrap corpus (unless --no-seed)
  //
  // Default: call seedYakccCorpus() (DEC-CLI-INIT-002 flips the no-auto-seed
  // clause of DEC-CLI-INIT-001). --no-seed restores quiet-init behavior.
  // -------------------------------------------------------------------------

  let seedCount = 0;
  if (!noSeed) {
    let registry: Registry | null = null;
    try {
      registry = await openRegistry(registryPath);
    } catch (err) {
      logger.error(`warning: cannot open registry for seed: ${String(err)} — continuing`);
    }

    if (registry !== null) {
      try {
        seedCount = await seedYakccCorpus(
          registry,
          { ...(opts?.corpusPath !== undefined ? { corpusPath: opts.corpusPath } : {}) },
          logger,
        );
      } catch (err) {
        // Seed failure is non-fatal — the registry is still initialized.
        logger.error(`warning: seed failed: ${String(err)} — continuing`);
      } finally {
        try {
          await registry.close();
        } catch {
          // ignore close error
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // 8. Mirror peer (if --peer provided)
  // -------------------------------------------------------------------------

  if (peerUrl !== undefined) {
    logger.log(`  mirroring blocks from peer: ${peerUrl}`);
    const { runFederation } = await import("./federation.js");
    const mirrorCode = await runFederation(
      ["mirror", "--remote", peerUrl, "--registry", registryPath],
      logger,
    );
    if (mirrorCode !== 0) {
      logger.error(`warning: mirror from ${peerUrl} failed (exit ${mirrorCode}) — continuing`);
    }
  }

  // -------------------------------------------------------------------------
  // 9. Write / update .yakccrc.json
  //
  // New additive fields per DEC-CLI-INIT-002 (NG4: no version bump, additive only):
  //   - mode: "local" | "airgapped" | "global"
  //   - installedHooks: string[] (merged, deduped)
  // -------------------------------------------------------------------------

  const existingRc = readRc(targetDir);

  let rc: YakccRc;
  if (existingRc !== null) {
    // Spread existing rc fields. Ensure registry is always set (a minimal rc created by
    // addInstalledHook in a per-IDE tail call may not have registry yet — WI-759).
    rc = {
      ...existingRc,
      mode,
      registry: existingRc.registry ?? { path: DEFAULT_REGISTRY_SUBPATH },
    };
    if (peerUrl !== undefined) {
      const existingFed = rc.federation as { peers: string[] } | undefined;
      if (existingFed === undefined) {
        rc = { ...rc, federation: { peers: [peerUrl] } };
      } else if (!existingFed.peers.includes(peerUrl)) {
        rc = { ...rc, federation: { peers: [...existingFed.peers, peerUrl] } };
      }
    }
    // Merge installedHooks (dedupe).
    const existingHooks = rc.installedHooks ?? [];
    const merged = [...new Set([...existingHooks, ...installedHooks])];
    rc = { ...rc, installedHooks: merged };
  } else {
    rc = {
      version: 1,
      mode,
      registry: { path: DEFAULT_REGISTRY_SUBPATH },
      ...(peerUrl !== undefined ? { federation: { peers: [peerUrl] } } : {}),
      installedHooks,
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
  // 10. Print concise summary (G6: ≤6 lines on happy path)
  // -------------------------------------------------------------------------

  const hookedLine =
    installedHooks.length > 0
      ? `Hooked into: ${installedHooks.join(", ")}.`
      : skipHooks
        ? "Hooks: skipped (--skip-hooks)."
        : "Hooks: no IDEs detected.";

  const telemetryDir = process.env.YAKCC_TELEMETRY_DIR ?? join(homedir(), ".yakcc", "telemetry");
  logger.log("");
  logger.log(`Installed in ${targetDir}. ${hookedLine} Registry: ${seedCount} atoms.`);
  logger.log(`Telemetry: ${telemetryDir}/<session>.jsonl (written on next Edit/Write tool call)`);

  // @decision DEC-CLI-INIT-NO-IDE-HINT-001 (WI-687-S7 / #746 AC2)
  // title: When auto-detect finds nothing and --skip-hooks was not passed, surface a
  //        structured hint so the first-30-seconds GTM surface does not dead-end silently.
  // status: accepted (WI-746-S7)
  // rationale:
  //   AC2 of #746 requires the user to receive actionable guidance when no IDE config
  //   dirs are found. A silent "Hooks: no IDEs detected." leaves a fresh user with no
  //   recovery path. The hint is non-interactive (parent plan NG6 / DEC-CLI-INIT-002:
  //   init must remain scriptable and non-blocking on stdin). The IDE list is derived
  //   from KNOWN_IDE_NAMES — NOT a hand-typed parallel list — so the hint never drifts
  //   when a future S-slice adds a 7th adapter (Sacred Practice #12 / DEC-WI687-SLICING-001).
  if (!skipHooks && installedHooks.length === 0) {
    logger.log("  Tip: no IDE config dirs found in your home directory. Re-run with");
    logger.log("       `yakcc init --ide <name>` to install for a specific IDE");
    logger.log(`       (supported: ${KNOWN_IDE_NAMES.join(", ")}),`);
    logger.log("       or `yakcc init --skip-hooks` to skip hook setup entirely.");
  }

  return 0;
}
