// SPDX-License-Identifier: MIT

/**
 * Convert a string to an ASCII URL slug: lowercase, non-ASCII characters
 * stripped, runs of non-alphanumeric characters collapsed to a single hyphen,
 * with leading and trailing hyphens removed. An empty input or an input that
 * produces no alphanumeric content returns an empty string.
 *
 * @param text - The input string to slugify.
 * @returns ASCII slug, e.g. "Hello, World!" → "hello-world".
 */
export function slugifyAscii(text: string): string {
  if (typeof text !== "string" || text.length === 0) return "";
  // Strip non-ASCII bytes, lowercase
  let s = text.replace(/[^\x00-\x7F]/g, "").toLowerCase();
  // Replace runs of non-alphanumeric characters with a single hyphen
  s = s.replace(/[^a-z0-9]+/g, "-");
  // Trim leading and trailing hyphens
  s = s.replace(/^-+|-+$/g, "");
  return s;
}
