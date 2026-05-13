// bench/B9-min-surface/tasks/parse-int-list/arm-a/coarse.mjs
// Arm A-coarse: single broad block per task for parse-int-list.

export function listOfInts(input) {
  for (let i = 0; i < input.length; i++) {
    if (input.charCodeAt(i) > 127) throw new RangeError(`Non-ASCII at position ${i}`);
  }
  if (input[0] !== "[") throw new SyntaxError(`Expected '[' at start`);

  let pos = 1;
  const result = [];

  // Skip leading whitespace
  while (pos < input.length && (input[pos] === " " || input[pos] === "\t")) pos++;

  if (input[pos] === "]") {
    pos++;
  } else {
    let first = true;
    while (pos < input.length && input[pos] !== "]") {
      if (!first) {
        if (input[pos] !== ",") throw new SyntaxError(`Expected ',' at position ${pos}`);
        pos++;
        while (pos < input.length && (input[pos] === " " || input[pos] === "\t")) pos++;
      }
      first = false;
      const start = pos;
      while (pos < input.length && input[pos] >= "0" && input[pos] <= "9") pos++;
      if (pos === start) throw new SyntaxError(`Expected digit at position ${pos}`);
      result.push(parseInt(input.slice(start, pos), 10));
      while (pos < input.length && (input[pos] === " " || input[pos] === "\t")) pos++;
    }
    if (input[pos] !== "]") throw new SyntaxError(`Expected ']' at position ${pos}`);
    pos++;
  }

  if (pos < input.length) throw new SyntaxError(`Trailing content at position ${pos}`);
  return result;
}

export default listOfInts;
