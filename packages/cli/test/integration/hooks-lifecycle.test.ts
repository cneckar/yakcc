// SPDX-License-Identifier: MIT
//
// hooks-lifecycle.test.ts — round-trip hook lifecycle harness for all IDE adapters
//
// @decision DEC-687-S1-ADAPTER-COUNT
// title: Harness covers 5 production-wired adapters; codex deferred (no CLI IDE adapter)
// status: amended (WI-687-S3 adds windsurf)
// rationale:
//   The CLI's production surface (KNOWN_IDE_NAMES in ide-detect.ts,
//   installHookForIde/uninstallHookForIde in init.ts/uninstall.ts) contains
//   5 adapters: claude-code, cursor, cline, continue, windsurf. There is no `codex`
//   IDE adapter in the CLI; hooks-codex exists as a hooks-base sibling package but is
//   not wired into installHookForIde/uninstallHookForIde/KNOWN_IDE_NAMES.
//   Adding a codex lifecycle case would require touching packages/cli/src/**, which
//   is forbidden by this slice's scope manifest. The codex gap is recorded here
//   explicitly so future planners do not silently rediscover it.
//
//   KNOWN SKIPPED: codex — no CLI IDE adapter; deferred to a follow-up WI once
//   (if) codex becomes a real CLI IDE adapter.
//
// @decision DEC-687-S1-ENTRY-SEAM
// title: Tests call init()/uninstall() in-process via overrideHome — NOT via spawned binary
// status: accepted (WI-687-S1)
// rationale:
//   The handlers are the binary's only meaningful logic. In-process calls avoid
//   a dist/-build dependency and exercise the real production code path without mocking.
//   The overrideHome seam is a documented production feature of InitOptions /
//   UninstallOptions, not a test-only hack.
//
// @decision DEC-687-S1-BYTE-IDENTITY-SCOPE
// title: Round-trip byte-identity is asserted on hook artefacts; cline/continue
//        strip installedAt before comparison
// status: accepted (WI-687-S1)
// rationale:
//   The hook artefact is the property under test (presence/absence of the yakcc
//   entry). .yakccrc.json is rewritten every init for mode reasons and is excluded.
//   cline/continue marker files embed installedAt: new Date().toISOString() which
//   is intentionally regenerated on each fresh install. The byte-identity assertion
//   strips this field before comparing to verify "no information loss across
//   uninstall/reinstall beyond what production code intentionally regenerates".
//   A future slice can decide whether installedAt should be stable across re-installs.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Logger } from "../../src/index.js";
import { CollectingLogger } from "../../src/index.js";
import { init } from "../../src/commands/init.js";
import { uninstall } from "../../src/commands/uninstall.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Marker sentinel values — mirrors the installer constants (cross-check). */
const SENTINELS = {
  "claude-code": "yakcc-hook-v1",
  cursor: "yakcc-hook-v1-cursor",
  cline: "yakcc-hook-v1-cline",
  continue: "yakcc-hook-v1-continue",
  windsurf: "yakcc-hook-v1-windsurf",
} as const;

type Adapter = keyof typeof SENTINELS;
const ADAPTERS: readonly Adapter[] = ["claude-code", "cursor", "cline", "continue", "windsurf"] as const;

// ---------------------------------------------------------------------------
// Suite-level HOME sentinel guard
//
// Captures the existence + mtime of real user IDE config dirs BEFORE any tests
// run. The afterAll block re-checks and fails loudly if any changed.
// This is the "no writes to real HOME" invariant from the Evaluation Contract.
// ---------------------------------------------------------------------------

interface HomeDirSnapshot {
  path: string;
  existedAtStart: boolean;
  mtimeAtStart: number | null;
}

const REAL_HOME = process.env.HOME ?? "";
const HOME_SENTINEL_PATHS = [
  join(REAL_HOME, ".claude"),
  join(REAL_HOME, ".cursor"),
  join(REAL_HOME, ".config", "cline"),
  join(REAL_HOME, ".continue"),
  join(REAL_HOME, ".windsurf"),
];

let homeDirSnapshots: HomeDirSnapshot[] = [];

beforeAll(() => {
  // Snapshot real user IDE config dirs before any test runs.
  homeDirSnapshots = HOME_SENTINEL_PATHS.map((p) => {
    const existed = existsSync(p);
    let mtime: number | null = null;
    if (existed) {
      try {
        const { statSync } = require("node:fs") as typeof import("node:fs");
        mtime = statSync(p).mtimeMs;
      } catch {
        mtime = null;
      }
    }
    return { path: p, existedAtStart: existed, mtimeAtStart: mtime };
  });
});

afterAll(() => {
  // Re-check each real IDE config dir. Fail if existence or mtime changed.
  for (const snap of homeDirSnapshots) {
    const existsNow = existsSync(snap.path);
    expect(
      existsNow,
      `HOME sentinel violated: ${snap.path} existence changed (was ${snap.existedAtStart}, now ${existsNow})`,
    ).toBe(snap.existedAtStart);

    if (snap.existedAtStart && snap.mtimeAtStart !== null) {
      try {
        const { statSync } = require("node:fs") as typeof import("node:fs");
        const mtimeNow = statSync(snap.path).mtimeMs;
        expect(
          mtimeNow,
          `HOME sentinel violated: ${snap.path} mtime changed (was ${snap.mtimeAtStart}, now ${mtimeNow}) — tests must not write to real HOME`,
        ).toBe(snap.mtimeAtStart);
      } catch {
        // stat failed — path may have been deleted. Caught by existence check above.
      }
    }
  }
});

// ---------------------------------------------------------------------------
// Per-test scratch helpers
// ---------------------------------------------------------------------------

interface Scratch {
  rootDir: string;
  targetDir: string;
  homeDir: string;
  /** call in afterEach to remove the temp tree */
  cleanup: () => void;
}

function mkScratch(): Scratch {
  const rootDir = mkdtempSync(join(tmpdir(), "wi-687-s1-"));
  const targetDir = join(rootDir, "project");
  const homeDir = join(rootDir, "home");
  mkdirSync(targetDir, { recursive: true });
  mkdirSync(homeDir, { recursive: true });
  return {
    rootDir,
    targetDir,
    homeDir,
    cleanup: () => rmSync(rootDir, { recursive: true, force: true }),
  };
}

// ---------------------------------------------------------------------------
// Adapter-specific helpers
// ---------------------------------------------------------------------------

/**
 * For IDE detection: each adapter has a canonical config dir the detection
 * probe expects. We create this directory so detectInstalledIdes() would fire
 * if called, but in these tests we always pass --ide explicitly to stay
 * deterministic regardless of the host machine's environment.
 *
 * These probe-dir creators match buildCandidatePaths() in ide-detect.ts.
 */
function seedDetectProbe(adapter: Adapter, homeDir: string): void {
  switch (adapter) {
    case "claude-code":
      mkdirSync(join(homeDir, ".claude"), { recursive: true });
      break;
    case "cursor":
      // macOS primary probe path
      mkdirSync(join(homeDir, "Library", "Application Support", "Cursor"), { recursive: true });
      break;
    case "cline":
      mkdirSync(join(homeDir, ".config", "cline"), { recursive: true });
      break;
    case "continue":
      mkdirSync(join(homeDir, ".continue"), { recursive: true });
      break;
    case "windsurf":
      mkdirSync(join(homeDir, ".windsurf"), { recursive: true });
      break;
  }
}

/**
 * Returns the primary hook artefact path for a given adapter.
 * claude-code, cursor, windsurf: settings.json inside targetDir subtree.
 * cline and continue: marker file inside homeDir subtree.
 */
function hookArtefactPath(adapter: Adapter, targetDir: string, homeDir: string): string {
  switch (adapter) {
    case "claude-code":
      return join(targetDir, ".claude", "settings.json");
    case "cursor":
      return join(targetDir, ".cursor", "settings.json");
    case "cline":
      return join(homeDir, ".config", "cline", "yakcc-cline-hook.json");
    case "continue":
      return join(homeDir, ".continue", "yakcc-continue-hook.json");
    case "windsurf":
      return join(targetDir, ".windsurf", "settings.json");
  }
}

/**
 * For cursor: the secondary marker artefact that is also written during install.
 * The settings.json is the primary artefact for idempotency; this is secondary.
 */
function cursorMarkerPath(targetDir: string): string {
  return join(targetDir, ".cursor", "yakcc-cursor-hook.json");
}

/**
 * Read a JSON artefact at path and return as unknown record.
 * Throws if path doesn't exist or isn't valid JSON.
 */
function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
}

/**
 * Check if the yakcc marker sentinel is present in the hook artefact.
 * For claude-code/cursor: checks the hooks entry inside settings.json.
 * For cline/continue: checks _yakcc on the marker file directly.
 */
function isYakccMarkerPresent(adapter: Adapter, targetDir: string, homeDir: string): boolean {
  const artefact = hookArtefactPath(adapter, targetDir, homeDir);
  if (!existsSync(artefact)) return false;
  const obj = readJson(artefact);
  const sentinel = SENTINELS[adapter];

  switch (adapter) {
    case "claude-code": {
      // sentinel is on an inner hook object inside hooks.PreToolUse[].hooks[]
      const hooks = obj.hooks as Record<string, unknown> | undefined;
      const preToolUse = hooks?.PreToolUse as Array<{ matcher: string; hooks: Array<{ _yakcc?: string }> }> | undefined;
      return (preToolUse ?? []).some((entry) =>
        entry.hooks.some((h) => h._yakcc === sentinel),
      );
    }
    case "cursor":
    case "windsurf": {
      // sentinel is on hooks.yakcc._yakcc in settings.json
      const hooks = obj.hooks as Record<string, unknown> | undefined;
      const yakccEntry = hooks?.yakcc as Record<string, unknown> | undefined;
      return yakccEntry?._yakcc === sentinel;
    }
    case "cline":
    case "continue":
      // sentinel is _yakcc field on the marker file directly
      return obj._yakcc === sentinel;
  }
}

/**
 * Normalize a hook artefact for byte-identity comparison:
 * - cline/continue: strip installedAt (intentionally regenerated on fresh install)
 * - claude-code/cursor: return as-is (settings.json is deterministic via applyInstall)
 *
 * See DEC-687-S1-BYTE-IDENTITY-SCOPE.
 */
function normalizeForByteIdentity(adapter: Adapter, raw: Buffer): Buffer {
  if (adapter === "cline" || adapter === "continue") {
    const obj = JSON.parse(raw.toString("utf-8")) as Record<string, unknown>;
    delete obj.installedAt;
    return Buffer.from(`${JSON.stringify(obj, null, 2)}\n`, "utf-8");
  }
  // For claude-code, cursor, and windsurf settings.json: the file is deterministic —
  // applyInstall returns early if the marker is already present, so bytes
  // are unchanged on re-init. Return raw for strict byte comparison.
  return raw;
}

// ---------------------------------------------------------------------------
// Pre-seed user-authored sibling content helpers
//
// These seed "user content" that lives in the same config file/dir as the
// yakcc artefact. The preservation assertions verify that uninstall did NOT
// remove this user content.
// ---------------------------------------------------------------------------

interface SiblingSnapshot {
  paths: string[];
  /** Reads each sibling path and stores its content for later comparison */
  capture: () => Record<string, string>;
}

function preSeedSiblingContent(
  adapter: Adapter,
  targetDir: string,
  homeDir: string,
): SiblingSnapshot {
  switch (adapter) {
    case "claude-code": {
      // Write .claude/settings.json with a pre-existing PreToolUse entry (no yakcc marker)
      // AND a sibling non-hook key "theme". These must survive init and uninstall.
      const claudeDir = join(targetDir, ".claude");
      mkdirSync(claudeDir, { recursive: true });
      const settingsPath = join(claudeDir, "settings.json");
      const userSettings = {
        theme: "dark",
        hooks: {
          PreToolUse: [
            {
              matcher: "Bash",
              hooks: [{ type: "command", command: "echo hello", _user: "authored" }],
            },
          ],
        },
      };
      writeFileSync(settingsPath, `${JSON.stringify(userSettings, null, 2)}\n`, "utf-8");
      return {
        paths: [settingsPath],
        capture: () => ({ settings: readFileSync(settingsPath, "utf-8") }),
      };
    }
    case "cursor": {
      // Write .cursor/settings.json with user content not related to yakcc.
      // A sibling file user-notes.json in the .cursor dir.
      const cursorDir = join(targetDir, ".cursor");
      mkdirSync(cursorDir, { recursive: true });
      const settingsPath = join(cursorDir, "settings.json");
      const notesPath = join(cursorDir, "user-notes.json");
      const userSettings = { "editor.tabSize": 2, hooks: { somethingElse: { cmd: "echo hi" } } };
      writeFileSync(settingsPath, `${JSON.stringify(userSettings, null, 2)}\n`, "utf-8");
      writeFileSync(notesPath, `${JSON.stringify({ note: "user cursor notes" }, null, 2)}\n`, "utf-8");
      return {
        paths: [settingsPath, notesPath],
        capture: () => ({
          settings: readFileSync(settingsPath, "utf-8"),
          notes: readFileSync(notesPath, "utf-8"),
        }),
      };
    }
    case "cline": {
      // Write a sibling user-notes.json in ~/.config/cline/ (not the yakcc marker file).
      const clineDir = join(homeDir, ".config", "cline");
      mkdirSync(clineDir, { recursive: true });
      const notesPath = join(clineDir, "user-notes.json");
      writeFileSync(notesPath, `${JSON.stringify({ note: "cline user notes" }, null, 2)}\n`, "utf-8");
      return {
        paths: [notesPath],
        capture: () => ({ notes: readFileSync(notesPath, "utf-8") }),
      };
    }
    case "continue": {
      // Write a sibling config.json in ~/.continue/ (not the yakcc marker file).
      const continueDir = join(homeDir, ".continue");
      mkdirSync(continueDir, { recursive: true });
      const configPath = join(continueDir, "config.json");
      writeFileSync(configPath, `${JSON.stringify({ userTheme: "light" }, null, 2)}\n`, "utf-8");
      return {
        paths: [configPath],
        capture: () => ({ config: readFileSync(configPath, "utf-8") }),
      };
    }
    case "windsurf": {
      // Write .windsurf/settings.json with user content not related to yakcc.
      // A sibling file user-notes.json in the .windsurf dir.
      const windsurfDir = join(targetDir, ".windsurf");
      mkdirSync(windsurfDir, { recursive: true });
      const settingsPath = join(windsurfDir, "settings.json");
      const notesPath = join(windsurfDir, "user-notes.json");
      const userSettings = { "editor.tabSize": 2, hooks: { somethingElse: { cmd: "echo hi" } } };
      writeFileSync(settingsPath, `${JSON.stringify(userSettings, null, 2)}\n`, "utf-8");
      writeFileSync(notesPath, `${JSON.stringify({ note: "user windsurf notes" }, null, 2)}\n`, "utf-8");
      return {
        paths: [settingsPath, notesPath],
        capture: () => ({
          settings: readFileSync(settingsPath, "utf-8"),
          notes: readFileSync(notesPath, "utf-8"),
        }),
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Per-adapter test suite factory
//
// 3 describe-blocks per adapter:
//   1. install + idempotency (snapshot1 captured here, reused in §3)
//   2. uninstall + sibling preservation
//   3. re-init round-trip byte-identity (snapshot1 vs snapshot3)
// ---------------------------------------------------------------------------

for (const adapter of ADAPTERS) {
  describe(`hooks-lifecycle: ${adapter}`, () => {
    let scratch: Scratch;
    // snapshot1: hook artefact bytes after first init (normalized)
    let snapshot1: Buffer;

    beforeEach(() => {
      scratch = mkScratch();
      // Seed the detect probe dir so auto-detection WOULD work,
      // though we always pass --ide explicitly.
      seedDetectProbe(adapter, scratch.homeDir);
    });

    afterEach(() => {
      scratch.cleanup();
    });

    // -----------------------------------------------------------------------
    // §1 — Install and idempotency
    // -----------------------------------------------------------------------

    it(`${adapter}: first init exits 0 and writes the yakcc marker`, async () => {
      const logger = new CollectingLogger();
      const code = await init(
        ["--target", scratch.targetDir, "--ide", adapter, "--no-seed"],
        logger,
        { overrideHome: scratch.homeDir },
      );
      expect(code, `init exit code (logs: ${logger.logLines.join(" | ")})`).toBe(0);

      const artefact = hookArtefactPath(adapter, scratch.targetDir, scratch.homeDir);
      expect(existsSync(artefact), `artefact not found at ${artefact}`).toBe(true);
      expect(
        isYakccMarkerPresent(adapter, scratch.targetDir, scratch.homeDir),
        `yakcc marker sentinel missing for ${adapter}`,
      ).toBe(true);

      // Capture snapshot for idempotency and round-trip assertions.
      snapshot1 = normalizeForByteIdentity(adapter, readFileSync(artefact));
    });

    it(`${adapter}: first init records adapter in .yakccrc.json installedHooks`, async () => {
      const logger = new CollectingLogger();
      await init(
        ["--target", scratch.targetDir, "--ide", adapter, "--no-seed"],
        logger,
        { overrideHome: scratch.homeDir },
      );

      const rcPath = join(scratch.targetDir, ".yakccrc.json");
      expect(existsSync(rcPath), ".yakccrc.json not found").toBe(true);
      const rc = readJson(rcPath);
      expect(Array.isArray(rc.installedHooks), "installedHooks is not an array").toBe(true);
      expect((rc.installedHooks as string[]).includes(adapter), `${adapter} not in installedHooks`).toBe(true);
    });

    it(`${adapter}: second init is idempotent — artefact bytes unchanged and no duplicate hook entry`, async () => {
      // First init
      await init(
        ["--target", scratch.targetDir, "--ide", adapter, "--no-seed"],
        new CollectingLogger(),
        { overrideHome: scratch.homeDir },
      );
      const artefact = hookArtefactPath(adapter, scratch.targetDir, scratch.homeDir);
      snapshot1 = normalizeForByteIdentity(adapter, readFileSync(artefact));

      // Small delay — ensures installedAt timestamps differ if re-written for cline/continue
      await new Promise((r) => setTimeout(r, 10));

      // Second init
      const logger2 = new CollectingLogger();
      const code2 = await init(
        ["--target", scratch.targetDir, "--ide", adapter, "--no-seed"],
        logger2,
        { overrideHome: scratch.homeDir },
      );
      expect(code2, `second init exit code (logs: ${logger2.logLines.join(" | ")})`).toBe(0);

      // Hook artefact bytes unchanged (stripped of installedAt for cline/continue)
      const snapshot2 = normalizeForByteIdentity(adapter, readFileSync(artefact));
      expect(snapshot2.equals(snapshot1), `${adapter}: hook artefact changed on second init (idempotency violation)`).toBe(true);

      // .yakccrc.json installedHooks lists adapter exactly once
      const rc = readJson(join(scratch.targetDir, ".yakccrc.json"));
      const hooks = rc.installedHooks as string[];
      const occurrences = hooks.filter((h) => h === adapter).length;
      expect(occurrences, `${adapter} appears ${occurrences} times in installedHooks (expected 1)`).toBe(1);
    });

    // -----------------------------------------------------------------------
    // §2 — Uninstall and user-content preservation
    // -----------------------------------------------------------------------

    it(`${adapter}: uninstall removes yakcc marker and preserves user-authored sibling content`, async () => {
      // First, pre-seed user-authored content in the same config locations
      const sibling = preSeedSiblingContent(adapter, scratch.targetDir, scratch.homeDir);
      const siblingBefore = sibling.capture();

      // Install
      const initLogger = new CollectingLogger();
      const initCode = await init(
        ["--target", scratch.targetDir, "--ide", adapter, "--no-seed"],
        initLogger,
        { overrideHome: scratch.homeDir },
      );
      expect(initCode, `init exit code (logs: ${initLogger.logLines.join(" | ")})`).toBe(0);
      expect(isYakccMarkerPresent(adapter, scratch.targetDir, scratch.homeDir)).toBe(true);

      // Uninstall
      const uninstallLogger = new CollectingLogger();
      const uninstallCode = await uninstall(
        ["--target", scratch.targetDir, "--ide", adapter],
        uninstallLogger,
        { overrideHome: scratch.homeDir },
      );
      expect(
        uninstallCode,
        `uninstall exit code (logs: ${uninstallLogger.logLines.join(" | ")})`,
      ).toBe(0);

      // yakcc marker is gone
      expect(
        isYakccMarkerPresent(adapter, scratch.targetDir, scratch.homeDir),
        `${adapter}: yakcc marker still present after uninstall`,
      ).toBe(false);

      // User-authored sibling content preserved byte-for-byte
      const siblingAfter = sibling.capture();
      for (const key of Object.keys(siblingBefore)) {
        expect(
          siblingAfter[key],
          `${adapter}: sibling content "${key}" changed after uninstall (preservation violation)`,
        ).toBe(siblingBefore[key]);
      }
    });

    it(`${adapter}: uninstall removes adapter from .yakccrc.json installedHooks`, async () => {
      await init(
        ["--target", scratch.targetDir, "--ide", adapter, "--no-seed"],
        new CollectingLogger(),
        { overrideHome: scratch.homeDir },
      );

      await uninstall(
        ["--target", scratch.targetDir, "--ide", adapter],
        new CollectingLogger(),
        { overrideHome: scratch.homeDir },
      );

      const rc = readJson(join(scratch.targetDir, ".yakccrc.json"));
      const hooks = rc.installedHooks as string[];
      expect(
        hooks.includes(adapter),
        `${adapter} still in installedHooks after uninstall`,
      ).toBe(false);
    });

    // -----------------------------------------------------------------------
    // §3 — Re-init round-trip byte-identity
    // -----------------------------------------------------------------------

    it(`${adapter}: re-init after uninstall restores byte-identical artefact (round-trip closure)`, async () => {
      // First init — capture snapshot1
      await init(
        ["--target", scratch.targetDir, "--ide", adapter, "--no-seed"],
        new CollectingLogger(),
        { overrideHome: scratch.homeDir },
      );
      const artefact = hookArtefactPath(adapter, scratch.targetDir, scratch.homeDir);
      snapshot1 = normalizeForByteIdentity(adapter, readFileSync(artefact));

      // Uninstall
      await uninstall(
        ["--target", scratch.targetDir, "--ide", adapter],
        new CollectingLogger(),
        { overrideHome: scratch.homeDir },
      );
      expect(isYakccMarkerPresent(adapter, scratch.targetDir, scratch.homeDir)).toBe(false);

      // Re-init — small delay for fresh timestamps if applicable
      await new Promise((r) => setTimeout(r, 10));

      const reInitLogger = new CollectingLogger();
      const reInitCode = await init(
        ["--target", scratch.targetDir, "--ide", adapter, "--no-seed"],
        reInitLogger,
        { overrideHome: scratch.homeDir },
      );
      expect(reInitCode, `re-init exit code (logs: ${reInitLogger.logLines.join(" | ")})`).toBe(0);

      // artefact is present and marker is back
      expect(existsSync(artefact), `artefact absent after re-init at ${artefact}`).toBe(true);
      expect(isYakccMarkerPresent(adapter, scratch.targetDir, scratch.homeDir), `yakcc marker missing after re-init`).toBe(true);

      // Bytes match snapshot1 (after normalisation)
      const snapshot3 = normalizeForByteIdentity(adapter, readFileSync(artefact));
      expect(
        snapshot3.equals(snapshot1),
        `${adapter}: re-init hook artefact bytes differ from first-init (round-trip closure violated)`,
      ).toBe(true);
    });
  });
}
