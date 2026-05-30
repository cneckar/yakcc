// SPDX-License-Identifier: MIT
//
// Tests for the Go -> TS type mapper (WI-870 slice 1).

import { describe, expect, it } from "vitest";
import { UnsupportedTypeError, mapGoType } from "./type-map.js";

describe("mapGoType -- primitives", () => {
  it.each([
    ["int", "number"],
    ["int8", "number"],
    ["int16", "number"],
    ["int32", "number"],
    ["int64", "number"],
    ["uint", "number"],
    ["uint8", "number"],
    ["byte", "number"],
    ["uint16", "number"],
    ["uint32", "number"],
    ["uint64", "number"],
    ["uintptr", "number"],
    ["float32", "number"],
    ["float64", "number"],
    ["rune", "number"],
    ["string", "string"],
    ["bool", "boolean"],
    ["error", "Error"],
    ["any", "unknown"],
    ["interface{}", "unknown"],
  ])("maps %s -> %s", (goType, expected) => {
    expect(mapGoType(goType)).toBe(expected);
  });

  it("trims whitespace around the type string", () => {
    expect(mapGoType("  int  ")).toBe("number");
    expect(mapGoType(" string ")).toBe("string");
  });
});

describe("mapGoType -- composite types", () => {
  it("maps []int -> number[]", () => {
    expect(mapGoType("[]int")).toBe("number[]");
  });

  it("maps []string -> string[]", () => {
    expect(mapGoType("[]string")).toBe("string[]");
  });

  it("maps [][]bool -> boolean[][]", () => {
    expect(mapGoType("[][]bool")).toBe("boolean[][]");
  });

  it("maps [][]string -> string[][]", () => {
    expect(mapGoType("[][]string")).toBe("string[][]");
  });

  it("maps *int -> number (pointer flattened)", () => {
    expect(mapGoType("*int")).toBe("number");
  });

  it("maps *string -> string", () => {
    expect(mapGoType("*string")).toBe("string");
  });

  it("maps map[string]int -> Record<string, number>", () => {
    expect(mapGoType("map[string]int")).toBe("Record<string, number>");
  });

  it("maps map[string]string -> Record<string, string>", () => {
    expect(mapGoType("map[string]string")).toBe("Record<string, string>");
  });

  it("maps map[string][]int -> Record<string, number[]>", () => {
    expect(mapGoType("map[string][]int")).toBe("Record<string, number[]>");
  });

  it("maps *[]string -> string[] (pointer to slice)", () => {
    expect(mapGoType("*[]string")).toBe("string[]");
  });
});

describe("mapGoType -- rejection cases", () => {
  it("throws UnsupportedTypeError for empty string", () => {
    expect(() => mapGoType("")).toThrow(UnsupportedTypeError);
  });

  it("throws for complex64", () => {
    expect(() => mapGoType("complex64")).toThrow(UnsupportedTypeError);
  });

  it("throws for chan int", () => {
    expect(() => mapGoType("chan int")).toThrow(UnsupportedTypeError);
  });

  it("throws for map with non-string key", () => {
    expect(() => mapGoType("map[int]string")).toThrow(UnsupportedTypeError);
    expect(() => mapGoType("map[int]string")).toThrow(/map key must be/);
  });

  it("throws with the original type name in the error", () => {
    try {
      mapGoType("chan int");
      expect.unreachable("should throw");
    } catch (err) {
      expect(err).toBeInstanceOf(UnsupportedTypeError);
      expect((err as UnsupportedTypeError).goType).toBe("chan int");
    }
  });

  it("throws for struct literal type (unsupported in slice 1)", () => {
    expect(() => mapGoType("struct{ X int }")).toThrow(UnsupportedTypeError);
  });

  it("throws for func literal type", () => {
    expect(() => mapGoType("func(int) int")).toThrow(UnsupportedTypeError);
  });

  it("throws for named user type (MyStruct)", () => {
    expect(() => mapGoType("MyStruct")).toThrow(UnsupportedTypeError);
  });
});
