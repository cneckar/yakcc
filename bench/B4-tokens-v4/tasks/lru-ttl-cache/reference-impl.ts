// SPDX-License-Identifier: MIT
// LRU cache with per-entry TTL.

interface Entry<K, V> {
  key: K;
  value: V;
  expiresAt: number; // 0 = never expires
  prev: Entry<K, V> | null;
  next: Entry<K, V> | null;
}

export class LRUTTLCache<K, V> {
  private readonly cap: number;
  private readonly defaultTtlMs: number;
  private readonly map: Map<K, Entry<K, V>> = new Map();
  // Doubly-linked list: head = LRU end, tail = MRU end
  private head: Entry<K, V> | null = null;
  private tail: Entry<K, V> | null = null;

  constructor(capacity: number, defaultTtlMs = 0) {
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new RangeError(`capacity must be a positive integer, got ${capacity}`);
    }
    this.cap = capacity;
    this.defaultTtlMs = defaultTtlMs;
  }

  get(key: K): V | undefined {
    const entry = this.map.get(key);
    if (entry === undefined) return undefined;
    if (this.isExpired(entry)) {
      this.removeEntry(entry);
      return undefined;
    }
    this.moveToTail(entry);
    return entry.value;
  }

  set(key: K, value: V, ttlMs = 0): void {
    const now = Date.now();
    const effectiveTtl = ttlMs > 0 ? ttlMs : this.defaultTtlMs;
    const expiresAt = effectiveTtl > 0 && effectiveTtl !== Infinity
      ? now + effectiveTtl
      : 0;

    const existing = this.map.get(key);
    if (existing !== undefined) {
      existing.value = value;
      existing.expiresAt = expiresAt;
      this.moveToTail(existing);
      return;
    }

    // Evict all expired entries before capacity check
    this.evictExpired(now);

    // Evict LRU if still at capacity
    if (this.map.size >= this.cap) {
      this.evictLRU();
    }

    const entry: Entry<K, V> = { key, value, expiresAt, prev: null, next: null };
    this.map.set(key, entry);
    this.appendToTail(entry);
  }

  delete(key: K): boolean {
    const entry = this.map.get(key);
    if (entry === undefined) return false;
    this.removeEntry(entry);
    return true;
  }

  has(key: K): boolean {
    const entry = this.map.get(key);
    if (entry === undefined) return false;
    if (this.isExpired(entry)) {
      this.removeEntry(entry);
      return false;
    }
    return true;
  }

  get size(): number {
    const now = Date.now();
    let count = 0;
    let cur = this.head;
    while (cur !== null) {
      if (!this.isExpiredAt(cur, now)) count++;
      cur = cur.next;
    }
    return count;
  }

  clear(): void {
    this.map.clear();
    this.head = null;
    this.tail = null;
  }

  entries(): [K, V][] {
    const now = Date.now();
    const result: [K, V][] = [];
    let cur = this.head;
    while (cur !== null) {
      if (!this.isExpiredAt(cur, now)) {
        result.push([cur.key, cur.value]);
      }
      cur = cur.next;
    }
    return result;
  }

  // -------------------------------------------------------------------------

  private isExpired(entry: Entry<K, V>): boolean {
    return entry.expiresAt !== 0 && Date.now() >= entry.expiresAt;
  }

  private isExpiredAt(entry: Entry<K, V>, now: number): boolean {
    return entry.expiresAt !== 0 && now >= entry.expiresAt;
  }

  private evictExpired(now: number): void {
    let cur = this.head;
    while (cur !== null) {
      const next = cur.next;
      if (this.isExpiredAt(cur, now)) {
        this.removeEntry(cur);
      }
      cur = next;
    }
  }

  private evictLRU(): void {
    // Find the first non-expired entry from the head (LRU end)
    let cur = this.head;
    while (cur !== null) {
      if (!this.isExpired(cur)) {
        this.removeEntry(cur);
        return;
      }
      cur = cur.next;
    }
  }

  private appendToTail(entry: Entry<K, V>): void {
    entry.prev = this.tail;
    entry.next = null;
    if (this.tail !== null) this.tail.next = entry;
    this.tail = entry;
    if (this.head === null) this.head = entry;
  }

  private moveToTail(entry: Entry<K, V>): void {
    if (entry === this.tail) return;
    this.unlinkEntry(entry);
    this.appendToTail(entry);
  }

  private unlinkEntry(entry: Entry<K, V>): void {
    if (entry.prev !== null) entry.prev.next = entry.next;
    else this.head = entry.next;
    if (entry.next !== null) entry.next.prev = entry.prev;
    else this.tail = entry.prev;
    entry.prev = null;
    entry.next = null;
  }

  private removeEntry(entry: Entry<K, V>): void {
    this.unlinkEntry(entry);
    this.map.delete(entry.key);
  }
}
