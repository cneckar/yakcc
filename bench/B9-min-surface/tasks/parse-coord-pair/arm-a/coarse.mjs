// bench/B9-min-surface/tasks/parse-coord-pair/arm-a/coarse.mjs
// Arm A-coarse: single broad block per task. Minimal decomposition.

export function parseCoordPair(input) {
  for (let i = 0; i < input.length; i++) {
    if (input.charCodeAt(i) > 127) throw new RangeError(`Non-ASCII at position ${i}`);
  }
  if (!input.startsWith("(")) throw new SyntaxError("Expected input to start with '('");
  if (!input.endsWith(")")) throw new SyntaxError("Expected input to end with ')'");
  const inner = input.slice(1, -1);
  const commaIdx = inner.indexOf(",");
  if (commaIdx === -1) throw new SyntaxError("Expected ',' separator between coordinates");
  const xStr = inner.slice(0, commaIdx);
  const yStr = inner.slice(commaIdx + 1);
  if (!/^\d+$/.test(xStr)) throw new SyntaxError(`Invalid x coordinate: ${JSON.stringify(xStr)}`);
  if (!/^\d+$/.test(yStr)) throw new SyntaxError(`Invalid y coordinate: ${JSON.stringify(yStr)}`);
  return [parseInt(xStr, 10), parseInt(yStr, 10)];
}

export default parseCoordPair;
