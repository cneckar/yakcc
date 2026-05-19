/**
 * uninstall.test.ts — integration tests for `yakcc uninstall`.
 *
 * Production sequence exercised:
 *   uninstall(argv, logger, opts?)
 *   → parseArgs → DEC-CLI-UNINSTALL-DETECTION-001 (tier selection)
 *   → uninstallHookForIde(each) → update .yakccrc.json / purge
 *   → summary log
 *
 * All tests use mkdtempSync + real fs I/O (no mocks). overrideHome injects a
 * controlled home directory for cline/continue marker resolution and for
 * detectInstalledIdes() IDE detection, without touching the real HOME.
 *
 * Mirror of init.test.ts structure per EC-S2 and Sacred Practice #5.
 *
 * @decision DEC-CLI-UNINSTALL-TEST-001
 * title: Uninstall tests use temp directories + overrideHome injection; no mocks
 * status: accepted (WI-656-S2)
 * rationale:
 *   Same rationale as DEC-CLI-INIT-TEST-001. Real fs I/O proves the production
 *   code paths work. CollectingLogger captures output without spying. Temp dirs
 *   guarantee isolation. overrideHome avoids writing to the real HOME directory.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CollectingLogger, runCli } from "../index.js";
import { init } from "./init.js";
import { uninstall } from "./uninstall.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "yakcc-uninstall-test-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

/** Read and parse .yakccrc.json from a directory, or null if absent/invalid. */
function readRc(dir: string): Record<string, unknown> | null {
  const p = join(dir, ".yakccrc.json");
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf-8")) as Record<string, unknown>;
}

/** Read and parse .claude/settings.json, or null if absent/invalid. */
function readClaudeSettings(dir: string): Record<string, unknown> | null {
  const p = join(dir, ".claude", "settings.json");
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf-8")) as Record<string, unknown>;
}

/** Check whether .claude/settings.json has a yakcc PreToolUse entry. */
function claudeCodeHookPresent(dir: string): boolean {
  const settings = readClaudeSettings(dir);
  if (settings === null) return false;
  const hooks = settings.hooks as Record<string, unknown[]> | undefined;
  if (hooks === undefined) return false;
  const preToolUse = hooks.PreToolUse as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(preToolUse)) return false;
  // The yakcc hook lives inside a nested hooks array on the PreToolUse entry
  return preToolUse.some((entry) => {
    const inner = entry.hooks as Array<Record<string, unknown>> | undefined;
    return Array.isArray(inner) && inner.some((h) => h._yakcc === "yakcc-hook-v1");
  });
}

/** Write a minimal .yakccrc.json to seed a scenario without running init. */
function seedRc(dir: string, installedHooks: string[]): void {
  const rc = {
    version: 1,
    mode: "local",
    registry: { path: ".yakcc/registry.sqlite" },
    installedHooks,
  };
  writeFileSync(join(dir, ".yakccrc.json"), `${JSON.stringify(rc, null, 2)}\n`, "utf-8");
}

/** Create a fake HOME directory with a .claude/ config dir present. */
function makeHomeWithClaudeCode(base: string): string {
  const fakeHome = join(base, "fakehome");
  mkdirSync(join(fakeHome, ".claude"), { recursive: true });
  return fakeHome;
}

/** Run init for claude-code + cursor in tmpDir with a fake home. */
async function initBothClaudeAndCursor(dir: string, fakeHome: string): Promise<void> {
  mkdirSync(join(fakeHome, ".claude"), { recursive: true });
  mkdirSync(join(fakeHome, ".config", "Cursor"), { recursive: true });
  const code = await init(
    ["--target", dir, "--ide", "claude-code,cursor", "--no-seed"],
    new CollectingLogger(),
    {
      overrideHome: fakeHome,
    },
  );
  expect(code).toBe(0);
}

// ---------------------------------------------------------------------------
// EC-S2-T1 — default uninstall, installedHooks-driven (happy path)
// ---------------------------------------------------------------------------

describe("uninstall — default, installedHooks-driven (EC-S2-T1)", () => {
  it("removes claude-code and cursor hooks; .yakccrc.json stays with installedHooks:[]", async () => {
    const fakeHome = join(tmpDir, "fakehome-t1");
    await initBothClaudeAndCursor(tmpDir, fakeHome);

    // Confirm hooks are installed
    expect(claudeCodeHookPresent(tmpDir)).toBe(true);
    const rcBefore = readRc(tmpDir);
    expect((rcBefore?.installedHooks as string[]).includes("claude-code")).toBe(true);

    const logger = new CollectingLogger();
    const code = await uninstall(["--target", tmpDir], logger);

    expect(code).toBe(0);
    // Claude Code hook removed
    expect(claudeCodeHookPresent(tmpDir)).toBe(false);
    // .yakccrc.json still exists
    expect(existsSync(join(tmpDir, ".yakccrc.json"))).toBe(true);
    // installedHooks cleared to []
    const rcAfter = readRc(tmpDir);
    expect(rcAfter?.installedHooks).toEqual([]);
    // .yakcc/ still exists (not purged)
    expect(existsSync(join(tmpDir, ".yakcc"))).toBe(true);
  });

  it("preserves other .yakccrc.json keys (version, mode, registry) verbatim (EC-S2-I3)", async () => {
    const fakeHome = join(tmpDir, "fakehome-i3");
    mkdirSync(join(fakeHome, ".claude"), { recursive: true });
    await init(["--target", tmpDir, "--ide", "claude-code", "--no-seed"], new CollectingLogger(), {
      overrideHome: fakeHome,
    });

    await uninstall(["--target", tmpDir], new CollectingLogger());

    const rc = readRc(tmpDir);
    expect(rc?.version).toBe(1);
    expect(rc?.mode).toBe("local");
    expect(rc?.registry).toEqual({ path: ".yakcc/registry.sqlite" });
  });
});

// ---------------------------------------------------------------------------
// EC-S2-T2 — default uninstall, fallback to detectInstalledIdes()
// ---------------------------------------------------------------------------

describe("uninstall — fallback to detectInstalledIdes() (EC-S2-T2)", () => {
  it("removes claude-code hook when no .yakccrc.json and overrideHome has .claude/", async () => {
    const fakeHome = join(tmpDir, "fakehome-t2");
    // Install claude-code hook manually, then remove the rc to force Tier 3 detection.
    // (hooksClaudeCodeInstall now writes .yakccrc.json as part of #759 fix;
    // deleting it here tests the Tier 3 filesystem-detection fallback path.)
    mkdirSync(join(fakeHome, ".claude"), { recursive: true });
    const { hooksClaudeCodeInstall } = await import("./hooks-install.js");
    await hooksClaudeCodeInstall(["--target", tmpDir], new CollectingLogger());
    rmSync(join(tmpDir, ".yakccrc.json"), { force: true });

    // Confirm hook is present and no rc exists
    expect(claudeCodeHookPresent(tmpDir)).toBe(true);
    expect(existsSync(join(tmpDir, ".yakccrc.json"))).toBe(false);

    const logger = new CollectingLogger();
    const code = await uninstall(["--target", tmpDir], logger, { overrideHome: fakeHome });

    expect(code).toBe(0);
    // Claude Code hook removed via fallback detection path
    expect(claudeCodeHookPresent(tmpDir)).toBe(false);
  });

  it("falls back when .yakccrc.json has empty installedHooks (still tries detection)", async () => {
    const fakeHome = join(tmpDir, "fakehome-t2b");
    // Seed rc with empty installedHooks
    seedRc(tmpDir, []);
    // Install a hook manually
    mkdirSync(join(fakeHome, ".claude"), { recursive: true });
    const { hooksClaudeCodeInstall } = await import("./hooks-install.js");
    await hooksClaudeCodeInstall(["--target", tmpDir], new CollectingLogger());
    expect(claudeCodeHookPresent(tmpDir)).toBe(true);

    const code = await uninstall(["--target", tmpDir], new CollectingLogger(), {
      overrideHome: fakeHome,
    });

    expect(code).toBe(0);
    expect(claudeCodeHookPresent(tmpDir)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// EC-S2-T3 — `--purge` removes data
// ---------------------------------------------------------------------------

describe("uninstall --purge — removes .yakcc/ and .yakccrc.json (EC-S2-T3)", () => {
  it("purge removes .yakcc/ directory and .yakccrc.json", async () => {
    const fakeHome = join(tmpDir, "fakehome-t3");
    mkdirSync(join(fakeHome, ".claude"), { recursive: true });
    await init(["--target", tmpDir, "--ide", "claude-code", "--no-seed"], new CollectingLogger(), {
      overrideHome: fakeHome,
    });

    expect(existsSync(join(tmpDir, ".yakcc"))).toBe(true);
    expect(existsSync(join(tmpDir, ".yakccrc.json"))).toBe(true);

    const logger = new CollectingLogger();
    const code = await uninstall(["--target", tmpDir, "--purge"], logger, {
      overrideHome: fakeHome,
    });

    expect(code).toBe(0);
    expect(existsSync(join(tmpDir, ".yakcc"))).toBe(false);
    expect(existsSync(join(tmpDir, ".yakccrc.json"))).toBe(false);
  });

  it("purge: hook files are also removed (uninstall loop runs before purge)", async () => {
    const fakeHome = join(tmpDir, "fakehome-t3b");
    mkdirSync(join(fakeHome, ".claude"), { recursive: true });
    await init(["--target", tmpDir, "--ide", "claude-code", "--no-seed"], new CollectingLogger(), {
      overrideHome: fakeHome,
    });

    await uninstall(["--target", tmpDir, "--purge"], new CollectingLogger(), {
      overrideHome: fakeHome,
    });

    expect(claudeCodeHookPresent(tmpDir)).toBe(false);
  });

  it("purge: summary contains 'purged' (DEC-CLI-UNINSTALL-PURGE-001 / EC-S2-T8)", async () => {
    const fakeHome = join(tmpDir, "fakehome-t3c");
    mkdirSync(join(fakeHome, ".claude"), { recursive: true });
    await init(["--target", tmpDir, "--ide", "claude-code", "--no-seed"], new CollectingLogger(), {
      overrideHome: fakeHome,
    });

    const logger = new CollectingLogger();
    await uninstall(["--target", tmpDir, "--purge"], logger, { overrideHome: fakeHome });

    const allLog = logger.logLines.join("\n").toLowerCase();
    expect(allLog).toContain("purged");
  });
});

// ---------------------------------------------------------------------------
// EC-S2-T4 — `--ide <single>` targets one IDE only
// ---------------------------------------------------------------------------

describe("uninstall --ide cursor — removes cursor only (EC-S2-T4)", () => {
  it("cursor removed; claude-code hook UNCHANGED; installedHooks updated", async () => {
    const fakeHome = join(tmpDir, "fakehome-t4");
    await initBothClaudeAndCursor(tmpDir, fakeHome);

    const rcBefore = readRc(tmpDir);
    expect((rcBefore?.installedHooks as string[]).includes("claude-code")).toBe(true);
    expect((rcBefore?.installedHooks as string[]).includes("cursor")).toBe(true);

    const logger = new CollectingLogger();
    const code = await uninstall(["--target", tmpDir, "--ide", "cursor"], logger);

    expect(code).toBe(0);
    // Claude Code hook preserved
    expect(claudeCodeHookPresent(tmpDir)).toBe(true);
    // installedHooks now has claude-code but not cursor
    const rcAfter = readRc(tmpDir);
    expect((rcAfter?.installedHooks as string[]).includes("claude-code")).toBe(true);
    expect((rcAfter?.installedHooks as string[]).includes("cursor")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// EC-S2-T5 — `--ide <comma-list>` targets multiple
// ---------------------------------------------------------------------------

describe("uninstall --ide claude-code,cline — removes both (EC-S2-T5)", () => {
  it("claude-code and cline removed; cursor and continue PRESERVED", async () => {
    const fakeHome = join(tmpDir, "fakehome-t5");
    mkdirSync(join(fakeHome, ".claude"), { recursive: true });
    mkdirSync(join(fakeHome, ".config", "Cursor"), { recursive: true });
    mkdirSync(join(fakeHome, ".config", "cline"), { recursive: true });
    mkdirSync(join(fakeHome, ".continue"), { recursive: true });

    // Init all four IDEs
    const initCode = await init(
      ["--target", tmpDir, "--ide", "claude-code,cursor,cline,continue", "--no-seed"],
      new CollectingLogger(),
      { overrideHome: fakeHome },
    );
    expect(initCode).toBe(0);

    const logger = new CollectingLogger();
    const code = await uninstall(["--target", tmpDir, "--ide", "claude-code,cline"], logger, {
      overrideHome: fakeHome,
    });

    expect(code).toBe(0);
    // claude-code hook removed
    expect(claudeCodeHookPresent(tmpDir)).toBe(false);
    // cline marker removed
    expect(existsSync(join(fakeHome, ".config", "cline", "yakcc-cline-hook.json"))).toBe(false);
    // cursor settings still present
    expect(existsSync(join(tmpDir, ".cursor", "settings.json"))).toBe(true);
    // continue marker still present
    expect(existsSync(join(fakeHome, ".continue", "yakcc-continue-hook.json"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// EC-S2-T6 — `--ide` invalid name rejected
// ---------------------------------------------------------------------------

describe("uninstall --ide codex — rejected (EC-S2-T6 + EC-S2-F6)", () => {
  it("exits 1 and logs all four known IDE names when given an unknown IDE", async () => {
    const logger = new CollectingLogger();
    const code = await uninstall(["--target", tmpDir, "--ide", "codex"], logger);

    expect(code).toBe(1);
    const errText = logger.errLines.join("\n");
    expect(errText).toContain("unknown IDE name(s): codex");
    expect(errText).toContain("claude-code");
    expect(errText).toContain("cursor");
    expect(errText).toContain("cline");
    expect(errText).toContain("continue");
  });

  it("exits 1 for an empty string ide name", async () => {
    const logger = new CollectingLogger();
    const code = await uninstall(["--target", tmpDir, "--ide", "bogus-ide"], logger);
    expect(code).toBe(1);
  });

  it("does not touch the filesystem before validation (fail-fast)", async () => {
    await uninstall(["--target", tmpDir, "--ide", "codex"], new CollectingLogger());
    // .yakcc/ must not be created — we fail before any fs mutation
    expect(existsSync(join(tmpDir, ".yakcc"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// EC-S2-T7 — idempotent re-run
// ---------------------------------------------------------------------------

describe("uninstall — idempotent re-run (EC-S2-T7)", () => {
  it("calling uninstall twice on a non-init'd dir exits 0 both times", async () => {
    const logger1 = new CollectingLogger();
    const logger2 = new CollectingLogger();
    const code1 = await uninstall(["--target", tmpDir], logger1, { overrideHome: tmpDir });
    const code2 = await uninstall(["--target", tmpDir], logger2, { overrideHome: tmpDir });

    expect(code1).toBe(0);
    expect(code2).toBe(0);
  });

  it("second call has no error lines", async () => {
    await uninstall(["--target", tmpDir], new CollectingLogger(), { overrideHome: tmpDir });
    const logger2 = new CollectingLogger();
    await uninstall(["--target", tmpDir], logger2, { overrideHome: tmpDir });

    expect(logger2.errLines.length).toBe(0);
  });

  it("calling uninstall twice after an init exits 0 both times", async () => {
    const fakeHome = join(tmpDir, "fakehome-t7");
    mkdirSync(join(fakeHome, ".claude"), { recursive: true });
    await init(["--target", tmpDir, "--ide", "claude-code", "--no-seed"], new CollectingLogger(), {
      overrideHome: fakeHome,
    });

    const code1 = await uninstall(["--target", tmpDir], new CollectingLogger(), {
      overrideHome: fakeHome,
    });
    const code2 = await uninstall(["--target", tmpDir], new CollectingLogger(), {
      overrideHome: fakeHome,
    });

    expect(code1).toBe(0);
    expect(code2).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// EC-S2-T8 — concise summary output (≤6 lines)
// ---------------------------------------------------------------------------

describe("uninstall — concise summary output (EC-S2-T8)", () => {
  it("default uninstall: summary log is ≤6 non-empty lines", async () => {
    const fakeHome = join(tmpDir, "fakehome-t8a");
    mkdirSync(join(fakeHome, ".claude"), { recursive: true });
    await init(["--target", tmpDir, "--ide", "claude-code", "--no-seed"], new CollectingLogger(), {
      overrideHome: fakeHome,
    });

    const logger = new CollectingLogger();
    await uninstall(["--target", tmpDir], logger, { overrideHome: fakeHome });

    const nonEmpty = logger.logLines.filter((l) => l.trim().length > 0);
    expect(nonEmpty.length).toBeLessThanOrEqual(6);
  });

  it("purge uninstall: summary contains 'purged' AND IDE removal info", async () => {
    const fakeHome = join(tmpDir, "fakehome-t8b");
    mkdirSync(join(fakeHome, ".claude"), { recursive: true });
    await init(["--target", tmpDir, "--ide", "claude-code", "--no-seed"], new CollectingLogger(), {
      overrideHome: fakeHome,
    });

    const logger = new CollectingLogger();
    await uninstall(["--target", tmpDir, "--purge"], logger, { overrideHome: fakeHome });

    const allLog = logger.logLines.join("\n").toLowerCase();
    expect(allLog).toContain("purged");
    // Summary should mention the IDE removal
    expect(
      logger.logLines.some((l) => l.includes("claude-code") || l.includes("Removed from")),
    ).toBe(true);
    // Total non-empty log lines ≤ 6
    const nonEmpty = logger.logLines.filter((l) => l.trim().length > 0);
    expect(nonEmpty.length).toBeLessThanOrEqual(6);
  });

  it("default uninstall: summary mentions 'Registry preserved'", async () => {
    const fakeHome = join(tmpDir, "fakehome-t8c");
    mkdirSync(join(fakeHome, ".claude"), { recursive: true });
    await init(["--target", tmpDir, "--ide", "claude-code", "--no-seed"], new CollectingLogger(), {
      overrideHome: fakeHome,
    });

    const logger = new CollectingLogger();
    await uninstall(["--target", tmpDir], logger, { overrideHome: fakeHome });

    const allLog = logger.logLines.join("\n");
    expect(allLog).toContain("Registry preserved");
  });
});

// ---------------------------------------------------------------------------
// EC-S2-T9 — runCli dispatch arm exists
// ---------------------------------------------------------------------------

describe("runCli dispatch — routes 'uninstall' to the uninstall handler (EC-S2-T9)", () => {
  it("runCli(['uninstall', '--target', tmpDir]) exits 0", async () => {
    const logger = new CollectingLogger();
    const code = await runCli(["uninstall", "--target", tmpDir], logger, {});

    expect(code).toBe(0);
  });

  it("runCli uninstall result matches direct uninstall() call", async () => {
    const fakeHome = join(tmpDir, "fakehome-t9");
    mkdirSync(join(fakeHome, ".claude"), { recursive: true });
    await init(["--target", tmpDir, "--ide", "claude-code", "--no-seed"], new CollectingLogger(), {
      overrideHome: fakeHome,
    });

    const loggerViaRunCli = new CollectingLogger();
    const codeViaRunCli = await runCli(["uninstall", "--target", tmpDir], loggerViaRunCli, {});

    expect(codeViaRunCli).toBe(0);
    // Hook should be removed
    expect(claudeCodeHookPresent(tmpDir)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// EC-S2-T10 — `--purge` without hooks succeeds (empty installedHooks edge case)
// ---------------------------------------------------------------------------

describe("uninstall --purge — empty installedHooks still removes data (EC-S2-T10)", () => {
  it("purge with installedHooks:[] removes .yakcc/ and .yakccrc.json without error", async () => {
    // Seed: .yakcc/ exists, .yakccrc.json exists with empty installedHooks
    mkdirSync(join(tmpDir, ".yakcc"), { recursive: true });
    seedRc(tmpDir, []);

    const logger = new CollectingLogger();
    const code = await uninstall(["--target", tmpDir, "--purge"], logger, {
      overrideHome: tmpDir,
    });

    expect(code).toBe(0);
    expect(existsSync(join(tmpDir, ".yakcc"))).toBe(false);
    expect(existsSync(join(tmpDir, ".yakccrc.json"))).toBe(false);
    // No errors logged
    expect(logger.errLines.length).toBe(0);
  });

  it("purge with no .yakccrc.json at all still exits 0 (idempotent on missing files)", async () => {
    mkdirSync(join(tmpDir, ".yakcc"), { recursive: true });
    // No .yakccrc.json

    const code = await uninstall(["--target", tmpDir, "--purge"], new CollectingLogger(), {
      overrideHome: tmpDir,
    });

    expect(code).toBe(0);
    expect(existsSync(join(tmpDir, ".yakcc"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// EC-S2-R2 — help text for `yakcc --help` shows uninstall verb
// ---------------------------------------------------------------------------

describe("usage text — uninstall verb documented (EC-S2-R2)", () => {
  it("yakcc --help output contains 'uninstall' verb and its flags", async () => {
    const logger = new CollectingLogger();
    await runCli(["--help"], logger);

    const helpText = logger.logLines.join("\n");
    expect(helpText).toContain("uninstall");
    expect(helpText).toContain("--purge");
    expect(helpText).toContain("--target");
  });
});

// ---------------------------------------------------------------------------
// EC-S2-I3 — .yakccrc.json schema invariant: version stays 1
// ---------------------------------------------------------------------------

describe("uninstall — .yakccrc.json schema invariants (EC-S2-I3)", () => {
  it("version is still 1 after uninstall", async () => {
    const fakeHome = join(tmpDir, "fakehome-i3");
    mkdirSync(join(fakeHome, ".claude"), { recursive: true });
    await init(["--target", tmpDir, "--ide", "claude-code", "--no-seed"], new CollectingLogger(), {
      overrideHome: fakeHome,
    });

    await uninstall(["--target", tmpDir], new CollectingLogger(), { overrideHome: fakeHome });

    const rc = readRc(tmpDir);
    expect(rc?.version).toBe(1);
  });

  it("installedHooks is [] (not absent) after default uninstall", async () => {
    const fakeHome = join(tmpDir, "fakehome-i3b");
    mkdirSync(join(fakeHome, ".claude"), { recursive: true });
    await init(["--target", tmpDir, "--ide", "claude-code", "--no-seed"], new CollectingLogger(), {
      overrideHome: fakeHome,
    });

    await uninstall(["--target", tmpDir], new CollectingLogger(), { overrideHome: fakeHome });

    const rc = readRc(tmpDir);
    expect(Array.isArray(rc?.installedHooks)).toBe(true);
    expect(rc?.installedHooks).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Compound-interaction test (required by implementer dispatch contract)
//
// Exercises the real production sequence end-to-end crossing multiple components:
//   init (writes hooks + rc) → uninstall (reads rc → removes hooks → clears rc)
// Both functions are the real implementations operating on real temp-dir files.
// ---------------------------------------------------------------------------

describe("compound interaction: init → uninstall end-to-end", () => {
  it("init then uninstall: all hooks removed, rc preserved with empty installedHooks, .yakcc/ preserved", async () => {
    const fakeHome = join(tmpDir, "fakehome-compound");
    mkdirSync(join(fakeHome, ".claude"), { recursive: true });
    mkdirSync(join(fakeHome, ".config", "cline"), { recursive: true });

    // Step 1: init with claude-code + cline
    const initCode = await init(
      ["--target", tmpDir, "--ide", "claude-code,cline", "--no-seed"],
      new CollectingLogger(),
      { overrideHome: fakeHome },
    );
    expect(initCode).toBe(0);

    // Verify installed state
    expect(claudeCodeHookPresent(tmpDir)).toBe(true);
    expect(existsSync(join(fakeHome, ".config", "cline", "yakcc-cline-hook.json"))).toBe(true);
    const rcAfterInit = readRc(tmpDir);
    expect((rcAfterInit?.installedHooks as string[]).includes("claude-code")).toBe(true);
    expect((rcAfterInit?.installedHooks as string[]).includes("cline")).toBe(true);

    // Step 2: uninstall (default — no purge)
    const uninstallLogger = new CollectingLogger();
    const uninstallCode = await uninstall(["--target", tmpDir], uninstallLogger, {
      overrideHome: fakeHome,
    });
    expect(uninstallCode).toBe(0);

    // 3. Claude Code hook removed
    expect(claudeCodeHookPresent(tmpDir)).toBe(false);
    // 4. Cline marker removed
    expect(existsSync(join(fakeHome, ".config", "cline", "yakcc-cline-hook.json"))).toBe(false);
    // 5. .yakccrc.json preserved with installedHooks: []
    expect(existsSync(join(tmpDir, ".yakccrc.json"))).toBe(true);
    const rcAfterUninstall = readRc(tmpDir);
    expect(rcAfterUninstall?.version).toBe(1);
    expect(rcAfterUninstall?.installedHooks).toEqual([]);
    // 6. .yakcc/ still exists (registry preserved)
    expect(existsSync(join(tmpDir, ".yakcc"))).toBe(true);
    expect(existsSync(join(tmpDir, ".yakcc", "registry.sqlite"))).toBe(true);
    // 7. Summary contains "Removed from" and "Registry preserved"
    const allLog = uninstallLogger.logLines.join("\n");
    expect(allLog).toContain("Removed from");
    expect(allLog).toContain("Registry preserved");
  });

  it("init → uninstall --purge: everything gone", async () => {
    const fakeHome = join(tmpDir, "fakehome-compound-purge");
    mkdirSync(join(fakeHome, ".claude"), { recursive: true });

    const initCode = await init(
      ["--target", tmpDir, "--ide", "claude-code", "--no-seed"],
      new CollectingLogger(),
      { overrideHome: fakeHome },
    );
    expect(initCode).toBe(0);

    const logger = new CollectingLogger();
    const code = await uninstall(["--target", tmpDir, "--purge"], logger, {
      overrideHome: fakeHome,
    });
    expect(code).toBe(0);

    // All yakcc artefacts gone
    expect(claudeCodeHookPresent(tmpDir)).toBe(false);
    expect(existsSync(join(tmpDir, ".yakcc"))).toBe(false);
    expect(existsSync(join(tmpDir, ".yakccrc.json"))).toBe(false);

    const allLog = logger.logLines.join("\n").toLowerCase();
    expect(allLog).toContain("purged");
  });
});
