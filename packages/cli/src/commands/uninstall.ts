// SPDX-License-Identifier: MIT
//
// uninstall.ts — handler for `yakcc uninstall [options]`
//
// The symmetric off-switch for `yakcc init`. Removes the yakcc hook from every
// IDE that S1 init recorded in `.yakccrc.json`, or falls back to detectInstalledIdes().
//
// @decision DEC-CLI-UNINSTALL-COMMAND-001
// title: `yakcc uninstall` top-level verb; default removes hooks but preserves data;
//        `--purge` removes `.yakcc/` and `.yakccrc.json`; `--ide <list>` targets specific IDEs
// status: accepted (WI-656-S2)
// rationale:
//   Operator directive 2026-05-17 (#656). Default-preserve-data is the safe behavior —
//   `--purge` is the explicit opt-in for destructive removal. Symmetric with `yakcc init`.
//   Non-interactive per parent plan NG6; the summary line is the visibility mechanism.
//
// @decision DEC-CLI-UNINSTALL-DETECTION-001
// title: 3-tier detection — explicit `--ide` list → `.yakccrc.json installedHooks` → detectInstalledIdes() fallback
// status: accepted (WI-656-S2)
// rationale:
//   Primary path uses the precise install-time inventory S1 init wrote. Fallback handles
//   projects whose `.yakccrc.json` predates S1 or was never created via unified `init`.
//   Avoids a new public API on `ide-detect.ts` (Sacred Practice #12 — no parallel authority).
//   Per-IDE installers are idempotent on uninstall, so an over-broad fallback is safe.
//
// @decision DEC-CLI-UNINSTALL-PURGE-001
// title: `--purge` is non-interactive; summary log line announces "purged" prominently
// status: accepted (WI-656-S2)
// rationale:
//   Consistent with parent plan NG6 (no interactive prompts). Scriptability is preserved.
//   Visibility is via the summary line, not a confirmation gate. Uses rmSync with
//   { recursive: true, force: true } per C4 (cross-platform path safety).

import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { Logger } from "../index.js";
import { type IdeName, KNOWN_IDE_NAMES, detectInstalledIdes } from "../lib/ide-detect.js";
import { hooksClineInstall } from "./hooks-cline-install.js";
import { hooksContinueInstall } from "./hooks-continue-install.js";
import { hooksCursorInstall } from "./hooks-cursor-install.js";
import { hooksClaudeCodeInstall } from "./hooks-install.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Subdirectory for all yakcc operational data — removed on `--purge`. */
const YAKCC_DIR = ".yakcc";

/** Config file at project root — read (for installedHooks) and mutated or deleted. */
const RC_FILENAME = ".yakccrc.json";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Flexible rc schema — only the fields uninstall.ts needs are typed; the rest
 * are preserved verbatim (EC-S2-I3: version stays 1, additive-only, no field removal).
 */
interface YakccRc {
  version: number;
  installedHooks?: string[];
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Options injection seam (mirrors init.ts InitOptions)
// ---------------------------------------------------------------------------

/**
 * Internal options for `uninstall`. Tests inject these to avoid writing to
 * the real HOME directory.
 *
 * @property overrideHome - Substitute for os.homedir() during IDE detection
 *   and cline/continue directory resolution. Mirrors InitOptions.overrideHome.
 */
export interface UninstallOptions {
  overrideHome?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Read `.yakccrc.json` from target directory, or return null if absent/corrupt.
 * Parsing errors are silently swallowed and treated as "no rc" — the caller
 * falls through to the detectInstalledIdes() tier.
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

/**
 * Parse a comma-separated `--ide` value into a list of IdeName.
 * Returns `{ ok: IdeName[] }` on success, `{ err: string }` on invalid input.
 *
 * Mirrors init.ts's parseIdeList() — identical logic, same error shape (EC-S2-T6).
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
// Per-IDE uninstall dispatch
//
// Mirrors init.ts's installHookForIde() but flips --uninstall.
// Uses the same static dispatch table (DEC-CLI-IDE-INSTALLER-DISPATCH-001).
// No generic HookInstaller interface — per-IDE installers preserve their
// surface-specific semantics (EC-S2-I2).
// ---------------------------------------------------------------------------

/**
 * Dispatch to the per-IDE installer with --uninstall flag set.
 *
 * For claude-code and cursor: delegates to the settings.json-based uninstall.
 * For cline and continue: delegates to the marker-file-based uninstall.
 *
 * Returns the exit code from the delegated installer (0 = success / already absent).
 * The per-IDE installers are idempotent: absent marker → log message → exit 0.
 */
async function uninstallHookForIde(
  ide: IdeName,
  targetDir: string,
  logger: Logger,
  overrideHome?: string,
): Promise<number> {
  const home = overrideHome ?? homedir();

  switch (ide) {
    case "claude-code":
      return hooksClaudeCodeInstall(["--target", targetDir, "--uninstall"], logger);
    case "cursor":
      return hooksCursorInstall(["--target", targetDir, "--uninstall"], logger);
    case "cline":
      return hooksClineInstall(["--uninstall"], logger, join(home, ".config", "cline"));
    case "continue":
      return hooksContinueInstall(["--uninstall"], logger, join(home, ".continue"));
  }
}

// ---------------------------------------------------------------------------
// Command handler
// ---------------------------------------------------------------------------

/**
 * Handler for `yakcc uninstall [--target <dir>] [--purge] [--ide <list>]`.
 *
 * Steps performed (in order):
 *  1. Parse and validate arguments (strict; fail fast before filesystem I/O).
 *  2. Resolve targetDir (default ".").
 *  3. Determine the IDE list to uninstall from (DEC-CLI-UNINSTALL-DETECTION-001):
 *     a. If --ide <list>: use explicit list (validated; no rc or detection consulted).
 *     b. Else if .yakccrc.json has non-empty installedHooks: use that array.
 *     c. Else: call detectInstalledIdes(overrideHome) and use the result.
 *  4. For each IDE: call uninstallHookForIde(); log failures as warnings (non-fatal).
 *  5. If NOT --purge: update .yakccrc.json (if it exists):
 *       --ide path: remove only the targeted IDEs from installedHooks.
 *       default path: set installedHooks to [].
 *       All other rc fields preserved verbatim (EC-S2-I3).
 *  6. If --purge: rmSync(.yakcc/, recursive+force) and rmSync(.yakccrc.json, force).
 *  7. Emit a concise summary line (≤6 lines total; "purged" word required when --purge).
 *  8. Return 0 on success; 1 only on flag-parse or invalid --ide errors.
 *
 * Idempotency: per-IDE installers log "not installed — nothing to uninstall" and
 * return 0 when the hook is already absent. Two consecutive uninstall calls both exit 0.
 *
 * @param argv   - Remaining argv after `uninstall` has been consumed by runCli.
 * @param logger - Output sink; defaults to CONSOLE_LOGGER in production.
 * @param opts   - Internal options (home override for tests).
 * @returns Process exit code (0 = success, 1 = error).
 */
export async function uninstall(
  argv: readonly string[],
  logger: Logger,
  opts?: UninstallOptions,
): Promise<number> {
  // -------------------------------------------------------------------------
  // 1. Parse arguments
  // -------------------------------------------------------------------------

  let parsed: ReturnType<
    typeof parseArgs<{
      options: {
        target: { type: "string"; short: "t" };
        purge: { type: "boolean" };
        ide: { type: "string" };
      };
    }>
  >;

  try {
    parsed = parseArgs({
      args: [...argv],
      options: {
        target: { type: "string", short: "t" },
        purge: { type: "boolean" },
        ide: { type: "string" },
      },
      allowPositionals: false,
      strict: true,
    });
  } catch (err) {
    logger.error(`error: ${(err as Error).message}`);
    logger.error(
      "Usage: yakcc uninstall [--target <dir>] [--purge] [--ide <claude-code|cursor|cline|continue,...>]",
    );
    return 1;
  }

  const targetDir = parsed.values.target ?? ".";
  const doPurge = parsed.values.purge === true;
  const ideRaw = parsed.values.ide;

  // -------------------------------------------------------------------------
  // 2. Validate --ide list (fail fast before touching the filesystem)
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
  // 3. Determine IDE list per DEC-CLI-UNINSTALL-DETECTION-001
  //
  // Tier 1: explicit --ide <list> (already validated above)
  // Tier 2: .yakccrc.json installedHooks (non-empty array)
  // Tier 3: detectInstalledIdes() fallback
  // -------------------------------------------------------------------------

  let idesToUninstall: IdeName[];

  if (explicitIdes !== null) {
    // Tier 1: caller gave us an explicit list — do not consult rc or detection
    idesToUninstall = explicitIdes;
  } else {
    const rc = readRc(targetDir);
    if (rc !== null && Array.isArray(rc.installedHooks) && rc.installedHooks.length > 0) {
      // Tier 2: .yakccrc.json has a non-empty installedHooks inventory
      // Filter to known IDE names (defensive against corrupted rc files)
      idesToUninstall = rc.installedHooks.filter((name): name is IdeName =>
        (KNOWN_IDE_NAMES as readonly string[]).includes(name),
      );
    } else {
      // Tier 3: fallback to live detection (covers projects that used legacy
      // per-IDE installers before `yakcc init` unified the surface)
      const detected = detectInstalledIdes(opts?.overrideHome);
      idesToUninstall = detected.map((d) => d.name);
    }
  }

  // -------------------------------------------------------------------------
  // 4. Per-IDE uninstall loop
  //
  // Failures are non-fatal (logged as warnings). Mirrors init.ts's pattern of
  // continuing after a per-IDE error so partial uninstall is still useful.
  // -------------------------------------------------------------------------

  const removedIdes: IdeName[] = [];

  for (const ide of idesToUninstall) {
    try {
      const code = await uninstallHookForIde(ide, targetDir, logger, opts?.overrideHome);
      if (code === 0) {
        removedIdes.push(ide);
      } else {
        logger.error(`warning: uninstall from ${ide} returned exit ${code} — continuing`);
      }
    } catch (err) {
      logger.error(`warning: uninstall from ${ide} failed: ${String(err)} — continuing`);
    }
  }

  // -------------------------------------------------------------------------
  // 5. Update .yakccrc.json after a default (non-purge) uninstall
  //
  // If --ide was used: remove only the targeted IDEs from installedHooks.
  // If no --ide (rc or detect path): set installedHooks to [].
  // Skip if .yakccrc.json doesn't exist.
  //
  // EC-S2-I3: all fields except installedHooks are preserved verbatim.
  // -------------------------------------------------------------------------

  if (!doPurge) {
    const rc = readRc(targetDir);
    if (rc !== null) {
      let updatedHooks: string[];
      if (explicitIdes !== null) {
        // --ide path: remove only the targeted IDEs from the inventory
        updatedHooks = (rc.installedHooks ?? []).filter(
          (h) => !explicitIdes?.includes(h as IdeName),
        );
      } else {
        // Default path: clear the entire installedHooks array
        updatedHooks = [];
      }
      const updated: YakccRc = { ...rc, installedHooks: updatedHooks };
      try {
        writeFileSync(
          join(targetDir, RC_FILENAME),
          `${JSON.stringify(updated, null, 2)}\n`,
          "utf-8",
        );
      } catch (err) {
        logger.error(`warning: cannot update ${RC_FILENAME}: ${String(err)}`);
      }
    }
  }

  // -------------------------------------------------------------------------
  // 6. --purge: remove .yakcc/ and .yakccrc.json (DEC-CLI-UNINSTALL-PURGE-001)
  //
  // Runs AFTER the hook-removal loop. Uses rmSync with { force: true } so
  // absent files/dirs are silently ignored (idempotent). Cross-platform paths
  // via join() (C4).
  // -------------------------------------------------------------------------

  if (doPurge) {
    try {
      rmSync(join(targetDir, YAKCC_DIR), { recursive: true, force: true });
    } catch (err) {
      logger.error(`warning: cannot remove ${YAKCC_DIR}: ${String(err)}`);
    }
    try {
      rmSync(join(targetDir, RC_FILENAME), { force: true });
    } catch (err) {
      logger.error(`warning: cannot remove ${RC_FILENAME}: ${String(err)}`);
    }
  }

  // -------------------------------------------------------------------------
  // 7. Emit concise summary (G6: ≤6 lines total)
  //
  // The summary line MUST contain "purged" when --purge is active
  // (DEC-CLI-UNINSTALL-PURGE-001 / EC-S2-T3 / EC-S2-T8).
  // -------------------------------------------------------------------------

  const absTargetDir = resolve(targetDir);

  const removedLine =
    removedIdes.length > 0
      ? `Removed from: ${removedIdes.join(", ")}.`
      : "No hooks removed (nothing was installed).";

  if (doPurge) {
    logger.log(`${removedLine} Purged .yakcc/ and ${RC_FILENAME} at ${absTargetDir}.`);
  } else {
    logger.log(`${removedLine} Registry preserved at ${join(absTargetDir, YAKCC_DIR)}.`);
  }

  return 0;
}
