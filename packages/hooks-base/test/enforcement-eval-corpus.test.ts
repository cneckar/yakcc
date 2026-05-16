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

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scoreIntentSpecificity } from "../src/intent-specificity.js";
import type { CandidateMatch } from "@yakcc/registry";
import { resetConfigOverride, setConfigOverride, getDefaults, loadEnforcementConfig } from "../src/enforcement-config.js";
import { scoreResultSetSize } from "../src/result-set-size.js";
import { enforceAtomSizeRatio } from "../src/atom-size-ratio.js";
import type { AtomLike, CallSiteAnalysis } from "../src/atom-size-ratio.js";
import type { Layer3Config } from "../src/enforcement-config.js";

// ---------------------------------------------------------------------------
// Corpus type
// ---------------------------------------------------------------------------

interface CorpusRow {
  id: string;
  /** For Layer 1 rows: the intent text. For Layer 2/3 rows: descriptive label (not interpreted). */
  input: string;
  expectedLayer: number;
  expectedOutcome: "intent-too-broad" | "accept" | "result-set-too-large" | "atom-oversized" | "descent-bypass-warning" | "drift-alert";
  notes?: string;
  // Layer 2 fields — present only for L2-* rows
  candidateCount?: number;
  confidentCount?: number;
  weakCount?: number;
  envOverrides?: Record<string, string>;
  // Layer 3 fields — present only for L3-* rows
  atomComplexity?: number;
  needComplexity?: number;
  ratioThreshold?: number;
  minFloor?: number;
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
// Layer 2 helpers — build minimal CandidateMatch stubs
// ---------------------------------------------------------------------------

/**
 * Build a confident CandidateMatch stub (score >= 0.70, d=0.5, score=0.9375).
 * combinedScore = 1 - d^2/4 = 1 - 0.25/4 = 0.9375 >= confidentThreshold=0.70.
 */
function makeConfidentStub(): CandidateMatch {
  return {
    cosineDistance: 0.5,
    block: {
      specCanonicalBytes: new Uint8Array(0),
      spec: {
        behavior: "stub",
        inputs: [],
        outputs: [],
        guarantees: [],
        errorConditions: [],
        nonFunctional: { purity: "pure", threadSafety: "safe" },
        propertyTests: [],
      },
    },
  } as unknown as CandidateMatch;
}

/**
 * Build a weak CandidateMatch stub (score < 0.70, d=1.2, score=0.64).
 * combinedScore = 1 - 1.44/4 = 0.64 < confidentThreshold=0.70.
 */
function makeWeakStub(): CandidateMatch {
  return {
    cosineDistance: 1.2,
    block: {
      specCanonicalBytes: new Uint8Array(0),
      spec: {
        behavior: "stub",
        inputs: [],
        outputs: [],
        guarantees: [],
        errorConditions: [],
        nonFunctional: { purity: "pure", threadSafety: "safe" },
        propertyTests: [],
      },
    },
  } as unknown as CandidateMatch;
}

/**
 * Build the candidate list from a corpus row's confidentCount + weakCount fields.
 */
function buildCandidatesFromRow(row: CorpusRow): CandidateMatch[] {
  const confident = Array.from({ length: row.confidentCount ?? 0 }, () => makeConfidentStub());
  const weak = Array.from({ length: row.weakCount ?? 0 }, () => makeWeakStub());
  return [...confident, ...weak];
}

// ---------------------------------------------------------------------------
// Layer 3 helpers — build AtomLike + CallSiteAnalysis from corpus fields
// ---------------------------------------------------------------------------

/**
 * Build a minimal AtomLike from a corpus row's atomComplexity proxy fields.
 *
 * The corpus stores the pre-computed complexity values (atomComplexity, needComplexity)
 * rather than the raw spec fields. We reconstruct an AtomLike that reproduces
 * the documented atomComplexity via the standard formula:
 *   atomComplexity = transitiveNodes + 5 * exportedSurface + 2 * transitiveDeps
 *
 * Strategy: encode all complexity in transitiveDeps (cleanest single-field control):
 *   transitiveDeps = atomComplexity / 2  when atomComplexity is even,
 *   otherwise use inputs = atomComplexity (transitiveNodes only, exportedSurface=0, deps=0).
 * Both roundtrip exactly.
 */
function makeAtomLikeFromRow(row: CorpusRow): AtomLike {
  const atomComplexity = row.atomComplexity ?? 0;
  // Encode via transitiveDeps when divisible by 2; otherwise via inputs only.
  if (atomComplexity % 2 === 0) {
    const deps = atomComplexity / 2;
    return {
      spec: {
        inputs: [],
        outputs: [],
        guarantees: [],
      } as unknown as import("@yakcc/contracts").SpecYak,
      exportedSurface: 0,
      transitiveDeps: deps,
    };
  }
  // Odd: encode all in transitiveNodes (inputs only, no exports or deps).
  return {
    spec: {
      inputs: Array.from({ length: atomComplexity }, (_, i) => ({ name: `in${i}`, type: "string" })),
      outputs: [],
      guarantees: [],
    } as unknown as import("@yakcc/contracts").SpecYak,
    exportedSurface: 0,
    transitiveDeps: 0,
  };
}

/**
 * Build a CallSiteAnalysis that produces the row's documented needComplexity.
 *
 * needComplexity = max(1, bindingsUsed * statementCount).
 * We use bindingsUsed=needComplexity, statementCount=1 for simplicity.
 */
function makeCallSiteFromRow(row: CorpusRow): CallSiteAnalysis {
  const needComplexity = row.needComplexity ?? 1;
  return { bindingsUsed: needComplexity, statementCount: 1 };
}

/**
 * Assert a Layer 3 corpus row against enforceAtomSizeRatio().
 *
 * Builds AtomLike + CallSiteAnalysis from row fields and verifies the gate verdict.
 *
 * @decision DEC-HOOK-ENF-LAYER3-ATOM-SIZE-RATIO-001
 */
function assertLayer3Row(row: CorpusRow): void {
  const cfg: Layer3Config = {
    ratioThreshold: row.ratioThreshold ?? 10,
    minFloor: row.minFloor ?? 20,
    disableGate: false,
  };
  const atomLike = makeAtomLikeFromRow(row);
  const callSite = makeCallSiteFromRow(row);

  const result = enforceAtomSizeRatio(atomLike, callSite, cfg);

  if (row.expectedOutcome === "atom-oversized") {
    expect(result.status, `[${row.id}] expected atom-size-too-large for atomComplexity=${row.atomComplexity ?? 0} (${row.notes ?? ""})`).toBe("atom-size-too-large");
    expect(result.layer, `[${row.id}] layer discriminant must be 3`).toBe(3);
  } else if (row.expectedOutcome === "accept") {
    expect(result.status, `[${row.id}] expected ok (accept) for atomComplexity=${row.atomComplexity ?? 0} (${row.notes ?? ""})`).toBe("ok");
    expect(result.layer, `[${row.id}] layer discriminant must be 3`).toBe(3);
  } else {
    throw new Error(`[${row.id}] unexpected expectedOutcome="${row.expectedOutcome}" for a Layer 3 row`);
  }
}

// ---------------------------------------------------------------------------
// Layer 2 assertion helper
// ---------------------------------------------------------------------------

function assertLayer2Row(row: CorpusRow): void {
  const candidates = buildCandidatesFromRow(row);

  // Apply env overrides via setConfigOverride when envOverrides is present.
  // This simulates what loadEnforcementConfig would do with the env vars.
  if (row.envOverrides && Object.keys(row.envOverrides).length > 0) {
    const cfg = loadEnforcementConfig({ env: { ...process.env, ...row.envOverrides } });
    setConfigOverride(cfg);
  }

  const result = scoreResultSetSize(candidates);

  if (row.expectedOutcome === "result-set-too-large") {
    expect(result.status, `[${row.id}] expected result_set_too_large for confidentCount=${row.confidentCount ?? 0} (${row.notes ?? ""})`).toBe("result_set_too_large");
    expect(result.layer, `[${row.id}] layer discriminant must be 2`).toBe(2);
  } else if (row.expectedOutcome === "accept") {
    expect(result.status, `[${row.id}] expected ok (accept) for confidentCount=${row.confidentCount ?? 0} (${row.notes ?? ""})`).toBe("ok");
    expect(result.layer, `[${row.id}] layer discriminant must be 2`).toBe(2);
  } else {
    throw new Error(`[${row.id}] unexpected expectedOutcome="${row.expectedOutcome}" for a Layer 2 row`);
  }
}

// ---------------------------------------------------------------------------
// Config reset between tests (needed for L2 env-override tests)
// ---------------------------------------------------------------------------

beforeEach(() => {
  resetConfigOverride();
});

afterEach(() => {
  resetConfigOverride();
});

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

  it("S2 seeds exactly 5 Layer 2 rows", async () => {
    const rows = await loadCorpus();
    const layer2Rows = rows.filter((r) => r.expectedLayer === 2);
    expect(layer2Rows.length).toBe(5);
  });

  it("S3 seeds exactly 5 Layer 3 rows", async () => {
    const rows = await loadCorpus();
    const layer3Rows = rows.filter((r) => r.expectedLayer === 3);
    expect(layer3Rows.length).toBe(5);
  });

  it("all S1 row ids follow L1-NNN format", async () => {
    const rows = await loadCorpus();
    const layer1Rows = rows.filter((r) => r.expectedLayer === 1);
    for (const row of layer1Rows) {
      expect(row.id, `id should match L1-NNN`).toMatch(/^L1-\d{3}$/);
    }
  });

  it("all S2 row ids follow L2-NNN format", async () => {
    const rows = await loadCorpus();
    const layer2Rows = rows.filter((r) => r.expectedLayer === 2);
    for (const row of layer2Rows) {
      expect(row.id, `id should match L2-NNN`).toMatch(/^L2-\d{3}$/);
    }
  });

  it("all S3 row ids follow L3-NNN format", async () => {
    const rows = await loadCorpus();
    const layer3Rows = rows.filter((r) => r.expectedLayer === 3);
    for (const row of layer3Rows) {
      expect(row.id, `id should match L3-NNN`).toMatch(/^L3-\d{3}$/);
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
// Layer 2 eval gate — table-driven
// ---------------------------------------------------------------------------

describe("Layer 6 eval corpus — Layer 2 rows", () => {
  it("L2-001: 12 confident candidates → result-set-too-large", async () => {
    const rows = await loadCorpus();
    const row = rows.find((r) => r.id === "L2-001");
    expect(row, "L2-001 must be in corpus").toBeDefined();
    if (row) assertLayer2Row(row);
  });

  it("L2-002: 4 confident candidates → result-set-too-large (boundary +1)", async () => {
    const rows = await loadCorpus();
    const row = rows.find((r) => r.id === "L2-002");
    expect(row, "L2-002 must be in corpus").toBeDefined();
    if (row) assertLayer2Row(row);
  });

  it("L2-003: 3 confident candidates → accept (at boundary)", async () => {
    const rows = await loadCorpus();
    const row = rows.find((r) => r.id === "L2-003");
    expect(row, "L2-003 must be in corpus").toBeDefined();
    if (row) assertLayer2Row(row);
  });

  it("L2-004: 0 confident + 5 weak candidates → accept", async () => {
    const rows = await loadCorpus();
    const row = rows.find((r) => r.id === "L2-004");
    expect(row, "L2-004 must be in corpus").toBeDefined();
    if (row) assertLayer2Row(row);
  });

  it("L2-005: YAKCC_RESULT_SET_MAX=5 env override + 4 confident → accept", async () => {
    const rows = await loadCorpus();
    const row = rows.find((r) => r.id === "L2-005");
    expect(row, "L2-005 must be in corpus").toBeDefined();
    if (row) assertLayer2Row(row);
  });

  it("all Layer 2 rows pass (catch-all sweep for future corpus additions)", async () => {
    const rows = await loadCorpus();
    const layer2Rows = rows.filter((r) => r.expectedLayer === 2);
    for (const row of layer2Rows) {
      assertLayer2Row(row);
      resetConfigOverride(); // reset between rows in the sweep
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

  it("corpus covers both reject and accept outcomes in Layer 2", async () => {
    const rows = await loadCorpus();
    const layer2Rows = rows.filter((r) => r.expectedLayer === 2);
    const hasReject = layer2Rows.some((r) => r.expectedOutcome === "result-set-too-large");
    const hasAccept = layer2Rows.some((r) => r.expectedOutcome === "accept");
    expect(hasReject, "corpus must contain at least one result-set-too-large row").toBe(true);
    expect(hasAccept, "corpus must contain at least one accept row for Layer 2").toBe(true);
  });

  it("corpus covers both reject and accept outcomes in Layer 3", async () => {
    const rows = await loadCorpus();
    const layer3Rows = rows.filter((r) => r.expectedLayer === 3);
    const hasReject = layer3Rows.some((r) => r.expectedOutcome === "atom-oversized");
    const hasAccept = layer3Rows.some((r) => r.expectedOutcome === "accept");
    expect(hasReject, "corpus must contain at least one atom-oversized row").toBe(true);
    expect(hasAccept, "corpus must contain at least one accept row for Layer 3").toBe(true);
  });

  it("corpus has grown to 17 rows (S1=7 + S2=5 + S3=5)", async () => {
    const rows = await loadCorpus();
    expect(rows.length).toBe(17);
  });
});

// ---------------------------------------------------------------------------
// Layer 3 eval gate — table-driven (S3 additive, wi-591-s3-layer3)
// ---------------------------------------------------------------------------

describe("Layer 6 eval corpus — Layer 3 rows", () => {
  it("L3-001: lodash-shaped atom (atomComplexity=110, needComplexity=1) → atom-oversized", async () => {
    const rows = await loadCorpus();
    const row = rows.find((r) => r.id === "L3-001");
    expect(row, "L3-001 must be in corpus").toBeDefined();
    if (row) assertLayer3Row(row);
  });

  it("L3-002: micro-atom (atomComplexity=7 < minFloor=20) → accept (bypassed)", async () => {
    const rows = await loadCorpus();
    const row = rows.find((r) => r.id === "L3-002");
    expect(row, "L3-002 must be in corpus").toBeDefined();
    if (row) assertLayer3Row(row);
  });

  it("L3-003: boundary at ratioThreshold (ratio=10.0, not > 10) → accept", async () => {
    const rows = await loadCorpus();
    const row = rows.find((r) => r.id === "L3-003");
    expect(row, "L3-003 must be in corpus").toBeDefined();
    if (row) assertLayer3Row(row);
  });

  it("L3-004: boundary +1 (ratio=10.5 > ratioThreshold=10) → atom-oversized", async () => {
    const rows = await loadCorpus();
    const row = rows.find((r) => r.id === "L3-004");
    expect(row, "L3-004 must be in corpus").toBeDefined();
    if (row) assertLayer3Row(row);
  });

  it("L3-005: large needComplexity reduces ratio to safe zone (ratio=2.2 < 10) → accept", async () => {
    const rows = await loadCorpus();
    const row = rows.find((r) => r.id === "L3-005");
    expect(row, "L3-005 must be in corpus").toBeDefined();
    if (row) assertLayer3Row(row);
  });

  it("all Layer 3 rows pass (catch-all sweep for future corpus additions)", async () => {
    const rows = await loadCorpus();
    const layer3Rows = rows.filter((r) => r.expectedLayer === 3);
    for (const row of layer3Rows) {
      assertLayer3Row(row);
    }
  });
});
