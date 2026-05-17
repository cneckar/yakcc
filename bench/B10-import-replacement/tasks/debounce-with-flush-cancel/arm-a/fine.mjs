// SPDX-License-Identifier: MIT
//
// bench/B10-import-replacement/tasks/debounce-with-flush-cancel/arm-a/fine.mjs
//
// @decision DEC-BENCH-B10-SLICE3-ARMA-FALLBACK-001
// @title Arm A-fine produced via hand-translation fallback (not yakcc compile + #508 hook)
// @status accepted
// @rationale
//   Hand-translation of lodash debounce subgraph from WI-510 S7.
//   GRANULARITY: A-fine -- 6 named functions. Zero non-builtin imports.
//
//   Cross-references:
//   DEC-BENCH-B10-SLICE3-TASK-CORPUS-SELECTION-001 -- corpus-spec.json
//   plans/wi-512-s3-b10-broaden.md §4

/** Atom: get current timestamp in ms. */
export function now() { return Date.now(); }

/** Atom: invoke the debounced function and update state. */
export function invokeFunc(fn, args, thisArg) {
  return fn.apply(thisArg, args);
}

/** Atom: check if the trailing edge should invoke now. */
export function shouldInvoke(lastCallTime, wait) {
  if (lastCallTime === null) return false;
  return (now() - lastCallTime) >= wait;
}

/** Atom: cancel the pending timer. */
export function cancelTimer(timerRef) {
  if (timerRef.id !== null) { clearTimeout(timerRef.id); timerRef.id = null; }
}

/** Atom: start or restart the debounce timer. */
export function startTimer(timerRef, fn, wait) {
  cancelTimer(timerRef);
  timerRef.id = setTimeout(fn, wait);
}

/**
 * Entry: create a debounced function with .flush() and .cancel().
 * @param {Function} fn
 * @param {number} wait
 * @returns {Function & { flush: Function, cancel: Function }}
 */
export function debounceWithFlushCancel(fn, wait) {
  let lastArgs = null;
  let lastThis = null;
  let lastCallTime = null;
  let lastResult = undefined;
  const timerRef = { id: null };

  function trailingEdge() {
    timerRef.id = null;
    if (lastArgs !== null) {
      lastResult = invokeFunc(fn, lastArgs, lastThis);
      lastArgs = null;
      lastThis = null;
    }
    return lastResult;
  }

  function debounced(...args) {
    lastArgs = args;
    lastThis = this;
    lastCallTime = now();
    startTimer(timerRef, trailingEdge, wait);
    return lastResult;
  }

  debounced.cancel = function() {
    cancelTimer(timerRef);
    lastArgs = null;
    lastThis = null;
    lastCallTime = null;
  };

  debounced.flush = function() {
    cancelTimer(timerRef);
    return trailingEdge();
  };

  return debounced;
}

export default debounceWithFlushCancel;
