// SPDX-License-Identifier: MIT
//
// bench/B4-tokens-v3/tasks/pkce-code-verifier/oracle.test.ts
//
// Oracle tests for the pkce-code-verifier task (B4-v3).
// Tests are deterministic and hand-authored per DEC-BENCH-METHODOLOGY-NEVER-SYNTHETIC-001.
// Load implementation via IMPL_PATH env var (defaults to reference-impl.ts).

import { beforeEach, describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const implPath = process.env['IMPL_PATH']
  ? resolve(process.env['IMPL_PATH'])
  : resolve(__dirname, 'reference-impl.ts');
const implUrl = pathToFileURL(implPath).href;

let generateCodeVerifier: () => string;
let computeCodeChallenge: (v: string) => string;
let verifyPkce: (v: string, c: string) => boolean;

beforeEach(async () => {
  const mod = await import(/* @vite-ignore */ implUrl);
  generateCodeVerifier = mod.generateCodeVerifier;
  computeCodeChallenge = mod.computeCodeChallenge;
  verifyPkce = mod.verifyPkce;
  if (!generateCodeVerifier || !computeCodeChallenge || !verifyPkce) {
    throw new Error(
      `Implementation at ${implPath} must export: generateCodeVerifier, computeCodeChallenge, verifyPkce`
    );
  }
});

describe('generateCodeVerifier', () => {
  it('returns exactly 43 characters (32 bytes → base64url = 43 chars)', () => {
    const v = generateCodeVerifier();
    expect(v.length).toBe(43);
  });

  it('contains only base64url characters [A-Za-z0-9-_]', () => {
    const v = generateCodeVerifier();
    expect(v).toMatch(/^[A-Za-z0-9\-_]+$/);
  });

  it('contains no + characters (base64url replaces + with -)', () => {
    for (let i = 0; i < 30; i++) {
      expect(generateCodeVerifier()).not.toContain('+');
    }
  });

  it('contains no / characters (base64url replaces / with _)', () => {
    for (let i = 0; i < 30; i++) {
      expect(generateCodeVerifier()).not.toContain('/');
    }
  });

  it('contains no = padding characters', () => {
    for (let i = 0; i < 30; i++) {
      expect(generateCodeVerifier()).not.toContain('=');
    }
  });

  it('produces distinct values (is random, not fixed)', () => {
    const values = new Set(Array.from({ length: 20 }, () => generateCodeVerifier()));
    expect(values.size).toBeGreaterThan(1);
  });
});

describe('computeCodeChallenge', () => {
  it('RFC 7636 Appendix B test vector: known verifier → known challenge', () => {
    // From RFC 7636 §B. Example for the S256 code_challenge_method
    const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    const expected = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
    expect(computeCodeChallenge(verifier)).toBe(expected);
  });

  it('returns exactly 43 characters (SHA-256 is 32 bytes → 43 base64url chars)', () => {
    const v = generateCodeVerifier();
    expect(computeCodeChallenge(v).length).toBe(43);
  });

  it('returns base64url (no +, no /, no =)', () => {
    for (let i = 0; i < 20; i++) {
      const c = computeCodeChallenge(generateCodeVerifier());
      expect(c).not.toContain('+');
      expect(c).not.toContain('/');
      expect(c).not.toContain('=');
    }
  });

  it('is deterministic for the same input', () => {
    const v = 'test-verifier-abc-123-xyz';
    const c1 = computeCodeChallenge(v);
    const c2 = computeCodeChallenge(v);
    expect(c1).toBe(c2);
  });

  it('different verifiers produce different challenges', () => {
    const v1 = generateCodeVerifier();
    const v2 = generateCodeVerifier();
    expect(computeCodeChallenge(v1)).not.toBe(computeCodeChallenge(v2));
  });
});

describe('verifyPkce', () => {
  it('returns true for a valid verifier/challenge pair', () => {
    const v = generateCodeVerifier();
    const c = computeCodeChallenge(v);
    expect(verifyPkce(v, c)).toBe(true);
  });

  it('returns false for a wrong verifier', () => {
    const v1 = generateCodeVerifier();
    const v2 = generateCodeVerifier();
    const c = computeCodeChallenge(v1);
    expect(verifyPkce(v2, c)).toBe(false);
  });

  it('returns false for a wrong challenge', () => {
    const v = generateCodeVerifier();
    const wrongC = computeCodeChallenge(generateCodeVerifier());
    expect(verifyPkce(v, wrongC)).toBe(false);
  });

  it('RFC 7636 test vector round-trip', () => {
    const v = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    const c = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
    expect(verifyPkce(v, c)).toBe(true);
  });

  it('returns false (not throw) for mismatched lengths', () => {
    expect(verifyPkce('a', 'x')).toBe(false);
  });

  it('returns false for empty strings', () => {
    expect(verifyPkce('', '')).toBe(false);
  });
});
