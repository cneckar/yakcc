/**
 * @decision DEC-LICENSE-WIRING-002
 * title: End-to-end wiring tests for licenseGate inside universalize() (WI-013-02)
 * status: decided
 * rationale: These tests exercise the real production sequence:
 *   universalize() → detectLicense() → licenseGate() → [throw or continue]
 *   → extractIntent() (cache) → decompose() → slice()
 *
 * Production trigger: universalize() is called by the continuous universalizer
 * loop for each candidate block emitted by the compiler.
 *
 * Real production sequence:
 *   1. Caller invokes universalize(candidate, registry, options).
 *   2. detectLicense(candidate.source) scans the raw source string.
 *   3. licenseGate(detection) accepts or refuses the detection.
 *   4. If refused, LicenseRefusedError is thrown immediately (no API call).
 *   5. If accepted, extractIntent reads from the file-system cache (or API).
 *   6. decompose() parses the TypeScript source and builds a RecursionTree.
 *   7. slice() walks the tree and emits SlicePlanEntry items.
 *   8. UniversalizeResult carries licenseDetection so callers can introspect.
 *
 * These tests cross the universalize → detectLicense → licenseGate →
 * extractIntent → decompose → slice component boundaries in one call.
 *
 * Mocking strategy: registry is a plain-object stub (no SQLite). Intent
 * extraction is bypassed via offline: true + pre-seeded cache. No real network
 * calls are made. Source strings carry SPDX comments / Unlicense preamble as
 * leading lines to exercise the detector's signal paths.
 */

import { mkdir } from "node:fs/promises";
import * as os from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeIntent } from "../cache/file-cache.js";
import { keyFromIntentInputs, sourceHash } from "../cache/key.js";
import { LicenseRefusedError, universalize } from "../index.js";
import {
  DEFAULT_MODEL,
  INTENT_PROMPT_VERSION,
  INTENT_SCHEMA_VERSION,
} from "../intent/constants.js";
import type { IntentCard } from "../intent/types.js";
import type { ShaveRegistryView } from "../types.js";

// ---------------------------------------------------------------------------
// Atomic source — expression-body arrow function, zero control-flow boundaries.
// Decompose() classifies the SourceFile as an atom in one step.
// The SPDX comment / Unlicense preamble is prepended per test.
// ---------------------------------------------------------------------------

const ATOM_BODY = `const isDigit = (c: string): boolean => c >= "0" && c <= "9";`;

// ---------------------------------------------------------------------------
// Registry stub — no matches; all nodes become NovelGlueEntry.
// ---------------------------------------------------------------------------

const emptyRegistry: ShaveRegistryView = {
  selectBlocks: async () => [],
  getBlock: async () => undefined,
  findByCanonicalAstHash: async () => [],
};

// ---------------------------------------------------------------------------
// Per-test tmpdir + API key isolation
// ---------------------------------------------------------------------------

let cacheDir: string;

beforeEach(async () => {
  const unique = Math.random().toString(36).slice(2);
  cacheDir = join(os.tmpdir(), `wire-license-test-${unique}`);
  await mkdir(cacheDir, { recursive: true });
  // biome-ignore lint/performance/noDelete: process.env requires delete to truly unset
  delete process.env.ANTHROPIC_API_KEY;
});

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await rm(cacheDir, { recursive: true, force: true }).catch(() => {});
  // biome-ignore lint/performance/noDelete: process.env requires delete to truly unset
  delete process.env.ANTHROPIC_API_KEY;
});

// ---------------------------------------------------------------------------
// Helper: pre-seed a valid IntentCard into the cache for a given source string
// ---------------------------------------------------------------------------

async function seedCache(source: string): Promise<IntentCard> {
  const sh = sourceHash(source);
  const key = keyFromIntentInputs({
    sourceHash: sh,
    modelTag: DEFAULT_MODEL,
    promptVersion: INTENT_PROMPT_VERSION,
    schemaVersion: INTENT_SCHEMA_VERSION,
  });
  const card: IntentCard = {
    schemaVersion: 1,
    behavior: "Checks whether a character is a decimal digit",
    inputs: [{ name: "c", typeHint: "string", description: "A single character" }],
    outputs: [{ name: "result", typeHint: "boolean", description: "True if c is 0-9" }],
    preconditions: [],
    postconditions: [],
    notes: [],
    modelVersion: DEFAULT_MODEL,
    promptVersion: INTENT_PROMPT_VERSION,
    sourceHash: sh,
    extractedAt: "2025-01-01T00:00:00.000Z",
  };
  await writeIntent(cacheDir, key, card);
  return card;
}

// ---------------------------------------------------------------------------
// Test 1: MIT-licensed candidate — accepted, licenseDetection on result
// ---------------------------------------------------------------------------

describe("universalize() license wiring — MIT-licensed source", () => {
  it("accepts MIT source, returns licenseDetection.identifier === 'MIT', no license-gate in stubbed", async () => {
    const source = `// SPDX-License-Identifier: MIT\n${ATOM_BODY}`;
    await seedCache(source);

    const result = await universalize({ source }, emptyRegistry, { cacheDir, offline: true });

    // License was accepted — result carries the detection.
    expect(result.licenseDetection.identifier).toBe("MIT");
    expect(result.licenseDetection.source).toBe("spdx-comment");

    // "license-gate" is no longer in stubbed — it is live.
    expect(result.diagnostics.stubbed).not.toContain("license-gate");

    // Pipeline completed normally.
    expect(result.intentCard.behavior).toBeTruthy();
    expect(result.slicePlan.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Test 2: GPL-licensed candidate — refused with LicenseRefusedError
// ---------------------------------------------------------------------------

describe("universalize() license wiring — GPL-licensed source", () => {
  it("throws LicenseRefusedError with copyleft reason for GPL-3.0-or-later source", async () => {
    const source = `// SPDX-License-Identifier: GPL-3.0-or-later\n${ATOM_BODY}`;

    await expect(
      universalize({ source }, emptyRegistry, { cacheDir, offline: true }),
    ).rejects.toThrow(LicenseRefusedError);

    // Also verify the error message mentions "copyleft" and the detection
    // carries the correct identifier.
    try {
      await universalize({ source }, emptyRegistry, { cacheDir, offline: true });
    } catch (err) {
      expect(err).toBeInstanceOf(LicenseRefusedError);
      const lre = err as LicenseRefusedError;
      expect(lre.detection.identifier).toBe("GPL-3.0-or-later");
      expect(lre.message.toLowerCase()).toContain("copyleft");
    }
  });
});

// ---------------------------------------------------------------------------
// Test 3: Unlicense preamble — accepted via dedication signal
// ---------------------------------------------------------------------------

describe("universalize() license wiring — Unlicense preamble", () => {
  it("accepts Unlicense preamble, returns licenseDetection.identifier === 'Unlicense'", async () => {
    // Full Unlicense opening sentence triggers the 'dedication' signal path.
    const unlicensePreamble =
      "// This is free and unencumbered software released into the public domain.\n";
    const source = `${unlicensePreamble}${ATOM_BODY}`;
    await seedCache(source);

    const result = await universalize({ source }, emptyRegistry, { cacheDir, offline: true });

    expect(result.licenseDetection.identifier).toBe("Unlicense");
    expect(result.licenseDetection.source).toBe("dedication");
    expect(result.diagnostics.stubbed).not.toContain("license-gate");
    expect(result.slicePlan.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Test 4: Unknown license (no signal) — refused with LicenseRefusedError
// ---------------------------------------------------------------------------

describe("universalize() license wiring — no license signal", () => {
  it("throws LicenseRefusedError with 'no recognizable' reason when source has no license comment", async () => {
    // Bare source: no SPDX comment, no Unlicense phrase, no header pattern.
    const source = ATOM_BODY;

    await expect(
      universalize({ source }, emptyRegistry, { cacheDir, offline: true }),
    ).rejects.toThrow(LicenseRefusedError);

    try {
      await universalize({ source }, emptyRegistry, { cacheDir, offline: true });
    } catch (err) {
      expect(err).toBeInstanceOf(LicenseRefusedError);
      const lre = err as LicenseRefusedError;
      expect(lre.message.toLowerCase()).toContain("no recognizable");
    }
  });
});

// ---------------------------------------------------------------------------
// Test 5: LicenseRefusedError instanceof Error sanity check
// ---------------------------------------------------------------------------

describe("LicenseRefusedError class", () => {
  it("is instanceof Error and carries detection", () => {
    const detection = { identifier: "GPL-2.0", source: "spdx-comment" as const };
    const err = new LicenseRefusedError(
      "copyleft/proprietary license detected: GPL-2.0",
      detection,
    );

    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(LicenseRefusedError);
    expect(err.name).toBe("LicenseRefusedError");
    expect(err.message).toContain("License refused:");
    expect(err.detection).toBe(detection);
    expect(err.detection.identifier).toBe("GPL-2.0");
  });
});
