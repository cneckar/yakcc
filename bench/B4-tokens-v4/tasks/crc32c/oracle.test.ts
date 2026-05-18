// SPDX-License-Identifier: MIT
//
// bench/B4-tokens-v4/tasks/crc32c/oracle.test.ts
//
// Oracle tests for the crc32c task (B4-v4).
// Tests are deterministic and hand-authored per DEC-BENCH-METHODOLOGY-NEVER-SYNTHETIC-001.
// Load implementation via IMPL_PATH env var (defaults to reference-impl.ts).

import { describe, it, expect, beforeEach } from 'vitest';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const implPath = process.env['IMPL_PATH']
  ? resolve(process.env['IMPL_PATH'])
  : resolve(__dirname, 'reference-impl.ts');
const implUrl = pathToFileURL(implPath).href;

let CRC32C: new () => {
  update(data: Uint8Array | string): { update: unknown; digest: () => number; reset: () => void; clone: () => unknown };
  digest(): number;
  reset(): void;
  clone(): unknown;
};

beforeEach(async () => {
  const mod = await import(/* @vite-ignore */ implUrl);
  CRC32C = mod.CRC32C;
  if (typeof CRC32C !== 'function') {
    throw new Error(`Implementation at ${implPath} must export CRC32C as a named class`);
  }
});

describe('crc32c — standard test vector', () => {
  it('produces 0xE3069283 for "123456789"', () => {
    const crc = new CRC32C();
    crc.update('123456789');
    expect(crc.digest()).toBe(0xE3069283);
  });

  it('produces 0xE3069283 as decimal 3808858755', () => {
    const crc = new CRC32C();
    crc.update('123456789');
    expect(crc.digest()).toBe(3808858755);
  });
});

describe('crc32c — empty input', () => {
  it('empty string produces 0x00000000', () => {
    const crc = new CRC32C();
    crc.update('');
    expect(crc.digest()).toBe(0x00000000);
  });

  it('empty Uint8Array produces 0x00000000', () => {
    const crc = new CRC32C();
    crc.update(new Uint8Array(0));
    expect(crc.digest()).toBe(0x00000000);
  });
});

describe('crc32c — incremental vs single-pass', () => {
  it('splitting input produces same result as single update', () => {
    const single = new CRC32C();
    single.update('hello world');
    const expected = single.digest();

    const incremental = new CRC32C();
    incremental.update('hello');
    incremental.update(' ');
    incremental.update('world');
    expect(incremental.digest()).toBe(expected);
  });

  it('byte-by-byte matches single-pass for "abc"', () => {
    const single = new CRC32C();
    single.update('abc');
    const expected = single.digest();

    const byByte = new CRC32C();
    for (const b of new TextEncoder().encode('abc')) {
      byByte.update(new Uint8Array([b]));
    }
    expect(byByte.digest()).toBe(expected);
  });
});

describe('crc32c — uses Castagnoli polynomial (NOT CRC-32)', () => {
  it('"hello" CRC-32C = 0x9A71BB4C, NOT CRC-32 0x3610A686', () => {
    const crc = new CRC32C();
    crc.update('hello');
    // CRC-32C value
    expect(crc.digest()).toBe(0x9A71BB4C);
    // Must NOT be the CRC-32 (Ethernet) value
    expect(crc.digest()).not.toBe(0x3610A686);
  });

  it('"The quick brown fox" CRC-32C value', () => {
    const crc = new CRC32C();
    crc.update('The quick brown fox');
    expect(crc.digest()).toBe(0x537E5CF4);
  });
});

describe('crc32c — digest() does not mutate state', () => {
  it('calling digest() twice returns same value', () => {
    const crc = new CRC32C();
    crc.update('test data');
    const a = crc.digest();
    const b = crc.digest();
    expect(a).toBe(b);
  });

  it('can continue updating after digest()', () => {
    const crc1 = new CRC32C();
    crc1.update('hello');
    crc1.digest(); // should not mutate
    crc1.update(' world');
    const after = crc1.digest();

    const crc2 = new CRC32C();
    crc2.update('hello world');
    expect(after).toBe(crc2.digest());
  });
});

describe('crc32c — reset()', () => {
  it('reset() restores fresh state', () => {
    const crc = new CRC32C();
    crc.update('some data');
    crc.reset();
    crc.update('123456789');
    expect(crc.digest()).toBe(0xE3069283);
  });

  it('empty digest after reset equals empty digest on fresh instance', () => {
    const fresh = new CRC32C();
    fresh.update('');
    const crc = new CRC32C();
    crc.update('something');
    crc.reset();
    crc.update('');
    expect(crc.digest()).toBe(fresh.digest());
  });
});

describe('crc32c — clone()', () => {
  it('clone produces independent copy with same state', () => {
    const crc = new CRC32C();
    crc.update('hello');
    const cloned = crc.clone() as typeof crc;
    expect(cloned.digest()).toBe(crc.digest());
  });

  it('mutating original does not affect clone', () => {
    const crc = new CRC32C();
    crc.update('hello');
    const cloned = crc.clone() as typeof crc;
    crc.update(' world');
    expect(cloned.digest()).not.toBe(crc.digest());
  });

  it('mutating clone does not affect original', () => {
    const crc = new CRC32C();
    crc.update('hello');
    const originalDigest = crc.digest();
    const cloned = crc.clone() as typeof crc;
    cloned.update(' world');
    expect(crc.digest()).toBe(originalDigest);
  });
});

describe('crc32c — string vs Uint8Array equivalence', () => {
  it('update("abc") equals update(encode("abc"))', () => {
    const fromString = new CRC32C();
    fromString.update('abc');

    const fromBytes = new CRC32C();
    fromBytes.update(new TextEncoder().encode('abc'));

    expect(fromString.digest()).toBe(fromBytes.digest());
  });
});

describe('crc32c — return type is unsigned 32-bit', () => {
  it('digest() returns a non-negative number', () => {
    const crc = new CRC32C();
    crc.update('test');
    const result = crc.digest();
    expect(result).toBeGreaterThanOrEqual(0);
    expect(result).toBeLessThanOrEqual(0xFFFFFFFF);
  });
});
