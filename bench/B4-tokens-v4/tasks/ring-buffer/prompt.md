Implement a fixed-capacity ring buffer (circular buffer).

Export a **single class**:

```typescript
export class RingBuffer<T> {
  /**
   * @param capacity Maximum number of items. Must be a positive integer.
   * @throws RangeError if capacity is not a positive integer.
   */
  constructor(capacity: number);

  /**
   * Add an item to the back. If the buffer is full, the **oldest** item is
   * overwritten and returned. Returns undefined when the buffer was not full.
   */
  push(item: T): T | undefined;

  /**
   * Remove and return the **oldest** (front) item.
   * Returns undefined if the buffer is empty.
   */
  shift(): T | undefined;

  /**
   * Return the oldest item without removing it.
   * Returns undefined if the buffer is empty.
   */
  peek(): T | undefined;

  /**
   * Return the item at logical index `i` (0 = oldest).
   * Negative indices count from the back (-1 = newest).
   * Throws RangeError if the index is out of bounds.
   */
  get(index: number): T;

  /**
   * Iterate items from oldest to newest.
   * Must implement the iterable protocol so `for...of` works.
   */
  [Symbol.iterator](): Iterator<T>;

  /** Current number of items (0 ≤ size ≤ capacity). */
  get size(): number;

  /** The fixed capacity set at construction. */
  get capacity(): number;

  /** Remove all items. */
  clear(): void;
}
```

Constraints:
- No external libraries.
- Use a fixed-size array internally (pre-allocated at construction). Do NOT use a dynamic array that grows.
- O(1) `push`, `shift`, `peek`, `get`.
- `push` on a full buffer overwrites the oldest item (wrap-around), returning the displaced item.
- `get(-1)` returns the newest item; `get(-capacity)` returns the oldest item when full.
