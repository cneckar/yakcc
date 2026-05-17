// SPDX-License-Identifier: MIT
//
// bench/B10-import-replacement/tasks/verify-jwt-hs256/arm-a/fine.mjs
//
// @decision DEC-BENCH-B10-SLICE3-ARMA-FALLBACK-001
// @title Arm A-fine produced via hand-translation fallback (not yakcc compile + #508 hook)
// @status accepted
// @rationale
//   The production end-to-end CLI path (yakcc compile + #508 import-intercept hook + WI-510
//   atom registry) is not wired end-to-end at S3 implementation time. This file is produced
//   via hand-translation of the HS256 verify subgraph from WI-510 S6 fixture
//   (jsonwebtoken@9.0.2 / verify.js, HS256 HMAC path only) into a zero-npm-import .mjs.
//
//   GRANULARITY: A-fine -- one exported function per structural concern.
//   Zero non-builtin imports -- reachable_files == 1 when measured.
//   Uses only node:crypto for HMAC-SHA256 (counted as builtin, not npm surface).
//
//   Cross-references:
//   DEC-BENCH-B10-SLICE3-TASK-CORPUS-SELECTION-001 -- corpus-spec.json
//   DEC-WI510-S6-NPM-EXTERNAL-FAN-OUT-001 -- jsonwebtoken multi-npm externalSpecifiers
//   plans/wi-512-s3-b10-broaden.md §4

import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Atom: base64url-decode a string to a Buffer.
 * @param {string} str
 * @returns {Buffer}
 */
export function base64UrlDecode(str) {
  const padded = str.replace(/-/g, "+").replace(/_/g, "/");
  const pad = (4 - (padded.length % 4)) % 4;
  return Buffer.from(padded + "=".repeat(pad), "base64");
}

/**
 * Atom: split a compact JWT into [header, payload, signature] parts.
 * Returns null if the token does not have exactly 3 parts.
 * @param {string} token
 * @returns {[string, string, string] | null}
 */
export function splitJwtParts(token) {
  if (typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  return [parts[0], parts[1], parts[2]];
}

/**
 * Atom: decode and parse a base64url-encoded JSON segment.
 * Returns null if parsing fails.
 * @param {string} segment
 * @returns {Record<string, unknown> | null}
 */
export function decodeJwtSegment(segment) {
  try {
    return JSON.parse(base64UrlDecode(segment).toString("utf8"));
  } catch {
    return null;
  }
}

/**
 * Atom: compute HMAC-SHA256 signature over the signing input.
 * @param {string} signingInput  "header.payload" (base64url encoded)
 * @param {string} secret
 * @returns {Buffer}
 */
export function computeHmacSha256(signingInput, secret) {
  return createHmac("sha256", secret).update(signingInput).digest();
}

/**
 * Atom: constant-time compare two Buffers.
 * @param {Buffer} a
 * @param {Buffer} b
 * @returns {boolean}
 */
export function safeBufferEqual(a, b) {
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Entry: verify a JWT signed with HS256.
 * Throws on invalid token, wrong algorithm, or bad signature.
 * @param {string} token
 * @param {string} secret
 * @returns {unknown} decoded payload
 */
export function verifyJwtHs256(token, secret) {
  const parts = splitJwtParts(token);
  if (!parts) throw new Error("invalid token: expected 3 parts");

  const [headerB64, payloadB64, sigB64] = parts;

  const header = decodeJwtSegment(headerB64);
  if (!header) throw new Error("invalid token: header not parseable");
  if (header.alg !== "HS256") throw new Error("invalid algorithm: expected HS256, got " + header.alg);

  const signingInput = headerB64 + "." + payloadB64;
  const expected = computeHmacSha256(signingInput, secret);
  const actual   = base64UrlDecode(sigB64);

  if (!safeBufferEqual(expected, actual)) {
    throw new Error("invalid signature");
  }

  const payload = decodeJwtSegment(payloadB64);
  if (!payload) throw new Error("invalid token: payload not parseable");

  if (typeof payload.exp === "number" && payload.exp < Math.floor(Date.now() / 1000)) {
    throw new Error("token expired");
  }

  return payload;
}

export default verifyJwtHs256;
