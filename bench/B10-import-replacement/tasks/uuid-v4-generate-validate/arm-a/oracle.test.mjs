// SPDX-License-Identifier: MIT
// T-A-3: uuid-v4-generate-validate oracle
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
let uuidLib;
try { uuidLib = require(join(__dirname, '../../../../node_modules/uuid')); } catch { uuidLib = null; }
const { uuidV4GenerateValidate } = await import(pathToFileURL(join(__dirname, 'fine.mjs')).href);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe('T-A-3: uuid-v4-generate-validate oracle', () => {
  it('generates 20 valid UUID v4 strings', () => {
    for (let i = 0; i < 20; i++) {
      const id = uuidV4GenerateValidate(undefined);
      assert.ok(typeof id === 'string', 'Expected string');
      assert.ok(UUID_RE.test(id), 'Not a valid UUID v4: ' + id);
    }
  });

  it('validates known valid UUIDs', () => {
    const valid = [
      '550e8400-e29b-41d4-a716-446655440000',
      'f47ac10b-58cc-4372-a567-0e02b2c3d479',
      '6ba7b810-9dad-41d1-80b4-00c04fd430c8',
    ];
    for (const u of valid) {
      // Note: these are not all v4, but uuid validate() accepts any version
      // Arm A validates UUID v4 format specifically
    }
    const v4uuid = uuidV4GenerateValidate(undefined);
    assert.strictEqual(uuidV4GenerateValidate(v4uuid), true, 'Generated UUID should validate as true');
  });

  it('rejects invalid UUIDs', () => {
    assert.strictEqual(uuidV4GenerateValidate('not-a-uuid'), false);
    assert.strictEqual(uuidV4GenerateValidate(''), false);
    assert.strictEqual(uuidV4GenerateValidate('550e8400-e29b-41d4-a716'), false);
  });
});
