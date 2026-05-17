// SPDX-License-Identifier: MIT
//
// bench/B10-import-replacement/tasks/debounce-with-flush-cancel/arm-a/coarse.mjs
//
// @decision DEC-BENCH-B10-SLICE3-ARMA-FALLBACK-001
// @title Arm A-coarse produced via hand-translation fallback (not yakcc compile + #508 hook)
// @status accepted
// @rationale Same fallback as fine.mjs. GRANULARITY: A-coarse. Zero non-builtin imports.

export function debounceWithFlushCancel(fn, wait) {
  let id = null; let lastArgs = null; let lastThis = null; let lastResult;
  function invoke() {
    id = null;
    if (lastArgs !== null) { lastResult = fn.apply(lastThis, lastArgs); lastArgs = null; lastThis = null; }
    return lastResult;
  }
  function debounced(...args) {
    lastArgs = args; lastThis = this;
    if (id !== null) clearTimeout(id);
    id = setTimeout(invoke, wait);
    return lastResult;
  }
  debounced.cancel = () => { if (id !== null) { clearTimeout(id); id = null; } lastArgs = null; lastThis = null; };
  debounced.flush = () => { if (id !== null) { clearTimeout(id); id = null; } return invoke(); };
  return debounced;
}

export default debounceWithFlushCancel;
