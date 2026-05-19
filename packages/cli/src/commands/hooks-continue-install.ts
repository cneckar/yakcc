// SPDX-License-Identifier: MIT
//
// hooks-continue-install.ts — marker-file installer for Continue.dev
//
// @decision DEC-CLI-HOOKS-CONTINUE-INSTALL-001
// title: hooks-continue-install writes a marker file ~/.continue/yakcc-continue-hook.json;
//        no live hook wiring yet (Continue.dev's extension API not yet instrumented)
// status: accepted (WI-656-S1)
// rationale:
//   Continue.dev (continue.continue VS Code / JetBrains extension) does not yet
//   expose a synchronous tool-call interception surface via a stable Node.js API
//   as of the WI-656 implementation date. This installer mirrors the pattern from
//   DEC-CLI-HOOKS-CURSOR-INSTALL-001 and DEC-CLI-HOOKS-CLINE-INSTALL-001:
//
//   (A) Creates ~/.continue/ if absent.
//   (B) Writes ~/.continue/yakcc-continue-hook.json — a structured marker that
//       records the hook command, description, session env var, installation
//       timestamp, and an explicit note about the API-surface limitation.
//
//   IDEMPOTENT: if the marker already exists (identified by the _yakcc sentinel
//   field), logs "already installed" and exits 0 without re-writing.
//
//   No settings.json wiring is performed because Continue.dev's extension-settings
//   schema for hook interception is not yet documented. The marker file documents
//   the intent; a follow-up WI activates real wiring when the API stabilises.
//
//   The continue config directory is determined by the overrideContinueDir parameter
//   (for testing) or defaults to ~/.continue/ (primary probe per
//   DEC-CLI-IDE-DETECT-SEMANTICS-001).

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import type { Logger } from "../index.js";
import { removeInstalledHooks, updateInstalledHooks } from "../lib/rc-helpers.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Marker filename written to the Continue config dir by the install command. */
const CONTINUE_HOOK_MARKER_FILENAME = "yakcc-continue-hook.json";

/** Sentinel field that identifies a yakcc-installed Continue marker. */
const YAKCC_CONTINUE_MARKER = "yakcc-hook-v1-continue";

/** Subprocess command to be invoked for Continue tool-call interception (future). */
const HOOK_COMMAND = "yakcc hook-intercept";

// ---------------------------------------------------------------------------
// Marker helpers
// ---------------------------------------------------------------------------

interface ContinueMarker {
  _yakcc: string;
  [key: string]: unknown;
}

function readMarker(markerPath: string): ContinueMarker | null {
  if (!existsSync(markerPath)) return null;
  try {
    return JSON.parse(readFileSync(markerPath, "utf-8")) as ContinueMarker;
  } catch {
    return null;
  }
}

function isYakccInstalled(markerPath: string): boolean {
  const marker = readMarker(markerPath);
  return marker !== null && marker._yakcc === YAKCC_CONTINUE_MARKER;
}

// ---------------------------------------------------------------------------
// Command handler
// ---------------------------------------------------------------------------

/**
 * Handler for the Continue.dev hook installer.
 *
 * Called by `yakcc init` when Continue.dev is detected (DEC-CLI-IDE-INSTALLER-DISPATCH-001).
 * Can also be invoked standalone (e.g., tests, future `yakcc hooks continue install` verb).
 *
 * Install: creates ~/.continue/ (or the override dir) and writes a yakcc marker
 *   file documenting the intended hook wiring. Idempotent.
 * Uninstall: removes the yakcc marker file.
 *
 * @param argv              - Remaining argv. Accepts `--target <dir>` and `--uninstall`.
 * @param logger            - Output sink.
 * @param overrideContinueDir - Optional absolute path to use instead of ~/.continue/.
 *   Used by tests to avoid writing to the real home directory.
 * @returns Process exit code (0 = success, 1 = error).
 */
export async function hooksContinueInstall(
  argv: readonly string[],
  logger: Logger,
  overrideContinueDir?: string,
  overrideTargetDir?: string,
): Promise<number> {
  let parsed: ReturnType<
    typeof parseArgs<{
      options: {
        target: { type: "string"; short: "t" };
        uninstall: { type: "boolean" };
      };
    }>
  >;

  try {
    parsed = parseArgs({
      args: [...argv],
      options: {
        target: { type: "string", short: "t" },
        uninstall: { type: "boolean" },
      },
      allowPositionals: false,
      strict: true,
    });
  } catch (err) {
    logger.error(`error: ${(err as Error).message}`);
    return 1;
  }

  // Resolve the Continue.dev config directory.
  // overrideContinueDir is the injection seam for tests; production uses ~/.continue/.
  const continueDir = overrideContinueDir ?? join(homedir(), ".continue");
  const markerPath = join(continueDir, CONTINUE_HOOK_MARKER_FILENAME);
  // Project dir for .yakccrc.json: overrideTargetDir for tests, or --target flag.
  // Undefined when neither is provided (called from yakcc init, which manages rc itself).
  const targetDir = overrideTargetDir ?? parsed.values.target;

  try {
    mkdirSync(continueDir, { recursive: true });
  } catch (err) {
    logger.error(`error: cannot create ${continueDir}: ${String(err)}`);
    return 1;
  }

  // --- Uninstall path ---
  if (parsed.values.uninstall) {
    if (!isYakccInstalled(markerPath)) {
      logger.log("yakcc continue hook not installed — nothing to uninstall.");
      return 0;
    }
    try {
      rmSync(markerPath);
    } catch (err) {
      logger.error(`error: cannot remove ${markerPath}: ${String(err)}`);
      return 1;
    }
    if (targetDir !== undefined) removeInstalledHooks(targetDir, ["continue"]);
    logger.log(`yakcc continue hook marker removed: ${markerPath}`);
    return 0;
  }

  // --- Install path ---
  if (isYakccInstalled(markerPath)) {
    logger.log(`yakcc continue hook already installed at ${markerPath} (idempotent).`);
    return 0;
  }

  const marker: ContinueMarker = {
    command: HOOK_COMMAND,
    description: "yakcc tool-call interception hook for Continue.dev",
    sessionEnvVar: "CONTINUE_SESSION_ID",
    telemetryPrefix: "continue",
    installedAt: new Date().toISOString(),
    _yakcc: YAKCC_CONTINUE_MARKER,
    note:
      "Continue.dev (continue.continue) does not yet expose synchronous tool-call " +
      "interception via a stable Node.js API. This marker documents the intended " +
      "wiring (DEC-CLI-HOOKS-CONTINUE-INSTALL-001). When the Continue.dev API " +
      "stabilises, hook activation requires no reinstall.",
  };

  try {
    writeFileSync(markerPath, `${JSON.stringify(marker, null, 2)}\n`, "utf-8");
  } catch (err) {
    logger.error(`error: cannot write marker ${markerPath}: ${String(err)}`);
    return 1;
  }

  if (targetDir !== undefined) updateInstalledHooks(targetDir, ["continue"]);
  logger.log(`yakcc continue hook marker installed: ${markerPath}`);
  logger.log(
    "note: Continue.dev tool-call interception API not yet stable — see marker for details.",
  );
  return 0;
}
