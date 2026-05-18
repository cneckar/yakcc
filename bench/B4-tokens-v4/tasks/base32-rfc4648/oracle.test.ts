// SPDX-License-Identifier: MIT
//
// bench/B4-tokens-v4/tasks/base32-rfc4648/oracle.test.ts
//
// Oracle tests for the base32-rfc4648 task (B4-v4).
// RFC 4648 §10 test vectors included.

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

let Base32Codec: new () => { encode(b: Uint8Array): string; decode(s: string): Uint8Array };

beforeEach(async () => {
  const mod = await import(/* @vite-ignore */ implUrl);
  Base32Codec = mod.Base32Codec;
  if (typeof Base32Codec !== 'function') {
    throw new Error(`Implementation must export Base32Codec as a named class`);
  }
});

function ascii(s: string): Uint8Array {
  return new Uint8Array([...s].map((c) => c.charCodeAt(0)));
}

describe('base32-rfc4648 — RFC 4648 §10 test vectors', () => {
  // https://www.rfc-editor.org/rfc/rfc4648#section-10
  it('encode("") = ""', () => {
    expect(new Base32Codec().encode(new Uint8Array(0))).toBe('');
  });
  it('encode("f") = "MY======"', () => {
    expect(new Base32Codec().encode(ascii('f'))).toBe('MY======');
  });
  it('encode("fo") = "MZXQ===="', () => {
    expect(new Base32Codec().encode(ascii('fo'))).toBe('MZXQ====');
  });
  it('encode("foo") = "MZXW6==="', () => {
    expect(new Base32Codec().encode(ascii('foo'))).toBe('MZXW6===');
  });
  it('encode("foob") = "MZXW6YQ="', () => {
    expect(new Base32Codec().encode(ascii('foob'))).toBe('MZXW6YQ=');
  });
  it('encode("fooba") = "MZXW6YTB"', () => {
    expect(new Base32Codec().encode(ascii('fooba'))).toBe('MZXW6YTB');
  });
  it('encode("foobar") = "MZXW6YTBOI======"', () => {
    expect(new Base32Codec().encode(ascii('foobar'))).toBe('MZXW6YTBOI======');
  });
});

describe('base32-rfc4648 — uses A-Z2-7 alphabet, NOT base32hex (0-9A-V)', () => {
  it('output alphabet contains only A-Z and 2-7', () => {
    // Single byte 0xFF should produce 8 chars from the standard alphabet
    const c = new Base32Codec();
    const out = c.encode(new Uint8Array([0xFF])).replace(/=/g, '');
    expect(out).toMatch(/^[A-Z2-7]+$/);
  });

  it('"f" encodes to MY====== (NOT 0V====== from base32hex)', () => {
    const c = new Base32Codec();
    expect(c.encode(ascii('f'))).toBe('MY======');
    expect(c.encode(ascii('f'))).not.toBe('0V======');
  });
});

describe('base32-rfc4648 — decode: RFC 4648 §10 test vectors', () => {
  it('decode("") = []', () => {
    expect(new Base32Codec().decode('')).toEqual(new Uint8Array(0));
  });
  it('decode("MY======") = "f"', () => {
    expect(new Base32Codec().decode('MY======')).toEqual(ascii('f'));
  });
  it('decode("MZXQ====") = "fo"', () => {
    expect(new Base32Codec().decode('MZXQ====')).toEqual(ascii('fo'));
  });
  it('decode("MZXW6===") = "foo"', () => {
    expect(new Base32Codec().decode('MZXW6===')).toEqual(ascii('foo'));
  });
  it('decode("MZXW6YQ=") = "foob"', () => {
    expect(new Base32Codec().decode('MZXW6YQ=')).toEqual(ascii('foob'));
  });
  it('decode("MZXW6YTB") = "fooba"', () => {
    expect(new Base32Codec().decode('MZXW6YTB')).toEqual(ascii('fooba'));
  });
  it('decode("MZXW6YTBOI======") = "foobar"', () => {
    expect(new Base32Codec().decode('MZXW6YTBOI======')).toEqual(ascii('foobar'));
  });
});

describe('base32-rfc4648 — case-insensitive decode', () => {
  it('lowercase input decodes correctly', () => {
    expect(new Base32Codec().decode('mzxw6ytb')).toEqual(ascii('fooba'));
  });
  it('mixed-case input decodes correctly', () => {
    expect(new Base32Codec().decode('MzXw6yTb')).toEqual(ascii('fooba'));
  });
});

describe('base32-rfc4648 — round-trip', () => {
  it('round-trips 32 random bytes', () => {
    const data = new Uint8Array(32).fill(0).map((_, i) => (i * 37 + 11) & 0xFF);
    const c = new Base32Codec();
    expect(c.decode(c.encode(data))).toEqual(data);
  });

  it('round-trips all 256 byte values', () => {
    const data = new Uint8Array(256).map((_, i) => i);
    const c = new Base32Codec();
    expect(c.decode(c.encode(data))).toEqual(data);
  });
});

describe('base32-rfc4648 — error cases', () => {
  it('throws TypeError for invalid character "8"', () => {
    expect(() => new Base32Codec().decode('MY888888')).toThrow(TypeError);
  });
  it('throws TypeError for invalid character "1"', () => {
    expect(() => new Base32Codec().decode('MY111111')).toThrow(TypeError);
  });
  it('throws TypeError for invalid character "0" (zero, not O)', () => {
    expect(() => new Base32Codec().decode('MY000000')).toThrow(TypeError);
  });
  it('throws TypeError for impossible length 1 (mod 8 = 1)', () => {
    expect(() => new Base32Codec().decode('M')).toThrow(TypeError);
  });
  it('throws TypeError for impossible length 3 (mod 8 = 3)', () => {
    expect(() => new Base32Codec().decode('MZX')).toThrow(TypeError);
  });
  it('throws TypeError for impossible length 6 (mod 8 = 6)', () => {
    expect(() => new Base32Codec().decode('MZXW6Y')).toThrow(TypeError);
  });
});

describe('base32-rfc4648 — output is uppercase', () => {
  it('encode output is all uppercase', () => {
    const c = new Base32Codec();
    const out = c.encode(ascii('Hello World'));
    expect(out).toBe(out.toUpperCase());
  });
});
