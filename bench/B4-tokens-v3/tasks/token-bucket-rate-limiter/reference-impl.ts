// SPDX-License-Identifier: MIT
// Reference implementation for B4-v3 oracle validation.

export class RateLimitError extends Error {
  readonly available: number;
  readonly requested: number;

  constructor(available: number, requested: number) {
    super(`Rate limit: ${available} tokens available, ${requested} requested`);
    this.name = 'RateLimitError';
    this.available = available;
    this.requested = requested;
  }
}

export class TokenBucketRateLimiter {
  private readonly capacity: number;
  private readonly refillRate: number;
  private tokens: number;
  private lastRefill: number;

  constructor(capacity: number, refillRatePerSecond: number) {
    if (!isFinite(capacity) || capacity <= 0) {
      throw new TypeError('capacity must be a positive finite number');
    }
    if (!isFinite(refillRatePerSecond) || refillRatePerSecond <= 0) {
      throw new TypeError('refillRatePerSecond must be a positive finite number');
    }
    this.capacity = capacity;
    this.refillRate = refillRatePerSecond;
    this.tokens = capacity;
    this.lastRefill = Date.now();
  }

  private refillNow(): void {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillRate);
    this.lastRefill = now;
  }

  tryConsume(tokens = 1): boolean {
    if (tokens < 0) throw new TypeError('tokens must not be negative');
    if (tokens === 0) return true;
    this.refillNow();
    if (this.tokens >= tokens) {
      this.tokens -= tokens;
      return true;
    }
    return false;
  }

  consume(tokens = 1): void {
    if (tokens < 0) throw new TypeError('tokens must not be negative');
    if (tokens === 0) return;
    this.refillNow();
    if (this.tokens < tokens) {
      throw new RateLimitError(this.tokens, tokens);
    }
    this.tokens -= tokens;
  }

  availableTokens(): number {
    this.refillNow();
    return this.tokens;
  }

  reset(): void {
    this.tokens = this.capacity;
    this.lastRefill = Date.now();
  }
}
