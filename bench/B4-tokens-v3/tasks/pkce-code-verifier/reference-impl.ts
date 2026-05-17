// SPDX-License-Identifier: MIT
// Reference implementation for B4-v3 oracle validation.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

function toBase64Url(buf: Buffer): string {
  return buf.toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export function generateCodeVerifier(): string {
  return toBase64Url(randomBytes(32));
}

export function computeCodeChallenge(verifier: string): string {
  const hash = createHash('sha256').update(Buffer.from(verifier, 'ascii')).digest();
  return toBase64Url(hash);
}

export function verifyPkce(verifier: string, challenge: string): boolean {
  try {
    const expected = computeCodeChallenge(verifier);
    const a = Buffer.from(expected, 'utf8');
    const b = Buffer.from(challenge, 'utf8');
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}
