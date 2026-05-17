// SPDX-License-Identifier: MIT
//
// bench/B10-import-replacement/tasks/rate-limit-sliding-window/arm-a/coarse.mjs
//
// @decision DEC-BENCH-B10-SLICE3-ARMA-FALLBACK-001
// @title Arm A-coarse produced via hand-translation fallback (not yakcc compile + #508 hook)
// @status accepted
// @rationale Same fallback as fine.mjs. GRANULARITY: A-coarse. Zero non-builtin imports.

export function rateLimitSlidingWindow(fn, limit, interval) {
  if (!Number.isFinite(limit) || limit < 1) throw new TypeError("limit must be a positive integer");
  const queue = [];
  let active = 0;
  return async function throttled(...args) {
    if (active < limit) {
      active++;
      setTimeout(() => { active--; if (queue.length > 0) { const {resolve} = queue.shift(); active++; resolve(); } }, interval);
    } else {
      await new Promise((resolve, reject) => queue.push({ resolve, reject }));
    }
    return fn(...args);
  };
}

export default rateLimitSlidingWindow;
