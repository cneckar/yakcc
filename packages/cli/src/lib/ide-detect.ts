// SPDX-License-Identifier: MIT
//
// ide-detect.ts — canonical IDE-detection library for yakcc CLI
//
// @decision DEC-CLI-IDE-DETECT-PLACEMENT-001
// title: IDE-detection logic lives in packages/cli/src/lib/ide-detect.ts, NOT colocated in init.ts
// status: accepted (WI-656-S1)
// rationale:
//   Both `init` and `uninstall` consume the detection function; placing it under
//   `commands/` would make it look like a CLI verb. Sacred Practice #12 demands a
//   single authority for "which IDEs are present on this machine." Any IDE-aware
//   code path (init, uninstall, future telemetry-tagging) MUST consult this module.
//
// @decision DEC-CLI-IDE-DETECT-SEMANTICS-001
// title: IDE detection probes "config dir exists", NOT "binary in $PATH" or "app running"
// status: accepted (WI-656-S1)
// rationale:
//   Detection-by-config-dir is uniform across IDEs (Cline/Continue are VS Code
//   extensions, not binaries); avoids subprocess spawn (B6a-air-gap-clean);
//   uninstall finds what install installed (false-positive < false-negative cost).
//   The probe is: does the IDE's config directory exist? If a user uninstalled the
//   IDE but left the config dir, we still detect it — that is the correct behavior
//   because our hook lives in the config dir and we need to be able to uninstall it.
//
// NO node:child_process import — detection is pure existsSync, no shell-out (B6a gate).

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Union of all IDE identifiers known to yakcc's detection library.
 *
 * - `"claude-code"`: Anthropic Claude Code CLI / extension
 * - `"cursor"`:      Cursor editor (forked VS Code)
 * - `"cline"`:       Cline VS Code extension (saoudrizwan.claude-dev)
 * - `"continue"`:    Continue.dev VS Code / JetBrains extension
 *
 * Note: "codex" is explicitly excluded per NG1 / DEC-CLI-INIT-002 (#220 closed
 * not-planned). Do not add it here without a new WI reversing that decision.
 */
export type IdeName = "claude-code" | "cursor" | "cline" | "continue";

/**
 * A detected IDE entry — the config directory is confirmed to exist.
 *
 * `installed: true` narrows the type for callers who want to assert that the
 * detection actually fired (vs. a candidate that was probed but not found).
 */
export interface DetectedIde {
  /** Canonical IDE identifier. */
  name: IdeName;
  /** Absolute path to the IDE's config directory (confirmed to exist). */
  configDir: string;
  /** Always true for entries returned by detectInstalledIdes(). */
  installed: true;
}

// ---------------------------------------------------------------------------
// Config-dir path resolution helpers (platform-specific per §2.2 of the plan)
// ---------------------------------------------------------------------------

/**
 * Returns candidate config directories for each supported IDE, ordered by
 * probe priority (primary first, fallbacks after).
 *
 * Paths are expanded from the provided `home` directory. No shell-out, no $PATH scan.
 *
 * The returned map is consumed by detectInstalledIdes() which probes each
 * candidate path with existsSync until one is found per IDE.
 *
 * @internal — exported for testing only.
 */
export function buildCandidatePaths(home: string): Record<IdeName, readonly string[]> {
  const platform = process.platform as "darwin" | "linux" | "win32" | string;

  // Cursor config dir — platform-specific (DEC-CLI-IDE-DETECT-SEMANTICS-001)
  const cursorCandidates: string[] = (() => {
    if (platform === "darwin") {
      return [join(home, "Library", "Application Support", "Cursor")];
    }
    if (platform === "win32") {
      const appdata = process.env.APPDATA;
      if (appdata !== undefined) {
        return [join(appdata, "Cursor")];
      }
      // Fallback if APPDATA is not set on Windows
      return [join(home, "AppData", "Roaming", "Cursor")];
    }
    // Linux (and anything else)
    return [join(home, ".config", "Cursor")];
  })();

  // Cline: `~/.config/cline/` on all platforms, with VS Code extension marker as
  // a secondary probe. The extension marker path allows detection even before
  // the user has opened Cline's settings panel (which creates ~/.config/cline/).
  const clineCandidates: string[] = [
    join(home, ".config", "cline"),
    // VS Code extension dir marker — check the containing directory prefix since
    // the actual extension dir includes a version suffix.
    join(home, ".vscode", "extensions", "saoudrizwan.claude-dev"),
  ];

  // Continue.dev: `~/.continue/` on all platforms (documented in Continue's docs).
  // Optionally also check for the VS Code extension marker as a secondary probe.
  const continueCandidates: string[] = [
    join(home, ".continue"),
    join(home, ".vscode", "extensions", "continue.continue"),
  ];

  return {
    "claude-code": [join(home, ".claude")],
    cursor: cursorCandidates,
    cline: clineCandidates,
    continue: continueCandidates,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Detect which IDEs are present on this machine by probing known config dirs.
 *
 * This is a pure-function-equivalent (given a fixed filesystem state). The only
 * I/O it performs is existsSync calls — no network, no subprocess, no $PATH
 * scan. Tests override the home directory via the optional `overrideHome`
 * parameter to inject a fake home directory without mutating process state.
 *
 * @decision DEC-CLI-IDE-DETECT-SEMANTICS-001 — probe is "config dir exists,"
 *   not "binary in $PATH" or "app running." False positives (config dir exists
 *   but app uninstalled) are preferred over false negatives (app installed but
 *   config dir missing), because our hook lives in the config dir and uninstall
 *   must be able to find what install put there.
 *
 * @param overrideHome - Optional home directory override for testing. When
 *   omitted, uses os.homedir(). Tests MUST use this parameter rather than
 *   mutating process.env.HOME to avoid state leakage between tests.
 *
 * @returns Array of DetectedIde entries, one per IDE whose config dir exists.
 *   Empty array if no IDEs are detected. Order is stable: claude-code, cursor,
 *   cline, continue.
 */
export function detectInstalledIdes(overrideHome?: string): DetectedIde[] {
  const home = overrideHome ?? homedir();
  const candidates = buildCandidatePaths(home);

  const detected: DetectedIde[] = [];

  for (const [name, paths] of Object.entries(candidates) as [IdeName, readonly string[]][]) {
    for (const configDir of paths) {
      if (existsSync(configDir)) {
        detected.push({ name, configDir, installed: true });
        break; // First matching candidate wins; don't emit duplicate entries per IDE.
      }
    }
  }

  return detected;
}

/**
 * All IDE names that yakcc can detect and install hooks for.
 *
 * Callers (e.g. `yakcc init --ide <list>`) validate user-supplied IDE names
 * against this set. Any name not in this set is an error.
 */
export const KNOWN_IDE_NAMES: readonly IdeName[] = ["claude-code", "cursor", "cline", "continue"];
