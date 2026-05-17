// SPDX-License-Identifier: MIT
//
// bench/B10-import-replacement/tasks/uuid-v4-generate-validate/arm-a/fine.mjs
//
// @decision DEC-BENCH-B10-SLICE3-ARMA-FALLBACK-001
// @title Arm A-fine produced via hand-translation fallback (not yakcc compile + #508 hook)
// @status accepted
// @rationale
//   Hand-translation of uuid v4 + validate subgraph from WI-510 S4.
//   Uses node:crypto for random generation per DEC-WI510-S4-NODE-BUILTIN-FOREIGN-LEAF-001.
//   GRANULARITY: A-fine -- 5 named functions. Zero non-builtin imports.
//
//   Cross-references:
//   DEC-BENCH-B10-SLICE3-TASK-CORPUS-SELECTION-001 -- corpus-spec.json
//   DEC-WI510-S4-NODE-BUILTIN-FOREIGN-LEAF-001 -- crypto builtin usage
//   plans/wi-512-s3-b10-broaden.md §4

import { randomBytes } from 'node:crypto';

const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Atom: generate 16 random bytes.
 * @returns {Buffer}
 */
export function generateRandomBytes() {
  return randomBytes(16);
}

/**
 * Atom: set UUID v4 version and variant bits.
 * @param {Buffer} bytes
 * @returns {Buffer}
 */
export function setUuidV4Bits(bytes) {
  const b = Buffer.from(bytes);
  b[6] = (b[6] & 0x0f) | 0x40; // version 4
  b[8] = (b[8] & 0x3f) | 0x80; // variant RFC 4122
  return b;
}

/**
 * Atom: format bytes as UUID string.
 * @param {Buffer} bytes
 * @returns {string}
 */
export function bytesToUuidString(bytes) {
  const h = bytes.toString('hex');
  return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
}

/**
 * Atom: validate UUID string format.
 * @param {string} str
 * @returns {boolean}
 */
export function isValidUuid(str) {
  return typeof str === 'string' && UUID_V4_REGEX.test(str);
}

/**
 * Entry: generate a UUID v4 or validate a UUID string.
 * @param {string | undefined} input
 * @returns {string | boolean}
 */
export function uuidV4GenerateValidate(input) {
  if (input === undefined) {
    const bytes = setUuidV4Bits(generateRandomBytes());
    return bytesToUuidString(bytes);
  }
  return isValidUuid(input);
}

export default uuidV4GenerateValidate;
