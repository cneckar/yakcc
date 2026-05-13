// bench/B9-min-surface/tasks/parse-int-list/arm-a/medium.mjs
// Arm A-medium: composite blocks at natural task-component boundary for parse-int-list.

export function validateAsciiAndPrefix(input) {
  for (let i = 0; i < input.length; i++) {
    if (input.charCodeAt(i) > 127) throw new RangeError(`Non-ASCII at position ${i}`);
  }
  if (input[0] !== "[") throw new SyntaxError(`Expected '[', got: ${JSON.stringify(input[0] ?? "EOF")}`);
}

export function parseIntegerList(input, startPos) {
  const results = [];
  let pos = startPos;
  while (pos < input.length && (input[pos] === " " || input[pos] === "\t")) pos++;

  if (input[pos] === "]") return [results, pos + 1];

  // Parse first element
  let end = pos;
  while (end < input.length && input[end] >= "0" && input[end] <= "9") end++;
  if (end === pos) throw new SyntaxError(`Expected digit at position ${pos}`);
  results.push(parseInt(input.slice(pos, end), 10));
  pos = end;

  while (pos < input.length && (input[pos] === " " || input[pos] === "\t")) pos++;

  // Parse remaining elements
  while (pos < input.length && input[pos] === ",") {
    pos++;
    while (pos < input.length && (input[pos] === " " || input[pos] === "\t")) pos++;
    end = pos;
    while (end < input.length && input[end] >= "0" && input[end] <= "9") end++;
    if (end === pos) throw new SyntaxError(`Expected digit at position ${pos}`);
    results.push(parseInt(input.slice(pos, end), 10));
    pos = end;
    while (pos < input.length && (input[pos] === " " || input[pos] === "\t")) pos++;
  }

  if (input[pos] !== "]") throw new SyntaxError(`Expected ']' at position ${pos}`);
  return [results, pos + 1];
}

export function assertEof(input, pos) {
  if (pos < input.length) throw new SyntaxError(`Trailing content at position ${pos}`);
}

export function listOfInts(input) {
  validateAsciiAndPrefix(input);
  const [result, pos] = parseIntegerList(input, 1);
  assertEof(input, pos);
  return result;
}

export default listOfInts;
