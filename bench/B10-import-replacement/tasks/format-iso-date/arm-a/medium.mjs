// SPDX-License-Identifier: MIT
//
// bench/B10-import-replacement/tasks/format-iso-date/arm-a/medium.mjs
//
// @decision DEC-BENCH-B10-SLICE3-ARMA-FALLBACK-001
// @title Arm A-medium produced via hand-translation fallback (not yakcc compile + #508 hook)
// @status accepted
// @rationale Same fallback as fine.mjs. GRANULARITY: A-medium. Zero non-builtin imports.

function pad(n, l) { return String(Math.abs(n)).padStart(l, '0'); }

export function formatDateTimeParts(date) {
  const off = date.getTimezoneOffset();
  const sign = off > 0 ? '-' : '+';
  const abs = Math.abs(off);
  return {
    date: pad(date.getFullYear(), 4) + '-' + pad(date.getMonth() + 1, 2) + '-' + pad(date.getDate(), 2),
    time: pad(date.getHours(), 2) + ':' + pad(date.getMinutes(), 2) + ':' + pad(date.getSeconds(), 2),
    tz: sign + pad(Math.floor(abs / 60), 2) + ':' + pad(abs % 60, 2),
  };
}

export function formatIsoDate(date) {
  if (!(date instanceof Date) || isNaN(date.getTime())) throw new RangeError('Invalid date');
  const { date: d, time: t, tz } = formatDateTimeParts(date);
  return d + 'T' + t + tz;
}

export default formatIsoDate;
