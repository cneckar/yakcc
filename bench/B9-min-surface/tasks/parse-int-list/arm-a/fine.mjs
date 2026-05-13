// bench/B9-min-surface/tasks/parse-int-list/arm-a/fine.mjs
// Arm A-fine for parse-int-list: mirrors the yakcc compile pipeline's atomic emit.
// Each atom handles exactly one structural concern.
// Used by the Arm A granularity sweep (DEC-V0-MIN-SURFACE-004).
// NOTE: The "gold standard" A-fine emit is examples/parse-int-list/dist/module.ts
// (produced by `yakcc compile`). This file provides an equivalent reference for
// the harness when the compiled emit is not available (e.g., CI without build step).

export function nonAsciiRejector(input) {
  for (let i = 0; i < input.length; i++) {
    if (input.charCodeAt(i) > 127) {
      throw new RangeError(`Non-ASCII character at position ${i}: code ${input.charCodeAt(i)}`);
    }
  }
}

export function bracket(input, pos) {
  if (input[pos] !== "[") {
    throw new SyntaxError(`Expected '[' at position ${pos}, got: ${JSON.stringify(input[pos] ?? "EOF")}`);
  }
  return pos + 1;
}

export function optionalWhitespace(input, pos) {
  while (pos < input.length && (input[pos] === " " || input[pos] === "\t")) pos++;
  return pos;
}

export function peekChar(input, pos) {
  return pos < input.length ? input[pos] : null;
}

export function emptyListContent(input, pos) {
  // Handles the case where the next char is ']' (empty list)
  if (input[pos] !== "]") throw new SyntaxError(`Expected ']' for empty list at position ${pos}`);
  return pos + 1;
}

export function parseDigits(input, pos) {
  let end = pos;
  while (end < input.length && input[end] >= "0" && input[end] <= "9") end++;
  if (end === pos) {
    throw new SyntaxError(`Expected digit at position ${pos}, got: ${JSON.stringify(input[pos] ?? "EOF")}`);
  }
  return [parseInt(input.slice(pos, end), 10), end];
}

export function nonemptyListContent(input, pos) {
  const results = [];
  pos = optionalWhitespace(input, pos);
  const [first, afterFirst] = parseDigits(input, pos);
  results.push(first);
  pos = optionalWhitespace(input, afterFirst);

  while (pos < input.length && input[pos] === ",") {
    pos++; // consume comma
    pos = optionalWhitespace(input, pos);
    const [n, afterN] = parseDigits(input, pos);
    results.push(n);
    pos = optionalWhitespace(input, afterN);
  }

  if (input[pos] !== "]") {
    throw new SyntaxError(`Expected ']' at position ${pos}, got: ${JSON.stringify(input[pos] ?? "EOF")}`);
  }
  return [results, pos + 1];
}

export function eofCheck(input, pos) {
  if (pos < input.length) {
    throw new SyntaxError(`Unexpected trailing content at position ${pos}: ${JSON.stringify(input.slice(pos, pos + 10))}`);
  }
}

export function listOfInts(input) {
  nonAsciiRejector(input);
  let pos = bracket(input, 0);
  pos = optionalWhitespace(input, pos);
  const ch = peekChar(input, pos);
  if (ch === null) throw new SyntaxError("Unexpected end of input after '['");
  let result;
  if (ch === "]") {
    pos = emptyListContent(input, pos);
    result = [];
  } else {
    [result, pos] = nonemptyListContent(input, pos);
  }
  eofCheck(input, pos);
  return result;
}

export default listOfInts;
