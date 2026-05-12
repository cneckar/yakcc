// SPDX-License-Identifier: MIT

/**
 * Determine whether a year is a leap year in the proleptic Gregorian calendar.
 * A year is a leap year if it is divisible by 4, EXCEPT for century years
 * (divisible by 100), which must also be divisible by 400.
 *
 * @param year - The year to test; must be a finite integer (may be negative for BCE years).
 * @returns True if the year is a Gregorian leap year; false otherwise.
 * @throws {RangeError} if year is not a finite integer.
 */
export function isLeapYearGregorian(year: number): boolean {
  if (!Number.isFinite(year) || !Number.isInteger(year)) {
    throw new RangeError("isLeapYearGregorian: year must be a finite integer");
  }
  if (year % 400 === 0) return true;
  if (year % 100 === 0) return false;
  if (year % 4 === 0) return true;
  return false;
}
