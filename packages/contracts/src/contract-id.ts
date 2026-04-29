// @decision DEC-HASH-WI002: Content-address uses BLAKE3 via @noble/hashes.
// Status: decided (WI-002)
// Rationale: BLAKE3 provides cryptographic collision resistance needed for a
// content-addressed registry. @noble/hashes is MIT-licensed, dependency-free
// (no native bindings), audited, and runs on any JS runtime. FNV-1a (the v0
// facade) had no collision resistance guarantees; BLAKE3-256 gives 128-bit
// preimage resistance which is more than sufficient for a registry of any
// realistic size.

import { blake3 } from "@noble/hashes/blake3.js";
import { canonicalize } from "./canonicalize.js";
import type { ContractId, ContractSpec } from "./index.js";

// ---------------------------------------------------------------------------
// ContractId derivation
// ---------------------------------------------------------------------------

/**
 * Derive a ContractId from the canonical bytes of a ContractSpec.
 *
 * The id is a 64-character lowercase hex string encoding 32 bytes of BLAKE3
 * output (BLAKE3-256). The hex string is branded as ContractId.
 *
 * Use this overload when you have already called `canonicalize()` and want to
 * avoid re-canonicalizing. This is the primitive that `contractId()` is built on.
 */
export function contractIdFromBytes(canonical: Uint8Array): ContractId {
  const digest = blake3(canonical);
  return bytesToHex(digest) as ContractId;
}

/**
 * Derive a stable ContractId from a ContractSpec.
 *
 * Equivalent to `contractIdFromBytes(canonicalize(spec))`. Call sites are
 * unchanged whether they canonicalize first or not.
 */
export function contractId(spec: ContractSpec): ContractId {
  return contractIdFromBytes(canonicalize(spec));
}

/**
 * Return true if `s` is a validly-formed ContractId: 64 lowercase hex characters.
 * Does not verify that the id was ever registered; only validates the format.
 */
export function isValidContractId(s: string): s is ContractId {
  return /^[0-9a-f]{64}$/.test(s);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Convert a Uint8Array to a lowercase hex string. */
function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
