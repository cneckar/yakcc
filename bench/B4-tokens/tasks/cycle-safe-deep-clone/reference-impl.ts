// SPDX-License-Identifier: MIT
//
// bench/B4-tokens/tasks/cycle-safe-deep-clone/reference-impl.ts
//
// @decision DEC-B4-SLICE-3-TASKS-001
// @title B4 Slice 3 task corpus: cycle-safe-deep-clone reference implementation
// @status accepted
// @rationale
//   Reference implementation for oracle validation. Proves the oracle correctly
//   distinguishes cycle-safe deep-clone implementations from broken ones. Hand-written
//   from lodash's documented cloneDeep semantics; not LLM-generated or copied from
//   the lodash npm package (per DEC-BENCH-METHODOLOGY-NEVER-SYNTHETIC-001).
//
//   WI-510 atom backing: lodash Slice 7 — cloneDeep.js (top-level clone entry) and
//   _baseClone.js (recursive type dispatch + WeakMap cycle detection). The benchmark
//   tests whether the hooked LLM arm substitutes these shaved atoms rather than
//   regenerating the recursive type-dispatch from scratch.
//
//   Adversarial traps exercised by the oracle:
//   1. Cycle detection: a.self = a → cloned.self === cloned (WeakMap visited set)
//   2. Date → must be instanceof Date, not a string (JSON.stringify path loses Date)
//   3. RegExp → instanceof RegExp with source/flags preserved
//   4. Map/Set → instanceof Map/Set with entries cloned
//   5. undefined property values → Object.hasOwn(clone, "a") stays true
//   6. Symbol-keyed properties → preserved via Object.getOwnPropertySymbols
//   7. Class prototype chain → Object.getPrototypeOf(clone) === Object.getPrototypeOf(original)
//   8. Functions → returned by reference (clone.fn === original.fn)

/**
 * Determine the [[Class]] tag of a value for type dispatch.
 * Uses Object.prototype.toString which is reliable across realms.
 */
function getTag(value: unknown): string {
  return Object.prototype.toString.call(value);
}

const ARRAY_TAG = "[object Array]";
const OBJECT_TAG = "[object Object]";
const DATE_TAG = "[object Date]";
const REGEXP_TAG = "[object RegExp]";
const MAP_TAG = "[object Map]";
const SET_TAG = "[object Set]";
const ARRAYBUFFER_TAG = "[object ArrayBuffer]";

// Typed array tags — all must be detected for slicing
const TYPED_ARRAY_TAGS = new Set([
  "[object Int8Array]",
  "[object Uint8Array]",
  "[object Uint8ClampedArray]",
  "[object Int16Array]",
  "[object Uint16Array]",
  "[object Int32Array]",
  "[object Uint32Array]",
  "[object Float32Array]",
  "[object Float64Array]",
  "[object BigInt64Array]",
  "[object BigUint64Array]",
]);

/**
 * Internal recursive clone function.
 *
 * @param value   - The value to clone
 * @param visited - WeakMap tracking original→clone pairs for cycle detection
 */
function baseClone<T>(value: T, visited: WeakMap<object, unknown>): T {
  // Primitives, functions, symbols — return by reference
  if (value === null || typeof value !== "object" && typeof value !== "function") {
    return value;
  }

  // Functions — returned by reference per lodash.cloneDeep documented behavior
  if (typeof value === "function") {
    return value;
  }

  const obj = value as object;

  // Cycle detection: if we've already seen this object, return the in-progress clone
  if (visited.has(obj)) {
    return visited.get(obj) as T;
  }

  const tag = getTag(obj);

  // Date: clone preserving millisecond timestamp
  if (tag === DATE_TAG) {
    const cloned = new Date((obj as Date).getTime());
    visited.set(obj, cloned);
    return cloned as unknown as T;
  }

  // RegExp: clone preserving source and flags; reset lastIndex
  if (tag === REGEXP_TAG) {
    const re = obj as RegExp;
    const cloned = new RegExp(re.source, re.flags);
    cloned.lastIndex = 0;
    visited.set(obj, cloned);
    return cloned as unknown as T;
  }

  // ArrayBuffer: clone via slice
  if (tag === ARRAYBUFFER_TAG) {
    const cloned = (obj as ArrayBuffer).slice(0);
    visited.set(obj, cloned);
    return cloned as unknown as T;
  }

  // Typed arrays: clone via buffer slice
  if (TYPED_ARRAY_TAGS.has(tag)) {
    const ta = obj as Int8Array; // use Int8Array as proxy for typed array interface
    const cloned = new (Object.getPrototypeOf(ta).constructor as new (buf: ArrayBuffer) => Int8Array)(
      ta.buffer.slice(0),
    );
    visited.set(obj, cloned);
    return cloned as unknown as T;
  }

  // Array: create empty array, register in visited BEFORE recursing (cycle-safety)
  if (tag === ARRAY_TAG || Array.isArray(obj)) {
    const arr = obj as unknown[];
    const cloned: unknown[] = new Array(arr.length);
    visited.set(obj, cloned);
    for (let i = 0; i < arr.length; i++) {
      // Preserve sparse array holes
      if (Object.prototype.hasOwnProperty.call(arr, i)) {
        cloned[i] = baseClone(arr[i], visited);
      }
    }
    return cloned as unknown as T;
  }

  // Map: clone entries
  if (tag === MAP_TAG) {
    const map = obj as Map<unknown, unknown>;
    const cloned = new Map<unknown, unknown>();
    visited.set(obj, cloned);
    for (const [k, v] of map) {
      cloned.set(baseClone(k, visited), baseClone(v, visited));
    }
    return cloned as unknown as T;
  }

  // Set: clone values
  if (tag === SET_TAG) {
    const set = obj as Set<unknown>;
    const cloned = new Set<unknown>();
    visited.set(obj, cloned);
    for (const v of set) {
      cloned.add(baseClone(v, visited));
    }
    return cloned as unknown as T;
  }

  // Plain objects and class instances:
  // Preserve prototype chain via Object.create(Object.getPrototypeOf(original))
  const proto = Object.getPrototypeOf(obj) as object | null;
  const cloned: Record<string | symbol, unknown> = Object.create(proto);
  // Register BEFORE recursing into properties (cycle-safety)
  visited.set(obj, cloned);

  // Clone own string-keyed properties (both enumerable and non-enumerable)
  for (const key of Object.getOwnPropertyNames(obj)) {
    cloned[key] = baseClone((obj as Record<string, unknown>)[key], visited);
  }

  // Clone own symbol-keyed properties
  for (const sym of Object.getOwnPropertySymbols(obj)) {
    cloned[sym] = baseClone((obj as Record<symbol, unknown>)[sym], visited);
  }

  return cloned as unknown as T;
}

/**
 * Deep-clone a JavaScript value with cycle safety and full type fidelity.
 *
 * Matching lodash.cloneDeep semantics:
 * - Primitives and functions returned by reference
 * - Date, RegExp, Map, Set, ArrayBuffer, typed arrays cloned correctly
 * - Symbol-keyed and undefined-valued properties preserved
 * - Prototype chain preserved for class instances
 * - Cycles handled via WeakMap visited set (no stack overflow)
 *
 * @param value - The value to deep-clone
 * @returns A deep clone of `value`
 */
export default function deepClone<T>(value: T): T {
  const visited = new WeakMap<object, unknown>();
  return baseClone(value, visited);
}
