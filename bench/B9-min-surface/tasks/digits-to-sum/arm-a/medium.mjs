// bench/B9-min-surface/tasks/digits-to-sum/arm-a/medium.mjs
// Arm A-medium: composite validation + computation for digits-to-sum.

export function validateDigitString(input) {
  if (!input || input.length === 0) throw new SyntaxError("Input must not be empty");
  for (let i = 0; i < input.length; i++) {
    const code = input.charCodeAt(i);
    if (code > 127) throw new SyntaxError(`Non-ASCII character at position ${i}`);
    if (code < 48 || code > 57) throw new SyntaxError(`Non-digit '${input[i]}' at position ${i}`);
  }
}

export function computeDigitSum(input) {
  let sum = 0;
  for (let i = 0; i < input.length; i++) sum += input.charCodeAt(i) - 48;
  return sum;
}

export function digitsToSum(input) {
  validateDigitString(input);
  return computeDigitSum(input);
}

export default digitsToSum;
