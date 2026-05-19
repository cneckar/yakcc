// SPDX-License-Identifier: MIT
// @decision DEC-CLI-HOOKS-WINDSURF-INSTALL-001
// title: yakcc hooks windsurf install — write production hook wiring for Windsurf
// status: decided (WI-687-S3, closes #687 S3)
// rationale:
//   Windsurf (Codeium's AI IDE) uses a VS Code-derived extension host model similar
//   to Cursor. Two artefacts are written to the target .windsurf/ directory:
//
//   (A) .windsurf/settings.json — a yakcc "PreToolUse"-equivalent hook entry in
//       the VS Code settings format. Windsurf inherits VS Code's extension host
//       model; a "tasks"-style entry records the hook intent. This is a stub
//       configuration that documents the intended wiring for when Windsurf's
//       extension API exposes a synchronous tool-call interception surface.
//
//   (B) .windsurf/yakcc-windsurf-hook.json — a structured marker file parallel to
//       hooks-cursor's yakcc-cursor-hook.json. Records the hook command,
//       description, session-ID env var, and installation timestamp. This is
//       the primary machine-readable artefact consumed by the hooks-windsurf
//       package's registerCommand() stub.
//
//   Risk: Windsurf surface stability (mirrors Cursor risk pattern from
//   DEC-CLI-HOOKS-CURSOR-INSTALL-001). If Windsurf does not expose synchronous
//   tool-call interception, the latency budget (D-HOOK-3 ≤200ms) cannot be
//   enforced at the IDE level. The install command writes the wiring and documents
//   the limitation in the marker file; it does NOT weaken any budget.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import type { Logger } from "../index.js";
import { addInstalledHook, removeInstalledHook } from "../lib/rc-hooks.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Marker filename written to .windsurf/ by the install command. */
const WINDSURF_HOOK_MARKER_FILENAME = "yakcc-windsurf-hook.json";

/** Marker placed in windsurf settings so the installer can find and remove it. */
const YAKCC_WINDSURF_MARKER = "yakcc-hook-v1-windsurf";

/** Subprocess command that should be invoked for windsurf tool-call interception. */
const HOOK_COMMAND = "yakcc hook-intercept";

// ---------------------------------------------------------------------------
// Settings helpers for .windsurf/settings.json
// ---------------------------------------------------------------------------

interface WindsurfSettings {
  hooks?: Record<string, unknown>;
  [key: string]: unknown;
}

function readWindsurfSettings(settingsPath: string): WindsurfSettings {
  if (!existsSync(settingsPath)) return {};
  try {
    return JSON.parse(readFileSync(settingsPath, "utf-8")) as WindsurfSettings;
  } catch {
    return {};
  }
}

function writeWindsurfSettings(settingsPath: string, settings: WindsurfSettings): void {
  writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf-8");
}

function isYakccInstalled(settings: WindsurfSettings): boolean {
  const hooks = settings.hooks;
  if (hooks == null || typeof hooks !== "object") return false;
  const yakccEntry = hooks.yakcc;
  if (yakccEntry == null || typeof yakccEntry !== "object") return false;
  return (yakccEntry as Record<string, unknown>)._yakcc === YAKCC_WINDSURF_MARKER;
}

function applyInstall(settings: WindsurfSettings): {
  settings: WindsurfSettings;
  alreadyInstalled: boolean;
} {
  if (isYakccInstalled(settings)) {
    return { settings, alreadyInstalled: true };
  }
  return {
    settings: {
      ...settings,
      hooks: {
        ...(settings.hooks ?? {}),
        yakcc: {
          command: HOOK_COMMAND,
          description: "yakcc tool-call interception hook for Windsurf",
          sessionEnvVar: "WINDSURF_SESSION_ID",
          _yakcc: YAKCC_WINDSURF_MARKER,
        },
      },
    },
    alreadyInstalled: false,
  };
}

function applyUninstall(settings: WindsurfSettings): {
  settings: WindsurfSettings;
  wasInstalled: boolean;
} {
  if (!isYakccInstalled(settings)) {
    return { settings, wasInstalled: false };
  }
  const { yakcc: _removed, ...remainingHooks } = (settings.hooks ?? {}) as Record<string, unknown>;
  const hasRemainingHooks = Object.keys(remainingHooks).length > 0;
  const newSettings: WindsurfSettings = hasRemainingHooks
    ? { ...settings, hooks: remainingHooks }
    : (({ hooks: _h, ...rest }) => rest)(settings as WindsurfSettings & { hooks: unknown });
  return { settings: newSettings, wasInstalled: true };
}

// ---------------------------------------------------------------------------
// Command handler
// ---------------------------------------------------------------------------

/**
 * Handler for `yakcc hooks windsurf install [--target <dir>] [--uninstall]`.
 *
 * Install: writes a yakcc hook entry to .windsurf/settings.json (VS Code settings
 *   format) and a marker file to .windsurf/yakcc-windsurf-hook.json.
 * Uninstall: removes the yakcc hook entry from .windsurf/settings.json.
 * Both paths are idempotent.
 *
 * Limitation (DEC-CLI-HOOKS-WINDSURF-INSTALL-001): Windsurf does not yet expose
 * synchronous tool-call interception via a stable Node.js API. The install
 * command writes the intended wiring so that, when the API stabilises, the
 * hook subprocess can be activated without a reinstall. The marker file
 * documents this constraint for tooling and human readers.
 *
 * @param argv - Remaining argv after `hooks windsurf install` has been consumed.
 * @param logger - Output sink.
 * @returns Process exit code (0 = success, 1 = error).
 */
export async function hooksWindsurfInstall(
  argv: readonly string[],
  logger: Logger,
): Promise<number> {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      target: { type: "string", short: "t" },
      uninstall: { type: "boolean" },
    },
    allowPositionals: false,
    strict: true,
  });

  const targetDir = values.target ?? ".";
  const windsurfDir = join(targetDir, ".windsurf");
  const settingsPath = join(windsurfDir, "settings.json");
  const markerPath = join(windsurfDir, WINDSURF_HOOK_MARKER_FILENAME);

  try {
    mkdirSync(windsurfDir, { recursive: true });
  } catch (err) {
    logger.error(`error: cannot create ${windsurfDir}: ${String(err)}`);
    return 1;
  }

  // --- Uninstall path ---
  if (values.uninstall) {
    const { settings: updated, wasInstalled } = applyUninstall(readWindsurfSettings(settingsPath));
    if (!wasInstalled) {
      logger.log("yakcc windsurf hook not installed — nothing to uninstall.");
      return 0;
    }
    try {
      writeWindsurfSettings(settingsPath, updated);
    } catch (err) {
      logger.error(`error: cannot write ${settingsPath}: ${String(err)}`);
      return 1;
    }
    try {
      removeInstalledHook(targetDir, "windsurf");
    } catch (err) {
      logger.error(`warning: cannot update .yakccrc.json: ${String(err)}`);
    }
    logger.log(`yakcc windsurf hook removed from ${settingsPath}`);
    return 0;
  }

  // --- Install path ---
  const { settings: updated, alreadyInstalled } = applyInstall(readWindsurfSettings(settingsPath));
  try {
    writeWindsurfSettings(settingsPath, updated);
  } catch (err) {
    logger.error(`error: cannot write ${settingsPath}: ${String(err)}`);
    return 1;
  }

  // Write the structured hook marker file.
  try {
    writeFileSync(
      markerPath,
      `${JSON.stringify(
        {
          command: HOOK_COMMAND,
          description: "yakcc tool-call interception hook for Windsurf",
          sessionEnvVar: "WINDSURF_SESSION_ID",
          telemetryPrefix: "windsurf",
          installedAt: new Date().toISOString(),
          note:
            "Windsurf does not yet expose synchronous tool-call interception via a stable Node.js API. " +
            "This marker documents the intended wiring (DEC-CLI-HOOKS-WINDSURF-INSTALL-001). " +
            "When the Windsurf extension API stabilises, hook activation requires no reinstall.",
        },
        null,
        2,
      )}\n`,
      "utf-8",
    );
  } catch (err) {
    logger.error(`warning: cannot write marker file ${markerPath}: ${String(err)}`);
    // Non-fatal: the settings.json update succeeded.
  }

  try {
    addInstalledHook(targetDir, "windsurf");
  } catch (err) {
    logger.error(`warning: cannot update .yakccrc.json: ${String(err)}`);
  }
  if (alreadyInstalled) {
    logger.log(`yakcc windsurf hook already installed at ${settingsPath} (idempotent).`);
  } else {
    logger.log(`yakcc windsurf hook installed at ${settingsPath}`);
    logger.log(`hook command: ${HOOK_COMMAND}`);
    logger.log("session env var: WINDSURF_SESSION_ID");
    logger.log(`marker: ${markerPath}`);
    logger.log(
      "note: Windsurf tool-call interception API not yet stable — see marker for details.",
    );
  }
  return 0;
}
