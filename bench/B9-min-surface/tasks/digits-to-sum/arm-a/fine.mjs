// bench/B9-min-surface/tasks/digits-to-sum/arm-a/fine.mjs
// Arm A-fine: maximally atomic decomposition for digits-to-sum.

export function nonAsciiRejector(input) {
  for (let i = 0; i < input.length; i++) {
    if (input.charCodeAt(i) > 127) throw new SyntaxError(`Non-ASCII character at position ${i}`);
  }
}

export function emptyCheck(input) {
  if (input.length === 0) throw new SyntaxError("Input must not be empty");
}

export function digitOnlyCheck(input) {
  for (let i = 0; i < input.length; i++) {
    if (input[i] < "0" || input[i] > "9") {
      throw new SyntaxError(`Non-digit character '${input[i]}' at position ${i}`);
    }
  }
}

export function sumDigits(input) {
  let sum = 0;
  for (let i = 0; i < input.length; i++) {
    sum += input.charCodeAt(i) - 48; // '0'.charCodeAt(0) = 48
  }
  return sum;
}

export function digitsToSum(input) {
  nonAsciiRejector(input);
  emptyCheck(input);
  digitOnlyCheck(input);
  return sumDigits(input);
}

export default digitsToSum;
