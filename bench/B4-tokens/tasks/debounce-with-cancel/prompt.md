# Task: Debounce Wrapper with Cancellation

Implement a TypeScript function `debounce` that wraps a callback and delays its invocation:

```typescript
function debounce<T extends (...args: unknown[]) => void>(
  fn: T,
  waitMs: number,
): DebouncedFunction<T>;

interface DebouncedFunction<T extends (...args: unknown[]) => void> {
  (...args: Parameters<T>): void;
  cancel(): void;
  flush(): void;
  pending(): boolean;
}
```

## Requirements

1. **Basic debounce**: When the debounced function is called, it delays invoking `fn` by `waitMs` milliseconds. If called again before the delay expires, the previous pending invocation is cancelled and the timer restarts with the new arguments.
2. **`cancel()`**: Cancels any pending invocation. After calling `cancel()`, `pending()` returns `false` and the underlying `fn` is NOT called.
3. **`flush()`**: If a pending invocation exists, invoke it immediately (synchronously) with the most recent arguments, then clear the pending state. If no invocation is pending, `flush()` is a no-op.
4. **`pending()`**: Returns `true` if a pending invocation exists (timer is running), `false` otherwise.
5. **Argument forwarding**: The most recent call's arguments are always forwarded to `fn`.
6. **`waitMs = 0`**: The function is still debounced — it does not invoke synchronously; it schedules via the timer mechanism. (In tests using fake timers, `waitMs = 0` debouncing still requires `vi.runAllTimers()` to fire.)
7. **No `this` binding required.** Arrow functions are the expected use case. You do not need to handle `this` context.

## Export

Export as a named export:

```typescript
export { debounce };
export type { DebouncedFunction };
```

## Notes

- Use `setTimeout` / `clearTimeout` for timing.
- Do not use external libraries. Pure TypeScript.
- The implementation must be a single `.ts` file.
