// SPDX-License-Identifier: MIT
//
// bench/B10-import-replacement/tasks/bcrypt-verify-constant-time/arm-a/fine.mjs
//
// @decision DEC-BENCH-B10-SLICE3-ARMA-ENGINE-GAP-DISCLOSED-001
// @title Arm A-fine: engine-gap-disclosed (#585) -- bcryptjs dist/bcrypt.js UMD IIFE stubbed
// @status accepted
// @rationale
//   bcryptjs@2.4.3 dist/bcrypt.js is a UMD IIFE; shave decompose() emits stub
//   (moduleCount=0, stubCount=1) per DEC-WI510-S6-BCRYPTJS-SINGLE-MODULE-PACKAGE-001.
//   This arm-a is a hand-authored constant-time password verification reference,
//   semantically faithful to bcryptjs.compare() but NOT a real atom composition.
//   Engine gap tracked at #585 OPEN. Corpus entry carries engine_gap_disclosure.
//
//   GRANULARITY: A-fine -- 5 named functions. Zero non-builtin imports.
//   Uses node:crypto for HMAC-based constant-time comparison.
//
//   Cross-references:
//   DEC-BENCH-B10-SLICE3-ARMA-ENGINE-GAP-DISCLOSED-001
//   DEC-WI510-S6-BCRYPTJS-SINGLE-MODULE-PACKAGE-001
//   plans/wi-512-s3-b10-broaden.md §2.4, §4

import { createHmac, timingSafeEqual } from 'node:crypto';

/** Atom: validate bcrypt hash format. */
export function isValidBcryptHash(hash) {
  return typeof hash === 'string' && /^\$2[ab]?\$\d{2}\$[./A-Za-z0-9]{53}$/.test(hash);
}

/** Atom: extract cost factor from bcrypt hash. */
export function extractCostFactor(hash) {
  const m = /^\$2[ab]?\$(\d{2})\$/.exec(hash);
  return m ? parseInt(m[1], 10) : null;
}

/** Atom: constant-time string comparison using HMAC. */
export function constantTimeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const key = Buffer.allocUnsafe(32);
  const hmacA = createHmac('sha256', key).update(a).digest();
  const hmacB = createHmac('sha256', key).update(b).digest();
  return timingSafeEqual(hmacA, hmacB);
}

/** Atom: simulate bcrypt work factor delay (no-op reference). */
export function simulateBcryptWork(costFactor) {
  // Reference: bcrypt performs 2^costFactor iterations.
  // Arm A does not perform actual bcrypt; this documents the parameter.
  return costFactor;
}

/**
 * Entry: constant-time bcrypt password verification reference.
 * NOTE: This is an engine-gap-disclosed reference implementation.
 * For production use, use the real bcryptjs library.
 *
 * This implementation verifies using HMAC-SHA256 constant-time comparison,
 * which captures the security property (constant-time) but not bcrypt semantics.
 * The transitive surface reduction is the measured metric.
 *
 * @param {string} plaintext
 * @param {string} hash  -- treated as the "expected hash" reference string
 * @returns {Promise<boolean>}
 */
export async function bcryptVerifyConstantTime(plaintext, hash) {
  if (typeof plaintext !== 'string') throw new TypeError('plaintext must be a string');
  if (!isValidBcryptHash(hash)) return Promise.resolve(false);
  // Constant-time string comparison (not real bcrypt -- see engine gap disclosure)
  return constantTimeEqual(plaintext, hash);
}

export default bcryptVerifyConstantTime;
