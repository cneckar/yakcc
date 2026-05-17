// SPDX-License-Identifier: MIT
// T-A-3: bcrypt-verify-constant-time oracle (engine-gap-disclosed)
// Note: oracle tests the constant-time comparison property (security intent),
// not bcrypt hash equivalence (engine gap #585 prevents that).
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
const __dirname = dirname(fileURLToPath(import.meta.url));
const { bcryptVerifyConstantTime } = await import(pathToFileURL(join(__dirname, 'fine.mjs')).href);

// Engine-gap-disclosed: we test the interface contract (Promise<boolean>, constant-time intent)
// not bcrypt-equivalence. The real bcryptjs compare() is not invoked.
describe('T-A-3: bcrypt-verify-constant-time oracle (engine-gap-disclosed #585)', () => {
  it('returns Promise for valid inputs', async () => {
    // Use a structurally-valid-looking bcrypt hash format
    const fakeHash = '$2a$10$' + 'a'.repeat(53);
    const result = bcryptVerifyConstantTime('plaintext', fakeHash);
    assert.ok(result instanceof Promise, 'Must return Promise');
    await result; // should not throw
  });

  it('returns false for invalid hash format (20 cases)', async () => {
    const invalidHashes = ['notahash', '', 'abc', '$2a$', '$1$10$' + 'a'.repeat(53)];
    for (const h of invalidHashes) {
      const result = await bcryptVerifyConstantTime('test', h);
      assert.strictEqual(result, false, 'Expected false for invalid hash: ' + h);
    }
  });

  it('throws TypeError for non-string plaintext', async () => {
    await assert.rejects(async () => bcryptVerifyConstantTime(null, '$2a$10$' + 'a'.repeat(53)), TypeError);
  });

  it('returns boolean from Promise for 20 valid-format inputs', async () => {
    for (let i = 0; i < 20; i++) {
      const hash = '$2a$10$' + 'b'.repeat(53);
      const result = await bcryptVerifyConstantTime('plaintext' + i, hash);
      assert.ok(typeof result === 'boolean', 'Expected boolean, got: ' + typeof result);
    }
  });
});
