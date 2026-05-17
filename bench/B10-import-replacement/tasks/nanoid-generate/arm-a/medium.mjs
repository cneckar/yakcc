// SPDX-License-Identifier: MIT
//
// bench/B10-import-replacement/tasks/nanoid-generate/arm-a/medium.mjs
//
// @decision DEC-BENCH-B10-SLICE3-ARMA-FALLBACK-001
// @title Arm A-medium produced via hand-translation fallback (not yakcc compile + #508 hook)
// @status accepted
// @rationale Same fallback as fine.mjs. GRANULARITY: A-medium. Zero non-builtin imports.

import { getRandomValues } from 'node:crypto';

const ALPHABET = 'useandom-26T198340PX75pxJACKVERYMINDBUSHWOLF_GQZbfghjklqvwyzrict';
const DEFAULT_SIZE = 21;

export function buildNanoidBytes(size) {
  const mask = (2 << Math.log(ALPHABET.length - 1) / Math.LN2) - 1;
  const step = Math.ceil(1.6 * mask * size / ALPHABET.length);
  let id = '';
  while (id.length < size) {
    const bytes = new Uint8Array(step);
    getRandomValues(bytes);
    for (const b of bytes) {
      const byte = b & mask;
      if (byte < ALPHABET.length) { id += ALPHABET[byte]; if (id.length === size) break; }
    }
  }
  return id;
}

export function nanoidGenerate(size) {
  const sz = size === undefined ? DEFAULT_SIZE : size;
  if (!Number.isInteger(sz) || sz < 1) throw new RangeError('Invalid size: ' + sz);
  return buildNanoidBytes(sz);
}

export default nanoidGenerate;
