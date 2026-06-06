Implement an LRU (Least-Recently-Used) cache with per-entry TTL (time-to-live).

Export a **single class**:

```typescript
export class LRUTTLCache<K, V> {
  /**
   * @param capacity Maximum number of live (non-expired) entries.
   *   Must be a positive integer; throws RangeError otherwise.
   * @param defaultTtlMs Default TTL in milliseconds for entries set without
   *   an explicit TTL. 0 (default) means entries never expire by default.
   */
  constructor(capacity: number, defaultTtlMs?: number);

  /**
   * Retrieve a value. Returns undefined if the key is absent or expired.
   * Accessing an unexpired entry promotes it to "most recently used".
   * An expired entry is removed from the cache on access (lazy eviction).
   */
  get(key: K): V | undefined;

  /**
   * Insert or update a key-value pair.
   * @param ttlMs TTL for this entry in milliseconds.
   *   0 = use the constructor's defaultTtlMs; pass Infinity for a never-expire entry.
   *   When defaultTtlMs is also 0, the entry never expires.
   * If the cache is at capacity after adding the new entry (and all expired entries
   * have been evicted), evict the least-recently-used live entry.
   */
  set(key: K, value: V, ttlMs?: number): void;

  /** Remove a key. Returns true if the key existed (even if expired), false otherwise. */
  delete(key: K): boolean;

  /** Returns true if the key exists and is not expired. */
  has(key: K): boolean;

  /** Number of live (non-expired) entries. */
  get size(): number;

  /** Remove all entries. */
  clear(): void;

  /**
   * Return live entries in LRU order (oldest-accessed first).
   * Expired entries are not included.
   */
  entries(): [K, V][];
}
```

Time source: use `Date.now()` for timestamps. The test suite will provide a controllable
time mock via `vi.setSystemTime()` (Vitest's fake timers), so do NOT cache `Date.now` at
construction time — call it fresh on every `get`/`set`.

Constraints:
- No external libraries.
- O(1) average `get` and `set`.
- Capacity enforcement must consider capacity of live entries only: if the cache has
  live entries A, B, C (capacity=3) and you `set` D, evict the LRU of {A, B, C}.
- Expired entries do NOT count toward capacity: if A has expired and B, C are live
  (capacity=3), `set` D does NOT trigger LRU eviction — there are only 2 live entries.
