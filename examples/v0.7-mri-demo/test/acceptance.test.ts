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
import { join } from "node:path";
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
  it("universalize() reaches intent-extraction step for MIT-licensed source (offline: AnthropicApiKeyMissingError)", async () => {
    // Read the demo target itself — self-referential but deliberate: the parser
    // is the subject of the v0.7 demo and its source is well-typed MIT content.
    const srcPath = join(
      new URL(".", import.meta.url).pathname,
      "../src/argv-parser.ts",
    );
    const raw = await readFile(srcPath, "utf-8");

    // Strip SPDX comment lines so the source bytes are stable across formatting.
    const source = raw
      .split("\n")
      .filter((line) => !line.startsWith("// SPDX-License-Identifier"))
      .join("\n");

    // The pipeline should pass the license gate (MIT source accepted) and then
    // throw AnthropicApiKeyMissingError at the intent-extraction step — proving
    // offline-tolerant acceptance: the gate, the router, and the API-key check
    // all executed in the correct order.
    await expect(
      universalize({ source }, mockRegistry),
    ).rejects.toThrow(AnthropicApiKeyMissingError);
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
