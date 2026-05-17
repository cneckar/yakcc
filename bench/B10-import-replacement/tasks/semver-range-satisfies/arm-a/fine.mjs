// SPDX-License-Identifier: MIT
//
// bench/B10-import-replacement/tasks/semver-range-satisfies/arm-a/fine.mjs
//
// @decision DEC-BENCH-B10-SLICE3-ARMA-FALLBACK-001
// @title Arm A-fine produced via hand-translation fallback (not yakcc compile + #508 hook)
// @status accepted
// @rationale
//   Hand-translation of semver satisfies subgraph (~18 modules) from WI-510 S3.
//   GRANULARITY: A-fine -- 6 named functions covering comparator parsing.
//   Zero non-builtin imports.
//
//   Cross-references:
//   DEC-BENCH-B10-SLICE3-TASK-CORPUS-SELECTION-001 -- corpus-spec.json
//   DEC-WI510-S3-PARSE-COMPONENT-BINDING-001 -- semver subgraph structure
//   plans/wi-512-s3-b10-broaden.md §4

/** Atom: parse a semver version string. Returns { major, minor, patch, prerelease } or null. */
export function parseSemver(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([a-zA-Z0-9.-]+))?(?:\+[a-zA-Z0-9.-]+)?$/.exec((v || '').trim());
  if (!m) return null;
  return { major: +m[1], minor: +m[2], patch: +m[3], prerelease: m[4] ? m[4].split('.') : [] };
}

/** Atom: compare two semver objects. Returns -1, 0, or 1. */
export function compareSemver(a, b) {
  for (const k of ['major', 'minor', 'patch']) {
    if (a[k] !== b[k]) return a[k] < b[k] ? -1 : 1;
  }
  // prerelease: no-prerelease > prerelease
  if (!a.prerelease.length && b.prerelease.length) return 1;
  if (a.prerelease.length && !b.prerelease.length) return -1;
  for (let i = 0; i < Math.max(a.prerelease.length, b.prerelease.length); i++) {
    const ai = a.prerelease[i]; const bi = b.prerelease[i];
    if (ai === undefined) return -1;
    if (bi === undefined) return 1;
    const aNum = /^\d+$/.test(ai); const bNum = /^\d+$/.test(bi);
    if (aNum && bNum) { if (+ai !== +bi) return +ai < +bi ? -1 : 1; }
    else if (ai !== bi) return ai < bi ? -1 : 1;
  }
  return 0;
}

/** Atom: check a single comparator like ">=1.2.3". */
export function checkComparator(version, comparator) {
  const m = /^(==?|!=|>=?|<=?|~\^?|\^)(.+)$/.exec(comparator.trim());
  if (!m) return false;
  const op = m[1]; const target = parseSemver(m[2]);
  if (!target) return false;
  const cmp = compareSemver(version, target);
  switch (op) {
    case '=': case '==': return cmp === 0;
    case '!=': return cmp !== 0;
    case '>': return cmp > 0;
    case '>=': return cmp >= 0;
    case '<': return cmp < 0;
    case '<=': return cmp <= 0;
    default: return false;
  }
}

/** Atom: split range into OR groups (|| separated). */
export function splitRangeOrGroups(range) {
  return range.split('||').map((s) => s.trim());
}

/** Atom: check version against one AND-group of comparators (space-separated). */
export function checkAndGroup(version, group) {
  if (!group || group === '*' || group === '') return true;
  const parts = group.trim().split(/\s+/);
  return parts.every((c) => checkComparator(version, c));
}

/**
 * Entry: check if a semver version satisfies a range.
 * @param {string} version
 * @param {string} range
 * @returns {boolean}
 */
export function semverRangeSatisfies(version, range) {
  const v = parseSemver(version);
  if (!v) return false;
  if (!range || range === '*') return true;
  const groups = splitRangeOrGroups(range);
  return groups.some((g) => checkAndGroup(v, g));
}

export default semverRangeSatisfies;
