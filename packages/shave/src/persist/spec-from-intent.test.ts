import { describe, expect, it } from "vitest";
import type { IntentCard } from "../intent/types.js";
import { specFromIntent } from "./spec-from-intent.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FAKE_HASH = "abcdef1234567890abcdef1234567890abcdef1234567890abcdef12345678ab" as const;

function makeIntentCard(overrides: Partial<IntentCard> = {}): IntentCard {
  return {
    schemaVersion: 1,
    behavior: "Parse a comma-separated list of integers and return them as an array",
    inputs: [{ name: "raw", typeHint: "string", description: "The raw CSV string" }],
    outputs: [{ name: "result", typeHint: "number[]", description: "Parsed integers" }],
    preconditions: ["raw is a non-empty string"],
    postconditions: ["result.length >= 0"],
    notes: ["Trailing commas are ignored"],
    modelVersion: "claude-3-5-haiku-20241022",
    promptVersion: "v1.0",
    sourceHash: "deadbeef",
    extractedAt: "2025-01-01T00:00:00.000Z",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("specFromIntent()", () => {
  it("maps behavior to a stable name slug using behavior prefix + hash suffix", () => {
    const card = makeIntentCard();
    const spec = specFromIntent(card, FAKE_HASH);

    // Name should incorporate first 30 chars of behavior (non-word → "-") and
    // last 6 chars of canonicalAstHash.
    const hashSuffix = FAKE_HASH.slice(-6); // "345678ab" → last 6: "678ab" — wait, 6 chars: "78ab" is 4. Let's check: last 6 of "...345678ab" = "678ab" is 5 chars; "345678ab" last 6 = "5678ab" is 6 chars.
    // FAKE_HASH ends in "345678ab" — last 6 chars: "5678ab" — no. Let's be explicit.
    const last6 = FAKE_HASH.slice(-6); // "678ab" — actually the string ends "...12345678ab", last 6 = "345678ab" no...
    // Let's just verify it ends with the correct suffix by recomputing.
    expect(spec.name).toMatch(/-[a-f0-9]{6}$/);
    expect(spec.name.endsWith(`-${last6}`)).toBe(true);
  });

  it("maps inputs and outputs correctly from IntentParam to SpecYakParameter", () => {
    const card = makeIntentCard({
      inputs: [
        { name: "xs", typeHint: "number[]", description: "Input numbers" },
        { name: "n", typeHint: "number", description: "Count" },
      ],
      outputs: [{ name: "sum", typeHint: "number", description: "Sum of first n numbers" }],
    });
    const spec = specFromIntent(card, FAKE_HASH);

    expect(spec.inputs).toHaveLength(2);
    expect(spec.inputs[0]).toEqual({ name: "xs", type: "number[]", description: "Input numbers" });
    expect(spec.inputs[1]).toEqual({ name: "n", type: "number", description: "Count" });
    expect(spec.outputs).toHaveLength(1);
    expect(spec.outputs[0]).toEqual({
      name: "sum",
      type: "number",
      description: "Sum of first n numbers",
    });
  });

  it("forwards preconditions and postconditions, sets invariants/effects to empty and level to L0", () => {
    const card = makeIntentCard({
      preconditions: ["input >= 0", "input < 1000"],
      postconditions: ["result >= 0"],
    });
    const spec = specFromIntent(card, FAKE_HASH);

    expect(spec.preconditions).toEqual(["input >= 0", "input < 1000"]);
    expect(spec.postconditions).toEqual(["result >= 0"]);
    expect(spec.invariants).toEqual([]);
    expect(spec.effects).toEqual([]);
    expect(spec.level).toBe("L0");
  });

  it("produces a deterministic spec for identical inputs (same hash for same content)", () => {
    const card = makeIntentCard();
    const spec1 = specFromIntent(card, FAKE_HASH);
    const spec2 = specFromIntent(card, FAKE_HASH);

    expect(spec1.name).toBe(spec2.name);
    expect(spec1.inputs).toEqual(spec2.inputs);
    expect(spec1.outputs).toEqual(spec2.outputs);
    expect(spec1.level).toBe(spec2.level);
  });

  it("passes validateSpecYak (does not throw for a valid IntentCard)", () => {
    const card = makeIntentCard();
    // Should not throw.
    expect(() => specFromIntent(card, FAKE_HASH)).not.toThrow();
  });
});
