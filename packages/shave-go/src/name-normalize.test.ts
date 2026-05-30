// SPDX-License-Identifier: MIT
//
// Tests for Go identifier normalization (WI-870 slice 1).

import { describe, expect, it } from "vitest";
import { InvalidIdentifierError, isExported, normalizeGoName } from "./name-normalize.js";

describe("normalizeGoName", () => {
  it("preserves exported PascalCase names unchanged", () => {
    expect(normalizeGoName("Add")).toBe("Add");
    expect(normalizeGoName("ParseFnSignature")).toBe("ParseFnSignature");
    expect(normalizeGoName("HTTPClient")).toBe("HTTPClient");
    expect(normalizeGoName("NewMyStruct")).toBe("NewMyStruct");
  });

  it("preserves unexported camelCase names unchanged", () => {
    expect(normalizeGoName("add")).toBe("add");
    expect(normalizeGoName("parseFnSignature")).toBe("parseFnSignature");
    expect(normalizeGoName("internalHelper")).toBe("internalHelper");
  });

  it("preserves underscore-prefixed names (unexported Go convention)", () => {
    expect(normalizeGoName("_internal")).toBe("_internal");
  });

  it("preserves single-character names", () => {
    expect(normalizeGoName("x")).toBe("x");
    expect(normalizeGoName("X")).toBe("X");
  });

  it("throws InvalidIdentifierError for empty string", () => {
    expect(() => normalizeGoName("")).toThrow(InvalidIdentifierError);
    expect(() => normalizeGoName("")).toThrow(/must not be empty/);
  });

  it("throws for names with spaces", () => {
    expect(() => normalizeGoName("my func")).toThrow(InvalidIdentifierError);
  });

  it("throws for names with hyphens", () => {
    expect(() => normalizeGoName("my-func")).toThrow(InvalidIdentifierError);
  });

  it("throws for names starting with a digit", () => {
    expect(() => normalizeGoName("1func")).toThrow(InvalidIdentifierError);
  });
});

describe("isExported", () => {
  it("returns true for uppercase-starting names", () => {
    expect(isExported("Add")).toBe(true);
    expect(isExported("HTTPClient")).toBe(true);
    expect(isExported("X")).toBe(true);
  });

  it("returns false for lowercase-starting names", () => {
    expect(isExported("add")).toBe(false);
    expect(isExported("internalHelper")).toBe(false);
  });

  it("returns false for underscore-prefixed names", () => {
    expect(isExported("_internal")).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(isExported("")).toBe(false);
  });
});
