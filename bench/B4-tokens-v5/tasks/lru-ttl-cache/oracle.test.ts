// SPDX-License-Identifier: MIT
//
// bench/B4-tokens-v4/tasks/lru-ttl-cache/oracle.test.ts
//
// Oracle tests for the lru-ttl-cache task (B4-v4).
// Uses Vitest fake timers for deterministic TTL testing.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const implPath = process.env['IMPL_PATH']
  ? resolve(process.env['IMPL_PATH'])
  : resolve(__dirname, 'reference-impl.ts');
const implUrl = pathToFileURL(implPath).href;

type Cache<K, V> = {
  get(k: K): V | undefined;
  set(k: K, v: V, ttlMs?: number): void;
  delete(k: K): boolean;
  has(k: K): boolean;
  size: number;
  clear(): void;
  entries(): [K, V][];
};
let LRUTTLCache: new <K, V>(cap: number, defaultTtlMs?: number) => Cache<K, V>;

beforeEach(async () => {
  const mod = await import(/* @vite-ignore */ implUrl);
  LRUTTLCache = mod.LRUTTLCache;
  if (typeof LRUTTLCache !== 'function') {
    throw new Error(`Implementation must export LRUTTLCache as a named class`);
  }
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('lru-ttl-cache — constructor', () => {
  it('throws RangeError for capacity 0', () => {
    expect(() => new LRUTTLCache(0)).toThrow(RangeError);
  });
  it('throws RangeError for negative capacity', () => {
    expect(() => new LRUTTLCache(-1)).toThrow(RangeError);
  });
  it('throws RangeError for non-integer capacity', () => {
    expect(() => new LRUTTLCache(1.5)).toThrow(RangeError);
  });
  it('accepts capacity 1', () => {
    expect(() => new LRUTTLCache(1)).not.toThrow();
  });
});

describe('lru-ttl-cache — basic get/set', () => {
  it('returns undefined for missing key', () => {
    const c = new LRUTTLCache<string, number>(3);
    expect(c.get('x')).toBeUndefined();
  });

  it('stores and retrieves a value', () => {
    const c = new LRUTTLCache<string, number>(3);
    c.set('a', 1);
    expect(c.get('a')).toBe(1);
  });

  it('overwrite updates value', () => {
    const c = new LRUTTLCache<string, number>(3);
    c.set('a', 1);
    c.set('a', 99);
    expect(c.get('a')).toBe(99);
  });
});

describe('lru-ttl-cache — LRU eviction', () => {
  it('evicts the least-recently-used entry when at capacity', () => {
    const c = new LRUTTLCache<string, number>(3);
    c.set('a', 1);
    c.set('b', 2);
    c.set('c', 3);
    c.set('d', 4); // 'a' is LRU — must be evicted
    expect(c.get('a')).toBeUndefined();
    expect(c.get('b')).toBe(2);
    expect(c.get('c')).toBe(3);
    expect(c.get('d')).toBe(4);
  });

  it('get() promotes to MRU, protecting from eviction', () => {
    const c = new LRUTTLCache<string, number>(3);
    c.set('a', 1);
    c.set('b', 2);
    c.set('c', 3);
    c.get('a'); // promote 'a' → now 'b' is LRU
    c.set('d', 4);
    expect(c.get('a')).toBe(1);
    expect(c.get('b')).toBeUndefined(); // evicted
    expect(c.get('c')).toBe(3);
    expect(c.get('d')).toBe(4);
  });

  it('set() on existing key promotes to MRU', () => {
    const c = new LRUTTLCache<string, number>(3);
    c.set('a', 1);
    c.set('b', 2);
    c.set('c', 3);
    c.set('a', 10); // re-set 'a' → now 'b' is LRU
    c.set('d', 4);
    expect(c.get('a')).toBe(10);
    expect(c.get('b')).toBeUndefined(); // evicted
  });
});

describe('lru-ttl-cache — TTL eviction', () => {
  it('entry expires after TTL', () => {
    const c = new LRUTTLCache<string, number>(10);
    c.set('a', 1, 100);
    vi.advanceTimersByTime(99);
    expect(c.get('a')).toBe(1);
    vi.advanceTimersByTime(1);
    expect(c.get('a')).toBeUndefined();
  });

  it('expired entry is not counted in size', () => {
    const c = new LRUTTLCache<string, number>(10);
    c.set('a', 1, 100);
    c.set('b', 2);
    vi.advanceTimersByTime(100);
    expect(c.size).toBe(1); // 'a' expired, 'b' lives
  });

  it('expired entries do NOT count toward capacity', () => {
    const c = new LRUTTLCache<string, number>(2);
    c.set('a', 1, 100);
    c.set('b', 2, 100);
    vi.advanceTimersByTime(100); // both expired
    c.set('c', 3);
    c.set('d', 4);
    // c and d should both be present — no LRU eviction needed
    expect(c.get('c')).toBe(3);
    expect(c.get('d')).toBe(4);
  });

  it('defaultTtlMs applies when set() is called without explicit TTL', () => {
    const c = new LRUTTLCache<string, number>(10, 200);
    c.set('a', 1);
    vi.advanceTimersByTime(199);
    expect(c.get('a')).toBe(1);
    vi.advanceTimersByTime(1);
    expect(c.get('a')).toBeUndefined();
  });

  it('explicit ttlMs=0 defers to defaultTtlMs', () => {
    const c = new LRUTTLCache<string, number>(10, 100);
    c.set('a', 1, 0); // ttlMs=0 → use defaultTtlMs=100
    vi.advanceTimersByTime(100);
    expect(c.get('a')).toBeUndefined();
  });

  it('Infinity ttlMs means entry never expires', () => {
    const c = new LRUTTLCache<string, number>(10, 100);
    c.set('a', 1, Infinity);
    vi.advanceTimersByTime(1_000_000);
    expect(c.get('a')).toBe(1);
  });
});

describe('lru-ttl-cache — has()', () => {
  it('returns false for absent key', () => {
    expect(new LRUTTLCache<string, number>(3).has('x')).toBe(false);
  });
  it('returns true for present, non-expired key', () => {
    const c = new LRUTTLCache<string, number>(3);
    c.set('a', 1);
    expect(c.has('a')).toBe(true);
  });
  it('returns false for expired key', () => {
    const c = new LRUTTLCache<string, number>(3);
    c.set('a', 1, 50);
    vi.advanceTimersByTime(50);
    expect(c.has('a')).toBe(false);
  });
});

describe('lru-ttl-cache — delete()', () => {
  it('returns true and removes existing key', () => {
    const c = new LRUTTLCache<string, number>(3);
    c.set('a', 1);
    expect(c.delete('a')).toBe(true);
    expect(c.get('a')).toBeUndefined();
  });
  it('returns false for absent key', () => {
    expect(new LRUTTLCache<string, number>(3).delete('z')).toBe(false);
  });
});

describe('lru-ttl-cache — entries()', () => {
  it('returns entries in LRU order (oldest accessed first)', () => {
    const c = new LRUTTLCache<string, number>(3);
    c.set('a', 1);
    c.set('b', 2);
    c.set('c', 3);
    // LRU order: a (oldest), b, c (MRU)
    const keys = c.entries().map(([k]) => k);
    expect(keys).toEqual(['a', 'b', 'c']);
  });

  it('entries() excludes expired', () => {
    const c = new LRUTTLCache<string, number>(3);
    c.set('a', 1, 100);
    c.set('b', 2);
    vi.advanceTimersByTime(100);
    const entries = c.entries();
    expect(entries.map(([k]) => k)).not.toContain('a');
    expect(entries.map(([k]) => k)).toContain('b');
  });
});

describe('lru-ttl-cache — clear()', () => {
  it('removes all entries', () => {
    const c = new LRUTTLCache<string, number>(3);
    c.set('a', 1);
    c.set('b', 2);
    c.clear();
    expect(c.size).toBe(0);
    expect(c.get('a')).toBeUndefined();
  });
});
