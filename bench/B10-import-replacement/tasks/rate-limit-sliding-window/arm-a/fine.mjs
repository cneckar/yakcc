// SPDX-License-Identifier: MIT
//
// bench/B10-import-replacement/tasks/rate-limit-sliding-window/arm-a/fine.mjs
//
// @decision DEC-BENCH-B10-SLICE3-ARMA-FALLBACK-001
// @title Arm A-fine produced via hand-translation fallback (not yakcc compile + #508 hook)
// @status accepted
// @rationale
//   Hand-translation of p-throttle@8.1.0 index.js WI-510 S9 (pure ESM, single-file).
//   GRANULARITY: A-fine -- 4 named functions. Zero non-builtin imports.
//
//   Cross-references:
//   DEC-BENCH-B10-SLICE3-TASK-CORPUS-SELECTION-001 -- corpus-spec.json
//   plans/wi-512-s3-b10-broaden.md §4

/**
 * Atom: validate throttle parameters.
 * @param {number} limit
 * @param {number} interval
 */
export function validateThrottleParams(limit, interval) {
  if (!Number.isFinite(limit) || limit < 1) throw new TypeError("limit must be a positive integer");
  if (!Number.isFinite(interval) || interval < 0) throw new TypeError("interval must be non-negative");
}

/**
 * Atom: create a promise queue entry.
 * @returns {{ resolve: Function, reject: Function, promise: Promise }}
 */
export function createQueueEntry() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { resolve, reject, promise };
}

/**
 * Atom: schedule queue drain after the interval.
 * @param {Function[]} queue
 * @param {number} interval
 * @param {{ value: number }} activeCount
 * @param {number} limit
 */
export function scheduleQueueDrain(queue, interval, activeCount, limit) {
  setTimeout(() => {
    activeCount.value--;
    if (queue.length > 0) {
      const next = queue.shift();
      activeCount.value++;
      next.resolve();
      scheduleQueueDrain(queue, interval, activeCount, limit);
    }
  }, interval);
}

/**
 * Entry: create a rate-limited throttled wrapper for an async function.
 * @param {Function} fn
 * @param {number} limit
 * @param {number} interval
 * @returns {Function}
 */
export function rateLimitSlidingWindow(fn, limit, interval) {
  validateThrottleParams(limit, interval);
  const queue = [];
  const activeCount = { value: 0 };

  return async function throttled(...args) {
    if (activeCount.value < limit) {
      activeCount.value++;
      scheduleQueueDrain(queue, interval, activeCount, limit);
    } else {
      const entry = createQueueEntry();
      queue.push(entry);
      await entry.promise;
    }
    return fn(...args);
  };
}

export default rateLimitSlidingWindow;
