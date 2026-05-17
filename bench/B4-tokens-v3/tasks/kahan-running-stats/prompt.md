Implement a streaming statistics accumulator using Kahan compensated summation.

Export this class:

```typescript
export class KahanStats {
  add(x: number): void
  sum(): number        // Kahan compensated sum (see algorithm below)
  mean(): number       // arithmetic mean; throws RangeError if count === 0
  variance(): number   // sample variance (n−1 denominator, Bessel's correction); throws RangeError if count < 2
  stddev(): number     // Math.sqrt(variance()); throws RangeError if count < 2
  count(): number      // number of values added
  min(): number        // minimum value added; throws RangeError if count === 0
  max(): number        // maximum value added; throws RangeError if count === 0
}
```

**Kahan compensated summation** (you may use the Neumaier variant):
```
// Standard Kahan:
let sum = 0, c = 0
for each x:
  y = x - c
  t = sum + y
  c = (t - sum) - y
  sum = t
// return sum
```

**`variance()`** is the **sample variance** — divide by `n−1`, not `n` (Bessel's correction):
```
variance = Σ(xᵢ - mean)² / (n − 1)
```

**Error conditions** (must throw `RangeError`, NOT `Error` or other types):
- `mean()`, `min()`, `max()` throw `RangeError` with a message containing "at least 1" when `count === 0`
- `variance()`, `stddev()` throw `RangeError` with a message containing "at least 2" when `count < 2`

Constraints:
- No external libraries
- `add()` accepts any number including Infinity, -Infinity, NaN
- `sum()` on empty accumulator returns 0
- `count()` on empty accumulator returns 0
