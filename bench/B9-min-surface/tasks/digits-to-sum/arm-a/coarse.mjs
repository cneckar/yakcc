// bench/B9-min-surface/tasks/digits-to-sum/arm-a/coarse.mjs
// Arm A-coarse: single broad block for digits-to-sum.

export function digitsToSum(input) {
  if (!input || input.length === 0) throw new SyntaxError("Input must not be empty");
  if (!/^\d+$/.test(input)) throw new SyntaxError(`Input must contain only digits 0-9, got: ${JSON.stringify(input.slice(0, 20))}`);
  let sum = 0;
  for (let i = 0; i < input.length; i++) sum += input.charCodeAt(i) - 48;
  return sum;
}

export default digitsToSum;
