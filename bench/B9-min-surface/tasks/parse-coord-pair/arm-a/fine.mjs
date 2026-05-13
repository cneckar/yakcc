// bench/B9-min-surface/tasks/parse-coord-pair/arm-a/fine.mjs
// Arm A-fine: maximally atomic decomposition for parse-coord-pair.
// Each atom handles exactly one structural concern.
// Used by the Arm A granularity sweep (DEC-V0-MIN-SURFACE-004).

/** Atom: reject any non-ASCII character in input. */
export function nonAsciiRejector(input) {
  for (let i = 0; i < input.length; i++) {
    if (input.charCodeAt(i) > 127) {
      throw new RangeError(`Non-ASCII character at position ${i}: code ${input.charCodeAt(i)}`);
    }
  }
}

/** Atom: assert input starts with '(' */
export function openParen(input, pos) {
  if (input[pos] !== "(") {
    throw new SyntaxError(`Expected '(' at position ${pos}, got: ${JSON.stringify(input[pos] ?? "EOF")}`);
  }
}

/** Atom: parse a non-negative decimal integer starting at pos. Returns [value, nextPos]. */
export function parseUint(input, pos) {
  let end = pos;
  while (end < input.length && input[end] >= "0" && input[end] <= "9") {
    end++;
  }
  if (end === pos) {
    throw new SyntaxError(`Expected non-negative integer at position ${pos}, got: ${JSON.stringify(input[pos] ?? "EOF")}`);
  }
  return [parseInt(input.slice(pos, end), 10), end];
}

/** Atom: assert comma separator. */
export function comma(input, pos) {
  if (input[pos] !== ",") {
    throw new SyntaxError(`Expected ',' at position ${pos}, got: ${JSON.stringify(input[pos] ?? "EOF")}`);
  }
}

/** Atom: assert closing ')'. */
export function closeParen(input, pos) {
  if (input[pos] !== ")") {
    throw new SyntaxError(`Expected ')' at position ${pos}, got: ${JSON.stringify(input[pos] ?? "EOF")}`);
  }
}

/** Atom: assert end-of-input (no trailing characters). */
export function eofCheck(input, pos) {
  if (pos < input.length) {
    throw new SyntaxError(`Unexpected trailing characters at position ${pos}: ${JSON.stringify(input.slice(pos, pos + 10))}`);
  }
}

/** Entry point: compose atoms to parse '(x,y)'. */
export function parseCoordPair(input) {
  nonAsciiRejector(input);
  openParen(input, 0);
  const [x, pos1] = parseUint(input, 1);
  comma(input, pos1);
  const [y, pos2] = parseUint(input, pos1 + 1);
  closeParen(input, pos2);
  eofCheck(input, pos2 + 1);
  return [x, y];
}

export default parseCoordPair;
