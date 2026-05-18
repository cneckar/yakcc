/**
 * v0.7 acceptance tests — offline-tolerant
 *
 * Tests B-D cover the acceptance criteria achievable without ANTHROPIC_API_KEY.
 * Items requiring a live API key are documented in README.md with the ⚠️ marker.
 *
 * Test B — Pipeline structural smoke test (acceptance item a, partial)
 * Test C — Public surface contract
 * Test D — Compile assembleCandidate accessibility
 *
 * Note: Test A (License refusal) was removed by DEC-LICENSE-GATE-REMOVE-001 (WI-682,
 * 2026-05-17). yakcc reimplements behavior; license-of-origin is not gated at ingestion.
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  AnthropicApiKeyMissingError,
  shave,
  universalize,
} from "@yakcc/shave";
import type { ShaveRegistryView } from "@yakcc/shave";
import { assembleCandidate, CandidateNotResolvableError } from "@yakcc/compile";

// ---------------------------------------------------------------------------
// Minimal mock registry — no SQLite, no I/O, returns no matches
// ---------------------------------------------------------------------------

const mockRegistry: ShaveRegistryView = {
  findByCanonicalAstHash: async (_hash: string) => undefined,
};

// ---------------------------------------------------------------------------
// Test B — Pipeline structural smoke test (acceptance item a, partial)
//
// Reads argv-parser.ts (the MIT-licensed TS demo target), strips the SPDX
// comment so the candidate bytes are stable, then calls universalize() with
// the mock registry. Expects AnthropicApiKeyMissingError — proving the
// pipeline reached the intent-extraction step.
//
// NOTE: Live decomposition requires ANTHROPIC_API_KEY. The offline cache path
// requires a public seedIntentCache helper from @yakcc/shave (deferred). Once
// either is available, this test can be upgraded to assert a real UniversalizeResult.
// ---------------------------------------------------------------------------

describe("Test B: pipeline structural smoke test", () => {
  it("universalize() decomposes MIT-licensed source without CanonicalAstParseError (static intent path, B-011 regression)", { timeout: 30_000 }, async () => {
    // Read the demo target itself — self-referential but deliberate: the parser
    // is the subject of the v0.7 demo and its source is well-typed MIT content.
    // @decision DEC-WI026-FILEURLTOPATH-001 — use fileURLToPath instead of URL.pathname.
    // On Windows URL.pathname returns "/C:/..." which path.join treats as drive-rooted,
    // producing "C:\C:\..." (ENOENT). fileURLToPath collapses URL-relative resolution
    // into a native OS path on every platform.
    const srcPath = fileURLToPath(new URL("../src/argv-parser.ts", import.meta.url));
    const raw = await readFile(srcPath, "utf-8");

    // Strip SPDX comment lines so the source bytes are stable across formatting.
    const source = raw
      .split("\n")
      .filter((line) => !line.startsWith("// SPDX-License-Identifier"))
      .join("\n");

    // WI-033 removes the WI-026 workaround that pinned intentStrategy: "llm".
    // B-011 is fixed: the slicer now treats loops with escaping continue/break
    // as atomic (DEC-SLICER-LOOP-CONTROL-FLOW-001), so the static path can
    // decompose argv-parser.ts without hitting CanonicalAstParseError.
    //
    // With intentStrategy: "static" (the default), the pipeline:
    //   1. Extracts intent via TypeScript Compiler API — no API key needed.
    //   2. Decomposes via decompose() — previously threw CanonicalAstParseError
    //      on the while-loop body's continue/break; now succeeds.
    //   3. Returns a UniversalizeResult with a slicePlan.
    //
    // DEC-LICENSE-GATE-REMOVE-001: license gate removed (WI-682). This test
    // proves the static decompose path runs end-to-end without license gating.
    const result = await universalize({ source }, mockRegistry, {
      intentStrategy: "static",
    });

    // The result must have a non-empty slicePlan (atoms were extracted).
    expect(result.slicePlan.length).toBeGreaterThan(0);
    // No registry matches → all entries are novel-glue.
    for (const entry of result.slicePlan) {
      expect(entry.kind).toBe("novel-glue");
    }
    // matchedPrimitives is empty (mock registry has no entries).
    expect(result.matchedPrimitives).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Test C — Public surface contract
//
// Asserts that every symbol listed in the v0.7 public surface is importable
// and defined. This proves the @yakcc/shave package is correctly consumable
// as a downstream dependency from an examples/ package.
//
// Note: LicenseRefusedError, detectLicense, licenseGate were removed from the
// public surface by DEC-LICENSE-GATE-REMOVE-001 (WI-682, 2026-05-17).
// ---------------------------------------------------------------------------

describe("Test C: public surface contract (@yakcc/shave)", () => {
  it("shave is a function", () => {
    expect(typeof shave).toBe("function");
  });

  it("universalize is a function", () => {
    expect(typeof universalize).toBe("function");
  });

  it("AnthropicApiKeyMissingError is a class", () => {
    expect(typeof AnthropicApiKeyMissingError).toBe("function");
    const instance = new AnthropicApiKeyMissingError();
    expect(instance).toBeInstanceOf(Error);
  });
});

// ---------------------------------------------------------------------------
// Test D — Compile assembleCandidate accessibility
//
// Wire-tests that assembleCandidate and CandidateNotResolvableError are
// importable and defined from @yakcc/compile. Does not call assembleCandidate
// (would require a real registry with a seeded block).
// ---------------------------------------------------------------------------

describe("Test D: compile assembleCandidate accessibility (@yakcc/compile)", () => {
  it("assembleCandidate is a function", () => {
    expect(typeof assembleCandidate).toBe("function");
  });

  it("CandidateNotResolvableError is a class", () => {
    expect(typeof CandidateNotResolvableError).toBe("function");
    // Instantiate to confirm constructor signature matches the import shape.
    // The constructor accepts any string message (not load-bearing here).
    const instance = new CandidateNotResolvableError("test");
    expect(instance).toBeInstanceOf(Error);
  });
});
