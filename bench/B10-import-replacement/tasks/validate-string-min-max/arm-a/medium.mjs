// SPDX-License-Identifier: MIT
//
// bench/B10-import-replacement/tasks/validate-string-min-max/arm-a/medium.mjs
//
// @decision DEC-BENCH-B10-SLICE3-ARMA-ENGINE-GAP-DISCLOSED-001
// @title Arm A-medium: engine-gap-disclosed (#619 + #576)
// @status accepted
// @rationale Same engine-gap disclosure as fine.mjs. GRANULARITY: A-medium. Zero non-builtin imports.

export function validateType(input) {
  if (typeof input !== 'string') return { success: false, error: 'Expected string, received ' + typeof input };
  return null;
}

export function validateStringMinMax(input, min, max) {
  const typeErr = validateType(input);
  if (typeErr) return typeErr;
  if (input.length < min) return { success: false, error: 'String must contain at least ' + min + ' character(s)' };
  if (input.length > max) return { success: false, error: 'String must contain at most ' + max + ' character(s)' };
  return { success: true };
}

export default validateStringMinMax;
