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
import {
  recordMiss,
  getAdvisoryWarning,
  resetSession,
} from "../src/descent-tracker.js";
import type { Layer4Config, Layer5Config } from "../src/enforcement-config.js";
import {
  recordTelemetryEvent,
  checkDrift,
  resetDriftSession,
  type EventSnapshot,
} from "../src/drift-detector.js";

// ---------------------------------------------------------------------------
// Corpus type
// ---------------------------------------------------------------------------

interface CorpusRow {
  id: string;
  /** For Layer 1 rows: the intent text. For Layer 2/3/4 rows: descriptive label (not interpreted). */
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
  // Layer 4 fields — present only for L4-* rows
  packageName?: string;
  bindingName?: string;
  intent?: string;
  priorMisses?: number;
  minDepth?: number;
  shallowAllowPatterns?: string[];
  // Layer 5 fields — present only for L5-* rows
  driftWindow?: Array<{
    outcome: string;
    candidateCount: number;
    specificityScore?: number;
    atomRatio?: number;
  }>;
  layer5Config?: Partial<Layer5Config>;
  expectedDriftMetric?: string;
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
// Layer 4 helpers — build Layer4Config from corpus fields and run descent tracker
// ---------------------------------------------------------------------------

/**
 * Assert a Layer 4 corpus row against the descent-tracker module.
 *
 * The row encodes the scenario via:
 *   - packageName + bindingName: the binding under test
 *   - priorMisses: number of recordMiss calls to execute before the assertion
 *   - minDepth + shallowAllowPatterns: the Layer4Config to use
 *   - intent: passed to getAdvisoryWarning (affects suggestion text)
 *   - expectedOutcome: "descent-bypass-warning" or "accept"
 *
 * Uses the actual descent-tracker functions (real production code — no mocks).
 *
 * @decision DEC-HOOK-ENF-LAYER4-DESCENT-TRACKING-001
 */
function assertLayer4Row(row: CorpusRow): void {
  const packageName = row.packageName ?? "unknown-pkg";
  const bindingName = row.bindingName ?? "unknownBinding";
  const intent = row.intent ?? row.input;
  const priorMisses = row.priorMisses ?? 0;

  const cfg: Layer4Config = {
    minDepth: row.minDepth ?? 2,
    shallowAllowPatterns: row.shallowAllowPatterns ?? [],
    disableTracking: false,
  };

  // Simulate prior import-intercept miss events.
  for (let i = 0; i < priorMisses; i++) {
    recordMiss(packageName, bindingName);
  }

  const warning = getAdvisoryWarning(packageName, bindingName, intent, cfg);

  if (row.expectedOutcome === "descent-bypass-warning") {
    expect(warning, `[${row.id}] expected DescentBypassWarning for priorMisses=${priorMisses} (${row.notes ?? ""})`).not.toBeNull();
    expect(warning?.layer, `[${row.id}] layer discriminant must be 4`).toBe(4);
    expect(warning?.status, `[${row.id}] status must be descent-bypass-warning`).toBe("descent-bypass-warning");
    // WI-600: bindingKey is canonical atom-keyed — "bindingName::bindingName" (packageName ignored).
    // See DEC-HOOK-ENF-LAYER4-KEY-CANONICAL-001.
    expect(warning?.bindingKey, `[${row.id}] bindingKey format`).toBe(`${bindingName}::${bindingName}`);
    expect(warning?.observedDepth, `[${row.id}] observedDepth must equal priorMisses`).toBe(priorMisses);
    expect(warning?.minDepth, `[${row.id}] minDepth from config`).toBe(cfg.minDepth);
  } else if (row.expectedOutcome === "accept") {
    expect(warning, `[${row.id}] expected null warning (accept) for priorMisses=${priorMisses} (${row.notes ?? ""})`).toBeNull();
  } else {
    throw new Error(`[${row.id}] unexpected expectedOutcome="${row.expectedOutcome}" for a Layer 4 row`);
  }
}

// ---------------------------------------------------------------------------
// Layer 5 assertion helper
// ---------------------------------------------------------------------------

/**
 * Assert a Layer 5 corpus row against the drift-detector module.
 *
 * The row encodes the window via `driftWindow` (array of EventSnapshot-like objects)
 * and the config via `layer5Config` (partial Layer5Config merged with getDefaults().layer5).
 *
 * Uses the real drift-detector functions (no mocks).
 *
 * @decision DEC-HOOK-ENF-LAYER5-DRIFT-DETECTION-001
 */
const L5_CORPUS_SESSION = "corpus-l5-session";

function assertLayer5Row(row: CorpusRow): void {
  // Build the Layer5Config from row fields + defaults.
  const defaults = getDefaults().layer5;
  const cfg: Layer5Config = {
    ...defaults,
    ...(row.layer5Config ?? {}),
  };

  // Reset session state for this row.
  resetDriftSession(L5_CORPUS_SESSION);

  // Feed the window events into the rolling buffer.
  for (const snap of row.driftWindow ?? []) {
    const eventSnap: EventSnapshot = {
      outcome: snap.outcome,
      candidateCount: snap.candidateCount,
      ...(snap.specificityScore !== undefined ? { specificityScore: snap.specificityScore } : {}),
      ...(snap.atomRatio !== undefined ? { atomRatio: snap.atomRatio } : {}),
    };
    recordTelemetryEvent(L5_CORPUS_SESSION, eventSnap, cfg.rollingWindow);
  }

  const result = checkDrift(L5_CORPUS_SESSION, cfg);

  if (row.expectedOutcome === "drift-alert") {
    expect(result.status, `[${row.id}] expected drift_alert (${row.notes ?? ""})`).toBe("drift_alert");
    expect(result.layer, `[${row.id}] layer discriminant must be 5`).toBe(5);
    if (result.status === "drift_alert" && row.expectedDriftMetric !== undefined) {
      expect(result.driftMetric, `[${row.id}] expected driftMetric=${row.expectedDriftMetric}`).toBe(row.expectedDriftMetric);
    }
  } else if (row.expectedOutcome === "accept") {
    expect(result.status, `[${row.id}] expected ok (accept) (${row.notes ?? ""})`).toBe("ok");
    expect(result.layer, `[${row.id}] layer discriminant must be 5`).toBe(5);
  } else {
    throw new Error(`[${row.id}] unexpected expectedOutcome="${row.expectedOutcome}" for a Layer 5 row`);
  }

  // Always reset after the row.
  resetDriftSession(L5_CORPUS_SESSION);
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
// Config and session reset between tests (needed for L2 env-override and L4 session tests)
// ---------------------------------------------------------------------------

beforeEach(() => {
  resetConfigOverride();
  resetSession();
  resetDriftSession(L5_CORPUS_SESSION);
});

afterEach(() => {
  resetConfigOverride();
  resetSession();
  resetDriftSession(L5_CORPUS_SESSION);
});

// ---------------------------------------------------------------------------
// Structural invariants
// ---------------------------------------------------------------------------

describe("Layer 6 eval corpus — structural invariants", () => {
  it("corpus JSON loads successfully with ≥50 rows (S6 closer target)", async () => {
    const rows = await loadCorpus();
    expect(rows.length).toBeGreaterThanOrEqual(50);
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

  it("S6 grows Layer 1 rows to ≥10 (S1 seeded 7; S6 adds 3)", async () => {
    const rows = await loadCorpus();
    const layer1Rows = rows.filter((r) => r.expectedLayer === 1);
    expect(layer1Rows.length).toBeGreaterThanOrEqual(10);
  });

  it("S6 grows Layer 2 rows to ≥10 (S2 seeded 5; S6 adds 5)", async () => {
    const rows = await loadCorpus();
    const layer2Rows = rows.filter((r) => r.expectedLayer === 2);
    expect(layer2Rows.length).toBeGreaterThanOrEqual(10);
  });

  it("S6 grows Layer 3 rows to ≥10 (S3 seeded 5; S6 adds 5)", async () => {
    const rows = await loadCorpus();
    const layer3Rows = rows.filter((r) => r.expectedLayer === 3);
    expect(layer3Rows.length).toBeGreaterThanOrEqual(10);
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

  it("S6 grows Layer 4 rows to ≥10 (S4 seeded 3; S6 adds 7)", async () => {
    const rows = await loadCorpus();
    const layer4Rows = rows.filter((r) => r.expectedLayer === 4);
    expect(layer4Rows.length).toBeGreaterThanOrEqual(10);
  });

  it("all S4 row ids follow L4-NNN format", async () => {
    const rows = await loadCorpus();
    const layer4Rows = rows.filter((r) => r.expectedLayer === 4);
    for (const row of layer4Rows) {
      expect(row.id, `id should match L4-NNN`).toMatch(/^L4-\d{3}$/);
    }
  });

  it("S6 grows Layer 5 rows to ≥10 (S5 seeded 3; S6 adds 7)", async () => {
    const rows = await loadCorpus();
    const layer5Rows = rows.filter((r) => r.expectedLayer === 5);
    expect(layer5Rows.length).toBeGreaterThanOrEqual(10);
  });

  it("all S5 row ids follow L5-NNN format", async () => {
    const rows = await loadCorpus();
    const layer5Rows = rows.filter((r) => r.expectedLayer === 5);
    for (const row of layer5Rows) {
      expect(row.id, `id should match L5-NNN`).toMatch(/^L5-\d{3}$/);
    }
  });

  it("corpus has exactly 50 rows (S6 closer target: 10 per layer × 5 layers)", async () => {
    const rows = await loadCorpus();
    expect(rows.length).toBe(50);
  });

  it("each layer has exactly 10 rows (proportional coverage requirement)", async () => {
    const rows = await loadCorpus();
    for (const layer of [1, 2, 3, 4, 5]) {
      const count = rows.filter((r) => r.expectedLayer === layer).length;
      expect(count, `Layer ${layer} must have exactly 10 rows`).toBe(10);
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

  it("L1-008: 'misc things processor' → intent-too-broad (meta_word + stop_words + too_short)", async () => {
    const rows = await loadCorpus();
    const row = rows.find((r) => r.id === "L1-008");
    expect(row, "L1-008 must be in corpus").toBeDefined();
    if (row) assertLayer1Row(row);
  });

  it("L1-009: 'parse ISO 8601 datetime string into UTC epoch milliseconds' → accept", async () => {
    const rows = await loadCorpus();
    const row = rows.find((r) => r.id === "L1-009");
    expect(row, "L1-009 must be in corpus").toBeDefined();
    if (row) assertLayer1Row(row);
  });

  it("L1-010: 'encode binary buffer as base64url without padding' → accept", async () => {
    const rows = await loadCorpus();
    const row = rows.find((r) => r.id === "L1-010");
    expect(row, "L1-010 must be in corpus").toBeDefined();
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

  it("L2-006: 11 total weak candidates → result-set-too-large (exceeds maxOverall=10)", async () => {
    const rows = await loadCorpus();
    const row = rows.find((r) => r.id === "L2-006");
    expect(row, "L2-006 must be in corpus").toBeDefined();
    if (row) assertLayer2Row(row);
  });

  it("L2-007: 0 total candidates → accept (empty result set)", async () => {
    const rows = await loadCorpus();
    const row = rows.find((r) => r.id === "L2-007");
    expect(row, "L2-007 must be in corpus").toBeDefined();
    if (row) assertLayer2Row(row);
  });

  it("L2-008: 1 confident candidate → accept (single ideal match)", async () => {
    const rows = await loadCorpus();
    const row = rows.find((r) => r.id === "L2-008");
    expect(row, "L2-008 must be in corpus").toBeDefined();
    if (row) assertLayer2Row(row);
  });

  it("L2-009: 8 confident candidates → result-set-too-large", async () => {
    const rows = await loadCorpus();
    const row = rows.find((r) => r.id === "L2-009");
    expect(row, "L2-009 must be in corpus").toBeDefined();
    if (row) assertLayer2Row(row);
  });

  it("L2-010: 10 total weak candidates → accept (at maxOverall=10 boundary)", async () => {
    const rows = await loadCorpus();
    const row = rows.find((r) => r.id === "L2-010");
    expect(row, "L2-010 must be in corpus").toBeDefined();
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

  it("corpus covers both descent-bypass-warning and accept outcomes in Layer 4", async () => {
    const rows = await loadCorpus();
    const layer4Rows = rows.filter((r) => r.expectedLayer === 4);
    const hasWarn = layer4Rows.some((r) => r.expectedOutcome === "descent-bypass-warning");
    const hasAccept = layer4Rows.some((r) => r.expectedOutcome === "accept");
    expect(hasWarn, "corpus must contain at least one descent-bypass-warning row").toBe(true);
    expect(hasAccept, "corpus must contain at least one accept row for Layer 4").toBe(true);
  });

  it("corpus has grown to 50 rows (S6 final: S1=10 + S2=10 + S3=10 + S4=10 + S5=10)", async () => {
    const rows = await loadCorpus();
    expect(rows.length).toBe(50);
  });

  it("corpus covers both drift-alert and accept outcomes in Layer 5", async () => {
    const rows = await loadCorpus();
    const layer5Rows = rows.filter((r) => r.expectedLayer === 5);
    const hasAlert = layer5Rows.some((r) => r.expectedOutcome === "drift-alert");
    const hasAccept = layer5Rows.some((r) => r.expectedOutcome === "accept");
    expect(hasAlert, "corpus must contain at least one drift-alert row").toBe(true);
    expect(hasAccept, "corpus must contain at least one accept row for Layer 5").toBe(true);
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

  it("L3-006: moderate atom (atomComplexity=50, needComplexity=1) → atom-oversized (ratio=50)", async () => {
    const rows = await loadCorpus();
    const row = rows.find((r) => r.id === "L3-006");
    expect(row, "L3-006 must be in corpus").toBeDefined();
    if (row) assertLayer3Row(row);
  });

  it("L3-007: moderate atom with reasonable callsite (ratio=7.5 < 10) → accept", async () => {
    const rows = await loadCorpus();
    const row = rows.find((r) => r.id === "L3-007");
    expect(row, "L3-007 must be in corpus").toBeDefined();
    if (row) assertLayer3Row(row);
  });

  it("L3-008: atomComplexity=19 below minFloor=20 → accept (gate bypassed)", async () => {
    const rows = await loadCorpus();
    const row = rows.find((r) => r.id === "L3-008");
    expect(row, "L3-008 must be in corpus").toBeDefined();
    if (row) assertLayer3Row(row);
  });

  it("L3-009: very large atom (atomComplexity=200, needComplexity=3) → atom-oversized (ratio≈66.7)", async () => {
    const rows = await loadCorpus();
    const row = rows.find((r) => r.id === "L3-009");
    expect(row, "L3-009 must be in corpus").toBeDefined();
    if (row) assertLayer3Row(row);
  });

  it("L3-010: large atom with large callsite (ratio=5.0 < 10) → accept", async () => {
    const rows = await loadCorpus();
    const row = rows.find((r) => r.id === "L3-010");
    expect(row, "L3-010 must be in corpus").toBeDefined();
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

// ---------------------------------------------------------------------------
// Layer 4 eval gate — table-driven (S4 additive, wi-592-s4-layer4)
// ---------------------------------------------------------------------------

describe("Layer 6 eval corpus — Layer 4 rows", () => {
  it("L4-001: zero-miss scenario (depth=0 < minDepth=2) → descent-bypass-warning", async () => {
    const rows = await loadCorpus();
    const row = rows.find((r) => r.id === "L4-001");
    expect(row, "L4-001 must be in corpus").toBeDefined();
    if (row) assertLayer4Row(row);
  });

  it("L4-002: sufficient-miss scenario (depth=2 equals minDepth=2) → accept (no warning)", async () => {
    const rows = await loadCorpus();
    const row = rows.find((r) => r.id === "L4-002");
    expect(row, "L4-002 must be in corpus").toBeDefined();
    if (row) assertLayer4Row(row);
  });

  it("L4-003: shallow-allow bypass ('add' matches ^add$, depth=0) → accept (no warning)", async () => {
    const rows = await loadCorpus();
    const row = rows.find((r) => r.id === "L4-003");
    expect(row, "L4-003 must be in corpus").toBeDefined();
    if (row) assertLayer4Row(row);
  });

  it("L4-004: one-miss scenario (depth=1 < minDepth=2) → descent-bypass-warning", async () => {
    const rows = await loadCorpus();
    const row = rows.find((r) => r.id === "L4-004");
    expect(row, "L4-004 must be in corpus").toBeDefined();
    if (row) assertLayer4Row(row);
  });

  it("L4-005: over-threshold scenario (depth=3 > minDepth=2) → accept", async () => {
    const rows = await loadCorpus();
    const row = rows.find((r) => r.id === "L4-005");
    expect(row, "L4-005 must be in corpus").toBeDefined();
    if (row) assertLayer4Row(row);
  });

  it("L4-006: shallow-allow with raised minDepth=3 ('abs' matches ^abs$) → accept", async () => {
    const rows = await loadCorpus();
    const row = rows.find((r) => r.id === "L4-006");
    expect(row, "L4-006 must be in corpus").toBeDefined();
    if (row) assertLayer4Row(row);
  });

  it("L4-007: 'debounce' not shallow-allowed, depth=0 < minDepth=2 → descent-bypass-warning", async () => {
    const rows = await loadCorpus();
    const row = rows.find((r) => r.id === "L4-007");
    expect(row, "L4-007 must be in corpus").toBeDefined();
    if (row) assertLayer4Row(row);
  });

  it("L4-008: well-warmed scenario (depth=5 >> minDepth=2) → accept", async () => {
    const rows = await loadCorpus();
    const row = rows.find((r) => r.id === "L4-008");
    expect(row, "L4-008 must be in corpus").toBeDefined();
    if (row) assertLayer4Row(row);
  });

  it("L4-009: depth=1 < elevated minDepth=3 → descent-bypass-warning", async () => {
    const rows = await loadCorpus();
    const row = rows.find((r) => r.id === "L4-009");
    expect(row, "L4-009 must be in corpus").toBeDefined();
    if (row) assertLayer4Row(row);
  });

  it("L4-010: depth=3 equals elevated minDepth=3 → accept (exactly warmed)", async () => {
    const rows = await loadCorpus();
    const row = rows.find((r) => r.id === "L4-010");
    expect(row, "L4-010 must be in corpus").toBeDefined();
    if (row) assertLayer4Row(row);
  });

  it("all Layer 4 rows pass (catch-all sweep for future corpus additions)", async () => {
    const rows = await loadCorpus();
    const layer4Rows = rows.filter((r) => r.expectedLayer === 4);
    for (const row of layer4Rows) {
      // Each row needs a fresh session — layer4 is stateful (miss accumulation).
      resetSession();
      assertLayer4Row(row);
    }
  });
});

// ---------------------------------------------------------------------------
// Layer 5 eval gate — table-driven (S5 additive, wi-593-s5-layer5)
// ---------------------------------------------------------------------------

describe("Layer 6 eval corpus — Layer 5 rows", () => {
  it("L5-001: 5/10 bypass events (50% > descentBypassMax=40%) → drift-alert (descent_bypass_rate)", async () => {
    const rows = await loadCorpus();
    const row = rows.find((r) => r.id === "L5-001");
    expect(row, "L5-001 must be in corpus").toBeDefined();
    if (row) assertLayer5Row(row);
  });

  it("L5-002: 20 clean events (specificity=0.80, candidateCount=2) → accept", async () => {
    const rows = await loadCorpus();
    const row = rows.find((r) => r.id === "L5-002");
    expect(row, "L5-002 must be in corpus").toBeDefined();
    if (row) assertLayer5Row(row);
  });

  it("L5-003: 20 low-specificity events (score=0.30 < floor=0.55) → drift-alert (specificity_floor)", async () => {
    const rows = await loadCorpus();
    const row = rows.find((r) => r.id === "L5-003");
    expect(row, "L5-003 must be in corpus").toBeDefined();
    if (row) assertLayer5Row(row);
  });

  it("L5-004: 10 events with candidateCount 6-9 (median=7 > resultSetMedianMax=5) → drift-alert (result_set_median)", async () => {
    const rows = await loadCorpus();
    const row = rows.find((r) => r.id === "L5-004");
    expect(row, "L5-004 must be in corpus").toBeDefined();
    if (row) assertLayer5Row(row);
  });

  it("L5-005: 10 events with atomRatio 11-16 (median≈12.5 > ratioMedianMax=4) → drift-alert (ratio_median)", async () => {
    const rows = await loadCorpus();
    const row = rows.find((r) => r.id === "L5-005");
    expect(row, "L5-005 must be in corpus").toBeDefined();
    if (row) assertLayer5Row(row);
  });

  it("L5-006: 2/5 = 40% bypass rate exactly at descentBypassMax=0.40 boundary → accept (not strictly >)", async () => {
    const rows = await loadCorpus();
    const row = rows.find((r) => r.id === "L5-006");
    expect(row, "L5-006 must be in corpus").toBeDefined();
    if (row) assertLayer5Row(row);
  });

  it("L5-007: single event, no specificityScore or atomRatio → accept (insufficient data for mean/median)", async () => {
    const rows = await loadCorpus();
    const row = rows.find((r) => r.id === "L5-007");
    expect(row, "L5-007 must be in corpus").toBeDefined();
    if (row) assertLayer5Row(row);
  });

  it("L5-008: disableDetection=true → accept regardless of window contents", async () => {
    const rows = await loadCorpus();
    const row = rows.find((r) => r.id === "L5-008");
    expect(row, "L5-008 must be in corpus").toBeDefined();
    if (row) assertLayer5Row(row);
  });

  it("L5-009: dual-dimension alert (bypass=60%>40% AND specificity=0.42<0.55) → drift-alert", async () => {
    const rows = await loadCorpus();
    const row = rows.find((r) => r.id === "L5-009");
    expect(row, "L5-009 must be in corpus").toBeDefined();
    if (row) assertLayer5Row(row);
  });

  it("L5-010: all four dimensions healthy (specificity=0.724, bypass=0%, candidateCount=3, ratio=3.5) → accept", async () => {
    const rows = await loadCorpus();
    const row = rows.find((r) => r.id === "L5-010");
    expect(row, "L5-010 must be in corpus").toBeDefined();
    if (row) assertLayer5Row(row);
  });

  it("all Layer 5 rows pass (catch-all sweep for future corpus additions)", async () => {
    const rows = await loadCorpus();
    const layer5Rows = rows.filter((r) => r.expectedLayer === 5);
    for (const row of layer5Rows) {
      assertLayer5Row(row);
    }
  });
});
