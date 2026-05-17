// SPDX-License-Identifier: MIT
//
// bench/B10-import-replacement/tasks/rate-limit-sliding-window/arm-a/medium.mjs
//
// @decision DEC-BENCH-B10-SLICE3-ARMA-FALLBACK-001
// @title Arm A-medium produced via hand-translation fallback (not yakcc compile + #508 hook)
// @status accepted
// @rationale Same fallback as fine.mjs. GRANULARITY: A-medium. Zero non-builtin imports.

export function createRateLimiter(limit, interval) {
  if (!Number.isFinite(limit) || limit < 1) throw new TypeError("limit must be a positive integer");
  if (!Number.isFinite(interval) || interval < 0) throw new TypeError("interval must be non-negative");
  const queue = [];
  const active = { value: 0 };
  function drain() {
    setTimeout(() => {
      active.value--;
      if (queue.length > 0) {
        const { resolve } = queue.shift();
        active.value++;
        resolve();
        drain();
      }
    }, interval);
  }
  return async function acquire() {
    if (active.value < limit) {
      active.value++;
      drain();
    } else {
      await new Promise((resolve, reject) => queue.push({ resolve, reject }));
    }
  };
}

export function rateLimitSlidingWindow(fn, limit, interval) {
  const acquire = createRateLimiter(limit, interval);
  return async function throttled(...args) {
    await acquire();
    return fn(...args);
  };
}

export default rateLimitSlidingWindow;
