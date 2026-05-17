// SPDX-License-Identifier: MIT
//
// bench/B10-import-replacement/tasks/format-iso-date/arm-a/coarse.mjs
//
// @decision DEC-BENCH-B10-SLICE3-ARMA-FALLBACK-001
// @title Arm A-coarse produced via hand-translation fallback (not yakcc compile + #508 hook)
// @status accepted
// @rationale Same fallback as fine.mjs. GRANULARITY: A-coarse. Zero non-builtin imports.

export function formatIsoDate(date) {
  if (!(date instanceof Date) || isNaN(date.getTime())) throw new RangeError('Invalid date');
  const p = (n, l) => String(Math.abs(n)).padStart(l, '0');
  const off = date.getTimezoneOffset();
  const sign = off > 0 ? '-' : '+';
  const abs = Math.abs(off);
  return p(date.getFullYear(), 4) + '-' + p(date.getMonth() + 1, 2) + '-' + p(date.getDate(), 2) +
    'T' + p(date.getHours(), 2) + ':' + p(date.getMinutes(), 2) + ':' + p(date.getSeconds(), 2) +
    sign + p(Math.floor(abs / 60), 2) + ':' + p(abs % 60, 2);
}

export default formatIsoDate;
