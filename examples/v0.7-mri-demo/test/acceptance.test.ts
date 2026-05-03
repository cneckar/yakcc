/**
 * v0.7 acceptance tests — offline-tolerant
 *
 * Tests A-D cover the acceptance criteria achievable without ANTHROPIC_API_KEY.
 * Items requiring a live API key are documented in README.md with the ⚠️ marker.
 *
 * Test A — License refusal (acceptance item d)
 * Test B — Pipeline structural smoke test (acceptance item a, partial)
 * Test C — Public surface contract
 * Test D — Compile assembleCandidate accessibility
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  AnthropicApiKeyMissingError,
  LicenseRefusedError,
  detectLicense,
  licenseGate,
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
// Test A — License refusal (acceptance item d)
// @decision DEC-LICENSE-GATE-001: licenseGate refuses copyleft licenses.
// The gate runs before any LLM call, making this test fully offline.
// ---------------------------------------------------------------------------

describe("Test A: license refusal", () => {
  it("universalize() throws LicenseRefusedError for GPL-3.0-or-later source", async () => {
    const gplSource = [
      "// SPDX-License-Identifier: GPL-3.0-or-later",
      "// This file is intentionally GPL-licensed — it must be refused by yakcc shave.",
      "export function reject(): boolean { return false; }",
    ].join("\n");

    await expect(
      universalize({ source: gplSource }, mockRegistry),
    ).rejects.toThrow(LicenseRefusedError);
  });

  it("LicenseRefusedError carries detection.identifier matching GPL-3.0-or-later", async () => {
    const gplSource = [
      "// SPDX-License-Identifier: GPL-3.0-or-later",
      "export function reject(): boolean { return false; }",
    ].join("\n");

    let caught: LicenseRefusedError | undefined;
    try {
      await universalize({ source: gplSource }, mockRegistry);
    } catch (err) {
      if (err instanceof LicenseRefusedError) caught = err;
    }

    expect(caught).toBeInstanceOf(LicenseRefusedError);
    expect(caught?.detection.identifier).toMatch(/GPL-3\.0-or-later/);
  });

  it("detectLicense + licenseGate work synchronously without API key", () => {
    const gplSource = "// SPDX-License-Identifier: GPL-3.0-or-later\nexport {}";
    const detection = detectLicense(gplSource);
    const result = licenseGate(detection);
    expect(result.accepted).toBe(false);
    expect(detection.identifier).toMatch(/GPL-3\.0-or-later/);
  });
});

// ---------------------------------------------------------------------------
// Test B — Pipeline structural smoke test (acceptance item a, partial)
//
// Reads argv-parser.ts (the MIT-licensed TS demo target), strips the SPDX
// comment so the candidate bytes are stable, then calls universalize() with
// the mock registry. Expects AnthropicApiKeyMissingError — proving the
// pipeline passed the license gate and reached the intent-extraction step.
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
    //   1. Passes the license gate (MIT source accepted).
    //   2. Extracts intent via TypeScript Compiler API — no API key needed.
    //   3. Decomposes via decompose() — previously threw CanonicalAstParseError
    //      on the while-loop body's continue/break; now succeeds.
    //   4. Returns a UniversalizeResult with a slicePlan.
    //
    // The license gate fires before any LLM call, so this test proves the gate
    // works AND that the static decompose path runs end-to-end.
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
// ---------------------------------------------------------------------------

describe("Test C: public surface contract (@yakcc/shave)", () => {
  it("shave is a function", () => {
    expect(typeof shave).toBe("function");
  });

  it("universalize is a function", () => {
    expect(typeof universalize).toBe("function");
  });

  it("LicenseRefusedError is a class", () => {
    expect(typeof LicenseRefusedError).toBe("function");
    const instance = new LicenseRefusedError("test", {
      identifier: "GPL-3.0-or-later",
      confidence: "high",
      method: "spdx-header",
    });
    expect(instance).toBeInstanceOf(LicenseRefusedError);
    expect(instance).toBeInstanceOf(Error);
  });

  it("AnthropicApiKeyMissingError is a class", () => {
    expect(typeof AnthropicApiKeyMissingError).toBe("function");
    const instance = new AnthropicApiKeyMissingError();
    expect(instance).toBeInstanceOf(Error);
  });

  it("detectLicense is a function", () => {
    expect(typeof detectLicense).toBe("function");
  });

  it("licenseGate is a function", () => {
    expect(typeof licenseGate).toBe("function");
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
