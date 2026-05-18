/**
 * hooks-continue-install.test.ts — tests for the Continue.dev hook marker installer.
 *
 * Production sequence exercised:
 *   hooksContinueInstall(argv, logger, overrideContinueDir)
 *   → parseArgs → mkdirSync(continueDir) → isYakccInstalled → writeFileSync(marker) → log
 *
 * Mirrors the shape of hooks-cline-install.test.ts. Tests use overrideContinueDir
 * so no real ~/.continue is touched.
 *
 * @decision DEC-CLI-HOOKS-CONTINUE-INSTALL-001 — marker-file installer; no live
 *   hook wiring yet; idempotent install/uninstall.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CollectingLogger } from "../index.js";
import { hooksContinueInstall } from "./hooks-continue-install.js";

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let tmpDir: string;
let fakeContinueDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "yakcc-continue-install-test-"));
  fakeContinueDir = join(tmpDir, ".continue");
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

const MARKER_FILE = "yakcc-continue-hook.json";

function readMarker(dir: string): Record<string, unknown> | null {
  const p = join(dir, MARKER_FILE);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf-8")) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Suite 1: Happy path install
// ---------------------------------------------------------------------------

describe("hooksContinueInstall — install", () => {
  it("exits 0 on fresh install", async () => {
    const logger = new CollectingLogger();
    const code = await hooksContinueInstall([], logger, fakeContinueDir);
    expect(code).toBe(0);
  });

  it("creates the continue config dir if absent", async () => {
    await hooksContinueInstall([], new CollectingLogger(), fakeContinueDir);
    expect(existsSync(fakeContinueDir)).toBe(true);
  });

  it("writes the marker file with the _yakcc sentinel", async () => {
    await hooksContinueInstall([], new CollectingLogger(), fakeContinueDir);
    const marker = readMarker(fakeContinueDir);
    expect(marker).not.toBeNull();
    expect(marker?._yakcc).toBe("yakcc-hook-v1-continue");
  });

  it("marker file contains the hook command", async () => {
    await hooksContinueInstall([], new CollectingLogger(), fakeContinueDir);
    const marker = readMarker(fakeContinueDir);
    expect(marker?.command).toBe("yakcc hook-intercept");
  });

  it("marker file contains installedAt timestamp", async () => {
    await hooksContinueInstall([], new CollectingLogger(), fakeContinueDir);
    const marker = readMarker(fakeContinueDir);
    expect(typeof marker?.installedAt).toBe("string");
    expect((marker?.installedAt as string).length).toBeGreaterThan(0);
  });

  it("marker file contains a note about API stability", async () => {
    await hooksContinueInstall([], new CollectingLogger(), fakeContinueDir);
    const marker = readMarker(fakeContinueDir);
    expect(typeof marker?.note).toBe("string");
    expect((marker?.note as string).toLowerCase()).toContain("continue");
  });

  it("logs success message", async () => {
    const logger = new CollectingLogger();
    await hooksContinueInstall([], logger, fakeContinueDir);
    expect(logger.logLines.some((l) => l.includes("installed"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Suite 2: Idempotency
// ---------------------------------------------------------------------------

describe("hooksContinueInstall — idempotency", () => {
  it("second install exits 0", async () => {
    await hooksContinueInstall([], new CollectingLogger(), fakeContinueDir);
    const code = await hooksContinueInstall([], new CollectingLogger(), fakeContinueDir);
    expect(code).toBe(0);
  });

  it("second install does not overwrite the marker timestamp", async () => {
    await hooksContinueInstall([], new CollectingLogger(), fakeContinueDir);
    const ts1 = readMarker(fakeContinueDir)?.installedAt as string;

    await new Promise((r) => setTimeout(r, 5));

    await hooksContinueInstall([], new CollectingLogger(), fakeContinueDir);
    const ts2 = readMarker(fakeContinueDir)?.installedAt as string;

    expect(ts1).toBe(ts2); // unchanged — idempotent
  });

  it("second install logs 'already installed'", async () => {
    await hooksContinueInstall([], new CollectingLogger(), fakeContinueDir);
    const logger = new CollectingLogger();
    await hooksContinueInstall([], logger, fakeContinueDir);
    expect(logger.logLines.some((l) => l.includes("already installed"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Suite 3: Uninstall
// ---------------------------------------------------------------------------

describe("hooksContinueInstall — uninstall", () => {
  it("uninstall after install removes the marker file", async () => {
    await hooksContinueInstall([], new CollectingLogger(), fakeContinueDir);
    expect(existsSync(join(fakeContinueDir, MARKER_FILE))).toBe(true);

    const code = await hooksContinueInstall(
      ["--uninstall"],
      new CollectingLogger(),
      fakeContinueDir,
    );
    expect(code).toBe(0);
    expect(existsSync(join(fakeContinueDir, MARKER_FILE))).toBe(false);
  });

  it("uninstall with no prior install exits 0 with 'nothing to uninstall'", async () => {
    const { mkdirSync } = await import("node:fs");
    mkdirSync(fakeContinueDir, { recursive: true });

    const logger = new CollectingLogger();
    const code = await hooksContinueInstall(["--uninstall"], logger, fakeContinueDir);
    expect(code).toBe(0);
    expect(logger.logLines.some((l) => l.includes("nothing to uninstall"))).toBe(true);
  });

  it("uninstall is idempotent — second uninstall exits 0", async () => {
    await hooksContinueInstall([], new CollectingLogger(), fakeContinueDir);
    await hooksContinueInstall(["--uninstall"], new CollectingLogger(), fakeContinueDir);
    const code = await hooksContinueInstall(
      ["--uninstall"],
      new CollectingLogger(),
      fakeContinueDir,
    );
    expect(code).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Suite 4: Invalid flags
// ---------------------------------------------------------------------------

describe("hooksContinueInstall — invalid flags", () => {
  it("returns 1 for unknown flag", async () => {
    const logger = new CollectingLogger();
    const code = await hooksContinueInstall(["--bogus-flag"], logger, fakeContinueDir);
    expect(code).toBe(1);
    expect(logger.errLines.some((l) => l.includes("error:"))).toBe(true);
  });
});
