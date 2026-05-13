// bench/B9-min-surface/tasks/kebab-to-camel/arm-a/fine.mjs
// Arm A-fine: maximally atomic decomposition for kebab-to-camel.

export function emptyCheck(input) {
  if (input.length === 0) throw new SyntaxError("Input must not be empty");
}

export function allowedCharCheck(input) {
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (!((c >= "a" && c <= "z") || c === "-")) {
      throw new SyntaxError(`Invalid character '${c}' at position ${i}: only lowercase a-z and hyphens allowed`);
    }
  }
}

export function edgeHyphenCheck(input) {
  if (input[0] === "-") throw new SyntaxError("Input must not start with a hyphen");
  if (input[input.length - 1] === "-") throw new SyntaxError("Input must not end with a hyphen");
}

export function consecutiveHyphenCheck(input) {
  for (let i = 0; i < input.length - 1; i++) {
    if (input[i] === "-" && input[i + 1] === "-") {
      throw new SyntaxError(`Consecutive hyphens at position ${i}`);
    }
  }
}

export function transformToCamel(input) {
  const parts = input.split("-");
  return parts[0] + parts.slice(1).map(p => p[0].toUpperCase() + p.slice(1)).join("");
}

export function kebabToCamel(input) {
  emptyCheck(input);
  allowedCharCheck(input);
  edgeHyphenCheck(input);
  consecutiveHyphenCheck(input);
  return transformToCamel(input);
}

export default kebabToCamel;
