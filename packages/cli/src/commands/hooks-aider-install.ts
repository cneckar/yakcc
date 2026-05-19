// SPDX-License-Identifier: MIT
//
// hooks-aider-install.ts — marker-file installer for Aider CLI tool
//
// @decision DEC-CLI-HOOKS-AIDER-INSTALL-001
// title: hooks-aider-install writes a marker file ~/.aider/yakcc-aider-hook.json;
//        no live --lint-cmd / --test-cmd wiring yet (YAML mutation deferred)
// status: accepted (wi-687-s4-aider-adapter)
// rationale:
//   Aider (https://aider.chat) is a CLI tool that exposes hook surfaces via
//   --lint-cmd and --test-cmd flags on .aider.conf.yml. Direct YAML mutation
//   introduces byte-identity round-trip risk (key ordering, comments, anchors);
//   the marker-file pattern mirrors the cline/continue approach:
//
//   (A) Creates ~/.aider/ if absent (Aider auto-creates this on first run
//       to store chat history and cache).
//   (B) Writes ~/.aider/yakcc-aider-hook.json — a structured marker that
//       records the hook command, description, session env var, installation
//       timestamp, and an explicit note about the YAML deferral. This marker
//       is the primary machine-readable artefact for future tooling that
//       activates the hook once the byte-identity contract is designed.
//
//   The install command is IDEMPOTENT: if the marker already exists (identified
//   by the _yakcc sentinel field), it logs a "already installed" message and
//   exits 0 without re-writing. This matches the cline installer pattern.
//
//   No .aider.conf.yml wiring is performed in this slice. When the byte-identity
//   round-trip contract is established, a follow-up WI can activate real hook
//   wiring without requiring users to reinstall — the marker file already
//   documents the intent.
//
//   The aider config directory is determined by the overrideAiderDir parameter
//   (for testing) or defaults to ~/.aider/ (primary probe per
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

/** Marker filename written to the Aider config dir by the install command. */
const AIDER_HOOK_MARKER_FILENAME = "yakcc-aider-hook.json";

/** Sentinel field that identifies a yakcc-installed Aider marker. */
const YAKCC_AIDER_MARKER = "yakcc-hook-v1-aider";

/** Subprocess command to be invoked for Aider tool-call interception (future). */
const HOOK_COMMAND = "yakcc hook-intercept";

// ---------------------------------------------------------------------------
// Marker helpers
// ---------------------------------------------------------------------------

interface AiderMarker {
  _yakcc: string;
  [key: string]: unknown;
}

function readMarker(markerPath: string): AiderMarker | null {
  if (!existsSync(markerPath)) return null;
  try {
    return JSON.parse(readFileSync(markerPath, "utf-8")) as AiderMarker;
  } catch {
    return null;
  }
}

function isYakccInstalled(markerPath: string): boolean {
  const marker = readMarker(markerPath);
  return marker !== null && marker._yakcc === YAKCC_AIDER_MARKER;
}

// ---------------------------------------------------------------------------
// Command handler
// ---------------------------------------------------------------------------

/**
 * Handler for the Aider hook installer.
 *
 * Called by `yakcc init` when Aider is detected (DEC-CLI-IDE-INSTALLER-DISPATCH-001).
 * Can also be invoked standalone (e.g., tests, `yakcc hooks aider install` verb).
 *
 * Install: creates ~/.aider/ (or the override dir) and writes a yakcc marker
 *   file documenting the intended hook wiring. Idempotent.
 * Uninstall: removes the yakcc marker file.
 *
 * @param argv           - Remaining argv. Accepts `--target <dir>` and `--uninstall`.
 * @param logger         - Output sink.
 * @param overrideAiderDir - Optional absolute path to use instead of ~/.aider/.
 *   Used by tests to avoid writing to the real home directory.
 * @returns Process exit code (0 = success, 1 = error).
 */
export async function hooksAiderInstall(
  argv: readonly string[],
  logger: Logger,
  overrideAiderDir?: string,
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

  // Resolve the Aider config directory.
  // overrideAiderDir is the injection seam for tests; production uses ~/.aider/.
  const aiderDir = overrideAiderDir ?? join(homedir(), ".aider");
  const markerPath = join(aiderDir, AIDER_HOOK_MARKER_FILENAME);
  // Project dir for .yakccrc.json: overrideTargetDir for tests, or --target flag.
  // Undefined when neither is provided (called from yakcc init, which manages rc itself).
  const targetDir = overrideTargetDir ?? parsed.values.target;

  try {
    mkdirSync(aiderDir, { recursive: true });
  } catch (err) {
    logger.error(`error: cannot create ${aiderDir}: ${String(err)}`);
    return 1;
  }

  // --- Uninstall path ---
  if (parsed.values.uninstall) {
    if (!isYakccInstalled(markerPath)) {
      logger.log("yakcc aider hook not installed — nothing to uninstall.");
      return 0;
    }
    try {
      rmSync(markerPath);
    } catch (err) {
      logger.error(`error: cannot remove ${markerPath}: ${String(err)}`);
      return 1;
    }
    if (targetDir !== undefined) removeInstalledHooks(targetDir, ["aider"]);
    logger.log(`yakcc aider hook marker removed: ${markerPath}`);
    return 0;
  }

  // --- Install path ---
  if (isYakccInstalled(markerPath)) {
    logger.log(`yakcc aider hook already installed at ${markerPath} (idempotent).`);
    return 0;
  }

  const marker: AiderMarker = {
    command: HOOK_COMMAND,
    description: "yakcc tool-call interception hook for Aider",
    sessionEnvVar: "AIDER_SESSION_ID",
    telemetryPrefix: "aider",
    installedAt: new Date().toISOString(),
    _yakcc: YAKCC_AIDER_MARKER,
    note:
      "Aider (https://aider.chat) is a CLI tool that exposes hook surfaces via " +
      "`--lint-cmd` and `--test-cmd` flags on `.aider.conf.yml`. This marker " +
      "documents the intended wiring (DEC-CLI-HOOKS-AIDER-INSTALL-001). Direct " +
      "YAML mutation of `.aider.conf.yml` is deferred to a follow-up WI to preserve " +
      "byte-identity round-trip. When the wiring is activated, hook activation " +
      "requires no reinstall.",
  };

  try {
    writeFileSync(markerPath, `${JSON.stringify(marker, null, 2)}\n`, "utf-8");
  } catch (err) {
    logger.error(`error: cannot write marker ${markerPath}: ${String(err)}`);
    return 1;
  }

  if (targetDir !== undefined) updateInstalledHooks(targetDir, ["aider"]);
  logger.log(`yakcc aider hook marker installed: ${markerPath}`);
  logger.log(
    "note: Aider hook wiring via --lint-cmd/--test-cmd deferred — see marker for details.",
  );
  return 0;
}
