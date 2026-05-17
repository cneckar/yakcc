// SPDX-License-Identifier: MIT
//
// bench/B10-import-replacement/tasks/verify-jwt-hs256/arm-a/coarse.mjs
//
// @decision DEC-BENCH-B10-SLICE3-ARMA-FALLBACK-001
// @title Arm A-coarse produced via hand-translation fallback (not yakcc compile + #508 hook)
// @status accepted
// @rationale
//   Same fallback provenance as arm-a/fine.mjs. GRANULARITY: A-coarse -- single entry
//   function inlining all validation. Zero non-builtin imports.

import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Verify a JWT signed with HS256 (single-function coarse granularity).
 * @param {string} token
 * @param {string} secret
 * @returns {unknown}
 */
export function verifyJwtHs256(token, secret) {
  if (typeof token !== "string") throw new Error("invalid token");
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("invalid token: expected 3 parts");
  const b64url = (s) => {
    const p = s.replace(/-/g, "+").replace(/_/g, "/");
    return Buffer.from(p + "=".repeat((4 - p.length % 4) % 4), "base64");
  };
  const header = JSON.parse(b64url(parts[0]).toString("utf8"));
  if (header.alg !== "HS256") throw new Error("invalid algorithm: expected HS256, got " + header.alg);
  const expected = createHmac("sha256", secret).update(parts[0] + "." + parts[1]).digest();
  const actual = b64url(parts[2]);
  if (actual.length !== expected.length || !timingSafeEqual(expected, actual)) {
    throw new Error("invalid signature");
  }
  const payload = JSON.parse(b64url(parts[1]).toString("utf8"));
  if (typeof payload.exp === "number" && payload.exp < Math.floor(Date.now() / 1000)) {
    throw new Error("token expired");
  }
  return payload;
}

export default verifyJwtHs256;
