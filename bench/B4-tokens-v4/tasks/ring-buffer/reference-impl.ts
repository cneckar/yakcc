// SPDX-License-Identifier: MIT
// Fixed-capacity ring buffer.

export class RingBuffer<T> {
  private readonly buf: (T | undefined)[];
  private readonly cap: number;
  private head: number = 0; // index of oldest item
  private count: number = 0;

  constructor(capacity: number) {
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new RangeError(`capacity must be a positive integer, got ${capacity}`);
    }
    this.cap = capacity;
    this.buf = new Array(capacity);
  }

  get capacity(): number { return this.cap; }
  get size(): number { return this.count; }

  push(item: T): T | undefined {
    let evicted: T | undefined = undefined;
    const tail = (this.head + this.count) % this.cap;

    if (this.count === this.cap) {
      // Full: overwrite oldest (head position), advance head
      evicted = this.buf[this.head] as T;
      this.buf[this.head] = item;
      this.head = (this.head + 1) % this.cap;
    } else {
      this.buf[tail] = item;
      this.count++;
    }
    return evicted;
  }

  shift(): T | undefined {
    if (this.count === 0) return undefined;
    const item = this.buf[this.head] as T;
    this.buf[this.head] = undefined;
    this.head = (this.head + 1) % this.cap;
    this.count--;
    return item;
  }

  peek(): T | undefined {
    if (this.count === 0) return undefined;
    return this.buf[this.head] as T;
  }

  get(index: number): T {
    // Normalize negative index
    let i = index < 0 ? this.count + index : index;
    if (!Number.isInteger(i) || i < 0 || i >= this.count) {
      throw new RangeError(`Index ${index} out of bounds for size ${this.count}`);
    }
    return this.buf[(this.head + i) % this.cap] as T;
  }

  [Symbol.iterator](): Iterator<T> {
    let pos = 0;
    const self = this;
    return {
      next(): IteratorResult<T> {
        if (pos >= self.count) return { done: true, value: undefined };
        const item = self.buf[(self.head + pos) % self.cap] as T;
        pos++;
        return { done: false, value: item };
      },
    };
  }

  clear(): void {
    this.buf.fill(undefined);
    this.head = 0;
    this.count = 0;
  }
}
