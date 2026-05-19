/**
 * hooks-cursor-install.test.ts -- tests for the Cursor hook installer.
 *
 * Production sequence:
 *   hooksCursorInstall(argv, logger)
 *   -> parseArgs -> mkdirSync(.cursor/) -> readCursorSettings -> applyInstall/applyUninstall
 *   -> writeCursorSettings -> writeFileSync(marker) -> addInstalledHook/removeInstalledHook
 *
 * Tests use --target <tmpDir> so no real .cursor/ is touched.
 * WI-759 rc tests (AC1/AC3/AC4/AC5/AC9) included.
 *
 * @decision DEC-CLI-HOOKS-CURSOR-INSTALL-001 -- settings.json + marker installer;
 *   idempotent install/uninstall; WI-759 rc integration.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CollectingLogger } from "../index.js";
import { readRc } from "../lib/yakccrc.js";
import { hooksCursorInstall } from "./hooks-cursor-install.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "yakcc-cursor-install-test-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

const CURSOR_MARKER_FILE = "yakcc-cursor-hook.json";

function readCursorSettings(dir: string): Record<string, unknown> | null {
  const p = join(dir, ".cursor", "settings.json");
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf-8")) as Record<string, unknown>;
}

function readCursorMarker(dir: string): Record<string, unknown> | null {
  const p = join(dir, ".cursor", CURSOR_MARKER_FILE);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf-8")) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Suite 1: Happy path install
// ---------------------------------------------------------------------------

describe("hooksCursorInstall -- install", () => {
  it("exits 0 on fresh install", async () => {
    const code = await hooksCursorInstall(["--target", tmpDir], new CollectingLogger());
    expect(code).toBe(0);
  });

  it("creates .cursor/ directory if absent", async () => {
    await hooksCursorInstall(["--target", tmpDir], new CollectingLogger());
    expect(existsSync(join(tmpDir, ".cursor"))).toBe(true);
  });

  it("writes .cursor/settings.json with yakcc hook entry", async () => {
    await hooksCursorInstall(["--target", tmpDir], new CollectingLogger());
    const settings = readCursorSettings(tmpDir);
    expect(settings).not.toBeNull();
    const hooks = settings?.hooks as Record<string, unknown> | undefined;
    expect(hooks).toBeDefined();
    const yakcc = hooks?.yakcc as Record<string, unknown> | undefined;
    expect(yakcc?._yakcc).toBe("yakcc-hook-v1-cursor");
  });

  it("writes .cursor/yakcc-cursor-hook.json marker file", async () => {
    await hooksCursorInstall(["--target", tmpDir], new CollectingLogger());
    const marker = readCursorMarker(tmpDir);
    expect(marker).not.toBeNull();
    expect(marker?.command).toBe("yakcc hook-intercept");
    expect(marker?.sessionEnvVar).toBe("CURSOR_SESSION_ID");
  });

  it("logs install confirmation", async () => {
    const logger = new CollectingLogger();
    await hooksCursorInstall(["--target", tmpDir], logger);
    expect(logger.logLines.some((l) => l.includes("installed"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Suite 2: Idempotency
// ---------------------------------------------------------------------------

describe("hooksCursorInstall -- idempotency", () => {
  it("second install exits 0", async () => {
    await hooksCursorInstall(["--target", tmpDir], new CollectingLogger());
    const code = await hooksCursorInstall(["--target", tmpDir], new CollectingLogger());
    expect(code).toBe(0);
  });

  it("second install does not duplicate yakcc entry in settings.json", async () => {
    await hooksCursorInstall(["--target", tmpDir], new CollectingLogger());
    await hooksCursorInstall(["--target", tmpDir], new CollectingLogger());
    const settings = readCursorSettings(tmpDir) as Record<string, unknown>;
    const hooks = settings.hooks as Record<string, unknown>;
    const yakccEntries = Object.values(hooks).filter(
      (v) => (v as Record<string, unknown>)?._yakcc === "yakcc-hook-v1-cursor",
    );
    expect(yakccEntries.length).toBe(1);
  });

  it("second install logs already installed", async () => {
    await hooksCursorInstall(["--target", tmpDir], new CollectingLogger());
    const logger = new CollectingLogger();
    await hooksCursorInstall(["--target", tmpDir], logger);
    expect(logger.logLines.some((l) => l.includes("already installed"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Suite 3: Uninstall
// ---------------------------------------------------------------------------

describe("hooksCursorInstall -- uninstall", () => {
  it("uninstall after install exits 0", async () => {
    await hooksCursorInstall(["--target", tmpDir], new CollectingLogger());
    const code = await hooksCursorInstall(
      ["--target", tmpDir, "--uninstall"],
      new CollectingLogger(),
    );
    expect(code).toBe(0);
  });

  it("uninstall removes yakcc entry from .cursor/settings.json", async () => {
    await hooksCursorInstall(["--target", tmpDir], new CollectingLogger());
    await hooksCursorInstall(["--target", tmpDir, "--uninstall"], new CollectingLogger());
    const settings = readCursorSettings(tmpDir) as Record<string, unknown>;
    const hooks = settings?.hooks as Record<string, unknown> | undefined;
    expect(hooks?.yakcc).toBeUndefined();
  });

  it("uninstall when not installed exits 0 with nothing to uninstall message", async () => {
    mkdirSync(join(tmpDir, ".cursor"), { recursive: true });
    const logger = new CollectingLogger();
    const code = await hooksCursorInstall(["--target", tmpDir, "--uninstall"], logger);
    expect(code).toBe(0);
    expect(logger.logLines.some((l) => l.includes("nothing to uninstall"))).toBe(true);
  });

  it("uninstall is idempotent -- second uninstall exits 0", async () => {
    await hooksCursorInstall(["--target", tmpDir], new CollectingLogger());
    await hooksCursorInstall(["--target", tmpDir, "--uninstall"], new CollectingLogger());
    const code = await hooksCursorInstall(
      ["--target", tmpDir, "--uninstall"],
      new CollectingLogger(),
    );
    expect(code).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Suite 4: Preserves existing settings.json content
// ---------------------------------------------------------------------------

describe("hooksCursorInstall -- preserves existing settings.json", () => {
  it("merges hook entry without clobbering unrelated keys", async () => {
    const cursorDir = join(tmpDir, ".cursor");
    mkdirSync(cursorDir, { recursive: true });
    writeFileSync(
      join(cursorDir, "settings.json"),
      JSON.stringify({ theme: "dark", myConfig: true }),
      "utf-8",
    );
    await hooksCursorInstall(["--target", tmpDir], new CollectingLogger());
    const settings = readCursorSettings(tmpDir) as Record<string, unknown>;
    expect(settings.theme).toBe("dark");
    expect(settings.myConfig).toBe(true);
    expect((settings.hooks as Record<string, unknown>)?.yakcc).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Suite 5: WI-759 -- .yakccrc.json.installedHooks integration (AC1/AC3/AC4/AC5/AC9)
// ---------------------------------------------------------------------------

describe("hooksCursorInstall -- WI-759 rc integration", () => {
  it("AC3: creates .yakccrc.json when absent", async () => {
    const code = await hooksCursorInstall(["--target", tmpDir], new CollectingLogger());
    expect(code).toBe(0);
    const rc = readRc(tmpDir);
    expect(rc).not.toBeNull();
    expect(rc?.version).toBe(1);
  });

  it("AC1: install appends cursor to installedHooks", async () => {
    await hooksCursorInstall(["--target", tmpDir], new CollectingLogger());
    const rc = readRc(tmpDir);
    expect(rc?.installedHooks).toContain("cursor");
  });

  it("AC4: second install does not duplicate cursor in installedHooks", async () => {
    await hooksCursorInstall(["--target", tmpDir], new CollectingLogger());
    await hooksCursorInstall(["--target", tmpDir], new CollectingLogger());
    const rc = readRc(tmpDir);
    const count = rc?.installedHooks?.filter((h) => h === "cursor").length ?? 0;
    expect(count).toBe(1);
  });

  it("AC5: uninstall removes cursor from installedHooks", async () => {
    await hooksCursorInstall(["--target", tmpDir], new CollectingLogger());
    await hooksCursorInstall(["--target", tmpDir, "--uninstall"], new CollectingLogger());
    const rc = readRc(tmpDir);
    expect(rc?.installedHooks ?? []).not.toContain("cursor");
  });

  it("AC9: install uninstall install round-trip: cursor appears exactly once", async () => {
    await hooksCursorInstall(["--target", tmpDir], new CollectingLogger());
    await hooksCursorInstall(["--target", tmpDir, "--uninstall"], new CollectingLogger());
    await hooksCursorInstall(["--target", tmpDir], new CollectingLogger());
    const rc = readRc(tmpDir);
    const count = rc?.installedHooks?.filter((h) => h === "cursor").length ?? 0;
    expect(count).toBe(1);
  });

  it("preserves other rc keys through install (EC-S2-I3)", async () => {
    writeFileSync(
      join(tmpDir, ".yakccrc.json"),
      JSON.stringify({ version: 1, mode: "local", registry: { path: ".yakcc/registry.sqlite" } }),
      "utf-8",
    );
    await hooksCursorInstall(["--target", tmpDir], new CollectingLogger());
    const rc = readRc(tmpDir);
    expect(rc?.mode).toBe("local");
    expect((rc?.registry as Record<string, unknown>)?.path).toBe(".yakcc/registry.sqlite");
    expect(rc?.installedHooks).toContain("cursor");
  });
});
