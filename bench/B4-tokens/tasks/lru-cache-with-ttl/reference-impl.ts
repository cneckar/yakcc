// SPDX-License-Identifier: MIT
//
// bench/B4-tokens/tasks/lru-cache-with-ttl/reference-impl.ts
//
// Reference implementation for oracle validation (Slice 1).
// This file exists to prove the oracle tests correctly distinguish correct from broken
// implementations. It is NOT the thing being measured — it is the ground truth.
//
// @decision DEC-BENCH-B4-HARNESS-001
// See harness/run.mjs for the full decision annotation.
// Short rationale: reference impls are committed so the oracle can be validated before
// Slice 2 measures real LLM output. A passing reference + failing broken-impl proves
// the oracle gates are not vacuous.

interface Entry<V> {
  value: V;
  expiresAt: number;
  prev: Entry<V> | null;
  next: Entry<V> | null;
  key: unknown;
}

/**
 * LRU cache with per-entry TTL eviction.
 * O(1) get/set/has/delete via doubly-linked list + Map.
 */
class LRUCacheWithTTL<K, V> {
  private readonly capacity: number;
  private readonly defaultTtlMs: number;
  private readonly map: Map<K, Entry<V>>;
  // Doubly-linked list: head.next = MRU, tail.prev = LRU
  private readonly head: Entry<V>;
  private readonly tail: Entry<V>;

  constructor(capacity: number, defaultTtlMs: number) {
    this.capacity = capacity;
    this.defaultTtlMs = defaultTtlMs;
    this.map = new Map();
    // Sentinel nodes (never stored in map)
    this.head = { value: undefined as unknown as V, expiresAt: Infinity, prev: null, next: null, key: null };
    this.tail = { value: undefined as unknown as V, expiresAt: Infinity, prev: null, next: null, key: null };
    this.head.next = this.tail;
    this.tail.prev = this.head;
  }

  private isExpired(entry: Entry<V>): boolean {
    return Date.now() >= entry.expiresAt;
  }

  private detach(entry: Entry<V>): void {
    if (entry.prev) entry.prev.next = entry.next;
    if (entry.next) entry.next.prev = entry.prev;
    entry.prev = null;
    entry.next = null;
  }

  private insertMRU(entry: Entry<V>): void {
    // Insert right after head (MRU position)
    entry.next = this.head.next;
    entry.prev = this.head;
    if (this.head.next) this.head.next.prev = entry;
    this.head.next = entry;
  }

  private evictLRU(): void {
    // LRU is tail.prev (skip sentinel)
    const lru = this.tail.prev;
    if (lru === null || lru === this.head) return;
    this.detach(lru);
    this.map.delete(lru.key as K);
  }

  set(key: K, value: V, ttlMs?: number): void {
    const ttl = ttlMs !== undefined ? ttlMs : this.defaultTtlMs;
    const expiresAt = Date.now() + ttl;

    const existing = this.map.get(key);
    if (existing !== undefined) {
      // Update in place, move to MRU
      existing.value = value;
      existing.expiresAt = expiresAt;
      this.detach(existing);
      this.insertMRU(existing);
      return;
    }

    // New entry
    const entry: Entry<V> = { value, expiresAt, prev: null, next: null, key };
    this.map.set(key, entry);
    this.insertMRU(entry);

    // Evict LRU if over capacity (count only non-expired)
    // Simple approach: if map size > capacity, evict from LRU end (may be expired)
    if (this.map.size > this.capacity) {
      this.evictLRU();
    }
  }

  get(key: K): V | undefined {
    const entry = this.map.get(key);
    if (entry === undefined) return undefined;
    if (this.isExpired(entry)) {
      // Lazy eviction
      this.detach(entry);
      this.map.delete(key);
      return undefined;
    }
    // Move to MRU
    this.detach(entry);
    this.insertMRU(entry);
    return entry.value;
  }

  has(key: K): boolean {
    const entry = this.map.get(key);
    if (entry === undefined) return false;
    if (this.isExpired(entry)) {
      this.detach(entry);
      this.map.delete(key);
      return false;
    }
    return true;
  }

  delete(key: K): boolean {
    const entry = this.map.get(key);
    if (entry === undefined) return false;
    if (this.isExpired(entry)) {
      this.detach(entry);
      this.map.delete(key);
      return false;
    }
    this.detach(entry);
    this.map.delete(key);
    return true;
  }

  size(): number {
    // Count only non-expired entries
    let count = 0;
    const now = Date.now();
    for (const [, entry] of this.map) {
      if (now < entry.expiresAt) count++;
    }
    return count;
  }

  clear(): void {
    this.map.clear();
    this.head.next = this.tail;
    this.tail.prev = this.head;
  }
}

export default LRUCacheWithTTL;
