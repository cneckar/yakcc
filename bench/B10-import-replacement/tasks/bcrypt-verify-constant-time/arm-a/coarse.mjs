// SPDX-License-Identifier: MIT
//
// bench/B10-import-replacement/tasks/bcrypt-verify-constant-time/arm-a/coarse.mjs
//
// @decision DEC-BENCH-B10-SLICE3-ARMA-ENGINE-GAP-DISCLOSED-001
// @title Arm A-coarse: engine-gap-disclosed (#585)
// @status accepted
// @rationale Same engine-gap disclosure as fine.mjs. GRANULARITY: A-coarse. Zero non-builtin imports.

import { createHmac, timingSafeEqual } from 'node:crypto';

export async function bcryptVerifyConstantTime(plaintext, hash) {
  if (typeof plaintext !== 'string') throw new TypeError('plaintext must be a string');
  if (typeof hash !== 'string' || !/^\$2[ab]?\$\d{2}\$[./A-Za-z0-9]{53}$/.test(hash)) return false;
  const key = Buffer.allocUnsafe(32);
  return timingSafeEqual(
    createHmac('sha256', key).update(plaintext).digest(),
    createHmac('sha256', key).update(hash).digest()
  );
}

export default bcryptVerifyConstantTime;
