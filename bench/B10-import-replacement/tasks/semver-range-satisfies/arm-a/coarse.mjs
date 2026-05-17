// SPDX-License-Identifier: MIT
//
// bench/B10-import-replacement/tasks/semver-range-satisfies/arm-a/coarse.mjs
//
// @decision DEC-BENCH-B10-SLICE3-ARMA-FALLBACK-001
// @title Arm A-coarse produced via hand-translation fallback (not yakcc compile + #508 hook)
// @status accepted
// @rationale Same fallback as fine.mjs. GRANULARITY: A-coarse. Zero non-builtin imports.

export function semverRangeSatisfies(version, range) {
  const parse = (v) => {
    const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([a-zA-Z0-9.-]+))?/.exec((v || '').trim());
    return m ? { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] ? m[4].split('.') : [] } : null;
  };
  const cmpV = (a, b) => {
    for (const k of ['major', 'minor', 'patch']) { if (a[k] !== b[k]) return a[k] < b[k] ? -1 : 1; }
    if (!a.pre.length && b.pre.length) return 1; if (a.pre.length && !b.pre.length) return -1;
    return 0;
  };
  const v = parse(version); if (!v) return false;
  if (!range || range === '*') return true;
  return range.split('||').map((s) => s.trim()).some((g) => {
    if (!g || g === '*') return true;
    return g.trim().split(/\s+/).every((c) => {
      const m = /^(==?|!=|>=?|<=?)(.+)$/.exec(c.trim());
      if (!m) return false;
      const t = parse(m[2]); if (!t) return false;
      const r = cmpV(v, t);
      switch (m[1]) {
        case '=': case '==': return r === 0; case '!=': return r !== 0;
        case '>': return r > 0; case '>=': return r >= 0;
        case '<': return r < 0; case '<=': return r <= 0; default: return false;
      }
    });
  });
}

export default semverRangeSatisfies;
