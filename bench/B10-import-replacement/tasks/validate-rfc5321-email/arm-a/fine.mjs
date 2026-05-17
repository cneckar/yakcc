// SPDX-License-Identifier: MIT
//
// bench/B10-import-replacement/tasks/validate-rfc5321-email/arm-a/fine.mjs
//
// @decision DEC-BENCH-B10-SLICE2-ARMA-FALLBACK-001
// @title Arm A-fine produced via hand-translation fallback (not yakcc compile + #508 hook)
// @status accepted
// @rationale
//   The production end-to-end CLI path (yakcc compile + #508 import-intercept hook + WI-510
//   atom registry) is not wired end-to-end at S2 implementation time. No test today drives
//   a yakcc-compile run that consumes a WI-510-seeded registry and emits a .mjs Arm A artifact.
//   This file is produced via the documented B9 precedent: hand-translation of the shaved
//   isEmail subgraph from WI-510 S2 fixture (packages/shave/src/__fixtures__/module-graph/
//   validator-13.15.35/lib/isEmail.js) into a zero-npm-import .mjs with the same semantics
//   as validator.isEmail(input, { default options }).
//
//   DEFAULT OPTIONS used by the spec (no display name, allow_utf8_local_part=true,
//   require_tld=true, blacklisted_chars='', ignore_max_length=false):
//   This matches the strict RFC 5321 behavior described in spec.yak.
//
//   GRANULARITY: A-fine -- one exported function per RFC 5321 sub-rule / structural concern.
//   Six to eight small named functions composing into the entry.
//   Zero non-builtin imports -- reachable_files == 1 when measured by measure-transitive-surface.
//
//   Cross-references:
//   DEC-BENCH-B10-SLICE2-DEMO-LIBRARY-001 -- corpus-spec.json (task entry)
//   DEC-BENCH-B10-SLICE2-CLASSIFIER-DRYRUN-001 -- harness/classify-arm-b.mjs
//   plans/wi-512-s2-b10-demo-task.md S3.3 (fallback rationale)
//   bench/B9-min-surface/tasks/parse-coord-pair/arm-a/fine.mjs (pattern source)

/** Max total email length per RFC 5321 / validator default. */
const MAX_EMAIL_LENGTH = 254;
/** Max local-part (user) length per RFC 5321. */
const MAX_USER_LENGTH = 64;
/** Max domain length. */
const MAX_DOMAIN_LENGTH = 253;

/** Atom: RFC 5321 local-part character class (allow_utf8_local_part=true default). */
const EMAIL_USER_UTF8_PART = /^[a-z\d!#$%&'*+\-/=?^_`{|}~¡-퟿豈-﷏ﷰ-￯]+$/i;

/**
 * Atom: check overall email length is within the RFC 5321 limit.
 * @param {string} email
 * @returns {boolean}
 */
export function checkEmailLength(email) {
  return email.length <= MAX_EMAIL_LENGTH;
}

/**
 * Atom: split email on the last '@' into local-part and domain.
 * Returns null if the structure is invalid (no '@', empty halves).
 * @param {string} email
 * @returns {{ user: string, domain: string } | null}
 */
export function splitAtSign(email) {
  const atIdx = email.lastIndexOf("@");
  if (atIdx < 1) return null;
  const user = email.slice(0, atIdx);
  const domain = email.slice(atIdx + 1);
  if (!user || !domain) return null;
  return { user, domain };
}

/**
 * Atom: validate local-part length and character content.
 * Dotted segments each tested against emailUserUtf8Part regex.
 * Quoted local parts accepted per RFC 5321.
 * @param {string} user
 * @returns {boolean}
 */
export function validateLocalPart(user) {
  if (user.length > MAX_USER_LENGTH) return false;
  if (user.startsWith('"') && user.endsWith('"')) {
    const inner = user.slice(1, -1);
    // Quoted string: allow printable + selected control chars per RFC 5321
    return /^([\s\x01-\x08\x0b\x0c\x0e-\x1f\x7f\x21\x23-\x5b\x5d-\x7e -퟿豈-﷏ﷰ-￯]|(\[\x01-\x09\x0b\x0c\x0d-\x7f -퟿豈-﷏ﷰ-￯]))*$/i.test(inner);
  }
  const parts = user.split(".");
  for (const part of parts) {
    if (!part || !EMAIL_USER_UTF8_PART.test(part)) return false;
  }
  return true;
}

/**
 * Atom: validate one domain label (between dots).
 * Must not start or end with hyphen; max 63 chars.
 * @param {string} label
 * @returns {boolean}
 */
export function validateDomainLabel(label) {
  if (!label || label.length > 63) return false;
  if (label.startsWith("-") || label.endsWith("-")) return false;
  return /^[a-z\d¡-퟿豈-﷏ﷰ-￯][a-z\d\-¡-퟿豈-﷏ﷰ-￯]*$/i.test(label);
}

/**
 * Atom: validate domain FQDN (require_tld=true, at least 2 labels, TLD >= 2 alpha chars).
 * @param {string} domain
 * @returns {boolean}
 */
export function validateDomain(domain) {
  if (!domain || domain.length > MAX_DOMAIN_LENGTH) return false;
  const parts = domain.endsWith(".") ? domain.slice(0, -1).split(".") : domain.split(".");
  if (parts.length < 2) return false;
  const tld = parts[parts.length - 1];
  if (!/^[a-z¡-퟿豈-﷏ﷰ-￯]{2,}$/i.test(tld)) return false;
  for (const label of parts) {
    if (!validateDomainLabel(label)) return false;
  }
  return true;
}

/**
 * Entry point: validate an RFC 5321 email address.
 * Equivalent to validator.isEmail(input) with default options:
 *   allow_display_name: false, require_display_name: false,
 *   allow_utf8_local_part: true, require_tld: true,
 *   blacklisted_chars: '', ignore_max_length: false.
 *
 * @param {string} input
 * @returns {boolean}
 */
export function validateRfc5321Email(input) {
  if (typeof input !== "string") return false;
  if (!checkEmailLength(input)) return false;
  const parts = splitAtSign(input);
  if (!parts) return false;
  if (!validateLocalPart(parts.user)) return false;
  if (!validateDomain(parts.domain)) return false;
  return true;
}

export default validateRfc5321Email;
