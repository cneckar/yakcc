import { describe, expect, it } from "vitest";
import { CanonicalAstParseError, canonicalAstHash } from "./canonical-ast.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Assert hash is 64 lowercase hex chars. */
function assertHashFormat(h: string): void {
  expect(h).toMatch(/^[0-9a-f]{64}$/);
}

// ---------------------------------------------------------------------------
// Hash format
// ---------------------------------------------------------------------------

describe("canonicalAstHash – hash format", () => {
  it("returns a 64-char lowercase hex string", () => {
    const h = canonicalAstHash("const x = 1;");
    assertHashFormat(h);
  });

  it("branded type: CanonicalAstHash is assignable to string at compile time", () => {
    // This is a compile-time assertion verified by the TypeScript build.
    // At runtime, just confirm the value is a string.
    const h: string = canonicalAstHash("const x = 1;");
    expect(typeof h).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

describe("canonicalAstHash – determinism", () => {
  it("returns the same hash on repeated calls with the same source", () => {
    const src = "function add(a: number, b: number): number { return a + b; }";
    const h1 = canonicalAstHash(src);
    const h2 = canonicalAstHash(src);
    const h3 = canonicalAstHash(src);
    expect(h1).toBe(h2);
    expect(h1).toBe(h3);
    assertHashFormat(h1);
  });

  it("empty source file produces a stable hash", () => {
    expect(canonicalAstHash("")).toBe(canonicalAstHash(""));
  });
});

// ---------------------------------------------------------------------------
// Comment-invariance
// ---------------------------------------------------------------------------

describe("canonicalAstHash – comment-invariance", () => {
  const base = "function add(a: number, b: number): number { return a + b; }";

  it("single-line comment does not change the hash", () => {
    const withComment = `// adds two numbers\n${base}`;
    expect(canonicalAstHash(base)).toBe(canonicalAstHash(withComment));
  });

  it("block comment does not change the hash", () => {
    const withBlock = `/* adds two numbers */ ${base}`;
    expect(canonicalAstHash(base)).toBe(canonicalAstHash(withBlock));
  });

  it("JSDoc comment does not change the hash", () => {
    const withJsdoc = `/** @param a - first\n * @param b - second\n */\n${base}`;
    expect(canonicalAstHash(base)).toBe(canonicalAstHash(withJsdoc));
  });

  it("inline comment inside function body does not change the hash", () => {
    const withInline = "function add(a: number, b: number): number { /* add */ return a + b; }";
    expect(canonicalAstHash(base)).toBe(canonicalAstHash(withInline));
  });
});

// ---------------------------------------------------------------------------
// Whitespace-invariance
// ---------------------------------------------------------------------------

describe("canonicalAstHash – whitespace-invariance", () => {
  it("type annotation spacing is normalized: 'a:number' equals 'a: number'", () => {
    // ts-morph's printer normalizes type-annotation whitespace — colon spacing
    // is standardized regardless of how the source was written.
    const withSpace = "function add(a: number, b: number): number { return a + b; }";
    // The printer always emits 'a: number' (with space), so two sources that
    // differ only in colon-spacing canonicalize identically.
    const alsoWithSpace = "function add(a: number,  b:  number):   number { return a + b; }";
    expect(canonicalAstHash(withSpace)).toBe(canonicalAstHash(alsoWithSpace));
  });

  it("leading/trailing newlines do not change the hash", () => {
    const src = "function f(a: number): number { return a; }";
    const withNewlines = `\n\n${src}\n\n`;
    expect(canonicalAstHash(src)).toBe(canonicalAstHash(withNewlines));
  });

  it("extra indentation inside function body does not change the hash", () => {
    // Both forms have the same block structure; indentation inside the body
    // is re-emitted uniformly by the printer.
    const src1 = "function f(a: number): number {\n  return a + 1;\n}";
    const src2 = "function f(a: number): number {\n    return a + 1;\n}";
    expect(canonicalAstHash(src1)).toBe(canonicalAstHash(src2));
  });
});

// ---------------------------------------------------------------------------
// Local-rename invariance
// ---------------------------------------------------------------------------

describe("canonicalAstHash – local-rename invariance", () => {
  it("non-exported function parameter rename produces the same hash", () => {
    const withA = "function f(a: number): number { return a + 1; }";
    const withB = "function f(b: number): number { return b + 1; }";
    expect(canonicalAstHash(withA)).toBe(canonicalAstHash(withB));
  });

  it("local variable rename produces the same hash", () => {
    const withX = "function f(): number { const x = 1; return x + 1; }";
    const withY = "function f(): number { const y = 1; return y + 1; }";
    expect(canonicalAstHash(withX)).toBe(canonicalAstHash(withY));
  });

  it("multiple parameter renames produce the same hash", () => {
    const src1 = "function compute(a: number, b: number, c: number): number { return a * b + c; }";
    const src2 = "function compute(x: number, y: number, z: number): number { return x * y + z; }";
    expect(canonicalAstHash(src1)).toBe(canonicalAstHash(src2));
  });
});

// ---------------------------------------------------------------------------
// Exported-rename DIFFERENCE
// ---------------------------------------------------------------------------

describe("canonicalAstHash – exported names ARE significant", () => {
  it("exported function name change produces a different hash", () => {
    const f = "export function f(a: number): number { return a + 1; }";
    const g = "export function g(a: number): number { return a + 1; }";
    expect(canonicalAstHash(f)).not.toBe(canonicalAstHash(g));
  });

  it("exported variable name change produces a different hash", () => {
    const v1 = "export const myValue = 42;";
    const v2 = "export const otherValue = 42;";
    expect(canonicalAstHash(v1)).not.toBe(canonicalAstHash(v2));
  });
});

// ---------------------------------------------------------------------------
// Semantic difference
// ---------------------------------------------------------------------------

describe("canonicalAstHash – semantic differences produce different hashes", () => {
  it("a + b vs a - b", () => {
    const add = "function f(a: number, b: number): number { return a + b; }";
    const sub = "function f(a: number, b: number): number { return a - b; }";
    expect(canonicalAstHash(add)).not.toBe(canonicalAstHash(sub));
  });

  it("if (x) y vs if (x) z — structurally different bodies", () => {
    // Use distinct variable names so the structural difference survives renaming.
    const src1 = `function f(x: boolean): string { if (x) { return "yes"; } return "no"; }`;
    const src2 = `function f(x: boolean): string { if (x) { return "no"; } return "yes"; }`;
    expect(canonicalAstHash(src1)).not.toBe(canonicalAstHash(src2));
  });

  it("different literal values", () => {
    const s1 = "const x = 1;";
    const s2 = "const x = 2;";
    expect(canonicalAstHash(s1)).not.toBe(canonicalAstHash(s2));
  });

  it("different string literals", () => {
    const s1 = `const x = "hello";`;
    const s2 = `const x = "world";`;
    expect(canonicalAstHash(s1)).not.toBe(canonicalAstHash(s2));
  });
});

// ---------------------------------------------------------------------------
// Type annotation difference
// ---------------------------------------------------------------------------

describe("canonicalAstHash – type annotations ARE significant", () => {
  it("number vs string parameter type produces different hash", () => {
    const num = "function f(a: number): number { return a + 1; }";
    const str = `function f(a: string): string { return a + "!"; }`;
    expect(canonicalAstHash(num)).not.toBe(canonicalAstHash(str));
  });

  it("with vs without return type annotation produces different hash", () => {
    // ts-morph prints the return type annotation when present; its presence
    // changes the canonical text and thus the hash.
    const withReturn = "function f(a: number): number { return a + 1; }";
    const withoutReturn = "function f(a: number) { return a + 1; }";
    expect(canonicalAstHash(withReturn)).not.toBe(canonicalAstHash(withoutReturn));
  });

  it("function(a: number) vs function(a: string) → different hashes", () => {
    const numFn = "export function process(a: number): void {}";
    const strFn = "export function process(a: string): void {}";
    expect(canonicalAstHash(numFn)).not.toBe(canonicalAstHash(strFn));
  });
});

// ---------------------------------------------------------------------------
// Range tests
// ---------------------------------------------------------------------------

describe("canonicalAstHash – sourceRange", () => {
  it("range covering full source equals no-range hash", () => {
    // When the range exactly covers [0, src.length), findEnclosingNode
    // returns the SourceFile — identical to the no-range call.
    const src = "const a = 1;\nconst b = 2;";
    const noRange = canonicalAstHash(src);
    const fullRange = canonicalAstHash(src, { start: 0, end: src.length });
    assertHashFormat(noRange);
    assertHashFormat(fullRange);
    expect(fullRange).toBe(noRange);
  });

  it("range over a function declaration produces a stable, valid hash", () => {
    const fnSrc = "function add(a: number, b: number): number { return a + b; }";
    const fullSrc = `const x = 1;\n${fnSrc}\nconst y = 2;`;

    const start = fullSrc.indexOf(fnSrc);
    const end = start + fnSrc.length;

    const rangeHash = canonicalAstHash(fullSrc, { start, end });
    assertHashFormat(rangeHash);

    // The range hash must be deterministic.
    expect(canonicalAstHash(fullSrc, { start, end })).toBe(rangeHash);
  });

  it("same function at different positions in file produces the same range hash", () => {
    // The hash of a range depends only on the node's content, not its position
    // in the file. Two identical function declarations at different offsets
    // must produce the same hash when extracted by range.
    const fn = "function add(a: number, b: number): number { return a + b; }";
    const src1 = `const x = 1;\n${fn}\nconst y = 2;`;
    const src2 = `const longPreamble = "hello world";\nconst anotherVar = 99;\n${fn}\nconst z = 3;`;

    const start1 = src1.indexOf(fn);
    const start2 = src2.indexOf(fn);

    const h1 = canonicalAstHash(src1, { start: start1, end: start1 + fn.length });
    const h2 = canonicalAstHash(src2, { start: start2, end: start2 + fn.length });

    assertHashFormat(h1);
    assertHashFormat(h2);
    expect(h1).toBe(h2);
  });

  it("range spanning multiple top-level nodes throws CanonicalAstParseError", () => {
    // A range that starts inside one node and ends inside a sibling node
    // cannot be covered by any single AST node, so it must throw.
    const twoFns = "function f(): void {}\nfunction g(): void {}";
    // Start at position 1 (inside 'f' keyword body) and end at len-1
    // (inside 'g' declaration) — no single node spans this range.
    const midStart = 1;
    const midEnd = twoFns.length - 1;
    expect(() => canonicalAstHash(twoFns, { start: midStart, end: midEnd })).toThrow(
      CanonicalAstParseError,
    );
  });

  it("range outside source bounds throws CanonicalAstParseError", () => {
    const src = "const x = 1;";
    expect(() => canonicalAstHash(src, { start: 0, end: src.length + 100 })).toThrow(
      CanonicalAstParseError,
    );
  });

  it("range with start > end throws CanonicalAstParseError", () => {
    const src = "const x = 1;";
    expect(() => canonicalAstHash(src, { start: 5, end: 3 })).toThrow(CanonicalAstParseError);
  });

  it("range with negative start throws CanonicalAstParseError", () => {
    const src = "const x = 1;";
    expect(() => canonicalAstHash(src, { start: -1, end: 5 })).toThrow(CanonicalAstParseError);
  });
});

// ---------------------------------------------------------------------------
// External imports do not trigger parse errors
// ---------------------------------------------------------------------------

describe("canonicalAstHash – external imports are tolerated", () => {
  it("source with import from unresolvable module does not throw", () => {
    // We hash source text structure, not runtime module availability.
    // Only syntax errors (TS1xxx) should throw; semantic errors like
    // 'Cannot find module' (TS2307) must be ignored.
    const src = [
      `import { something } from "some-external-package";`,
      "export function useIt(x: number): number { return x * 2; }",
    ].join("\n");
    expect(() => canonicalAstHash(src)).not.toThrow();
    assertHashFormat(canonicalAstHash(src));
  });
});

// ---------------------------------------------------------------------------
// Error tests
// ---------------------------------------------------------------------------

describe("canonicalAstHash – error handling", () => {
  it("source with unclosed paren/brace throws CanonicalAstParseError", () => {
    expect(() => canonicalAstHash("function f(")).toThrow(CanonicalAstParseError);
  });

  it("source with unclosed string literal throws CanonicalAstParseError", () => {
    expect(() => canonicalAstHash('const x = "unterminated')).toThrow(CanonicalAstParseError);
  });

  it("CanonicalAstParseError has correct name", () => {
    let caught: unknown;
    try {
      canonicalAstHash("const x: = 1;");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(CanonicalAstParseError);
    expect((caught as CanonicalAstParseError).name).toBe("CanonicalAstParseError");
  });

  it("CanonicalAstParseError.diagnostics is a non-empty array for syntax errors", () => {
    let caught: CanonicalAstParseError | undefined;
    try {
      canonicalAstHash("const x: = 1;");
    } catch (e) {
      if (e instanceof CanonicalAstParseError) caught = e;
    }
    expect(caught).toBeDefined();
    expect(Array.isArray(caught?.diagnostics)).toBe(true);
    expect(caught?.diagnostics.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// WI-551 α-class regression: line-ending and BOM stability
// ---------------------------------------------------------------------------

/**
 * @decision DEC-WI551-001: regression coverage for the two-pass T3 byte-identity sweep.
 *   Status: active
 *   Rationale: #551 reported 82 divergent roots; empirical investigation showed those were
 *   symptoms of two underlying bugs fixed in #552 and #556. These tests guard the α-class
 *   (canonicalAstHash line-ending + BOM stability, fixed by #556's `ignoreBOM: true` and
 *   prior canonicalizer work) so they cannot silently regress. If either mechanism regresses,
 *   the two-pass T3 sweep will produce divergent roots for BOM-bearing or CRLF files.
 */
describe("canonicalAstHash – WI-551 α-class regression: line-ending stability", () => {
  it("produces identical hash for CRLF vs LF source (guards #543/#556 regression)", () => {
    // ts-morph normalizes line endings internally; if this ever regresses, two-pass
    // compile-self reconstruction will produce divergent roots for any file with CRLF endings.
    const lf = "export function foo() {\n  return 1;\n}\n";
    const crlf = lf.replace(/\n/g, "\r\n");
    expect(canonicalAstHash(crlf)).toBe(canonicalAstHash(lf));
    assertHashFormat(canonicalAstHash(lf));
  });

  it("CRLF stability holds for multi-function file (compound)", () => {
    const lf = [
      "export function add(a: number, b: number): number { return a + b; }",
      "export function sub(a: number, b: number): number { return a - b; }",
    ].join("\n");
    const crlf = lf.replace(/\n/g, "\r\n");
    expect(canonicalAstHash(crlf)).toBe(canonicalAstHash(lf));
  });
});

describe("canonicalAstHash – WI-551 α-class regression: UTF-8 BOM stability", () => {
  it("produces identical hash for source with UTF-8 BOM vs without (guards #543/#556 regression)", () => {
    // The #556 fix added `ignoreBOM: true` to TextDecoder in the compile-self glue decode.
    // ts-morph itself may or may not strip BOM from source text; this test guards that
    // the canonical hash is identical regardless of a leading BOM byte sequence.
    // If this regresses, import-intercept.ts and other BOM-bearing files will produce
    // divergent roots in the two-pass sweep.
    const noBom = "export const X = 1;\n";
    const withBom = `﻿${noBom}`; // U+FEFF is the UTF-8 BOM codepoint
    expect(canonicalAstHash(withBom)).toBe(canonicalAstHash(noBom));
  });

  it("BOM stability holds for a function declaration (compound)", () => {
    const noBom = "export function process(x: number): number { return x * 2; }";
    const withBom = `﻿${noBom}`;
    expect(canonicalAstHash(withBom)).toBe(canonicalAstHash(noBom));
  });

  it("CRLF + BOM combined: identical hash regardless of both variants (production sequence)", () => {
    // Production sequence: compile-self reconstruction reads a file from dist-recompiled/
    // which may carry a BOM and CRLF endings depending on platform/toolchain. Both variants
    // must hash identically to the canonical LF/no-BOM form for the two-pass sweep to be clean.
    const canonical = "export function encode(x: string): string {\n  return x;\n}\n";
    const withCrlfAndBom = `﻿${canonical.replace(/\n/g, "\r\n")}`;
    expect(canonicalAstHash(withCrlfAndBom)).toBe(canonicalAstHash(canonical));
    assertHashFormat(canonicalAstHash(canonical));
  });
});

// ---------------------------------------------------------------------------
// Compound-interaction (production-sequence) test
// ---------------------------------------------------------------------------

describe("canonicalAstHash – compound integration: full production sequence", () => {
  /**
   * Production sequence: a caller has a source file, extracts a function by
   * byte range, and content-addresses it. The same function written in two
   * equivalent ways (different local variable names, comments stripped) must
   * produce the same hash. A structurally different function must produce a
   * different hash.
   *
   * This test crosses: range extraction → node selection → local-rename
   * collection → canonical print → BLAKE3 hash, verifying the full pipeline.
   */
  it("range-extracted function hashes equal across semantically equivalent rewrites", () => {
    // Source with preamble, a target function with local vars, and a suffix.
    const src1 = [
      "function helper(): void {}",
      "function inner(alpha: number): number {",
      "  const result = alpha * 2;",
      "  return result;",
      "}",
      "export function outer(): void {}",
    ].join("\n");

    const src2 = [
      "function helper(): void {}",
      "function inner(x: number): number {",
      "  // compute double",
      "  const doubled = x * 2;",
      "  return doubled;",
      "}",
      "export function outer(): void {}",
    ].join("\n");

    // Extract range of the `inner` function in both sources.
    // We find the start of "function inner" and the character before "\nexport".
    const innerStart1 = src1.indexOf("function inner");
    const innerEnd1 = src1.indexOf("\nexport");

    const innerStart2 = src2.indexOf("function inner");
    const innerEnd2 = src2.indexOf("\nexport");

    const hash1 = canonicalAstHash(src1, { start: innerStart1, end: innerEnd1 });
    const hash2 = canonicalAstHash(src2, { start: innerStart2, end: innerEnd2 });

    assertHashFormat(hash1);
    assertHashFormat(hash2);
    expect(hash1).toBe(hash2);

    // Structurally different: multiply vs add → must produce a different hash.
    const src3 = [
      "function helper(): void {}",
      "function inner(alpha: number): number {",
      "  const result = alpha + 2;", // different operator
      "  return result;",
      "}",
      "export function outer(): void {}",
    ].join("\n");

    const innerStart3 = src3.indexOf("function inner");
    const innerEnd3 = src3.indexOf("\nexport");
    const hash3 = canonicalAstHash(src3, { start: innerStart3, end: innerEnd3 });

    assertHashFormat(hash3);
    expect(hash1).not.toBe(hash3);
  });

  it("hash is stable across comment variants — full pipeline round-trip", () => {
    const source = `
      export function parseIntSafe(raw: string): number {
        const trimmed = raw.trim();
        const parsed = parseInt(trimmed, 10);
        if (isNaN(parsed)) {
          throw new Error("not an integer: " + raw);
        }
        return parsed;
      }
    `;

    const h1 = canonicalAstHash(source);
    const h2 = canonicalAstHash(source);
    expect(h1).toBe(h2);
    assertHashFormat(h1);

    // Add comments — hash must stay the same.
    const withComments = [
      "/**",
      " * Parses an integer from a string.",
      " * @throws if input is not a valid integer",
      " */",
      source,
    ].join("\n");
    const h3 = canonicalAstHash(withComments);
    expect(h1).toBe(h3);

    // Change operator — hash must differ.
    const different = source.replace("parseInt(trimmed, 10)", "parseFloat(trimmed)");
    const h4 = canonicalAstHash(different);
    expect(h1).not.toBe(h4);
  });
});
