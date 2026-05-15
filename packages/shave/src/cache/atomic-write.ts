// SPDX-License-Identifier: MIT
// @decision DEC-SHAVE-CACHE-RENAME-RETRY-001: writeIntent's tmp→final rename
// retries on EPERM/EBUSY (Windows transient lock) with bounded exponential
// backoff (5 attempts: 10/20/40/80/160 ms; ~310 ms total worst-case budget).
// Status: decided (plans/wi-525-cache-eperm.md §4.1)
// Rationale: Windows MoveFileEx surfaces EPERM/EBUSY when the destination
// path is briefly held by a concurrent writer's handle (sibling writeIntent
// completing its own tmp→final rename). The lock window typically clears in
// <100 ms; 5 attempts at ~310 ms total absorbs the 99th-percentile contention
// window without masking genuine persistent failures. Non-retryable codes
// (EISDIR, ENOENT, EACCES, ENOSPC, …) rethrow immediately on the first
// attempt so existing error semantics are fully preserved. POSIX rename is
// atomic over open handles, so this helper is a no-op overhead on Linux/macOS.

import { rename } from "node:fs/promises";

/** Maximum number of rename attempts (1 initial + 4 retries). */
const MAX_ATTEMPTS = 5;

/**
 * Exponential backoff delays in milliseconds between successive attempts.
 * Index 0 is the delay *after* the first failed attempt, index 3 after the
 * fourth. The fifth attempt (if it fails) exhausts the budget and rethrows
 * without sleeping.
 */
const BACKOFF_MS: readonly number[] = [10, 20, 40, 80, 160];

/**
 * Error codes that indicate a transient Windows file-lock condition.
 * All other codes are treated as permanent and rethrown immediately.
 */
const RETRYABLE_CODES = new Set<string>(["EPERM", "EBUSY"]);

/**
 * Atomically rename `src` to `dst`, retrying on transient Windows lock errors.
 *
 * On POSIX systems `fs.rename` is atomic with respect to open handles and
 * never returns EPERM/EBUSY from the lock-contention path, so this function
 * adds zero observable overhead on Linux/macOS.
 *
 * On Windows, concurrent `writeIntent` calls that race on the same `dst` path
 * may surface EPERM (ERROR_ACCESS_DENIED from MoveFileEx) or EBUSY
 * (ERROR_SHARING_VIOLATION) while a sibling handle holds the destination
 * briefly. This helper retries up to MAX_ATTEMPTS times with exponential
 * backoff, then rethrows the final error so the caller's cleanup logic fires
 * as before.
 *
 * Non-retryable codes (EISDIR, ENOENT, EACCES on the parent directory, ENOSPC,
 * etc.) are rethrown on the very first attempt — preserving all existing error
 * semantics observed by callers and tests.
 *
 * @param src - Absolute path to the source (tmp) file.
 * @param dst - Absolute path to the destination (final) file.
 */
export async function renameWithRetry(src: string, dst: string): Promise<void> {
  let lastErr: unknown;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      await rename(src, dst);
      return; // success — done
    } catch (err) {
      lastErr = err;

      // Extract the error code; unknown shape → treat as non-retryable.
      const code =
        err !== null && typeof err === "object" && "code" in err
          ? (err as { code: unknown }).code
          : undefined;

      if (typeof code !== "string" || !RETRYABLE_CODES.has(code)) {
        // Non-retryable: rethrow the original error object immediately so the
        // caller sees the exact error (important for the EISDIR test in
        // cache.test.ts:190 which asserts rejects.toThrow() on the original).
        throw err;
      }

      // Retryable (EPERM or EBUSY): sleep before the next attempt, except
      // after the last attempt where we are about to rethrow anyway.
      if (attempt < MAX_ATTEMPTS - 1) {
        const delay = BACKOFF_MS[attempt] ?? BACKOFF_MS[BACKOFF_MS.length - 1] ?? 160;
        await new Promise<void>((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  // Exhausted all attempts; rethrow the last retryable error so the caller's
  // catch block (which unlinks the tmp file) fires normally.
  throw lastErr;
}
