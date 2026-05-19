/**
 * hooks-windsurf-install.test.ts — tests for the Windsurf hook installer.
 *
 * Production sequence exercised:
 *   hooksWindsurfInstall(argv, logger)
 *   → parseArgs → mkdirSync(.windsurf/) → applyInstall/applyUninstall → writeSettings
 *   → writeFileSync(marker) → addInstalledHook/.yakccrc.json bookkeeping
 *
 * Covers .yakccrc.json installedHooks bookkeeping added in #759.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CollectingLogger } from "../index.js";
import { hooksWindsurfInstall } from "./hooks-windsurf-install.js";

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "yakcc-windsurf-install-test-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function readRc(dir: string): Record<string, unknown> | null {
  const p = join(dir, ".yakccrc.json");
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf-8")) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Suite 1: Happy path install
// ---------------------------------------------------------------------------

describe("hooksWindsurfInstall — install", () => {
  it("exits 0 on fresh install", async () => {
    const code = await hooksWindsurfInstall(["--target", tmpDir], new CollectingLogger());
    expect(code).toBe(0);
  });

  it("creates .windsurf/settings.json with yakcc hook entry", async () => {
    await hooksWindsurfInstall(["--target", tmpDir], new CollectingLogger());
    const settingsPath = join(tmpDir, ".windsurf", "settings.json");
    expect(existsSync(settingsPath)).toBe(true);
    const settings = JSON.parse(readFileSync(settingsPath, "utf-8")) as Record<string, unknown>;
    expect(settings.hooks).toBeDefined();
  });

  it("logs success message", async () => {
    const logger = new CollectingLogger();
    await hooksWindsurfInstall(["--target", tmpDir], logger);
    expect(logger.logLines.some((l) => l.includes("installed"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Suite 2: Idempotency
// ---------------------------------------------------------------------------

describe("hooksWindsurfInstall — idempotency", () => {
  it("second install exits 0", async () => {
    await hooksWindsurfInstall(["--target", tmpDir], new CollectingLogger());
    const code = await hooksWindsurfInstall(["--target", tmpDir], new CollectingLogger());
    expect(code).toBe(0);
  });

  it("second install logs 'already installed'", async () => {
    await hooksWindsurfInstall(["--target", tmpDir], new CollectingLogger());
    const logger = new CollectingLogger();
    await hooksWindsurfInstall(["--target", tmpDir], logger);
    expect(logger.logLines.some((l) => l.includes("already installed"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Suite 3: Uninstall
// ---------------------------------------------------------------------------

describe("hooksWindsurfInstall — uninstall", () => {
  it("uninstall after install exits 0", async () => {
    await hooksWindsurfInstall(["--target", tmpDir], new CollectingLogger());
    const code = await hooksWindsurfInstall(
      ["--target", tmpDir, "--uninstall"],
      new CollectingLogger(),
    );
    expect(code).toBe(0);
  });

  it("uninstall with no prior install exits 0 with 'nothing to uninstall'", async () => {
    const logger = new CollectingLogger();
    const code = await hooksWindsurfInstall(["--target", tmpDir, "--uninstall"], logger);
    expect(code).toBe(0);
    expect(logger.logLines.some((l) => l.includes("nothing to uninstall"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Suite 4: .yakccrc.json installedHooks bookkeeping (#759)
// ---------------------------------------------------------------------------

describe("hooksWindsurfInstall — rc bookkeeping", () => {
  it("creates .yakccrc.json with installedHooks when none exists", async () => {
    await hooksWindsurfInstall(["--target", tmpDir], new CollectingLogger());
    const rc = readRc(tmpDir);
    expect(rc).not.toBeNull();
    expect((rc?.installedHooks as string[]).includes("windsurf")).toBe(true);
  });

  it("merges into an existing rc without clobbering other fields", async () => {
    writeFileSync(
      join(tmpDir, ".yakccrc.json"),
      JSON.stringify(
        {
          version: 1,
          registry: { path: ".yakcc/registry.sqlite" },
          mode: "local",
          installedHooks: [],
        },
        null,
        2,
      ),
      "utf-8",
    );
    await hooksWindsurfInstall(["--target", tmpDir], new CollectingLogger());
    const rc = readRc(tmpDir);
    expect(rc?.mode).toBe("local");
    expect((rc?.installedHooks as string[]).includes("windsurf")).toBe(true);
  });

  it("does not duplicate installedHooks on idempotent re-install", async () => {
    await hooksWindsurfInstall(["--target", tmpDir], new CollectingLogger());
    await hooksWindsurfInstall(["--target", tmpDir], new CollectingLogger());
    const hooks = (readRc(tmpDir)?.installedHooks as string[]) ?? [];
    expect(hooks.filter((h) => h === "windsurf").length).toBe(1);
  });

  it("removes windsurf from installedHooks on --uninstall", async () => {
    await hooksWindsurfInstall(["--target", tmpDir], new CollectingLogger());
    await hooksWindsurfInstall(["--target", tmpDir, "--uninstall"], new CollectingLogger());
    const rc = readRc(tmpDir);
    expect((rc?.installedHooks as string[]).includes("windsurf")).toBe(false);
  });
});
