// SPDX-License-Identifier: MIT
//
// bench/B10-import-replacement/tasks/debounce-with-flush-cancel/arm-a/medium.mjs
//
// @decision DEC-BENCH-B10-SLICE3-ARMA-FALLBACK-001
// @title Arm A-medium produced via hand-translation fallback (not yakcc compile + #508 hook)
// @status accepted
// @rationale Same fallback as fine.mjs. GRANULARITY: A-medium. Zero non-builtin imports.

export function createDebounceState() {
  return { id: null, lastArgs: null, lastThis: null, lastResult: undefined };
}

export function debounceWithFlushCancel(fn, wait) {
  const state = createDebounceState();

  function invoke() {
    state.id = null;
    if (state.lastArgs !== null) {
      state.lastResult = fn.apply(state.lastThis, state.lastArgs);
      state.lastArgs = null; state.lastThis = null;
    }
    return state.lastResult;
  }

  function debounced(...args) {
    state.lastArgs = args; state.lastThis = this;
    if (state.id !== null) clearTimeout(state.id);
    state.id = setTimeout(invoke, wait);
    return state.lastResult;
  }

  debounced.cancel = () => {
    if (state.id !== null) { clearTimeout(state.id); state.id = null; }
    state.lastArgs = null; state.lastThis = null;
  };

  debounced.flush = () => {
    if (state.id !== null) { clearTimeout(state.id); state.id = null; }
    return invoke();
  };

  return debounced;
}

export default debounceWithFlushCancel;
