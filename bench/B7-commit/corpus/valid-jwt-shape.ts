// SPDX-License-Identifier: MIT

/**
 * Validate the structural shape of a JSON Web Token: three base64url-encoded
 * segments separated by dots, where the header decodes to a JSON object with
 * a string "alg" field, and the payload decodes to a JSON object. Signature
 * bytes are not verified — this is a shape check only.
 *
 * @param token - The JWT string to inspect.
 * @returns True if the token has a valid JWT structure; false otherwise.
 */
export function isValidJwtShape(token: string): boolean {
  if (typeof token !== "string") return false;
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  const base64urlRe = /^[A-Za-z0-9_-]*$/;
  for (const part of parts) {
    if (!base64urlRe.test(part)) return false;
  }
  // Decode header
  try {
    const headerJson = Buffer.from(parts[0]!, "base64url").toString("utf8");
    const header = JSON.parse(headerJson) as unknown;
    if (typeof header !== "object" || header === null) return false;
    if (typeof (header as Record<string, unknown>)["alg"] !== "string") return false;
  } catch {
    return false;
  }
  // Decode payload (must be a JSON object)
  try {
    const payloadJson = Buffer.from(parts[1]!, "base64url").toString("utf8");
    const payload = JSON.parse(payloadJson) as unknown;
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return false;
  } catch {
    return false;
  }
  return true;
}
