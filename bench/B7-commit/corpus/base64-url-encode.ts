// SPDX-License-Identifier: MIT

/**
 * Encode a Uint8Array or Buffer to a base64url string (RFC 4648 §5): uses
 * "-" instead of "+", "_" instead of "/", and omits "=" padding. The output
 * is safe for use in URLs and HTTP headers without further percent-encoding.
 *
 * @param data - The binary data to encode.
 * @returns Base64url-encoded string with no padding characters.
 */
export function base64UrlEncode(data: Uint8Array): string {
  // Use Node.js Buffer for the base64 conversion, then apply RFC 4648 §5 substitutions
  const b64 = Buffer.from(data).toString("base64");
  const noPlus = b64.replace(/\+/g, "-");
  const noSlash = noPlus.replace(/\//g, "_");
  const noPadding = noSlash.replace(/=+$/, "");
  return noPadding;
}
