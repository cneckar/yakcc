// SPDX-License-Identifier: MIT

/**
 * Compute the number of whole calendar days between two ISO 8601 date strings
 * (YYYY-MM-DD). The result is always non-negative: |date2 - date1| in days,
 * regardless of argument order. Dates are interpreted as UTC midnight.
 *
 * @param date1 - First date in "YYYY-MM-DD" format.
 * @param date2 - Second date in "YYYY-MM-DD" format.
 * @returns The absolute number of days between the two dates.
 * @throws {RangeError} if either string is not a valid ISO date.
 */
export function daysBetweenDates(date1: string, date2: string): number {
  const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  if (!ISO_DATE_RE.test(date1) || !ISO_DATE_RE.test(date2)) {
    throw new RangeError("daysBetweenDates: both arguments must be YYYY-MM-DD strings");
  }
  const ms1 = Date.UTC(
    Number(date1.slice(0, 4)), Number(date1.slice(5, 7)) - 1, Number(date1.slice(8, 10))
  );
  const ms2 = Date.UTC(
    Number(date2.slice(0, 4)), Number(date2.slice(5, 7)) - 1, Number(date2.slice(8, 10))
  );
  if (Number.isNaN(ms1) || Number.isNaN(ms2)) {
    throw new RangeError("daysBetweenDates: could not parse one or both date strings");
  }
  return Math.round(Math.abs(ms2 - ms1) / 86_400_000);
}
