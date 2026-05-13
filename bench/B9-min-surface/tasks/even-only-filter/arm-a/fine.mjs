// bench/B9-min-surface/tasks/even-only-filter/arm-a/fine.mjs
// Arm A-fine: maximally atomic decomposition for even-only-filter.

const MAX_LENGTH = 256;

export function lengthCheck(input) {
  if (input.length > MAX_LENGTH) {
    throw new RangeError(`Input array exceeds maximum length of ${MAX_LENGTH}, got ${input.length}`);
  }
}

export function safeIntegerCheck(input) {
  for (let i = 0; i < input.length; i++) {
    if (!Number.isSafeInteger(input[i])) {
      throw new TypeError(`Element at index ${i} is not a safe integer: ${input[i]}`);
    }
  }
}

export function filterEven(input) {
  const result = [];
  for (let i = 0; i < input.length; i++) {
    if (input[i] % 2 === 0) result.push(input[i]);
  }
  return result;
}

export function evenOnlyFilter(input) {
  lengthCheck(input);
  safeIntegerCheck(input);
  return filterEven(input);
}

export default evenOnlyFilter;
