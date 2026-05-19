/**
 * hooks-cline-install.test.ts — tests for the Cline hook marker installer.
 *
 * Production sequence exercised:
 *   hooksClineInstall(argv, logger, overrideClineDir)
 *   → parseArgs → mkdirSync(clineDir) → isYakccInstalled → writeFileSync(marker) → log
 *
 * Mirrors the shape of hooks-cursor-install.test.ts. Tests use overrideClineDir
 * so no real ~/.config/cline is touched.
 *
 * @decision DEC-CLI-HOOKS-CLINE-INSTALL-001 — marker-file installer; no live
 *   hook wiring yet; idempotent install/uninstall.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CollectingLogger } from "../index.js";
import { hooksClineInstall } from "./hooks-cline-install.js";

function readRc(dir: string): Record<string, unknown> | null {
  const p = join(dir, ".yakccrc.json");
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf-8")) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let tmpDir: string;
let fakeClineDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "yakcc-cline-install-test-"));
  fakeClineDir = join(tmpDir, ".config", "cline");
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

const MARKER_FILE = "yakcc-cline-hook.json";

function readMarker(dir: string): Record<string, unknown> | null {
  const p = join(dir, MARKER_FILE);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf-8")) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Suite 1: Happy path install
// ---------------------------------------------------------------------------

describe("hooksClineInstall — install", () => {
  it("exits 0 on fresh install", async () => {
    const logger = new CollectingLogger();
    const code = await hooksClineInstall([], logger, fakeClineDir);
    expect(code).toBe(0);
  });

  it("creates the cline config dir if absent", async () => {
    await hooksClineInstall([], new CollectingLogger(), fakeClineDir);
    expect(existsSync(fakeClineDir)).toBe(true);
  });

  it("writes the marker file with the _yakcc sentinel", async () => {
    await hooksClineInstall([], new CollectingLogger(), fakeClineDir);
    const marker = readMarker(fakeClineDir);
    expect(marker).not.toBeNull();
    expect(marker?._yakcc).toBe("yakcc-hook-v1-cline");
  });

  it("marker file contains the hook command", async () => {
    await hooksClineInstall([], new CollectingLogger(), fakeClineDir);
    const marker = readMarker(fakeClineDir);
    expect(marker?.command).toBe("yakcc hook-intercept");
  });

  it("marker file contains installedAt timestamp", async () => {
    await hooksClineInstall([], new CollectingLogger(), fakeClineDir);
    const marker = readMarker(fakeClineDir);
    expect(typeof marker?.installedAt).toBe("string");
    expect((marker?.installedAt as string).length).toBeGreaterThan(0);
  });

  it("marker file contains a note about API stability", async () => {
    await hooksClineInstall([], new CollectingLogger(), fakeClineDir);
    const marker = readMarker(fakeClineDir);
    expect(typeof marker?.note).toBe("string");
    expect((marker?.note as string).toLowerCase()).toContain("cline");
  });

  it("logs success message", async () => {
    const logger = new CollectingLogger();
    await hooksClineInstall([], logger, fakeClineDir);
    expect(logger.logLines.some((l) => l.includes("installed"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Suite 2: Idempotency
// ---------------------------------------------------------------------------

describe("hooksClineInstall — idempotency", () => {
  it("second install exits 0", async () => {
    await hooksClineInstall([], new CollectingLogger(), fakeClineDir);
    const code = await hooksClineInstall([], new CollectingLogger(), fakeClineDir);
    expect(code).toBe(0);
  });

  it("second install does not overwrite the marker timestamp", async () => {
    await hooksClineInstall([], new CollectingLogger(), fakeClineDir);
    const ts1 = readMarker(fakeClineDir)?.installedAt as string;

    // Small delay to ensure timestamps differ if re-written
    await new Promise((r) => setTimeout(r, 5));

    await hooksClineInstall([], new CollectingLogger(), fakeClineDir);
    const ts2 = readMarker(fakeClineDir)?.installedAt as string;

    expect(ts1).toBe(ts2); // unchanged — idempotent
  });

  it("second install logs 'already installed'", async () => {
    await hooksClineInstall([], new CollectingLogger(), fakeClineDir);
    const logger = new CollectingLogger();
    await hooksClineInstall([], logger, fakeClineDir);
    expect(logger.logLines.some((l) => l.includes("already installed"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Suite 3: Uninstall
// ---------------------------------------------------------------------------

describe("hooksClineInstall — uninstall", () => {
  it("uninstall after install removes the marker file", async () => {
    await hooksClineInstall([], new CollectingLogger(), fakeClineDir);
    expect(existsSync(join(fakeClineDir, MARKER_FILE))).toBe(true);

    const code = await hooksClineInstall(["--uninstall"], new CollectingLogger(), fakeClineDir);
    expect(code).toBe(0);
    expect(existsSync(join(fakeClineDir, MARKER_FILE))).toBe(false);
  });

  it("uninstall with no prior install exits 0 with 'nothing to uninstall'", async () => {
    // Ensure dir exists but no marker
    const { mkdirSync } = await import("node:fs");
    mkdirSync(fakeClineDir, { recursive: true });

    const logger = new CollectingLogger();
    const code = await hooksClineInstall(["--uninstall"], logger, fakeClineDir);
    expect(code).toBe(0);
    expect(logger.logLines.some((l) => l.includes("nothing to uninstall"))).toBe(true);
  });

  it("uninstall is idempotent — second uninstall exits 0", async () => {
    await hooksClineInstall([], new CollectingLogger(), fakeClineDir);
    await hooksClineInstall(["--uninstall"], new CollectingLogger(), fakeClineDir);
    const code = await hooksClineInstall(["--uninstall"], new CollectingLogger(), fakeClineDir);
    expect(code).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Suite 4: Invalid flags
// ---------------------------------------------------------------------------

describe("hooksClineInstall — invalid flags", () => {
  it("returns 1 for unknown flag", async () => {
    const logger = new CollectingLogger();
    const code = await hooksClineInstall(["--bogus-flag"], logger, fakeClineDir);
    expect(code).toBe(1);
    expect(logger.errLines.some((l) => l.includes("error:"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Suite 5: .yakccrc.json installedHooks bookkeeping (#759)
// ---------------------------------------------------------------------------

describe("hooksClineInstall — .yakccrc.json installedHooks bookkeeping", () => {
  it("install with --target and existing rc adds 'cline' to installedHooks", async () => {
    writeFileSync(
      join(tmpDir, ".yakccrc.json"),
      JSON.stringify({ version: 1, registry: { path: ".yakcc/registry.sqlite" }, installedHooks: [] }, null, 2),
      "utf-8",
    );
    await hooksClineInstall(["--target", tmpDir], new CollectingLogger(), fakeClineDir);
    const rc = readRc(tmpDir);
    expect((rc?.installedHooks as string[]).includes("cline")).toBe(true);
  });

  it("install with --target and no rc creates .yakccrc.json with installedHooks: ['cline']", async () => {
    expect(existsSync(join(tmpDir, ".yakccrc.json"))).toBe(false);
    await hooksClineInstall(["--target", tmpDir], new CollectingLogger(), fakeClineDir);
    const rc = readRc(tmpDir);
    expect(rc).not.toBeNull();
    expect(rc?.installedHooks).toEqual(["cline"]);
  });

  it("install twice with --target does not duplicate 'cline' (idempotent)", async () => {
    await hooksClineInstall(["--target", tmpDir], new CollectingLogger(), fakeClineDir);
    await hooksClineInstall(["--target", tmpDir], new CollectingLogger(), fakeClineDir);
    const rc = readRc(tmpDir);
    const hooks = rc?.installedHooks as string[];
    expect(hooks.filter((h) => h === "cline").length).toBe(1);
  });

  it("--uninstall with --target removes 'cline' from installedHooks", async () => {
    await hooksClineInstall(["--target", tmpDir], new CollectingLogger(), fakeClineDir);
    await hooksClineInstall(["--uninstall", "--target", tmpDir], new CollectingLogger(), fakeClineDir);
    const rc = readRc(tmpDir);
    const hooks = rc?.installedHooks as string[];
    expect(hooks.includes("cline")).toBe(false);
  });
});
