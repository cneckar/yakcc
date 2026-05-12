// SPDX-License-Identifier: MIT

/**
 * Parse an ISO 8601 duration string and return the total number of seconds.
 * Supports years (365d), months (30d), weeks, days, hours, minutes, and seconds.
 * Returns NaN for malformed or empty input.
 *
 * @param iso - An ISO 8601 duration string, e.g. "P1Y2M3DT4H5M6S".
 * @returns Total duration in seconds, or NaN if the string is not a valid ISO 8601 duration.
 */
export function isoDurationToSeconds(iso: string): number {
  if (!iso || typeof iso !== "string") return NaN;
  const pattern =
    /^P(?:(\d+(?:\.\d+)?)Y)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)W)?(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/;
  const match = pattern.exec(iso);
  if (!match) return NaN;
  const [, years, months, weeks, days, hours, minutes, seconds] = match;
  const toNum = (s: string | undefined): number => (s === undefined ? 0 : parseFloat(s));
  return (
    toNum(years) * 365 * 24 * 3600 +
    toNum(months) * 30 * 24 * 3600 +
    toNum(weeks) * 7 * 24 * 3600 +
    toNum(days) * 24 * 3600 +
    toNum(hours) * 3600 +
    toNum(minutes) * 60 +
    toNum(seconds)
  );
}
