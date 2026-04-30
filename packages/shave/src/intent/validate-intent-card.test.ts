/**
 * Tests for validateIntentCard() — the strict schema validator that rejects
 * unknown fields, invalid types, and out-of-range values.
 *
 * Production trigger: validateIntentCard is called (a) inside extractIntent
 * after every cache read and after every live API response to ensure only
 * schema-conformant cards are cached or returned, and (b) by external callers
 * that receive an IntentCard from an external source.
 *
 * Compound-interaction test: the "full-schema roundtrip" test builds a valid
 * card, validates it, and then stringifies + re-parses it to confirm the
 * validator accepts the exact shape it produces (as extractIntent would after
 * assembling envelope fields).
 */

import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { IntentCardSchemaError } from "../errors.js";
import type { IntentCard } from "./types.js";
import { validateIntentCard } from "./validate-intent-card.js";

// ---------------------------------------------------------------------------
// Valid fixture
// ---------------------------------------------------------------------------

function validCard(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    schemaVersion: 1,
    behavior: "Parses comma-separated integers from a string",
    inputs: [{ name: "s", typeHint: "string", description: "Input string" }],
    outputs: [{ name: "result", typeHint: "number[]", description: "Parsed result" }],
    preconditions: ["s is non-null"],
    postconditions: ["every element is a finite integer"],
    notes: ["Throws on invalid tokens"],
    modelVersion: "claude-haiku-4-5-20251001",
    promptVersion: "1",
    sourceHash: "a".repeat(64),
    extractedAt: "2025-01-01T00:00:00.000Z",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe("validateIntentCard() — valid input", () => {
  it("accepts a fully-specified valid card and returns it typed", () => {
    const raw = validCard();
    const result = validateIntentCard(raw);
    expect(result.schemaVersion).toBe(1);
    expect(result.behavior).toBe("Parses comma-separated integers from a string");
    expect(result.inputs).toHaveLength(1);
    expect(result.inputs[0].name).toBe("s");
  });

  it("accepts empty arrays for optional fields", () => {
    const raw = validCard({
      inputs: [],
      outputs: [],
      preconditions: [],
      postconditions: [],
      notes: [],
    });
    expect(() => validateIntentCard(raw)).not.toThrow();
  });

  it("round-trips through JSON serialization", () => {
    const card = validateIntentCard(validCard()) as IntentCard;
    const reparsed = JSON.parse(JSON.stringify(card)) as unknown;
    expect(() => validateIntentCard(reparsed)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Non-object inputs
// ---------------------------------------------------------------------------

describe("validateIntentCard() — non-object input", () => {
  it.each([null, undefined, "string", 42, [], true])("rejects %p as not a plain object", (v) => {
    expect(() => validateIntentCard(v)).toThrow(IntentCardSchemaError);
  });
});

// ---------------------------------------------------------------------------
// schemaVersion
// ---------------------------------------------------------------------------

describe("validateIntentCard() — schemaVersion", () => {
  it("rejects schemaVersion: 2 with 'schema version' in message", () => {
    expect(() => validateIntentCard(validCard({ schemaVersion: 2 }))).toThrow(/schemaVersion/);
  });

  it("rejects missing schemaVersion", () => {
    const { schemaVersion: _, ...rest } = validCard() as Record<string, unknown>;
    expect(() => validateIntentCard(rest)).toThrow(IntentCardSchemaError);
  });

  it("rejects schemaVersion: '1' (string)", () => {
    expect(() => validateIntentCard(validCard({ schemaVersion: "1" }))).toThrow(
      IntentCardSchemaError,
    );
  });
});

// ---------------------------------------------------------------------------
// behavior
// ---------------------------------------------------------------------------

describe("validateIntentCard() — behavior", () => {
  it("rejects empty behavior", () => {
    expect(() => validateIntentCard(validCard({ behavior: "" }))).toThrow(/behavior/);
  });

  it("rejects behavior longer than 200 characters", () => {
    expect(() => validateIntentCard(validCard({ behavior: "x".repeat(201) }))).toThrow(/behavior/);
  });

  it("accepts behavior of exactly 200 characters", () => {
    expect(() => validateIntentCard(validCard({ behavior: "x".repeat(200) }))).not.toThrow();
  });

  it("rejects behavior containing LF newline", () => {
    expect(() => validateIntentCard(validCard({ behavior: "line1\nline2" }))).toThrow(/behavior/);
  });

  it("rejects behavior containing CR", () => {
    expect(() => validateIntentCard(validCard({ behavior: "line1\rline2" }))).toThrow(/behavior/);
  });

  it("rejects missing behavior", () => {
    const { behavior: _, ...rest } = validCard() as Record<string, unknown>;
    expect(() => validateIntentCard(rest)).toThrow(IntentCardSchemaError);
  });
});

// ---------------------------------------------------------------------------
// sourceHash
// ---------------------------------------------------------------------------

describe("validateIntentCard() — sourceHash", () => {
  it("rejects sourceHash that is not 64 chars", () => {
    expect(() => validateIntentCard(validCard({ sourceHash: "a".repeat(63) }))).toThrow(
      /sourceHash/,
    );
  });

  it("rejects sourceHash with uppercase hex", () => {
    expect(() => validateIntentCard(validCard({ sourceHash: "A".repeat(64) }))).toThrow(
      /sourceHash/,
    );
  });

  it("rejects sourceHash with non-hex characters", () => {
    expect(() => validateIntentCard(validCard({ sourceHash: "z".repeat(64) }))).toThrow(
      /sourceHash/,
    );
  });

  it("accepts a valid 64-char lowercase hex sourceHash", () => {
    expect(() => validateIntentCard(validCard({ sourceHash: "f0".repeat(32) }))).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Unknown top-level fields
// ---------------------------------------------------------------------------

describe("validateIntentCard() — unknown top-level fields", () => {
  it("rejects an unknown top-level field and names it in the message", () => {
    const raw = { ...validCard(), extra: 1 };
    expect(() => validateIntentCard(raw)).toThrow(/extra/);
  });

  it("rejects another unknown top-level field 'foo'", () => {
    const raw = { ...validCard(), foo: "bar" };
    expect(() => validateIntentCard(raw)).toThrow(/foo/);
  });
});

// ---------------------------------------------------------------------------
// inputs / outputs
// ---------------------------------------------------------------------------

describe("validateIntentCard() — inputs array", () => {
  it("rejects inputs: 'not array'", () => {
    expect(() => validateIntentCard(validCard({ inputs: "not array" }))).toThrow(/inputs/);
  });

  it("rejects input item with unknown key", () => {
    const bad = [{ name: "x", typeHint: "string", description: "d", extra: 1 }];
    expect(() => validateIntentCard(validCard({ inputs: bad }))).toThrow(/extra/);
  });

  it("rejects input item missing typeHint and description", () => {
    const bad = [{ name: "x" }];
    expect(() => validateIntentCard(validCard({ inputs: bad }))).toThrow(IntentCardSchemaError);
  });

  it("rejects input item missing name", () => {
    const bad = [{ typeHint: "string", description: "d" }];
    expect(() => validateIntentCard(validCard({ inputs: bad }))).toThrow(IntentCardSchemaError);
  });

  it("rejects non-object array element", () => {
    expect(() => validateIntentCard(validCard({ inputs: ["string-element"] }))).toThrow(
      IntentCardSchemaError,
    );
  });
});

// ---------------------------------------------------------------------------
// Required fields — missing each one must be rejected
// ---------------------------------------------------------------------------

describe("validateIntentCard() — missing required fields", () => {
  const requiredFields = [
    "schemaVersion",
    "behavior",
    "inputs",
    "outputs",
    "preconditions",
    "postconditions",
    "notes",
    "modelVersion",
    "promptVersion",
    "sourceHash",
    "extractedAt",
  ];

  for (const field of requiredFields) {
    it(`rejects card missing "${field}"`, () => {
      const { [field]: _, ...rest } = validCard() as Record<string, unknown>;
      expect(() => validateIntentCard(rest)).toThrow(IntentCardSchemaError);
    });
  }
});

// ---------------------------------------------------------------------------
// extractedAt
// ---------------------------------------------------------------------------

describe("validateIntentCard() — extractedAt", () => {
  it("rejects empty extractedAt", () => {
    expect(() => validateIntentCard(validCard({ extractedAt: "" }))).toThrow(/extractedAt/);
  });

  it("rejects missing extractedAt", () => {
    const { extractedAt: _, ...rest } = validCard() as Record<string, unknown>;
    expect(() => validateIntentCard(rest)).toThrow(IntentCardSchemaError);
  });
});

// ---------------------------------------------------------------------------
// String arrays (preconditions / postconditions / notes)
// ---------------------------------------------------------------------------

describe("validateIntentCard() — string arrays", () => {
  it("rejects preconditions containing a non-string element", () => {
    expect(() => validateIntentCard(validCard({ preconditions: ["ok", 42] }))).toThrow(
      /preconditions/,
    );
  });

  it("rejects postconditions containing a non-string element", () => {
    expect(() => validateIntentCard(validCard({ postconditions: [null] }))).toThrow(
      /postconditions/,
    );
  });

  it("rejects notes containing a non-string element", () => {
    expect(() => validateIntentCard(validCard({ notes: [true] }))).toThrow(/notes/);
  });
});

// ---------------------------------------------------------------------------
// fast-check properties
// ---------------------------------------------------------------------------

describe("validateIntentCard() — fast-check properties", () => {
  it("rejects any extra top-level key (fast-check)", () => {
    fc.assert(
      fc.property(
        fc
          .string({ minLength: 1 })
          .filter(
            (k) =>
              ![
                "schemaVersion",
                "behavior",
                "inputs",
                "outputs",
                "preconditions",
                "postconditions",
                "notes",
                "modelVersion",
                "promptVersion",
                "sourceHash",
                "extractedAt",
              ].includes(k),
          ),
        (extraKey) => {
          const raw = { ...validCard(), [extraKey]: "value" };
          let threw = false;
          try {
            validateIntentCard(raw);
          } catch (e) {
            threw = e instanceof IntentCardSchemaError;
          }
          return threw;
        },
      ),
    );
  });

  it("rejects when any required field is stripped (fast-check)", () => {
    const requiredFields = [
      "schemaVersion",
      "behavior",
      "inputs",
      "outputs",
      "preconditions",
      "postconditions",
      "notes",
      "modelVersion",
      "promptVersion",
      "sourceHash",
      "extractedAt",
    ];

    fc.assert(
      fc.property(fc.constantFrom(...requiredFields), (field) => {
        const { [field]: _, ...rest } = validCard() as Record<string, unknown>;
        let threw = false;
        try {
          validateIntentCard(rest);
        } catch (e) {
          threw = e instanceof IntentCardSchemaError;
        }
        return threw;
      }),
    );
  });
});
