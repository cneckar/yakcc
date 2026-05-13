// bench/B9-min-surface/tasks/parse-coord-pair/arm-a/medium.mjs
// Arm A-medium: composite blocks at natural task-component boundary.
// Combines related atoms into composite helpers.

/** Composite: validate ASCII and opening paren as one block. */
export function validatePrefix(input) {
  for (let i = 0; i < input.length; i++) {
    if (input.charCodeAt(i) > 127) {
      throw new RangeError(`Non-ASCII character at position ${i}`);
    }
  }
  if (input[0] !== "(") {
    throw new SyntaxError(`Expected '(' at position 0, got: ${JSON.stringify(input[0] ?? "EOF")}`);
  }
}

/** Composite: parse both coordinates and the comma between them. Returns [x, y, endPos]. */
export function parseCoordinates(input, startPos) {
  let pos = startPos;
  let xEnd = pos;
  while (xEnd < input.length && input[xEnd] >= "0" && input[xEnd] <= "9") xEnd++;
  if (xEnd === pos) throw new SyntaxError(`Expected x coordinate at position ${pos}`);
  const x = parseInt(input.slice(pos, xEnd), 10);

  if (input[xEnd] !== ",") throw new SyntaxError(`Expected ',' at position ${xEnd}`);

  pos = xEnd + 1;
  let yEnd = pos;
  while (yEnd < input.length && input[yEnd] >= "0" && input[yEnd] <= "9") yEnd++;
  if (yEnd === pos) throw new SyntaxError(`Expected y coordinate at position ${pos}`);
  const y = parseInt(input.slice(pos, yEnd), 10);

  return [x, y, yEnd];
}

/** Composite: validate closing paren and EOF. */
export function validateSuffix(input, pos) {
  if (input[pos] !== ")") throw new SyntaxError(`Expected ')' at position ${pos}`);
  if (pos + 1 < input.length) throw new SyntaxError(`Trailing characters at position ${pos + 1}`);
}

export function parseCoordPair(input) {
  validatePrefix(input);
  const [x, y, endPos] = parseCoordinates(input, 1);
  validateSuffix(input, endPos);
  return [x, y];
}

export default parseCoordPair;
