// SPDX-License-Identifier: MIT
//
// bench/B4-tokens-v5/reference-emit/paid-experiment.test.mjs
//
// Validates paid-experiment.mjs in --dry mode (no API calls, no ANTHROPIC_API_KEY needed).
//
// Test scope:
//   1. buildPlan() covers all (atom × model × condition × rep) cells correctly
//   2. verbatim user-message contains the impl source
//   3. reference user-message contains the real import line and DTS, NOT the full impl
//   4. system prompt is the real discovery prompt (non-empty, contains "yakcc_reference")
//   5. cost estimate is computed and > 0
//   6. plan covers the default atom/model/condition/rep matrix exactly
//   7. Deterministic: two calls to buildPlan() produce identical messages
//   8. Compound integration: real @yakcc/compile artifacts are embedded in reference msgs
//
// No mocks. No API calls. No ANTHROPIC_API_KEY required.
//
// Runner: vitest via bench/B4-tokens-v5/reference-emit/vitest.config.mjs

import { describe, it, expect, beforeAll } from "vitest";
import {
  buildPlan,
  buildVerbatimMessage,
  buildReferenceMessage,
  estimatePlanCostUsd,
  EXPERIMENT_DEFAULTS,
  SYSTEM_PROMPT,
} from "./paid-experiment.mjs";

// ---------------------------------------------------------------------------
// Shared fixture — build the plan once for all tests
// ---------------------------------------------------------------------------

let plan;
beforeAll(() => {
  plan = buildPlan();
});

// ---------------------------------------------------------------------------
// Plan structure
// ---------------------------------------------------------------------------

describe("buildPlan() — plan structure", () => {
  it("covers all (atom × model × condition × rep) cells", () => {
    const expectedCells =
      EXPERIMENT_DEFAULTS.atoms.length *
      EXPERIMENT_DEFAULTS.models.length *
      EXPERIMENT_DEFAULTS.conditions.length *
      EXPERIMENT_DEFAULTS.reps;
    expect(plan.cells).toHaveLength(expectedCells);
  });

  it("contains all default atoms", () => {
    const atomsInPlan = [...new Set(plan.cells.map((c) => c.atomId))];
    for (const atom of EXPERIMENT_DEFAULTS.atoms) {
      expect(atomsInPlan).toContain(atom);
    }
  });

  it("contains all default models", () => {
    const modelsInPlan = [...new Set(plan.cells.map((c) => c.model))];
    for (const model of EXPERIMENT_DEFAULTS.models) {
      expect(modelsInPlan).toContain(model);
    }
  });

  it("contains both conditions: verbatim and reference", () => {
    const conditionsInPlan = [...new Set(plan.cells.map((c) => c.condition))];
    expect(conditionsInPlan).toContain("verbatim");
    expect(conditionsInPlan).toContain("reference");
  });

  it("contains correct rep count per (atom, model, condition)", () => {
    for (const atom of EXPERIMENT_DEFAULTS.atoms) {
      for (const model of EXPERIMENT_DEFAULTS.models) {
        for (const condition of EXPERIMENT_DEFAULTS.conditions) {
          const matching = plan.cells.filter(
            (c) => c.atomId === atom && c.model === model && c.condition === condition,
          );
          expect(matching).toHaveLength(EXPERIMENT_DEFAULTS.reps);
          // Rep indices are 0..reps-1
          expect(matching.map((c) => c.rep).sort()).toEqual(
            Array.from({ length: EXPERIMENT_DEFAULTS.reps }, (_, i) => i),
          );
        }
      }
    }
  });

  it("carries artifacts for every atom in the plan", () => {
    for (const atom of EXPERIMENT_DEFAULTS.atoms) {
      expect(plan.artifactsByAtomId.has(atom)).toBe(true);
      const artifacts = plan.artifactsByAtomId.get(atom);
      expect(artifacts.atomId).toBe(atom);
      expect(typeof artifacts.implSource).toBe("string");
      expect(artifacts.implSource.length).toBeGreaterThan(100);
    }
  });
});

// ---------------------------------------------------------------------------
// System prompt integrity
// ---------------------------------------------------------------------------

describe("SYSTEM_PROMPT — real discovery prompt", () => {
  it("is non-empty", () => {
    expect(SYSTEM_PROMPT.length).toBeGreaterThan(100);
  });

  it("contains 'yakcc_reference'", () => {
    expect(SYSTEM_PROMPT).toContain("yakcc_reference");
  });

  it("contains Section A (reference path) text", () => {
    expect(SYSTEM_PROMPT).toContain(".yakcc/manifest.json");
  });

  it("contains Section B (verbatim path) text", () => {
    expect(SYSTEM_PROMPT).toContain("yakcc_compile");
  });
});

// ---------------------------------------------------------------------------
// verbatim user-message content
// ---------------------------------------------------------------------------

describe("buildVerbatimMessage() — verbatim condition user message", () => {
  it("contains the impl source for crc32c", () => {
    const artifacts = plan.artifactsByAtomId.get("crc32c");
    const msg = buildVerbatimMessage(artifacts);
    // Must contain a distinctive snippet from the impl
    const implSnippet = artifacts.implSource.slice(0, 60);
    expect(msg).toContain(implSnippet);
  });

  it("contains the impl source for avl-tree (large atom)", () => {
    const artifacts = plan.artifactsByAtomId.get("avl-tree");
    const msg = buildVerbatimMessage(artifacts);
    expect(msg).toContain(artifacts.implSource.slice(0, 60));
  });

  it("mentions yakcc_compile and auto_accept", () => {
    const artifacts = plan.artifactsByAtomId.get("crc32c");
    const msg = buildVerbatimMessage(artifacts);
    expect(msg).toContain("yakcc_compile");
    expect(msg).toContain("auto_accept");
  });

  it("does NOT mention .yakcc/manifest.json (ensures Section B fires, not Section A)", () => {
    for (const atom of EXPERIMENT_DEFAULTS.atoms) {
      const artifacts = plan.artifactsByAtomId.get(atom);
      const msg = buildVerbatimMessage(artifacts);
      expect(msg).not.toContain(".yakcc/manifest.json");
    }
  });

  it("cells in the plan with condition=verbatim have a message containing the impl", () => {
    const verbatimCells = plan.cells.filter((c) => c.condition === "verbatim");
    for (const cell of verbatimCells) {
      expect(cell.userMessage).toContain(cell.artifacts.implSource.slice(0, 40));
    }
  });
});

// ---------------------------------------------------------------------------
// reference user-message content
// ---------------------------------------------------------------------------

describe("buildReferenceMessage() — reference condition user message", () => {
  it("contains the real import line for crc32c (via JSON-embedded import_line field)", () => {
    const artifacts = plan.artifactsByAtomId.get("crc32c");
    const msg = buildReferenceMessage(artifacts);
    // The import line is embedded inside a JSON object as "import_line": "...",
    // so double-quotes in the value are JSON-escaped to \". Check the alias and
    // symbol are present — the alias is safe (hex chars, no escaping).
    expect(msg).toContain(artifacts.manifestEntry.alias);
    expect(msg).toContain(artifacts.symbol);
    expect(msg).toContain("import_line");
  });

  it("import line matches .yakcc/atoms/<alias> pattern", () => {
    for (const atom of EXPERIMENT_DEFAULTS.atoms) {
      const artifacts = plan.artifactsByAtomId.get(atom);
      expect(artifacts.importLine).toMatch(
        /^import \{ \w+ \} from "\.yakcc\/atoms\/[0-9a-f]+";$/,
      );
    }
  });

  it("contains the DTS content", () => {
    const artifacts = plan.artifactsByAtomId.get("lru-ttl-cache");
    const msg = buildReferenceMessage(artifacts);
    expect(msg).toContain(artifacts.dtsContent.slice(0, 20));
  });

  it("mentions .yakcc/manifest.json (ensures Section A fires)", () => {
    for (const atom of EXPERIMENT_DEFAULTS.atoms) {
      const artifacts = plan.artifactsByAtomId.get(atom);
      const msg = buildReferenceMessage(artifacts);
      expect(msg).toContain(".yakcc/manifest.json");
    }
  });

  it("does NOT contain the full impl body (reference path should not write impl)", () => {
    for (const atom of EXPERIMENT_DEFAULTS.atoms) {
      const artifacts = plan.artifactsByAtomId.get(atom);
      const msg = buildReferenceMessage(artifacts);
      // The reference message should contain the import line but NOT hundreds of lines of impl.
      // We check that a distinctive interior snippet of the impl is absent.
      const implLines = artifacts.implSource
        .split("\n")
        .filter((l) => l.trim() && !l.trim().startsWith("//") && !l.trim().startsWith("*"))
        .slice(2, 5)
        .join("\n");
      if (implLines.length > 20) {
        expect(msg).not.toContain(implLines);
      }
    }
  });

  it("cells in the plan with condition=reference contain the import_line JSON key and atom alias", () => {
    const referenceCells = plan.cells.filter((c) => c.condition === "reference");
    for (const cell of referenceCells) {
      // The import line is embedded in a JSON tool-result object, so check the
      // JSON key and the alias (hex, safe to check directly).
      expect(cell.userMessage).toContain("import_line");
      expect(cell.userMessage).toContain(cell.artifacts.manifestEntry.alias);
    }
  });
});

// ---------------------------------------------------------------------------
// Cost estimate
// ---------------------------------------------------------------------------

describe("estimatePlanCostUsd() — cost gate", () => {
  it("returns a positive total cost estimate", () => {
    const { totalUsd } = estimatePlanCostUsd(plan);
    expect(totalUsd).toBeGreaterThan(0);
  });

  it("per-cell costs are all positive", () => {
    const { perCell } = estimatePlanCostUsd(plan);
    for (const cell of perCell) {
      expect(cell.usd).toBeGreaterThan(0);
    }
  });

  it("total cost is sum of per-cell costs", () => {
    const { totalUsd, perCell } = estimatePlanCostUsd(plan);
    const sumPerCell = perCell.reduce((s, c) => s + c.usd, 0);
    expect(totalUsd).toBeCloseTo(sumPerCell, 8);
  });

  it("plan totalEstimatedCostUsd matches estimatePlanCostUsd result", () => {
    const { totalUsd } = estimatePlanCostUsd(plan);
    expect(plan.totalEstimatedCostUsd).toBeCloseTo(totalUsd, 8);
  });

  it("default plan cost is under the default cap ($5.00)", () => {
    const { totalUsd } = estimatePlanCostUsd(plan);
    expect(totalUsd).toBeLessThan(EXPERIMENT_DEFAULTS.maxUsd);
  });
});

// ---------------------------------------------------------------------------
// Determinism: two buildPlan() calls produce the same messages
// ---------------------------------------------------------------------------

describe("determinism", () => {
  it("two sequential buildPlan() calls produce identical user messages", () => {
    const plan2 = buildPlan();
    for (let i = 0; i < plan.cells.length; i++) {
      expect(plan2.cells[i].userMessage).toBe(plan.cells[i].userMessage);
    }
  });

  it("two calls produce the same import lines for each atom", () => {
    const plan2 = buildPlan();
    for (const atom of EXPERIMENT_DEFAULTS.atoms) {
      const a1 = plan.artifactsByAtomId.get(atom);
      const a2 = plan2.artifactsByAtomId.get(atom);
      expect(a2.importLine).toBe(a1.importLine);
    }
  });
});

// ---------------------------------------------------------------------------
// Compound integration test
//
// Exercises the real production sequence end-to-end:
//   1. Load impl source from reference-impl.ts (bench/B4-tokens-v5/tasks*)
//   2. Compute syntheticRoot = SHA-256(impl) — deterministic 64-char hex
//   3. Call @yakcc/compile addReference(emptyManifest, {root, symbol}) → alias
//   4. Call referenceImportLine(reference) → import { Symbol } from ".yakcc/atoms/<alias>"
//   5. Call generateAtomDts(spec, symbol) → .d.ts declaration text
//   6. Build verbatim user message: embeds full impl source
//   7. Build reference user message: embeds import line + DTS, NOT impl body
//   8. Confirm: verbatim msg >> reference msg in length (the collapse)
//
// No mocks — all @yakcc/compile calls are real production dist code.
// No API calls — builds artifacts only.
// ---------------------------------------------------------------------------

describe("compound integration: real production sequence end-to-end", () => {
  it("produces correct import line shape for all default atoms", () => {
    const IMPORT_RE = /^import \{ \w+ \} from "\.yakcc\/atoms\/[0-9a-f]+";$/;
    for (const atom of EXPERIMENT_DEFAULTS.atoms) {
      const artifacts = plan.artifactsByAtomId.get(atom);
      expect(artifacts.importLine).toMatch(IMPORT_RE);
    }
  });

  it("reference message is substantially shorter than verbatim message (output collapse)", () => {
    for (const atom of EXPERIMENT_DEFAULTS.atoms) {
      const artifacts = plan.artifactsByAtomId.get(atom);
      const verbatimMsg = buildVerbatimMessage(artifacts);
      const referenceMsg = buildReferenceMessage(artifacts);
      // The verbatim message embeds the full impl; the reference embeds only import + DTS.
      // The verbatim message must be substantially longer.
      expect(verbatimMsg.length).toBeGreaterThan(referenceMsg.length);
    }
  });

  it("avl-tree (large atom): verbatim impl > 8000 chars, reference msg embeds the import line in JSON", () => {
    const artifacts = plan.artifactsByAtomId.get("avl-tree");
    expect(artifacts.implSource.length).toBeGreaterThan(8000);
    const referenceMsg = buildReferenceMessage(artifacts);
    // The import line is embedded as a JSON field "import_line": "...".
    // Check the JSON key and the unescaped alias.
    expect(referenceMsg).toContain("import_line");
    expect(referenceMsg).toContain(artifacts.manifestEntry.alias);
    // The import line itself is a single line — no newline inside it
    expect(artifacts.importLine).not.toContain("\n");
    // The reference message length is a fraction of the verbatim impl length
    expect(referenceMsg.length).toBeLessThan(artifacts.implSource.length);
  });

  it("dijkstra-heap (large atom): reference msg has import line with correct symbol 'Graph'", () => {
    const artifacts = plan.artifactsByAtomId.get("dijkstra-heap");
    expect(artifacts.symbol).toBe("Graph");
    expect(artifacts.importLine).toContain("Graph");
    expect(artifacts.importLine).toMatch(/^import \{ Graph \} from "\.yakcc\/atoms\/[0-9a-f]+";$/);
  });

  it("crc32c (small atom): verbatim cell message in plan contains full impl, reference cell does not", () => {
    const verbatimCell = plan.cells.find(
      (c) => c.atomId === "crc32c" && c.condition === "verbatim" && c.rep === 0,
    );
    const referenceCell = plan.cells.find(
      (c) => c.atomId === "crc32c" && c.condition === "reference" && c.rep === 0,
    );
    expect(verbatimCell).toBeDefined();
    expect(referenceCell).toBeDefined();

    const artifacts = plan.artifactsByAtomId.get("crc32c");

    // Verbatim: must contain the full impl (not just a snippet)
    expect(verbatimCell.userMessage).toContain(artifacts.implSource);

    // Reference: must contain the import_line JSON key and the alias (hex, unescaped)
    expect(referenceCell.userMessage).toContain("import_line");
    expect(referenceCell.userMessage).toContain(artifacts.manifestEntry.alias);

    // Reference: must NOT contain the verbatim impl body
    // (first 100 chars of impl after stripping the license header line)
    const implBody = artifacts.implSource.split("\n").find((l) => l.trim() && !l.startsWith("//"));
    if (implBody && implBody.length > 20) {
      expect(referenceCell.userMessage).not.toContain(implBody);
    }
  });
});
