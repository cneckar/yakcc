/**
 * lock.test.ts — unit tests for the cross-process advisory write lock.
 *
 * Tests run against a temporary directory on disk (not :memory:) because the
 * lock module writes a real file. All tests clean up after themselves.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acquireWriteLock, lockFilePathFor } from "./lock.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let testDir: string;
let registryPath: string;
let lockPath: string;

beforeEach(() => {
  testDir = join(tmpdir(), `yakcc-lock-test-${process.pid}-${Date.now()}`);
  mkdirSync(testDir, { recursive: true });
  registryPath = join(testDir, "registry.sqlite");
  lockPath = lockFilePathFor(registryPath);
});

afterEach(() => {
  // Best-effort cleanup.
  try {
    rmSync(testDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

// ---------------------------------------------------------------------------
// lockFilePathFor
// ---------------------------------------------------------------------------

describe("lockFilePathFor", () => {
  it("places lock file alongside the registry db", () => {
    expect(lockFilePathFor("/home/user/.yakcc/registry.sqlite")).toBe(
      "/home/user/.yakcc/.write.lock",
    );
  });
});

// ---------------------------------------------------------------------------
// acquireWriteLock — basic acquire and release
// ---------------------------------------------------------------------------

describe("acquireWriteLock — basic", () => {
  it("creates the lock file on acquire", async () => {
    const release = await acquireWriteLock(registryPath);
    expect(existsSync(lockPath)).toBe(true);
    release();
  });

  it("lock file contains valid JSON with pid and startedAt", async () => {
    const release = await acquireWriteLock(registryPath);
    const meta = JSON.parse(readFileSync(lockPath, "utf-8")) as {
      pid: number;
      startedAt: string;
    };
    expect(meta.pid).toBe(process.pid);
    expect(new Date(meta.startedAt).getTime()).toBeGreaterThan(0);
    release();
  });

  it("removes the lock file on release", async () => {
    const release = await acquireWriteLock(registryPath);
    expect(existsSync(lockPath)).toBe(true);
    release();
    expect(existsSync(lockPath)).toBe(false);
  });

  it("double-release is safe (idempotent)", async () => {
    const release = await acquireWriteLock(registryPath);
    release();
    expect(() => release()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// acquireWriteLock — :memory: registry bypass
// ---------------------------------------------------------------------------

describe("acquireWriteLock — :memory: bypass", () => {
  it("returns a no-op release for :memory:", async () => {
    const release = await acquireWriteLock(":memory:");
    // No lock file should be created (no path to derive one from)
    expect(typeof release).toBe("function");
    expect(() => release()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// acquireWriteLock — timeout when lock is held
// ---------------------------------------------------------------------------

describe("acquireWriteLock — timeout", () => {
  it("throws when the lock file is held and timeout expires", async () => {
    // Manually place a lock file with our own PID so stale-detection doesn't steal it.
    writeFileSync(
      lockPath,
      JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
      { flag: "w" }, // overwrite (not wx) so we can write directly
    );

    await expect(
      acquireWriteLock(registryPath, { timeoutMs: 150, pollIntervalMs: 50 }),
    ).rejects.toThrow(/write lock held/);
  });

  it("error message includes the holder PID", async () => {
    writeFileSync(
      lockPath,
      JSON.stringify({ pid: process.pid, startedAt: "2026-01-01T00:00:00.000Z" }),
      { flag: "w" },
    );

    await expect(
      acquireWriteLock(registryPath, { timeoutMs: 100, pollIntervalMs: 40 }),
    ).rejects.toThrow(new RegExp(`PID ${process.pid}`));
  });
});

// ---------------------------------------------------------------------------
// acquireWriteLock — stale-lock detection
// ---------------------------------------------------------------------------

describe("acquireWriteLock — stale lock", () => {
  it("steals a lock held by a dead PID", async () => {
    // PID 999999 is almost certainly not a running process.
    const deadPid = 999999;
    writeFileSync(
      lockPath,
      JSON.stringify({ pid: deadPid, startedAt: new Date().toISOString() }),
      { flag: "w" },
    );

    // Should succeed immediately (stale detection kicks in on first poll).
    const release = await acquireWriteLock(registryPath, { timeoutMs: 2000 });
    expect(existsSync(lockPath)).toBe(true);
    const meta = JSON.parse(readFileSync(lockPath, "utf-8")) as { pid: number };
    // The new lock file should have our PID, not the dead one.
    expect(meta.pid).toBe(process.pid);
    release();
  });
});

// ---------------------------------------------------------------------------
// acquireWriteLock — sequential acquire after release
// ---------------------------------------------------------------------------

describe("acquireWriteLock — sequential reacquire", () => {
  it("can acquire the lock again after releasing it", async () => {
    const release1 = await acquireWriteLock(registryPath, { timeoutMs: 500 });
    release1();

    const release2 = await acquireWriteLock(registryPath, { timeoutMs: 500 });
    expect(existsSync(lockPath)).toBe(true);
    release2();
    expect(existsSync(lockPath)).toBe(false);
  });
});
