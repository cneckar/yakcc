// SPDX-License-Identifier: MIT
//
// bench/B10-import-replacement/tasks/coerce-semver/arm-a/fine.mjs
//
// @decision DEC-BENCH-B10-SLICE3-ARMA-FALLBACK-001
// @title Arm A-fine produced via hand-translation fallback (not yakcc compile + #508 hook)
// @status accepted
// @rationale
//   Hand-translation of semver coerce subgraph (~8 modules) from WI-510 S3.
//   GRANULARITY: A-fine -- 4 named functions. Zero non-builtin imports.
//
//   Cross-references:
//   DEC-BENCH-B10-SLICE3-TASK-CORPUS-SELECTION-001 -- corpus-spec.json
//   plans/wi-512-s3-b10-broaden.md §4

/**
 * Atom: extract first semver-like pattern from a string.
 * @param {string} s
 * @returns {{ major: string, minor: string, patch: string } | null}
 */
export function extractSemverPattern(s) {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(s);
  if (m) return { major: m[1], minor: m[2], patch: m[3] };
  const m2 = /(\d+)\.(\d+)(?!\.\d)/.exec(s);
  if (m2) return { major: m2[1], minor: m2[2], patch: '0' };
  const m3 = /(\d+)/.exec(s);
  if (m3) return { major: m3[1], minor: '0', patch: '0' };
  return null;
}

/**
 * Atom: normalize to major.minor.patch string.
 * @param {{ major: string, minor: string, patch: string }} parts
 * @returns {string}
 */
export function normalizeSemver(parts) {
  return parts.major + '.' + parts.minor + '.' + parts.patch;
}

/**
 * Atom: strip leading 'v' from version string.
 * @param {string} s
 * @returns {string}
 */
export function stripLeadingV(s) {
  return s.replace(/^v/i, '');
}

/**
 * Entry: coerce a string into a semver string, or null.
 * @param {string} version
 * @returns {string | null}
 */
export function coerceSemver(version) {
  if (typeof version !== 'string') return null;
  const stripped = stripLeadingV(version.trim());
  const parts = extractSemverPattern(stripped);
  if (!parts) return null;
  return normalizeSemver(parts);
}

export default coerceSemver;
