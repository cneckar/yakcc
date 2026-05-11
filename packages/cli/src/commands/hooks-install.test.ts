/**
 * hooks-install.test.ts — integration tests for `yakcc hooks claude-code install`.
 *
 * Production sequence exercised:
 *   hooksClaudeCodeInstall(argv, logger)
 *   → parseArgs → readSettings → applyInstall/applyUninstall → writeSettings
 *   → optional rmSync(CLAUDE.md)
 *
 * Tests:
 *   1. install in empty dir: creates .claude/settings.json with PreToolUse hook entry.
 *   2. idempotent re-install: running twice yields same settings.json, exit 0.
 *   3. --target <dir>: installs into a non-cwd directory.
 *   4. install removes existing .claude/CLAUDE.md v0 stub.
 *   5. install preserves existing non-yakcc settings.json content.
 *   6. --uninstall removes the yakcc hook entry.
 *   7. --uninstall when not installed: exit 0 with informative message.
 *   8. --uninstall is idempotent: second uninstall also exits 0.
 *   9. install → uninstall → re-install round trip.
 *  10. cannot create directory: returns 1 with error message.
 *  11. install via runCli dispatch path.
 *
 * @decision DEC-CLI-HOOKS-INSTALL-TEST-001
 * title: Tests use temp directories for isolation; no real home-dir writes
 * status: decided (WI-V05-CLI-INSTALL-RETIRE-FACADE #203)
 * rationale: Each test creates a fresh tmpdir so test runs are isolated from
 *   each other and from the real project .claude/ directory. CollectingLogger
 *   captures output without mocking. Sacred Practice #5: no mocks on fs
 *   internals — tests exercise the real file I/O against the temp directory.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CollectingLogger, runCli } from "../index.js";
import { hooksClaudeCodeInstall } from "./hooks-install.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "yakcc-hooks-test-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function readSettings(dir: string): unknown {
  const p = join(dir, ".claude", "settings.json");
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf-8"));
}

function touchClaudeMd(dir: string): void {
  const claudeDir = join(dir, ".claude");
  mkdirSync(claudeDir, { recursive: true });
  writeFileSync(join(claudeDir, "CLAUDE.md"), "# v0 stub\n", "utf-8");
}

// ---------------------------------------------------------------------------
// Suite 1: fresh install
// ---------------------------------------------------------------------------

describe("install — fresh directory", () => {
  it("creates .claude/settings.json with PreToolUse hook entry", async () => {
    const logger = new CollectingLogger();
    const code = await hooksClaudeCodeInstall(["--target", tmpDir], logger);

    expect(code).toBe(0);
    const settings = readSettings(tmpDir) as Record<string, unknown>;
    expect(settings).not.toBeNull();
    const hooks = settings.hooks as Record<string, unknown>;
    expect(hooks).toBeDefined();
    const preToolUse = hooks.PreToolUse as Array<{ matcher: string; hooks: unknown[] }>;
    expect(Array.isArray(preToolUse)).toBe(true);
    expect(preToolUse.length).toBeGreaterThan(0);
    expect(preToolUse[0]?.matcher).toBe("Edit|Write|MultiEdit");
    const innerHooks = preToolUse[0]?.hooks as Array<{
      type: string;
      command: string;
      _yakcc: string;
    }>;
    expect(innerHooks[0]?.type).toBe("command");
    expect(innerHooks[0]?.command).toBe("yakcc hook-intercept");
    expect(innerHooks[0]?._yakcc).toBe("yakcc-hook-v1");
  });

  it("logs install confirmation", async () => {
    const logger = new CollectingLogger();
    await hooksClaudeCodeInstall(["--target", tmpDir], logger);

    expect(logger.logLines.some((l) => l.includes("installed"))).toBe(true);
    expect(logger.logLines.some((l) => l.includes("yakcc hook-intercept"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Suite 2: idempotency
// ---------------------------------------------------------------------------

describe("install — idempotent re-install", () => {
  it("running twice yields the same settings.json entry count", async () => {
    const logger1 = new CollectingLogger();
    await hooksClaudeCodeInstall(["--target", tmpDir], logger1);

    const settingsAfterFirst = readSettings(tmpDir) as Record<string, unknown>;
    const countAfterFirst = (
      (settingsAfterFirst.hooks as Record<string, unknown[]>).PreToolUse ?? []
    ).length;

    const logger2 = new CollectingLogger();
    const code = await hooksClaudeCodeInstall(["--target", tmpDir], logger2);

    expect(code).toBe(0);
    const settingsAfterSecond = readSettings(tmpDir) as Record<string, unknown>;
    const countAfterSecond = (
      (settingsAfterSecond.hooks as Record<string, unknown[]>).PreToolUse ?? []
    ).length;

    expect(countAfterSecond).toBe(countAfterFirst);
    expect(logger2.logLines.some((l) => l.includes("idempotent"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Suite 3: --target flag
// ---------------------------------------------------------------------------

describe("install — --target <dir>", () => {
  it("installs into a non-cwd target directory", async () => {
    const subDir = join(tmpDir, "my-project");
    mkdirSync(subDir);

    const logger = new CollectingLogger();
    const code = await hooksClaudeCodeInstall(["--target", subDir], logger);

    expect(code).toBe(0);
    expect(existsSync(join(subDir, ".claude", "settings.json"))).toBe(true);
    expect(existsSync(join(tmpDir, ".claude", "settings.json"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Suite 4: v0 CLAUDE.md removal
// ---------------------------------------------------------------------------

describe("install — removes v0 CLAUDE.md stub", () => {
  it("deletes .claude/CLAUDE.md when it exists", async () => {
    touchClaudeMd(tmpDir);
    expect(existsSync(join(tmpDir, ".claude", "CLAUDE.md"))).toBe(true);

    const logger = new CollectingLogger();
    await hooksClaudeCodeInstall(["--target", tmpDir], logger);

    expect(existsSync(join(tmpDir, ".claude", "CLAUDE.md"))).toBe(false);
  });

  it("succeeds when .claude/CLAUDE.md does not exist", async () => {
    const logger = new CollectingLogger();
    const code = await hooksClaudeCodeInstall(["--target", tmpDir], logger);
    expect(code).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Suite 5: preserves existing settings.json content
// ---------------------------------------------------------------------------

describe("install — preserves existing settings.json", () => {
  it("merges yakcc hook entry without clobbering unrelated keys", async () => {
    const claudeDir = join(tmpDir, ".claude");
    mkdirSync(claudeDir, { recursive: true });
    const existing = { theme: "dark", keybindings: [{ key: "ctrl+s", command: "save" }] };
    writeFileSync(join(claudeDir, "settings.json"), JSON.stringify(existing, null, 2), "utf-8");

    const logger = new CollectingLogger();
    const code = await hooksClaudeCodeInstall(["--target", tmpDir], logger);

    expect(code).toBe(0);
    const result = readSettings(tmpDir) as Record<string, unknown>;
    expect(result.theme).toBe("dark");
    expect(Array.isArray(result.keybindings)).toBe(true);
    expect(result.hooks).toBeDefined();
  });

  it("appends to existing non-yakcc PreToolUse entries", async () => {
    const claudeDir = join(tmpDir, ".claude");
    mkdirSync(claudeDir, { recursive: true });
    const existing = {
      hooks: {
        PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "my-linter" }] }],
      },
    };
    writeFileSync(join(claudeDir, "settings.json"), JSON.stringify(existing, null, 2), "utf-8");

    await hooksClaudeCodeInstall(["--target", tmpDir], new CollectingLogger());

    const result = readSettings(tmpDir) as Record<string, unknown>;
    const preToolUse = (result.hooks as Record<string, unknown[]>).PreToolUse as unknown[];
    expect(preToolUse.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Suite 6: --uninstall
// ---------------------------------------------------------------------------

describe("--uninstall", () => {
  it("removes the yakcc hook entry from settings.json", async () => {
    await hooksClaudeCodeInstall(["--target", tmpDir], new CollectingLogger());

    const logger = new CollectingLogger();
    const code = await hooksClaudeCodeInstall(["--target", tmpDir, "--uninstall"], logger);

    expect(code).toBe(0);
    expect(logger.logLines.some((l) => l.includes("removed"))).toBe(true);

    const settings = readSettings(tmpDir) as Record<string, unknown>;
    const hooks = settings?.hooks as Record<string, unknown[]> | undefined;
    const entries = hooks?.PreToolUse ?? [];
    expect(entries.length).toBe(0);
  });

  it("preserves non-yakcc PreToolUse entries on uninstall", async () => {
    const claudeDir = join(tmpDir, ".claude");
    mkdirSync(claudeDir, { recursive: true });
    const existing = {
      hooks: {
        PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "my-linter" }] }],
      },
    };
    writeFileSync(join(claudeDir, "settings.json"), JSON.stringify(existing, null, 2), "utf-8");

    await hooksClaudeCodeInstall(["--target", tmpDir], new CollectingLogger());
    await hooksClaudeCodeInstall(["--target", tmpDir, "--uninstall"], new CollectingLogger());

    const result = readSettings(tmpDir) as Record<string, unknown>;
    const preToolUse = (result.hooks as Record<string, unknown[]>).PreToolUse as unknown[];
    expect(preToolUse.length).toBe(1);
    expect((preToolUse[0] as Record<string, unknown>).matcher).toBe("Bash");
  });
});

// ---------------------------------------------------------------------------
// Suite 7: --uninstall when not installed
// ---------------------------------------------------------------------------

describe("--uninstall when not installed", () => {
  it("exits 0 with informative message when hook is not present", async () => {
    const logger = new CollectingLogger();
    const code = await hooksClaudeCodeInstall(["--target", tmpDir, "--uninstall"], logger);

    expect(code).toBe(0);
    expect(logger.logLines.some((l) => l.includes("not installed"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Suite 8: --uninstall idempotent
// ---------------------------------------------------------------------------

describe("--uninstall idempotent", () => {
  it("second uninstall also exits 0 gracefully", async () => {
    await hooksClaudeCodeInstall(["--target", tmpDir], new CollectingLogger());
    await hooksClaudeCodeInstall(["--target", tmpDir, "--uninstall"], new CollectingLogger());

    const logger = new CollectingLogger();
    const code = await hooksClaudeCodeInstall(["--target", tmpDir, "--uninstall"], logger);
    expect(code).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Suite 9: install → uninstall → re-install round trip
// ---------------------------------------------------------------------------

describe("round trip", () => {
  it("install → uninstall → re-install produces a clean settings.json", async () => {
    await hooksClaudeCodeInstall(["--target", tmpDir], new CollectingLogger());
    await hooksClaudeCodeInstall(["--target", tmpDir, "--uninstall"], new CollectingLogger());

    const logger = new CollectingLogger();
    const code = await hooksClaudeCodeInstall(["--target", tmpDir], logger);

    expect(code).toBe(0);
    const settings = readSettings(tmpDir) as Record<string, unknown>;
    const preToolUse = ((settings.hooks as Record<string, unknown[]>).PreToolUse ?? []) as Array<
      Record<string, unknown>
    >;
    expect(preToolUse.filter((e) => e.matcher === "Edit|Write|MultiEdit").length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Suite 10: directory creation failure (guarded by pre-existing path)
// ---------------------------------------------------------------------------

describe("error handling", () => {
  it("returns 1 when target is a file not a directory", async () => {
    // Create a file where .claude/ would be placed so mkdir fails.
    writeFileSync(join(tmpDir, ".claude"), "not a directory");

    const logger = new CollectingLogger();
    const code = await hooksClaudeCodeInstall(["--target", tmpDir], logger);

    expect(code).toBe(1);
    expect(logger.errLines.some((l) => l.startsWith("error:"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Suite 11: runCli dispatch
// ---------------------------------------------------------------------------

describe("runCli dispatch", () => {
  it("routes hooks claude-code install correctly", async () => {
    const logger = new CollectingLogger();
    const code = await runCli(["hooks", "claude-code", "install", "--target", tmpDir], logger);

    expect(code).toBe(0);
    expect(existsSync(join(tmpDir, ".claude", "settings.json"))).toBe(true);
  });
});
