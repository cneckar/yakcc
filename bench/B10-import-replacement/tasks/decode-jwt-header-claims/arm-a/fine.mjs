// SPDX-License-Identifier: MIT
//
// bench/B10-import-replacement/tasks/decode-jwt-header-claims/arm-a/fine.mjs
//
// @decision DEC-BENCH-B10-SLICE3-ARMA-FALLBACK-001
// @title Arm A-fine produced via hand-translation fallback (not yakcc compile + #508 hook)
// @status accepted
// @rationale
//   Hand-translation of jsonwebtoken/decode.js WI-510 S6 subgraph (1 module).
//   GRANULARITY: A-fine -- 4 small named functions. Zero non-builtin imports.
//
//   Cross-references:
//   DEC-BENCH-B10-SLICE3-TASK-CORPUS-SELECTION-001 -- corpus-spec.json
//   plans/wi-512-s3-b10-broaden.md §4

/**
 * Atom: base64url-decode to string.
 * @param {string} str
 * @returns {string}
 */
export function b64urlToString(str) {
  const padded = str.replace(/-/g, "+").replace(/_/g, "/");
  const pad = (4 - (padded.length % 4)) % 4;
  return Buffer.from(padded + "=".repeat(pad), "base64").toString("utf8");
}

/**
 * Atom: safely parse JSON, returning null on failure.
 * @param {string} s
 * @returns {unknown | null}
 */
export function safeParse(s) {
  try { return JSON.parse(s); } catch { return null; }
}

/**
 * Atom: split compact JWT into parts, returning null if not 3 parts.
 * @param {string} token
 * @returns {string[] | null}
 */
export function splitToken(token) {
  if (typeof token !== "string") return null;
  const parts = token.split(".");
  return parts.length === 3 ? parts : null;
}

/**
 * Atom: decode a single JWT segment to a parsed object.
 * @param {string} segment
 * @returns {unknown | null}
 */
export function decodeSegment(segment) {
  return safeParse(b64urlToString(segment));
}

/**
 * Entry: decode a JWT without signature verification.
 * Returns null if the token cannot be decoded.
 * @param {string} token
 * @returns {{ header: unknown, payload: unknown, signature: string } | null}
 */
export function decodeJwtHeaderClaims(token) {
  const parts = splitToken(token);
  if (!parts) return null;
  const header  = decodeSegment(parts[0]);
  const payload = decodeSegment(parts[1]);
  if (!header || !payload) return null;
  return { header, payload, signature: parts[2] };
}

export default decodeJwtHeaderClaims;
