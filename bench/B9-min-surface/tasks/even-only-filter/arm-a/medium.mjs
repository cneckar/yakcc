// bench/B9-min-surface/tasks/even-only-filter/arm-a/medium.mjs
// Arm A-medium: composite validation + filter for even-only-filter.

export function validateBoundedSafeIntArray(input) {
  if (input.length > 256) {
    throw new RangeError(`Input array too long: ${input.length} > 256`);
  }
  for (let i = 0; i < input.length; i++) {
    if (!Number.isSafeInteger(input[i])) {
      throw new TypeError(`Element [${i}] is not a safe integer: ${input[i]}`);
    }
  }
}

export function collectEvenElements(input) {
  return input.filter(n => n % 2 === 0);
}

export function evenOnlyFilter(input) {
  validateBoundedSafeIntArray(input);
  return collectEvenElements(input);
}

export default evenOnlyFilter;
