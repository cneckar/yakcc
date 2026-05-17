// SPDX-License-Identifier: MIT
//
// bench/B10-import-replacement/tasks/semver-range-satisfies/arm-a/medium.mjs
//
// @decision DEC-BENCH-B10-SLICE3-ARMA-FALLBACK-001
// @title Arm A-medium produced via hand-translation fallback (not yakcc compile + #508 hook)
// @status accepted
// @rationale Same fallback as fine.mjs. GRANULARITY: A-medium. Zero non-builtin imports.

function parseSemver(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([a-zA-Z0-9.-]+))?/.exec((v || '').trim());
  if (!m) return null;
  return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] ? m[4].split('.') : [] };
}

function cmp(a, b) {
  for (const k of ['major', 'minor', 'patch']) { if (a[k] !== b[k]) return a[k] < b[k] ? -1 : 1; }
  if (!a.pre.length && b.pre.length) return 1;
  if (a.pre.length && !b.pre.length) return -1;
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    const ai = a.pre[i]; const bi = b.pre[i];
    if (ai === undefined) return -1; if (bi === undefined) return 1;
    if (/^\d+$/.test(ai) && /^\d+$/.test(bi)) { if (+ai !== +bi) return +ai < +bi ? -1 : 1; }
    else if (ai !== bi) return ai < bi ? -1 : 1;
  }
  return 0;
}

export function checkRangeGroup(v, group) {
  if (!group || group === '*' || group === '') return true;
  return group.trim().split(/\s+/).every((c) => {
    const m = /^(==?|!=|>=?|<=?)(.+)$/.exec(c.trim());
    if (!m) return false;
    const t = parseSemver(m[2]); if (!t) return false;
    const r = cmp(v, t);
    switch (m[1]) {
      case '=': case '==': return r === 0;
      case '!=': return r !== 0;
      case '>': return r > 0; case '>=': return r >= 0;
      case '<': return r < 0; case '<=': return r <= 0;
      default: return false;
    }
  });
}

export function semverRangeSatisfies(version, range) {
  const v = parseSemver(version); if (!v) return false;
  if (!range || range === '*') return true;
  return range.split('||').map((s) => s.trim()).some((g) => checkRangeGroup(v, g));
}

export default semverRangeSatisfies;
