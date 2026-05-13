// bench/B9-min-surface/tasks/csv-row-narrow/arm-a/coarse.mjs
// Arm A-coarse: single broad block for csv-row-narrow.

export function parseCsvRowNarrow(input) {
  for (let i = 0; i < input.length; i++) {
    const code = input.charCodeAt(i);
    if (code > 127) throw new RangeError(`Non-ASCII input`);
    if (code < 32 && code !== 9) throw new SyntaxError(`Control character at position ${i}`);
  }
  const parts = input.split(",");
  if (parts.length !== 3) throw new SyntaxError(`Expected 3 fields, got ${parts.length}`);
  return [parts[0].trim(), parts[1].trim(), parts[2].trim()];
}

export default parseCsvRowNarrow;
