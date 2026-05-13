// SPDX-License-Identifier: MIT
//
// @decision DEC-SEED-TIMER-001
// @title timer-handle atom: setTimeout/clearTimeout closure pattern; closes #454
// @status accepted
// @rationale
//   The debounce-with-cancel task (B4 benchmark) requires a timer-management
//   primitive as a registry atom. The timer-handle block encapsulates the
//   setTimeout/clearTimeout pattern as a reusable atom with a cancel handle.
//
//   Design decisions:
//   (A) CLOSURE OVER TIMER ID: The timer ID returned by setTimeout is captured
//       in a closure and cleared on cancel(). This is the idiomatic JS pattern.
//       Using ReturnType<typeof setTimeout> (= NodeJS.Timeout | number) avoids
//       platform-specific typing. A null sentinel signals "already fired or
//       cancelled" so cancel() is safely idempotent.
//
//   (B) PURITY: This atom is deliberately "impure" — it schedules real side
//       effects (timer scheduling). This is correct. The strict-subset validator
//       does not forbid impure atoms; it only forbids top-level side effects.
//       The setTimeout call is inside the exported function body, not at module
//       scope, which satisfies the no-top-level-side-effects rule.
//
//   (C) L0 LEVEL: Despite being impure, L0 is appropriate — this is a thin
//       wrapper over a well-understood browser/Node built-in. The risk is
//       lower than an algorithm that could be wrong. L1+ would require property
//       tests beyond the current fast-check corpus.
//
//   (D) SEED CORPUS METHODOLOGY: Per DEC-BENCH-METHODOLOGY-NEVER-SYNTHETIC-001,
//       this atom represents a real implementation pattern used in production
//       debounce/throttle implementations. It is not hallucinated or generated
//       by an LLM for the purpose of this benchmark.
//
// Cross-reference:
//   bench/B4-tokens/TASKS_RATIONALE.md DEC-BENCH-B4-NON-ENGAGEMENT-001 (debounce non-engagement)
//   bench/B4-tokens/harness/mcp-server.mjs DEC-V0-B4-MCP-001 (MCP server decision)
//   GitHub issue #454 (timer-atom-seed -- closed by this block)

/** Return type of timerHandle -- a cancellable timer reference. */
export interface TimerHandleResult {
  readonly cancel: () => void;
}

/**
 * Schedule a one-shot timer that invokes callback after delayMs milliseconds.
 * Returns a handle with cancel() to prevent invocation.
 *
 * @param callback - Called once when the timer fires.
 * @param delayMs  - Delay in milliseconds (0 = next event loop tick).
 */
export function timerHandle(callback: () => void, delayMs: number): TimerHandleResult {
  // Capture timer id in closure. null means "fired or cancelled".
  let id: ReturnType<typeof setTimeout> | null = setTimeout(() => {
    id = null;
    callback();
  }, delayMs);

  return {
    cancel(): void {
      if (id !== null) {
        clearTimeout(id);
        id = null;
      }
    },
  };
}
