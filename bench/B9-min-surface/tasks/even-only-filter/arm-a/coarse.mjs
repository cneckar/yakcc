// bench/B9-min-surface/tasks/even-only-filter/arm-a/coarse.mjs
// Arm A-coarse: single broad block for even-only-filter.

export function evenOnlyFilter(input) {
  if (input.length > 256) throw new RangeError(`Array length ${input.length} exceeds maximum 256`);
  const result = [];
  for (let i = 0; i < input.length; i++) {
    if (!Number.isSafeInteger(input[i])) throw new TypeError(`Element [${i}] not a safe integer: ${input[i]}`);
    if (input[i] % 2 === 0) result.push(input[i]);
  }
  return result;
}

export default evenOnlyFilter;
