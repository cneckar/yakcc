// SPDX-License-Identifier: MIT
//
// bench/B4-tokens-v3/tasks/kahan-running-stats/oracle.test.ts
//
// Oracle tests for the kahan-running-stats task (B4-v3).
// Tests are deterministic and hand-authored per DEC-BENCH-METHODOLOGY-NEVER-SYNTHETIC-001.
// Load implementation via IMPL_PATH env var (defaults to reference-impl.ts).

import { beforeEach, describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const implPath = process.env['IMPL_PATH']
  ? resolve(process.env['IMPL_PATH'])
  : resolve(__dirname, 'reference-impl.ts');
const implUrl = pathToFileURL(implPath).href;

let KahanStats: new () => {
  add(x: number): void;
  sum(): number;
  mean(): number;
  variance(): number;
  stddev(): number;
  count(): number;
  min(): number;
  max(): number;
};

beforeEach(async () => {
  const mod = await import(/* @vite-ignore */ implUrl);
  KahanStats = mod.KahanStats;
  if (!KahanStats) {
    throw new Error(`Implementation at ${implPath} must export KahanStats`);
  }
});

describe('KahanStats — sum', () => {
  it('returns 0 for empty accumulator', () => {
    expect(new KahanStats().sum()).toBe(0);
  });

  it('returns 0 for empty count', () => {
    expect(new KahanStats().count()).toBe(0);
  });

  it('sums simple integers', () => {
    const s = new KahanStats();
    s.add(1); s.add(2); s.add(3);
    expect(s.sum()).toBe(6);
  });

  it('count tracks additions', () => {
    const s = new KahanStats();
    s.add(1); s.add(2);
    expect(s.count()).toBe(2);
  });

  it('sum is accurate for small values', () => {
    const s = new KahanStats();
    s.add(0.1); s.add(0.2);
    expect(s.sum()).toBeCloseTo(0.3, 10);
  });
});

describe('KahanStats — mean', () => {
  it('throws RangeError on empty accumulator', () => {
    expect(() => new KahanStats().mean()).toThrow(RangeError);
  });

  it('mean of single value', () => {
    const s = new KahanStats();
    s.add(5);
    expect(s.mean()).toBe(5);
  });

  it('mean of [1, 2, 3] is 2', () => {
    const s = new KahanStats();
    s.add(1); s.add(2); s.add(3);
    expect(s.mean()).toBe(2);
  });

  it('mean of [10, 20, 30] is 20', () => {
    const s = new KahanStats();
    s.add(10); s.add(20); s.add(30);
    expect(s.mean()).toBeCloseTo(20, 10);
  });
});

describe('KahanStats — variance (Bessel correction n-1)', () => {
  it('throws RangeError with count === 0', () => {
    expect(() => new KahanStats().variance()).toThrow(RangeError);
  });

  it('throws RangeError with count === 1', () => {
    const s = new KahanStats();
    s.add(5);
    expect(() => s.variance()).toThrow(RangeError);
  });

  it('sample variance of [1, 3] is 2 (n-1 denominator)', () => {
    // mean=2, deviations=[1, 1], sum_sq_dev=2, sample_var = 2/(2-1) = 2
    const s = new KahanStats();
    s.add(1); s.add(3);
    expect(s.variance()).toBeCloseTo(2.0, 10);
  });

  it('sample variance of [1, 2, 3] is 1 (n-1 denominator)', () => {
    // mean=2, deviations=[-1, 0, 1], sum_sq_dev=2, sample_var = 2/(3-1) = 1
    const s = new KahanStats();
    s.add(1); s.add(2); s.add(3);
    expect(s.variance()).toBeCloseTo(1.0, 10);
  });

  it('sample variance uses n-1, NOT n', () => {
    // population variance of [1, 3] = 1.0 (divide by 2)
    // sample variance of [1, 3]     = 2.0 (divide by 1)
    const s = new KahanStats();
    s.add(1); s.add(3);
    const v = s.variance();
    // must be 2.0, not 1.0
    expect(v).toBeCloseTo(2.0, 5);
    expect(v).not.toBeCloseTo(1.0, 5);
  });
});

describe('KahanStats — stddev', () => {
  it('throws RangeError when count < 2', () => {
    const s = new KahanStats();
    s.add(1);
    expect(() => s.stddev()).toThrow(RangeError);
  });

  it('stddev of [1, 2, 3] is sqrt(1) = 1', () => {
    const s = new KahanStats();
    s.add(1); s.add(2); s.add(3);
    expect(s.stddev()).toBeCloseTo(1.0, 10);
  });

  it('stddev = sqrt(variance)', () => {
    const s = new KahanStats();
    s.add(2); s.add(4); s.add(6);
    expect(s.stddev()).toBeCloseTo(Math.sqrt(s.variance()), 12);
  });
});

describe('KahanStats — min/max', () => {
  it('throws RangeError for min on empty', () => {
    expect(() => new KahanStats().min()).toThrow(RangeError);
  });

  it('throws RangeError for max on empty', () => {
    expect(() => new KahanStats().max()).toThrow(RangeError);
  });

  it('min and max of a single value', () => {
    const s = new KahanStats();
    s.add(7);
    expect(s.min()).toBe(7);
    expect(s.max()).toBe(7);
  });

  it('tracks min and max across multiple values', () => {
    const s = new KahanStats();
    s.add(5); s.add(1); s.add(3); s.add(9); s.add(2);
    expect(s.min()).toBe(1);
    expect(s.max()).toBe(9);
  });

  it('handles negative values in min/max', () => {
    const s = new KahanStats();
    s.add(-10); s.add(5); s.add(-3);
    expect(s.min()).toBe(-10);
    expect(s.max()).toBe(5);
  });
});
