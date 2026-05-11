// SPDX-License-Identifier: MIT
// @decision DEC-CLI-HOOKS-CURSOR-INSTALL-001
// title: yakcc hooks cursor install — write production hook wiring for Cursor
// status: decided (WI-HOOK-PHASE-4-CURSOR, closes #219)
// rationale:
//   Cursor's VS Code extension API does not expose a Node.js-callable hook
//   registration surface as of v1 (same constraint as hooks-claude-code before
//   the Claude Code settings.json hook surface stabilised). Two artefacts are
//   written to the target .cursor/ directory:
//
//   (A) .cursor/settings.json — a yakcc "PreToolUse"-equivalent hook entry in
//       the VS Code settings format. Cursor inherits VS Code's extension host
//       model; a "tasks"-style entry records the hook intent. This is a stub
//       configuration that documents the intended wiring for when Cursor's
//       extension API exposes a synchronous tool-call interception surface.
//
//   (B) .cursor/yakcc-cursor-hook.json — a structured marker file parallel to
//       hooks-claude-code's yakcc-slash-command.json. Records the hook command,
//       description, session-ID env var, and installation timestamp. This is
//       the primary machine-readable artefact consumed by the hooks-cursor
//       package's registerCommand() stub.
//
//   Risk: Cursor surface stability (issue #219 Risk section). If Cursor does not
//   expose synchronous tool-call interception, the latency budget (D-HOOK-3 ≤200ms)
//   cannot be enforced at the IDE level. The install command writes the wiring
//   and documents the limitation in the marker file; it does NOT weaken any budget.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import type { Logger } from "../index.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Marker filename written to .cursor/ by the install command. */
const CURSOR_HOOK_MARKER_FILENAME = "yakcc-cursor-hook.json";

/** Marker placed in cursor settings so the installer can find and remove it. */
const YAKCC_CURSOR_MARKER = "yakcc-hook-v1-cursor";

/** Subprocess command that should be invoked for cursor tool-call interception. */
const HOOK_COMMAND = "yakcc hook-intercept";

// ---------------------------------------------------------------------------
// Settings helpers for .cursor/settings.json
// ---------------------------------------------------------------------------

interface CursorSettings {
  hooks?: Record<string, unknown>;
  [key: string]: unknown;
}

function readCursorSettings(settingsPath: string): CursorSettings {
  if (!existsSync(settingsPath)) return {};
  try {
    return JSON.parse(readFileSync(settingsPath, "utf-8")) as CursorSettings;
  } catch {
    return {};
  }
}

function writeCursorSettings(settingsPath: string, settings: CursorSettings): void {
  writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf-8");
}

function isYakccInstalled(settings: CursorSettings): boolean {
  const hooks = settings.hooks;
  if (hooks == null || typeof hooks !== "object") return false;
  const yakccEntry = hooks.yakcc;
  if (yakccEntry == null || typeof yakccEntry !== "object") return false;
  return (yakccEntry as Record<string, unknown>)._yakcc === YAKCC_CURSOR_MARKER;
}

function applyInstall(settings: CursorSettings): {
  settings: CursorSettings;
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
          description: "yakcc tool-call interception hook for Cursor",
          sessionEnvVar: "CURSOR_SESSION_ID",
          _yakcc: YAKCC_CURSOR_MARKER,
        },
      },
    },
    alreadyInstalled: false,
  };
}

function applyUninstall(settings: CursorSettings): {
  settings: CursorSettings;
  wasInstalled: boolean;
} {
  if (!isYakccInstalled(settings)) {
    return { settings, wasInstalled: false };
  }
  const { yakcc: _removed, ...remainingHooks } = (settings.hooks ?? {}) as Record<string, unknown>;
  const hasRemainingHooks = Object.keys(remainingHooks).length > 0;
  const newSettings: CursorSettings = hasRemainingHooks
    ? { ...settings, hooks: remainingHooks }
    : (({ hooks: _h, ...rest }) => rest)(settings as CursorSettings & { hooks: unknown });
  return { settings: newSettings, wasInstalled: true };
}

// ---------------------------------------------------------------------------
// Command handler
// ---------------------------------------------------------------------------

/**
 * Handler for `yakcc hooks cursor install [--target <dir>] [--uninstall]`.
 *
 * Install: writes a yakcc hook entry to .cursor/settings.json (VS Code settings
 *   format) and a marker file to .cursor/yakcc-cursor-hook.json.
 * Uninstall: removes the yakcc hook entry from .cursor/settings.json.
 * Both paths are idempotent.
 *
 * Limitation (DEC-CLI-HOOKS-CURSOR-INSTALL-001): Cursor does not yet expose
 * synchronous tool-call interception via a stable Node.js API. The install
 * command writes the intended wiring so that, when the API stabilises, the
 * hook subprocess can be activated without a reinstall. The marker file
 * documents this constraint for tooling and human readers.
 *
 * @param argv - Remaining argv after `hooks cursor install` has been consumed.
 * @param logger - Output sink.
 * @returns Process exit code (0 = success, 1 = error).
 */
export async function hooksCursorInstall(argv: readonly string[], logger: Logger): Promise<number> {
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
  const cursorDir = join(targetDir, ".cursor");
  const settingsPath = join(cursorDir, "settings.json");
  const markerPath = join(cursorDir, CURSOR_HOOK_MARKER_FILENAME);

  try {
    mkdirSync(cursorDir, { recursive: true });
  } catch (err) {
    logger.error(`error: cannot create ${cursorDir}: ${String(err)}`);
    return 1;
  }

  // --- Uninstall path ---
  if (values.uninstall) {
    const { settings: updated, wasInstalled } = applyUninstall(readCursorSettings(settingsPath));
    if (!wasInstalled) {
      logger.log("yakcc cursor hook not installed — nothing to uninstall.");
      return 0;
    }
    try {
      writeCursorSettings(settingsPath, updated);
    } catch (err) {
      logger.error(`error: cannot write ${settingsPath}: ${String(err)}`);
      return 1;
    }
    logger.log(`yakcc cursor hook removed from ${settingsPath}`);
    return 0;
  }

  // --- Install path ---
  const { settings: updated, alreadyInstalled } = applyInstall(readCursorSettings(settingsPath));
  try {
    writeCursorSettings(settingsPath, updated);
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
          description: "yakcc tool-call interception hook for Cursor",
          sessionEnvVar: "CURSOR_SESSION_ID",
          telemetryPrefix: "cursor",
          installedAt: new Date().toISOString(),
          note:
            "Cursor does not yet expose synchronous tool-call interception via a stable Node.js API. " +
            "This marker documents the intended wiring (DEC-CLI-HOOKS-CURSOR-INSTALL-001). " +
            "When the Cursor extension API stabilises, hook activation requires no reinstall.",
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

  if (alreadyInstalled) {
    logger.log(`yakcc cursor hook already installed at ${settingsPath} (idempotent).`);
  } else {
    logger.log(`yakcc cursor hook installed at ${settingsPath}`);
    logger.log(`hook command: ${HOOK_COMMAND}`);
    logger.log("session env var: CURSOR_SESSION_ID");
    logger.log(`marker: ${markerPath}`);
    logger.log("note: Cursor tool-call interception API not yet stable — see marker for details.");
  }
  return 0;
}
