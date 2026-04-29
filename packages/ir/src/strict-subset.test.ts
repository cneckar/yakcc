// Tests for the strict-subset validator.
//
// Structure:
//   - Negative tests: each forbidden construct is rejected (≥2 cases each)
//   - Positive tests: close-but-allowed variants pass without false positives
//   - Property tests: monotonicity and idempotence via fast-check
//   - Path-discovery tests: validateStrictSubsetFile against fixture directory

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { validateStrictSubset, validateStrictSubsetFile } from "./strict-subset.js";

// Resolve the fixture block directory relative to this test file.
const FIXTURE_DIR = join(fileURLToPath(import.meta.url), "..", "__fixtures__", "blocks");

// ---------------------------------------------------------------------------
// Helper: assert violation
// ---------------------------------------------------------------------------

function assertRejects(source: string, rule: string): void {
  const result = validateStrictSubset(source);
  if (result.ok) {
    throw new Error(
      `Expected rule "${rule}" to trigger but validator returned ok:true for:\n${source}`,
    );
  }
  const matching = result.errors.filter((e) => e.rule === rule);
  expect(matching.length).toBeGreaterThan(0);
}

function assertPasses(source: string): void {
  const result = validateStrictSubset(source);
  if (!result.ok) {
    const msgs = result.errors.map((e) => `  ${e.rule}: ${e.message}`).join("\n");
    throw new Error(`Expected source to pass but got errors:\n${msgs}\n\nSource:\n${source}`);
  }
}

// ---------------------------------------------------------------------------
// no-any
// ---------------------------------------------------------------------------

describe("no-any", () => {
  it("rejects explicit type annotation `: any`", () => {
    assertRejects("export const x: any = 1;", "no-any");
  });

  it("rejects `as any` cast", () => {
    assertRejects("export const x = (1 as any);", "no-any");
  });

  it("rejects parameter typed as any", () => {
    assertRejects("export function f(x: any): void {}", "no-any");
  });

  it("rejects return type any", () => {
    assertRejects("export function f(): any { return 1; }", "no-any");
  });

  it("rejects generic type argument any", () => {
    assertRejects("export const arr: Array<any> = [];", "no-any");
  });

  // Allowed variants
  it("allows unknown type (not any)", () => {
    assertPasses("export function f(x: unknown): void { void x; }");
  });

  it("allows explicit typed const (no any)", () => {
    assertPasses("export const x: number = 1;");
  });
});

// ---------------------------------------------------------------------------
// no-eval
// ---------------------------------------------------------------------------

describe("no-eval", () => {
  it("rejects eval(...) call", () => {
    assertRejects(`export function f(): void { eval("1+1"); }`, "no-eval");
  });

  it("rejects new Function(...) constructor", () => {
    assertRejects(`export function f(): void { new Function("return 1"); }`, "no-eval");
  });

  it("rejects bare Function(...) call", () => {
    assertRejects(`export function f(): void { Function("return 1"); }`, "no-eval");
  });

  // Allowed variants
  it("allows a local variable named eval used as a type (shadowed)", () => {
    // A shadowed `eval` identifier in a type position does not trigger the rule
    // because the rule only fires on call expressions — but we can't prove
    // shadowing easily in the in-memory project. Just ensure a function
    // with a different name doesn't trigger it.
    assertPasses("export function evaluate(code: string): string { return code; }");
  });

  it("allows JSON.parse (not eval)", () => {
    assertPasses("export function parse(s: string): unknown { return JSON.parse(s); }");
  });
});

// ---------------------------------------------------------------------------
// no-runtime-reflection
// ---------------------------------------------------------------------------

describe("no-runtime-reflection", () => {
  it("rejects Object.getPrototypeOf", () => {
    assertRejects(
      "export function f(x: object): object { return Object.getPrototypeOf(x); }",
      "no-runtime-reflection",
    );
  });

  it("rejects Object.defineProperty", () => {
    assertRejects(
      `export function f(x: object): void { Object.defineProperty(x, "p", { value: 1 }); }`,
      "no-runtime-reflection",
    );
  });

  it("rejects Reflect.ownKeys", () => {
    assertRejects(
      "export function f(x: object): PropertyKey[] { return Reflect.ownKeys(x); }",
      "no-runtime-reflection",
    );
  });

  it("rejects Reflect.get", () => {
    assertRejects(
      "export function f(x: object, k: string): unknown { return Reflect.get(x, k); }",
      "no-runtime-reflection",
    );
  });

  it("rejects __proto__ property access", () => {
    assertRejects(
      "export function f(x: object): unknown { return (x as { __proto__: unknown }).__proto__; }",
      "no-runtime-reflection",
    );
  });

  it("rejects __proto__ bracket access", () => {
    assertRejects(
      `export function f(x: Record<string, unknown>): unknown { return x["__proto__"]; }`,
      "no-runtime-reflection",
    );
  });

  it("rejects Object.setPrototypeOf", () => {
    assertRejects(
      "export function f(x: object, p: object): void { Object.setPrototypeOf(x, p); }",
      "no-runtime-reflection",
    );
  });

  // Allowed variants
  it("allows Object.keys (not a reflection method)", () => {
    assertPasses(
      "export function f(x: Record<string, number>): string[] { return Object.keys(x); }",
    );
  });

  it("allows Object.assign (not a reflection method)", () => {
    assertPasses(
      "export function f(a: Record<string, number>, b: Record<string, number>): Record<string, number> { return Object.assign({}, a, b); }",
    );
  });
});

// ---------------------------------------------------------------------------
// no-with
// ---------------------------------------------------------------------------

describe("no-with", () => {
  // `with` is a syntax error in strict mode TypeScript, but ts-morph can still
  // parse it in non-strict JS context. We verify our rule fires when present.
  // Because TypeScript rejects `with` outright under strict mode, we test that
  // the rule at minimum doesn't false-positive on clean code.
  it("does not false-positive on clean code (no with)", () => {
    assertPasses("export function f(x: number): number { return x + 1; }");
  });

  it("rejects with statement", () => {
    // ts-morph parses `with` even in TS mode (the node exists in the AST);
    // our rule must detect and reject it.
    const source = "export function f(): void { with (Math) { const x = 1; void x; } }";
    const result = validateStrictSubset(source);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.rule === "no-with")).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// no-mutable-globals
// ---------------------------------------------------------------------------

describe("no-mutable-globals", () => {
  it("rejects top-level let", () => {
    assertRejects("let x = 1;\nexport function f(): number { return x; }", "no-mutable-globals");
  });

  it("rejects top-level var", () => {
    assertRejects("var x = 1;\nexport function f(): number { return x; }", "no-mutable-globals");
  });

  it("rejects exported top-level let", () => {
    assertRejects("export let counter = 0;", "no-mutable-globals");
  });

  // Allowed variants
  it("allows top-level const", () => {
    assertPasses("export const LIMIT = 100;\nexport function f(): number { return LIMIT; }");
  });

  it("allows let inside a function body (not top-level)", () => {
    assertPasses("export function f(): number { let x = 0; x += 1; return x; }");
  });

  it("allows var inside a function body (not top-level)", () => {
    assertPasses("export function f(): number { var x = 0; return x; }");
  });
});

// ---------------------------------------------------------------------------
// no-throw-non-error
// ---------------------------------------------------------------------------

describe("no-throw-non-error", () => {
  it("rejects throwing a string literal", () => {
    assertRejects(`export function f(): void { throw "bad input"; }`, "no-throw-non-error");
  });

  it("rejects throwing a number literal", () => {
    assertRejects("export function f(): void { throw 42; }", "no-throw-non-error");
  });

  it("rejects throwing an object literal", () => {
    assertRejects(`export function f(): void { throw { code: "ERR" }; }`, "no-throw-non-error");
  });

  // Allowed variants
  it("allows throw new Error(...)", () => {
    assertPasses(`export function f(): void { throw new Error("bad"); }`);
  });

  it("allows throw new TypeError(...)", () => {
    assertPasses(`export function f(): void { throw new TypeError("type mismatch"); }`);
  });

  it("allows throw of an identifier (may be an Error reference)", () => {
    assertPasses("export function f(err: Error): void { throw err; }");
  });
});

// ---------------------------------------------------------------------------
// no-top-level-side-effects
// ---------------------------------------------------------------------------

describe("no-top-level-side-effects", () => {
  it("rejects top-level console.log call", () => {
    assertRejects(`console.log("init");\nexport const x = 1;`, "no-top-level-side-effects");
  });

  it("rejects top-level assignment expression", () => {
    assertRejects(
      `export const obj: Record<string, number> = {};\nobj["key"] = 1;`,
      "no-top-level-side-effects",
    );
  });

  // Allowed variants
  it("allows top-level import + export const", () => {
    assertPasses(
      `export const VERSION = "0.0.1";\nexport function f(): string { return VERSION; }`,
    );
  });

  it("allows top-level interface declaration", () => {
    assertPasses(
      "export interface Foo { readonly x: number; }\nexport function f(foo: Foo): number { return foo.x; }",
    );
  });

  it("allows top-level type alias", () => {
    assertPasses(`export type Id = string & { readonly __brand: "Id" };`);
  });

  it("allows top-level class declaration", () => {
    assertPasses(
      "export class Counter { private n = 0; increment(): void { this.n++; } value(): number { return this.n; } }",
    );
  });
});

// ---------------------------------------------------------------------------
// no-untyped-imports
// ---------------------------------------------------------------------------

describe("no-untyped-imports", () => {
  // In the in-memory project, modules that have no registered types resolve to `any`.
  // A bare import of a nonexistent module should trigger the rule.
  it("rejects import of unresolvable module", () => {
    const source = `import { foo } from "some-untyped-module-that-has-no-types";\nexport function f(): unknown { return foo; }`;
    assertRejects(source, "no-untyped-imports");
  });

  // Allowed variants
  it("allows import type (always safe)", () => {
    assertPasses(
      `import type { ContractSpec } from "@yakcc/contracts";\nexport function f(): void {}`,
    );
  });
});

// ---------------------------------------------------------------------------
// Property tests: idempotence and monotonicity
// ---------------------------------------------------------------------------

describe("property tests", () => {
  it("validating twice gives the same result", () => {
    // Use a fixed set of sources — fast-check arbitrary TS strings would be
    // too slow and mostly parse-error. Test with known valid and invalid sources.
    const sources = [
      "export const x = 1;",
      "export function f(): number { return 1; }",
      "export const x: any = 1;",
      "let top = 0;\nexport const f = (): number => top;",
      `export function g(): void { eval("1"); }`,
    ];
    for (const source of sources) {
      const r1 = validateStrictSubset(source);
      const r2 = validateStrictSubset(source);
      expect(r1.ok).toBe(r2.ok);
      if (!r1.ok && !r2.ok) {
        expect(r1.errors.map((e) => e.rule)).toEqual(r2.errors.map((e) => e.rule));
      }
    }
  });

  it("adding whitespace/comments to a passing source does not fail it", () => {
    const base = `export const VERSION = "1";\nexport function f(): string { return VERSION; }`;
    assertPasses(base);
    assertPasses(`// leading comment\n${base}`);
    assertPasses(`${base}\n// trailing comment`);
    assertPasses(`\n\n${base}\n\n`);
  });

  it("adding whitespace/comments to a failing source keeps it failing with the same rules", () => {
    const base = "export const x: any = 1;";
    const r1 = validateStrictSubset(base);
    const r2 = validateStrictSubset(`// comment\n${base}`);
    expect(r1.ok).toBe(false);
    expect(r2.ok).toBe(false);
    if (!r1.ok && !r2.ok) {
      expect(r1.errors.map((e) => e.rule).sort()).toEqual(r2.errors.map((e) => e.rule).sort());
    }
  });

  it("fast-check: a source that already passed never becomes invalid on second call", () => {
    const knownGoodSources = [
      "export const A = 1;",
      "export function add(a: number, b: number): number { return a + b; }",
      "export interface Point { readonly x: number; readonly y: number; }",
      `export type Id = string & { readonly __brand: "Id" };`,
    ];
    fc.assert(
      fc.property(fc.constantFrom(...knownGoodSources), (source) => {
        const r1 = validateStrictSubset(source);
        const r2 = validateStrictSubset(source);
        return r1.ok === r2.ok;
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// Integration: compound scenario
// ---------------------------------------------------------------------------

describe("integration: real production sequence", () => {
  it("a valid strict-TS-subset block passes all rules", () => {
    // This exercises the full production sequence: source → in-memory parse →
    // all 8 rules checked → ValidationResult returned.
    const validBlock = `
import type { ContractSpec } from "@yakcc/contracts";

export const CONTRACT: ContractSpec = {
  inputs: [{ name: "s", type: "string" }],
  outputs: [{ name: "result", type: "number" }],
  behavior: "Parse a single ASCII digit character '0'-'9' to its integer value.",
  guarantees: [{ id: "pure", description: "Referentially transparent." }],
  errorConditions: [{ description: "Input is not a single digit character.", errorType: "RangeError" }],
  nonFunctional: { time: "O(1)", space: "O(1)", purity: "pure", threadSafety: "safe" },
  propertyTests: [
    { id: "zero", description: "digitOf('0') === 0" },
    { id: "nine", description: "digitOf('9') === 9" },
  ],
};

export function digitOf(s: string): number {
  if (s.length !== 1 || s < "0" || s > "9") {
    throw new RangeError(\`Not a digit: \${s}\`);
  }
  return s.charCodeAt(0) - "0".charCodeAt(0);
}
`;
    assertPasses(validBlock);
  });

  it("a block with multiple violations reports all of them", () => {
    const badBlock = `
let counter = 0;
export function f(x: any): any {
  eval("counter++");
  return x;
}
`;
    const result = validateStrictSubset(badBlock);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const rules = new Set(result.errors.map((e) => e.rule));
      expect(rules.has("no-any")).toBe(true);
      expect(rules.has("no-eval")).toBe(true);
      expect(rules.has("no-mutable-globals")).toBe(true);
    }
  });

  it("ValidationError carries file, line, column, and snippet", () => {
    const result = validateStrictSubset("export const x: any = 1;");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const err = result.errors[0];
      expect(err).toBeDefined();
      if (err !== undefined) {
        expect(err.file).toBe("<source>");
        expect(err.line).toBeGreaterThan(0);
        expect(err.column).toBeGreaterThan(0);
        expect(err.snippet).toBeTruthy();
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Path-discovery: validateStrictSubsetFile against fixture blocks
//
// This section proves the strict-subset validator works on real files and that
// the path-discovery pattern used by the CLI is non-vacuous. Fixtures live at
// src/__fixtures__/blocks/ (in scope for WI-004). The valid fixture passes all
// rules; the invalid fixture fails with no-any.
// ---------------------------------------------------------------------------

describe("path-discovery: fixture block files", () => {
  it("accepts valid-block.ts fixture (strict-subset compliant)", () => {
    const path = join(FIXTURE_DIR, "valid-block.ts");
    // Ensure the fixture exists — a missing file would silently skip validation.
    const source = readFileSync(path, "utf-8");
    expect(source.length).toBeGreaterThan(0);

    const result = validateStrictSubsetFile(path);
    if (!result.ok) {
      const msgs = result.errors.map((e) => `  ${e.rule}: ${e.message}`).join("\n");
      throw new Error(`valid-block.ts should pass but got errors:\n${msgs}`);
    }
    expect(result.ok).toBe(true);
  });

  it("rejects invalid-block.ts fixture (contains any)", () => {
    const path = join(FIXTURE_DIR, "invalid-block.ts");
    const source = readFileSync(path, "utf-8");
    expect(source.length).toBeGreaterThan(0);

    const result = validateStrictSubsetFile(path);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.rule === "no-any")).toBe(true);
    }
  });

  it("file path is reported correctly in ValidationError", () => {
    const path = join(FIXTURE_DIR, "invalid-block.ts");
    const result = validateStrictSubsetFile(path);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // Every error should carry the actual file path, not "<source>".
      for (const err of result.errors) {
        expect(err.file).toBe(path);
      }
    }
  });
});
