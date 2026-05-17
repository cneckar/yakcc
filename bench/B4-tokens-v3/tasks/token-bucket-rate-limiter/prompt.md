Implement a token bucket rate limiter.

Export these:

```typescript
export class RateLimitError extends Error {
  readonly available: number;  // tokens available when error was thrown
  readonly requested: number;  // tokens that were requested
  constructor(available: number, requested: number)
}

export class TokenBucketRateLimiter {
  constructor(capacity: number, refillRatePerSecond: number)
  tryConsume(tokens?: number): boolean  // default 1; returns false if not enough
  consume(tokens?: number): void        // default 1; throws RateLimitError if not enough
  availableTokens(): number             // current token count (may be fractional between calls)
  reset(): void                         // refill to capacity, reset refill timer
}
```

**Algorithm:**
- On construction: bucket starts full at `capacity` tokens
- On each call to `tryConsume`/`consume`/`availableTokens`: compute elapsed time since last refill timestamp, add `elapsed * refillRatePerSecond` tokens, cap at `capacity`
- Use `Date.now()` for timing (milliseconds)
- `tryConsume(n)`: if `availableTokens >= n`, subtract n and return `true`; else return `false`
- `consume(n)`: if `availableTokens >= n`, subtract n; else throw `RateLimitError(available, n)`
- `reset()`: set tokens to `capacity`, reset last-refill timestamp to `Date.now()`
- `tryConsume(0)` and `consume(0)` always succeed
- `tryConsume(n < 0)` and `consume(n < 0)` throw `TypeError`
- Constructor throws `TypeError` if `capacity <= 0` or `refillRatePerSecond <= 0`
