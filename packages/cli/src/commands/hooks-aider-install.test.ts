/**
 * hooks-aider-install.test.ts -- tests for the Aider hook marker installer.
 *
 * Production sequence exercised:
 *   hooksAiderInstall(argv, logger, overrideAiderDir, overrideCwd)
 *   -> parseArgs -> mkdirSync(aiderDir) -> isYakccInstalled -> writeFileSync(marker)
 *   -> addInstalledHook/removeInstalledHook at overrideCwd
 *
 * Tests use overrideAiderDir so no real ~/.aider/ is touched.
 * WI-759 rc tests use overrideCwd so no real project cwd is modified.
 *
 * @decision DEC-CLI-HOOKS-AIDER-INSTALL-001 -- marker-file installer; no live
 *   .aider.conf.yml wiring yet; idempotent install/uninstall.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CollectingLogger } from "../index.js";
import { readRc } from "../lib/yakccrc.js";
import { hooksAiderInstall } from "./hooks-aider-install.js";

let tmpDir: string;
let fakeAiderDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "yakcc-aider-install-test-"));
  fakeAiderDir = join(tmpDir, ".aider");
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

const MARKER_FILE = "yakcc-aider-hook.json";

function readMarker(dir: string): Record<string, unknown> | null {
  const p = join(dir, MARKER_FILE);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf-8")) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Suite 1: Happy path install
// ---------------------------------------------------------------------------

describe("hooksAiderInstall -- install", () => {
  it("exits 0 on fresh install", async () => {
    const logger = new CollectingLogger();
    const code = await hooksAiderInstall([], logger, fakeAiderDir);
    expect(code).toBe(0);
  });

  it("creates the aider config dir if absent", async () => {
    await hooksAiderInstall([], new CollectingLogger(), fakeAiderDir);
    expect(existsSync(fakeAiderDir)).toBe(true);
  });

  it("writes the marker file with the _yakcc sentinel", async () => {
    await hooksAiderInstall([], new CollectingLogger(), fakeAiderDir);
    const marker = readMarker(fakeAiderDir);
    expect(marker).not.toBeNull();
    expect(marker?._yakcc).toBe("yakcc-hook-v1-aider");
  });

  it("marker file contains the hook command", async () => {
    await hooksAiderInstall([], new CollectingLogger(), fakeAiderDir);
    const marker = readMarker(fakeAiderDir);
    expect(marker?.command).toBe("yakcc hook-intercept");
  });

  it("marker file contains installedAt timestamp", async () => {
    await hooksAiderInstall([], new CollectingLogger(), fakeAiderDir);
    const marker = readMarker(fakeAiderDir);
    expect(typeof marker?.installedAt).toBe("string");
    expect((marker?.installedAt as string).length).toBeGreaterThan(0);
  });

  it("logs success message", async () => {
    const logger = new CollectingLogger();
    await hooksAiderInstall([], logger, fakeAiderDir);
    expect(logger.logLines.some((l) => l.includes("installed"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Suite 2: Idempotency
// ---------------------------------------------------------------------------

describe("hooksAiderInstall -- idempotency", () => {
  it("second install exits 0", async () => {
    await hooksAiderInstall([], new CollectingLogger(), fakeAiderDir);
    const code = await hooksAiderInstall([], new CollectingLogger(), fakeAiderDir);
    expect(code).toBe(0);
  });

  it("second install does not overwrite the marker timestamp", async () => {
    await hooksAiderInstall([], new CollectingLogger(), fakeAiderDir);
    const ts1 = readMarker(fakeAiderDir)?.installedAt as string;

    await new Promise((r) => setTimeout(r, 5));

    await hooksAiderInstall([], new CollectingLogger(), fakeAiderDir);
    const ts2 = readMarker(fakeAiderDir)?.installedAt as string;

    expect(ts1).toBe(ts2);
  });

  it("second install logs already installed", async () => {
    await hooksAiderInstall([], new CollectingLogger(), fakeAiderDir);
    const logger = new CollectingLogger();
    await hooksAiderInstall([], logger, fakeAiderDir);
    expect(logger.logLines.some((l) => l.includes("already installed"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Suite 3: Uninstall
// ---------------------------------------------------------------------------

describe("hooksAiderInstall -- uninstall", () => {
  it("uninstall after install removes the marker file", async () => {
    await hooksAiderInstall([], new CollectingLogger(), fakeAiderDir);
    expect(existsSync(join(fakeAiderDir, MARKER_FILE))).toBe(true);

    const code = await hooksAiderInstall(["--uninstall"], new CollectingLogger(), fakeAiderDir);
    expect(code).toBe(0);
    expect(existsSync(join(fakeAiderDir, MARKER_FILE))).toBe(false);
  });

  it("uninstall with no prior install exits 0 with nothing to uninstall", async () => {
    mkdirSync(fakeAiderDir, { recursive: true });
    const logger = new CollectingLogger();
    const code = await hooksAiderInstall(["--uninstall"], logger, fakeAiderDir);
    expect(code).toBe(0);
    expect(logger.logLines.some((l) => l.includes("nothing to uninstall"))).toBe(true);
  });

  it("uninstall is idempotent -- second uninstall exits 0", async () => {
    await hooksAiderInstall([], new CollectingLogger(), fakeAiderDir);
    await hooksAiderInstall(["--uninstall"], new CollectingLogger(), fakeAiderDir);
    const code = await hooksAiderInstall(["--uninstall"], new CollectingLogger(), fakeAiderDir);
    expect(code).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Suite 4: Invalid flags
// ---------------------------------------------------------------------------

describe("hooksAiderInstall -- invalid flags", () => {
  it("returns 1 for unknown flag", async () => {
    const logger = new CollectingLogger();
    const code = await hooksAiderInstall(["--bogus-flag"], logger, fakeAiderDir);
    expect(code).toBe(1);
    expect(logger.errLines.some((l) => l.includes("error:"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Suite 5: WI-759 -- .yakccrc.json.installedHooks integration (overrideCwd seam)
// ---------------------------------------------------------------------------

describe("hooksAiderInstall -- WI-759 rc integration (overrideCwd)", () => {
  it("AC3: creates .yakccrc.json at overrideCwd when absent", async () => {
    const code = await hooksAiderInstall([], new CollectingLogger(), fakeAiderDir, tmpDir);
    expect(code).toBe(0);
    const rc = readRc(tmpDir);
    expect(rc).not.toBeNull();
    expect(rc?.version).toBe(1);
  });

  it("AC1: install appends aider to installedHooks at overrideCwd", async () => {
    await hooksAiderInstall([], new CollectingLogger(), fakeAiderDir, tmpDir);
    const rc = readRc(tmpDir);
    expect(rc?.installedHooks).toContain("aider");
  });

  it("AC4: second install does not duplicate aider in installedHooks", async () => {
    await hooksAiderInstall([], new CollectingLogger(), fakeAiderDir, tmpDir);
    await hooksAiderInstall([], new CollectingLogger(), fakeAiderDir, tmpDir);
    const rc = readRc(tmpDir);
    const count = rc?.installedHooks?.filter((h) => h === "aider").length ?? 0;
    expect(count).toBe(1);
  });

  it("AC5: uninstall removes aider from installedHooks at overrideCwd", async () => {
    await hooksAiderInstall([], new CollectingLogger(), fakeAiderDir, tmpDir);
    await hooksAiderInstall(["--uninstall"], new CollectingLogger(), fakeAiderDir, tmpDir);
    const rc = readRc(tmpDir);
    expect(rc?.installedHooks ?? []).not.toContain("aider");
  });
});
