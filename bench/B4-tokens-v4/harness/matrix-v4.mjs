// SPDX-License-Identifier: MIT
//
// bench/B4-tokens-v4/harness/matrix-v4.mjs
//
// @decision DEC-BENCH-B4-V4-MATRIX-001
// @title B4-v4: two-phase 6-cell matrix definition (cells A–F, same structure as v3)
// @status accepted
// @rationale
//   Inherits the B4-v3 two-phase matrix design (DEC-BENCH-B4-V3-MATRIX-001) unchanged.
//   The cell layout (A=Opus unhook, B=Opus hooked, …, F=Haiku hooked) is the same;
//   what changes is the corpus shape (DEC-B4-V4-CORPUS-COMPOSITE-001) and the task
//   suite (DEC-BENCH-B4-V4-TASKS-001). The headline measurement (A vs F: equal quality
//   at 10×–50× lower cost) is the same hypothesis.
//
//   Model IDs inherited from DEC-BENCH-B4-V3-DRIVERS-001. Do not change without a DEC.

/** @typedef {{ short_name: string, model_id: string }} Driver */

export const DRIVERS = Object.freeze([
  { short_name: 'haiku',  model_id: 'claude-haiku-4-5-20251001' },
  { short_name: 'sonnet', model_id: 'claude-sonnet-4-6' },
  { short_name: 'opus',   model_id: 'claude-opus-4-7' },
]);

export const PHASE1_DRIVER = Object.freeze(
  DRIVERS.find((d) => d.short_name === 'opus'),
);

/**
 * @typedef {Object} Phase2Cell
 * @property {string} cell_id
 * @property {string} driver
 * @property {string} model_id
 * @property {string} arm      'unhooked' | 'hooked'
 * @property {string} label
 */

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
  PHASE2_CELLS.map((c) => [c.cell_id, c.label]),
);
