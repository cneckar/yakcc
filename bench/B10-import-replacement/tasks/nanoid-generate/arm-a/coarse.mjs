// SPDX-License-Identifier: MIT
//
// bench/B10-import-replacement/tasks/nanoid-generate/arm-a/coarse.mjs
//
// @decision DEC-BENCH-B10-SLICE3-ARMA-FALLBACK-001
// @title Arm A-coarse produced via hand-translation fallback (not yakcc compile + #508 hook)
// @status accepted
// @rationale Same fallback as fine.mjs. GRANULARITY: A-coarse. Zero non-builtin imports.

import { getRandomValues } from 'node:crypto';

export function nanoidGenerate(size) {
  const sz = size === undefined ? 21 : size;
  if (!Number.isInteger(sz) || sz < 1) throw new RangeError('Invalid size: ' + sz);
  const alphabet = 'useandom-26T198340PX75pxJACKVERYMINDBUSHWOLF_GQZbfghjklqvwyzrict';
  const mask = (2 << Math.log(alphabet.length - 1) / Math.LN2) - 1;
  const step = Math.ceil(1.6 * mask * sz / alphabet.length);
  let id = '';
  while (id.length < sz) {
    const bytes = new Uint8Array(step);
    getRandomValues(bytes);
    for (const b of bytes) {
      const byte = b & mask;
      if (byte < alphabet.length) { id += alphabet[byte]; if (id.length === sz) break; }
    }
  }
  return id;
}

export default nanoidGenerate;
