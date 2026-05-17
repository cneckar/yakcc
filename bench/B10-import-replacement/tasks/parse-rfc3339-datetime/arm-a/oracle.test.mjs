// SPDX-License-Identifier: MIT
// T-A-3: parse-rfc3339-datetime oracle
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
const __dirname = dirname(fileURLToPath(import.meta.url));
const { parseRfc3339Datetime } = await import(pathToFileURL(join(__dirname, 'fine.mjs')).href);

const TEST_STRINGS = [
  '2024-01-15T10:30:00Z',
  '2024-06-01T00:00:00Z',
  '2023-12-31T23:59:59Z',
  '2024-03-15T14:30:00+05:30',
  '2024-01-01T00:00:00-08:00',
  '2024-07-04',
  '2024-01-15T10:30:00.500Z',
  '2024-01-15T10:30:00.100Z',
  '2024-01-15T00:00:00+00:00',
  '2024-11-30T15:45:30Z',
  '2024-09-15T08:00:00+02:00',
  '2024-04-01T12:00:00-05:00',
  '2024-08-20',
  '2024-10-10T10:10:10.999Z',
  '2024-05-05T05:05:05Z',
  '2024-02-28T23:59:59Z',
  '2024-12-25T00:00:00Z',
  '2024-01-31T12:30:00+01:00',
  '2024-03-20T18:00:00-03:30',
  '2024-07-15T06:30:00Z',
];

describe('T-A-3: parse-rfc3339-datetime oracle', () => {
  it('parses 20 ISO date strings matching native Date', () => {
    for (const s of TEST_STRINGS) {
      const result = parseRfc3339Datetime(s);
      assert.ok(result instanceof Date, 'Expected Date for: ' + s);
      assert.ok(!isNaN(result.getTime()), 'Expected valid Date for: ' + s);
      const nativeTime = new Date(s).getTime();
      assert.strictEqual(result.getTime(), nativeTime, 'Mismatch for: ' + s);
    }
  });
});
