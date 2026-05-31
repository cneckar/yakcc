// SPDX-License-Identifier: MIT
//
// Tests for the Go -> TS type mapper (WI-870 slice 1 + WI-963 generics).

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

  it("maps func literal types to TS arrow types (WI-963 added support)", () => {
    // func(int) int is now supported: maps to (a0: number) => number.
    // Previously this threw UnsupportedTypeError (slice-1 limitation).
    // WI-963 adds func literal parsing for higher-order generic functions.
    expect(mapGoType("func(int) int")).toBe("(a0: number) => number");
  });

  it("throws for named user type (MyStruct)", () => {
    expect(() => mapGoType("MyStruct")).toThrow(UnsupportedTypeError);
  });
});

// ---------------------------------------------------------------------------
// WI-963: generic type parameter passthrough
// ---------------------------------------------------------------------------

describe("mapGoType -- generic type parameter passthrough (WI-963)", () => {
  it("returns bare T when T is in the typeParams set", () => {
    const typeParams = new Set(["T"]);
    expect(mapGoType("T", { typeParams })).toEqual({ tsType: "T", warnings: [] });
  });

  it("returns bare R when R is in the typeParams set", () => {
    const typeParams = new Set(["T", "R"]);
    expect(mapGoType("R", { typeParams })).toEqual({ tsType: "R", warnings: [] });
  });

  it("handles multi-char generic param names like In, Out, Elem", () => {
    const typeParams = new Set(["In", "Out", "Elem"]);
    expect(mapGoType("Elem", { typeParams })).toEqual({ tsType: "Elem", warnings: [] });
    expect(mapGoType("In", { typeParams })).toEqual({ tsType: "In", warnings: [] });
    expect(mapGoType("Out", { typeParams })).toEqual({ tsType: "Out", warnings: [] });
  });

  it("maps []T -> T[] when T is a type param", () => {
    const typeParams = new Set(["T"]);
    expect(mapGoType("[]T", { typeParams })).toEqual({ tsType: "T[]", warnings: [] });
  });

  it("maps []R -> R[] when R is a type param", () => {
    const typeParams = new Set(["T", "R"]);
    expect(mapGoType("[]R", { typeParams })).toEqual({ tsType: "R[]", warnings: [] });
  });

  it("maps func(T) R -> (a0: T) => R when both are type params", () => {
    const typeParams = new Set(["T", "R"]);
    const result = mapGoType("func(T) R", { typeParams });
    expect(result.tsType).toBe("(a0: T) => R");
    expect(result.warnings).toHaveLength(0);
  });

  it("maps func(T, T) R -> (a0: T, a1: T) => R", () => {
    const typeParams = new Set(["T", "R"]);
    const result = mapGoType("func(T, T) R", { typeParams });
    expect(result.tsType).toBe("(a0: T, a1: T) => R");
    expect(result.warnings).toHaveLength(0);
  });

  it("throws UnsupportedTypeError without a typeParams set for unknown T", () => {
    expect(() => mapGoType("T")).toThrow(UnsupportedTypeError);
  });

  it("throws UnsupportedTypeError when T is NOT in the typeParams set", () => {
    const typeParams = new Set(["R"]);
    // T not in set
    expect(() => mapGoType("T", { typeParams })).toThrow(UnsupportedTypeError);
  });

  it("backward compat: returns string (not object) when called without opts", () => {
    // Old callers (non-generic code paths) pass no opts — still get a string.
    expect(mapGoType("int")).toBe("number");
    expect(mapGoType("string")).toBe("string");
    expect(mapGoType("[]bool")).toBe("boolean[]");
  });
});

// ---------------------------------------------------------------------------
// #981: named parameters inside func literal types
// ---------------------------------------------------------------------------

describe("mapGoType -- #981 named parameters in func literal types", () => {
  it("strips param name from 'func(item T) R' with typeParams {T, R}", () => {
    const typeParams = new Set(["T", "R"]);
    const result = mapGoType("func(item T) R", { typeParams });
    expect(result.tsType).toBe("(a0: T) => R");
    expect(result.warnings).toHaveLength(0);
  });

  it("strips param name from 'func(item T, idx int) bool' (Map/Filter iteratee shape)", () => {
    const typeParams = new Set(["T"]);
    const result = mapGoType("func(item T, idx int) bool", { typeParams });
    expect(result.tsType).toBe("(a0: T, a1: number) => boolean");
    expect(result.warnings).toHaveLength(0);
  });

  it("handles samber/lo Map iteratee: func(item T, index int) R", () => {
    const typeParams = new Set(["T", "R"]);
    const result = mapGoType("func(item T, index int) R", { typeParams });
    expect(result.tsType).toBe("(a0: T, a1: number) => R");
    expect(result.warnings).toHaveLength(0);
  });

  it("handles Reduce accumulator: func(agg R, item T, index int) R", () => {
    const typeParams = new Set(["T", "R"]);
    const result = mapGoType("func(agg R, item T, index int) R", { typeParams });
    expect(result.tsType).toBe("(a0: R, a1: T, a2: number) => R");
    expect(result.warnings).toHaveLength(0);
  });

  it("handles Filter predicate: func(item T, index int) bool", () => {
    const typeParams = new Set(["T"]);
    const result = mapGoType("func(item T, index int) bool", { typeParams });
    expect(result.tsType).toBe("(a0: T, a1: number) => boolean");
    expect(result.warnings).toHaveLength(0);
  });

  it("handles named params with slice type: func(collection []T, item T) bool", () => {
    const typeParams = new Set(["T"]);
    const result = mapGoType("func(collection []T, item T) bool", { typeParams });
    expect(result.tsType).toBe("(a0: T[], a1: T) => boolean");
    expect(result.warnings).toHaveLength(0);
  });

  it("handles nested func type in param position: []func(T) R with named outer params", () => {
    const typeParams = new Set(["T", "R"]);
    // outer func has a param of type []func(T) R
    const result = mapGoType("[]func(T) R", { typeParams });
    expect(result.tsType).toBe("((a0: T) => R)[]");
    expect(result.warnings).toHaveLength(0);
  });

  it("handles unnamed params (no change from current behavior)", () => {
    const typeParams = new Set(["T", "R"]);
    const result = mapGoType("func(T) R", { typeParams });
    expect(result.tsType).toBe("(a0: T) => R");
    expect(result.warnings).toHaveLength(0);
  });

  it("handles variadic func type: func(items ...T) T", () => {
    const typeParams = new Set(["T"]);
    // ...T is a variadic — go/ast printer emits "...T" as type string
    const result = mapGoType("func(items ...T) T", { typeParams });
    expect(result.tsType).toBe("(a0: T) => T");
    expect(result.warnings).toHaveLength(0);
  });
});
