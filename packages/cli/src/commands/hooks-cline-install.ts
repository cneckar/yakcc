// SPDX-License-Identifier: MIT
//
// hooks-cline-install.ts — marker-file installer for Cline VS Code extension
//
// @decision DEC-CLI-HOOKS-CLINE-INSTALL-001
// title: hooks-cline-install writes a marker file ~/.config/cline/yakcc-cline-hook.json;
//        no live hook wiring yet (Cline's extension API surface not yet documented)
// status: accepted (WI-656-S1)
// rationale:
//   Cline's VS Code extension (saoudrizwan.claude-dev) does not expose a
//   synchronous tool-call interception surface via a stable Node.js API as of
//   the WI-656 implementation date. This installer mirrors the pattern from
//   DEC-CLI-HOOKS-CURSOR-INSTALL-001 (cursor marker-file approach):
//
//   (A) Creates ~/.config/cline/ if absent.
//   (B) Writes ~/.config/cline/yakcc-cline-hook.json — a structured marker that
//       records the hook command, description, session env var, installation
//       timestamp, and an explicit note about the API-surface limitation. This
//       marker is the primary machine-readable artefact for future tooling that
//       activates the hook once Cline's API stabilises.
//
//   The install command is IDEMPOTENT: if the marker already exists (identified
//   by the _yakcc sentinel field), it logs a "already installed" message and
//   exits 0 without re-writing. This matches the cursor installer pattern.
//
//   No settings.json wiring is performed (unlike claude-code and cursor) because
//   Cline's extension-settings schema is not yet documented. When the surface
//   stabilises, a follow-up WI can activate real hook wiring without requiring
//   users to reinstall — the marker file already documents the intent.
//
//   The cline config directory is determined by the overrideClineDir parameter
//   (for testing) or defaults to ~/.config/cline/ (primary probe per
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

/** Marker filename written to the Cline config dir by the install command. */
const CLINE_HOOK_MARKER_FILENAME = "yakcc-cline-hook.json";

/** Sentinel field that identifies a yakcc-installed Cline marker. */
const YAKCC_CLINE_MARKER = "yakcc-hook-v1-cline";

/** Subprocess command to be invoked for Cline tool-call interception (future). */
const HOOK_COMMAND = "yakcc hook-intercept";

// ---------------------------------------------------------------------------
// Marker helpers
// ---------------------------------------------------------------------------

interface ClineMarker {
  _yakcc: string;
  [key: string]: unknown;
}

function readMarker(markerPath: string): ClineMarker | null {
  if (!existsSync(markerPath)) return null;
  try {
    return JSON.parse(readFileSync(markerPath, "utf-8")) as ClineMarker;
  } catch {
    return null;
  }
}

function isYakccInstalled(markerPath: string): boolean {
  const marker = readMarker(markerPath);
  return marker !== null && marker._yakcc === YAKCC_CLINE_MARKER;
}

// ---------------------------------------------------------------------------
// Command handler
// ---------------------------------------------------------------------------

/**
 * Handler for the Cline hook installer.
 *
 * Called by `yakcc init` when Cline is detected (DEC-CLI-IDE-INSTALLER-DISPATCH-001).
 * Can also be invoked standalone (e.g., tests, future `yakcc hooks cline install` verb).
 *
 * Install: creates ~/.config/cline/ (or the override dir) and writes a yakcc marker
 *   file documenting the intended hook wiring. Idempotent.
 * Uninstall: removes the yakcc marker file.
 *
 * @param argv           - Remaining argv. Accepts `--target <dir>` and `--uninstall`.
 * @param logger         - Output sink.
 * @param overrideClineDir - Optional absolute path to use instead of ~/.config/cline/.
 *   Used by tests to avoid writing to the real home directory.
 * @returns Process exit code (0 = success, 1 = error).
 */
export async function hooksClineInstall(
  argv: readonly string[],
  logger: Logger,
  overrideClineDir?: string,
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

  // Resolve the Cline config directory.
  // overrideClineDir is the injection seam for tests; production uses ~/.config/cline/.
  const clineDir = overrideClineDir ?? join(homedir(), ".config", "cline");
  const markerPath = join(clineDir, CLINE_HOOK_MARKER_FILENAME);
  // Project dir for .yakccrc.json: overrideTargetDir for tests, or --target flag.
  // Undefined when neither is provided (called from yakcc init, which manages rc itself).
  const targetDir = overrideTargetDir ?? parsed.values.target;

  try {
    mkdirSync(clineDir, { recursive: true });
  } catch (err) {
    logger.error(`error: cannot create ${clineDir}: ${String(err)}`);
    return 1;
  }

  // --- Uninstall path ---
  if (parsed.values.uninstall) {
    if (!isYakccInstalled(markerPath)) {
      logger.log("yakcc cline hook not installed — nothing to uninstall.");
      return 0;
    }
    try {
      rmSync(markerPath);
    } catch (err) {
      logger.error(`error: cannot remove ${markerPath}: ${String(err)}`);
      return 1;
    }
    if (targetDir !== undefined) removeInstalledHooks(targetDir, ["cline"]);
    logger.log(`yakcc cline hook marker removed: ${markerPath}`);
    return 0;
  }

  // --- Install path ---
  if (isYakccInstalled(markerPath)) {
    logger.log(`yakcc cline hook already installed at ${markerPath} (idempotent).`);
    return 0;
  }

  const marker: ClineMarker = {
    command: HOOK_COMMAND,
    description: "yakcc tool-call interception hook for Cline",
    sessionEnvVar: "CLINE_SESSION_ID",
    telemetryPrefix: "cline",
    installedAt: new Date().toISOString(),
    _yakcc: YAKCC_CLINE_MARKER,
    note:
      "Cline (saoudrizwan.claude-dev) does not yet expose synchronous tool-call " +
      "interception via a stable Node.js API. This marker documents the intended " +
      "wiring (DEC-CLI-HOOKS-CLINE-INSTALL-001). When the Cline extension API " +
      "stabilises, hook activation requires no reinstall.",
  };

  try {
    writeFileSync(markerPath, `${JSON.stringify(marker, null, 2)}\n`, "utf-8");
  } catch (err) {
    logger.error(`error: cannot write marker ${markerPath}: ${String(err)}`);
    return 1;
  }

  if (targetDir !== undefined) updateInstalledHooks(targetDir, ["cline"]);
  logger.log(`yakcc cline hook marker installed: ${markerPath}`);
  logger.log("note: Cline tool-call interception API not yet stable — see marker for details.");
  return 0;
}
