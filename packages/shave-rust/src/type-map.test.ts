// SPDX-License-Identifier: Apache-2.0
//
// type-map.test.ts -- unit tests for the Rust -> TS type mapping table (WI-868 slice 1).

import { describe, expect, it } from "vitest";
import { UnsupportedTypeError, mapRustType } from "./type-map.js";

describe("mapRustType", () => {
  describe("integer primitives", () => {
    it.each([
      ["i8", "number"],
      ["i16", "number"],
      ["i32", "number"],
      ["i64", "number"],
      ["i128", "number"],
      ["isize", "number"],
      ["u8", "number"],
      ["u16", "number"],
      ["u32", "number"],
      ["u64", "number"],
      ["u128", "number"],
      ["usize", "number"],
    ])("maps %s -> %s", (input, expected) => {
      expect(mapRustType(input)).toBe(expected);
    });
  });

  describe("float primitives", () => {
    it.each([
      ["f32", "number"],
      ["f64", "number"],
    ])("maps %s -> %s", (input, expected) => {
      expect(mapRustType(input)).toBe(expected);
    });
  });

  describe("bool", () => {
    it("maps bool -> boolean", () => {
      expect(mapRustType("bool")).toBe("boolean");
    });
  });

  describe("string types", () => {
    it("maps str -> string", () => {
      expect(mapRustType("str")).toBe("string");
    });
    it("maps String -> string", () => {
      expect(mapRustType("String")).toBe("string");
    });
    it("maps char -> string", () => {
      expect(mapRustType("char")).toBe("string");
    });
  });

  describe("unit type", () => {
    it("maps () -> void", () => {
      expect(mapRustType("()")).toBe("void");
    });
  });

  describe("references", () => {
    it("maps &str -> string (strips & and maps inner)", () => {
      expect(mapRustType("&str")).toBe("string");
    });
    it("maps &'a str -> string (strips lifetime)", () => {
      expect(mapRustType("&'a str")).toBe("string");
    });
    it("maps &i32 -> number", () => {
      expect(mapRustType("&i32")).toBe("number");
    });
    it("maps &mut i32 -> number", () => {
      expect(mapRustType("&mut i32")).toBe("number");
    });
  });

  describe("Vec<T>", () => {
    it("maps Vec<i32> -> number[]", () => {
      expect(mapRustType("Vec<i32>")).toBe("number[]");
    });
    it("maps Vec<String> -> string[]", () => {
      expect(mapRustType("Vec<String>")).toBe("string[]");
    });
    it("maps Vec<bool> -> boolean[]", () => {
      expect(mapRustType("Vec<bool>")).toBe("boolean[]");
    });
  });

  describe("Option<T>", () => {
    it("maps Option<i32> -> number | null", () => {
      expect(mapRustType("Option<i32>")).toBe("number | null");
    });
    it("maps Option<String> -> string | null", () => {
      expect(mapRustType("Option<String>")).toBe("string | null");
    });
    it("maps Option<Vec<i32>> -> number[] | null (nested)", () => {
      expect(mapRustType("Option<Vec<i32>>")).toBe("number[] | null");
    });
  });

  describe("Result<T, E>", () => {
    it("maps Result<i32, String> -> number (T only, slice 1)", () => {
      expect(mapRustType("Result<i32, String>")).toBe("number");
    });
    it("maps Result<String, String> -> string", () => {
      expect(mapRustType("Result<String, String>")).toBe("string");
    });
  });

  describe("smart pointers", () => {
    it("maps Box<i32> -> number", () => {
      expect(mapRustType("Box<i32>")).toBe("number");
    });
    it("maps Rc<String> -> string", () => {
      expect(mapRustType("Rc<String>")).toBe("string");
    });
    it("maps Arc<bool> -> boolean", () => {
      expect(mapRustType("Arc<bool>")).toBe("boolean");
    });
  });

  describe("slice references", () => {
    it("maps &[i32] -> number[]", () => {
      expect(mapRustType("&[i32]")).toBe("number[]");
    });
    it("maps &'a [u8] -> number[]", () => {
      expect(mapRustType("&'a [u8]")).toBe("number[]");
    });
  });

  describe("tuple types", () => {
    it("maps (i32, bool) -> [number, boolean]", () => {
      expect(mapRustType("(i32, bool)")).toBe("[number, boolean]");
    });
    it("maps (String, i32, bool) -> [string, number, boolean]", () => {
      expect(mapRustType("(String, i32, bool)")).toBe("[string, number, boolean]");
    });
  });

  describe("whitespace tolerance", () => {
    it("trims leading/trailing whitespace", () => {
      expect(mapRustType("  i32  ")).toBe("number");
    });
  });

  describe("UnsupportedTypeError", () => {
    it("throws for unknown types", () => {
      expect(() => mapRustType("HashMap<String, i32>")).toThrow(UnsupportedTypeError);
    });
    it("throws for empty string", () => {
      expect(() => mapRustType("")).toThrow(UnsupportedTypeError);
    });
    it("throws for complex unsupported composite types", () => {
      expect(() => mapRustType("dyn Fn(i32) -> bool")).toThrow(UnsupportedTypeError);
    });
    it("has the rustType property on the thrown error", () => {
      try {
        mapRustType("UnknownType");
      } catch (err) {
        expect(err).toBeInstanceOf(UnsupportedTypeError);
        expect((err as UnsupportedTypeError).rustType).toBe("UnknownType");
      }
    });
  });
});
