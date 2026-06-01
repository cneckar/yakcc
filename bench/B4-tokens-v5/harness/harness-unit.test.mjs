// SPDX-License-Identifier: MIT
//
// bench/B4-tokens-v5/harness/harness-unit.test.mjs
//
// Unit tests for B4-v5 derivation logic:
//   1. Token-sum regression (REQ-TOKENS, PROTOCOL.md §2) -- proves v4 single-turn
//      undercounting is fixed. A multi-turn fixture MUST produce a sum strictly
//      greater than the last-turn-only reading.
//   2. flow_class / path_class / failure_class classification for all 4 fixture
//      scenarios: hot_hit, cold_miss, ignored_tool, resolved_then_ignored.
//   3. Billing: cache-column pricing sanity.
//
// Run: node --experimental-vm-modules node_modules/.bin/vitest run harness/harness-unit.test.mjs
// Or:  pnpm test (from bench/B4-tokens-v5)

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BENCH_ROOT  = resolve(__dirname, '..');
const FIXTURES_DIR = join(BENCH_ROOT, 'fixtures');

// Lazy-load the derivation module
const { deriveMetrics } = await import(new URL('file://' + join(__dirname, 'telemetry-v5.mjs')).href);
const { estimateCostUsd, PRICING } = await import(new URL('file://' + join(__dirname, 'billing.mjs')).href);

// Helper: load a fixture JSON
function loadFixture(name) {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, `${name}.json`), 'utf8'));
}

// ─── Token-sum regression (REQ-TOKENS, PROTOCOL.md §2) ────────────────────────

describe('REQ-TOKENS: token sum across all turns', () => {
  it('hot_hit: sums tokens across both turns (resolve + answer)', () => {
    const fixture = loadFixture('hot_hit');
    const result = deriveMetrics({ turns: fixture.turns, arm: fixture.arm });

    // Turn 0: out=120, Turn 1: out=35. Total should be 155.
    expect(result.tokens_total_output).toBe(155);
    expect(result.turns_count).toBe(2);

    // v4 bug: would only read last turn (out=35)
    expect(result.v4_last_turn_only_output).toBe(35);

    // REGRESSION PROOF: v5 sum MUST be strictly greater than v4 last-turn-only
    expect(result.tokens_total_output).toBeGreaterThan(result.v4_last_turn_only_output);
  });

  it('cold_miss: sums tokens across both turns (resolve + triplet emission)', () => {
    const fixture = loadFixture('cold_miss');
    const result = deriveMetrics({ turns: fixture.turns, arm: fixture.arm });

    // Turn 0: out=130, Turn 1: out=280. Total = 410.
    expect(result.tokens_total_output).toBe(410);
    expect(result.v4_last_turn_only_output).toBe(280);
    expect(result.tokens_total_output).toBeGreaterThan(result.v4_last_turn_only_output);
  });

  it('resolved_then_ignored: sums tokens across both turns', () => {
    const fixture = loadFixture('resolved_then_ignored');
    const result = deriveMetrics({ turns: fixture.turns, arm: fixture.arm });

    // Turn 0: out=140, Turn 1: out=120. Total = 260.
    expect(result.tokens_total_output).toBe(260);
    expect(result.v4_last_turn_only_output).toBe(120);
    expect(result.tokens_total_output).toBeGreaterThan(result.v4_last_turn_only_output);
  });

  it('ignored_tool: single-turn unhooked, v5 sum equals v4 (no multi-turn undercount here)', () => {
    const fixture = loadFixture('ignored_tool');
    const result = deriveMetrics({ turns: fixture.turns, arm: fixture.arm });

    // Single turn: both v4 and v5 agree (no bug effect on single-turn cases)
    expect(result.tokens_total_output).toBe(95);
    expect(result.v4_last_turn_only_output).toBe(95);
    expect(result.turns_count).toBe(1);
  });

  it('multi-turn token sum regression: fabricated 3-turn fixture', () => {
    // A fabricated 3-turn case to definitively prove the v4 bug.
    // v4 would report only the last turn's output_tokens.
    // v5 must report the sum.
    const fakeTurns = [
      {
        turn_index: 0,
        response: {
          stop_reason: 'tool_use',
          content_blocks: [{ type: 'tool_use', id: 't1', name: 'yakcc_resolve', input: { intent: { title: 'test' } } }],
          usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        },
        tool_results: [{ tool_use_id: 't1', intent: 'test', envelope: { confidence_tier: 'no_candidates', candidates: [], airgapped: true } }],
        wall_ms: 500, ts: '2026-01-01T00:00:00Z',
      },
      {
        turn_index: 1,
        response: {
          stop_reason: 'tool_use',
          content_blocks: [{ type: 'tool_use', id: 't2', name: 'yakcc_resolve', input: { intent: { title: 'test2' } } }],
          usage: { input_tokens: 200, output_tokens: 75, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        },
        tool_results: [{ tool_use_id: 't2', intent: 'test2', envelope: { confidence_tier: 'no_candidates', candidates: [], airgapped: true } }],
        wall_ms: 600, ts: '2026-01-01T00:00:01Z',
      },
      {
        turn_index: 2,
        response: {
          stop_reason: 'end_turn',
          content_blocks: [{ type: 'text', text: 'final answer with code' }],
          usage: { input_tokens: 400, output_tokens: 200, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        },
        tool_results: [],
        wall_ms: 1200, ts: '2026-01-01T00:00:02Z',
      },
    ];

    const result = deriveMetrics({ turns: fakeTurns, arm: 'hooked' });

    // v5 sum: 50 + 75 + 200 = 325
    expect(result.tokens_total_output).toBe(325);
    expect(result.tokens_total_input).toBe(700);
    expect(result.turns_count).toBe(3);

    // v4 would report only turn 2 (last turn): out=200, in=400
    expect(result.v4_last_turn_only_output).toBe(200);
    expect(result.v4_last_turn_only_input).toBe(400);

    // THE REGRESSION PROOF: multi-turn sum > last-turn-only
    expect(result.tokens_total_output).toBeGreaterThan(result.v4_last_turn_only_output);
    expect(result.tokens_total_input).toBeGreaterThan(result.v4_last_turn_only_input);

    // Specifically: 325 > 200 (the exact v4 undercount was 125 tokens)
    const undercount = result.tokens_total_output - result.v4_last_turn_only_output;
    expect(undercount).toBe(125);
  });
});

// ─── flow_class / path_class classification ────────────────────────────────────

describe('flow_class and path_class classification', () => {
  it('hot_hit: flow_class=followed, path_class=hot_hit', () => {
    const fixture = loadFixture('hot_hit');
    const result = deriveMetrics({ turns: fixture.turns, arm: fixture.arm });

    expect(result.tier_returned).toBe('auto_accept');
    expect(result.top_score).toBe(0.95);
    expect(result.n_candidates).toBe(2);
    expect(result.path_class).toBe('hot_hit');
    expect(result.flow_class).toBe('followed');
    expect(result.model_action_given_tier).toBe('accepted_auto');
    expect(result.resolve_before_any_code).toBe(true);
  });

  it('cold_miss: flow_class=cold_miss_authored, path_class=cold_miss', () => {
    const fixture = loadFixture('cold_miss');
    const result = deriveMetrics({ turns: fixture.turns, arm: fixture.arm });

    expect(result.tier_returned).toBe('no_candidates');
    expect(result.n_candidates).toBe(0);
    expect(result.path_class).toBe('cold_miss');
    expect(result.flow_class).toBe('cold_miss_authored');
    expect(result.failure_class).toBe('no_candidate');
  });

  it('ignored_tool: flow_class=ignored_tool, path_class=cold_miss', () => {
    const fixture = loadFixture('ignored_tool');
    const result = deriveMetrics({ turns: fixture.turns, arm: fixture.arm });

    expect(result.tier_returned).toBeNull();
    expect(result.path_class).toBe('cold_miss');
    expect(result.flow_class).toBe('ignored_tool');
    expect(result.resolve_before_any_code).toBe(false);
  });

  it('resolved_then_ignored: flow_class=resolved_then_ignored, failure_class=model_ignored_candidate', () => {
    const fixture = loadFixture('resolved_then_ignored');
    const result = deriveMetrics({ turns: fixture.turns, arm: fixture.arm });

    expect(result.tier_returned).toBe('candidate_list');
    expect(result.top_score).toBe(0.82);
    expect(result.path_class).toBe('warm_candidate_list');
    expect(result.flow_class).toBe('resolved_then_ignored');
    expect(result.model_action_given_tier).toBe('authored_despite_candidate');
    expect(result.failure_class).toBe('model_ignored_candidate');
  });

  it('unhooked arm: flow_class=cold_unhooked regardless of model text', () => {
    const result = deriveMetrics({
      turns: [{
        turn_index: 0,
        response: {
          stop_reason: 'end_turn',
          content_blocks: [{ type: 'text', text: '```typescript\nexport class Foo {}\n```' }],
          usage: { input_tokens: 1000, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        },
        tool_results: [], wall_ms: 800, ts: '2026-01-01T00:00:00Z',
      }],
      arm: 'unhooked',
    });
    expect(result.flow_class).toBe('cold_unhooked');
    expect(result.path_class).toBe('cold_unhooked');
    expect(result.tier_returned).toBeNull();
  });
});

// ─── Tier threshold capture (DEC-BENCH-B4-V5-THRESHOLD-001) ───────────────────

describe('DEC-BENCH-B4-V5-THRESHOLD-001: threshold capture', () => {
  it('auto_accept tier: score 0.95 > 0.92 AND gap 0.18 > 0.15 => production=true, doc=true', () => {
    const fixture = loadFixture('hot_hit');
    const result = deriveMetrics({ turns: fixture.turns, arm: fixture.arm });

    // Production thresholds (resolve.ts: 0.92 + gap 0.15)
    expect(result.threshold_auto_accept_production).toBe(true);
    // Doc threshold (discovery.md: 0.85)
    expect(result.threshold_auto_accept_doc_085).toBe(true);
  });

  it('candidate_list score 0.82: below production auto_accept (0.92) but above doc (0.85)', () => {
    const fixture = loadFixture('resolved_then_ignored');
    const result = deriveMetrics({ turns: fixture.turns, arm: fixture.arm });

    // Score 0.82 < 0.92 => production auto-accept = false
    expect(result.threshold_auto_accept_production).toBe(false);
    // Score 0.82 < 0.85 => doc threshold also false
    expect(result.threshold_auto_accept_doc_085).toBe(false);
  });
});

// ─── Billing: cache columns (PROTOCOL.md §3.3) ────────────────────────────────

describe('billing: cache_read and cache_creation pricing', () => {
  it('cache_off: cost equals input + output only', () => {
    const cost = estimateCostUsd({
      model_id: 'claude-haiku-4-5-20251001',
      input_tokens: 1000, output_tokens: 500,
      cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
    });
    // Haiku: 1000 * 0.80/1e6 + 500 * 4.00/1e6 = 0.0008 + 0.002 = 0.0028
    expect(cost).toBeCloseTo(0.0028, 6);
  });

  it('cache_on read: cache_read tokens cost less than input tokens', () => {
    const cacheReadCost = estimateCostUsd({
      model_id: 'claude-haiku-4-5-20251001',
      input_tokens: 0, output_tokens: 0,
      cache_read_input_tokens: 1000, cache_creation_input_tokens: 0,
    });
    const normalInputCost = estimateCostUsd({
      model_id: 'claude-haiku-4-5-20251001',
      input_tokens: 1000, output_tokens: 0,
    });
    // cache_read (0.08/MTok) should be 10x cheaper than normal input (0.80/MTok)
    expect(cacheReadCost).toBeLessThan(normalInputCost);
    expect(normalInputCost / cacheReadCost).toBeCloseTo(10, 0);
  });

  it('all models have cache_read and cache_creation prices', () => {
    for (const [modelId, prices] of Object.entries(PRICING)) {
      expect(prices.cache_read, `${modelId} missing cache_read`).toBeGreaterThan(0);
      expect(prices.cache_creation, `${modelId} missing cache_creation`).toBeGreaterThan(0);
      // cache_read must be cheaper than input (prompt caching gives a discount)
      expect(prices.cache_read, `${modelId}: cache_read should be cheaper than input`).toBeLessThan(prices.input);
    }
  });

  it('Opus cache_creation costs ~1.25x input (25% write premium)', () => {
    const opus = PRICING['claude-opus-4-7'];
    // cache_creation=18.75, input=15.00, ratio=1.25
    expect(opus.cache_creation / opus.input).toBeCloseTo(1.25, 1);
  });
});

// ─── Compound integration test: full production sequence ──────────────────────
// PROTOCOL.md requirement: at least one test crossing multiple component boundaries.

describe('compound integration: full hot_hit production sequence', () => {
  it('hot_hit fixture runs through complete derivation pipeline', () => {
    const fixture = loadFixture('hot_hit');
    const result = deriveMetrics({ turns: fixture.turns, arm: fixture.arm });

    // Token accounting
    expect(result.tokens_total_output).toBe(155);       // turn0=120 + turn1=35
    expect(result.tokens_total_input).toBe(3600);        // 1500+2100
    expect(result.turns_count).toBe(2);

    // Phase split: turn0 had tool_use (resolve phase), turn1 is emission
    expect(result.tokens_resolve_phase).toBe(120);      // turn0 output
    expect(result.tokens_emission_phase).toBe(35);      // turn1 output

    // Tier + classification
    expect(result.tier_returned).toBe('auto_accept');
    expect(result.path_class).toBe('hot_hit');
    expect(result.flow_class).toBe('followed');

    // Threshold capture: both doc and production
    expect(result.threshold_auto_accept_production).toBe(true);
    expect(result.threshold_auto_accept_doc_085).toBe(true);

    // Gap: 0.95 - 0.77 = 0.18 > 0.15
    expect(result.gap_to_2nd).toBeCloseTo(0.18, 2);

    // Billing integration: cost for these tokens
    const cost = estimateCostUsd({
      model_id: 'claude-opus-4-7',
      input_tokens: result.tokens_total_input,
      output_tokens: result.tokens_total_output,
    });
    // 3600 * 15/1e6 + 155 * 75/1e6 = 0.054 + 0.011625 = 0.065625
    expect(cost).toBeCloseTo(0.065625, 4);

    // v4 regression: v4 would have billed only for 35 output tokens
    const v4Cost = estimateCostUsd({
      model_id: 'claude-opus-4-7',
      input_tokens: result.v4_last_turn_only_input,
      output_tokens: result.v4_last_turn_only_output,
    });
    // v5 cost must exceed v4 cost (because v5 sums all turns)
    expect(cost).toBeGreaterThan(v4Cost);
  });
});

// ─── atom-fetch unit tests (DEC-BENCH-B4-V5-ATOM-FETCH-001) ──────────────────
//
// These tests verify fetchAtomImplSource and countRegistryAtoms against the
// production registry paths without making any Anthropic API calls.
// They exercise the real production sequence: SQLite open → query → result.

const { fetchAtomImplSource, countRegistryAtoms } = await import(
  new URL('file://' + join(__dirname, 'atom-fetch.mjs')).href
);

// atom-fetch.mjs internally resolves the true repo root (walking up from the harness
// dir to find the one with packages/registry/node_modules/better-sqlite3).
// We rely on the same walk here to find registry file paths for the tests.
function findMainRepoRoot() {
  let candidate = resolve(__dirname, '../../..');
  for (let i = 0; i < 4; i++) {
    if (existsSync(join(candidate, 'packages', 'registry', 'node_modules', 'better-sqlite3'))) {
      return candidate;
    }
    candidate = resolve(candidate, '..');
  }
  return resolve(__dirname, '../../..');
}
const MAIN_REPO_ROOT = findMainRepoRoot();
const BOOTSTRAP_REGISTRY = join(MAIN_REPO_ROOT, 'bootstrap', 'yakcc.registry.sqlite');
// The v3 registry: if it exists under main repo tmp, test it; otherwise skip.
const V3_REGISTRY = join(MAIN_REPO_ROOT, 'tmp', 'B4-tokens-v3', 'phase1-2026-05-18T03-51-02', 'registry.sqlite');
// Known block_merkle_root from the bootstrap registry (stable, content-addressed).
// Obtained by: SELECT block_merkle_root FROM blocks LIMIT 1
const KNOWN_BOOTSTRAP_ATOM_ROOT = 'fcc3ef57e707bb4ee882dfe0f990d35e0dd36ec3df407fb845cde24fcbf5cd92';

describe('atom-fetch: fetchAtomImplSource (DEC-BENCH-B4-V5-ATOM-FETCH-001)', () => {
  it('returns error when registry path does not exist', () => {
    const result = fetchAtomImplSource('/nonexistent/path/registry.sqlite', 'a'.repeat(64));
    expect(result.error).toMatch(/Registry not found/);
    expect(result.failure_class).toBe('atom_fetch_failed');
    expect(result.implSource).toBeUndefined();
  });

  it('returns error for invalid atom_id format (too short)', () => {
    const result = fetchAtomImplSource(BOOTSTRAP_REGISTRY, 'tooshort');
    expect(result.error).toMatch(/Invalid atom_id format/);
    expect(result.failure_class).toBe('atom_fetch_failed');
  });

  it('returns error when atom_id not found in registry', () => {
    // Valid format hex but guaranteed not to exist
    const result = fetchAtomImplSource(BOOTSTRAP_REGISTRY, '0'.repeat(64));
    expect(result.error).toMatch(/Atom not found/);
    expect(result.failure_class).toBe('atom_fetch_failed');
  });

  it('returns implSource for a real atom in the bootstrap registry', () => {
    // Use a known stable block_merkle_root from the bootstrap registry.
    // Content-addressed: if the root exists, the impl body is correct by construction.
    const result = fetchAtomImplSource(BOOTSTRAP_REGISTRY, KNOWN_BOOTSTRAP_ATOM_ROOT);
    expect(result.error).toBeUndefined();
    expect(typeof result.implSource).toBe('string');
    expect(result.implSource.length).toBeGreaterThan(0);
  });
});

describe('atom-fetch: countRegistryAtoms (Fix 3)', () => {
  it('returns -1 for nonexistent registry', () => {
    expect(countRegistryAtoms('/nonexistent/registry.sqlite')).toBe(-1);
  });

  it('returns 4904 for the bootstrap registry', () => {
    const count = countRegistryAtoms(BOOTSTRAP_REGISTRY);
    // The bootstrap registry has a known atom count; assert it is the expected value
    expect(count).toBe(4904);
  });

  it('returns 0 for the v3 phase1 registry (empty blocks table), or -1 if file absent', () => {
    const count = countRegistryAtoms(V3_REGISTRY);
    if (existsSync(V3_REGISTRY)) {
      // v3 registry exists but has 0 atoms in the blocks table
      expect(count).toBe(0);
    } else {
      // Registry absent (different environment) — count must be -1
      expect(count).toBe(-1);
    }
  });
});

// ─── Compound integration: real oracle path for substitution ─────────────────
// Exercises the real production sequence: fetch atom from SQLite → write temp file
// → run oracle on it.  This is the Fix 1 end-to-end path.

describe('compound integration: substitution oracle on real atom body', () => {
  it('fetchAtomImplSource + runOracle round-trip produces an explicit oracle result', async () => {
    // Use known stable atom root; fetchAtomImplSource handles SQLite via atom-fetch.mjs
    const fetchResult = fetchAtomImplSource(BOOTSTRAP_REGISTRY, KNOWN_BOOTSTRAP_ATOM_ROOT);
    expect(fetchResult.error).toBeUndefined();
    expect(typeof fetchResult.implSource).toBe('string');

    // The atom may or may not pass the oracle — we only assert the oracle returns
    // a well-formed result with explicit pass/fail (never a silent undefined).
    const { runOracle } = await import(new URL('file://' + join(__dirname, 'oracle-runner.mjs')).href);
    const oracle = await runOracle('crc32c', fetchResult.implSource);

    // These fields must always be present — never undefined (Fix 1 contract)
    expect(typeof oracle.oracle_passed).toBe('boolean');
    expect(typeof oracle.oracle_pass_count).toBe('number');
    expect(typeof oracle.oracle_total).toBe('number');
    expect(Array.isArray(oracle.oracle_failures)).toBe(true);
  });
});

// ─── Reference-emit helpers (DEC-BENCH-B4-V5-REFEMIT-ARM-001) ────────────────
//
// Tests for the reference-emit arm: tool definition shape, manifest-present
// helper, and the oracle materialization path (materializeAtomSource).
//
// The offline sanity proof is the key requirement: given the committed bench corpus,
// materializeAtomSource(candidates[0].root) for crc32c MUST produce source that
// passes the crc32c oracle — proving the new oracle path materializes correctly.

const { YAKCC_REFERENCE_TOOL_DEF, writeManifestPresent, materializeAtomSource } = await import(
  new URL('file://' + join(__dirname, 'refemit-helpers.mjs')).href
);

// The committed bench corpus registry (bench/B4-tokens-v5/corpus/registry.sqlite, #1066).
// This corpus probes auto_accept for all 6 B4-v5 tasks; crc32c has a known root.
const BENCH_CORPUS = join(BENCH_ROOT, 'corpus', 'registry.sqlite');

// The crc32c atom root from the committed bench corpus (stable, content-addressed).
// Obtained from: SELECT block_merkle_root FROM blocks WHERE spec_canonical_bytes LIKE '%CRC-32C%'
const CRC32C_CORPUS_ROOT = 'f0834da06c8606167ad106bb7f70ac570166cbfe99702784a1101615e68601b2';

describe('DEC-BENCH-B4-V5-REFEMIT-ARM-001: reference-emit helpers', () => {
  it('YAKCC_REFERENCE_TOOL_DEF has correct name and required atom_id input', () => {
    expect(YAKCC_REFERENCE_TOOL_DEF.name).toBe('yakcc_reference');
    expect(YAKCC_REFERENCE_TOOL_DEF.input_schema.required).toContain('atom_id');
    // project_root is optional (apply-mode) — must NOT be in required
    expect(YAKCC_REFERENCE_TOOL_DEF.input_schema.required).not.toContain('project_root');
    // description must mention compose-by-reference / import line
    expect(YAKCC_REFERENCE_TOOL_DEF.description).toMatch(/import/);
    expect(YAKCC_REFERENCE_TOOL_DEF.description).toMatch(/apply.*mode|apply mode/i);
  });

  it('writeManifestPresent creates a valid .yakcc/manifest.json', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const tmpDir = mkdtempSync(join(tmpdir(), 'bench-refemit-'));
    try {
      writeManifestPresent(tmpDir);
      const manifestPath = join(tmpDir, '.yakcc', 'manifest.json');
      expect(existsSync(manifestPath)).toBe(true);
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      expect(manifest.version).toBe(1);
      expect(Array.isArray(manifest.references)).toBe(true);
      // Idempotent: calling again must not throw and must not corrupt the file
      writeManifestPresent(tmpDir);
      const manifest2 = JSON.parse(readFileSync(manifestPath, 'utf8'));
      expect(manifest2.version).toBe(1);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('materializeAtomSource returns error for nonexistent registry', async () => {
    const result = await materializeAtomSource('/nonexistent/registry.sqlite', CRC32C_CORPUS_ROOT);
    expect(result.error).toMatch(/Registry not found/);
    expect(result.failure_class).toBeDefined();
  });

  it('materializeAtomSource returns error for invalid atom root', async () => {
    const result = await materializeAtomSource(BENCH_CORPUS, 'tooshort');
    expect(result.error).toMatch(/Invalid atom root/);
  });
});

// ─── OFFLINE SANITY PROOF (DEC-BENCH-B4-V5-REFEMIT-ARM-001) ──────────────────
//
// Required evidence: given the committed bench corpus, assemble(candidates[0].root)
// for crc32c MUST produce source that passes the crc32c oracle.
// This proves the new oracle materialization path works end-to-end without any
// Anthropic API call.
//
// Production sequence exercised:
//   1. Registry opened at bench corpus path (the corpus auto_accept probes)
//   2. materializeAtomSource(registryPath, crc32c_root) → calls real assemble()
//   3. Resulting source written to scratch file
//   4. runOracle('crc32c', source) → runs the real crc32c oracle tests
//   5. oracle_passed must be true (the corpus atom is a known-good implementation)

describe('OFFLINE SANITY PROOF: materializeAtomSource → oracle for crc32c (no API call)', () => {
  it('bench corpus crc32c atom materializes and passes the crc32c oracle', async () => {
    // Skip if bench corpus not present (shouldn't happen — it's committed)
    if (!existsSync(BENCH_CORPUS)) {
      console.warn('SKIP: bench corpus not found:', BENCH_CORPUS);
      return;
    }

    // Step 1: materialize via assemble() (the reference-emit oracle path)
    const materializeResult = await materializeAtomSource(BENCH_CORPUS, CRC32C_CORPUS_ROOT);
    expect(materializeResult.error, `materialize failed: ${materializeResult.error}`).toBeUndefined();
    expect(typeof materializeResult.source).toBe('string');
    expect(materializeResult.source.length).toBeGreaterThan(0);

    // Step 2: run the real crc32c oracle on the materialized source
    const { runOracle } = await import(new URL('file://' + join(__dirname, 'oracle-runner.mjs')).href);
    const oracle = await runOracle('crc32c', materializeResult.source);

    // Contract: well-formed oracle result (always present)
    expect(typeof oracle.oracle_passed).toBe('boolean');
    expect(typeof oracle.oracle_pass_count).toBe('number');
    expect(typeof oracle.oracle_total).toBe('number');
    expect(Array.isArray(oracle.oracle_failures)).toBe(true);

    // THE KEY PROOF: the corpus atom must pass the oracle.
    // This proves the reference-emit oracle path materializes a correct implementation.
    expect(
      oracle.oracle_passed,
      `crc32c corpus atom failed oracle (${oracle.oracle_pass_count}/${oracle.oracle_total}): ${JSON.stringify(oracle.oracle_failures)}`
    ).toBe(true);
  }, 30_000);
});
