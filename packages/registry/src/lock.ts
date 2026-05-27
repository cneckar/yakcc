// SPDX-License-Identifier: MIT
// @decision DEC-WRITE-LOCK-001
// @title Cross-process advisory write lock for the SQLite registry
// @status decided (WI-777 — SQLite concurrency hardening)
// @rationale WAL mode handles concurrent readers fine, but SQLite's single-writer
//   model means two simultaneous writers against the same registry produce
//   SQLITE_BUSY errors after busy_timeout expires. An advisory file lock
//   placed at <registryDir>/.write.lock serializes writers at the process
//   level — the first writer acquires it, the second waits (polling) and
//   eventually errors with a clear diagnostic. This is cooperative, not
//   kernel-enforced; tools that bypass it still fall back to SQLite's own
//   busy_timeout. Stale-lock detection (PID liveness via process.kill(pid,0))
//   ensures a killed writer doesn't permanently block future writers.

import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Metadata stored in the lock file. */
interface LockMeta {
  pid: number;
  startedAt: string; // ISO 8601
}

/** Options controlling lock acquisition behaviour. */
export interface WriteLockOptions {
  /**
   * Maximum milliseconds to wait before throwing a BUSY error.
   * Defaults to `YAKCC_WRITE_LOCK_TIMEOUT_MS` env var, or 30 000 ms.
   */
  timeoutMs?: number;
  /** Polling interval while waiting for the lock. Default: 100 ms. */
  pollIntervalMs?: number;
}

/** Call this function (in a `finally`) to release the write lock. */
export type ReleaseLock = () => void;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readMeta(lockPath: string): LockMeta | null {
  try {
    const text = readFileSync(lockPath, "utf-8");
    return JSON.parse(text) as LockMeta;
  } catch {
    return null;
  }
}

function isPidAlive(pid: number): boolean {
  try {
    // signal 0 checks for existence without sending a signal; throws if dead
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function tryAcquire(lockPath: string): boolean {
  try {
    // flag 'wx': O_CREAT | O_EXCL — atomic "create only if absent" on POSIX.
    // Throws EEXIST if the file already exists, which is our "lock is held" signal.
    writeFileSync(
      lockPath,
      JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() } satisfies LockMeta),
      { flag: "wx" },
    );
    return true;
  } catch (err) {
    // Only treat EEXIST as "lock is held" — all other errors (ENOENT bad dir,
    // EACCES permissions, etc.) must propagate immediately so callers see the
    // real failure rather than spinning until timeout.
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      return false;
    }
    throw err;
  }
}

function forceRelease(lockPath: string): void {
  try {
    rmSync(lockPath);
  } catch {
    // Best-effort: if the file is already gone, that's fine.
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Returns the lock-file path for a given registry database path.
 * Lock file lives in the same directory as the `.sqlite` file.
 */
export function lockFilePathFor(registryPath: string): string {
  return join(dirname(registryPath), ".write.lock");
}

/**
 * Acquire a cross-process advisory write lock for the registry at `registryPath`.
 *
 * - Lock file: `<dirname(registryPath)>/.write.lock` (JSON: `{ pid, startedAt }`)
 * - Stale-lock detection: if the lock file's PID is dead the lock is stolen.
 * - `:memory:` registries skip locking (no concurrent writers possible).
 *
 * @returns A `ReleaseLock` function. Call it (ideally in a `finally` block) to
 *          release the lock. Double-release is safe (idempotent).
 * @throws If the lock cannot be acquired within `timeoutMs`.
 */
export async function acquireWriteLock(
  registryPath: string,
  opts: WriteLockOptions = {},
): Promise<ReleaseLock> {
  // In-memory registries are single-process by definition; no lock needed.
  if (registryPath === ":memory:") {
    return () => {};
  }

  const timeoutMs =
    opts.timeoutMs ??
    (process.env["YAKCC_WRITE_LOCK_TIMEOUT_MS"]
      ? Number(process.env["YAKCC_WRITE_LOCK_TIMEOUT_MS"])
      : 30_000);
  const pollMs = opts.pollIntervalMs ?? 100;
  const lockPath = lockFilePathFor(registryPath);
  const deadline = Date.now() + timeoutMs;

  let released = false;

  while (true) {
    if (tryAcquire(lockPath)) {
      return () => {
        if (!released) {
          released = true;
          forceRelease(lockPath);
        }
      };
    }

    // Lock file exists. Check for stale lock (dead holder PID).
    const meta = readMeta(lockPath);
    if (meta !== null && !isPidAlive(meta.pid)) {
      // Holder process is dead — steal the lock and retry immediately.
      forceRelease(lockPath);
      continue;
    }

    if (Date.now() >= deadline) {
      const holderDesc =
        meta !== null ? `PID ${meta.pid} (since ${meta.startedAt})` : "unknown process";
      throw new Error(
        `Registry write lock held by ${holderDesc}; ` +
          `if that process is dead, remove ${lockPath} manually`,
      );
    }

    await sleep(pollMs);
  }
}
