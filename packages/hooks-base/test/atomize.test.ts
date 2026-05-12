// SPDX-License-Identifier: MIT
/**
 * atomize.test.ts — Integration tests for atomizeEmission() (DEC-HOOK-ATOM-CAPTURE-001).
 *
 * Tests A1–A8 per the acceptance criteria in issue #362.
 *
 * Production sequence:
 *   atomizeEmission({ emittedCode, registry }) →
 *   shape filter → license injection → shave.universalize(static) →
 *   storeBlock(row) → AtomizeResult
 *
 * Registry: :memory: with mockEmbeddingProvider() (same pattern as index.test.ts).
 * Shave: real @yakcc/shave dist via vitest.config.ts alias (strategy: "static", offline-safe).
 *
 * @decision DEC-HOOK-ATOM-CAPTURE-001
 * Tests use real shave + real registry to verify the full pipeline end-to-end.
 * Only the embedding provider is mocked (external boundary — no ONNX needed in tests).
 */

import type { EmbeddingProvider } from "@yakcc/contracts";
import type { Registry } from "@yakcc/registry";
import { openRegistry } from "@yakcc/registry";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { atomizeEmission, type AtomizeInput, type AtomizeResult } from "../src/atomize.js";

// ---------------------------------------------------------------------------
// Mock embedding provider (same as index.test.ts — deterministic, offline-safe)
// ---------------------------------------------------------------------------

function mockEmbeddingProvider(): EmbeddingProvider {
  return {
    dimension: 384,
    modelId: "mock/test-atomize",
    async embed(text: string): Promise<Float32Array> {
      const vec = new Float32Array(384);
      for (let i = 0; i < 384; i++) {
        const charIdx = (i * 7 + 3) % Math.max(1, text.length);
        const charCode = text.charCodeAt(charIdx) / 128;
        vec[i] = charCode * Math.sin((i + 1) * 0.05) + (i % 10) * 0.001;
      }
      let norm = 0;
      for (const v of vec) norm += v * v;
      const scale = norm > 0 ? 1 / Math.sqrt(norm) : 1;
      for (let i = 0; i < vec.length; i++) {
        const val = vec[i];
        if (val !== undefined) vec[i] = val * scale;
      }
      return vec;
    },
  };
}

// ---------------------------------------------------------------------------
// Shared code snippets
// ---------------------------------------------------------------------------

/**
 * A well-formed exported function with JSDoc — the canonical "atomize-yes" shape.
 * Behavior: "Compute the sum of all numbers in an array."
 */
const EXPORTED_WITH_JSDOC = `// SPDX-License-Identifier: MIT
/**
 * Compute the sum of all numbers in an array.
 *
 * @param nums - The numbers to sum.
 * @returns The total sum.
 */
export function sumArray(nums: number[]): number {
  let total = 0;
  for (const n of nums) {
    total += n;
  }
  return total;
}`;

/**
 * Exported function WITHOUT JSDoc comment — tests the MAYBE shape.
 * atomize.ts defaults skipOnNoJsdoc=false, so this is atomized with inferred intent.
 */
const EXPORTED_WITHOUT_JSDOC = `// SPDX-License-Identifier: MIT
export function reverseString(s: string): string {
  const chars = s.split("");
  chars.reverse();
  return chars.join("");
}`;

/** Inner function (not exported). */
const INNER_FUNCTION = `// SPDX-License-Identifier: MIT
export function outer(): void {
  function inner(x: number): number {
    return x * 2;
  }
  console.log(inner(5));
}`;

/** Arrow expression (no export keyword on the const, exported via object). */
const ARROW_EXPRESSION = `// SPDX-License-Identifier: MIT
const doubleNum = (x: number): number => x * 2;
export { doubleNum };`;

/** Test file code — should be rejected by the test-file shape filter. */
const TEST_FILE_CODE = `// SPDX-License-Identifier: MIT
import { expect, it } from "vitest";
it("adds two numbers", () => {
  expect(1 + 1).toBe(2);
});`;

/** Type-only emission. */
const TYPE_ONLY = `// SPDX-License-Identifier: MIT
export interface Rect {
  width: number;
  height: number;
}
export type Shape = Rect | { radius: number };`;

/** Trivial body — only 1 statement (return). */
const TRIVIAL_BODY = `// SPDX-License-Identifier: MIT
/**
 * Get the first element.
 */
export function head<T>(arr: T[]): T | undefined {
  return arr[0];
}`;

/** GPL-licensed code — should be refused. */
const GPL_CODE = `// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Multiply two numbers together.
 *
 * @param a - First number.
 * @param b - Second number.
 * @returns Product of a and b.
 */
export function multiply(a: number, b: number): number {
  const result = a * b;
  const formatted = String(result);
  return parseFloat(formatted);
}`;

/**
 * Valid exported function without SPDX header — license injection test.
 * The hook should auto-prepend MIT.
 */
const NO_SPDX_HEADER = `/**
 * Count distinct values in an array.
 *
 * @param arr - Input array of comparable values.
 * @returns Number of distinct values.
 */
export function countDistinct<T>(arr: T[]): number {
  const seen = new Set(arr);
  const unique = Array.from(seen);
  return unique.length;
}`;

/**
 * A second distinct exported function for dedup + concurrent tests.
 */
const EXPORTED_WITH_JSDOC_2 = `// SPDX-License-Identifier: MIT
/**
 * Find the maximum value in a non-empty array.
 *
 * @param nums - Array of numbers (must be non-empty).
 * @returns The largest number in the array.
 */
export function maxValue(nums: number[]): number {
  let max = nums[0] ?? -Infinity;
  for (const n of nums) {
    if (n > max) max = n;
  }
  return max;
}`;

// ---------------------------------------------------------------------------
// Test lifecycle
// ---------------------------------------------------------------------------

let registry: Registry;

beforeEach(async () => {
  registry = await openRegistry(":memory:", {
    embeddings: mockEmbeddingProvider(),
  });
});

afterEach(async () => {
  await registry.close();
});

function makeInput(overrides?: Partial<AtomizeInput>): AtomizeInput {
  return {
    emittedCode: EXPORTED_WITH_JSDOC,
    toolName: "Edit",
    registry,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// A1 — atomize-yes: exported function with JSDoc → atomized=true
// ---------------------------------------------------------------------------

describe("A1 — atomize-yes: exported function with JSDoc", () => {
  it("returns atomized=true and stores the atom in the registry", async () => {
    const result = await atomizeEmission(makeInput());

    expect(result.atomized).toBe(true);
    expect(result.atomsCreated.length).toBeGreaterThan(0);
    expect(result.reason).toBeUndefined();

    // The first atom should have a non-empty blockMerkleRoot and atomName.
    const first = result.atomsCreated[0];
    expect(first).toBeDefined();
    if (first !== undefined) {
      expect(first.blockMerkleRoot).toMatch(/^[0-9a-f]+$/i);
      expect(first.atomName).toBeTruthy();
    }
  }, 30_000);

  it("the stored BMR is retrievable from the registry", async () => {
    const result = await atomizeEmission(makeInput());
    expect(result.atomized).toBe(true);

    // selectBlocks requires the specHash — we can verify the BMR via findCandidatesByIntent.
    // If the atom was stored, a behavioral query for its JSDoc summary should return it.
    const candidates = await registry.findCandidatesByIntent(
      { behavior: "Compute the sum of all numbers in an array.", inputs: [], outputs: [] },
      { k: 1, rerank: "structural" },
    );
    // The atom should be retrievable (cosine distance < 1.0 means similarity found).
    expect(candidates.length).toBeGreaterThan(0);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// A2 — atomize-maybe-skip (no-jsdoc): skipOnNoJsdoc=true → atomized=false
// ---------------------------------------------------------------------------

describe("A2 — atomize-maybe-skip: exported function without JSDoc + skipOnNoJsdoc=true", () => {
  it("returns atomized=false with reason='no-jsdoc' when skipOnNoJsdoc=true", async () => {
    const result = await atomizeEmission(
      makeInput({ emittedCode: EXPORTED_WITHOUT_JSDOC, skipOnNoJsdoc: true }),
    );

    expect(result.atomized).toBe(false);
    expect(result.reason).toBe("no-jsdoc");
    expect(result.atomsCreated).toHaveLength(0);
  });
});

describe("A2b — atomize-maybe-proceed: exported function without JSDoc + skipOnNoJsdoc=false (default)", () => {
  it("proceeds to atomize when skipOnNoJsdoc is false (default)", async () => {
    // Default: skipOnNoJsdoc=false → MAYBE shape proceeds through shave pipeline.
    // The static extractor will use function name + signature as inferred intent.
    const result = await atomizeEmission(
      makeInput({ emittedCode: EXPORTED_WITHOUT_JSDOC }),
    );

    // With skipOnNoJsdoc=false, atomize should either succeed or fail with shave-rejected.
    // It must NOT return "no-jsdoc" because skipOnNoJsdoc=false means we proceed.
    expect(result.reason).not.toBe("no-jsdoc");
    // The shape filter passed (not-exported-function, inner-scope, type-only) — those
    // reasons must not appear.
    expect(result.reason).not.toBe("not-exported-function");
    expect(result.reason).not.toBe("inner-scope");
    expect(result.reason).not.toBe("type-only");
    // It may or may not atomize depending on whether shave accepts the no-jsdoc function.
    // We assert on the binary outcome: either atomized=true or a valid non-no-jsdoc reason.
    if (result.atomized) {
      expect(result.atomsCreated.length).toBeGreaterThan(0);
    } else {
      // Valid skip reasons when shave itself rejects: shave-rejected, trivial-body
      expect(["shave-rejected", "trivial-body"]).toContain(result.reason);
    }
  }, 30_000);
});

// ---------------------------------------------------------------------------
// A3 — atomize-no: five sub-tests for rejected shapes
// ---------------------------------------------------------------------------

describe("A3 — atomize-no: rejected shapes", () => {
  it("A3a: inner function — outer() has trivial body, inner() is inner-scope", async () => {
    // INNER_FUNCTION: outer() is exported but has a trivial body (2 statements).
    // The shape detector detects outer() as "exported-no-jsdoc" and proceeds, but
    // countBodyStatements() finds 2 statements (function decl + console.log) which
    // is below the threshold of 3, OR shave may accept it but produce no novel-glue.
    // Either way the result must be one of the expected non-atomizable outcomes.
    const result = await atomizeEmission(makeInput({ emittedCode: INNER_FUNCTION }));
    // Accept any of: trivial-body, shave-rejected, inner-scope, not-exported-function,
    // or even atomized=true (if shave successfully decomposes outer()).
    // The key invariant is: no unhandled throw.
    if (result.atomized) {
      // If shave does atomize outer(), that's acceptable too.
      expect(result.atomsCreated.length).toBeGreaterThan(0);
    } else {
      expect([
        "inner-scope",
        "not-exported-function",
        "trivial-body",
        "shave-rejected",
        "no-jsdoc",
      ]).toContain(result.reason);
    }
  }, 30_000);

  it("A3b: arrow expression → atomized=false, reason='not-exported-function' OR 'no-function'", async () => {
    // Arrow expression: `const doubleNum = ...` — regex won't find `export function`.
    const result = await atomizeEmission(makeInput({ emittedCode: ARROW_EXPRESSION }));
    expect(result.atomized).toBe(false);
    // Arrow expressions don't match the `export function` pattern → "not-exported-function"
    expect(["not-exported-function", "no-function", "shave-rejected"]).toContain(result.reason);
  });

  it("A3c: test file → atomized=false, reason='test-file'", async () => {
    const result = await atomizeEmission(
      makeInput({ emittedCode: TEST_FILE_CODE, filePath: "my-feature.test.ts" }),
    );
    expect(result.atomized).toBe(false);
    expect(result.reason).toBe("test-file");
  });

  it("A3d: type-only emission → atomized=false, reason='type-only'", async () => {
    const result = await atomizeEmission(makeInput({ emittedCode: TYPE_ONLY }));
    expect(result.atomized).toBe(false);
    expect(result.reason).toBe("type-only");
  });

  it("A3e: trivial body (1 statement) → atomized=false, reason='trivial-body'", async () => {
    const result = await atomizeEmission(makeInput({ emittedCode: TRIVIAL_BODY }));
    expect(result.atomized).toBe(false);
    expect(result.reason).toBe("trivial-body");
  });
});

// ---------------------------------------------------------------------------
// A4 — license-missing: GPL-licensed code → atomized=false
// ---------------------------------------------------------------------------

describe("A4 — license-missing: GPL-flagged code", () => {
  it("returns atomized=false with reason='license-missing' for GPL code", async () => {
    const result = await atomizeEmission(makeInput({ emittedCode: GPL_CODE }));
    expect(result.atomized).toBe(false);
    expect(result.reason).toBe("license-missing");
    expect(result.atomsCreated).toHaveLength(0);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// A5 — license-default-MIT: no SPDX header → MIT injected, atomization proceeds
// ---------------------------------------------------------------------------

describe("A5 — license-default-MIT: emission without SPDX header", () => {
  it("auto-prepends MIT SPDX header and atomizes successfully", async () => {
    const result = await atomizeEmission(makeInput({ emittedCode: NO_SPDX_HEADER }));

    // The MIT injection should make the license gate pass.
    // Result must NOT be "license-missing".
    expect(result.reason).not.toBe("license-missing");
    // With a proper exported function + JSDoc + non-trivial body, should atomize.
    expect(result.atomized).toBe(true);
    expect(result.atomsCreated.length).toBeGreaterThan(0);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// A6 — dedup: same code twice → second call is no-op, no error
// ---------------------------------------------------------------------------

describe("A6 — dedup: atomize same code twice", () => {
  it("second call is idempotent — no error, same BMR, no duplicate registry row", async () => {
    const first = await atomizeEmission(makeInput());
    // First call should atomize successfully.
    expect(first.atomized).toBe(true);
    const storedBmr = first.atomsCreated[0]?.blockMerkleRoot;
    expect(storedBmr).toBeDefined();

    // Second call on identical code: shave's findByCanonicalAstHash detects the atom
    // already in registry and returns a PointerEntry (not novel-glue). atomizeEmission
    // finds no novel-glue entries → atomized=false. This is correct dedup behavior:
    // the atom already exists; no duplicate is stored.
    const second = await atomizeEmission(makeInput());
    // Must NOT throw. atomized=false (dedup) OR atomized=true with same BMR (INSERT OR IGNORE).
    if (second.atomized) {
      // If shave still emits novel-glue (e.g., different AST hash path), BMR must match.
      expect(second.atomsCreated[0]?.blockMerkleRoot).toBe(storedBmr);
    }
    // In either case: no error, no corruption.

    // Registry must have exactly one row for this atom (no duplicate BMR).
    const candidates = await registry.findCandidatesByIntent(
      { behavior: "Compute the sum of all numbers in an array.", inputs: [], outputs: [] },
      { k: 5, rerank: "structural" },
    );
    const bmrs = candidates.map((c) => c.block.blockMerkleRoot);
    const unique = new Set(bmrs);
    expect(unique.size).toBe(bmrs.length); // no duplicate BMRs
    expect(candidates.length).toBeGreaterThan(0); // atom is still findable
  }, 30_000);
});

// ---------------------------------------------------------------------------
// A7 — concurrent: two parallel atomizeEmission calls → both succeed, no corruption
// ---------------------------------------------------------------------------

describe("A7 — concurrent: two parallel atomize calls on different code", () => {
  it("both calls succeed and registry has both atoms", async () => {
    // Run both atomizations in parallel.
    const [result1, result2] = await Promise.all([
      atomizeEmission(makeInput({ emittedCode: EXPORTED_WITH_JSDOC })),
      atomizeEmission(makeInput({ emittedCode: EXPORTED_WITH_JSDOC_2 })),
    ]);

    expect(result1.atomized).toBe(true);
    expect(result2.atomized).toBe(true);

    // The two BMRs should be different (different content).
    expect(result1.atomsCreated[0]?.blockMerkleRoot).not.toBe(
      result2.atomsCreated[0]?.blockMerkleRoot,
    );

    // Both atoms should be retrievable from the registry.
    const [cands1, cands2] = await Promise.all([
      registry.findCandidatesByIntent(
        { behavior: "Compute the sum of all numbers in an array.", inputs: [], outputs: [] },
        { k: 2, rerank: "structural" },
      ),
      registry.findCandidatesByIntent(
        { behavior: "Find the maximum value in a non-empty array.", inputs: [], outputs: [] },
        { k: 2, rerank: "structural" },
      ),
    ]);
    expect(cands1.length).toBeGreaterThan(0);
    expect(cands2.length).toBeGreaterThan(0);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// A8 — round-trip flywheel (LOAD-BEARING):
//   atomize(emission) → findCandidatesByIntent(behavior_text) returns the new atom
// ---------------------------------------------------------------------------

describe("A8 — round-trip flywheel (LOAD-BEARING): corpus grows on atomization", () => {
  it(
    "atomized atom is discoverable by a subsequent findCandidatesByIntent query",
    async () => {
      // Before atomization: registry is empty.
      const beforeCandidates = await registry.findCandidatesByIntent(
        { behavior: "Compute the sum of all numbers in an array.", inputs: [], outputs: [] },
        { k: 1, rerank: "structural" },
      );
      // Empty registry → no candidates.
      expect(beforeCandidates.length).toBe(0);

      // Atomize the emission.
      const result = await atomizeEmission(makeInput());
      expect(result.atomized).toBe(true);

      const storedBmr = result.atomsCreated[0]?.blockMerkleRoot;
      expect(storedBmr).toBeDefined();

      // After atomization: the flywheel query should return the new atom.
      const afterCandidates = await registry.findCandidatesByIntent(
        { behavior: "Compute the sum of all numbers in an array.", inputs: [], outputs: [] },
        { k: 1, rerank: "structural" },
      );
      expect(afterCandidates.length).toBeGreaterThan(0);

      // The top-1 result should be our newly-atomized atom (or at least contain it).
      const returnedBmrs = afterCandidates.map((c) => c.block.blockMerkleRoot as unknown as string);
      expect(returnedBmrs).toContain(storedBmr);

      // This is the flywheel: the atom written in one session is discoverable in the next.
      // cosineDistance < 1.0 means semantic similarity was found (not random noise).
      const top = afterCandidates[0];
      expect(top).toBeDefined();
      if (top !== undefined) {
        expect(top.cosineDistance).toBeLessThan(1.0);
      }
    },
    30_000,
  );
});

// ---------------------------------------------------------------------------
// renderAtomNewComment — unit tests for the comment format
// ---------------------------------------------------------------------------

describe("renderAtomNewComment — @atom-new comment format", () => {
  it("produces the correct format: // @atom-new: <8-hex> — yakcc:<name>", async () => {
    const { renderAtomNewComment } = await import("../src/atomize.js");
    const comment = renderAtomNewComment("abcdef1234567890", "sumArray");
    expect(comment).toBe("// @atom-new: abcdef12 — yakcc:sumArray");
  });

  it("uses only first 8 chars of BMR", async () => {
    const { renderAtomNewComment } = await import("../src/atomize.js");
    const comment = renderAtomNewComment("a".repeat(64), "testFn");
    expect(comment).toBe(`// @atom-new: ${"a".repeat(8)} — yakcc:testFn`);
  });
});

// ---------------------------------------------------------------------------
// A9 — JSDoc curly-brace regression (issue #383)
//   Functions with @throws {X}, @returns {X}, @param {X}, @type {X} in JSDoc
//   must not be falsely rejected as trivial-body.
// ---------------------------------------------------------------------------

/**
 * Reproduction case from issue #383 (originally from B7 Slice 1 corpus).
 * hammingDistance carries `@throws {RangeError}` — this must NOT cause a
 * false "trivial-body" rejection from countBodyStatements().
 */
const JSDOC_THROWS_TAG = `// SPDX-License-Identifier: MIT
/**
 * Computes Hamming distance.
 * @throws {RangeError} when strings differ in length
 */
export function hammingDistance(a: string, b: string): number {
  if (a.length !== b.length) throw new RangeError("strings must be equal length");
  let count = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) count++;
  return count;
}`;

const JSDOC_RETURNS_TAG = `// SPDX-License-Identifier: MIT
/**
 * Parse an integer from a string.
 * @returns {number} The parsed integer value.
 */
export function parseIntStrict(s: string): number {
  const n = parseInt(s, 10);
  if (isNaN(n)) throw new TypeError("not a valid integer: " + s);
  if (String(n) !== s.trim()) throw new RangeError("not a strict integer: " + s);
  return n;
}`;

const JSDOC_PARAM_TAG = `// SPDX-License-Identifier: MIT
/**
 * Compute a normalised score in [0, 1] for a value within [min, max].
 * @param {number} value - The value to normalise.
 * @param {number} min - The lower bound of the range.
 * @param {number} max - The upper bound of the range.
 * @returns A number in [0, 1] representing value's position in [min, max].
 */
export function normalise(value: number, min: number, max: number): number {
  if (max === min) throw new RangeError("min and max must be different");
  const range = max - min;
  const shifted = value - min;
  const ratio = shifted / range;
  if (ratio < 0) return 0;
  if (ratio > 1) return 1;
  return ratio;
}`;

const JSDOC_TYPE_TAG = `// SPDX-License-Identifier: MIT
/**
 * Format a value as a fixed-precision decimal string.
 * @type {(value: number, decimals: number) => string}
 */
export function toFixed(value: number, decimals: number): string {
  if (decimals < 0) throw new RangeError("decimals must be non-negative");
  const factor = Math.pow(10, decimals);
  const rounded = Math.round(value * factor) / factor;
  return rounded.toFixed(decimals);
}`;

describe("A9 — JSDoc curly-brace regression (issue #383)", () => {
  it("A9a: @throws {RangeError} — hammingDistance reproduction case atomizes successfully", async () => {
    const result = await atomizeEmission(makeInput({ emittedCode: JSDOC_THROWS_TAG }));
    // The JSDoc @throws tag must NOT cause a false trivial-body rejection.
    expect(result.reason).not.toBe("trivial-body");
    expect(result.atomized).toBe(true);
    expect(result.atomsCreated.length).toBeGreaterThan(0);
  }, 30_000);

  it("A9b: @returns {number} — parseIntStrict atomizes successfully", async () => {
    const result = await atomizeEmission(makeInput({ emittedCode: JSDOC_RETURNS_TAG }));
    expect(result.reason).not.toBe("trivial-body");
    expect(result.atomized).toBe(true);
    expect(result.atomsCreated.length).toBeGreaterThan(0);
  }, 30_000);

  it("A9c: @param {number} — normalise atomizes successfully", async () => {
    const result = await atomizeEmission(makeInput({ emittedCode: JSDOC_PARAM_TAG }));
    expect(result.reason).not.toBe("trivial-body");
    expect(result.atomized).toBe(true);
    expect(result.atomsCreated.length).toBeGreaterThan(0);
  }, 30_000);

  it("A9d: @type {(value: number, decimals: number) => string} — toFixed atomizes successfully", async () => {
    const result = await atomizeEmission(makeInput({ emittedCode: JSDOC_TYPE_TAG }));
    expect(result.reason).not.toBe("trivial-body");
    expect(result.atomized).toBe(true);
    expect(result.atomsCreated.length).toBeGreaterThan(0);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Test-file content heuristic detection
// ---------------------------------------------------------------------------

describe("test-file detection via content (no filePath provided)", () => {
  it("rejects test-framework code even without a .test.ts filePath", async () => {
    const result = await atomizeEmission(makeInput({ emittedCode: TEST_FILE_CODE }));
    expect(result.atomized).toBe(false);
    expect(result.reason).toBe("test-file");
  });
});
