// SPDX-License-Identifier: MIT
//
// bench/B4-tokens-v3/tasks/token-bucket-rate-limiter/oracle.test.ts
//
// Oracle tests for the token-bucket-rate-limiter task (B4-v3).
// Uses vi.useFakeTimers() for deterministic time-based tests.
// Tests are deterministic and hand-authored per DEC-BENCH-METHODOLOGY-NEVER-SYNTHETIC-001.
// Load implementation via IMPL_PATH env var (defaults to reference-impl.ts).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const implPath = process.env['IMPL_PATH']
  ? resolve(process.env['IMPL_PATH'])
  : resolve(__dirname, 'reference-impl.ts');
const implUrl = pathToFileURL(implPath).href;

let TokenBucketRateLimiter: new (capacity: number, rate: number) => {
  tryConsume(tokens?: number): boolean;
  consume(tokens?: number): void;
  availableTokens(): number;
  reset(): void;
};
let RateLimitError: new (available: number, requested: number) => Error & {
  available: number;
  requested: number;
};

beforeEach(async () => {
  const mod = await import(/* @vite-ignore */ implUrl);
  TokenBucketRateLimiter = mod.TokenBucketRateLimiter;
  RateLimitError = mod.RateLimitError;
  if (!TokenBucketRateLimiter || !RateLimitError) {
    throw new Error(`Implementation must export: TokenBucketRateLimiter, RateLimitError`);
  }
});

describe('TokenBucketRateLimiter — initial state', () => {
  it('starts full at capacity', () => {
    const limiter = new TokenBucketRateLimiter(10, 1);
    expect(limiter.availableTokens()).toBe(10);
  });

  it('tryConsume(0) always returns true on full bucket', () => {
    const limiter = new TokenBucketRateLimiter(5, 1);
    expect(limiter.tryConsume(0)).toBe(true);
  });

  it('consume(0) always succeeds on full bucket', () => {
    const limiter = new TokenBucketRateLimiter(5, 1);
    expect(() => limiter.consume(0)).not.toThrow();
  });
});

describe('TokenBucketRateLimiter — consuming tokens', () => {
  it('tryConsume reduces available tokens', () => {
    const limiter = new TokenBucketRateLimiter(10, 0.001); // very slow refill
    limiter.tryConsume(3);
    expect(limiter.availableTokens()).toBeCloseTo(7, 0);
  });

  it('tryConsume returns false when not enough tokens', () => {
    const limiter = new TokenBucketRateLimiter(5, 0.001);
    limiter.tryConsume(5); // drain
    expect(limiter.tryConsume(1)).toBe(false);
  });

  it('consume throws RateLimitError when not enough tokens', () => {
    const limiter = new TokenBucketRateLimiter(5, 0.001);
    limiter.tryConsume(5); // drain
    expect(() => limiter.consume(1)).toThrow();
  });

  it('RateLimitError.available and .requested are populated', () => {
    const limiter = new TokenBucketRateLimiter(5, 0.001);
    limiter.tryConsume(3); // 2 left
    try {
      limiter.consume(5); // request more than available
      expect.fail('should have thrown');
    } catch (e: any) {
      expect(typeof e.available).toBe('number');
      expect(e.requested).toBe(5);
    }
  });
});

describe('TokenBucketRateLimiter — zero-token edge cases', () => {
  it('tryConsume(0) returns true even on empty bucket', () => {
    const limiter = new TokenBucketRateLimiter(5, 0.001);
    limiter.tryConsume(5); // drain
    expect(limiter.tryConsume(0)).toBe(true);
  });

  it('consume(0) succeeds even on empty bucket', () => {
    const limiter = new TokenBucketRateLimiter(5, 0.001);
    limiter.tryConsume(5); // drain
    expect(() => limiter.consume(0)).not.toThrow();
  });
});

describe('TokenBucketRateLimiter — time-based refill', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('refills tokens after time passes', () => {
    const limiter = new TokenBucketRateLimiter(10, 2); // 2 tokens/sec
    limiter.tryConsume(10); // drain
    vi.advanceTimersByTime(3000); // 3 seconds → 6 new tokens
    expect(limiter.tryConsume(6)).toBe(true);
    expect(limiter.tryConsume(1)).toBe(false); // empty again
  });

  it('does not exceed capacity on overfill', () => {
    const limiter = new TokenBucketRateLimiter(10, 100); // very fast refill
    limiter.tryConsume(5);
    vi.advanceTimersByTime(10000); // way more tokens than capacity
    expect(limiter.availableTokens()).toBeCloseTo(10, 0); // capped at capacity
  });

  it('reset() fills to capacity immediately', () => {
    const limiter = new TokenBucketRateLimiter(10, 1);
    limiter.tryConsume(8); // 2 left
    limiter.reset();
    expect(limiter.availableTokens()).toBeCloseTo(10, 0);
  });
});

describe('TokenBucketRateLimiter — constructor validation', () => {
  it('throws TypeError for zero capacity', () => {
    expect(() => new TokenBucketRateLimiter(0, 1)).toThrow(TypeError);
  });

  it('throws TypeError for negative capacity', () => {
    expect(() => new TokenBucketRateLimiter(-5, 1)).toThrow(TypeError);
  });

  it('throws TypeError for zero refillRate', () => {
    expect(() => new TokenBucketRateLimiter(10, 0)).toThrow(TypeError);
  });

  it('throws TypeError for negative refillRate', () => {
    expect(() => new TokenBucketRateLimiter(10, -1)).toThrow(TypeError);
  });
});

describe('TokenBucketRateLimiter — negative token validation', () => {
  it('tryConsume(-1) throws TypeError', () => {
    const limiter = new TokenBucketRateLimiter(10, 1);
    expect(() => limiter.tryConsume(-1)).toThrow(TypeError);
  });

  it('consume(-1) throws TypeError', () => {
    const limiter = new TokenBucketRateLimiter(10, 1);
    expect(() => limiter.consume(-1)).toThrow(TypeError);
  });
});
