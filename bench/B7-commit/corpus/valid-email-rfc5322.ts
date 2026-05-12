// SPDX-License-Identifier: MIT

/**
 * Validate whether a string is a plausible RFC 5322 email address using a
 * structural heuristic: local-part@domain where local-part is non-empty,
 * domain has at least one dot, each label is non-empty, and no label exceeds
 * 63 characters. Quoted local parts and IP-literal domains are not supported.
 *
 * @param email - The string to validate.
 * @returns True if the string looks like a valid RFC 5322 email; false otherwise.
 */
export function isValidEmailRfc5322(email: string): boolean {
  if (typeof email !== "string" || email.length === 0 || email.length > 254) return false;
  const atIdx = email.lastIndexOf("@");
  if (atIdx <= 0 || atIdx === email.length - 1) return false;
  const local = email.slice(0, atIdx);
  const domain = email.slice(atIdx + 1);
  // Local part: printable ASCII, no consecutive dots, not starting/ending with dot
  if (local.length > 64) return false;
  if (local.startsWith(".") || local.endsWith(".") || local.includes("..")) return false;
  if (!/^[\x21-\x7E]+$/.test(local)) return false;
  // Domain: labels separated by dots, each 1–63 alphanum+hyphen chars, no leading/trailing hyphen
  const labels = domain.split(".");
  if (labels.length < 2) return false;
  for (const label of labels) {
    if (label.length === 0 || label.length > 63) return false;
    if (label.startsWith("-") || label.endsWith("-")) return false;
    if (!/^[A-Za-z0-9-]+$/.test(label)) return false;
  }
  return true;
}
