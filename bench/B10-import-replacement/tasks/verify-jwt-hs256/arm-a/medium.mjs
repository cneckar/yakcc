// SPDX-License-Identifier: MIT
//
// bench/B10-import-replacement/tasks/verify-jwt-hs256/arm-a/medium.mjs
//
// @decision DEC-BENCH-B10-SLICE3-ARMA-FALLBACK-001
// @title Arm A-medium produced via hand-translation fallback (not yakcc compile + #508 hook)
// @status accepted
// @rationale
//   Same fallback provenance as arm-a/fine.mjs. GRANULARITY: A-medium -- two composite
//   functions plus entry. Zero non-builtin imports.

import { createHmac, timingSafeEqual } from "node:crypto";

function b64urlDecode(str) {
  const padded = str.replace(/-/g, "+").replace(/_/g, "/");
  const pad = (4 - (padded.length % 4)) % 4;
  return Buffer.from(padded + "=".repeat(pad), "base64");
}

/**
 * Composite: split and decode JWT structure.
 * @param {string} token
 * @returns {{ header: object, payload: object, signingInput: string, sig: Buffer }}
 */
export function parseAndValidateJwt(token) {
  const parts = typeof token === "string" ? token.split(".") : [];
  if (parts.length !== 3) throw new Error("invalid token: expected 3 parts");
  const header = JSON.parse(b64urlDecode(parts[0]).toString("utf8"));
  if (header.alg !== "HS256") throw new Error("invalid algorithm: expected HS256, got " + header.alg);
  const payload = JSON.parse(b64urlDecode(parts[1]).toString("utf8"));
  return { header, payload, signingInput: parts[0] + "." + parts[1], sig: b64urlDecode(parts[2]) };
}

/**
 * Composite: verify HMAC-SHA256 signature and expiry.
 * @param {string} signingInput
 * @param {Buffer} sig
 * @param {string} secret
 * @param {object} payload
 */
export function verifySignatureAndClaims(signingInput, sig, secret, payload) {
  const expected = createHmac("sha256", secret).update(signingInput).digest();
  if (sig.length !== expected.length || !timingSafeEqual(expected, sig)) {
    throw new Error("invalid signature");
  }
  if (typeof payload.exp === "number" && payload.exp < Math.floor(Date.now() / 1000)) {
    throw new Error("token expired");
  }
}

/**
 * Entry: verify a JWT signed with HS256.
 * @param {string} token
 * @param {string} secret
 * @returns {unknown}
 */
export function verifyJwtHs256(token, secret) {
  const { payload, signingInput, sig } = parseAndValidateJwt(token);
  verifySignatureAndClaims(signingInput, sig, secret, payload);
  return payload;
}

export default verifyJwtHs256;
