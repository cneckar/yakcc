// SPDX-License-Identifier: MIT
//
// bench/B10-import-replacement/tasks/cycle-safe-deep-clone/arm-a/fine.mjs
//
// @decision DEC-BENCH-B10-SLICE3-ARMA-FALLBACK-001
// @title Arm A-fine produced via hand-translation fallback (not yakcc compile + #508 hook)
// @status accepted
// @rationale
//   Hand-translation of lodash cloneDeep subgraph from WI-510 S7.
//   GRANULARITY: A-fine -- 7 named functions. Zero non-builtin imports.
//
//   Cross-references:
//   DEC-BENCH-B10-SLICE3-TASK-CORPUS-SELECTION-001 -- corpus-spec.json
//   plans/wi-512-s3-b10-broaden.md §4

/** Atom: detect object tag. */
export function getTag(value) {
  if (value === null) return '[object Null]';
  if (value === undefined) return '[object Undefined]';
  return Object.prototype.toString.call(value);
}

/** Atom: check if value is a plain object. */
export function isPlainObject(value) {
  if (typeof value !== 'object' || value === null) return false;
  const tag = getTag(value);
  return tag === '[object Object]';
}

/** Atom: clone a Date. */
export function cloneDate(d) {
  return new Date(d.getTime());
}

/** Atom: clone a RegExp. */
export function cloneRegExp(r) {
  const result = new RegExp(r.source, r.flags);
  result.lastIndex = r.lastIndex;
  return result;
}

/** Atom: clone a Map with cycle tracking. */
export function cloneMap(map, seen) {
  const result = new Map();
  seen.set(map, result);
  map.forEach((v, k) => result.set(cloneDeepWith(k, seen), cloneDeepWith(v, seen)));
  return result;
}

/** Atom: clone a Set with cycle tracking. */
export function cloneSet(set, seen) {
  const result = new Set();
  seen.set(set, result);
  set.forEach((v) => result.add(cloneDeepWith(v, seen)));
  return result;
}

/** Atom: clone an object or array with cycle tracking. */
export function cloneObjectOrArray(value, seen) {
  const isArr = Array.isArray(value);
  const result = isArr ? [] : Object.create(Object.getPrototypeOf(value));
  seen.set(value, result);
  const keys = isArr ? [...value.keys()] : Object.keys(value);
  for (const key of keys) {
    result[key] = cloneDeepWith(value[key], seen);
  }
  return result;
}

/**
 * Entry: deep clone a value with cycle detection.
 * @param {unknown} value
 * @param {Map} [seen]
 * @returns {unknown}
 */
export function cloneDeepWith(value, seen = new Map()) {
  if (value === null || typeof value !== 'object' && typeof value !== 'function') return value;
  if (seen.has(value)) return seen.get(value);
  const tag = getTag(value);
  if (tag === '[object Date]') return cloneDate(value);
  if (tag === '[object RegExp]') return cloneRegExp(value);
  if (tag === '[object Map]') return cloneMap(value, seen);
  if (tag === '[object Set]') return cloneSet(value, seen);
  return cloneObjectOrArray(value, seen);
}

/**
 * Entry: cycle-safe deep clone.
 * @param {unknown} value
 * @returns {unknown}
 */
export function cycleSafeDeepClone(value) {
  return cloneDeepWith(value, new Map());
}

export default cycleSafeDeepClone;
