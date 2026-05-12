// SPDX-License-Identifier: MIT
//
// bench/B4-tokens/tasks/debounce-with-cancel/reference-impl.ts
//
// @decision DEC-BENCH-B4-CORPUS-001
// @title B4 task corpus: debounce-with-cancel reference implementation
// @status accepted
// @rationale
//   Reference implementation for oracle validation (Slice 1). Exists to prove the
//   oracle tests correctly distinguish correct from broken implementations. It is NOT
//   the thing being measured — it is the ground truth that validates the oracle before
//   Slice 2 measures real LLM output. A passing reference + failing broken-impl proves
//   oracle gates are not vacuous. See TASKS_RATIONALE.md for full corpus selection rationale.

export interface DebouncedFunction<T extends (...args: unknown[]) => void> {
  (...args: Parameters<T>): void;
  cancel(): void;
  flush(): void;
  pending(): boolean;
}

/**
 * Wrap a function so invocations are debounced by `waitMs` milliseconds.
 *
 * - Each call resets the timer to `waitMs` from now.
 * - `cancel()` clears the pending timer without invoking `fn`.
 * - `flush()` immediately invokes `fn` with the latest args if pending, then clears.
 * - `pending()` returns true iff a timer is currently outstanding.
 * - `waitMs = 0` still defers via setTimeout (not synchronous).
 */
export function debounce<T extends (...args: unknown[]) => void>(
  fn: T,
  waitMs: number,
): DebouncedFunction<T> {
  let timer: ReturnType<typeof setTimeout> | undefined = undefined;
  let lastArgs: Parameters<T> | undefined = undefined;

  function debounced(...args: Parameters<T>): void {
    lastArgs = args;
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => {
      timer = undefined;
      const args = lastArgs!;
      lastArgs = undefined;
      fn(...args);
    }, waitMs);
  }

  debounced.cancel = function cancel(): void {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    lastArgs = undefined;
  };

  debounced.flush = function flush(): void {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
      const args = lastArgs!;
      lastArgs = undefined;
      fn(...args);
    }
  };

  debounced.pending = function pending(): boolean {
    return timer !== undefined;
  };

  return debounced as DebouncedFunction<T>;
}
