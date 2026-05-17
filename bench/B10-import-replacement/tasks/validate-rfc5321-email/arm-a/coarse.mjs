// SPDX-License-Identifier: MIT
//
// bench/B10-import-replacement/tasks/validate-rfc5321-email/arm-a/coarse.mjs
//
// @decision DEC-BENCH-B10-SLICE2-ARMA-FALLBACK-001
// @title Arm A-coarse produced via hand-translation fallback (not yakcc compile + #508 hook)
// @status accepted
// @rationale
//   Same fallback provenance as arm-a/fine.mjs. See that file's decision block for full
//   rationale. GRANULARITY: A-coarse -- single entry function inlining the whole validation.
//   Zero non-builtin imports.
//
//   Cross-references: plans/wi-512-s2-b10-demo-task.md S3.4

/**
 * Validate an RFC 5321 email address (single-function coarse granularity).
 * Equivalent to validator.isEmail(input) with default options.
 *
 * @decision DEC-BENCH-B10-SLICE2-ARMA-FALLBACK-001
 * @param {string} input
 * @returns {boolean}
 */
export function validateRfc5321Email(input) {
  if (typeof input !== "string") return false;
  if (input.length > 254) return false;
  const atIdx = input.lastIndexOf("@");
  if (atIdx < 1) return false;
  const user = input.slice(0, atIdx);
  const domain = input.slice(atIdx + 1);
  if (!user || !domain) return false;

  // Validate local-part
  if (user.length > 64) return false;
  if (user.startsWith('"') && user.endsWith('"')) {
    const inner = user.slice(1, -1);
    if (!/^([\s\x01-\x08\x0b\x0c\x0e-\x1f\x7f\x21\x23-\x5b\x5d-\x7e]|(\[\x01-\x09\x0b\x0c\x0d-\x7f]))*$/i.test(inner)) return false;
  } else {
    const emailPart = /^[a-z\d!#$%&'*+\-/=?^_`{|}~¡-퟿豈-﷏ﷰ-￯]+$/i;
    const segments = user.split(".");
    for (const seg of segments) {
      if (!seg || !emailPart.test(seg)) return false;
    }
  }

  // Validate domain as FQDN (require_tld=true)
  if (domain.length > 253) return false;
  const labels = domain.endsWith(".") ? domain.slice(0, -1).split(".") : domain.split(".");
  if (labels.length < 2) return false;
  const tld = labels[labels.length - 1];
  if (!/^[a-z¡-퟿豈-﷏ﷰ-￯]{2,}$/i.test(tld)) return false;
  for (const label of labels) {
    if (!label || label.length > 63) return false;
    if (label.startsWith("-") || label.endsWith("-")) return false;
    if (!/^[a-z\d¡-퟿豈-﷏ﷰ-￯][a-z\d\-¡-퟿豈-﷏ﷰ-￯]*$/i.test(label)) return false;
  }
  return true;
}

export default validateRfc5321Email;
