/**
 * hooks-rc-bookkeeping.test.ts
 *
 * Integration tests verifying that each standalone hooks-*-install command
 * correctly maintains .yakccrc.json installedHooks when --target (or the
 * overrideTargetDir injection seam) is provided.
 *
 * Acceptance criteria from issue #759:
 *   - Install adds the IDE name to installedHooks (with existing rc).
 *   - Install creates a minimal rc when no .yakccrc.json exists.
 *   - Install is idempotent (no duplicate entries).
 *   - Uninstall removes the IDE name from installedHooks.
 *   - yakcc init behavior is unchanged (tested via init.test.ts; not re-tested here).
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CollectingLogger } from "../index.js";
import { hooksAiderInstall } from "./hooks-aider-install.js";
import { hooksClineInstall } from "./hooks-cline-install.js";
import { hooksContinueInstall } from "./hooks-continue-install.js";
import { hooksCursorInstall } from "./hooks-cursor-install.js";
import { hooksClaudeCodeInstall } from "./hooks-install.js";
import { hooksWindsurfInstall } from "./hooks-windsurf-install.js";

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "yakcc-rc-bookkeeping-test-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function readRc(dir: string): Record<string, unknown> | null {
  const p = join(dir, ".yakccrc.json");
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf-8")) as Record<string, unknown>;
}

function writeRc(dir: string, rc: Record<string, unknown>): void {
  writeFileSync(join(dir, ".yakccrc.json"), `${JSON.stringify(rc, null, 2)}\n`, "utf-8");
}

function fakeIdeDir(subPath: string): string {
  const d = join(tmpDir, subPath);
  mkdirSync(d, { recursive: true });
  return d;
}

// ---------------------------------------------------------------------------
// Helper: run all 6 installers with their respective install args
// ---------------------------------------------------------------------------

type InstallerFn = (
  targetDir: string,
  overrideDir: string,
  uninstall?: boolean,
) => Promise<number>;

const installers: Array<{ name: string; ideName: string; run: InstallerFn }> = [
  {
    name: "claude-code",
    ideName: "claude-code",
    run: (targetDir, _overrideDir, uninstall) =>
      hooksClaudeCodeInstall(
        uninstall ? ["--target", targetDir, "--uninstall"] : ["--target", targetDir],
        new CollectingLogger(),
      ),
  },
  {
    name: "cursor",
    ideName: "cursor",
    run: (targetDir, _overrideDir, uninstall) =>
      hooksCursorInstall(
        uninstall ? ["--target", targetDir, "--uninstall"] : ["--target", targetDir],
        new CollectingLogger(),
      ),
  },
  {
    name: "windsurf",
    ideName: "windsurf",
    run: (targetDir, _overrideDir, uninstall) =>
      hooksWindsurfInstall(
        uninstall ? ["--target", targetDir, "--uninstall"] : ["--target", targetDir],
        new CollectingLogger(),
      ),
  },
  {
    name: "cline",
    ideName: "cline",
    run: (targetDir, overrideDir, uninstall) =>
      hooksClineInstall(
        uninstall ? ["--uninstall"] : [],
        new CollectingLogger(),
        overrideDir,
        targetDir,
      ),
  },
  {
    name: "continue",
    ideName: "continue",
    run: (targetDir, overrideDir, uninstall) =>
      hooksContinueInstall(
        uninstall ? ["--uninstall"] : [],
        new CollectingLogger(),
        overrideDir,
        targetDir,
      ),
  },
  {
    name: "aider",
    ideName: "aider",
    run: (targetDir, overrideDir, uninstall) =>
      hooksAiderInstall(
        uninstall ? ["--uninstall"] : [],
        new CollectingLogger(),
        overrideDir,
        targetDir,
      ),
  },
];

// ---------------------------------------------------------------------------
// Suite A: rc file exists with installedHooks — install adds ide name
// ---------------------------------------------------------------------------

describe("rc bookkeeping — install adds IDE name to existing rc", () => {
  for (const { name, ideName, run } of installers) {
    it(`${name}: install adds "${ideName}" to existing rc.installedHooks`, async () => {
      writeRc(tmpDir, { version: 1, registry: { path: ".yakcc/registry.sqlite" }, installedHooks: [] });
      const overrideDir = fakeIdeDir(`.fake-${name}`);

      const code = await run(tmpDir, overrideDir);
      expect(code).toBe(0);

      const rc = readRc(tmpDir);
      expect(rc).not.toBeNull();
      expect(Array.isArray(rc!.installedHooks)).toBe(true);
      expect((rc!.installedHooks as string[]).includes(ideName)).toBe(true);
    });
  }
});

// ---------------------------------------------------------------------------
// Suite B: no rc file — install creates one with installedHooks: [ide]
// ---------------------------------------------------------------------------

describe("rc bookkeeping — install creates rc when none exists", () => {
  for (const { name, ideName, run } of installers) {
    it(`${name}: install creates .yakccrc.json with installedHooks: ["${ideName}"]`, async () => {
      expect(existsSync(join(tmpDir, ".yakccrc.json"))).toBe(false);
      const overrideDir = fakeIdeDir(`.fake-${name}`);

      const code = await run(tmpDir, overrideDir);
      expect(code).toBe(0);

      const rc = readRc(tmpDir);
      expect(rc).not.toBeNull();
      expect(Array.isArray(rc!.installedHooks)).toBe(true);
      expect((rc!.installedHooks as string[]).includes(ideName)).toBe(true);
    });
  }
});

// ---------------------------------------------------------------------------
// Suite C: idempotency — install twice does not duplicate the ide name
// ---------------------------------------------------------------------------

describe("rc bookkeeping — install is idempotent (no duplicate entries)", () => {
  for (const { name, ideName, run } of installers) {
    it(`${name}: running install twice keeps exactly one "${ideName}" in installedHooks`, async () => {
      const overrideDir = fakeIdeDir(`.fake-${name}`);

      await run(tmpDir, overrideDir);
      await run(tmpDir, overrideDir);

      const rc = readRc(tmpDir);
      expect(rc).not.toBeNull();
      const hooks = rc!.installedHooks as string[];
      expect(hooks.filter((h) => h === ideName).length).toBe(1);
    });
  }
});

// ---------------------------------------------------------------------------
// Suite D: uninstall removes ide name from installedHooks
// ---------------------------------------------------------------------------

describe("rc bookkeeping — uninstall removes IDE name from rc", () => {
  for (const { name, ideName, run } of installers) {
    it(`${name}: uninstall removes "${ideName}" from installedHooks`, async () => {
      const overrideDir = fakeIdeDir(`.fake-${name}`);

      // Install first
      await run(tmpDir, overrideDir, false);
      const rcAfterInstall = readRc(tmpDir);
      expect((rcAfterInstall!.installedHooks as string[]).includes(ideName)).toBe(true);

      // Uninstall
      const code = await run(tmpDir, overrideDir, true);
      expect(code).toBe(0);

      const rcAfterUninstall = readRc(tmpDir);
      expect(rcAfterUninstall).not.toBeNull();
      expect((rcAfterUninstall!.installedHooks as string[]).includes(ideName)).toBe(false);
    });
  }
});

// ---------------------------------------------------------------------------
// Suite E: preserves other fields in existing rc on install/uninstall
// ---------------------------------------------------------------------------

describe("rc bookkeeping — preserves existing rc fields", () => {
  for (const { name, ideName, run } of installers) {
    it(`${name}: install does not clobber other rc fields`, async () => {
      writeRc(tmpDir, {
        version: 1,
        mode: "local",
        registry: { path: ".yakcc/custom.sqlite" },
        installedHooks: ["other-ide"],
      });
      const overrideDir = fakeIdeDir(`.fake-${name}`);

      await run(tmpDir, overrideDir);

      const rc = readRc(tmpDir);
      expect(rc!.mode).toBe("local");
      expect((rc!.registry as Record<string, string>).path).toBe(".yakcc/custom.sqlite");
      const hooks = rc!.installedHooks as string[];
      expect(hooks.includes("other-ide")).toBe(true);
      expect(hooks.includes(ideName)).toBe(true);
    });
  }
});
