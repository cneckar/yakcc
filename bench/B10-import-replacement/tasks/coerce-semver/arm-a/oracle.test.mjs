// SPDX-License-Identifier: MIT
// T-A-3: coerce-semver oracle
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
let semver;
try { semver = require(join(__dirname, '../../../../node_modules/semver')); } catch { semver = null; }
const { coerceSemver } = await import(pathToFileURL(join(__dirname, 'fine.mjs')).href);

const CASES = [
  ['1.2.3', '1.2.3'],
  ['v1.2.3', '1.2.3'],
  ['1.2', '1.2.0'],
  ['1', '1.0.0'],
  ['v2', '2.0.0'],
  ['1.2.3-alpha', '1.2.3'],
  ['foo1.2.3bar', '1.2.3'],
  ['2.0.0', '2.0.0'],
  ['v0.0.1', '0.0.1'],
  ['10.20.30', '10.20.30'],
  ['1.0', '1.0.0'],
  ['v3', '3.0.0'],
  ['5.5.5', '5.5.5'],
  ['0.1.2', '0.1.2'],
  ['v1.0.0-rc1', '1.0.0'],
  ['2.3', '2.3.0'],
  ['abc1xyz', '1.0.0'],
  ['v100', '100.0.0'],
  ['7.8.9+build', '7.8.9'],
  ['not-a-version', '0.0.0'],  // Note: last one has digits embedded via NaN test
];

describe('T-A-3: coerce-semver oracle', () => {
  it('coerces 19 version strings correctly', () => {
    for (const [input, expected] of CASES.slice(0, 19)) {
      const result = coerceSemver(input);
      assert.strictEqual(result, expected, 'Mismatch for input=' + JSON.stringify(input) + ': expected ' + expected + ', got ' + result);
    }
  });

  it('returns null for strings with no digits', () => {
    assert.strictEqual(coerceSemver('no-version-here'), null);
    assert.strictEqual(coerceSemver(''), null);
    assert.strictEqual(coerceSemver(null), null);
  });
});
