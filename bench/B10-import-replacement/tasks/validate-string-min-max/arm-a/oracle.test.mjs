// SPDX-License-Identifier: MIT
// T-A-3: validate-string-min-max oracle (engine-gap-disclosed)
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
let z;
try { z = require(join(__dirname, '../../../../node_modules/zod')).z; } catch {
  try { z = require(join(__dirname, '../../../../node_modules/zod')); } catch { z = null; }
}
const { validateStringMinMax } = await import(pathToFileURL(join(__dirname, 'fine.mjs')).href);

describe('T-A-3: validate-string-min-max oracle (engine-gap-disclosed #619+#576)', () => {
  it('validates 20 string inputs with min/max bounds', () => {
    const cases = [
      ['hello', 1, 10, true],
      ['hi', 3, 10, false],
      ['hello world!', 1, 10, false],
      ['ok', 1, 5, true],
      ['', 0, 5, true],
      ['', 1, 5, false],
      ['abcde', 5, 5, true],
      ['abcdef', 5, 5, false],
      ['abc', 3, 100, true],
      ['a'.repeat(100), 1, 50, false],
      ['a'.repeat(50), 1, 50, true],
      ['test', 4, 4, true],
      ['test!', 4, 4, false],
      ['x', 1, 1, true],
      ['xy', 1, 1, false],
      ['hello', 0, 100, true],
      ['', 0, 0, true],
      ['a', 0, 0, false],
      ['abc', 2, 5, true],
      ['abcdef', 2, 5, false],
    ];
    for (const [input, min, max, expected] of cases) {
      const result = validateStringMinMax(input, min, max);
      assert.strictEqual(result.success, expected, 'Mismatch for input=' + JSON.stringify(input) + ' min=' + min + ' max=' + max);
    }
  });

  it('returns success=false for non-string input', () => {
    assert.strictEqual(validateStringMinMax(42, 0, 10).success, false);
    assert.strictEqual(validateStringMinMax(null, 0, 10).success, false);
    assert.strictEqual(validateStringMinMax(undefined, 0, 10).success, false);
  });
});
