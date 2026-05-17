// SPDX-License-Identifier: MIT
// T-A-3: debounce-with-flush-cancel oracle
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
const __dirname = dirname(fileURLToPath(import.meta.url));
const { debounceWithFlushCancel } = await import(pathToFileURL(join(__dirname, 'fine.mjs')).href);

describe('T-A-3: debounce-with-flush-cancel oracle', () => {
  it('debounced function has flush and cancel methods', () => {
    const debounced = debounceWithFlushCancel(() => {}, 100);
    assert.ok(typeof debounced.flush === 'function', 'Expected flush method');
    assert.ok(typeof debounced.cancel === 'function', 'Expected cancel method');
  });

  it('flush invokes the function immediately (20 calls)', () => {
    for (let i = 0; i < 20; i++) {
      let called = 0;
      const debounced = debounceWithFlushCancel(() => { called++; }, 1000);
      debounced('arg' + i);
      debounced.flush();
      assert.strictEqual(called, 1, 'Expected fn called once after flush, got: ' + called);
    }
  });

  it('cancel prevents invocation', async () => {
    let called = 0;
    const debounced = debounceWithFlushCancel(() => { called++; }, 50);
    debounced();
    debounced.cancel();
    await new Promise((r) => setTimeout(r, 100));
    assert.strictEqual(called, 0, 'Expected fn not called after cancel');
  });

  it('flush returns function result', () => {
    const debounced = debounceWithFlushCancel((x) => x * 2, 1000);
    debounced(21);
    const result = debounced.flush();
    assert.strictEqual(result, 42);
  });
});
