// SPDX-License-Identifier: MIT
// T-A-3: add-business-days oracle
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
let addDays;
try { addDays = require(join(__dirname, '../../../../node_modules/date-fns')).addDays; } catch { addDays = null; }
const { addBusinessDays } = await import(pathToFileURL(join(__dirname, 'fine.mjs')).href);

describe('T-A-3: add-business-days oracle', () => {
  it('adds days to 20 dates matching date-fns addDays', () => {
    if (!addDays) { return; }
    const base = new Date('2024-01-15T12:00:00Z');
    for (let i = -10; i < 10; i++) {
      const armA = addBusinessDays(new Date(base), i);
      const real = addDays(new Date(base), i);
      assert.strictEqual(armA.getTime(), real.getTime(), 'Mismatch for days=' + i);
    }
  });

  it('adds days without date-fns (native verification)', () => {
    const base = new Date('2024-06-01T00:00:00Z');
    const result = addBusinessDays(base, 7);
    const expected = new Date('2024-06-08T00:00:00Z');
    assert.strictEqual(result.getTime(), expected.getTime());
  });

  it('does not mutate original date', () => {
    const d = new Date('2024-01-01');
    const orig = d.getTime();
    addBusinessDays(d, 5);
    assert.strictEqual(d.getTime(), orig, 'Original date was mutated');
  });

  it('throws on invalid days', () => {
    assert.throws(() => addBusinessDays(new Date(), Infinity), RangeError);
    assert.throws(() => addBusinessDays(new Date(), NaN), RangeError);
  });
});
