// bench/B9-min-surface/tasks/csv-row-narrow/arm-a/medium.mjs
// Arm A-medium: composite blocks for csv-row-narrow.

export function validateInputCharacters(input) {
  for (let i = 0; i < input.length; i++) {
    const code = input.charCodeAt(i);
    if (code > 127) throw new RangeError(`Non-ASCII character at position ${i}`);
    if (code < 32 && code !== 9) throw new SyntaxError(`Control character at position ${i}`);
  }
}

export function splitAndValidateFields(input) {
  const parts = input.split(",");
  if (parts.length !== 3) {
    throw new SyntaxError(`Expected exactly 3 comma-separated fields, got ${parts.length}`);
  }
  return [parts[0].trim(), parts[1].trim(), parts[2].trim()];
}

export function parseCsvRowNarrow(input) {
  validateInputCharacters(input);
  return splitAndValidateFields(input);
}

export default parseCsvRowNarrow;
