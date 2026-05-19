/**
 * hooks-aider-install.test.ts — tests for the Aider hook marker installer.
 *
 * Production sequence exercised:
 *   hooksAiderInstall(argv, logger, overrideAiderDir)
 *   → parseArgs → mkdirSync(aiderDir) → isYakccInstalled → writeFileSync(marker)
 *   → addInstalledHook/.yakccrc.json bookkeeping
 *
 * Tests use overrideAiderDir so no real ~/.aider is touched.
 * Covers .yakccrc.json installedHooks bookkeeping added in #759.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CollectingLogger } from "../index.js";
import { hooksAiderInstall } from "./hooks-aider-install.js";

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

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

function readRc(dir: string): Record<string, unknown> | null {
  const p = join(dir, ".yakccrc.json");
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf-8")) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Suite 1: Happy path install
// ---------------------------------------------------------------------------

describe("hooksAiderInstall — install", () => {
  it("exits 0 on fresh install", async () => {
    const code = await hooksAiderInstall([], new CollectingLogger(), fakeAiderDir);
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
    expect(readMarker(fakeAiderDir)?.command).toBe("yakcc hook-intercept");
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

describe("hooksAiderInstall — idempotency", () => {
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
    expect(readMarker(fakeAiderDir)?.installedAt).toBe(ts1);
  });

  it("second install logs 'already installed'", async () => {
    await hooksAiderInstall([], new CollectingLogger(), fakeAiderDir);
    const logger = new CollectingLogger();
    await hooksAiderInstall([], logger, fakeAiderDir);
    expect(logger.logLines.some((l) => l.includes("already installed"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Suite 3: Uninstall
// ---------------------------------------------------------------------------

describe("hooksAiderInstall — uninstall", () => {
  it("uninstall after install removes the marker file", async () => {
    await hooksAiderInstall([], new CollectingLogger(), fakeAiderDir);
    const code = await hooksAiderInstall(["--uninstall"], new CollectingLogger(), fakeAiderDir);
    expect(code).toBe(0);
    expect(existsSync(join(fakeAiderDir, MARKER_FILE))).toBe(false);
  });

  it("uninstall with no prior install exits 0 with 'nothing to uninstall'", async () => {
    const { mkdirSync } = await import("node:fs");
    mkdirSync(fakeAiderDir, { recursive: true });
    const logger = new CollectingLogger();
    const code = await hooksAiderInstall(["--uninstall"], logger, fakeAiderDir);
    expect(code).toBe(0);
    expect(logger.logLines.some((l) => l.includes("nothing to uninstall"))).toBe(true);
  });

  it("uninstall is idempotent — second uninstall exits 0", async () => {
    await hooksAiderInstall([], new CollectingLogger(), fakeAiderDir);
    await hooksAiderInstall(["--uninstall"], new CollectingLogger(), fakeAiderDir);
    const code = await hooksAiderInstall(["--uninstall"], new CollectingLogger(), fakeAiderDir);
    expect(code).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Suite 4: Invalid flags
// ---------------------------------------------------------------------------

describe("hooksAiderInstall — invalid flags", () => {
  it("returns 1 for unknown flag", async () => {
    const logger = new CollectingLogger();
    const code = await hooksAiderInstall(["--bogus-flag"], logger, fakeAiderDir);
    expect(code).toBe(1);
    expect(logger.errLines.some((l) => l.includes("error:"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Suite 5: .yakccrc.json installedHooks bookkeeping (#759)
// ---------------------------------------------------------------------------

describe("hooksAiderInstall — rc bookkeeping", () => {
  it("creates .yakccrc.json with installedHooks when none exists", async () => {
    await hooksAiderInstall(["--target", tmpDir], new CollectingLogger(), fakeAiderDir);
    const rc = readRc(tmpDir);
    expect(rc).not.toBeNull();
    expect((rc?.installedHooks as string[]).includes("aider")).toBe(true);
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
    await hooksAiderInstall(["--target", tmpDir], new CollectingLogger(), fakeAiderDir);
    const rc = readRc(tmpDir);
    expect(rc?.mode).toBe("local");
    expect((rc?.installedHooks as string[]).includes("aider")).toBe(true);
  });

  it("does not duplicate installedHooks on idempotent re-install", async () => {
    await hooksAiderInstall(["--target", tmpDir], new CollectingLogger(), fakeAiderDir);
    await hooksAiderInstall(["--target", tmpDir], new CollectingLogger(), fakeAiderDir);
    const hooks = (readRc(tmpDir)?.installedHooks as string[]) ?? [];
    expect(hooks.filter((h) => h === "aider").length).toBe(1);
  });

  it("removes aider from installedHooks on --uninstall", async () => {
    await hooksAiderInstall(["--target", tmpDir], new CollectingLogger(), fakeAiderDir);
    await hooksAiderInstall(
      ["--target", tmpDir, "--uninstall"],
      new CollectingLogger(),
      fakeAiderDir,
    );
    const rc = readRc(tmpDir);
    expect((rc?.installedHooks as string[]).includes("aider")).toBe(false);
  });
});
