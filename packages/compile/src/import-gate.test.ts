/**
 * import-gate.test.ts -- Tests for compile-time import gate (WI-508 Slice 1).
 *
 * Tests the exported @yakcc/compile surface: assertNoUnexpandedImports(),
 * UnexpandedImportError, and GATE_INTERCEPT_ALLOWLIST.
 */

import { describe, expect, it } from "vitest";
import {
  GATE_INTERCEPT_ALLOWLIST,
  UnexpandedImportError,
  assertNoUnexpandedImports,
} from "./index.js";

describe("assertNoUnexpandedImports", () => {
  it("passes when source has no imports", () => {
    const src = "function add(a: number, b: number) { return a + b; }";
    expect(() => assertNoUnexpandedImports(src)).not.toThrow();
  });

  it("passes when source has only node: imports", () => {
    const src = `import { readFileSync } from "node:fs";\n`;
    expect(() => assertNoUnexpandedImports(src)).not.toThrow();
  });

  it("passes when source has only @yakcc/ imports", () => {
    const src = `import type { Registry } from "@yakcc/registry";\n`;
    expect(() => assertNoUnexpandedImports(src)).not.toThrow();
  });

  it("passes when source has off-allowlist foreign imports (zod, etc.)", () => {
    const src = `import zod from "zod";\nimport express from "express";\n`;
    expect(() => assertNoUnexpandedImports(src)).not.toThrow();
  });

  it("throws UnexpandedImportError when source has validator import", () => {
    const src = `import { isEmail } from "validator";\n`;
    expect(() => assertNoUnexpandedImports(src)).toThrow(UnexpandedImportError);
  });

  it("throws with correct moduleSpecifier", () => {
    const src = `import { isEmail } from "validator";\n`;
    let err: UnexpandedImportError | null = null;
    try {
      assertNoUnexpandedImports(src);
    } catch (e) {
      err = e as UnexpandedImportError;
    }
    expect(err).not.toBeNull();
    expect(err?.moduleSpecifier).toBe("validator");
    expect(err?.namedImports).toContain("isEmail");
  });

  it("throws with correct message", () => {
    const src = `import { isEmail } from "validator";\n`;
    expect(() => assertNoUnexpandedImports(src)).toThrow("Unexpanded covered import");
  });

  it("skips type-only validator imports (no throw)", () => {
    const src = `import type { IsEmail } from "validator";\n`;
    expect(() => assertNoUnexpandedImports(src)).not.toThrow();
  });

  it("no-op when disabled=true", () => {
    const src = `import { isEmail } from "validator";\n`;
    expect(() => assertNoUnexpandedImports(src, { disabled: true })).not.toThrow();
  });

  it("passes when source has only relative imports", () => {
    const src = `import { helper } from "./local";\n`;
    expect(() => assertNoUnexpandedImports(src)).not.toThrow();
  });

  it("passes when source is empty", () => {
    expect(() => assertNoUnexpandedImports("")).not.toThrow();
  });
});

describe("UnexpandedImportError", () => {
  it("has name UnexpandedImportError", () => {
    const err = new UnexpandedImportError("validator", ["isEmail"]);
    expect(err.name).toBe("UnexpandedImportError");
  });

  it("is an instance of Error", () => {
    const err = new UnexpandedImportError("validator", ["isEmail"]);
    expect(err).toBeInstanceOf(Error);
  });

  it("carries moduleSpecifier and namedImports", () => {
    const err = new UnexpandedImportError("validator", ["isEmail", "isURL"]);
    expect(err.moduleSpecifier).toBe("validator");
    expect(err.namedImports).toEqual(["isEmail", "isURL"]);
  });

  it("message includes module specifier", () => {
    const err = new UnexpandedImportError("validator", []);
    expect(err.message).toContain("validator");
  });

  it("message includes named imports when present", () => {
    const err = new UnexpandedImportError("validator", ["isEmail"]);
    expect(err.message).toContain("isEmail");
  });
  it("mixed type/value import: namedImports only includes value binding (not type-only specifier)", () => {
    // Regression: before the isTypeOnly() filter fix, "T" would appear in namedImports.
    // After the fix, only "isEmail" (a value binding) is captured.
    // DEC-WI508-INTERCEPT-CLASSIFIER-SHARED-001: mirrors the filter in import-intercept.ts.
    const src = `import { type T, isEmail } from "validator";
`;
    let err: UnexpandedImportError | null = null;
    try {
      assertNoUnexpandedImports(src);
    } catch (e) {
      err = e as UnexpandedImportError;
    }
    expect(err).not.toBeNull();
    expect(err?.moduleSpecifier).toBe("validator");
    // "T" is a type-only specifier -- must NOT appear in namedImports
    expect(err?.namedImports).not.toContain("T");
    // "isEmail" is a value binding -- must appear in namedImports
    expect(err?.namedImports).toContain("isEmail");
    expect(err?.namedImports).toEqual(["isEmail"]);
  });
});

describe("GATE_INTERCEPT_ALLOWLIST", () => {
  it("contains validator", () => {
    expect(GATE_INTERCEPT_ALLOWLIST.has("validator")).toBe(true);
  });

  it("does not contain zod", () => {
    expect(GATE_INTERCEPT_ALLOWLIST.has("zod")).toBe(false);
  });
});
