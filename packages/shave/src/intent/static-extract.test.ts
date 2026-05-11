/**
 * Unit tests for staticExtract() and pickPrimaryDeclaration().
 *
 * Table-driven fixture suite covering:
 *   - Bare function declaration
 *   - Arrow-const + JSDoc (regression for VariableStatement JSDoc gotcha)
 *   - Exported async function
 *   - Generic function
 *   - Destructured params
 *   - Rest params
 *   - No-JSDoc fallback (signature string)
 *   - Void return type
 *   - Multi-decl picker (export default wins)
 *   - No-declaration fragment (behavior = "source fragment (...)")
 *   - Full JSDoc with all tag families (@param, @returns, @requires, @ensures,
 *     @throws, @remarks, @example, @note)
 *   - Multiline @requires
 *   - Malformed JSDoc (graceful degradation)
 *
 * Production sequence: universalize() calls extractIntent() → staticExtract()
 * for every candidate block when strategy === "static". These tests verify that
 * every card produced by staticExtract() passes validateIntentCard() and has the
 * correct shape.
 */

import { Project } from "ts-morph";
import { describe, expect, it } from "vitest";
import { staticExtract } from "./static-extract.js";
import { pickPrimaryDeclaration } from "./static-pick.js";
import { validateIntentCard } from "./validate-intent-card.js";

// ---------------------------------------------------------------------------
// Test envelope (fixed for determinism)
// ---------------------------------------------------------------------------

const ENVELOPE = {
  sourceHash: "a".repeat(64),
  modelVersion: "static-ts@1",
  promptVersion: "static-jsdoc@1",
  extractedAt: "2025-06-15T12:00:00.000Z",
};

/** Run staticExtract + validateIntentCard and return the card. */
function extract(source: string) {
  const raw = staticExtract(source, ENVELOPE);
  return validateIntentCard(raw);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSourceFile(source: string) {
  const project = new Project({
    useInMemoryFileSystem: true,
    compilerOptions: { strict: false, allowJs: true, noLib: true },
  });
  return project.createSourceFile("__test__.ts", source);
}

// ---------------------------------------------------------------------------
// pickPrimaryDeclaration tests
// ---------------------------------------------------------------------------

describe("pickPrimaryDeclaration()", () => {
  it("prefers export default function over other declarations", () => {
    const sf = makeSourceFile(`
      function helper() {}
      export default function main() {}
    `);
    const node = pickPrimaryDeclaration(sf);
    expect(node).toBeDefined();
    // The node should contain "main"
    expect(node?.getText()).toContain("main");
  });

  it("prefers first exported function over non-exported", () => {
    const sf = makeSourceFile(`
      function internal() {}
      export function pub() {}
    `);
    const node = pickPrimaryDeclaration(sf);
    expect(node?.getText()).toContain("pub");
  });

  it("picks exported arrow-const (VariableStatement, not ArrowFunction)", () => {
    const sf = makeSourceFile(`
      export const greet = (name: string): string => "hello " + name;
    `);
    const node = pickPrimaryDeclaration(sf);
    expect(node).toBeDefined();
    // Must be a VariableStatement (not inner ArrowFunction) for JSDoc to work
    expect(node?.getKindName()).toBe("VariableStatement");
  });

  it("falls back to non-exported function when no export present", () => {
    const sf = makeSourceFile(`
      function localOnly(x: number) { return x; }
    `);
    const node = pickPrimaryDeclaration(sf);
    expect(node?.getText()).toContain("localOnly");
  });

  it("falls back to non-exported arrow-const", () => {
    const sf = makeSourceFile(`
      const double = (n: number) => n * 2;
    `);
    const node = pickPrimaryDeclaration(sf);
    expect(node).toBeDefined();
    expect(node?.getKindName()).toBe("VariableStatement");
  });

  it("returns undefined for no declaration (bare expression)", () => {
    const sf = makeSourceFile("1 + 2;");
    const node = pickPrimaryDeclaration(sf);
    expect(node).toBeUndefined();
  });

  it("picks first method from first class when no functions present", () => {
    const sf = makeSourceFile(`
      class Foo {
        bar(): void {}
        baz(): void {}
      }
    `);
    const node = pickPrimaryDeclaration(sf);
    expect(node).toBeDefined();
    expect(node?.getText()).toContain("bar");
  });
});

// ---------------------------------------------------------------------------
// staticExtract tests
// ---------------------------------------------------------------------------

describe("staticExtract()", () => {
  // -------------------------------------------------------------------------
  // Schema parity: all cards must pass validateIntentCard
  // -------------------------------------------------------------------------

  it("always produces a card that passes validateIntentCard", () => {
    const sources = [
      "function add(a: number, b: number): number { return a + b; }",
      "export const id = (x: string): string => x;",
      "export async function fetch(url: string): Promise<Response> { return fetch(url); }",
      "1 + 2;",
      "export function noop(): void {}",
    ];
    for (const source of sources) {
      expect(() => extract(source)).not.toThrow();
    }
  });

  // -------------------------------------------------------------------------
  // Bare function: signature-only behavior fallback
  // -------------------------------------------------------------------------

  it("bare function without JSDoc: behavior is signature string", () => {
    const card = extract("function add(a: number, b: number): number { return a + b; }");
    expect(card.behavior).toBe("function add(a, b) -> number");
    expect(card.inputs).toHaveLength(2);
    expect(card.inputs[0]).toEqual({ name: "a", typeHint: "number", description: "" });
    expect(card.inputs[1]).toEqual({ name: "b", typeHint: "number", description: "" });
    expect(card.outputs).toHaveLength(1);
    expect(card.outputs[0]).toMatchObject({ name: "return", typeHint: "number" });
  });

  // -------------------------------------------------------------------------
  // Arrow-const + JSDoc — regression for VariableStatement gotcha
  // -------------------------------------------------------------------------

  it("arrow-const with JSDoc: JSDoc from VariableStatement is found (regression test)", () => {
    const source = `
/** Adds two numbers. @param a First. @param b Second. @returns The sum. */
const add = (a: number, b: number): number => a + b;
    `.trim();
    const card = extract(source);
    // JSDoc summary should be found (not fall back to signature)
    expect(card.behavior).toBe("Adds two numbers.");
    expect(card.inputs[0]?.description).toBe("First.");
    expect(card.inputs[1]?.description).toBe("Second.");
    expect(card.outputs[0]?.description).toBe("The sum.");
  });

  // -------------------------------------------------------------------------
  // Exported async function
  // -------------------------------------------------------------------------

  it("exported async function: behavior includes 'async'", () => {
    const source = `
/** Fetches data from a URL. */
export async function fetchData(url: string): Promise<string> { return ""; }
    `.trim();
    const card = extract(source);
    expect(card.behavior).toBe("Fetches data from a URL.");
    expect(card.inputs[0]?.typeHint).toBe("string");
    expect(card.outputs[0]?.typeHint).toBe("Promise<string>");
  });

  it("exported async function without JSDoc: signature includes 'async'", () => {
    const card = extract("export async function load(id: number): Promise<void> {}");
    expect(card.behavior).toContain("async");
    expect(card.behavior).toContain("load");
    expect(card.outputs[0]?.typeHint).toBe("Promise<void>");
  });

  // -------------------------------------------------------------------------
  // Generics
  // -------------------------------------------------------------------------

  it("generic function: type parameters preserved in return type", () => {
    const source = `
/** Identity function. */
function identity<T>(value: T): T { return value; }
    `.trim();
    const card = extract(source);
    expect(card.behavior).toBe("Identity function.");
    expect(card.inputs[0]?.typeHint).toBe("T");
    expect(card.outputs[0]?.typeHint).toBe("T");
  });

  // -------------------------------------------------------------------------
  // Destructured params
  // -------------------------------------------------------------------------

  it("destructured params: name is the binding pattern text", () => {
    const source = "function process({ x, y }: { x: number; y: number }): number { return x + y; }";
    const card = extract(source);
    expect(card.inputs).toHaveLength(1);
    expect(card.inputs[0]?.name).toMatch(/\{.*x.*y.*\}/);
  });

  // -------------------------------------------------------------------------
  // Rest params
  // -------------------------------------------------------------------------

  it("rest params: name is prefixed with '...'", () => {
    const source =
      "function sum(...nums: number[]): number { return nums.reduce((a, b) => a + b, 0); }";
    const card = extract(source);
    expect(card.inputs).toHaveLength(1);
    expect(card.inputs[0]?.name).toBe("...nums");
    expect(card.inputs[0]?.typeHint).toBe("number[]");
  });

  // -------------------------------------------------------------------------
  // No-JSDoc fallback
  // -------------------------------------------------------------------------

  it("no-JSDoc: behavior falls back to signature string", () => {
    const card = extract("export const id = (x: string): string => x;");
    // No JSDoc → signature string
    expect(card.behavior).toContain("id");
    expect(card.behavior).toContain("string");
    expect(card.behavior).not.toContain("\n");
  });

  // -------------------------------------------------------------------------
  // Void return
  // -------------------------------------------------------------------------

  it("void return type: outputs[0].typeHint is 'void'", () => {
    const card = extract("export function noop(): void {}");
    expect(card.outputs[0]?.typeHint).toBe("void");
  });

  it("no return annotation: outputs[0].typeHint is 'unknown'", () => {
    const card = extract("function implicit(x: string) { console.log(x); }");
    expect(card.outputs[0]?.typeHint).toBe("unknown");
  });

  // -------------------------------------------------------------------------
  // Multi-decl picker: export default wins
  // -------------------------------------------------------------------------

  it("multi-decl: export default wins over regular export", () => {
    const source = `
export function helper(): void {}
export default function main(): string { return "main"; }
    `.trim();
    const card = extract(source);
    // Should pick the default export
    expect(card.outputs[0]?.typeHint).toBe("string");
  });

  // -------------------------------------------------------------------------
  // No-declaration fragment
  // -------------------------------------------------------------------------

  it("no-declaration source: behavior is 'source fragment (...)' with no inputs/outputs", () => {
    const source = `1 + 2; "hello"; true;`;
    const card = extract(source);
    expect(card.behavior).toMatch(/^source fragment \(\d+ statements, \d+ bytes\)$/);
    expect(card.inputs).toHaveLength(0);
    expect(card.outputs).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Full JSDoc with all tag families
  // -------------------------------------------------------------------------

  it("full JSDoc: all tag families are extracted", () => {
    const source = `
/**
 * Divides numerator by denominator.
 * @param num The numerator value.
 * @param den The denominator value.
 * @returns The quotient.
 * @requires den !== 0
 * @ensures result * den === num
 * @throws Error if den is zero.
 * @remarks This is integer division.
 * @example divide(10, 2) // 5
 * @note Precision may vary on floats.
 */
export function divide(num: number, den: number): number { return num / den; }
    `.trim();
    const card = extract(source);
    expect(card.behavior).toBe("Divides numerator by denominator.");
    expect(card.inputs[0]).toMatchObject({ name: "num", description: "The numerator value." });
    expect(card.inputs[1]).toMatchObject({ name: "den", description: "The denominator value." });
    expect(card.outputs[0]).toMatchObject({ description: "The quotient." });
    expect(card.preconditions).toContain("den !== 0");
    expect(card.postconditions).toContain("result * den === num");
    expect(card.notes.some((n) => n.startsWith("throws:"))).toBe(true);
    expect(card.notes.some((n) => n.startsWith("remarks:"))).toBe(true);
    expect(card.notes.some((n) => n.startsWith("example:"))).toBe(true);
    expect(card.notes.some((n) => n === "Precision may vary on floats.")).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Multiline @requires
  // -------------------------------------------------------------------------

  it("multiline @requires: body is collapsed to single line", () => {
    const source = `
/**
 * Does something.
 * @requires x > 0
 *   and x < 100
 */
export function bounded(x: number): number { return x; }
    `.trim();
    const card = extract(source);
    // Precondition should be non-empty and single-line
    expect(card.preconditions.length).toBeGreaterThan(0);
    for (const p of card.preconditions) {
      expect(p).not.toMatch(/\n/);
      expect(p.length).toBeGreaterThan(0);
    }
  });

  // -------------------------------------------------------------------------
  // Malformed JSDoc: graceful degradation
  // -------------------------------------------------------------------------

  it("malformed JSDoc comment: still produces a valid card", () => {
    const source = `
/**
 * @@@@@  broken tags ###
 * @param   (no name)
 */
function weird(x: number) { return x; }
    `.trim();
    // Should not throw; should produce a valid card
    expect(() => extract(source)).not.toThrow();
    const card = extract(source);
    expect(card.schemaVersion).toBe(1);
  });

  // -------------------------------------------------------------------------
  // Envelope fields are passed through unchanged
  // -------------------------------------------------------------------------

  it("envelope fields are embedded in the card", () => {
    const card = extract("function f(): void {}");
    expect(card.modelVersion).toBe(ENVELOPE.modelVersion);
    expect(card.promptVersion).toBe(ENVELOPE.promptVersion);
    expect(card.sourceHash).toBe(ENVELOPE.sourceHash);
    expect(card.extractedAt).toBe(ENVELOPE.extractedAt);
  });

  // -------------------------------------------------------------------------
  // behavior constraints: no newlines, <=200 chars
  // -------------------------------------------------------------------------

  it("behavior never contains newlines", () => {
    const sources = [
      "function f(x: string): void {}",
      "export const g = (a: number, b: number): number => a + b;",
      "1 + 2;",
    ];
    for (const s of sources) {
      const card = extract(s);
      expect(card.behavior).not.toMatch(/[\n\r]/);
    }
  });

  it("behavior is at most 200 characters", () => {
    // A very long JSDoc description should be truncated
    const longDesc = "A ".repeat(120); // 240 chars
    const source = `/** ${longDesc}. */ export function f(): void {}`;
    const card = extract(source);
    expect(card.behavior.length).toBeLessThanOrEqual(200);
  });

  // -------------------------------------------------------------------------
  // DEC-INTENT-STATIC-BEHAVIOR-COLLAPSE-001: multi-line return-type annotations
  // must not produce newlines in the behavior field (issue #350, file 5)
  // -------------------------------------------------------------------------

  /**
   * Regression test for IntentCardSchemaError: field "behavior" must not
   * contain newline characters.
   *
   * Reproduces the exact failure from `packages/cli/src/commands/hooks-install.ts`
   * (file 5 in #350): functions without JSDoc that have a multi-line inline
   * return-type annotation (e.g. `function f(): {\n  settings: T;\n  flag: B\n}`)
   * fall back to buildSignatureString(), which calls extractReturnType() →
   * rtNode.getText() verbatim — carrying the literal `\n` from the source.
   *
   * The fix (DEC-INTENT-STATIC-BEHAVIOR-COLLAPSE-001): buildSignatureString()
   * now passes its output through collapseWhitespace() before returning, so
   * the signature string is guaranteed newline-free regardless of the return-
   * type annotation's formatting.
   *
   * Production sequence (compound interaction):
   * shave() → universalize() → extractIntent() → staticExtract() →
   * buildSignatureString() → collapseWhitespace() → validateIntentCard() passes.
   * Previously: buildSignatureString() returned a string with `\n` →
   * validateIntentCard() threw IntentCardSchemaError.
   */
  it("multi-line return-type annotation: behavior does not contain newlines (DEC-INTENT-STATIC-BEHAVIOR-COLLAPSE-001)", () => {
    // This is the exact shape from hooks-install.ts that caused #350 file 5:
    // a function with NO JSDoc and a multi-line inline return-type literal.
    const source = `
function applyInstall(settings: unknown): {
  settings: unknown;
  alreadyInstalled: boolean;
} {
  return { settings, alreadyInstalled: false };
}
`.trim();
    // Must not throw IntentCardSchemaError
    expect(() => extract(source)).not.toThrow();

    const card = extract(source);
    // The behavior field must not contain newlines
    expect(card.behavior).not.toMatch(/[\n\r]/);
    // The behavior should still contain the function name and type info
    expect(card.behavior).toContain("applyInstall");
    // Collapsed whitespace: multi-line type literal becomes single-line
    expect(card.behavior).toMatch(/\{[^}]+alreadyInstalled[^}]+\}/);
  });
});
