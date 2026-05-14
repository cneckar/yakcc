// SPDX-License-Identifier: MIT
//
// @decision DEC-V0-B4-SEED-lru-node-001
// @title lru-node: doubly-linked list node for O(1) LRU eviction
// @status accepted
// @rationale
//   The lru-cache-with-ttl B4 task requires a doubly-linked list as the ordered
//   eviction structure. O(1) insert-at-head, O(1) remove-any, and O(1)
//   move-to-head all depend on prev/next pointer wiring. This atom is the
//   fundamental allocation unit: create a node, wire its pointers externally.
//
//   Design decisions:
//   (A) MUTABLE FIELDS: prev and next are mutable (not readonly) because the
//       LRU algorithm must rewire pointers in-place on every cache hit. Readonly
//       fields would require allocating a new node on every access -- O(n) space
//       for an O(n) operation sequence, defeating the purpose.
//
//   (B) PLAIN OBJECT RETURN: Returns a plain JS object that satisfies the
//       LruNode interface. No class needed; the interface provides the type
//       contract and the plain-object implementation avoids prototype overhead.
//
//   (C) UNKNOWN VALUE TYPE: value is typed as unknown (not generic) to keep
//       the atom strictly within the validated TypeScript subset. Callers cast
//       to their concrete type after retrieval, which is idiomatic for a low-
//       level building block.
//
//   Reference: Cormen et al., "Introduction to Algorithms" 4th ed., Section 10.2
//   (doubly linked lists) and Section 20.1 (hash table + list for O(1) LRU).

/** A node in a doubly-linked intrusive list used by the LRU eviction policy. */
export interface LruNode {
  key: string;
  value: unknown;
  prev: LruNode | null;
  next: LruNode | null;
}

/**
 * Allocate a new LRU list node for the given key-value pair.
 *
 * Both prev and next are initialised to null. The caller is responsible for
 * wiring pointers when inserting the node into the eviction list.
 *
 * @param key   - Cache key. Stored by reference (no copy).
 * @param value - Cached value. Stored by reference (no copy).
 * @returns A new LruNode with null prev/next pointers.
 */
export function makeLruNode(key: string, value: unknown): LruNode {
  return { key, value, prev: null, next: null };
}
