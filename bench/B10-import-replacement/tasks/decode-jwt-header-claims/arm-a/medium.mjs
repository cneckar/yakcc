// SPDX-License-Identifier: MIT
//
// bench/B10-import-replacement/tasks/decode-jwt-header-claims/arm-a/medium.mjs
//
// @decision DEC-BENCH-B10-SLICE3-ARMA-FALLBACK-001
// @title Arm A-medium produced via hand-translation fallback (not yakcc compile + #508 hook)
// @status accepted
// @rationale
//   Same fallback provenance as arm-a/fine.mjs. GRANULARITY: A-medium.
//   Zero non-builtin imports.

function b64Decode(str) {
  const p = str.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(p + "=".repeat((4 - p.length % 4) % 4), "base64").toString("utf8");
}

/**
 * Composite: parse all three JWT segments.
 * @param {string} token
 * @returns {{ header: unknown, payload: unknown, signature: string } | null}
 */
export function parseJwtSegments(token) {
  if (typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    return {
      header:    JSON.parse(b64Decode(parts[0])),
      payload:   JSON.parse(b64Decode(parts[1])),
      signature: parts[2],
    };
  } catch {
    return null;
  }
}

/**
 * Entry: decode a JWT without verification.
 * @param {string} token
 * @returns {{ header: unknown, payload: unknown, signature: string } | null}
 */
export function decodeJwtHeaderClaims(token) {
  return parseJwtSegments(token);
}

export default decodeJwtHeaderClaims;
