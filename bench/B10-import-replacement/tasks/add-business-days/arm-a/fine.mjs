// SPDX-License-Identifier: MIT
//
// bench/B10-import-replacement/tasks/add-business-days/arm-a/fine.mjs
//
// @decision DEC-BENCH-B10-SLICE3-ARMA-FALLBACK-001
// @title Arm A-fine produced via hand-translation fallback (not yakcc compile + #508 hook)
// @status accepted
// @rationale
//   Hand-translation of date-fns addDays subgraph from WI-510 S5.
//   GRANULARITY: A-fine -- 3 named functions. Zero non-builtin imports.
//
//   Cross-references:
//   DEC-BENCH-B10-SLICE3-TASK-CORPUS-SELECTION-001 -- corpus-spec.json
//   plans/wi-512-s3-b10-broaden.md §4

/**
 * Atom: validate that the input is a valid Date or date-number.
 * @param {Date | number} date
 * @returns {Date}
 */
export function toDate(date) {
  if (date instanceof Date) return new Date(date.getTime());
  if (typeof date === 'number') return new Date(date);
  throw new TypeError('Invalid date argument');
}

/**
 * Atom: validate that amount is a finite number.
 * @param {number} amount
 */
export function validateDaysAmount(amount) {
  if (typeof amount !== 'number' || !isFinite(amount)) {
    throw new RangeError('days must be a finite number');
  }
}

/**
 * Entry: add a given number of days to a date.
 * @param {Date | number} date
 * @param {number} days
 * @returns {Date}
 */
export function addBusinessDays(date, days) {
  const result = toDate(date);
  validateDaysAmount(days);
  result.setDate(result.getDate() + Math.trunc(days));
  return result;
}

export default addBusinessDays;
