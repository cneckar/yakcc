// SPDX-License-Identifier: MIT
//
// as-parity-runner.ts — Parallelization utilities for the AS parity test suite
//
// @decision DEC-AS-CLOSER-PARITY-CONCURRENCY-001
// Title: Promise pool with computeAscConcurrency(); default 4 (CI) / 6 (dev);
//        env override YAKCC_AS_PARITY_CONCURRENCY.
// Status: decided (plans/wi-531-asc-compile-cache.md §DEC-AS-CLOSER-PARITY-CONCURRENCY-001)
// Rationale:
//   The serial loop in closer-parity-as.test.ts iterated over 4119+ atoms
//   synchronously, making cold-cache runs exceed the 60-min hookTimeout on slow
//   CI runners. This module recovers the parallelization work that was lost in
//   cleanup (WI-FIX-485-CLOSER-PARITY-TIMEOUT, branch deleted without PR merge).
//   A bounded promise pool is used instead of Promise.all to avoid spawning all
//   asc child processes simultaneously (disk/IO-bound workload; scheduler thrash
//   outweighs gains above 6 concurrent processes on typical dev machines).
//   Default caps: 6 dev / 4 CI. YAKCC_AS_PARITY_CONCURRENCY overrides both.
//   YAKCC_AS_PARITY_CONCURRENCY=1 reproduces serial behavior for rollback proof.

import * as os from "node:os";

// ---------------------------------------------------------------------------
// computeAscConcurrency
// ---------------------------------------------------------------------------

/**
 * Compute the number of concurrent asc compiles to run in parallel.
 *
 * Resolution order:
 *   1. `YAKCC_AS_PARITY_CONCURRENCY` env var — explicit override, must be an
 *      integer ≥ 1.
 *   2. Detect CI: `process.env.CI === "true"` or `"1"` (overridable via opts).
 *   3. Apply default cap: min(cpus, ci ? 4 : 6). Always ≥ 1.
 *
 * @decision DEC-AS-CLOSER-PARITY-CONCURRENCY-001
 */
export function computeAscConcurrency(opts?: { ci?: boolean }): number {
  // Env override: YAKCC_AS_PARITY_CONCURRENCY
  const envVal = process.env.YAKCC_AS_PARITY_CONCURRENCY;
  if (envVal !== undefined) {
    const n = Number.parseInt(envVal, 10);
    if (Number.isFinite(n) && n >= 1) return n;
    // Invalid value: fall through to defaults (warn silently; don't throw).
  }

  // Detect CI environment.
  const ci = opts?.ci ?? (process.env.CI === "true" || process.env.CI === "1");

  // Cap based on logical CPUs available.
  const cpus = Math.max(1, os.cpus().length);
  return Math.min(cpus, ci ? 4 : 6);
}

// ---------------------------------------------------------------------------
// processAtomsInParallel
// ---------------------------------------------------------------------------

/**
 * Process `items` in parallel with a bounded concurrency promise pool.
 *
 * Contract:
 *   - Returns results in input order (result[i] corresponds to items[i]).
 *   - At most `concurrency` workers are in-flight simultaneously.
 *   - If any worker rejects, the error propagates at the boundary after all
 *     in-flight promises settle (Promise.allSettled semantics internally).
 *     The first rejection encountered is rethrown; subsequent rejections are
 *     silently dropped to preserve the order-stable result contract.
 *   - `worker` receives `(item, index)` for callers that need stable indexing.
 *   - Empty `items` → resolves to `[]` immediately.
 *
 * @decision DEC-AS-CLOSER-PARITY-CONCURRENCY-001
 *
 * @param items - Input array (readonly).
 * @param worker - Async function applied to each item.
 * @param concurrency - Maximum number of simultaneous in-flight promises (≥ 1).
 * @returns Results in input order.
 */
export async function processAtomsInParallel<T, R>(
  items: ReadonlyArray<T>,
  worker: (item: T, index: number) => Promise<R>,
  concurrency: number,
): Promise<R[]> {
  if (items.length === 0) return [];

  const results: R[] = new Array(items.length) as R[];
  let cursor = 0; // next item index to dispatch
  let firstRejection: unknown = undefined;
  let hasRejection = false;

  // Spawn up to `concurrency` driver coroutines. Each driver picks the next
  // unstarted item from `cursor` until exhausted.
  async function driver(): Promise<void> {
    while (cursor < items.length) {
      const idx = cursor++;
      // biome-ignore lint/style/noNonNullAssertion: idx always in bounds (cursor guard above)
      const item = items[idx]!;
      try {
        results[idx] = await worker(item, idx);
      } catch (err) {
        if (!hasRejection) {
          hasRejection = true;
          firstRejection = err;
        }
        // Continue draining to avoid orphaned promises; result slot stays
        // undefined (caller won't use it once we re-throw).
      }
    }
  }

  // Clamp concurrency to at most items.length (no point spawning more drivers
  // than there are items).
  const driverCount = Math.min(Math.max(1, concurrency), items.length);
  const drivers = Array.from({ length: driverCount }, () => driver());
  await Promise.all(drivers);

  if (hasRejection) throw firstRejection;
  return results;
}
