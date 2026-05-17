// SPDX-License-Identifier: MIT
//
// bench/B10-import-replacement/tasks/decode-jwt-header-claims/arm-a/coarse.mjs
//
// @decision DEC-BENCH-B10-SLICE3-ARMA-FALLBACK-001
// @title Arm A-coarse produced via hand-translation fallback (not yakcc compile + #508 hook)
// @status accepted
// @rationale
//   Same fallback provenance as arm-a/fine.mjs. GRANULARITY: A-coarse -- single entry
//   function. Zero non-builtin imports.

/**
 * Decode a JWT without signature verification (coarse).
 * @param {string} token
 * @returns {{ header: unknown, payload: unknown, signature: string } | null}
 */
export function decodeJwtHeaderClaims(token) {
  if (typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const dec = (s) => {
    const p = s.replace(/-/g, "+").replace(/_/g, "/");
    return Buffer.from(p + "=".repeat((4 - p.length % 4) % 4), "base64").toString("utf8");
  };
  try {
    return { header: JSON.parse(dec(parts[0])), payload: JSON.parse(dec(parts[1])), signature: parts[2] };
  } catch {
    return null;
  }
}

export default decodeJwtHeaderClaims;
