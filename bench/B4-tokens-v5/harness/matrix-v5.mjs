// SPDX-License-Identifier: MIT
// bench/B4-tokens-v5/harness/matrix-v5.mjs
//
// DEC-BENCH-B4-V5-MATRIX-001: Same 6-cell topology as v4 (PROTOCOL.md §5).
// v5 adds cache_condition per hooked cell: 'cache_off' | 'cache_on'.
// Unhooked cells run cache_off only (trivial system prompt, no caching benefit).

export const DRIVERS = Object.freeze([
  { short_name: 'haiku',  model_id: 'claude-haiku-4-5-20251001' },
  { short_name: 'sonnet', model_id: 'claude-sonnet-4-6' },
  { short_name: 'opus',   model_id: 'claude-opus-4-7' },
]);

export const PHASE2_CELLS = Object.freeze([
  { cell_id: 'A', driver: 'opus',   model_id: 'claude-opus-4-7',          arm: 'unhooked', cache_condition: 'cache_off', label: 'Opus unhooked — quality baseline, miss-path cost' },
  { cell_id: 'B', driver: 'opus',   model_id: 'claude-opus-4-7',          arm: 'hooked',   cache_condition: 'cache_off', label: 'Opus hooked cache_off — overhead without caching' },
  { cell_id: 'B2',driver: 'opus',   model_id: 'claude-opus-4-7',          arm: 'hooked',   cache_condition: 'cache_on',  label: 'Opus hooked cache_on — cached discovery prompt' },
  { cell_id: 'C', driver: 'sonnet', model_id: 'claude-sonnet-4-6',        arm: 'unhooked', cache_condition: 'cache_off', label: 'Sonnet unhooked — mid-quality baseline' },
  { cell_id: 'D', driver: 'sonnet', model_id: 'claude-sonnet-4-6',        arm: 'hooked',   cache_condition: 'cache_off', label: 'Sonnet hooked cache_off' },
  { cell_id: 'D2',driver: 'sonnet', model_id: 'claude-sonnet-4-6',        arm: 'hooked',   cache_condition: 'cache_on',  label: 'Sonnet hooked cache_on — cached discovery prompt' },
  { cell_id: 'E', driver: 'haiku',  model_id: 'claude-haiku-4-5-20251001', arm: 'unhooked', cache_condition: 'cache_off', label: 'Haiku unhooked — EXPECTED to fail' },
  { cell_id: 'F', driver: 'haiku',  model_id: 'claude-haiku-4-5-20251001', arm: 'hooked',   cache_condition: 'cache_off', label: 'Haiku hooked cache_off — via Opus atoms' },
  { cell_id: 'F2',driver: 'haiku',  model_id: 'claude-haiku-4-5-20251001', arm: 'hooked',   cache_condition: 'cache_on',  label: 'Haiku hooked cache_on — cached discovery prompt' },
]);

export const CELL_LABELS = Object.fromEntries(PHASE2_CELLS.map((c) => [c.cell_id, c.label]));
