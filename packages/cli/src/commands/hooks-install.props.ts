// SPDX-License-Identifier: MIT
// @decision DEC-V2-PROPTEST-CLI-HOOKS-INSTALL-001: hand-authored property-test corpus for
// @yakcc/cli commands/hooks-install.ts. Two-file pattern: this file (.props.ts) is
// vitest-free and holds the corpus; the sibling .props.test.ts is the vitest harness.
// Status: accepted (WI-87-fill-cli)
// Rationale: hooksClaudeCodeInstall() contains rich pure logic (applyInstall,
// applyUninstall, isYakccEntry, buildYakccHookObject) that is private but whose
// observable effects are fully captured through the command's settings.json output.
// Using a real OS tmpdir keeps the tests filesystem-honest with no mocking.
// The tmpdir is unique per property run to avoid cross-contamination.
//
// ---------------------------------------------------------------------------
// Property-test corpus for commands/hooks-install.ts atoms
//
// Atoms covered (all tested via hooksClaudeCodeInstall public API):
//   applyInstall    (A1) — adds yakcc PreToolUse hook entry to ClaudeSettings
//   applyUninstall  (A2) — removes yakcc hook entry from ClaudeSettings
//   isYakccEntry    (A3) — correctly identifies entries with _yakcc marker
//   idempotency     (A4) — install+install and uninstall+uninstall are no-ops
//
// Properties exercised (7):
//   1. install on empty dir → exit 0, settings.json created with hook entry
//   2. install on empty dir → settings.json contains "yakcc-hook-v1" marker
//   3. install twice (idempotent) → exit 0 both times
//   4. install twice → settings.json has exactly one yakcc hook entry
//   5. uninstall when not installed → exit 0 + "nothing to uninstall" message
//   6. install then uninstall → exit 0, yakcc entry removed from settings.json
//   7. install then uninstall → settings.json no longer contains "yakcc-hook-v1"
//
// External boundary: OS filesystem (tmpdir). No registry or network I/O.
// ---------------------------------------------------------------------------

import { mkdirSync, readFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as fc from "fast-check";
import { CollectingLogger } from "../index.js";
import { hooksClaudeCodeInstall } from "./hooks-install.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a fresh isolated temp directory for one property run.
 * Caller must clean up with rmSync(dir, { recursive: true, force: true }).
 */
function makeTmpTarget(): string {
  return mkdtempSync(join(tmpdir(), "yakcc-hooks-prop-"));
}

/**
 * Read the parsed ClaudeSettings JSON from <targetDir>/.claude/settings.json.
 * Returns null if the file does not exist or is not valid JSON.
 */
function readSettings(targetDir: string): Record<string, unknown> | null {
  const p = join(targetDir, ".claude", "settings.json");
  try {
    return JSON.parse(readFileSync(p, "utf-8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Count the number of hook entries in settings.json that contain
 * the "yakcc-hook-v1" marker.
 */
function countYakccEntries(settings: Record<string, unknown>): number {
  const hooks = settings.hooks as Record<string, unknown[]> | undefined;
  if (hooks === undefined) return 0;
  let count = 0;
  for (const entries of Object.values(hooks)) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (typeof entry !== "object" || entry === null) continue;
      const hookList = (entry as Record<string, unknown>).hooks;
      if (!Array.isArray(hookList)) continue;
      for (const h of hookList) {
        if (
          typeof h === "object" &&
          h !== null &&
          (h as Record<string, unknown>)._yakcc === "yakcc-hook-v1"
        ) {
          count++;
        }
      }
    }
  }
  return count;
}

// ---------------------------------------------------------------------------
// A1 + A3: install on a fresh directory
// ---------------------------------------------------------------------------

/**
 * prop_install_on_empty_dir_exits_0_and_creates_settings
 *
 * Installing on a fresh directory returns exit code 0 and creates
 * .claude/settings.json containing at least one yakcc hook entry.
 *
 * Invariant: applyInstall() always adds the yakcc entry when it is absent;
 * the file I/O path always succeeds on a writable directory.
 */
export const prop_install_on_empty_dir_exits_0_and_creates_settings = fc.asyncProperty(
  fc.constant(undefined),
  async () => {
    const targetDir = makeTmpTarget();
    try {
      const logger = new CollectingLogger();
      const code = await hooksClaudeCodeInstall(["--target", targetDir], logger);
      if (code !== 0) return false;
      const settings = readSettings(targetDir);
      if (settings === null) return false;
      return countYakccEntries(settings) >= 1;
    } finally {
      rmSync(targetDir, { recursive: true, force: true });
    }
  },
);

/**
 * prop_install_settings_contains_yakcc_marker
 *
 * After install, settings.json contains the string "yakcc-hook-v1"
 * (the canonical marker written by buildYakccHookObject()).
 *
 * Invariant: The marker is always present after a successful install so
 * isYakccEntry() can locate and remove it during uninstall.
 */
export const prop_install_settings_contains_yakcc_marker = fc.asyncProperty(
  fc.constant(undefined),
  async () => {
    const targetDir = makeTmpTarget();
    try {
      const logger = new CollectingLogger();
      await hooksClaudeCodeInstall(["--target", targetDir], logger);
      const raw = (() => {
        try {
          return readFileSync(join(targetDir, ".claude", "settings.json"), "utf-8");
        } catch {
          return "";
        }
      })();
      return raw.includes("yakcc-hook-v1");
    } finally {
      rmSync(targetDir, { recursive: true, force: true });
    }
  },
);

// ---------------------------------------------------------------------------
// A4: idempotency — install twice
// ---------------------------------------------------------------------------

/**
 * prop_install_is_idempotent_exit_codes
 *
 * Calling install twice on the same directory returns exit code 0 both times.
 *
 * Invariant: applyInstall() detects the existing entry and skips the add;
 * no error is returned on repeated installs.
 */
export const prop_install_is_idempotent_exit_codes = fc.asyncProperty(
  fc.constant(undefined),
  async () => {
    const targetDir = makeTmpTarget();
    try {
      const logger1 = new CollectingLogger();
      const code1 = await hooksClaudeCodeInstall(["--target", targetDir], logger1);
      const logger2 = new CollectingLogger();
      const code2 = await hooksClaudeCodeInstall(["--target", targetDir], logger2);
      return code1 === 0 && code2 === 0;
    } finally {
      rmSync(targetDir, { recursive: true, force: true });
    }
  },
);

/**
 * prop_install_twice_produces_exactly_one_yakcc_entry
 *
 * Calling install twice results in exactly one yakcc hook entry in settings.json.
 *
 * Invariant: applyInstall() is idempotent — it does not duplicate the entry
 * on the second call. The "already installed" guard prevents double-insertion.
 */
export const prop_install_twice_produces_exactly_one_yakcc_entry = fc.asyncProperty(
  fc.constant(undefined),
  async () => {
    const targetDir = makeTmpTarget();
    try {
      await hooksClaudeCodeInstall(["--target", targetDir], new CollectingLogger());
      await hooksClaudeCodeInstall(["--target", targetDir], new CollectingLogger());
      const settings = readSettings(targetDir);
      if (settings === null) return false;
      return countYakccEntries(settings) === 1;
    } finally {
      rmSync(targetDir, { recursive: true, force: true });
    }
  },
);

// ---------------------------------------------------------------------------
// A2: uninstall — remove the entry
// ---------------------------------------------------------------------------

/**
 * prop_uninstall_when_not_installed_exits_0
 *
 * Calling uninstall on a directory where yakcc was never installed returns
 * exit code 0 with a "nothing to uninstall" message.
 *
 * Invariant: applyUninstall() handles the absent-entry case gracefully;
 * idempotent in the "already clean" direction.
 */
export const prop_uninstall_when_not_installed_exits_0 = fc.asyncProperty(
  fc.constant(undefined),
  async () => {
    const targetDir = makeTmpTarget();
    // Pre-create .claude/ so the command doesn't fail on mkdirSync
    mkdirSync(join(targetDir, ".claude"), { recursive: true });
    try {
      const logger = new CollectingLogger();
      const code = await hooksClaudeCodeInstall(["--target", targetDir, "--uninstall"], logger);
      if (code !== 0) return false;
      return logger.logLines.some((l) => l.includes("nothing to uninstall"));
    } finally {
      rmSync(targetDir, { recursive: true, force: true });
    }
  },
);

/**
 * prop_install_then_uninstall_removes_entry
 *
 * After install followed by uninstall, the yakcc entry is no longer in settings.json.
 *
 * Invariant: applyUninstall() correctly filters out entries identified by
 * isYakccEntry(), leaving settings.json with zero yakcc entries.
 */
export const prop_install_then_uninstall_removes_entry = fc.asyncProperty(
  fc.constant(undefined),
  async () => {
    const targetDir = makeTmpTarget();
    try {
      await hooksClaudeCodeInstall(["--target", targetDir], new CollectingLogger());
      const codeUninstall = await hooksClaudeCodeInstall(
        ["--target", targetDir, "--uninstall"],
        new CollectingLogger(),
      );
      if (codeUninstall !== 0) return false;
      // After uninstall, no yakcc entries should remain
      const settings = readSettings(targetDir);
      if (settings === null) return true; // file removed entirely is also fine
      return countYakccEntries(settings) === 0;
    } finally {
      rmSync(targetDir, { recursive: true, force: true });
    }
  },
);

/**
 * prop_install_then_uninstall_marker_absent_from_settings
 *
 * After install+uninstall, settings.json no longer contains the
 * "yakcc-hook-v1" marker string.
 *
 * Invariant: The marker removal is complete — no residual marker text remains
 * anywhere in the JSON after uninstall.
 */
export const prop_install_then_uninstall_marker_absent_from_settings = fc.asyncProperty(
  fc.constant(undefined),
  async () => {
    const targetDir = makeTmpTarget();
    try {
      await hooksClaudeCodeInstall(["--target", targetDir], new CollectingLogger());
      await hooksClaudeCodeInstall(["--target", targetDir, "--uninstall"], new CollectingLogger());
      const raw = (() => {
        try {
          return readFileSync(join(targetDir, ".claude", "settings.json"), "utf-8");
        } catch {
          return ""; // file absent is also valid post-uninstall
        }
      })();
      return !raw.includes("yakcc-hook-v1");
    } finally {
      rmSync(targetDir, { recursive: true, force: true });
    }
  },
);
