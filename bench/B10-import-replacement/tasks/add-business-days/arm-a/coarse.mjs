// SPDX-License-Identifier: MIT
//
// bench/B10-import-replacement/tasks/add-business-days/arm-a/coarse.mjs
//
// @decision DEC-BENCH-B10-SLICE3-ARMA-FALLBACK-001
// @title Arm A-coarse produced via hand-translation fallback (not yakcc compile + #508 hook)
// @status accepted
// @rationale Same fallback as fine.mjs. GRANULARITY: A-coarse. Zero non-builtin imports.

export function addBusinessDays(date, days) {
  if (typeof days !== 'number' || !isFinite(days)) throw new RangeError('days must be finite');
  const result = date instanceof Date ? new Date(date.getTime()) : new Date(date);
  result.setDate(result.getDate() + Math.trunc(days));
  return result;
}

export default addBusinessDays;
