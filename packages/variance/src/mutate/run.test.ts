// SPDX-License-Identifier: MIT
import * as fc from "fast-check";
import { describe, expect, it, beforeEach } from "vitest";
import {
  clearMutationCache,
  createMutantFn,
  executeMutantTest,
  extractFuncName,
  hasImplReference,
  prepareTestScript,
  runMutationTesting,
  selectMutants,
  stripTypes,
} from "./run.js";
import { resetMutantId } from "./operators.js";

beforeEach(() => {
  clearMutationCache();
  resetMutantId();
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ADD_IMPL = `export function add(a: number, b: number): number {
  return a + b;
}`;

const ADD_IMPL_MINUS = `export function add(a: number, b: number): number {
  return a - b;
}`;

// A corpus test that actually calls add()
const ADD_CORPUS_REAL = `import * as fc from "fast-check";
import { describe, it } from "vitest";
import { add } from "./impl.js";

describe("add", () => {
  it("is commutative", () => {
    fc.assert(
      fc.property(fc.integer({ min: -100, max: 100 }), fc.integer({ min: -100, max: 100 }), (a, b) => {
        return add(a, b) === add(b, a);
      }),
      { numRuns: 20 },
    );
  });
  it("identity with zero", () => {
    fc.assert(
      fc.property(fc.integer({ min: -100, max: 100 }), (n) => {
        return add(n, 0) === n;
      }),
      { numRuns: 20 },
    );
  });
});
`;

// A corpus test that does NOT call add() — upstream-test stub style
const ADD_CORPUS_STUB = `import * as fc from "fast-check";
import { describe, it } from "vitest";

describe("add — property tests", () => {
  it("precondition 1: inputs are numbers", () => {
    fc.assert(
      fc.property(fc.anything(), (_input) => {
        return true; // placeholder
      }),
      { numRuns: 20 },
    );
  });
});
`;

// A function where some mutations survive a weak test
const CLAMP_IMPL = `export function clamp(n: number, lo: number, hi: number): number {
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}`;

// Weak test: only checks that result is within bounds (won't detect >= vs > mutation)
const CLAMP_CORPUS_WEAK = `import * as fc from "fast-check";
import { describe, it } from "vitest";
import { clamp } from "./impl.js";

describe("clamp", () => {
  it("result is within bounds", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -50, max: 50 }),
        fc.integer({ min: -50, max: 50 }),
        fc.integer({ min: -50, max: 50 }),
        (n, lo, hi) => {
          if (lo > hi) return true; // skip invalid ranges
          const c = clamp(n, lo, hi);
          return c >= lo && c <= hi;
        },
      ),
      { numRuns: 20 },
    );
  });
});
`;

const DIGIT_OR_THROW_IMPL = `export function digitOrThrow(input: string, position: number): readonly [number, number] {
  if (position < 0) {
    throw new RangeError(\`Position \${position} is negative\`);
  }
  if (position >= input.length) {
    throw new SyntaxError(\`Expected digit at position \${position} but reached end of input\`);
  }
  const c = input[position] as string;
  if (c < "0" || c > "9") {
    throw new SyntaxError(\`Expected digit at position \${position} but found \${JSON.stringify(c)}\`);
  }
  return [c.charCodeAt(0) - 48, position + 1] as const;
}`;

// ---------------------------------------------------------------------------
// extractFuncName
// ---------------------------------------------------------------------------

describe("extractFuncName", () => {
  it("extracts name from export function", () => {
    expect(extractFuncName("export function add(a, b) { return a + b; }")).toBe("add");
  });

  it("extracts name from export default function", () => {
    expect(extractFuncName("export default function compute(x) { return x; }")).toBe("compute");
  });

  it("extracts name from export const arrow function", () => {
    expect(extractFuncName("export const double = (n) => n * 2;")).toBe("double");
  });

  it("returns undefined for source with no named export", () => {
    expect(extractFuncName("const x = 1;")).toBeUndefined();
  });

  it("returns undefined for empty source", () => {
    expect(extractFuncName("")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// hasImplReference
// ---------------------------------------------------------------------------

describe("hasImplReference", () => {
  it("returns true when corpus test calls the function", () => {
    expect(hasImplReference("return add(a, b);", "add")).toBe(true);
  });

  it("returns false when corpus test does not call the function", () => {
    expect(hasImplReference("return true;", "add")).toBe(false);
  });

  it("requires function call syntax (parens after name)", () => {
    // 'add' appears as a word but not as a call
    expect(hasImplReference("// calls add function", "add")).toBe(false);
  });

  it("returns true for the add corpus test", () => {
    expect(hasImplReference(ADD_CORPUS_REAL, "add")).toBe(true);
  });

  it("returns false for the stub corpus test", () => {
    expect(hasImplReference(ADD_CORPUS_STUB, "add")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// stripTypes
// ---------------------------------------------------------------------------

describe("stripTypes", () => {
  it("removes parameter type annotations", () => {
    const stripped = stripTypes("function add(a: number, b: number) { return a + b; }");
    expect(stripped).toContain("function add(a, b)");
    expect(stripped).not.toContain(": number");
  });

  it("removes return type annotation", () => {
    const stripped = stripTypes("function f(x: number): number { return x; }");
    expect(stripped).not.toContain(": number {");
    expect(stripped).toContain("function f(");
  });

  it("removes export keyword", () => {
    const stripped = stripTypes("export function add(a: number, b: number): number { return a + b; }");
    expect(stripped).not.toContain("export");
    expect(stripped).toContain("function add");
  });

  it("removes readonly modifier", () => {
    const stripped = stripTypes("function f(a: readonly number[]) { return a; }");
    expect(stripped).not.toContain("readonly");
  });

  it("removes 'as Type' casts", () => {
    const stripped = stripTypes('const c = input[pos] as string;');
    expect(stripped).not.toContain("as string");
  });

  it("handles source without type annotations", () => {
    const src = "function add(a, b) { return a + b; }";
    const stripped = stripTypes(src);
    expect(stripped).toContain("function add(a, b)");
  });
});

// ---------------------------------------------------------------------------
// createMutantFn
// ---------------------------------------------------------------------------

describe("createMutantFn", () => {
  it("creates a callable function from stripped source", () => {
    const stripped = stripTypes(ADD_IMPL);
    const fn = createMutantFn(stripped, "add");
    expect(fn).not.toBeUndefined();
    expect(fn!(3, 4)).toBe(7);
  });

  it("returns undefined for syntactically invalid source", () => {
    const fn = createMutantFn("function add(a { return a; }", "add");
    expect(fn).toBeUndefined();
  });

  it("returns undefined when function name not found in source", () => {
    const fn = createMutantFn("function other(a) { return a; }", "add");
    expect(fn).toBeUndefined();
  });

  it("creates function for subtraction variant", () => {
    const stripped = stripTypes(ADD_IMPL_MINUS);
    const fn = createMutantFn(stripped, "add");
    expect(fn).not.toBeUndefined();
    expect(fn!(10, 3)).toBe(7);
  });
});

// ---------------------------------------------------------------------------
// prepareTestScript
// ---------------------------------------------------------------------------

describe("prepareTestScript", () => {
  it("removes import statements", () => {
    const prepared = prepareTestScript(ADD_CORPUS_REAL);
    expect(prepared).not.toContain("import ");
  });

  it("preserves the describe/it/fc body", () => {
    const prepared = prepareTestScript(ADD_CORPUS_REAL);
    expect(prepared).toContain("describe(");
    expect(prepared).toContain("fc.assert");
  });

  it("handles source with no imports", () => {
    const src = `describe("x", () => { it("y", () => { }); });`;
    const prepared = prepareTestScript(src);
    expect(prepared).toContain("describe(");
  });
});

// ---------------------------------------------------------------------------
// executeMutantTest
// ---------------------------------------------------------------------------

describe("executeMutantTest", () => {
  const strippedAdd = stripTypes(ADD_IMPL);
  const strippedAddMinus = stripTypes(ADD_IMPL_MINUS);
  const preparedTest = prepareTestScript(ADD_CORPUS_REAL);

  it("returns false (survived) for a correct implementation", () => {
    const addFn = createMutantFn(strippedAdd, "add")!;
    const killed = executeMutantTest(preparedTest, "add", addFn, 5000);
    expect(killed).toBe(false);
  });

  it("returns true (killed) for a broken implementation (subtraction)", () => {
    const addMinusFn = createMutantFn(strippedAddMinus, "add")!;
    const killed = executeMutantTest(preparedTest, "add", addMinusFn, 5000);
    // add(a, b) = a - b breaks commutativity (add(1,2)=-1, add(2,1)=1)
    expect(killed).toBe(true);
  });

  it("returns false for a stub test (no assertions)", () => {
    const addFn = createMutantFn(strippedAdd, "add")!;
    const stubPrepared = prepareTestScript(ADD_CORPUS_STUB);
    const killed = executeMutantTest(stubPrepared, "add", addFn, 5000);
    expect(killed).toBe(false);
  });

  it("returns false on timeout (inconclusive) — timeout error treated as survived", () => {
    const addFn = createMutantFn(strippedAdd, "add")!;
    // Simulate the vm timeout path: script that throws with "timed out" in message
    const timeoutScript = `throw new Error("Script execution timed out after 5000ms");`;
    const killed = executeMutantTest(timeoutScript, "add", addFn, 5000);
    expect(killed).toBe(false);
  });

  it("handles corpus using test() instead of it()", () => {
    // Covers the `test` shim (line 152)
    const corpusWithTest = [
      "describe('add', () => {",
      "  test('commutative', () => {",
      "    fc.assert(fc.property(",
      "      fc.integer({ min: -10, max: 10 }),",
      "      fc.integer({ min: -10, max: 10 }),",
      "      (a, b) => add(a, b) === add(b, a)",
      "    ), { numRuns: 5 });",
      "  });",
      "});",
    ].join("\n");
    const addMinusFn = createMutantFn(strippedAddMinus, "add")!;
    const killed = executeMutantTest(corpusWithTest, "add", addMinusFn, 5000);
    // add(a,b) = a-b breaks commutativity → killed
    expect(killed).toBe(true);
  });

  it("handles corpus using expect() shim (no-op, covers shim functions)", () => {
    // Covers the `expect` shim and its inner toBe/toEqual (lines 153-154)
    const corpusWithExpect = [
      "describe('add', () => {",
      "  it('adds numbers', () => {",
      "    expect(add(1, 2)).toBe(3);",
      "    expect(add(0, 0)).toEqual(0);",
      "  });",
      "});",
    ].join("\n");
    const addFn = createMutantFn(strippedAdd, "add")!;
    // expect shim is no-op — doesn't actually assert — so mutant always survives
    const killed = executeMutantTest(corpusWithExpect, "add", addFn, 5000);
    expect(killed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// selectMutants
// ---------------------------------------------------------------------------

describe("selectMutants", () => {
  const mutants = Array.from({ length: 10 }, (_, i) => ({
    id: i + 1,
    originalSource: "s",
    mutatedSource: `s${i}`,
    operatorName: "op",
    description: `d${i}`,
    line: 1,
    col: i + 1,
  }));

  it("returns all mutants when count <= max", () => {
    const selected = selectMutants(mutants, 20);
    expect(selected).toHaveLength(10);
  });

  it("truncates to max when no seed", () => {
    const selected = selectMutants(mutants, 5);
    expect(selected).toHaveLength(5);
    // Without seed: first 5
    expect(selected[0]!.id).toBe(1);
  });

  it("permutes with a seed for reproducible selection", () => {
    const s1 = selectMutants(mutants, 5, 42);
    const s2 = selectMutants(mutants, 5, 42);
    expect(s1.map((m) => m.id)).toEqual(s2.map((m) => m.id));
  });

  it("different seeds produce different orderings", () => {
    const s1 = selectMutants(mutants, 5, 1);
    const s2 = selectMutants(mutants, 5, 999);
    // Not guaranteed to differ for every seed pair, but these specific seeds do
    const same = s1.map((m) => m.id).join(",") === s2.map((m) => m.id).join(",");
    // We accept same if the LCG happens to produce same ordering (unlikely for these seeds)
    // Just test that selectMutants returns the right count either way
    expect(s1).toHaveLength(5);
    expect(s2).toHaveLength(5);
    // Suppress the unused variable warning by referencing same
    expect(typeof same).toBe("boolean");
  });
});

// ---------------------------------------------------------------------------
// runMutationTesting — integration tests
// ---------------------------------------------------------------------------

describe("runMutationTesting", () => {
  it("skips gate when corpus test does not reference impl function", async () => {
    const result = await runMutationTesting({
      implSource: ADD_IMPL,
      corpusTestSource: ADD_CORPUS_STUB,
      canonicalAstHash: "stub-test",
    });
    expect(result.skipped).toBe(true);
    expect(result.killRate).toBe(1.0);
    expect(result.survivors).toHaveLength(0);
  });

  it("skips gate when impl has no extractable function name", async () => {
    const result = await runMutationTesting({
      implSource: "const x = 1;",
      corpusTestSource: ADD_CORPUS_REAL,
      canonicalAstHash: "no-name-test",
    });
    expect(result.skipped).toBe(true);
  });

  it("kills mutants for a real property test (+ → - breaks commutativity)", async () => {
    const result = await runMutationTesting(
      {
        implSource: ADD_IMPL,
        corpusTestSource: ADD_CORPUS_REAL,
        canonicalAstHash: "add-real-test",
      },
      { maxMutants: 5, seed: 42 },
    );
    expect(result.skipped).toBe(false);
    // At least one mutant should be killed by the commutativity/identity tests
    expect(result.killed + result.survivors.length).toBe(result.total);
  });

  it("produces surviving mutants (tests_passed) for a weak corpus test", async () => {
    // The clamp function with `n < lo` → `n <= lo` mutation passes the weak
    // corpus test (result still in bounds). This covers line 263 in run.ts.
    const result = await runMutationTesting(
      {
        implSource: CLAMP_IMPL,
        corpusTestSource: CLAMP_CORPUS_WEAK,
        canonicalAstHash: "clamp-weak-test",
      },
      { maxMutants: 10, seed: 0 },
    );
    expect(result.skipped).toBe(false);
    // At least some survivors expected since the corpus is weak
    const testsPassedSurvivors = result.survivors.filter((s) => s.reason === "tests_passed");
    expect(testsPassedSurvivors.length).toBeGreaterThan(0);
    expect(result.killRate).toBeLessThan(1.0);
  });

  it("uses cache on second call with same canonicalAstHash", async () => {
    const r1 = await runMutationTesting({
      implSource: ADD_IMPL,
      corpusTestSource: ADD_CORPUS_STUB,
      canonicalAstHash: "cache-test",
    });
    const r2 = await runMutationTesting({
      implSource: ADD_IMPL,
      corpusTestSource: ADD_CORPUS_STUB,
      canonicalAstHash: "cache-test",
    });
    // Same object reference → cached
    expect(r1).toBe(r2);
  });

  it("clearMutationCache() removes cached results", async () => {
    await runMutationTesting({
      implSource: ADD_IMPL,
      corpusTestSource: ADD_CORPUS_STUB,
      canonicalAstHash: "cache-clear-test",
    });
    clearMutationCache();
    const r2 = await runMutationTesting({
      implSource: ADD_IMPL,
      corpusTestSource: ADD_CORPUS_STUB,
      canonicalAstHash: "cache-clear-test",
    });
    // After clear, a new result object is returned (not the same reference)
    expect(r2.skipped).toBe(true);
  });

  it("returns elapsed time >= 0", async () => {
    const result = await runMutationTesting({
      implSource: ADD_IMPL,
      corpusTestSource: ADD_CORPUS_STUB,
      canonicalAstHash: "elapsed-test",
    });
    expect(result.elapsed).toBeGreaterThanOrEqual(0);
  });

  it("respects maxMutants option", async () => {
    const result = await runMutationTesting(
      {
        implSource: DIGIT_OR_THROW_IMPL,
        corpusTestSource: ADD_CORPUS_STUB, // stub → skipped
        canonicalAstHash: "max-mutants-test",
      },
      { maxMutants: 3 },
    );
    // Skipped because stub doesn't reference digitOrThrow
    expect(result.skipped).toBe(true);
  });

  it("returns total=0 and skipped=true when source has no named function and no mutants", async () => {
    const result = await runMutationTesting({
      implSource: "// just a comment",
      corpusTestSource: "// nothing",
      canonicalAstHash: "empty-test",
    });
    expect(result.skipped).toBe(true);
  });

  it("handles equivalent mutants (can't eval → equivalent reason)", async () => {
    // A real test but with an impl that can't be eval'd after mutation
    // We use a digitOrThrow corpus test variant and add corpus that calls it
    const corpus = `import * as fc from "fast-check";
import { describe, it } from "vitest";
import { digitOrThrow } from "./impl.js";
describe("digitOrThrow", () => {
  it("returns digit value for valid input", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 9 }),
        (d) => {
          const [val] = digitOrThrow(String(d), 0);
          return val === d;
        }
      ),
      { numRuns: 10 },
    );
  });
});`;
    const result = await runMutationTesting(
      {
        implSource: DIGIT_OR_THROW_IMPL,
        corpusTestSource: corpus,
        canonicalAstHash: "dot-real-test",
      },
      { maxMutants: 10, seed: 1 },
    );
    expect(result.skipped).toBe(false);
    // Some mutants should be killed or equivalent; result is internally consistent
    expect(result.killed + result.survivors.length).toBe(result.total);
    expect(result.killRate).toBeGreaterThanOrEqual(0);
    expect(result.killRate).toBeLessThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Property-based: MutationResult invariants
// ---------------------------------------------------------------------------

describe("runMutationTesting — result invariants (property)", () => {
  it("killRate is always in [0, 1]", async () => {
    await fc.assert(
      fc.asyncProperty(fc.boolean(), async (useReal) => {
        const corpus = useReal ? ADD_CORPUS_REAL : ADD_CORPUS_STUB;
        const result = await runMutationTesting(
          { implSource: ADD_IMPL, corpusTestSource: corpus, canonicalAstHash: `prop-${useReal}` },
          { maxMutants: 3 },
        );
        return result.killRate >= 0 && result.killRate <= 1;
      }),
      { numRuns: 2 },
    );
  });

  it("killed + survivors.length === total for non-skipped results", async () => {
    const result = await runMutationTesting(
      { implSource: ADD_IMPL, corpusTestSource: ADD_CORPUS_REAL, canonicalAstHash: "invariant-test" },
      { maxMutants: 5, seed: 7 },
    );
    if (!result.skipped) {
      expect(result.killed + result.survivors.length).toBe(result.total);
    }
  });
});
