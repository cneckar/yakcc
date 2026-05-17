// SPDX-License-Identifier: MIT
//
// bench/B10-import-replacement/tasks/format-iso-date/arm-a/fine.mjs
//
// @decision DEC-BENCH-B10-SLICE3-ARMA-FALLBACK-001
// @title Arm A-fine produced via hand-translation fallback (not yakcc compile + #508 hook)
// @status accepted
// @rationale
//   Hand-translation of date-fns formatISO subgraph from WI-510 S5.
//   GRANULARITY: A-fine -- 4 named functions. Zero non-builtin imports.
//
//   Cross-references:
//   DEC-BENCH-B10-SLICE3-TASK-CORPUS-SELECTION-001 -- corpus-spec.json
//   plans/wi-512-s3-b10-broaden.md §4

/**
 * Atom: pad a number with leading zeros to given length.
 * @param {number} n
 * @param {number} len
 * @returns {string}
 */
export function addLeadingZeros(n, len) {
  return String(Math.abs(n)).padStart(len, '0');
}

/**
 * Atom: format the date portion YYYY-MM-DD.
 * @param {Date} date
 * @returns {string}
 */
export function formatDatePart(date) {
  return (
    addLeadingZeros(date.getFullYear(), 4) + '-' +
    addLeadingZeros(date.getMonth() + 1, 2) + '-' +
    addLeadingZeros(date.getDate(), 2)
  );
}

/**
 * Atom: format the time portion HH:mm:ss.
 * @param {Date} date
 * @returns {string}
 */
export function formatTimePart(date) {
  return (
    addLeadingZeros(date.getHours(), 2) + ':' +
    addLeadingZeros(date.getMinutes(), 2) + ':' +
    addLeadingZeros(date.getSeconds(), 2)
  );
}

/**
 * Atom: format the timezone offset +HH:mm or -HH:mm (never Z).
 * @param {Date} date
 * @returns {string}
 */
export function formatTzOffset(date) {
  const off = date.getTimezoneOffset();
  const sign = off > 0 ? '-' : '+';
  const abs = Math.abs(off);
  return sign + addLeadingZeros(Math.floor(abs / 60), 2) + ':' + addLeadingZeros(abs % 60, 2);
}

/**
 * Entry: format a Date as ISO 8601 extended string with timezone offset.
 * @param {Date} date
 * @returns {string}
 */
export function formatIsoDate(date) {
  if (!(date instanceof Date) || isNaN(date.getTime())) {
    throw new RangeError('Invalid date');
  }
  return formatDatePart(date) + 'T' + formatTimePart(date) + formatTzOffset(date);
}

export default formatIsoDate;
