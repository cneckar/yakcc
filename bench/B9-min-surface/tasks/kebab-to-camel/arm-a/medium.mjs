// bench/B9-min-surface/tasks/kebab-to-camel/arm-a/medium.mjs
// Arm A-medium: composite validation + transform for kebab-to-camel.

export function validateKebabCase(input) {
  if (input.length === 0) throw new SyntaxError("Input must not be empty");
  if (!/^[a-z]+(-[a-z]+)*$/.test(input)) {
    if (input[0] === "-") throw new SyntaxError("Must not start with hyphen");
    if (input[input.length - 1] === "-") throw new SyntaxError("Must not end with hyphen");
    if (/--/.test(input)) throw new SyntaxError("Consecutive hyphens not allowed");
    throw new SyntaxError(`Invalid kebab-case: only lowercase a-z and single hyphens allowed`);
  }
}

export function convertToCamel(input) {
  const parts = input.split("-");
  return parts[0] + parts.slice(1).map(p => p[0].toUpperCase() + p.slice(1)).join("");
}

export function kebabToCamel(input) {
  validateKebabCase(input);
  return convertToCamel(input);
}

export default kebabToCamel;
