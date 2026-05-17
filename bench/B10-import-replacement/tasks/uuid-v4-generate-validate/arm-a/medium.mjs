// SPDX-License-Identifier: MIT
//
// bench/B10-import-replacement/tasks/uuid-v4-generate-validate/arm-a/medium.mjs
//
// @decision DEC-BENCH-B10-SLICE3-ARMA-FALLBACK-001
// @title Arm A-medium produced via hand-translation fallback (not yakcc compile + #508 hook)
// @status accepted
// @rationale Same fallback as fine.mjs. GRANULARITY: A-medium. Zero non-builtin imports.

import { randomBytes } from 'node:crypto';

const RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function generateUuidV4() {
  const b = randomBytes(16);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.toString('hex');
  return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
}

export function uuidV4GenerateValidate(input) {
  if (input === undefined) return generateUuidV4();
  return typeof input === 'string' && RE.test(input);
}

export default uuidV4GenerateValidate;
