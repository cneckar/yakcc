// SPDX-License-Identifier: MIT
// Tests for packages/registry/src/lock.ts (WI-777)
//
// Coverage:
//   - :memory: path: immediate no-op release
//   - normal acquire/release lifecycle
//   - lock file contains valid PID + ISO timestamp
//   - stale-lock detection (dead PID → steal)
//   - timeout with live holder

import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acquireWriteLock } from "./lock.js";

let tmpDir: string;
let dbPath: string;
let lockPath: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "yakcc-lock-test-"));
  dbPath = join(tmpDir, "registry.sqlite");
  lockPath = join(tmpDir, ".write.lock");
});

afterEach(async () => {
  // Clean up temp dir; ignore errors (already cleaned).
  await rm(tmpDir, { recursive: true, force: true });
});

describe("acquireWriteLock — :memory: path", () => {
  it("returns a no-op release immediately without creating any file", async () => {
    const release = await acquireWriteLock(":memory:");
    expect(typeof release).toBe("function");
    // Calling release must not throw.
    expect(() => release()).not.toThrow();
  });
});

describe("acquireWriteLock — normal lifecycle", () => {
  it("creates a lock file with pid and timestamp", async () => {
    const release = await acquireWriteLock(dbPath);
    expect(existsSync(lockPath)).toBe(true);

    const content = JSON.parse(readFileSync(lockPath, "utf8")) as {
      pid: number;
      timestamp: string;
    };
    expect(content.pid).toBe(process.pid);
    expect(typeof content.timestamp).toBe("string");
    // Timestamp must be a valid ISO-8601 string.
    expect(new Date(content.timestamp).getTime()).toBeGreaterThan(0);

    release();
    expect(existsSync(lockPath)).toBe(false);
  });

  it("calling release twice does not throw", async () => {
    const release = await acquireWriteLock(dbPath);
    release();
    expect(() => release()).not.toThrow();
  });
});

describe("acquireWriteLock — stale lock detection", () => {
  it("steals a lock file whose PID is not alive", async () => {
    // Write a lock file with a PID that is guaranteed to not exist.
    // PID 0 is invalid on all POSIX systems (process.kill(0, 0) throws EINVAL or EPERM).
    // We want a PID that throws ESRCH (no such process). Use a high value that is
    // extremely unlikely to be in use: 2^31 - 1 is above any real PID limit.
    const deadPid = 2_147_483_647;
    writeFileSync(
      lockPath,
      JSON.stringify({ pid: deadPid, timestamp: new Date().toISOString() }),
    );

    // acquireWriteLock should detect the dead PID and steal the lock.
    const release = await acquireWriteLock(dbPath, { timeoutMs: 2000 });
    expect(existsSync(lockPath)).toBe(true);

    const content = JSON.parse(readFileSync(lockPath, "utf8")) as { pid: number };
    // The new lock must be owned by the current process, not the dead one.
    expect(content.pid).toBe(process.pid);

    release();
  });
});

describe("acquireWriteLock — timeout", () => {
  it("throws with reason='write_lock_timeout' when lock is held by a live process", async () => {
    // Write a lock file with this process's own PID (guaranteed alive).
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, timestamp: new Date().toISOString() }));

    // Use a very short timeout so the test doesn't take long.
    const err = await acquireWriteLock(dbPath, { timeoutMs: 150 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error & { reason: string }).reason).toBe("write_lock_timeout");
    expect((err as Error).message).toContain("Registry write lock held by");
    expect((err as Error).message).toContain(lockPath);

    // Clean up the pre-written lock file.
    unlinkSync(lockPath);
  });
});
