// SPDX-License-Identifier: MIT
//
// bench/B10-import-replacement/tasks/add-business-days/arm-a/medium.mjs
//
// @decision DEC-BENCH-B10-SLICE3-ARMA-FALLBACK-001
// @title Arm A-medium produced via hand-translation fallback (not yakcc compile + #508 hook)
// @status accepted
// @rationale Same fallback as fine.mjs. GRANULARITY: A-medium. Zero non-builtin imports.

export function cloneDate(date) {
  if (date instanceof Date) return new Date(date.getTime());
  if (typeof date === 'number') return new Date(date);
  throw new TypeError('Invalid date argument');
}

export function addBusinessDays(date, days) {
  if (typeof days !== 'number' || !isFinite(days)) throw new RangeError('days must be a finite number');
  const result = cloneDate(date);
  result.setDate(result.getDate() + Math.trunc(days));
  return result;
}

export default addBusinessDays;
