// SPDX-License-Identifier: MIT

/** Parsed components of an RFC 3339 UTC timestamp. */
export interface Rfc3339Components {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  millisecond: number;
}

/**
 * Parse an RFC 3339 UTC timestamp string into its components. Accepts strings
 * of the form "YYYY-MM-DDTHH:MM:SSZ" or "YYYY-MM-DDTHH:MM:SS.sssZ" (with
 * optional fractional seconds). The "Z" suffix is required — non-UTC offsets
 * are rejected. Returns null for any string that does not match.
 *
 * @param ts - The RFC 3339 UTC timestamp string to parse.
 * @returns Parsed components, or null if the string is not valid RFC 3339 UTC.
 */
export function parseRfc3339Utc(ts: string): Rfc3339Components | null {
  if (typeof ts !== "string") return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?[Zz]$/.exec(ts);
  if (!m) return null;
  const [, yr, mo, dy, hr, mn, sc, frac] = m;
  const year = Number(yr), month = Number(mo), day = Number(dy);
  const hour = Number(hr), minute = Number(mn), second = Number(sc);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  if (hour > 23 || minute > 59 || second > 59) return null;
  const millisecond = frac !== undefined ? Math.round(Number(`0.${frac}`) * 1000) : 0;
  return { year, month, day, hour, minute, second, millisecond };
}
