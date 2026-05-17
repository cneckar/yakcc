// SPDX-License-Identifier: MIT
//
// bench/B4-tokens/tasks/verify-jwt-hs256/reference-impl.ts
//
// @decision DEC-B4-SLICE-3-TASKS-001
// @title B4 Slice 3 task corpus: verify-jwt-hs256 reference implementation
// @status accepted
// @rationale
//   Reference implementation for oracle validation. Proves the oracle correctly
//   distinguishes RFC-compliant JWT verifiers from broken ones. Hand-written from
//   RFC 7519 (JWT) and RFC 7515 (JWS) specifications; not LLM-generated or copied
//   from the jsonwebtoken npm package (per DEC-BENCH-METHODOLOGY-NEVER-SYNTHETIC-001).
//
//   WI-510 atom backing: jsonwebtoken Slice 6 — verify.js (verification logic) and
//   decode.js (base64url decode + header/payload parse). The benchmark tests whether
//   the hooked LLM arm substitutes these shaved atoms rather than regenerating the
//   HMAC + base64url plumbing from scratch.
//
//   Adversarial traps exercised by the oracle:
//   1. Algorithm-confusion attack: alg=none / alg=RS256 must be rejected
//   2. HMAC over original base64url strings (not re-encoded)
//   3. Constant-time comparison via crypto.timingSafeEqual
//   4. Expiry check: payload.exp checked against Date.now()/1000
//   5. base64url vs base64: Buffer.from(x, "base64url") not atob()

import { createHmac, timingSafeEqual } from "node:crypto";

export interface VerifyResult {
  valid: boolean;
  payload?: Record<string, unknown>;
  header?: Record<string, unknown>;
  reason?: string;
}

/**
 * Decode a base64url-encoded string to a Buffer.
 * Uses Node.js built-in base64url encoding (Node 16+).
 */
function decodeBase64url(input: string): Buffer {
  return Buffer.from(input, "base64url");
}

/**
 * Parse a base64url-encoded JSON segment.
 * Returns the parsed object or throws on invalid encoding / invalid JSON.
 */
function parseJwtSegment(segment: string): Record<string, unknown> {
  const decoded = decodeBase64url(segment);
  const jsonStr = decoded.toString("utf8");
  const parsed: unknown = JSON.parse(jsonStr);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("JWT segment must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

/**
 * Verify a JWT signed with HS256 (HMAC-SHA256).
 *
 * Steps:
 * 1. Split into 3 parts
 * 2. Decode and validate header (must have alg === "HS256")
 * 3. Decode and validate payload
 * 4. Verify signature using HMAC-SHA256 with timingSafeEqual
 * 5. Check payload.exp if present
 *
 * @param token  - JWT string: base64url(header).base64url(payload).base64url(signature)
 * @param secret - HMAC secret as UTF-8 string
 * @returns VerifyResult with valid flag and decoded header/payload on success
 */
export function verifyHs256(token: string, secret: string): VerifyResult {
  // Step 1: Structural check
  const parts = token.split(".");
  if (parts.length !== 3) {
    return { valid: false, reason: `JWT must have exactly 3 parts, got ${parts.length}` };
  }
  const [headerPart, payloadPart, signaturePart] = parts as [string, string, string];
  if (!headerPart || !payloadPart || !signaturePart) {
    return { valid: false, reason: "JWT parts must be non-empty" };
  }

  // Step 2: Header decode and algorithm check
  let header: Record<string, unknown>;
  try {
    header = parseJwtSegment(headerPart);
  } catch (e) {
    return { valid: false, reason: `Invalid JWT header: ${(e as Error).message}` };
  }

  // Algorithm confusion attack: must be exactly "HS256"
  if (header["alg"] !== "HS256") {
    return {
      valid: false,
      reason: `Unsupported algorithm: expected "HS256", got ${JSON.stringify(header["alg"])}`,
    };
  }

  // Step 3: Payload decode
  let payload: Record<string, unknown>;
  try {
    payload = parseJwtSegment(payloadPart);
  } catch (e) {
    return { valid: false, reason: `Invalid JWT payload: ${(e as Error).message}` };
  }

  // Step 4: Signature verification
  // CRITICAL: Sign the ORIGINAL base64url strings from the token, not re-encoded values.
  // This matches the JWS spec: "ASCII(BASE64URL(UTF8(JWS Protected Header)) || '.' ||
  // BASE64URL(JWS Payload))" where the input is the literal token segments.
  const signingInput = `${headerPart}.${payloadPart}`;
  const expectedSigBuf = createHmac("sha256", secret)
    .update(signingInput)
    .digest();

  let actualSigBuf: Buffer;
  try {
    actualSigBuf = decodeBase64url(signaturePart);
  } catch (e) {
    return { valid: false, reason: `Invalid JWT signature encoding: ${(e as Error).message}` };
  }

  // Constant-time comparison to prevent timing oracle attacks
  if (expectedSigBuf.length !== actualSigBuf.length) {
    return { valid: false, reason: "Signature verification failed" };
  }
  if (!timingSafeEqual(expectedSigBuf, actualSigBuf)) {
    return { valid: false, reason: "Signature verification failed" };
  }

  // Step 5: Expiry check
  if ("exp" in payload) {
    const exp = payload["exp"];
    if (typeof exp !== "number") {
      return { valid: false, reason: `Invalid exp claim: expected number, got ${typeof exp}` };
    }
    const nowSeconds = Math.floor(Date.now() / 1000);
    if (nowSeconds >= exp) {
      return { valid: false, reason: `Token expired at ${exp} (now: ${nowSeconds})` };
    }
  }

  return { valid: true, header, payload };
}
