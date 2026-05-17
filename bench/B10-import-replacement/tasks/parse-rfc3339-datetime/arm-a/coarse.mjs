// SPDX-License-Identifier: MIT
//
// bench/B10-import-replacement/tasks/parse-rfc3339-datetime/arm-a/coarse.mjs
//
// @decision DEC-BENCH-B10-SLICE3-ARMA-FALLBACK-001
// @title Arm A-coarse produced via hand-translation fallback (not yakcc compile + #508 hook)
// @status accepted
// @rationale Same fallback as fine.mjs. GRANULARITY: A-coarse. Zero non-builtin imports.

export function parseRfc3339Datetime(dateString) {
  const s = (dateString || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const p = s.split('-').map(Number);
    return new Date(Date.UTC(p[0], p[1] - 1, p[2]));
  }
  const tIdx = s.search(/T/i);
  if (tIdx === -1) throw new RangeError('Invalid ISO date string: ' + dateString);
  const dp = s.slice(0, tIdx).split('-').map(Number);
  const rest = s.slice(tIdx + 1);
  const tzm = /(Z|[+-]\d{2}:\d{2})$/.exec(rest);
  const tz = tzm ? tzm[1] : '';
  const tp = rest.slice(0, rest.length - tz.length);
  const tm = /^(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?/.exec(tp);
  if (!tm) throw new RangeError('Invalid time: ' + tp);
  const ms = tm[4] ? parseInt(tm[4].padEnd(3, '0'), 10) : 0;
  let off = 0;
  if (tz && tz !== 'Z') {
    const sign = tz[0] === '+' ? 1 : -1;
    const op = tz.slice(1).split(':').map(Number);
    off = sign * (op[0] * 60 + (op[1] || 0));
  }
  return new Date(Date.UTC(dp[0], dp[1] - 1, dp[2], +tm[1], +tm[2] - off, +tm[3], ms));
}

export default parseRfc3339Datetime;
