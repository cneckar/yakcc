// SPDX-License-Identifier: MIT

/**
 * Parse a URL query string into a map of decoded key-value pairs.
 * Accepts strings with or without a leading "?". Keys that appear multiple
 * times produce arrays; keys with no "=" produce an empty-string value.
 * Both keys and values are percent-decoded via decodeURIComponent.
 *
 * @param qs - The query string, e.g. "?a=1&b=2&a=3" or "a=1&b=2".
 * @returns A record mapping each key to its value(s).
 * @throws {URIError} if any percent-encoded sequence is malformed.
 */
export function parseQueryString(qs: string): Record<string, string | string[]> {
  const raw = typeof qs === "string" && qs.startsWith("?") ? qs.slice(1) : qs;
  const result: Record<string, string | string[]> = {};
  if (!raw) return result;
  for (const pair of raw.split("&")) {
    if (pair.length === 0) continue;
    const eqIdx = pair.indexOf("=");
    const rawKey = eqIdx === -1 ? pair : pair.slice(0, eqIdx);
    const rawVal = eqIdx === -1 ? "" : pair.slice(eqIdx + 1);
    const key = decodeURIComponent(rawKey.replace(/\+/g, " "));
    const val = decodeURIComponent(rawVal.replace(/\+/g, " "));
    const existing = result[key];
    if (existing === undefined) {
      result[key] = val;
    } else if (Array.isArray(existing)) {
      existing.push(val);
    } else {
      result[key] = [existing, val];
    }
  }
  return result;
}
