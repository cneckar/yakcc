# Task: LRU Cache with TTL Eviction

Implement a TypeScript class `LRUCacheWithTTL<K, V>` with these exact semantics:

```typescript
class LRUCacheWithTTL<K, V> {
  constructor(capacity: number, defaultTtlMs: number);
  set(key: K, value: V, ttlMs?: number): void;
  get(key: K): V | undefined;
  delete(key: K): boolean;
  has(key: K): boolean;
  size(): number;
  clear(): void;
}
```

## Requirements

1. **LRU eviction**: When capacity is exceeded, evict the least-recently-used entry. An entry is "used" on both `get` and `set`.
2. **TTL eviction**: Each entry has a per-entry TTL in milliseconds (overrides the constructor default). An expired entry MUST be treated as absent: `get` returns `undefined`, `has` returns `false`, and the entry does not count toward `size()`. Expired entries are lazily evicted (you are not required to use `setInterval` or active timers).
3. **`set` with existing key**: Updates the value AND resets the TTL to the new ttlMs (or defaultTtlMs if not provided). Moves the entry to most-recently-used position.
4. **`delete`**: Returns `true` if the key existed (and was not yet expired), `false` otherwise.
5. **`size()`**: Returns the number of non-expired entries currently in the cache (expired-but-not-yet-evicted entries do NOT count).
6. **`clear()`**: Removes all entries.
7. **Capacity is always a positive integer >= 1.** You do not need to validate it.
8. **TTL of 0 means the entry expires immediately** (every subsequent access returns `undefined`).

## Export

Export the class as a default export:

```typescript
export default LRUCacheWithTTL;
```

## Notes

- Do not use external libraries. Use only the TypeScript standard library and `Date.now()` for time.
- The implementation must be a single `.ts` file.
- Complexity target: O(1) for `get`, `set`, `has`, `delete`.
