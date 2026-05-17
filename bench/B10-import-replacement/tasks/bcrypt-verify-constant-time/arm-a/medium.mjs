// SPDX-License-Identifier: MIT
//
// bench/B10-import-replacement/tasks/bcrypt-verify-constant-time/arm-a/medium.mjs
//
// @decision DEC-BENCH-B10-SLICE3-ARMA-ENGINE-GAP-DISCLOSED-001
// @title Arm A-medium: engine-gap-disclosed (#585)
// @status accepted
// @rationale Same engine-gap disclosure as fine.mjs. GRANULARITY: A-medium. Zero non-builtin imports.

import { createHmac, timingSafeEqual } from 'node:crypto';

function constantTimeEq(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const key = Buffer.allocUnsafe(32);
  return timingSafeEqual(
    createHmac('sha256', key).update(a).digest(),
    createHmac('sha256', key).update(b).digest()
  );
}

export function validateBcryptInputs(plaintext, hash) {
  if (typeof plaintext !== 'string') throw new TypeError('plaintext must be a string');
  return typeof hash === 'string' && /^\$2[ab]?\$\d{2}\$[./A-Za-z0-9]{53}$/.test(hash);
}

export async function bcryptVerifyConstantTime(plaintext, hash) {
  if (!validateBcryptInputs(plaintext, hash)) return false;
  return constantTimeEq(plaintext, hash);
}

export default bcryptVerifyConstantTime;
