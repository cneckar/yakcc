// SPDX-License-Identifier: MIT
//
// bench/B10-import-replacement/tasks/validate-string-min-max/arm-a/fine.mjs
//
// @decision DEC-BENCH-B10-SLICE3-ARMA-ENGINE-GAP-DISCLOSED-001
// @title Arm A-fine: engine-gap-disclosed (#619 + #576) -- zod helper-file mapping
// @status accepted
// @rationale
//   zod@3.25.76 TS-compiled CJS has ArrowFunction-in-class-body per issue #576 and
//   TS-compiled CJS prelude per issue #619. The shave engine maps to helper files
//   (util.cjs / parseUtil.cjs) rather than the binding-bearing source per
//   DEC-WI510-S8-HELPER-FILE-MAPPING-001 / DEC-WI510-S8-HELPER-FILE-MAPPING-AMENDED-002.
//   This arm-a is a hand-authored string-length validation reference, semantically
//   faithful to z.string().min(n).max(m).safeParse() but NOT a real atom composition.
//   Engine gap tracked at #619 + #576 OPEN.
//
//   GRANULARITY: A-fine -- 4 named functions. Zero non-builtin imports.
//
//   Cross-references:
//   DEC-BENCH-B10-SLICE3-ARMA-ENGINE-GAP-DISCLOSED-001
//   DEC-WI510-S8-HELPER-FILE-MAPPING-001 / DEC-WI510-S8-HELPER-FILE-MAPPING-AMENDED-002
//   plans/wi-512-s3-b10-broaden.md §2.4, §4

/**
 * Atom: check that input is a string.
 * @param {unknown} input
 * @returns {boolean}
 */
export function isString(input) {
  return typeof input === 'string';
}

/**
 * Atom: check string length >= min.
 * @param {string} s
 * @param {number} min
 * @returns {boolean}
 */
export function checkMinLength(s, min) {
  return s.length >= min;
}

/**
 * Atom: check string length <= max.
 * @param {string} s
 * @param {number} max
 * @returns {boolean}
 */
export function checkMaxLength(s, max) {
  return s.length <= max;
}

/**
 * Entry: validate that input is a string with length between min and max (inclusive).
 * Never throws; returns { success, error? }.
 *
 * @param {unknown} input
 * @param {number} min
 * @param {number} max
 * @returns {{ success: boolean; error?: string }}
 */
export function validateStringMinMax(input, min, max) {
  if (!isString(input)) {
    return { success: false, error: 'Expected string, received ' + typeof input };
  }
  if (!checkMinLength(input, min)) {
    return { success: false, error: 'String must contain at least ' + min + ' character(s)' };
  }
  if (!checkMaxLength(input, max)) {
    return { success: false, error: 'String must contain at most ' + max + ' character(s)' };
  }
  return { success: true };
}

export default validateStringMinMax;
