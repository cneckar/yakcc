// SPDX-License-Identifier: MIT
//
// bench/B10-import-replacement/tasks/parse-rfc3339-datetime/arm-a/medium.mjs
//
// @decision DEC-BENCH-B10-SLICE3-ARMA-FALLBACK-001
// @title Arm A-medium produced via hand-translation fallback (not yakcc compile + #508 hook)
// @status accepted
// @rationale Same fallback as fine.mjs. GRANULARITY: A-medium. Zero non-builtin imports.

function parseTz(tz) {
  if (!tz || tz === 'Z') return 0;
  const sign = tz[0] === '+' ? 1 : -1;
  const p = tz.slice(1).split(':').map(Number);
  return sign * (p[0] * 60 + (p[1] || 0));
}

export function splitIsoString(s) {
  s = (s || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return { datePart: s, timePart: '00:00:00', tz: 'Z', dateOnly: true };
  const tIdx = s.search(/T/i);
  if (tIdx === -1) throw new RangeError('Invalid ISO date string: ' + s);
  const datePart = s.slice(0, tIdx);
  const rest = s.slice(tIdx + 1);
  const tzMatch = /(Z|[+-]\d{2}:\d{2})$/.exec(rest);
  const tz = tzMatch ? tzMatch[1] : '';
  return { datePart, timePart: rest.slice(0, rest.length - tz.length), tz, dateOnly: false };
}

export function parseRfc3339Datetime(dateString) {
  const { datePart, timePart, tz, dateOnly } = splitIsoString(dateString);
  const dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(datePart);
  if (!dm) throw new RangeError('Invalid date part: ' + datePart);
  const [, y, mo, d] = dm.map(Number);
  if (dateOnly) return new Date(Date.UTC(y, mo - 1, d));
  const tm = /^(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?/.exec(timePart);
  if (!tm) throw new RangeError('Invalid time part: ' + timePart);
  const ms = tm[4] ? parseInt(tm[4].padEnd(3, '0'), 10) : 0;
  const off = parseTz(tz);
  return new Date(Date.UTC(y, mo - 1, d, +tm[1], +tm[2] - off, +tm[3], ms));
}

export default parseRfc3339Datetime;
