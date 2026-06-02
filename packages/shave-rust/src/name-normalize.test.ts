// SPDX-License-Identifier: Apache-2.0
//
// name-normalize.test.ts -- unit tests for Rust snake_case -> camelCase normalization (WI-868 slice 1).

import { describe, expect, it } from "vitest";
import { InvalidIdentifierError, isPublic, normalizeRustName } from "./name-normalize.js";

describe("normalizeRustName", () => {
  describe("simple snake_case -> camelCase", () => {
    it("single word: no change", () => {
      expect(normalizeRustName("add")).toBe("add");
    });
    it("two words: second word capitalized", () => {
      expect(normalizeRustName("add_numbers")).toBe("addNumbers");
    });
    it("three words", () => {
      expect(normalizeRustName("get_user_id")).toBe("getUserId");
    });
    it("four words", () => {
      expect(normalizeRustName("compute_max_list_length")).toBe("computeMaxListLength");
    });
  });

  describe("leading underscore preservation", () => {
    it("preserves single leading underscore", () => {
      expect(normalizeRustName("_private")).toBe("_private");
    });
    it("preserves leading underscore with subsequent snake_case", () => {
      expect(normalizeRustName("_internal_helper")).toBe("_internalHelper");
    });
  });

  describe("trailing underscore stripping", () => {
    it("strips trailing underscore (reserved word escape)", () => {
      expect(normalizeRustName("type_")).toBe("type");
    });
    it("strips trailing underscore from compound name", () => {
      expect(normalizeRustName("loop_")).toBe("loop");
    });
  });

  describe("ALL_CAPS -> camelCase", () => {
    it("ALL_CAPS constant name", () => {
      expect(normalizeRustName("MAX_VALUE")).toBe("maxValue");
    });
    it("two-word ALL_CAPS", () => {
      expect(normalizeRustName("HTTP_CLIENT")).toBe("httpClient");
    });
    it("single ALL_CAPS word", () => {
      expect(normalizeRustName("MAX")).toBe("MAX"); // PascalCase: no underscores -> preserved
    });
  });

  describe("PascalCase preservation (type names / struct names)", () => {
    it("PascalCase with no underscores is preserved", () => {
      expect(normalizeRustName("MyStruct")).toBe("MyStruct");
    });
    it("single uppercase word preserved", () => {
      expect(normalizeRustName("Add")).toBe("Add");
    });
  });

  describe("already-camelCase names", () => {
    it("returns as-is when no underscores (first char lowercase)", () => {
      // Not PascalCase, not snake_case — passthrough via snake_case with 1 segment
      expect(normalizeRustName("add")).toBe("add");
    });
  });

  describe("error cases", () => {
    it("throws InvalidIdentifierError for empty string", () => {
      expect(() => normalizeRustName("")).toThrow(InvalidIdentifierError);
    });
    it("throws for names with hyphens", () => {
      expect(() => normalizeRustName("foo-bar")).toThrow(InvalidIdentifierError);
    });
    it("throws for names starting with a digit", () => {
      expect(() => normalizeRustName("1foo")).toThrow(InvalidIdentifierError);
    });
    it("error has identifier property", () => {
      try {
        normalizeRustName("");
      } catch (err) {
        expect(err).toBeInstanceOf(InvalidIdentifierError);
        expect((err as InvalidIdentifierError).identifier).toBe("");
      }
    });
  });
});

describe("isPublic", () => {
  it("returns true for pub functions", () => {
    expect(isPublic(true)).toBe(true);
  });
  it("returns false for non-pub functions", () => {
    expect(isPublic(false)).toBe(false);
  });
});
