/**
 * hooks-windsurf-install.test.ts -- tests for the Windsurf hook installer.
 *
 * Production sequence:
 *   hooksWindsurfInstall(argv, logger)
 *   -> parseArgs -> mkdirSync(.windsurf/) -> readWindsurfSettings -> applyInstall/applyUninstall
 *   -> writeWindsurfSettings -> writeFileSync(marker) -> addInstalledHook/removeInstalledHook
 *
 * Tests use --target <tmpDir> so no real .windsurf/ is touched.
 * WI-759 rc tests (AC1/AC3/AC4/AC5/AC9) included.
 *
 * @decision DEC-CLI-HOOKS-WINDSURF-INSTALL-001 -- settings.json + marker installer;
 *   idempotent install/uninstall; WI-759 rc integration.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CollectingLogger } from "../index.js";
import { readRc } from "../lib/yakccrc.js";
import { hooksWindsurfInstall } from "./hooks-windsurf-install.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "yakcc-windsurf-install-test-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

const WINDSURF_MARKER_FILE = "yakcc-windsurf-hook.json";

function readWindsurfSettings(dir: string): Record<string, unknown> | null {
  const p = join(dir, ".windsurf", "settings.json");
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf-8")) as Record<string, unknown>;
}

function readWindsurfMarker(dir: string): Record<string, unknown> | null {
  const p = join(dir, ".windsurf", WINDSURF_MARKER_FILE);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf-8")) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Suite 1: Happy path install
// ---------------------------------------------------------------------------

describe("hooksWindsurfInstall -- install", () => {
  it("exits 0 on fresh install", async () => {
    const code = await hooksWindsurfInstall(["--target", tmpDir], new CollectingLogger());
    expect(code).toBe(0);
  });

  it("creates .windsurf/ directory if absent", async () => {
    await hooksWindsurfInstall(["--target", tmpDir], new CollectingLogger());
    expect(existsSync(join(tmpDir, ".windsurf"))).toBe(true);
  });

  it("writes .windsurf/settings.json with yakcc hook entry", async () => {
    await hooksWindsurfInstall(["--target", tmpDir], new CollectingLogger());
    const settings = readWindsurfSettings(tmpDir);
    expect(settings).not.toBeNull();
    const hooks = settings?.hooks as Record<string, unknown> | undefined;
    expect(hooks).toBeDefined();
    const yakcc = hooks?.yakcc as Record<string, unknown> | undefined;
    expect(yakcc?._yakcc).toBe("yakcc-hook-v1-windsurf");
  });

  it("writes .windsurf/yakcc-windsurf-hook.json marker file", async () => {
    await hooksWindsurfInstall(["--target", tmpDir], new CollectingLogger());
    const marker = readWindsurfMarker(tmpDir);
    expect(marker).not.toBeNull();
    expect(marker?.command).toBe("yakcc hook-intercept");
    expect(marker?.sessionEnvVar).toBe("WINDSURF_SESSION_ID");
  });

  it("logs install confirmation", async () => {
    const logger = new CollectingLogger();
    await hooksWindsurfInstall(["--target", tmpDir], logger);
    expect(logger.logLines.some((l) => l.includes("installed"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Suite 2: Idempotency
// ---------------------------------------------------------------------------

describe("hooksWindsurfInstall -- idempotency", () => {
  it("second install exits 0", async () => {
    await hooksWindsurfInstall(["--target", tmpDir], new CollectingLogger());
    const code = await hooksWindsurfInstall(["--target", tmpDir], new CollectingLogger());
    expect(code).toBe(0);
  });

  it("second install does not duplicate yakcc entry in settings.json", async () => {
    await hooksWindsurfInstall(["--target", tmpDir], new CollectingLogger());
    await hooksWindsurfInstall(["--target", tmpDir], new CollectingLogger());
    const settings = readWindsurfSettings(tmpDir) as Record<string, unknown>;
    const hooks = settings.hooks as Record<string, unknown>;
    const yakccEntries = Object.values(hooks).filter(
      (v) => (v as Record<string, unknown>)?._yakcc === "yakcc-hook-v1-windsurf",
    );
    expect(yakccEntries.length).toBe(1);
  });

  it("second install logs already installed", async () => {
    await hooksWindsurfInstall(["--target", tmpDir], new CollectingLogger());
    const logger = new CollectingLogger();
    await hooksWindsurfInstall(["--target", tmpDir], logger);
    expect(logger.logLines.some((l) => l.includes("already installed"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Suite 3: Uninstall
// ---------------------------------------------------------------------------

describe("hooksWindsurfInstall -- uninstall", () => {
  it("uninstall after install exits 0", async () => {
    await hooksWindsurfInstall(["--target", tmpDir], new CollectingLogger());
    const code = await hooksWindsurfInstall(
      ["--target", tmpDir, "--uninstall"],
      new CollectingLogger(),
    );
    expect(code).toBe(0);
  });

  it("uninstall removes yakcc entry from .windsurf/settings.json", async () => {
    await hooksWindsurfInstall(["--target", tmpDir], new CollectingLogger());
    await hooksWindsurfInstall(["--target", tmpDir, "--uninstall"], new CollectingLogger());
    const settings = readWindsurfSettings(tmpDir) as Record<string, unknown>;
    const hooks = settings?.hooks as Record<string, unknown> | undefined;
    expect(hooks?.yakcc).toBeUndefined();
  });

  it("uninstall when not installed exits 0 with nothing to uninstall message", async () => {
    mkdirSync(join(tmpDir, ".windsurf"), { recursive: true });
    const logger = new CollectingLogger();
    const code = await hooksWindsurfInstall(["--target", tmpDir, "--uninstall"], logger);
    expect(code).toBe(0);
    expect(logger.logLines.some((l) => l.includes("nothing to uninstall"))).toBe(true);
  });

  it("uninstall is idempotent -- second uninstall exits 0", async () => {
    await hooksWindsurfInstall(["--target", tmpDir], new CollectingLogger());
    await hooksWindsurfInstall(["--target", tmpDir, "--uninstall"], new CollectingLogger());
    const code = await hooksWindsurfInstall(
      ["--target", tmpDir, "--uninstall"],
      new CollectingLogger(),
    );
    expect(code).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Suite 4: Preserves existing settings.json content
// ---------------------------------------------------------------------------

describe("hooksWindsurfInstall -- preserves existing settings.json", () => {
  it("merges hook entry without clobbering unrelated keys", async () => {
    const windsurfDir = join(tmpDir, ".windsurf");
    mkdirSync(windsurfDir, { recursive: true });
    writeFileSync(
      join(windsurfDir, "settings.json"),
      JSON.stringify({ theme: "dark", myConfig: true }),
      "utf-8",
    );
    await hooksWindsurfInstall(["--target", tmpDir], new CollectingLogger());
    const settings = readWindsurfSettings(tmpDir) as Record<string, unknown>;
    expect(settings.theme).toBe("dark");
    expect(settings.myConfig).toBe(true);
    expect((settings.hooks as Record<string, unknown>)?.yakcc).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Suite 5: WI-759 -- .yakccrc.json.installedHooks integration (AC1/AC3/AC4/AC5/AC9)
// ---------------------------------------------------------------------------

describe("hooksWindsurfInstall -- WI-759 rc integration", () => {
  it("AC3: creates .yakccrc.json when absent", async () => {
    const code = await hooksWindsurfInstall(["--target", tmpDir], new CollectingLogger());
    expect(code).toBe(0);
    const rc = readRc(tmpDir);
    expect(rc).not.toBeNull();
    expect(rc?.version).toBe(1);
  });

  it("AC1: install appends windsurf to installedHooks", async () => {
    await hooksWindsurfInstall(["--target", tmpDir], new CollectingLogger());
    const rc = readRc(tmpDir);
    expect(rc?.installedHooks).toContain("windsurf");
  });

  it("AC4: second install does not duplicate windsurf in installedHooks", async () => {
    await hooksWindsurfInstall(["--target", tmpDir], new CollectingLogger());
    await hooksWindsurfInstall(["--target", tmpDir], new CollectingLogger());
    const rc = readRc(tmpDir);
    const count = rc?.installedHooks?.filter((h) => h === "windsurf").length ?? 0;
    expect(count).toBe(1);
  });

  it("AC5: uninstall removes windsurf from installedHooks", async () => {
    await hooksWindsurfInstall(["--target", tmpDir], new CollectingLogger());
    await hooksWindsurfInstall(["--target", tmpDir, "--uninstall"], new CollectingLogger());
    const rc = readRc(tmpDir);
    expect(rc?.installedHooks ?? []).not.toContain("windsurf");
  });

  it("AC9: install uninstall install round-trip: windsurf appears exactly once", async () => {
    await hooksWindsurfInstall(["--target", tmpDir], new CollectingLogger());
    await hooksWindsurfInstall(["--target", tmpDir, "--uninstall"], new CollectingLogger());
    await hooksWindsurfInstall(["--target", tmpDir], new CollectingLogger());
    const rc = readRc(tmpDir);
    const count = rc?.installedHooks?.filter((h) => h === "windsurf").length ?? 0;
    expect(count).toBe(1);
  });

  it("preserves other rc keys through install (EC-S2-I3)", async () => {
    writeFileSync(
      join(tmpDir, ".yakccrc.json"),
      JSON.stringify({ version: 1, mode: "local", registry: { path: ".yakcc/registry.sqlite" } }),
      "utf-8",
    );
    await hooksWindsurfInstall(["--target", tmpDir], new CollectingLogger());
    const rc = readRc(tmpDir);
    expect(rc?.mode).toBe("local");
    expect((rc?.registry as Record<string, unknown>)?.path).toBe(".yakcc/registry.sqlite");
    expect(rc?.installedHooks).toContain("windsurf");
  });
});
