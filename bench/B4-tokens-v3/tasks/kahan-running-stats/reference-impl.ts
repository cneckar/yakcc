// SPDX-License-Identifier: MIT
// Reference implementation for B4-v3 oracle validation.

export class KahanStats {
  private _count = 0;
  private _sum = 0;
  private _comp = 0;  // Kahan compensation term
  private _mean = 0;  // running mean (Welford)
  private _m2 = 0;    // running sum of squared deviations (Welford)
  private _min = Infinity;
  private _max = -Infinity;

  add(x: number): void {
    this._count++;

    // Kahan compensated sum
    const y = x - this._comp;
    const t = this._sum + y;
    this._comp = (t - this._sum) - y;
    this._sum = t;

    // Welford online variance algorithm
    const delta = x - this._mean;
    this._mean += delta / this._count;
    const delta2 = x - this._mean;
    this._m2 += delta * delta2;

    if (x < this._min) this._min = x;
    if (x > this._max) this._max = x;
  }

  sum(): number { return this._sum; }
  count(): number { return this._count; }

  mean(): number {
    if (this._count === 0) throw new RangeError('mean requires at least 1 value');
    return this._mean;
  }

  variance(): number {
    if (this._count < 2) throw new RangeError('variance requires at least 2 values');
    return this._m2 / (this._count - 1);
  }

  stddev(): number {
    return Math.sqrt(this.variance());
  }

  min(): number {
    if (this._count === 0) throw new RangeError('min requires at least 1 value');
    return this._min;
  }

  max(): number {
    if (this._count === 0) throw new RangeError('max requires at least 1 value');
    return this._max;
  }
}
