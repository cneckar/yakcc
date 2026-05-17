// bench/B9-min-surface/tasks/csv-row-narrow/arm-a/fine.mjs
// Arm A-fine: maximally atomic decomposition for csv-row-narrow.

export function nonAsciiRejector(input) {
  for (let i = 0; i < input.length; i++) {
    const code = input.charCodeAt(i);
    if (code > 127) throw new RangeError(`Non-ASCII character at position ${i}: code ${code}`);
  }
}

export function controlCharRejector(input) {
  for (let i = 0; i < input.length; i++) {
    const code = input.charCodeAt(i);
    // @decision DEC-WI-637-001: Reject all control chars (code < 32) including tab,
    // per spec.yak ("Input contains control characters (code < 32)") and arm-b reference.
    if (code < 32) throw new SyntaxError(`Control character at position ${i}: code ${code}`);
  }
}

export function countCommas(input) {
  let count = 0;
  for (let i = 0; i < input.length; i++) {
    if (input[i] === ",") count++;
  }
  return count;
}

export function splitFields(input) {
  const commaCount = countCommas(input);
  if (commaCount !== 2) {
    throw new SyntaxError(`Expected exactly 2 commas (3 fields), got ${commaCount} commas`);
  }
  const parts = input.split(",");
  return [parts[0].trim(), parts[1].trim(), parts[2].trim()];
}

export function parseCsvRowNarrow(input) {
  nonAsciiRejector(input);
  controlCharRejector(input);
  return splitFields(input);
}

export default parseCsvRowNarrow;
