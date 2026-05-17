// SPDX-License-Identifier: MIT
//
// bench/B10-import-replacement/tasks/validate-rfc5321-email/arm-a/medium.mjs
//
// @decision DEC-BENCH-B10-SLICE2-ARMA-FALLBACK-001
// @title Arm A-medium produced via hand-translation fallback (not yakcc compile + #508 hook)
// @status accepted
// @rationale
//   Same fallback provenance as arm-a/fine.mjs. See that file's decision block for full
//   rationale. GRANULARITY: A-medium -- two or three composite functions (local-part
//   validator, domain validator, entry wrapper). Zero non-builtin imports.
//
//   Cross-references: plans/wi-512-s2-b10-demo-task.md S3.4

const MAX_EMAIL_LENGTH = 254;
const MAX_USER_LENGTH = 64;
const MAX_DOMAIN_LENGTH = 253;
const EMAIL_USER_UTF8_PART = /^[a-z\d!#$%&'*+\-/=?^_`{|}~¡-퟿豈-﷏ﷰ-￯]+$/i;

/**
 * Composite: validate local-part and domain in one pass.
 * Returns null if structure is invalid, or { user, domain } if parseable.
 * @param {string} email
 * @returns {{ user: string, domain: string } | null}
 */
export function parseEmailParts(email) {
  if (email.length > MAX_EMAIL_LENGTH) return null;
  const atIdx = email.lastIndexOf("@");
  if (atIdx < 1) return null;
  const user = email.slice(0, atIdx);
  const domain = email.slice(atIdx + 1);
  if (!user || !domain) return null;
  return { user, domain };
}

/**
 * Composite: validate the local-part of an email address.
 * Accepts quoted strings and dotted-segments of UTF-8-allowed chars.
 * @param {string} user
 * @returns {boolean}
 */
export function isValidLocalPart(user) {
  if (user.length > MAX_USER_LENGTH) return false;
  if (user.startsWith('"') && user.endsWith('"')) {
    const inner = user.slice(1, -1);
    return /^([\s\x01-\x08\x0b\x0c\x0e-\x1f\x7f\x21\x23-\x5b\x5d-\x7e -퟿豈-﷏ﷰ-￯]|(\[\x01-\x09\x0b\x0c\x0d-\x7f -퟿豈-﷏ﷰ-￯]))*$/i.test(inner);
  }
  return user.split(".").every((p) => p && EMAIL_USER_UTF8_PART.test(p));
}

/**
 * Composite: validate a domain as a fully-qualified domain name (require_tld=true).
 * @param {string} domain
 * @returns {boolean}
 */
export function isValidDomain(domain) {
  if (!domain || domain.length > MAX_DOMAIN_LENGTH) return false;
  const parts = domain.endsWith(".") ? domain.slice(0, -1).split(".") : domain.split(".");
  if (parts.length < 2) return false;
  const tld = parts[parts.length - 1];
  if (!/^[a-z¡-퟿豈-﷏ﷰ-￯]{2,}$/i.test(tld)) return false;
  return parts.every(
    (l) => l && l.length <= 63 && !l.startsWith("-") && !l.endsWith("-") &&
           /^[a-z\d¡-퟿豈-﷏ﷰ-￯][a-z\d\-¡-퟿豈-﷏ﷰ-￯]*$/i.test(l)
  );
}

/**
 * Entry point: validate an RFC 5321 email address.
 * @param {string} input
 * @returns {boolean}
 */
export function validateRfc5321Email(input) {
  if (typeof input !== "string") return false;
  const parts = parseEmailParts(input);
  if (!parts) return false;
  if (!isValidLocalPart(parts.user)) return false;
  if (!isValidDomain(parts.domain)) return false;
  return true;
}

export default validateRfc5321Email;
