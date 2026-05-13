// bench/B9-min-surface/tasks/kebab-to-camel/arm-a/coarse.mjs
// Arm A-coarse: single broad block for kebab-to-camel.

export function kebabToCamel(input) {
  if (!input || !/^[a-z]+(-[a-z]+)*$/.test(input)) {
    if (!input) throw new SyntaxError("Input must not be empty");
    throw new SyntaxError(`Invalid kebab-case input: ${JSON.stringify(input.slice(0, 20))}`);
  }
  return input.split("-").reduce((acc, part, i) =>
    i === 0 ? part : acc + part[0].toUpperCase() + part.slice(1), "");
}

export default kebabToCamel;
