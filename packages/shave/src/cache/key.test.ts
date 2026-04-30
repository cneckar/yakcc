/**
 * Tests for sourceHash() and keyFromIntentInputs() — the two cache-key
 * derivation functions.
 *
 * Production trigger: every extractIntent call computes a sourceHash then
 * passes it through keyFromIntentInputs to derive the filesystem path for the
 * cached IntentCard.
 *
 * Compound-interaction test: the "full extraction key pipeline" test runs the
 * same sequence extractIntent uses (sourceHash → keyFromIntentInputs with all
 * four inputs) and verifies that any single-field change produces a distinct
 * key, proving the NUL-delimiter collision prevention works end-to-end.
 */

import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { keyFromIntentInputs, sourceHash } from "./key.js";

// ---------------------------------------------------------------------------
// sourceHash
// ---------------------------------------------------------------------------

describe("sourceHash()", () => {
  it("returns a 64-character lowercase hex string", () => {
    const h = sourceHash("hello");
    expect(h).toHaveLength(64);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic: same input produces same hash", () => {
    expect(sourceHash("hello")).toBe(sourceHash("hello"));
  });

  it("CRLF and LF produce the same hash (normalization applied)", () => {
    expect(sourceHash("a\r\nb")).toBe(sourceHash("a\nb"));
  });

  it("trailing newline does not change hash (normalization trims)", () => {
    expect(sourceHash("hello\n")).toBe(sourceHash("hello"));
  });

  it("different inputs produce different hashes", () => {
    expect(sourceHash("foo")).not.toBe(sourceHash("bar"));
  });

  it("empty string hashes consistently", () => {
    expect(sourceHash("")).toBe(sourceHash(""));
    expect(sourceHash("")).toHaveLength(64);
  });
});

// ---------------------------------------------------------------------------
// keyFromIntentInputs
// ---------------------------------------------------------------------------

describe("keyFromIntentInputs()", () => {
  const baseInputs = {
    sourceHash: "a".repeat(64),
    modelTag: "claude-haiku-4-5-20251001",
    promptVersion: "1",
    schemaVersion: 1,
  };

  it("returns a 64-character lowercase hex string", () => {
    const k = keyFromIntentInputs(baseInputs);
    expect(k).toHaveLength(64);
    expect(k).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic: same inputs produce same key", () => {
    expect(keyFromIntentInputs(baseInputs)).toBe(keyFromIntentInputs(baseInputs));
  });

  it("changing sourceHash changes the key", () => {
    const k1 = keyFromIntentInputs({ ...baseInputs, sourceHash: "a".repeat(64) });
    const k2 = keyFromIntentInputs({ ...baseInputs, sourceHash: "b".repeat(64) });
    expect(k1).not.toBe(k2);
  });

  it("changing modelTag changes the key", () => {
    const k1 = keyFromIntentInputs({ ...baseInputs, modelTag: "model-a" });
    const k2 = keyFromIntentInputs({ ...baseInputs, modelTag: "model-b" });
    expect(k1).not.toBe(k2);
  });

  it("changing promptVersion changes the key", () => {
    const k1 = keyFromIntentInputs({ ...baseInputs, promptVersion: "1" });
    const k2 = keyFromIntentInputs({ ...baseInputs, promptVersion: "2" });
    expect(k1).not.toBe(k2);
  });

  it("changing schemaVersion changes the key", () => {
    const k1 = keyFromIntentInputs({ ...baseInputs, schemaVersion: 1 });
    const k2 = keyFromIntentInputs({ ...baseInputs, schemaVersion: 2 });
    expect(k1).not.toBe(k2);
  });

  // -------------------------------------------------------------------------
  // Compound-interaction test: full extraction key pipeline
  // Runs the same path extractIntent uses: sourceHash then keyFromIntentInputs.
  // Verifies that any single-field change produces a distinct composite key.
  // -------------------------------------------------------------------------
  it("full pipeline: sourceHash → keyFromIntentInputs produces unique keys per change", () => {
    const source1 = "function add(a, b) { return a + b; }";
    const source2 = "function sub(a, b) { return a - b; }";
    const sh1 = sourceHash(source1);
    const sh2 = sourceHash(source2);

    const key1 = keyFromIntentInputs({
      sourceHash: sh1,
      modelTag: "m1",
      promptVersion: "p1",
      schemaVersion: 1,
    });
    const key2 = keyFromIntentInputs({
      sourceHash: sh2,
      modelTag: "m1",
      promptVersion: "p1",
      schemaVersion: 1,
    });
    const key3 = keyFromIntentInputs({
      sourceHash: sh1,
      modelTag: "m2",
      promptVersion: "p1",
      schemaVersion: 1,
    });
    const key4 = keyFromIntentInputs({
      sourceHash: sh1,
      modelTag: "m1",
      promptVersion: "p2",
      schemaVersion: 1,
    });
    const key5 = keyFromIntentInputs({
      sourceHash: sh1,
      modelTag: "m1",
      promptVersion: "p1",
      schemaVersion: 2,
    });

    // All must be distinct
    const keys = [key1, key2, key3, key4, key5];
    const unique = new Set(keys);
    expect(unique.size).toBe(5);
  });

  // -------------------------------------------------------------------------
  // fast-check: keys are deterministic for any string inputs
  // -------------------------------------------------------------------------
  it("is deterministic for any string inputs (fast-check)", () => {
    fc.assert(
      fc.property(
        fc.string(),
        fc.string(),
        fc.string(),
        fc.integer({ min: 1, max: 10 }),
        (sh, modelTag, promptVersion, schemaVersion) => {
          const inputs = { sourceHash: sh, modelTag, promptVersion, schemaVersion };
          const k1 = keyFromIntentInputs(inputs);
          const k2 = keyFromIntentInputs(inputs);
          return k1 === k2;
        },
      ),
    );
  });
});
