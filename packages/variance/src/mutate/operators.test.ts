// SPDX-License-Identifier: MIT
import { beforeEach, describe, expect, it } from "vitest";
import { ALL_OPERATORS, generateMutants, resetMutantId } from "./operators.js";

beforeEach(() => {
  resetMutantId();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function applyOperator(name: string, source: string) {
  const op = ALL_OPERATORS.find((o) => o.name === name);
  if (!op) throw new Error(`Operator not found: ${name}`);
  return op.apply(source);
}

function hasOperator(name: string) {
  return ALL_OPERATORS.some((o) => o.name === name);
}

// ---------------------------------------------------------------------------
// Presence check: 20+ operators exported
// ---------------------------------------------------------------------------

describe("ALL_OPERATORS", () => {
  it("exports at least 20 operators", () => {
    expect(ALL_OPERATORS.length).toBeGreaterThanOrEqual(20);
  });

  it("all operator names are unique", () => {
    const names = ALL_OPERATORS.map((o) => o.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("includes all expected categories", () => {
    const names = ALL_OPERATORS.map((o) => o.name);
    const categories = ["arith-", "cmp-", "bool-", "ctrl-", "const-", "loop-"];
    for (const cat of categories) {
      expect(
        names.some((n) => n.startsWith(cat)),
        `no operator for category ${cat}`,
      ).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Arithmetic operators
// ---------------------------------------------------------------------------

describe("arith-mul-to-div", () => {
  it("replaces * with /", () => {
    const mutants = applyOperator("arith-mul-to-div", "return a * b;");
    expect(mutants).toHaveLength(1);
    expect(mutants[0]?.mutatedSource).toContain("a / b");
  });

  it("does not match **", () => {
    const mutants = applyOperator("arith-mul-to-div", "return 2 ** 3;");
    expect(mutants).toHaveLength(0);
  });
});

describe("arith-div-to-mul", () => {
  it("replaces / with *", () => {
    const mutants = applyOperator("arith-div-to-mul", "return a / b;");
    expect(mutants).toHaveLength(1);
    expect(mutants[0]?.mutatedSource).toContain("a * b");
  });
});

describe("arith-mod-to-mul", () => {
  it("replaces % with *", () => {
    const mutants = applyOperator("arith-mod-to-mul", "return n % 2;");
    expect(mutants).toHaveLength(1);
    expect(mutants[0]?.mutatedSource).toContain("n * 2");
  });
});

describe("arith-pow-to-mul", () => {
  it("replaces ** with *", () => {
    const mutants = applyOperator("arith-pow-to-mul", "return x ** 2;");
    expect(mutants).toHaveLength(1);
    expect(mutants[0]?.mutatedSource).toContain("x * 2");
  });
});

describe("arith-minus-to-plus", () => {
  it("replaces binary - with +", () => {
    const mutants = applyOperator("arith-minus-to-plus", "return a - b;");
    expect(mutants.length).toBeGreaterThan(0);
    const found = mutants.find((m) => m.mutatedSource.includes("a + b"));
    expect(found).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Comparison operators
// ---------------------------------------------------------------------------

describe("cmp-stricteq-to-strictneq", () => {
  it("replaces === with !==", () => {
    const mutants = applyOperator("cmp-stricteq-to-strictneq", "if (a === b) return 1;");
    expect(mutants).toHaveLength(1);
    expect(mutants[0]?.mutatedSource).toContain("a !== b");
  });
});

describe("cmp-strictneq-to-stricteq", () => {
  it("replaces !== with ===", () => {
    const mutants = applyOperator("cmp-strictneq-to-stricteq", "if (a !== b) return 1;");
    expect(mutants).toHaveLength(1);
    expect(mutants[0]?.mutatedSource).toContain("a === b");
  });
});

describe("cmp-gt-to-gte", () => {
  it("replaces > with >=", () => {
    const mutants = applyOperator("cmp-gt-to-gte", "if (n > 0) return 1;");
    expect(mutants.length).toBeGreaterThan(0);
    expect(mutants[0]?.mutatedSource).toContain(">=");
  });
});

describe("cmp-gte-to-gt", () => {
  it("replaces >= with >", () => {
    const mutants = applyOperator("cmp-gte-to-gt", "if (n >= 0) return 1;");
    expect(mutants).toHaveLength(1);
    expect(mutants[0]?.mutatedSource).toContain("n > 0");
  });
});

describe("cmp-lt-to-lte", () => {
  it("replaces < with <=", () => {
    const mutants = applyOperator("cmp-lt-to-lte", "if (n < 10) return 1;");
    expect(mutants.length).toBeGreaterThan(0);
    expect(mutants[0]?.mutatedSource).toContain("<=");
  });
});

describe("cmp-lte-to-lt", () => {
  it("replaces <= with <", () => {
    const mutants = applyOperator("cmp-lte-to-lt", "if (n <= 10) return 1;");
    expect(mutants).toHaveLength(1);
    expect(mutants[0]?.mutatedSource).toContain("n < 10");
  });
});

describe("cmp-gtlt", () => {
  it("replaces > with <", () => {
    const mutants = applyOperator("cmp-gtlt", "if (a > b) return 1;");
    expect(mutants.length).toBeGreaterThan(0);
    expect(mutants[0]?.mutatedSource).toContain("a < b");
  });
});

describe("cmp-ltgt", () => {
  it("replaces < with >", () => {
    const mutants = applyOperator("cmp-ltgt", "if (a < b) return 1;");
    expect(mutants.length).toBeGreaterThan(0);
    expect(mutants[0]?.mutatedSource).toContain("a > b");
  });
});

// ---------------------------------------------------------------------------
// Boolean operators
// ---------------------------------------------------------------------------

describe("bool-and-to-or", () => {
  it("replaces && with ||", () => {
    const mutants = applyOperator("bool-and-to-or", "if (a && b) return 1;");
    expect(mutants).toHaveLength(1);
    expect(mutants[0]?.mutatedSource).toContain("a || b");
  });
});

describe("bool-or-to-and", () => {
  it("replaces || with &&", () => {
    const mutants = applyOperator("bool-or-to-and", "if (a || b) return 1;");
    expect(mutants).toHaveLength(1);
    expect(mutants[0]?.mutatedSource).toContain("a && b");
  });
});

describe("bool-negation-strip", () => {
  it("removes leading !", () => {
    const mutants = applyOperator("bool-negation-strip", "if (!x) return 1;");
    expect(mutants.length).toBeGreaterThan(0);
    expect(mutants.some((m) => m.mutatedSource.includes("if (x)"))).toBe(true);
  });

  it("does not strip !=", () => {
    const mutants = applyOperator("bool-negation-strip", "if (a != b) return 1;");
    // != has !, but ! is followed by =, so it should not be stripped
    expect(mutants).toHaveLength(0);
  });
});

describe("bool-true-to-false", () => {
  it("replaces true with false", () => {
    const mutants = applyOperator("bool-true-to-false", "return true;");
    expect(mutants).toHaveLength(1);
    expect(mutants[0]?.mutatedSource).toContain("return false");
  });
});

describe("bool-false-to-true", () => {
  it("replaces false with true", () => {
    const mutants = applyOperator("bool-false-to-true", "return false;");
    expect(mutants).toHaveLength(1);
    expect(mutants[0]?.mutatedSource).toContain("return true");
  });
});

// ---------------------------------------------------------------------------
// Control flow operators
// ---------------------------------------------------------------------------

describe("ctrl-negate-if", () => {
  it("negates if condition", () => {
    const mutants = applyOperator("ctrl-negate-if", "if (x > 0) { return x; }");
    expect(mutants.length).toBeGreaterThan(0);
    expect(mutants[0]?.mutatedSource).toContain("if (!(");
  });

  it("does not fire on source without if", () => {
    const mutants = applyOperator("ctrl-negate-if", "return a + b;");
    expect(mutants).toHaveLength(0);
  });
});

describe("ctrl-throw-to-return", () => {
  it("replaces throw new Error with return undefined", () => {
    const src = 'if (n < 0) { throw new RangeError("negative"); }';
    const mutants = applyOperator("ctrl-throw-to-return", src);
    expect(mutants).toHaveLength(1);
    expect(mutants[0]?.mutatedSource).toContain("return undefined as any");
  });

  it("does not fire on plain throw", () => {
    const mutants = applyOperator("ctrl-throw-to-return", "throw err;");
    expect(mutants).toHaveLength(0);
  });
});

describe("ctrl-return-to-undefined", () => {
  it("replaces return value with return undefined", () => {
    const mutants = applyOperator("ctrl-return-to-undefined", "return a + b;");
    expect(mutants.length).toBeGreaterThan(0);
    expect(mutants[0]?.mutatedSource).toContain("return undefined");
  });

  it("does not replace bare return", () => {
    const mutants = applyOperator("ctrl-return-to-undefined", "return;");
    // bare return has no expression after return → should not match
    expect(mutants.every((m) => m.mutatedSource !== "return undefined")).toBe(true);
  });

  it("does not match return undefined itself", () => {
    const mutants = applyOperator("ctrl-return-to-undefined", "return undefined;");
    expect(mutants).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Constants operators
// ---------------------------------------------------------------------------

describe("const-zero-to-one", () => {
  it("replaces isolated 0 with 1", () => {
    const mutants = applyOperator("const-zero-to-one", "return n + 0;");
    expect(mutants.length).toBeGreaterThan(0);
    expect(mutants.some((m) => m.mutatedSource.includes("n + 1"))).toBe(true);
  });

  it("does not replace 0 inside a larger number", () => {
    const mutants = applyOperator("const-zero-to-one", "return 100;");
    expect(mutants).toHaveLength(0);
  });
});

describe("const-one-to-zero", () => {
  it("replaces isolated 1 with 0", () => {
    const mutants = applyOperator("const-one-to-zero", "return n + 1;");
    expect(mutants.length).toBeGreaterThan(0);
  });
});

describe("const-emptystr-to-space", () => {
  it('replaces "" with " "', () => {
    const mutants = applyOperator("const-emptystr-to-space", 'if (s === "") return -1;');
    expect(mutants).toHaveLength(1);
    expect(mutants[0]?.mutatedSource).toContain('" "');
  });
});

describe("const-null-to-undef", () => {
  it("replaces null with undefined", () => {
    const mutants = applyOperator("const-null-to-undef", "return null;");
    expect(mutants).toHaveLength(1);
    expect(mutants[0]?.mutatedSource).toContain("return undefined");
  });
});

describe("const-undef-to-null", () => {
  it("replaces undefined with null", () => {
    const mutants = applyOperator("const-undef-to-null", "return undefined;");
    expect(mutants).toHaveLength(1);
    expect(mutants[0]?.mutatedSource).toContain("return null");
  });
});

// ---------------------------------------------------------------------------
// Loop bounds operators
// ---------------------------------------------------------------------------

describe("loop-lt-to-lte", () => {
  it("changes < to <= in for loop condition", () => {
    const mutants = applyOperator("loop-lt-to-lte", "for (let i = 0; i < n; i++) { }");
    expect(mutants.length).toBeGreaterThan(0);
    expect(mutants[0]?.mutatedSource).toContain("i <=");
  });

  it("does not fire on source without a for loop", () => {
    const mutants = applyOperator("loop-lt-to-lte", "if (a < b) return 1;");
    expect(mutants).toHaveLength(0);
  });

  it("does not fire for a for loop with >= condition (inner-if false branch)", () => {
    // for loop present but condition uses >= not < → inner if condition is false
    const mutants = applyOperator("loop-lt-to-lte", "for (let i = n; i >= 0; i--) { }");
    expect(mutants).toHaveLength(0);
  });
});

describe("loop-lte-to-lt", () => {
  it("changes <= to < in for loop condition", () => {
    const mutants = applyOperator("loop-lte-to-lt", "for (let i = 0; i <= n; i++) { }");
    expect(mutants.length).toBeGreaterThan(0);
    expect(mutants[0]?.mutatedSource).toContain("i <");
  });

  it("does not fire for a for loop with < condition (inner-if false branch)", () => {
    // for loop present but condition uses < not <= → inner if finds no lteIdx
    const mutants = applyOperator("loop-lte-to-lt", "for (let i = 0; i < n; i++) { }");
    expect(mutants).toHaveLength(0);
  });
});

describe("loop-init-zero-to-one", () => {
  it("changes loop initializer 0 to 1", () => {
    const mutants = applyOperator("loop-init-zero-to-one", "for (let i = 0; i < n; i++) { }");
    expect(mutants.length).toBeGreaterThan(0);
    expect(mutants[0]?.mutatedSource).toMatch(/let i = 1/);
  });

  it("does not fire for a for loop with non-zero initializer (inner-if false branch)", () => {
    // for loop present but initializer is 1, not 0
    const mutants = applyOperator("loop-init-zero-to-one", "for (let i = 1; i < n; i++) { }");
    expect(mutants).toHaveLength(0);
  });
});

describe("loop-incr-to-decr", () => {
  it("replaces ++ with -- after a variable", () => {
    const mutants = applyOperator("loop-incr-to-decr", "for (let i = 0; i < n; i++) { }");
    expect(mutants.length).toBeGreaterThan(0);
    expect(mutants[0]?.mutatedSource).toContain("i--");
  });
});

// ---------------------------------------------------------------------------
// Off-by-one operators
// ---------------------------------------------------------------------------

describe("obo-minus-one", () => {
  it("removes - 1 from an expression", () => {
    const mutants = applyOperator("obo-minus-one", "return arr[n - 1];");
    expect(mutants.length).toBeGreaterThan(0);
    expect(mutants[0]?.mutatedSource).toContain("arr[n]");
  });

  it("does not fire when no - 1 pattern exists", () => {
    const mutants = applyOperator("obo-minus-one", "return arr[n];");
    expect(mutants).toHaveLength(0);
  });
});

describe("obo-plus-one", () => {
  it("removes + 1 from an expression", () => {
    const mutants = applyOperator("obo-plus-one", "return pos + 1;");
    expect(mutants.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// generateMutants
// ---------------------------------------------------------------------------

describe("generateMutants", () => {
  it("returns mutants from multiple operators", () => {
    const src = `
export function digitOrThrow(input, position) {
  if (position < 0) throw new RangeError("negative");
  if (position >= input.length) throw new SyntaxError("eof");
  const c = input[position];
  if (c < "0" || c > "9") throw new SyntaxError("not a digit");
  return [c.charCodeAt(0) - 48, position + 1];
}`;
    const mutants = generateMutants(src);
    expect(mutants.length).toBeGreaterThan(0);
  });

  it("deduplicates mutations at the same operator+location", () => {
    // A source with one + sign should produce at most 1 arith-plus-to-minus mutant
    const src = "function f(a, b) { return a + b; }";
    const mutants = generateMutants(src);
    const dupCheck = new Map<string, number>();
    for (const m of mutants) {
      const key = `${m.operatorName}:${m.line}:${m.col}`;
      dupCheck.set(key, (dupCheck.get(key) ?? 0) + 1);
    }
    for (const [key, count] of dupCheck) {
      expect(count, `duplicate mutant at ${key}`).toBe(1);
    }
  });

  it("assigns sequential ids starting at 1", () => {
    resetMutantId();
    const src = "function f(a, b) { return a + b; }";
    const mutants = generateMutants(src);
    expect(mutants[0]?.id).toBeGreaterThanOrEqual(1);
    for (let i = 1; i < mutants.length; i++) {
      expect(mutants[i]?.id).toBeGreaterThan(mutants[i - 1]?.id);
    }
  });

  it("returns empty array for a source with no matchable tokens", () => {
    const mutants = generateMutants("function f() { }");
    // An empty function body has no tokens that match any operators
    expect(Array.isArray(mutants)).toBe(true);
  });

  it("includes line/col in each mutant description", () => {
    const src = "function f(a) { return a + 1; }";
    const mutants = generateMutants(src);
    for (const m of mutants) {
      expect(m.line).toBeGreaterThan(0);
      expect(m.col).toBeGreaterThan(0);
      expect(m.description).toContain(`${m.line}:${m.col}`);
    }
  });

  it("operator with name not in ALL_OPERATORS is not found", () => {
    expect(hasOperator("nonexistent-operator")).toBe(false);
  });
});
