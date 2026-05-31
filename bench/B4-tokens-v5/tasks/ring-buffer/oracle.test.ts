// SPDX-License-Identifier: MIT
//
// bench/B4-tokens-v4/tasks/ring-buffer/oracle.test.ts
//
// Oracle tests for the ring-buffer task (B4-v4).

import { describe, it, expect, beforeEach } from 'vitest';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const implPath = process.env['IMPL_PATH']
  ? resolve(process.env['IMPL_PATH'])
  : resolve(__dirname, 'reference-impl.ts');
const implUrl = pathToFileURL(implPath).href;

type RingBuf<T> = {
  push(item: T): T | undefined;
  shift(): T | undefined;
  peek(): T | undefined;
  get(i: number): T;
  [Symbol.iterator](): Iterator<T>;
  size: number;
  capacity: number;
  clear(): void;
};
let RingBuffer: new <T>(cap: number) => RingBuf<T>;

beforeEach(async () => {
  const mod = await import(/* @vite-ignore */ implUrl);
  RingBuffer = mod.RingBuffer;
  if (typeof RingBuffer !== 'function') {
    throw new Error(`Implementation must export RingBuffer as a named class`);
  }
});

describe('ring-buffer — constructor', () => {
  it('throws RangeError for capacity 0', () => {
    expect(() => new RingBuffer(0)).toThrow(RangeError);
  });
  it('throws RangeError for negative capacity', () => {
    expect(() => new RingBuffer(-5)).toThrow(RangeError);
  });
  it('throws RangeError for non-integer capacity', () => {
    expect(() => new RingBuffer(2.5)).toThrow(RangeError);
  });
  it('initializes with size=0 and correct capacity', () => {
    const rb = new RingBuffer<number>(5);
    expect(rb.size).toBe(0);
    expect(rb.capacity).toBe(5);
  });
});

describe('ring-buffer — push and size', () => {
  it('returns undefined when not full', () => {
    const rb = new RingBuffer<number>(3);
    expect(rb.push(1)).toBeUndefined();
    expect(rb.push(2)).toBeUndefined();
    expect(rb.size).toBe(2);
  });

  it('returns evicted item when full', () => {
    const rb = new RingBuffer<number>(3);
    rb.push(1); rb.push(2); rb.push(3);
    expect(rb.push(4)).toBe(1); // oldest evicted
    expect(rb.size).toBe(3);
  });

  it('capacity=1: every push evicts the previous item', () => {
    const rb = new RingBuffer<number>(1);
    expect(rb.push(10)).toBeUndefined();
    expect(rb.push(20)).toBe(10);
    expect(rb.push(30)).toBe(20);
    expect(rb.size).toBe(1);
    expect(rb.peek()).toBe(30);
  });
});

describe('ring-buffer — shift', () => {
  it('returns undefined on empty buffer', () => {
    expect(new RingBuffer<number>(3).shift()).toBeUndefined();
  });

  it('removes and returns oldest item', () => {
    const rb = new RingBuffer<number>(3);
    rb.push(1); rb.push(2); rb.push(3);
    expect(rb.shift()).toBe(1);
    expect(rb.shift()).toBe(2);
    expect(rb.size).toBe(1);
  });

  it('size decrements on shift', () => {
    const rb = new RingBuffer<number>(3);
    rb.push(5);
    rb.shift();
    expect(rb.size).toBe(0);
  });
});

describe('ring-buffer — peek', () => {
  it('returns undefined on empty buffer', () => {
    expect(new RingBuffer<number>(3).peek()).toBeUndefined();
  });

  it('returns oldest without removing', () => {
    const rb = new RingBuffer<number>(3);
    rb.push(10); rb.push(20);
    expect(rb.peek()).toBe(10);
    expect(rb.size).toBe(2); // unchanged
  });
});

describe('ring-buffer — get', () => {
  it('get(0) returns oldest item', () => {
    const rb = new RingBuffer<number>(3);
    rb.push(1); rb.push(2); rb.push(3);
    expect(rb.get(0)).toBe(1);
  });

  it('get(-1) returns newest item', () => {
    const rb = new RingBuffer<number>(3);
    rb.push(1); rb.push(2); rb.push(3);
    expect(rb.get(-1)).toBe(3);
  });

  it('get(-2) returns second-newest', () => {
    const rb = new RingBuffer<number>(3);
    rb.push(1); rb.push(2); rb.push(3);
    expect(rb.get(-2)).toBe(2);
  });

  it('throws RangeError for out-of-bounds positive index', () => {
    const rb = new RingBuffer<number>(3);
    rb.push(1); rb.push(2);
    expect(() => rb.get(2)).toThrow(RangeError); // size=2, index 2 is out
  });

  it('throws RangeError for out-of-bounds negative index', () => {
    const rb = new RingBuffer<number>(3);
    rb.push(1); rb.push(2);
    expect(() => rb.get(-3)).toThrow(RangeError); // size=2, -3 is out
  });

  it('get works correctly after wrap-around', () => {
    const rb = new RingBuffer<number>(3);
    rb.push(1); rb.push(2); rb.push(3);
    rb.push(4); // evicts 1, buffer is now [2, 3, 4]
    expect(rb.get(0)).toBe(2);
    expect(rb.get(1)).toBe(3);
    expect(rb.get(2)).toBe(4);
    expect(rb.get(-1)).toBe(4);
    expect(rb.get(-3)).toBe(2);
  });
});

describe('ring-buffer — iterator', () => {
  it('iterates from oldest to newest', () => {
    const rb = new RingBuffer<number>(4);
    rb.push(1); rb.push(2); rb.push(3);
    expect([...rb]).toEqual([1, 2, 3]);
  });

  it('iterates correctly after wrap-around', () => {
    const rb = new RingBuffer<number>(3);
    rb.push(1); rb.push(2); rb.push(3);
    rb.push(4); // evicts 1
    expect([...rb]).toEqual([2, 3, 4]);
  });

  it('for...of works', () => {
    const rb = new RingBuffer<string>(3);
    rb.push('a'); rb.push('b'); rb.push('c');
    const result: string[] = [];
    for (const v of rb) result.push(v);
    expect(result).toEqual(['a', 'b', 'c']);
  });

  it('empty buffer iterates zero items', () => {
    expect([...new RingBuffer<number>(5)]).toEqual([]);
  });
});

describe('ring-buffer — clear', () => {
  it('resets size to 0', () => {
    const rb = new RingBuffer<number>(3);
    rb.push(1); rb.push(2);
    rb.clear();
    expect(rb.size).toBe(0);
  });

  it('returns undefined for peek after clear', () => {
    const rb = new RingBuffer<number>(3);
    rb.push(1);
    rb.clear();
    expect(rb.peek()).toBeUndefined();
  });

  it('can push after clear', () => {
    const rb = new RingBuffer<number>(2);
    rb.push(1); rb.push(2); // full
    rb.clear();
    rb.push(10); rb.push(20);
    expect([...rb]).toEqual([10, 20]);
  });
});

describe('ring-buffer — push/shift interleaved (exhaustive wrap-around)', () => {
  it('maintains FIFO order through multiple wrap-arounds', () => {
    const rb = new RingBuffer<number>(3);
    rb.push(1); rb.push(2); rb.push(3);
    expect(rb.shift()).toBe(1);
    rb.push(4);
    expect(rb.shift()).toBe(2);
    rb.push(5);
    expect([...rb]).toEqual([3, 4, 5]);
  });
});
