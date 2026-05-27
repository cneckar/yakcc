// SPDX-License-Identifier: MIT
// @decision DEC-CONCURRENCY-LOCK-001
// title: Cross-process advisory write lock via O_CREAT|O_EXCL
// status: decided (WI-777 — SQLite concurrency hardening)
// rationale: Writer-writer contention is the real hazard under WAL mode; readers
//   run concurrently with no lock. A cross-process file lock (not an in-process
//   Mutex) is required because Node.js processes share no memory. O_CREAT|O_EXCL
//   is atomic on local POSIX filesystems. Stale-lock detection via
//   process.kill(pid, 0) lets a second writer steal a lock whose holder died
//   mid-write (e.g. kill -9). NFS is explicitly unsupported (out-of-scope WI-777).
//
// Lock file location: <dirname(dbPath)>/.write.lock
// Lock file content:  JSON { pid: number, timestamp: ISO-string }
// Env override:       YAKCC_WRITE_LOCK_TIMEOUT_MS (overrides opts.timeoutMs)

import { closeSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";

export interface WriteLockOptions {
  /** Milliseconds to wait before giving up. Default: 30 000. */
  timeoutMs?: number;
}

/** Calling this function releases the write lock (idempotent). */
export type Release = () => void;

const DEFAULT_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 100;

/**
 * Acquire a cross-process advisory write lock for the registry at `dbPath`.
 *
 * The lock file is placed at `<dirname(dbPath)>/.write.lock`. Returns a
 * `Release` callback; callers MUST call it in a `try-finally` block to
 * guarantee cleanup even on thrown errors.
 *
 * For `:memory:` registries no lock file is created and a no-op release is
 * returned immediately.
 *
 * @throws {Error} with `.reason === "write_lock_timeout"` if the lock cannot
 *   be acquired within `timeoutMs` (env `YAKCC_WRITE_LOCK_TIMEOUT_MS` overrides).
 */
export async function acquireWriteLock(dbPath: string, opts?: WriteLockOptions): Promise<Release> {
  if (dbPath === ":memory:") {
    return () => {};
  }

  const envMs =
    typeof process.env.YAKCC_WRITE_LOCK_TIMEOUT_MS === "string"
      ? Number.parseInt(process.env.YAKCC_WRITE_LOCK_TIMEOUT_MS, 10)
      : Number.NaN;
  const timeoutMs = Number.isFinite(envMs) && envMs > 0 ? envMs : (opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  const lockDir = dirname(dbPath);
  const lockPath = join(lockDir, ".write.lock");

  const deadline = Date.now() + timeoutMs;

  while (true) {
    // Attempt atomic exclusive create.
    try {
      const fd = openSync(lockPath, "wx"); // O_WRONLY | O_CREAT | O_EXCL
      writeSync(fd, JSON.stringify({ pid: process.pid, timestamp: new Date().toISOString() }));
      closeSync(fd);

      return () => {
        try {
          unlinkSync(lockPath);
        } catch {
          // Best-effort: ignore ENOENT / any cleanup error.
        }
      };
    } catch (createErr) {
      if ((createErr as NodeJS.ErrnoException).code !== "EEXIST") {
        throw createErr;
      }
    }

    // Lock file exists. Read holder metadata to check for staleness.
    let holderPid: number | null = null;
    let holderTimestamp: string | null = null;

    try {
      const raw = readFileSync(lockPath, "utf8");
      const info = JSON.parse(raw) as { pid?: unknown; timestamp?: unknown };
      if (typeof info.pid === "number") holderPid = info.pid;
      if (typeof info.timestamp === "string") holderTimestamp = info.timestamp;
    } catch {
      // File removed between EEXIST check and read, or content is corrupt.
      // Either way, retry immediately from the top of the loop.
      continue;
    }

    if (holderPid !== null) {
      let holderAlive = true;
      try {
        process.kill(holderPid, 0); // throws ESRCH if process does not exist
      } catch {
        holderAlive = false;
      }

      if (!holderAlive) {
        // Holder is dead — steal the lock by removing the stale file.
        try {
          unlinkSync(lockPath);
        } catch {
          // Another racer may have removed it first; that's fine.
        }
        continue;
      }
    }

    // Holder is alive (or PID unknown). Check timeout.
    if (Date.now() >= deadline) {
      const pidStr = holderPid !== null ? `PID ${holderPid}` : "unknown PID";
      const timeStr = holderTimestamp !== null ? ` (since ${holderTimestamp})` : "";
      const err = new Error(
        `Registry write lock held by ${pidStr}${timeStr}; if that process is dead, remove ${lockPath} manually`,
      );
      (err as Error & { reason: string }).reason = "write_lock_timeout";
      throw err;
    }

    await new Promise<void>((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}
