// SPDX-License-Identifier: MIT
// T-A-3: semver-range-satisfies oracle
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
let semver;
try { semver = require(join(__dirname, '../../../../node_modules/semver')); } catch { semver = null; }
const { semverRangeSatisfies } = await import(pathToFileURL(join(__dirname, 'fine.mjs')).href);

const CASES = [
  ['1.2.3', '>=1.0.0 <2.0.0', true],
  ['2.0.0', '>=1.0.0 <2.0.0', false],
  ['1.0.0', '1.0.0', true],
  ['1.0.1', '1.0.0', false],
  ['0.9.0', '>=1.0.0', false],
  ['1.5.0', '>=1.0.0 <=2.0.0', true],
  ['3.0.0', '>=1.0.0 <2.0.0 || >=3.0.0', true],
  ['2.5.0', '>=1.0.0 <2.0.0 || >=3.0.0', false],
  ['1.0.0', '*', true],
  ['0.0.1', '!=0.0.1', false],
  ['0.0.2', '!=0.0.1', true],
  ['1.0.0', '>0.9.0', true],
  ['1.0.0', '>1.0.0', false],
  ['1.0.0', '<=1.0.0', true],
  ['1.0.1', '<=1.0.0', false],
  ['2.0.0', '==2.0.0', true],
  ['2.0.1', '==2.0.0', false],
  ['1.2.3', '>=1.0.0', true],
  ['0.1.0', '>=0.0.1', true],
  ['10.0.0', '>=1.0.0 <2.0.0 || >=10.0.0', true],
];

describe('T-A-3: semver-range-satisfies oracle', () => {
  it('arm-a produces correct results for 20 version/range pairs', () => {
    for (const [ver, range, expected] of CASES) {
      const armA = semverRangeSatisfies(ver, range);
      assert.strictEqual(armA, expected, 'Failed for ' + ver + ' ' + range + ': expected ' + expected + ' got ' + armA);
    }
  });

  if (semver) {
    it('matches semver.satisfies for all test cases', () => {
      for (const [ver, range] of CASES) {
        const real = semver.satisfies(ver, range);
        const armA = semverRangeSatisfies(ver, range);
        assert.strictEqual(armA, real, 'Mismatch vs semver.satisfies for ' + ver + ' ' + range);
      }
    });
  }
});
