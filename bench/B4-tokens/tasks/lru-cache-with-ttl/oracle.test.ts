// SPDX-License-Identifier: MIT
//
// bench/B4-tokens/tasks/lru-cache-with-ttl/oracle.test.ts
//
// @decision DEC-BENCH-B4-HARNESS-001
// @title B4 harness oracle: LRU cache with TTL eviction
// @status accepted
// @rationale
//   Oracle tests for semantic-equivalence verification. Must pass against reference-impl.ts
//   before Slice 2 measures LLM-generated implementations. Tests are exhaustive enough
//   that a broken implementation cannot pass by accident. Uses vi.useFakeTimers() so
//   TTL tests are deterministic without real waits.
//
// Usage:
//   vitest run --config bench/B4-tokens/vitest.config.mjs bench/B4-tokens/tasks/lru-cache-with-ttl/oracle.test.ts
//
// The IMPL_PATH env var points to the file under test. Defaults to reference-impl.ts
// for local development.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

const implPath = process.env["IMPL_PATH"]
  ? resolve(process.env["IMPL_PATH"])
  : resolve(__dirname, "reference-impl.ts");

// Dynamic import using file:// URL for Windows compatibility
const implUrl = pathToFileURL(implPath).href;

// We load the implementation module once at the top level via a dynamic import.
// vitest handles TypeScript transpilation for .ts files automatically.
// For .js files written by the LLM, we use the URL directly.
let LRUCacheWithTTL: new (capacity: number, defaultTtlMs: number) => {
  set(key: unknown, value: unknown, ttlMs?: number): void;
  get(key: unknown): unknown;
  has(key: unknown): boolean;
  delete(key: unknown): boolean;
  size(): number;
  clear(): void;
};

beforeEach(async () => {
  // Re-import for each describe block to pick up fresh module
  const mod = await import(/* @vite-ignore */ implUrl);
  LRUCacheWithTTL = mod.default ?? mod.LRUCacheWithTTL;
  if (!LRUCacheWithTTL) {
    throw new Error(
      `Implementation at ${implPath} must export LRUCacheWithTTL as default or named export`
    );
  }
});

describe("LRUCacheWithTTL — basic get/set/has/delete/clear", () => {
  it("stores and retrieves a value", () => {
    const cache = new LRUCacheWithTTL(10, 60_000);
    cache.set("a", 1);
    expect(cache.get("a")).toBe(1);
  });

  it("returns undefined for missing key", () => {
    const cache = new LRUCacheWithTTL(10, 60_000);
    expect(cache.get("missing")).toBeUndefined();
  });

  it("has() returns true for existing key, false for missing", () => {
    const cache = new LRUCacheWithTTL(10, 60_000);
    cache.set("x", 42);
    expect(cache.has("x")).toBe(true);
    expect(cache.has("y")).toBe(false);
  });

  it("delete() returns true for existing key", () => {
    const cache = new LRUCacheWithTTL(10, 60_000);
    cache.set("k", "v");
    expect(cache.delete("k")).toBe(true);
    expect(cache.has("k")).toBe(false);
    expect(cache.get("k")).toBeUndefined();
  });

  it("delete() returns false for missing key", () => {
    const cache = new LRUCacheWithTTL(10, 60_000);
    expect(cache.delete("nonexistent")).toBe(false);
  });

  it("clear() removes all entries", () => {
    const cache = new LRUCacheWithTTL(10, 60_000);
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("c", 3);
    cache.clear();
    expect(cache.size()).toBe(0);
    expect(cache.get("a")).toBeUndefined();
    expect(cache.has("b")).toBe(false);
  });

  it("size() counts live entries", () => {
    const cache = new LRUCacheWithTTL(10, 60_000);
    expect(cache.size()).toBe(0);
    cache.set("a", 1);
    expect(cache.size()).toBe(1);
    cache.set("b", 2);
    expect(cache.size()).toBe(2);
    cache.delete("a");
    expect(cache.size()).toBe(1);
  });

  it("set() on existing key updates value and moves to MRU", () => {
    const cache = new LRUCacheWithTTL(2, 60_000);
    cache.set("a", 1);
    cache.set("b", 2);
    // Now update "a" — it should move to MRU, so "b" becomes LRU
    cache.set("a", 99);
    // Adding "c" should evict "b" (LRU), not "a"
    cache.set("c", 3);
    expect(cache.get("a")).toBe(99);
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("c")).toBe(3);
  });

  it("supports non-string keys (numbers, objects)", () => {
    const cache = new LRUCacheWithTTL(10, 60_000);
    const key = { id: 1 };
    cache.set(key, "obj-value");
    expect(cache.get(key)).toBe("obj-value");
    cache.set(42, "num-value");
    expect(cache.get(42)).toBe("num-value");
  });
});

describe("LRUCacheWithTTL — LRU eviction order", () => {
  it("evicts least-recently-used when capacity exceeded", () => {
    const cache = new LRUCacheWithTTL(3, 60_000);
    cache.set("a", 1); // LRU: a
    cache.set("b", 2); // LRU: a, then b
    cache.set("c", 3); // LRU: a, b, c (c=MRU)
    cache.set("d", 4); // should evict "a" (LRU)
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBe(2);
    expect(cache.get("c")).toBe(3);
    expect(cache.get("d")).toBe(4);
  });

  it("get() promotes entry to MRU", () => {
    const cache = new LRUCacheWithTTL(2, 60_000);
    cache.set("a", 1);
    cache.set("b", 2);
    // Access "a" to make it MRU; "b" becomes LRU
    cache.get("a");
    cache.set("c", 3); // should evict "b"
    expect(cache.get("a")).toBe(1);
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("c")).toBe(3);
  });

  it("eviction order is correct over multiple insertions", () => {
    const cache = new LRUCacheWithTTL(3, 60_000);
    cache.set(1, "one");
    cache.set(2, "two");
    cache.set(3, "three");
    cache.get(1); // 1 is now MRU; order: 2(LRU), 3, 1(MRU)
    cache.set(4, "four"); // evicts 2
    expect(cache.get(2)).toBeUndefined();
    cache.set(5, "five"); // evicts 3
    expect(cache.get(3)).toBeUndefined();
    expect(cache.get(1)).toBe("one");
    expect(cache.get(4)).toBe("four");
    expect(cache.get(5)).toBe("five");
  });

  it("capacity=1 evicts on every new key", () => {
    const cache = new LRUCacheWithTTL(1, 60_000);
    cache.set("a", 1);
    cache.set("b", 2);
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBe(2);
    cache.set("c", 3);
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("c")).toBe(3);
  });
});

describe("LRUCacheWithTTL — TTL eviction (fake timers)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("entry expires after TTL elapses", () => {
    const cache = new LRUCacheWithTTL(10, 1000);
    cache.set("a", "alive");
    expect(cache.get("a")).toBe("alive");
    vi.advanceTimersByTime(999);
    expect(cache.get("a")).toBe("alive");
    vi.advanceTimersByTime(1); // exactly at expiry
    expect(cache.get("a")).toBeUndefined();
  });

  it("has() returns false for expired entry", () => {
    const cache = new LRUCacheWithTTL(10, 500);
    cache.set("k", "v");
    vi.advanceTimersByTime(501);
    expect(cache.has("k")).toBe(false);
  });

  it("delete() returns false for expired entry", () => {
    const cache = new LRUCacheWithTTL(10, 500);
    cache.set("k", "v");
    vi.advanceTimersByTime(501);
    expect(cache.delete("k")).toBe(false);
  });

  it("size() excludes expired entries", () => {
    const cache = new LRUCacheWithTTL(10, 1000);
    cache.set("a", 1);
    cache.set("b", 2, 200); // short TTL
    expect(cache.size()).toBe(2);
    vi.advanceTimersByTime(201);
    expect(cache.size()).toBe(1); // "b" expired
    vi.advanceTimersByTime(800);
    expect(cache.size()).toBe(0); // "a" expired
  });

  it("per-entry TTL overrides default TTL", () => {
    const cache = new LRUCacheWithTTL(10, 10_000);
    cache.set("short", "value", 100);
    cache.set("long", "value", 5000);
    vi.advanceTimersByTime(200);
    expect(cache.get("short")).toBeUndefined();
    expect(cache.get("long")).toBe("value");
  });

  it("TTL=0 means entry is immediately expired", () => {
    const cache = new LRUCacheWithTTL(10, 60_000);
    cache.set("instant", "gone", 0);
    // Even without advancing time, TTL=0 means expiresAt <= Date.now()
    expect(cache.get("instant")).toBeUndefined();
    expect(cache.has("instant")).toBe(false);
  });

  it("set() on existing key resets TTL", () => {
    const cache = new LRUCacheWithTTL(10, 60_000);
    cache.set("k", "v1", 1000);
    vi.advanceTimersByTime(800);
    // Reset TTL with new set
    cache.set("k", "v2", 1000);
    vi.advanceTimersByTime(800); // 800ms into new TTL — should still be alive
    expect(cache.get("k")).toBe("v2");
    vi.advanceTimersByTime(201); // now past new TTL
    expect(cache.get("k")).toBeUndefined();
  });

  it("TTL precedence over LRU: expired entry not evicted as LRU before capacity filled", () => {
    const cache = new LRUCacheWithTTL(3, 60_000);
    cache.set("a", 1, 500); // will expire
    cache.set("b", 2);
    cache.set("c", 3);
    vi.advanceTimersByTime(501); // "a" expires
    // "a" is expired but may still occupy a slot in the map
    // Adding "d": capacity=3, map.size=3, so LRU (which is "a") gets evicted
    cache.set("d", 4);
    expect(cache.get("a")).toBeUndefined(); // expired
    expect(cache.get("b")).toBe(2);
    expect(cache.get("c")).toBe(3);
    expect(cache.get("d")).toBe(4);
  });
});

describe("LRUCacheWithTTL — edge cases", () => {
  it("works with capacity=1 and TTL interactions", () => {
    vi.useFakeTimers();
    const cache = new LRUCacheWithTTL(1, 1000);
    cache.set("a", 1);
    vi.advanceTimersByTime(1001);
    // "a" is expired; adding "b" should work without eviction issues
    cache.set("b", 2);
    expect(cache.get("b")).toBe(2);
    vi.useRealTimers();
  });

  it("set() with undefined value is stored and returned", () => {
    const cache = new LRUCacheWithTTL(10, 60_000);
    cache.set("undef", undefined);
    // undefined value: has() should return true, get() returns undefined
    // Note: some implementations may not handle this — reference does
    expect(cache.has("undef")).toBe(true);
    expect(cache.get("undef")).toBeUndefined();
  });

  it("multiple clears do not corrupt state", () => {
    const cache = new LRUCacheWithTTL(10, 60_000);
    cache.set("a", 1);
    cache.clear();
    cache.clear(); // second clear should be safe
    cache.set("b", 2);
    expect(cache.size()).toBe(1);
    expect(cache.get("b")).toBe(2);
  });

  it("large number of insertions respects capacity", () => {
    const cache = new LRUCacheWithTTL(5, 60_000);
    for (let i = 0; i < 100; i++) {
      cache.set(i, i * 10);
    }
    // Only last 5 should remain (95–99)
    expect(cache.size()).toBe(5);
    for (let i = 95; i < 100; i++) {
      expect(cache.get(i)).toBe(i * 10);
    }
    for (let i = 0; i < 95; i++) {
      expect(cache.get(i)).toBeUndefined();
    }
  });
});
