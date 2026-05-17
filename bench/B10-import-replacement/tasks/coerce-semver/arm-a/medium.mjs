// SPDX-License-Identifier: MIT
//
// bench/B10-import-replacement/tasks/coerce-semver/arm-a/medium.mjs
//
// @decision DEC-BENCH-B10-SLICE3-ARMA-FALLBACK-001
// @title Arm A-medium produced via hand-translation fallback (not yakcc compile + #508 hook)
// @status accepted
// @rationale Same fallback as fine.mjs. GRANULARITY: A-medium. Zero non-builtin imports.

export function parseSemverParts(s) {
  const full = /(\d+)\.(\d+)\.(\d+)/.exec(s);
  if (full) return [full[1], full[2], full[3]];
  const mm = /(\d+)\.(\d+)(?!\.\d)/.exec(s);
  if (mm) return [mm[1], mm[2], '0'];
  const maj = /(\d+)/.exec(s);
  if (maj) return [maj[1], '0', '0'];
  return null;
}

export function coerceSemver(version) {
  if (typeof version !== 'string') return null;
  const s = version.trim().replace(/^v/i, '');
  const parts = parseSemverParts(s);
  return parts ? parts.join('.') : null;
}

export default coerceSemver;
