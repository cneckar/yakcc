// SPDX-License-Identifier: MIT
//
// bench/B4-tokens-v5/reference-emit/measure.test.mjs
//
// Validates the offline reference-emit output-collapse measurement.
//
// Test scope:
//   1. For every B4-v5 atom, verbatim output tokens > import-line tokens (collapse holds).
//   2. Every collapse ratio is > 1 (all atoms compress).
//   3. Import line is a single `import { <symbol> } from ".yakcc/atoms/...";` line.
//   4. Determinism: two sequential calls to runMeasurement() produce identical results.
//
// No mocks of registry handlers. runMeasurement() calls the real @yakcc/compile
// production functions (addReference, referenceImportLine, generateAtomDts).
// No API keys, no network, no registry needed — fully offline.
//
// Runner: vitest (matches bench/B4-tokens-v5 convention, vitest.config.mjs).
// Invocation: vitest run --config bench/B4-tokens-v5/reference-emit/vitest.config.mjs

import { describe, it, expect } from "vitest";
import { runMeasurement } from "./measure.mjs";

// Run the measurement once and share across all tests for speed.
// runMeasurement is deterministic, so a single shared result is sufficient.
const result = await runMeasurement();

describe("reference-emit output-collapse measurement", () => {
  // ---------------------------------------------------------------------------
  // Structural integrity
  // ---------------------------------------------------------------------------

  it("returns results for all 6 B4-v5 atoms", () => {
    expect(result.atoms).toHaveLength(6);
    const ids = result.atoms.map((a) => a.atomId);
    expect(ids).toContain("crc32c");
    expect(ids).toContain("utf8-codec");
    expect(ids).toContain("base32-rfc4648");
    expect(ids).toContain("lru-ttl-cache");
    expect(ids).toContain("semver-range");
    expect(ids).toContain("ring-buffer");
  });

  it("includes aggregate statistics", () => {
    expect(result.aggregate).toBeDefined();
    expect(result.aggregate.n).toBe(6);
    expect(typeof result.aggregate.corpusCollapseRatio).toBe("number");
    expect(typeof result.aggregate.meanRatio).toBe("number");
    expect(typeof result.aggregate.medianRatio).toBe("number");
    expect(typeof result.aggregate.minRatio).toBe("number");
    expect(typeof result.aggregate.maxRatio).toBe("number");
  });

  // ---------------------------------------------------------------------------
  // Core collapse invariant: verbatim tokens > import-line tokens for EVERY atom
  // ---------------------------------------------------------------------------

  for (const atom of result.atoms) {
    it(`[${atom.atomId}] verbatim output tokens (${atom.verbatim.tokens}) > import-line tokens (${atom.reference.tokens})`, () => {
      expect(atom.verbatim.tokens).toBeGreaterThan(atom.reference.tokens);
    });

    it(`[${atom.atomId}] collapse ratio > 1 (got ${atom.collapseRatio.toFixed(2)}x)`, () => {
      expect(atom.collapseRatio).toBeGreaterThan(1);
    });
  }

  // ---------------------------------------------------------------------------
  // Import line shape: must be a valid single-line import statement
  // ---------------------------------------------------------------------------

  const IMPORT_RE = /^import \{ \w+ \} from "\.yakcc\/atoms\/[0-9a-f]+";$/;

  for (const atom of result.atoms) {
    it(`[${atom.atomId}] import line is a single .yakcc/atoms import: "${atom.importLine}"`, () => {
      // Single line — no newlines
      expect(atom.importLine).not.toContain("\n");
      // Matches the canonical form: import { Symbol } from ".yakcc/atoms/<alias>";
      expect(atom.importLine).toMatch(IMPORT_RE);
    });
  }

  // ---------------------------------------------------------------------------
  // Symbol derivation: each symbol matches the expected_export from tasks.json
  // ---------------------------------------------------------------------------

  const EXPECTED_SYMBOLS = {
    "crc32c": "CRC32C",
    "utf8-codec": "Utf8Codec",
    "base32-rfc4648": "Base32Codec",
    "lru-ttl-cache": "LRUTTLCache",
    "semver-range": "SemVerRange",
    "ring-buffer": "RingBuffer",
  };

  for (const atom of result.atoms) {
    const expectedSymbol = EXPECTED_SYMBOLS[atom.atomId];
    if (expectedSymbol !== undefined) {
      it(`[${atom.atomId}] symbol is "${expectedSymbol}"`, () => {
        expect(atom.symbol).toBe(expectedSymbol);
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Verbatim source is non-trivial (sanity check on read)
  // ---------------------------------------------------------------------------

  for (const atom of result.atoms) {
    it(`[${atom.atomId}] verbatim source is > 100 chars (real impl, not empty)`, () => {
      expect(atom.verbatim.chars).toBeGreaterThan(100);
    });
  }

  // ---------------------------------------------------------------------------
  // DTS one-time cost is non-zero and smaller than verbatim
  // ---------------------------------------------------------------------------

  for (const atom of result.atoms) {
    it(`[${atom.atomId}] dts one-time cost is > 0 and < verbatim chars`, () => {
      expect(atom.dts.chars).toBeGreaterThan(0);
      expect(atom.dts.chars).toBeLessThan(atom.verbatim.chars);
    });
  }

  // ---------------------------------------------------------------------------
  // Aggregate: corpus collapse ratio is meaningful (> 5x on the full corpus)
  // ---------------------------------------------------------------------------

  it("corpus collapse ratio is > 5x (real compression confirmed)", () => {
    expect(result.aggregate.corpusCollapseRatio).toBeGreaterThan(5);
  });

  it("minimum per-atom ratio is > 1 across all atoms", () => {
    expect(result.aggregate.minRatio).toBeGreaterThan(1);
  });

  // ---------------------------------------------------------------------------
  // Determinism: two sequential runs produce identical atom results
  // ---------------------------------------------------------------------------

  it("measurement is deterministic (two runs produce the same import lines)", async () => {
    const result2 = await runMeasurement();
    for (let i = 0; i < result.atoms.length; i++) {
      expect(result2.atoms[i].importLine).toBe(result.atoms[i].importLine);
      expect(result2.atoms[i].verbatim.chars).toBe(result.atoms[i].verbatim.chars);
      expect(result2.atoms[i].reference.chars).toBe(result.atoms[i].reference.chars);
      expect(result2.atoms[i].collapseRatio).toBe(result.atoms[i].collapseRatio);
    }
  });

  // ---------------------------------------------------------------------------
  // Compound-integration test: exercises the real production sequence end-to-end
  //
  // This test verifies the actual state transition the reference-emit flow makes:
  //   1. Read verbatim impl source (what model writes under yakcc_compile/#1030)
  //   2. Call @yakcc/compile addReference → builds AtomReference with alias+importPath
  //   3. Call referenceImportLine(reference) → single-line import statement
  //   4. Call generateAtomDts(spec, symbol) → .d.ts declaration text
  //   5. Confirm collapse: verbatim >> import (what the model "writes" is tiny)
  //
  // No mocks — all four functions are called via the real @yakcc/compile dist.
  // ---------------------------------------------------------------------------

  it("compound integration: real production sequence for crc32c produces correct artifacts", () => {
    const crc32c = result.atoms.find((a) => a.atomId === "crc32c");
    expect(crc32c).toBeDefined();

    // Verbatim impl is a real TypeScript class
    expect(crc32c.verbatim.chars).toBeGreaterThan(1000);
    expect(crc32c.verbatim.tokens).toBeGreaterThan(100);

    // Import line is ~51 chars / 13 tokens
    expect(crc32c.reference.chars).toBeLessThan(80);
    expect(crc32c.reference.tokens).toBeLessThanOrEqual(20);

    // Import line contains the symbol CRC32C
    expect(crc32c.importLine).toContain("CRC32C");
    expect(crc32c.importLine).toContain(".yakcc/atoms/");
    expect(crc32c.importLine).toMatch(/^import \{ CRC32C \} from "\.yakcc\/atoms\/[0-9a-f]{12,}";$/);

    // Collapse is massive — ~20–30x just for the smallest atom
    expect(crc32c.collapseRatio).toBeGreaterThan(10);

    // DTS is produced and is non-trivial
    expect(crc32c.dts.chars).toBeGreaterThan(50);
    expect(crc32c.dts.tokens).toBeGreaterThan(0);
    expect(crc32c.dtsPath).toMatch(/^\.yakcc\/atoms\/[0-9a-f]+\.d\.ts$/);
  });
});
