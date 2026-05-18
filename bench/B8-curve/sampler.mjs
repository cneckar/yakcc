#!/usr/bin/env node
/**
 * sampler.mjs — Deterministic seeded subset-fraction sampler.
 *
 * @decision DEC-BENCH-B8-CURVE-MONOTONE-SAMPLING-001
 * @title Monotone-stable seeded sampling (shuffle once per seed; take prefix per f).
 * @status accepted
 * @rationale
 *   Independent sampling at each f would introduce churn that obscures the underlying
 *   signal in any single-seed run. Monotone-stable sampling guarantees that the f-sweep
 *   curve is non-decreasing in sampled set membership, isolating the corpus-shape effect
 *   from sampling noise.
 *
 *   Algorithm: mulberry32 PRNG seeded by the caller's integer seed produces a full
 *   shuffle of [0..N-1]. For fraction f we take the first ceil(f*N) indices of that
 *   shuffled order, then sort them ascending to preserve original task order in output.
 *   Because every fraction f' > f includes all indices chosen at f, subset membership
 *   is monotone-non-decreasing in f for a fixed seed.
 *
 *   ceil semantics: f=0.1 of N=10 → k=1 task (not 0). Avoids degenerate empty subsets
 *   at low fractions for small corpora.
 *
 * Cross-reference: bench/B8-curve/README.md, DEC-BENCH-B8-CURVE-SLICE1-001
 */

'use strict';

// ---------------------------------------------------------------------------
// PRNG — mulberry32 (well-understood, dependency-free, 32-bit internal state)
// ---------------------------------------------------------------------------

/**
 * Returns a mulberry32 PRNG function seeded with `seed`.
 * Each call to the returned function produces the next pseudo-random float in [0, 1).
 *
 * @param {number} seed — non-negative integer
 * @returns {() => number}
 */
function mulberry32(seed) {
  // Coerce to Uint32 to match the well-known mulberry32 spec exactly.
  let s = seed >>> 0;
  return function () {
    s |= 0;
    s = s + 0x6d2b79f5 | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = t + Math.imul(t ^ (t >>> 7), 61 | t) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Fisher-Yates shuffle using the provided PRNG
// ---------------------------------------------------------------------------

/**
 * In-place Fisher-Yates shuffle of `arr` using `rand` as the PRNG.
 * Returns `arr` for chaining.
 *
 * @param {Array} arr
 * @param {() => number} rand
 * @returns {Array}
 */
function fisherYates(arr, rand) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
  }
  return arr;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Deterministic seeded subset-fraction sampler.
 *
 * Takes the first `ceil(fraction * N)` elements of a seeded shuffle of `tasks`,
 * then returns them in ascending original-index order (preserving task ordering).
 *
 * Guarantees:
 *   - Same (tasks, fraction, seed) → identical output across machines/runs.
 *   - For a fixed seed, raising fraction is a superset relation on sampled indices
 *     (monotone-stable sampling) — see DEC-BENCH-B8-CURVE-MONOTONE-SAMPLING-001.
 *
 * Edge cases:
 *   - fraction === 0 → []
 *   - fraction === 1 → tasks.slice() (full copy; original order)
 *   - N === 0 → []
 *
 * @param {Array<object>} tasks — per-task truth-table rows from the source artifact
 * @param {number} fraction — subset fraction in [0, 1]
 * @param {number} seed — integer seed for the PRNG
 * @returns {Array<object>}
 */
export function sampleSubset(tasks, fraction, seed) {
  if (!Array.isArray(tasks)) {
    throw new TypeError('sampleSubset: tasks must be an array');
  }
  if (typeof fraction !== 'number' || fraction < 0 || fraction > 1) {
    throw new RangeError(`sampleSubset: fraction must be in [0,1]; got ${fraction}`);
  }
  if (!Number.isInteger(seed) || seed < 0) {
    throw new RangeError(`sampleSubset: seed must be a non-negative integer; got ${seed}`);
  }

  const N = tasks.length;
  if (N === 0 || fraction === 0) return [];
  if (fraction === 1) return tasks.slice();

  // Produce a deterministic shuffled order for this seed.
  const indices = Array.from({ length: N }, (_, i) => i);
  const rand = mulberry32(seed);
  fisherYates(indices, rand);

  // Take prefix of length ceil(fraction * N) for monotone-stable semantics.
  const k = Math.ceil(fraction * N);
  const chosen = indices.slice(0, k).sort((a, b) => a - b);

  return chosen.map(i => tasks[i]);
}
