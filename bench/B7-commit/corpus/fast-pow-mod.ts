// SPDX-License-Identifier: MIT

/**
 * Compute (base ^ exponent) mod modulus using fast binary exponentiation
 * (right-to-left square-and-multiply). All arguments must be non-negative
 * safe integers. Returns 1 when exponent is 0 (including 0^0 = 1 by convention).
 *
 * @param base     - The base; must be a non-negative safe integer.
 * @param exponent - The exponent; must be a non-negative safe integer.
 * @param modulus  - The modulus; must be a positive safe integer.
 * @returns (base ^ exponent) % modulus.
 * @throws {RangeError} if any argument violates the precondition.
 */
export function fastPowMod(base: number, exponent: number, modulus: number): number {
  if (!Number.isSafeInteger(base) || base < 0) throw new RangeError("base must be a non-negative safe integer");
  if (!Number.isSafeInteger(exponent) || exponent < 0) throw new RangeError("exponent must be a non-negative safe integer");
  if (!Number.isSafeInteger(modulus) || modulus <= 0) throw new RangeError("modulus must be a positive safe integer");
  if (modulus === 1) return 0;
  let result = 1;
  let b = base % modulus;
  let e = exponent;
  while (e > 0) {
    if (e % 2 === 1) result = (result * b) % modulus;
    b = (b * b) % modulus;
    e = Math.floor(e / 2);
  }
  return result;
}
