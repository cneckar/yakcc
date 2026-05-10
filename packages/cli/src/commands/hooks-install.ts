// SPDX-License-Identifier: MIT
// @decision DEC-CLI-HOOKS-INSTALL-002
// title: Replace v0 CLAUDE.md facade with real settings.json hook wiring
// status: decided (WI-V05-CLI-INSTALL-RETIRE-FACADE #203)
// rationale:
//   Per DEC-HOOK-LAYER-001 (docs/adr/hook-layer-architecture.md):
//   D-HOOK-1 → Claude Code is the first IDE target.
//   D-HOOK-2 → tool-call interception via settings.json PreToolUse hook entry
//               for Edit|Write|MultiEdit tool calls.
//   The install command writes the yakcc PreToolUse block to .claude/settings.json
//   (idempotent read-modify-write) and removes the v0 .claude/CLAUDE.md stub
//   (Sacred Practice #12 — no parallel mechanisms may coexist).
//   The hook subprocess (yakcc hook-intercept) is provided by WI-HOOK-PHASE-1-MVP (#216).
//   Uninstall reads settings.json and strips the yakcc-marked entry, then writes back.
//
// Supersedes DEC-CLI-HOOKS-INSTALL-001 (v0 CLAUDE.md stub; WI-009).

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import type { Logger } from "../index.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Claude Code settings.json hook event for pre-tool-call interception (D-HOOK-2). */
const HOOK_EVENT = "PreToolUse";

/** Tool names the yakcc hook intercepts (D-HOOK-2: Edit/Write/MultiEdit). */
const HOOK_MATCHER = "Edit|Write|MultiEdit";

/** Subprocess command Claude Code spawns per intercepted tool call.
 *  Implementation provided by WI-HOOK-PHASE-1-MVP (#216). */
const HOOK_COMMAND = "yakcc hook-intercept";

/** Marker placed on the inner hook object so the installer can find and remove it. */
const YAKCC_MARKER = "yakcc-hook-v1";

// ---------------------------------------------------------------------------
// Types for the settings.json shape
// ---------------------------------------------------------------------------

interface YakccHookObject {
  type: string;
  command: string;
  _yakcc: string;
}

interface HookObject {
  type: string;
  command: string;
  _yakcc?: string | undefined;
}

interface HookEntry {
  matcher: string;
  hooks: HookObject[];
}

interface ClaudeSettings {
  hooks?: Record<string, HookEntry[]>;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Settings helpers
// ---------------------------------------------------------------------------

function readSettings(settingsPath: string): ClaudeSettings {
  if (!existsSync(settingsPath)) return {};
  try {
    return JSON.parse(readFileSync(settingsPath, "utf-8")) as ClaudeSettings;
  } catch {
    // Corrupt or non-JSON settings — start fresh rather than aborting.
    return {};
  }
}

function writeSettings(settingsPath: string, settings: ClaudeSettings): void {
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf-8");
}

function buildYakccHookObject(): YakccHookObject {
  return { type: "command", command: HOOK_COMMAND, _yakcc: YAKCC_MARKER };
}

function isYakccEntry(entry: HookEntry): boolean {
  return entry.hooks.some((h) => h._yakcc === YAKCC_MARKER);
}

// ---------------------------------------------------------------------------
// Install / uninstall logic
// ---------------------------------------------------------------------------

function applyInstall(settings: ClaudeSettings): { settings: ClaudeSettings; alreadyInstalled: boolean } {
  const hooks = settings.hooks ?? {};
  const eventHooks: HookEntry[] = hooks[HOOK_EVENT] ?? [];

  if (eventHooks.some(isYakccEntry)) {
    return { settings, alreadyInstalled: true };
  }

  const newEntry: HookEntry = { matcher: HOOK_MATCHER, hooks: [buildYakccHookObject()] };
  return {
    settings: {
      ...settings,
      hooks: { ...hooks, [HOOK_EVENT]: [...eventHooks, newEntry] },
    },
    alreadyInstalled: false,
  };
}

function applyUninstall(settings: ClaudeSettings): { settings: ClaudeSettings; wasInstalled: boolean } {
  const hooks = settings.hooks ?? {};
  const eventHooks: HookEntry[] = hooks[HOOK_EVENT] ?? [];
  const filtered = eventHooks.filter((e) => !isYakccEntry(e));
  const wasInstalled = filtered.length < eventHooks.length;

  if (!wasInstalled) {
    return { settings, wasInstalled: false };
  }

  const newEventHooks: Record<string, HookEntry[]> = { ...hooks };
  if (filtered.length === 0) {
    delete newEventHooks[HOOK_EVENT];
  } else {
    newEventHooks[HOOK_EVENT] = filtered;
  }

  const hasRemainingHooks = Object.keys(newEventHooks).length > 0;
  const newSettings: ClaudeSettings = hasRemainingHooks
    ? { ...settings, hooks: newEventHooks }
    : (({ hooks: _h, ...rest }) => rest)(settings as ClaudeSettings & { hooks: unknown });

  return { settings: newSettings, wasInstalled: true };
}

// ---------------------------------------------------------------------------
// Command handler
// ---------------------------------------------------------------------------

/**
 * Handler for `yakcc hooks claude-code install [--target <dir>] [--uninstall]`.
 *
 * Install: writes a yakcc PreToolUse hook entry to .claude/settings.json
 *   and removes the v0 .claude/CLAUDE.md stub if present.
 * Uninstall: removes the yakcc hook entry from .claude/settings.json.
 * Both paths are idempotent.
 *
 * @param argv - Remaining argv after `hooks claude-code install` has been consumed.
 * @param logger - Output sink.
 * @returns Process exit code (0 = success, 1 = error).
 */
export async function hooksClaudeCodeInstall(
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
  const claudeDir = join(targetDir, ".claude");
  const settingsPath = join(claudeDir, "settings.json");
  const claudeMdPath = join(claudeDir, "CLAUDE.md");

  try {
    mkdirSync(claudeDir, { recursive: true });
  } catch (err) {
    logger.error(`error: cannot create ${claudeDir}: ${String(err)}`);
    return 1;
  }

  // --- Uninstall path ---
  if (values.uninstall) {
    const { settings: updated, wasInstalled } = applyUninstall(readSettings(settingsPath));
    if (!wasInstalled) {
      logger.log("yakcc hook not installed — nothing to uninstall.");
      return 0;
    }
    try {
      writeSettings(settingsPath, updated);
    } catch (err) {
      logger.error(`error: cannot write ${settingsPath}: ${String(err)}`);
      return 1;
    }
    logger.log(`yakcc hook removed from ${settingsPath}`);
    return 0;
  }

  // --- Install path ---
  const { settings: updated, alreadyInstalled } = applyInstall(readSettings(settingsPath));
  try {
    writeSettings(settingsPath, updated);
  } catch (err) {
    logger.error(`error: cannot write ${settingsPath}: ${String(err)}`);
    return 1;
  }

  // Remove the v0 CLAUDE.md facade stub (Sacred Practice #12 — no parallel mechanisms).
  if (existsSync(claudeMdPath)) {
    try {
      rmSync(claudeMdPath);
    } catch (err) {
      logger.error(`warning: cannot remove v0 stub ${claudeMdPath}: ${String(err)}`);
      // Non-fatal: the main install succeeded.
    }
  }

  if (alreadyInstalled) {
    logger.log(`yakcc hook already installed at ${settingsPath} (idempotent).`);
  } else {
    logger.log(`yakcc hook installed at ${settingsPath}`);
    logger.log(`tool-call interception: ${HOOK_MATCHER} → ${HOOK_COMMAND}`);
  }
  return 0;
}
