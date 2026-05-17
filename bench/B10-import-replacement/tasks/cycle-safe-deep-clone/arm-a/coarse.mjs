// SPDX-License-Identifier: MIT
//
// bench/B10-import-replacement/tasks/cycle-safe-deep-clone/arm-a/coarse.mjs
//
// @decision DEC-BENCH-B10-SLICE3-ARMA-FALLBACK-001
// @title Arm A-coarse produced via hand-translation fallback (not yakcc compile + #508 hook)
// @status accepted
// @rationale Same fallback as fine.mjs. GRANULARITY: A-coarse. Zero non-builtin imports.

export function cycleSafeDeepClone(value, seen = new Map()) {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return value;
  if (seen.has(value)) return seen.get(value);
  const tag = Object.prototype.toString.call(value);
  if (tag === '[object Date]') return new Date(value.getTime());
  if (tag === '[object RegExp]') { const r = new RegExp(value.source, value.flags); r.lastIndex = value.lastIndex; return r; }
  if (tag === '[object Map]') {
    const m = new Map(); seen.set(value, m);
    value.forEach((v, k) => m.set(cycleSafeDeepClone(k, seen), cycleSafeDeepClone(v, seen)));
    return m;
  }
  if (tag === '[object Set]') {
    const s = new Set(); seen.set(value, s);
    value.forEach((v) => s.add(cycleSafeDeepClone(v, seen)));
    return s;
  }
  const isArr = Array.isArray(value);
  const result = isArr ? [] : Object.create(Object.getPrototypeOf(value));
  seen.set(value, result);
  const keys = isArr ? [...value.keys()] : Object.keys(value);
  for (const k of keys) result[k] = cycleSafeDeepClone(value[k], seen);
  return result;
}

export default cycleSafeDeepClone;
