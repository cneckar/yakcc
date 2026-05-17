// SPDX-License-Identifier: MIT
// T-A-3: nanoid-generate oracle
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
const __dirname = dirname(fileURLToPath(import.meta.url));
const { nanoidGenerate } = await import(pathToFileURL(join(__dirname, 'fine.mjs')).href);

const NANOID_RE = /^[a-zA-Z0-9_-]+$/;

describe('T-A-3: nanoid-generate oracle', () => {
  it('generates 20 IDs with default size 21', () => {
    for (let i = 0; i < 20; i++) {
      const id = nanoidGenerate(undefined);
      assert.strictEqual(id.length, 21, 'Expected length 21, got: ' + id.length);
      assert.ok(NANOID_RE.test(id), 'ID has non-URL-safe chars: ' + id);
    }
  });

  it('generates IDs with custom sizes', () => {
    for (const size of [5, 10, 15, 21, 32, 64]) {
      const id = nanoidGenerate(size);
      assert.strictEqual(id.length, size, 'Expected length ' + size + ', got: ' + id.length);
      assert.ok(NANOID_RE.test(id), 'ID has non-URL-safe chars: ' + id);
    }
  });

  it('generates unique IDs (20 samples)', () => {
    const ids = new Set(Array.from({ length: 20 }, () => nanoidGenerate(21)));
    assert.strictEqual(ids.size, 20, 'Generated duplicate IDs');
  });

  it('throws on invalid size', () => {
    assert.throws(() => nanoidGenerate(0), RangeError);
    assert.throws(() => nanoidGenerate(-1), RangeError);
  });
});
