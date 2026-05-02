// SPDX-License-Identifier: MIT
// @decision DEC-CONTINUOUS-SHAVE-022: Cache keys are BLAKE3 hashes of the
// concatenated inputs, NUL-delimited to prevent collisions across field
// boundaries. Two separate keys are produced: one for the source alone
// (sourceHash, used inside the IntentCard), and one composite key for the
// cache file name (incorporates model, prompt version, schema version).
// Status: decided (MASTER_PLAN.md DEC-CONTINUOUS-SHAVE-022)
// Rationale: Separating sourceHash from the composite cache key lets the
// IntentCard record what source it was extracted from (sourceHash) while the
// cache file name encodes the full extraction context that must match for a
// cache hit to be valid.

import { blake3 } from "@noble/hashes/blake3";
import { bytesToHex } from "@noble/hashes/utils";
import { normalizeSource } from "./normalize.js";

const encoder = new TextEncoder();

/**
 * Compute the BLAKE3-256 hex hash of the normalized source text.
 *
 * This value is stored in IntentCard.sourceHash and is the first input
 * to the composite cache key.
 *
 * @param unitSource - Raw source string from the candidate block.
 * @returns 64-character lowercase hex string.
 */
export function sourceHash(unitSource: string): string {
  const normalized = normalizeSource(unitSource);
  return bytesToHex(blake3(encoder.encode(normalized)));
}

/**
 * Parameters for the composite intent-extraction cache key.
 */
export interface IntentKeyInputs {
  readonly sourceHash: string;
  readonly modelTag: string;
  readonly promptVersion: string;
  readonly schemaVersion: number;
}

/**
 * Derive the file-system cache key from the full set of extraction inputs.
 *
 * The key is BLAKE3-256 of the NUL-delimited concatenation:
 *   sourceHash \x00 modelTag \x00 promptVersion \x00 schemaVersion
 *
 * NUL delimiters prevent collisions where one field's value is a prefix of
 * another (e.g. sourceHash="abc\x00def" with modelTag="" vs
 * sourceHash="abc" with modelTag="def").
 *
 * @returns 64-character lowercase hex string used as the cache filename stem.
 */
export function keyFromIntentInputs(inputs: IntentKeyInputs): string {
  const { sourceHash: sh, modelTag, promptVersion, schemaVersion } = inputs;
  const raw = `${sh}\x00${modelTag}\x00${promptVersion}\x00${schemaVersion}`;
  return bytesToHex(blake3(encoder.encode(raw)));
}
