// SPDX-License-Identifier: MIT
/**
 * enforcement-eval-corpus.test.ts — Layer 6 eval gate (wi-579 S1).
 *
 * @decision DEC-HOOK-ENF-LAYER6-EVAL-CORPUS-001
 * title: Layer 6 eval gate — table-driven corpus exercises live enforcement layers
 * status: decided (wi-579-hook-enforcement S1)
 * rationale:
 *   Layer 6 is a hard CI gate per #579 acceptance — no carve-outs to skip individual
 *   layers. This test loads packages/hooks-base/test/enforcement-eval-corpus.json
 *   and asserts each row produces the expected outcome through scoreIntentSpecificity()
 *   (Layer 1) and, for future slices, through executeRegistryQueryWithSubstitution()
 *   with a registry stub that prevents real I/O.
 *
 *   Slice rule: no slice may land without expanding this corpus. S1 seeds Layer 1
 *   rows (ids L1-001..L1-007). S2 appends L2-NNN; S3 appends L3-NNN; etc.
 *
 *   The test exercises the REAL production sequence:
 *     1. scoreIntentSpecificity(row.input) for Layer 1 rows.
 *     2. For future layers: executeRegistryQueryWithSubstitution with a stub registry.
 *
 *   Cross-reference: plans/wi-579-hook-enforcement-architecture.md §5.7
 *
 * Production trigger: this test runs in the default Vitest suite for @yakcc/hooks-base.
 * Every PR touching packages/hooks-base/src/** will exercise it.
 */

import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { scoreIntentSpecificity } from "../src/intent-specificity.js";

// ---------------------------------------------------------------------------
// Corpus type
// ---------------------------------------------------------------------------

interface CorpusRow {
  id: string;
  input: string;
  expectedLayer: number;
  expectedOutcome: "intent-too-broad" | "accept" | "result-set-too-large" | "atom-oversized" | "descent-bypass-warning" | "drift-alert";
  notes?: string;
}

// ---------------------------------------------------------------------------
// Load corpus
// ---------------------------------------------------------------------------

async function loadCorpus(): Promise<CorpusRow[]> {
  const corpusPath = join(import.meta.dirname, "enforcement-eval-corpus.json");
  const raw = await readFile(corpusPath, "utf-8");
  const rows = JSON.parse(raw) as CorpusRow[];
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error("enforcement-eval-corpus.json is empty or not an array — Layer 6 gate broken");
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Layer 1 assertion helper
// ---------------------------------------------------------------------------

function assertLayer1Row(row: CorpusRow): void {
  const result = scoreIntentSpecificity(row.input);
  if (row.expectedOutcome === "intent-too-broad") {
    expect(result.status, `[${row.id}] expected intent_too_broad for: "${row.input}" (${row.notes ?? ""})`).toBe("intent_too_broad");
    expect(result.layer, `[${row.id}] layer discriminant`).toBe(1);
  } else if (row.expectedOutcome === "accept") {
    expect(result.status, `[${row.id}] expected ok (accept) for: "${row.input}" (${row.notes ?? ""})`).toBe("ok");
    expect(result.layer, `[${row.id}] layer discriminant`).toBe(1);
    if (result.status === "ok") {
      expect(typeof result.score, `[${row.id}] score must be number`).toBe("number");
      expect(result.score, `[${row.id}] score must be in [0,1]`).toBeGreaterThanOrEqual(0);
      expect(result.score, `[${row.id}] score must be in [0,1]`).toBeLessThanOrEqual(1);
    }
  } else {
    throw new Error(`[${row.id}] unexpected expectedOutcome="${row.expectedOutcome}" for a Layer 1 row`);
  }
}

// ---------------------------------------------------------------------------
// Structural invariants
// ---------------------------------------------------------------------------

describe("Layer 6 eval corpus — structural invariants", () => {
  it("corpus JSON loads successfully with ≥5 rows", async () => {
    const rows = await loadCorpus();
    expect(rows.length).toBeGreaterThanOrEqual(5);
  });

  it("every row has required fields: id, input, expectedLayer, expectedOutcome", async () => {
    const rows = await loadCorpus();
    for (const row of rows) {
      expect(typeof row.id, `row.id must be string`).toBe("string");
      expect(typeof row.input, `[${row.id}] input must be string`).toBe("string");
      expect(typeof row.expectedLayer, `[${row.id}] expectedLayer must be number`).toBe("number");
      expect(typeof row.expectedOutcome, `[${row.id}] expectedOutcome must be string`).toBe("string");
    }
  });

  it("S1 seeds exactly 7 Layer 1 rows", async () => {
    const rows = await loadCorpus();
    const layer1Rows = rows.filter((r) => r.expectedLayer === 1);
    expect(layer1Rows.length).toBe(7);
  });

  it("all S1 row ids follow L1-NNN format", async () => {
    const rows = await loadCorpus();
    const layer1Rows = rows.filter((r) => r.expectedLayer === 1);
    for (const row of layer1Rows) {
      expect(row.id, `id should match L1-NNN`).toMatch(/^L1-\d{3}$/);
    }
  });
});

// ---------------------------------------------------------------------------
// Layer 1 eval gate — table-driven
// ---------------------------------------------------------------------------

describe("Layer 6 eval corpus — Layer 1 rows", () => {
  // Named individual cases for clear failure messages.
  // Each test is independent so CI shows exactly which corpus row fails.

  it("L1-001: 'utility for handling stuff' → intent-too-broad", async () => {
    const rows = await loadCorpus();
    const row = rows.find((r) => r.id === "L1-001");
    expect(row, "L1-001 must be in corpus").toBeDefined();
    if (row) assertLayer1Row(row);
  });

  it("L1-002: 'validate input' → intent-too-broad (too_short)", async () => {
    const rows = await loadCorpus();
    const row = rows.find((r) => r.id === "L1-002");
    expect(row, "L1-002 must be in corpus").toBeDefined();
    if (row) assertLayer1Row(row);
  });

  it("L1-003: 'helper' → intent-too-broad (single_word)", async () => {
    const rows = await loadCorpus();
    const row = rows.find((r) => r.id === "L1-003");
    expect(row, "L1-003 must be in corpus").toBeDefined();
    if (row) assertLayer1Row(row);
  });

  it("L1-004: 'isEmail RFC 5321 subset' → accept", async () => {
    const rows = await loadCorpus();
    const row = rows.find((r) => r.id === "L1-004");
    expect(row, "L1-004 must be in corpus").toBeDefined();
    if (row) assertLayer1Row(row);
  });

  it("L1-005: 'split string on first :// substring' → accept", async () => {
    const rows = await loadCorpus();
    const row = rows.find((r) => r.id === "L1-005");
    expect(row, "L1-005 must be in corpus").toBeDefined();
    if (row) assertLayer1Row(row);
  });

  it("L1-006: 'general parser' → intent-too-broad (meta_word + too_short)", async () => {
    const rows = await loadCorpus();
    const row = rows.find((r) => r.id === "L1-006");
    expect(row, "L1-006 must be in corpus").toBeDefined();
    if (row) assertLayer1Row(row);
  });

  it("L1-007: 'convert hex pair %XX to single byte' → accept", async () => {
    const rows = await loadCorpus();
    const row = rows.find((r) => r.id === "L1-007");
    expect(row, "L1-007 must be in corpus").toBeDefined();
    if (row) assertLayer1Row(row);
  });

  it("all Layer 1 rows pass (catch-all sweep for future corpus additions)", async () => {
    const rows = await loadCorpus();
    const layer1Rows = rows.filter((r) => r.expectedLayer === 1);
    for (const row of layer1Rows) {
      assertLayer1Row(row);
    }
  });
});

// ---------------------------------------------------------------------------
// Corpus completeness gate
// ---------------------------------------------------------------------------

describe("Layer 6 eval corpus — completeness gate", () => {
  it("corpus covers both reject and accept outcomes in Layer 1", async () => {
    const rows = await loadCorpus();
    const layer1Rows = rows.filter((r) => r.expectedLayer === 1);
    const hasReject = layer1Rows.some((r) => r.expectedOutcome === "intent-too-broad");
    const hasAccept = layer1Rows.some((r) => r.expectedOutcome === "accept");
    expect(hasReject, "corpus must contain at least one intent-too-broad row").toBe(true);
    expect(hasAccept, "corpus must contain at least one accept row").toBe(true);
  });
});
