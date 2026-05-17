// SPDX-License-Identifier: MIT
//
// bench/B10-import-replacement/tasks/nanoid-generate/arm-a/fine.mjs
//
// @decision DEC-BENCH-B10-SLICE3-ARMA-FALLBACK-001
// @title Arm A-fine produced via hand-translation fallback (not yakcc compile + #508 hook)
// @status accepted
// @rationale
//   Hand-translation of nanoid@3.3.12 index.cjs from WI-510 S4.
//   Uses node:crypto builtin per DEC-WI510-S4-NODE-BUILTIN-FOREIGN-LEAF-001.
//   GRANULARITY: A-fine -- 4 named functions. Zero non-builtin imports.
//
//   Cross-references:
//   DEC-BENCH-B10-SLICE3-TASK-CORPUS-SELECTION-001 -- corpus-spec.json
//   DEC-WI510-S4-NODE-BUILTIN-FOREIGN-LEAF-001 -- crypto builtin foreign leaf
//   plans/wi-512-s3-b10-broaden.md §4

import { getRandomValues } from 'node:crypto';

/** URL-safe alphabet used by nanoid (64 characters). */
export const NANOID_ALPHABET = 'useandom-26T198340PX75pxJACKVERYMINDBUSHWOLF_GQZbfghjklqvwyzrict';

/** Default nanoid size. */
export const NANOID_DEFAULT_SIZE = 21;

/**
 * Atom: generate `size` random bytes using crypto.getRandomValues.
 * @param {number} size
 * @returns {Uint8Array}
 */
export function getRandomBytes(size) {
  const bytes = new Uint8Array(size);
  getRandomValues(bytes);
  return bytes;
}

/**
 * Atom: map random bytes to alphabet characters.
 * Uses the standard nanoid mask approach for uniform distribution.
 * @param {Uint8Array} bytes
 * @param {string} alphabet
 * @returns {string}
 */
export function mapBytesToAlphabet(bytes, alphabet) {
  const mask = (2 << Math.log(alphabet.length - 1) / Math.LN2) - 1;
  let id = '';
  let i = 0;
  while (id.length < bytes.length) {
    const byte = bytes[i++ % bytes.length] & mask;
    if (byte < alphabet.length) id += alphabet[byte];
  }
  return id;
}

/**
 * Entry: generate a nanoid of the given size.
 * @param {number} [size]
 * @returns {string}
 */
export function nanoidGenerate(size) {
  const sz = size === undefined ? NANOID_DEFAULT_SIZE : size;
  if (!Number.isInteger(sz) || sz < 1) throw new RangeError('Invalid size: ' + sz);
  // Oversample to handle masking rejects (standard nanoid approach)
  const bytes = getRandomBytes(sz + Math.ceil(sz * 0.3));
  let id = '';
  const mask = (2 << Math.log(NANOID_ALPHABET.length - 1) / Math.LN2) - 1;
  let i = 0;
  while (id.length < sz) {
    const b = bytes[i++ % bytes.length] & mask;
    if (b < NANOID_ALPHABET.length) id += NANOID_ALPHABET[b];
    if (i >= bytes.length && id.length < sz) {
      // Get more bytes if needed
      const extra = getRandomBytes(sz - id.length + 5);
      for (let j = 0; j < extra.length && id.length < sz; j++) {
        const eb = extra[j] & mask;
        if (eb < NANOID_ALPHABET.length) id += NANOID_ALPHABET[eb];
      }
    }
  }
  return id.slice(0, sz);
}

export default nanoidGenerate;
