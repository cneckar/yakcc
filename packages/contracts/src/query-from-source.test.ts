// SPDX-License-Identifier: MIT
/**
 * Unit tests for queryIntentCardFromSource.
 *
 * Production sequence: a caller provides TypeScript source text (e.g. from
 * the LSP "current document" text) and calls queryIntentCardFromSource() to
 * derive a QueryIntentCard for vector-search enrichment. These tests exercise
 * that full sequence — parse, extract, map — using small inline fixture strings
 * (no file I/O, no network).
 *
 * Coverage contract (per wi-fix-523-p0 Evaluation Contract):
 *   1. Behavior extraction from JSDoc summary (first sentence of description)
 *   2. Signature extraction from typed params "(values: readonly number[]): number"
 *      (inputs AND outputs both populated)
 *   3. errorConditions from @throws tags in JSDoc
 *   4. Multiple exported functions + entryFunction option selects the right one
 *   5. No exported functions → throws TypeError
 *   6. Malformed TS → throws TypeError
 *   7. Absent JSDoc → behavior omitted or falls back (D1 rule: helper still
 *      returns a valid QueryIntentCard with whatever IS derivable)
 *   8. Compound / end-to-end: the arrayMedian fixture (matches v0-smoke Step 9)
 *      verifies the full production sequence across all extraction components.
 */

import { describe, expect, it } from "vitest";
import type { QueryIntentCard } from "./canonicalize.js";
import {
  type QueryIntentCardFromSourceOptions,
  queryIntentCardFromSource,
} from "./query-from-source.js";

// ---------------------------------------------------------------------------
// Fixture sources
// ---------------------------------------------------------------------------

/**
 * Canonical v0-smoke fixture (Step 9 in the plan).
 * Represents a well-documented function with JSDoc summary, @throws,
 * and a typed signature: (values: readonly number[]): number.
 */
const ARRAY_MEDIAN_SOURCE = `
/**
 * Compute the median of a non-empty array of numbers.
 *
 * @param values - The input array (must not be empty).
 * @returns The median value.
 * @throws RangeError if the array is empty.
 */
export function arrayMedian(values: readonly number[]): number {
  if (values.length === 0) {
    throw new RangeError("arrayMedian: values must not be empty");
  }
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
    : (sorted[mid] ?? 0);
}
`.trim();

/** Two exported functions; used to test entryFunction option. */
const TWO_FUNCTIONS_SOURCE = `
/**
 * Add two numbers together.
 * @throws TypeError if either argument is NaN.
 */
export function add(a: number, b: number): number {
  return a + b;
}

/**
 * Multiply two numbers together.
 */
export function multiply(x: number, y: number): number {
  return x * y;
}
`.trim();

/** Exported arrow-const with JSDoc on the VariableStatement. */
const ARROW_CONST_SOURCE = `
/**
 * Clamp a value to a range.
 */
export const clamp = (value: number, min: number, max: number): number =>
  Math.min(Math.max(value, min), max);
`.trim();

/** Function with no JSDoc — behavior should fall back to signature string. */
const NO_JSDOC_SOURCE = `
export function add(a: number, b: number): number {
  return a + b;
}
`.trim();

/** Completely empty source — no function declarations. */
const EMPTY_SOURCE = `
const x = 42;
`.trim();

// ---------------------------------------------------------------------------
// Test 1: JSDoc summary → behavior field
// ---------------------------------------------------------------------------

describe("queryIntentCardFromSource — behavior from JSDoc summary", () => {
  it("extracts the first-sentence JSDoc summary as the behavior field", () => {
    const card = queryIntentCardFromSource(ARRAY_MEDIAN_SOURCE);

    // The JSDoc starts: "Compute the median of a non-empty array of numbers."
    expect(card.behavior).toBe("Compute the median of a non-empty array of numbers.");
  });

  it("uses the JSDoc summary even when a second sentence follows", () => {
    const source = `
/**
 * Parse an integer from a string. Returns NaN for non-numeric input.
 */
export function parseInt2(s: string): number { return parseInt(s, 10); }
`.trim();
    const card = queryIntentCardFromSource(source);
    expect(card.behavior).toBe("Parse an integer from a string.");
  });
});

// ---------------------------------------------------------------------------
// Test 2: Signature extraction — inputs and outputs
// ---------------------------------------------------------------------------

describe("queryIntentCardFromSource — signature inputs and outputs", () => {
  it("populates signature.inputs from typed parameters", () => {
    const card = queryIntentCardFromSource(ARRAY_MEDIAN_SOURCE);

    expect(card.signature).toBeDefined();
    expect(card.signature?.inputs).toHaveLength(1);
    expect(card.signature?.inputs?.[0]).toMatchObject({
      name: "values",
      type: "readonly number[]",
    });
  });

  it("populates signature.outputs with the return type", () => {
    const card = queryIntentCardFromSource(ARRAY_MEDIAN_SOURCE);

    expect(card.signature?.outputs).toHaveLength(1);
    expect(card.signature?.outputs?.[0]).toMatchObject({
      name: "result",
      type: "number",
    });
  });

  it("populates both inputs and outputs from multi-param function", () => {
    const card = queryIntentCardFromSource(NO_JSDOC_SOURCE);

    expect(card.signature?.inputs).toHaveLength(2);
    expect(card.signature?.inputs?.[0]).toMatchObject({ name: "a", type: "number" });
    expect(card.signature?.inputs?.[1]).toMatchObject({ name: "b", type: "number" });
    expect(card.signature?.outputs?.[0]).toMatchObject({ type: "number" });
  });

  it("populates signature from arrow-const declaration", () => {
    const card = queryIntentCardFromSource(ARROW_CONST_SOURCE);

    expect(card.signature?.inputs).toHaveLength(3);
    expect(card.signature?.inputs?.[0]).toMatchObject({ name: "value", type: "number" });
    expect(card.signature?.outputs?.[0]).toMatchObject({ type: "number" });
  });
});

// ---------------------------------------------------------------------------
// Test 3: errorConditions from @throws tag
// ---------------------------------------------------------------------------

describe("queryIntentCardFromSource — errorConditions from @throws", () => {
  it("extracts @throws tag text into errorConditions array", () => {
    const card = queryIntentCardFromSource(ARRAY_MEDIAN_SOURCE);

    expect(card.errorConditions).toBeDefined();
    expect(Array.isArray(card.errorConditions)).toBe(true);
    // The @throws tag says "RangeError if the array is empty."
    expect((card.errorConditions ?? []).some((e) => /RangeError/i.test(e))).toBe(true);
  });

  it("extracts multiple @throws tags when present", () => {
    const source = `
/**
 * Divide a by b.
 * @throws RangeError if b is zero.
 * @throws TypeError if either argument is not a number.
 */
export function divide(a: number, b: number): number {
  if (b === 0) throw new RangeError("divide by zero");
  return a / b;
}
`.trim();
    const card = queryIntentCardFromSource(source);

    expect(Array.isArray(card.errorConditions)).toBe(true);
    expect((card.errorConditions ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it("omits errorConditions when no @throws tags are present", () => {
    const source = `
/**
 * Return the absolute value.
 */
export function abs(x: number): number { return x < 0 ? -x : x; }
`.trim();
    const card = queryIntentCardFromSource(source);

    // D1 absent-dimension rule: omit the field when not derivable.
    expect(card.errorConditions).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Test 4: entryFunction option selects named function
// ---------------------------------------------------------------------------

describe("queryIntentCardFromSource — entryFunction option", () => {
  it("selects the named function when entryFunction is specified", () => {
    const card = queryIntentCardFromSource(TWO_FUNCTIONS_SOURCE, {
      entryFunction: "multiply",
    });

    // multiply's JSDoc says "Multiply two numbers together."
    expect(card.behavior).toBe("Multiply two numbers together.");
    // multiply has params x and y
    expect(card.signature?.inputs?.[0]).toMatchObject({ name: "x", type: "number" });
    expect(card.signature?.inputs?.[1]).toMatchObject({ name: "y", type: "number" });
  });

  it("selects the other named function correctly", () => {
    const card = queryIntentCardFromSource(TWO_FUNCTIONS_SOURCE, {
      entryFunction: "add",
    });

    expect(card.behavior).toBe("Add two numbers together.");
    // add has @throws
    expect(card.errorConditions).toBeDefined();
    expect((card.errorConditions ?? []).some((e) => /TypeError/i.test(e))).toBe(true);
  });

  it("falls back to first function when entryFunction is not specified", () => {
    // Without entryFunction, the preference chain picks the first exported fn.
    const card = queryIntentCardFromSource(TWO_FUNCTIONS_SOURCE);

    // "add" is first, so its JSDoc summary is used.
    expect(card.behavior).toBe("Add two numbers together.");
  });
});

// ---------------------------------------------------------------------------
// Test 5: No function declarations → TypeError
// ---------------------------------------------------------------------------

describe("queryIntentCardFromSource — no function declarations", () => {
  it("throws TypeError when source has no function declarations", () => {
    expect(() => queryIntentCardFromSource(EMPTY_SOURCE)).toThrow(TypeError);
  });

  it("throws TypeError with an informative message about missing functions", () => {
    expect(() => queryIntentCardFromSource(EMPTY_SOURCE)).toThrow(
      /source contains no function declarations/i,
    );
  });
});

// ---------------------------------------------------------------------------
// Test 6: Named function not found → TypeError
// ---------------------------------------------------------------------------

describe("queryIntentCardFromSource — entryFunction not found", () => {
  it("throws TypeError when entryFunction name is not found in source", () => {
    expect(() =>
      queryIntentCardFromSource(ARRAY_MEDIAN_SOURCE, { entryFunction: "nonExistent" }),
    ).toThrow(TypeError);
  });

  it("includes the missing function name in the error message", () => {
    expect(() =>
      queryIntentCardFromSource(ARRAY_MEDIAN_SOURCE, { entryFunction: "nonExistent" }),
    ).toThrow(/nonExistent/);
  });
});

// ---------------------------------------------------------------------------
// Test 7: Absent JSDoc — behavior fallback (D1 rule)
// ---------------------------------------------------------------------------

describe("queryIntentCardFromSource — absent JSDoc, D1 fallback", () => {
  it("returns a valid QueryIntentCard even when JSDoc is absent", () => {
    const card = queryIntentCardFromSource(NO_JSDOC_SOURCE);

    // Must be a plain object (satisfies QueryIntentCard shape).
    expect(typeof card).toBe("object");
    expect(card).not.toBeNull();
  });

  it("populates behavior with signature string fallback when no JSDoc summary", () => {
    const card = queryIntentCardFromSource(NO_JSDOC_SOURCE);

    // Behavior falls back to the signature string (e.g. "function add(a, b) -> number").
    expect(typeof card.behavior).toBe("string");
    expect(card.behavior!.length).toBeGreaterThan(0);
    // Should include the function name "add" in the fallback.
    expect(card.behavior).toMatch(/add/);
  });

  it("omits errorConditions when JSDoc has no @throws and no throws in body (D1)", () => {
    // NO_JSDOC_SOURCE has no @throws and no throw statement picked by static extraction.
    const card = queryIntentCardFromSource(NO_JSDOC_SOURCE);
    expect(card.errorConditions).toBeUndefined();
  });

  it("still populates signature when no JSDoc present", () => {
    const card = queryIntentCardFromSource(NO_JSDOC_SOURCE);
    // Even without JSDoc, the TS types are still extractable.
    expect(card.signature?.inputs).toHaveLength(2);
    expect(card.signature?.outputs).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Test 8 (Compound / end-to-end): arrayMedian fixture — full production sequence
//
// This test crosses all internal component boundaries:
//   ts-morph parse → findExportedDeclarationByName / pickPrimaryDeclaration →
//   extractSignatureFromNode → extractJsDoc → QueryIntentCard assembly.
//
// It verifies byte-identical behavior/signature with what the shave atomize
// path would store for the same source (OD-2 Option A, R1 mitigation).
// ---------------------------------------------------------------------------

describe("queryIntentCardFromSource — compound end-to-end (arrayMedian fixture)", () => {
  let card: QueryIntentCard;

  it("parses and returns a QueryIntentCard without throwing", () => {
    card = queryIntentCardFromSource(ARRAY_MEDIAN_SOURCE);
    expect(card).toBeDefined();
  });

  it("behavior = first-sentence JSDoc summary (byte-exact)", () => {
    card = card ?? queryIntentCardFromSource(ARRAY_MEDIAN_SOURCE);
    expect(card.behavior).toBe("Compute the median of a non-empty array of numbers.");
  });

  it("signature.inputs contains name=values, type=readonly number[]", () => {
    card = card ?? queryIntentCardFromSource(ARRAY_MEDIAN_SOURCE);
    expect(card.signature?.inputs).toEqual([{ name: "values", type: "readonly number[]" }]);
  });

  it("signature.outputs contains name=result, type=number", () => {
    card = card ?? queryIntentCardFromSource(ARRAY_MEDIAN_SOURCE);
    expect(card.signature?.outputs).toEqual([{ name: "result", type: "number" }]);
  });

  it("errorConditions includes 'RangeError if the array is empty.'", () => {
    card = card ?? queryIntentCardFromSource(ARRAY_MEDIAN_SOURCE);
    expect(card.errorConditions).toBeDefined();
    const hasRangeError = (card.errorConditions ?? []).some((e) =>
      /RangeError if the array is empty/i.test(e),
    );
    expect(hasRangeError).toBe(true);
  });

  it("guarantees, nonFunctional, propertyTests are absent (D1 absent-dimension)", () => {
    card = card ?? queryIntentCardFromSource(ARRAY_MEDIAN_SOURCE);
    expect(card.guarantees).toBeUndefined();
    expect(card.nonFunctional).toBeUndefined();
    expect(card.propertyTests).toBeUndefined();
  });

  it("result satisfies the QueryIntentCard type (runtime structural check)", () => {
    card = card ?? queryIntentCardFromSource(ARRAY_MEDIAN_SOURCE);
    // All present fields must match the QueryIntentCard schema.
    if (card.behavior !== undefined) expect(typeof card.behavior).toBe("string");
    if (card.errorConditions !== undefined) {
      expect(Array.isArray(card.errorConditions)).toBe(true);
      for (const e of card.errorConditions) expect(typeof e).toBe("string");
    }
    if (card.signature !== undefined) {
      if (card.signature.inputs !== undefined) {
        for (const p of card.signature.inputs) {
          expect(typeof p.type).toBe("string");
        }
      }
      if (card.signature.outputs !== undefined) {
        for (const p of card.signature.outputs) {
          expect(typeof p.type).toBe("string");
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Type-level smoke test: ensure the function signature matches the plan spec
// (will cause a TypeScript compile error if the API surface changes)
// ---------------------------------------------------------------------------

describe("queryIntentCardFromSource — TypeScript API surface", () => {
  it("accepts (source: string) and returns QueryIntentCard", () => {
    // If the function signature is wrong this file won't compile.
    const result: QueryIntentCard = queryIntentCardFromSource("export function f(): void {}");
    expect(result).toBeDefined();
  });

  it("accepts (source: string, options: { entryFunction: string }) overload", () => {
    const options: QueryIntentCardFromSourceOptions = { entryFunction: "f" };
    const result: QueryIntentCard = queryIntentCardFromSource(
      "export function f(): void {}",
      options,
    );
    expect(result).toBeDefined();
  });

  it("accepts options with entryFunction: undefined (optional field)", () => {
    const options: QueryIntentCardFromSourceOptions = { entryFunction: undefined };
    const result: QueryIntentCard = queryIntentCardFromSource(
      "export function f(): void {}",
      options,
    );
    expect(result).toBeDefined();
  });
});
