// SPDX-License-Identifier: MIT

/**
 * Linearly interpolate between two values and clamp the result to [a, b].
 * Returns `a + t * (b - a)` for t in [0, 1], with the output clamped so that
 * floating-point rounding errors cannot push the result outside [min(a,b), max(a,b)].
 *
 * @param a - Start value (t=0).
 * @param b - End value (t=1).
 * @param t - Interpolation factor; values outside [0, 1] are clamped before use.
 * @returns Interpolated value clamped to the range [min(a,b), max(a,b)].
 */
export function lerpClamped(a: number, b: number, t: number): number {
  const tc = Math.max(0, Math.min(1, t));
  const result = a + tc * (b - a);
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  return Math.max(lo, Math.min(hi, result));
}
