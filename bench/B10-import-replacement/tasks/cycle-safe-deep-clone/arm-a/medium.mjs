// SPDX-License-Identifier: MIT
//
// bench/B10-import-replacement/tasks/cycle-safe-deep-clone/arm-a/medium.mjs
//
// @decision DEC-BENCH-B10-SLICE3-ARMA-FALLBACK-001
// @title Arm A-medium produced via hand-translation fallback (not yakcc compile + #508 hook)
// @status accepted
// @rationale Same fallback as fine.mjs. GRANULARITY: A-medium. Zero non-builtin imports.

function cloneValue(value, seen) {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return value;
  if (seen.has(value)) return seen.get(value);
  const tag = Object.prototype.toString.call(value);
  if (tag === '[object Date]') return new Date(value.getTime());
  if (tag === '[object RegExp]') { const r = new RegExp(value.source, value.flags); r.lastIndex = value.lastIndex; return r; }
  return cloneStructure(value, seen, tag);
}

export function cloneStructure(value, seen, tag) {
  if (tag === '[object Map]') {
    const m = new Map(); seen.set(value, m);
    value.forEach((v, k) => m.set(cloneValue(k, seen), cloneValue(v, seen)));
    return m;
  }
  if (tag === '[object Set]') {
    const s = new Set(); seen.set(value, s);
    value.forEach((v) => s.add(cloneValue(v, seen)));
    return s;
  }
  const isArr = Array.isArray(value);
  const result = isArr ? [] : Object.create(Object.getPrototypeOf(value));
  seen.set(value, result);
  const keys = isArr ? [...value.keys()] : Object.keys(value);
  for (const k of keys) result[k] = cloneValue(value[k], seen);
  return result;
}

export function cycleSafeDeepClone(value) {
  return cloneValue(value, new Map());
}

export default cycleSafeDeepClone;
