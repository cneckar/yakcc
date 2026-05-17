// SPDX-License-Identifier: MIT
//
// bench/B10-import-replacement/tasks/parse-rfc3339-datetime/arm-a/fine.mjs
//
// @decision DEC-BENCH-B10-SLICE3-ARMA-FALLBACK-001
// @title Arm A-fine produced via hand-translation fallback (not yakcc compile + #508 hook)
// @status accepted
// @rationale
//   Hand-translation of date-fns parseISO subgraph from WI-510 S5.
//   GRANULARITY: A-fine -- 5 named functions. Zero non-builtin imports.
//
//   Cross-references:
//   DEC-BENCH-B10-SLICE3-TASK-CORPUS-SELECTION-001 -- corpus-spec.json
//   plans/wi-512-s3-b10-broaden.md §4

/**
 * Atom: parse timezone offset to minutes.
 * @param {string} tzStr
 * @returns {number}
 */
export function parseTzOffset(tzStr) {
  if (!tzStr || tzStr === 'Z') return 0;
  const sign = tzStr[0] === '+' ? 1 : -1;
  const parts = tzStr.slice(1).split(':').map(Number);
  return sign * (parts[0] * 60 + (parts[1] || 0));
}

/**
 * Atom: parse date-only string YYYY-MM-DD.
 * @param {string} s
 * @returns {number[] | null}
 */
export function parseDateOnly(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  return [parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10)];
}

/**
 * Atom: parse time string HH:mm:ss[.sss].
 * @param {string} s
 * @returns {number[] | null}
 */
export function parseTimeOnly(s) {
  const m = /^(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?/.exec(s);
  if (!m) return null;
  const ms = m[4] ? parseInt(m[4].padEnd(3, '0'), 10) : 0;
  return [parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10), ms];
}

/**
 * Atom: extract timezone suffix from ISO string.
 * @param {string} s
 * @returns {string}
 */
export function extractTzSuffix(s) {
  const m = /(Z|[+-]\d{2}:\d{2})$/.exec(s);
  return m ? m[1] : '';
}

/**
 * Entry: parse an ISO 8601 / RFC 3339 date-time string.
 * @param {string} dateString
 * @returns {Date}
 */
export function parseRfc3339Datetime(dateString) {
  if (typeof dateString !== 'string') throw new TypeError('dateString must be a string');
  const s = dateString.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const dp = parseDateOnly(s);
    if (!dp) throw new RangeError('Invalid date: ' + dateString);
    return new Date(Date.UTC(dp[0], dp[1] - 1, dp[2]));
  }
  const tIdx = s.search(/T/i);
  if (tIdx === -1) throw new RangeError('Invalid ISO date string: ' + dateString);
  const datePart = s.slice(0, tIdx);
  const rest = s.slice(tIdx + 1);
  const tz = extractTzSuffix(rest);
  const timePart = rest.slice(0, rest.length - tz.length);
  const dp = parseDateOnly(datePart);
  if (!dp) throw new RangeError('Invalid date part: ' + datePart);
  const tp = parseTimeOnly(timePart);
  if (!tp) throw new RangeError('Invalid time part: ' + timePart);
  const offsetMin = parseTzOffset(tz);
  return new Date(Date.UTC(dp[0], dp[1] - 1, dp[2], tp[0], tp[1] - offsetMin, tp[2], tp[3]));
}

export default parseRfc3339Datetime;
