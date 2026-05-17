// SPDX-License-Identifier: MIT
// T-A-3: format-iso-date oracle
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
const __dirname = dirname(fileURLToPath(import.meta.url));
const { formatIsoDate } = await import(pathToFileURL(join(__dirname, 'fine.mjs')).href);

// Test dates at various offsets
const TEST_DATES = Array.from({ length: 20 }, (_, i) => new Date(Date.UTC(2024, 0, i + 1, 10, 30, 0)));

describe('T-A-3: format-iso-date oracle', () => {
  it('formats 20 dates producing ISO 8601 strings', () => {
    for (const d of TEST_DATES) {
      const result = formatIsoDate(d);
      assert.ok(typeof result === 'string', 'Expected string');
      assert.ok(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/.test(result),
        'Expected ISO 8601 format, got: ' + result);
      // Cross-check: parse the output and verify timestamp matches
      const roundtrip = new Date(result);
      assert.strictEqual(roundtrip.getTime(), d.getTime(), 'Roundtrip mismatch for: ' + d.toISOString());
    }
  });

  it('throws on invalid date', () => {
    assert.throws(() => formatIsoDate(new Date(NaN)), /Invalid date/);
  });
});
