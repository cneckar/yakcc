// SPDX-License-Identifier: MIT
// T-A-3: cycle-safe-deep-clone oracle
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
let lodashCloneDeep;
try { lodashCloneDeep = require(join(__dirname, '../../../../node_modules/lodash/cloneDeep.js')); } catch { lodashCloneDeep = null; }
const { cycleSafeDeepClone } = await import(pathToFileURL(join(__dirname, 'fine.mjs')).href);

describe('T-A-3: cycle-safe-deep-clone oracle', () => {
  it('deep clones 20 plain objects', () => {
    for (let i = 0; i < 20; i++) {
      const obj = { a: i, b: { c: i * 2, d: [i, i + 1] }, e: 'str' + i };
      const clone = cycleSafeDeepClone(obj);
      assert.deepStrictEqual(clone, obj);
      clone.b.c = 999;
      assert.strictEqual(obj.b.c, i * 2, 'clone mutation affected original');
    }
  });

  it('handles circular references', () => {
    const obj = { a: 1 };
    obj.self = obj;
    const clone = cycleSafeDeepClone(obj);
    assert.strictEqual(clone.self, clone, 'circular ref not preserved');
    assert.strictEqual(clone.a, 1);
  });

  it('clones Date objects', () => {
    const d = new Date('2024-01-15');
    const clone = cycleSafeDeepClone({ date: d });
    assert.strictEqual(clone.date.getTime(), d.getTime());
    assert.notStrictEqual(clone.date, d, 'Date should be a new instance');
  });

  it('clones primitive values unchanged', () => {
    assert.strictEqual(cycleSafeDeepClone(42), 42);
    assert.strictEqual(cycleSafeDeepClone('hello'), 'hello');
    assert.strictEqual(cycleSafeDeepClone(null), null);
    assert.strictEqual(cycleSafeDeepClone(true), true);
  });
});
