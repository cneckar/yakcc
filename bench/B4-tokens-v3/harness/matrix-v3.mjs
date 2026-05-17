// SPDX-License-Identifier: MIT
//
// bench/B4-tokens-v3/harness/matrix-v3.mjs
//
// @decision DEC-BENCH-B4-V3-MATRIX-001
// @title B4-v3: two-phase 6-cell matrix definition (cells A–F)
// @status accepted
// @rationale
//   Issue #644 (WI-B4-V3-HYPOTHESIS-MATRIX) defines a two-phase design that
//   replaces the original B4 single-pass matrix:
//
//   Phase 1 — Corpus build:
//     One cell only: Opus driver, empty corpus (no atoms in registry).
//     Opus solves each task cold; shave pipeline extracts atoms into registry.
//     Records: cost C_p1, oracle outcome Q_p1, token counts.
//     This investment establishes the atom corpus for Phase 2.
//
//   Phase 2 — Corpus exploit (6 cells A–F):
//     Registry pre-seeded with Phase 1 atoms.
//     | Cell | Driver  | Hook   | Key comparison |
//     |------|---------|--------|----------------|
//     | A    | Opus    | unhook | quality=high, cost=C_opus_miss (baseline) |
//     | B    | Opus    | hooked | quality=high, cost≈A+small_query_overhead |
//     | C    | Sonnet  | unhook | quality=mid/high, C_sonnet_miss |
//     | D    | Sonnet  | hooked | quality=high (=A), C_sonnet_hit |
//     | E    | Haiku   | unhook | quality=LOW or many turns (killer baseline) |
//     | F    | Haiku   | hooked | quality=high (=A), C_haiku_hit |
//
//   Headline comparisons (per issue #644):
//     A vs F: equal quality, 10×–50× lower cost → hypothesis holds
//     E vs F: quality lift on cheap driver → the killer evidence
//     B/D/F: cost reduction at constant quality
//
//   N=3 reruns per cell per task.
//   5 tasks × 6 cells × N=3 = 90 runs per Phase 2 execution.
//   Budget: $75 USD total (Phase 1 + Phase 2), matching DEC-V0-B4-SLICE2-COST-CEILING-004.
//
// Exports:
//   DRIVERS          — frozen array of driver descriptors
//   PHASE1_DRIVER    — the locked Phase-1 Opus driver
//   PHASE2_CELLS     — frozen array of 6 cell descriptors (A–F)
//   CELL_LABELS      — human-readable cell descriptions

/** @typedef {{ short_name: string, model_id: string }} Driver */

// @decision DEC-BENCH-B4-V3-DRIVERS-001: model IDs locked to same values as
// B4-tokens matrix.mjs (DEC-V0-B4-SLICE2-MATRIX-002). Do not change without DEC.
export const DRIVERS = Object.freeze([
  { short_name: 'haiku',  model_id: 'claude-haiku-4-5-20251001' },
  { short_name: 'sonnet', model_id: 'claude-sonnet-4-6' },
  { short_name: 'opus',   model_id: 'claude-opus-4-7' },
]);

/** The Phase 1 corpus-build driver is always Opus (locked per issue #644). */
export const PHASE1_DRIVER = Object.freeze(
  DRIVERS.find(d => d.short_name === 'opus')
);

/**
 * @typedef {Object} Phase2Cell
 * @property {string} cell_id    - Single letter A–F
 * @property {string} driver     - short_name of the driver
 * @property {string} model_id   - Anthropic model ID
 * @property {string} arm        - 'unhooked' | 'hooked'
 * @property {string} label      - human-readable description
 */

/** @type {Readonly<Phase2Cell[]>} */
export const PHASE2_CELLS = Object.freeze([
  {
    cell_id: 'A',
    driver:   'opus',
    model_id: 'claude-opus-4-7',
    arm:      'unhooked',
    label:    'Opus unhooked — quality baseline, miss-path cost',
  },
  {
    cell_id: 'B',
    driver:   'opus',
    model_id: 'claude-opus-4-7',
    arm:      'hooked',
    label:    'Opus hooked — quality parity + small query overhead vs A',
  },
  {
    cell_id: 'C',
    driver:   'sonnet',
    model_id: 'claude-sonnet-4-6',
    arm:      'unhooked',
    label:    'Sonnet unhooked — mid-quality baseline',
  },
  {
    cell_id: 'D',
    driver:   'sonnet',
    model_id: 'claude-sonnet-4-6',
    arm:      'hooked',
    label:    'Sonnet hooked — quality lift + cost reduction vs A',
  },
  {
    cell_id: 'E',
    driver:   'haiku',
    model_id: 'claude-haiku-4-5-20251001',
    arm:      'unhooked',
    label:    'Haiku unhooked — EXPECTED to fail (killer baseline)',
  },
  {
    cell_id: 'F',
    driver:   'haiku',
    model_id: 'claude-haiku-4-5-20251001',
    arm:      'hooked',
    label:    'Haiku hooked — EXPECTED to pass via Opus atoms (the killer cell)',
  },
]);

export const CELL_LABELS = Object.fromEntries(
  PHASE2_CELLS.map(c => [c.cell_id, c.label])
);
