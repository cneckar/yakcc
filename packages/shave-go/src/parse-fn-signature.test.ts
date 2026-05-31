// SPDX-License-Identifier: MIT
//
// Tests for extractFunctionSignatures (WI-870 slice 1).
//
// Tests build the go/ast envelope directly (no subprocess) -- the envelope
// shape is the wire contract that scripts/go-ast-parse.go also produces.

import { describe, expect, it } from "vitest";
import type { GoAstParseResult } from "./go-ast-parser.js";
import { SignatureRaiseError, extractFunctionSignatures } from "./parse-fn-signature.js";
import { UnsupportedTypeError } from "./type-map.js";

function envelopeWith(
  functions: GoAstParseResult["functions"],
  packageName = "main",
): GoAstParseResult {
  return { version: 2, packageName, functions };
}

describe("extractFunctionSignatures -- happy paths", () => {
  it("extracts a simple typed function (Add)", () => {
    const env = envelopeWith([
      {
        name: "Add",
        receiver: null,
        typeParams: [],
        params: [
          { name: "a", goType: "int" },
          { name: "b", goType: "int" },
        ],
        results: [{ name: "", goType: "int" }],
        bodySource: "return a + b",
        body: null,
      },
    ]);
    const sigs = extractFunctionSignatures(env);
    expect(sigs).toHaveLength(1);
    const sig = sigs[0];
    expect(sig?.name).toBe("Add");
    expect(sig?.params).toEqual([
      { name: "a", goType: "int", tsType: "number" },
      { name: "b", goType: "int", tsType: "number" },
    ]);
    expect(sig?.returnTypes).toEqual(["number"]);
    expect(sig?.goReturnTypes).toEqual(["int"]);
    expect(sig?.bodySource).toBe("return a + b");
    expect(sig?.receiver).toBeNull();
  });

  it("handles multiple primitive types and a slice param", () => {
    const env = envelopeWith([
      {
        name: "Fancy",
        receiver: null,
        typeParams: [],
        params: [
          { name: "s", goType: "string" },
          { name: "ok", goType: "bool" },
          { name: "nums", goType: "[]int" },
          { name: "m", goType: "map[string]string" },
        ],
        results: [{ name: "", goType: "bool" }],
        bodySource: "return ok",
        body: null,
      },
    ]);
    const sig = extractFunctionSignatures(env)[0];
    expect(sig).toBeDefined();
    expect(sig?.params.map((p) => p.tsType)).toEqual([
      "string",
      "boolean",
      "number[]",
      "Record<string, string>",
    ]);
    expect(sig?.returnTypes).toEqual(["boolean"]);
  });

  it("handles multiple return values", () => {
    const env = envelopeWith([
      {
        name: "DivMod",
        receiver: null,
        typeParams: [],
        params: [
          { name: "a", goType: "int" },
          { name: "b", goType: "int" },
        ],
        results: [
          { name: "quotient", goType: "int" },
          { name: "remainder", goType: "int" },
        ],
        bodySource: "return a/b, a%b",
        body: null,
      },
    ]);
    const sig = extractFunctionSignatures(env)[0];
    expect(sig?.returnTypes).toEqual(["number", "number"]);
    expect(sig?.goReturnTypes).toEqual(["int", "int"]);
  });

  it("returns [] when the package has no functions", () => {
    expect(extractFunctionSignatures(envelopeWith([]))).toEqual([]);
  });

  it("returns one entry per function in declaration order", () => {
    const env = envelopeWith([
      {
        name: "First",
        receiver: null,
        typeParams: [],
        params: [],
        results: [],
        bodySource: "",
        body: null,
      },
      {
        name: "Second",
        receiver: null,
        typeParams: [],
        params: [],
        results: [],
        bodySource: "",
        body: null,
      },
    ]);
    const sigs = extractFunctionSignatures(env);
    expect(sigs.map((s) => s.name)).toEqual(["First", "Second"]);
  });

  it("preserves generics type params (Go 1.18)", () => {
    const env = envelopeWith([
      {
        name: "Map",
        receiver: null,
        typeParams: [{ name: "T", constraint: "any" }],
        params: [{ name: "xs", goType: "[]int" }],
        results: [{ name: "", goType: "[]int" }],
        bodySource: "return xs",
        body: null,
      },
    ]);
    const sig = extractFunctionSignatures(env)[0];
    expect(sig?.typeParams).toEqual([{ name: "T", constraint: "any" }]);
  });

  it("handles pointer param (*string -> string)", () => {
    const env = envelopeWith([
      {
        name: "Deref",
        receiver: null,
        typeParams: [],
        params: [{ name: "s", goType: "*string" }],
        results: [{ name: "", goType: "string" }],
        bodySource: "return *s",
        body: null,
      },
    ]);
    const sig = extractFunctionSignatures(env)[0];
    expect(sig?.params[0]?.tsType).toBe("string");
  });

  it("records bodySource and receiver correctly", () => {
    const env = envelopeWith([
      {
        name: "Len",
        receiver: "*MySlice",
        typeParams: [],
        params: [],
        results: [{ name: "", goType: "int" }],
        bodySource: "return len(s.data)",
        body: null,
      },
    ]);
    const sig = extractFunctionSignatures(env)[0];
    expect(sig?.receiver).toBe("*MySlice");
    expect(sig?.bodySource).toBe("return len(s.data)");
  });

  it("handles null bodySource (forward declaration)", () => {
    const env = envelopeWith([
      {
        name: "External",
        receiver: null,
        typeParams: [],
        params: [{ name: "n", goType: "int" }],
        results: [{ name: "", goType: "int" }],
        bodySource: null,
        body: null,
      },
    ]);
    const sig = extractFunctionSignatures(env)[0];
    expect(sig?.bodySource).toBeNull();
  });
});

describe("extractFunctionSignatures -- rejection cases", () => {
  it("throws SignatureRaiseError when a param type is unsupported", () => {
    const env = envelopeWith([
      {
        name: "Bad",
        receiver: null,
        typeParams: [],
        params: [{ name: "c", goType: "chan int" }],
        results: [{ name: "", goType: "int" }],
        bodySource: "",
        body: null,
      },
    ]);
    try {
      extractFunctionSignatures(env);
      expect.unreachable("should throw");
    } catch (err) {
      expect(err).toBeInstanceOf(SignatureRaiseError);
      expect((err as SignatureRaiseError).functionName).toBe("Bad");
      expect((err as SignatureRaiseError).cause_).toBeInstanceOf(UnsupportedTypeError);
      expect((err as Error).message).toContain("Function 'Bad'");
      expect((err as Error).message).toContain("parameter 'c'");
    }
  });

  it("throws SignatureRaiseError when a return type is unsupported", () => {
    const env = envelopeWith([
      {
        name: "BadRet",
        receiver: null,
        typeParams: [],
        params: [],
        results: [{ name: "", goType: "chan int" }],
        bodySource: "",
        body: null,
      },
    ]);
    try {
      extractFunctionSignatures(env);
      expect.unreachable("should throw");
    } catch (err) {
      expect(err).toBeInstanceOf(SignatureRaiseError);
      expect((err as Error).message).toContain("return type");
    }
  });
});

describe("extractFunctionSignatures -- WI-963 generic type parameter passthrough", () => {
  it("maps T param to tsType 'T' when T is declared as a type param", () => {
    const env = envelopeWith([
      {
        name: "Identity",
        receiver: null,
        typeParams: [{ name: "T", constraint: "any" }],
        params: [{ name: "x", goType: "T" }],
        results: [{ name: "", goType: "T" }],
        bodySource: "return x",
        body: null,
      },
    ]);
    const sigs = extractFunctionSignatures(env);
    const sig = sigs[0];
    expect(sig?.typeParams).toEqual([{ name: "T", constraint: "any" }]);
    expect(sig?.params[0]?.tsType).toBe("T");
    expect(sig?.returnTypes).toEqual(["T"]);
  });

  it("maps Map[T, R any] -- both T and R params pass through verbatim", () => {
    const env = envelopeWith([
      {
        name: "Map",
        receiver: null,
        typeParams: [
          { name: "T", constraint: "any" },
          { name: "R", constraint: "any" },
        ],
        params: [
          { name: "s", goType: "[]T" },
          { name: "f", goType: "func(T) R" },
        ],
        results: [{ name: "", goType: "[]R" }],
        bodySource: "// body",
        body: null,
      },
    ]);
    const sig = extractFunctionSignatures(env)[0];
    expect(sig?.params[0]?.tsType).toBe("T[]");
    expect(sig?.params[1]?.tsType).toBe("(a0: T) => R");
    expect(sig?.returnTypes).toEqual(["R[]"]);
  });

  it("does not break non-generic functions when type-param set is empty", () => {
    const env = envelopeWith([
      {
        name: "Add",
        receiver: null,
        typeParams: [],
        params: [
          { name: "a", goType: "int" },
          { name: "b", goType: "int" },
        ],
        results: [{ name: "", goType: "int" }],
        bodySource: "return a + b",
        body: null,
      },
    ]);
    const sig = extractFunctionSignatures(env)[0];
    expect(sig?.params.map((p) => p.tsType)).toEqual(["number", "number"]);
    expect(sig?.returnTypes).toEqual(["number"]);
  });

  it("throws SignatureRaiseError when a type-param-named type appears in a non-generic func", () => {
    // T is not in typeParams, so it should be an unsupported type
    const env = envelopeWith([
      {
        name: "Bad",
        receiver: null,
        typeParams: [],
        params: [{ name: "x", goType: "T" }],
        results: [],
        bodySource: "",
        body: null,
      },
    ]);
    expect(() => extractFunctionSignatures(env)).toThrow(SignatureRaiseError);
  });
});

describe("extractFunctionSignatures -- #981 iteratee/predicate with named func params", () => {
  it("raises Map[T, R any](collection []T, iteratee func(item T, index int) R) []R", () => {
    const env = envelopeWith([
      {
        name: "Map",
        receiver: null,
        typeParams: [
          { name: "T", constraint: "any" },
          { name: "R", constraint: "any" },
        ],
        params: [
          { name: "collection", goType: "[]T" },
          { name: "iteratee", goType: "func(item T, index int) R" },
        ],
        results: [{ name: "", goType: "[]R" }],
        bodySource: "// body",
        body: null,
      },
    ]);
    const sig = extractFunctionSignatures(env)[0];
    expect(sig?.params[0]?.tsType).toBe("T[]");
    expect(sig?.params[1]?.tsType).toBe("(a0: T, a1: number) => R");
    expect(sig?.returnTypes).toEqual(["R[]"]);
  });

  it("raises Filter[T any](collection []T, predicate func(item T, index int) bool) []T", () => {
    const env = envelopeWith([
      {
        name: "Filter",
        receiver: null,
        typeParams: [{ name: "T", constraint: "any" }],
        params: [
          { name: "collection", goType: "[]T" },
          { name: "predicate", goType: "func(item T, index int) bool" },
        ],
        results: [{ name: "", goType: "[]T" }],
        bodySource: "// body",
        body: null,
      },
    ]);
    const sig = extractFunctionSignatures(env)[0];
    expect(sig?.params[1]?.tsType).toBe("(a0: T, a1: number) => boolean");
    expect(sig?.returnTypes).toEqual(["T[]"]);
  });

  it("raises Reduce[T, R any](collection []T, accumulator func(agg R, item T, index int) R, initial R) R", () => {
    const env = envelopeWith([
      {
        name: "Reduce",
        receiver: null,
        typeParams: [
          { name: "T", constraint: "any" },
          { name: "R", constraint: "any" },
        ],
        params: [
          { name: "collection", goType: "[]T" },
          { name: "accumulator", goType: "func(agg R, item T, index int) R" },
          { name: "initial", goType: "R" },
        ],
        results: [{ name: "", goType: "R" }],
        bodySource: "// body",
        body: null,
      },
    ]);
    const sig = extractFunctionSignatures(env)[0];
    expect(sig?.params[0]?.tsType).toBe("T[]");
    expect(sig?.params[1]?.tsType).toBe("(a0: R, a1: T, a2: number) => R");
    expect(sig?.params[2]?.tsType).toBe("R");
    expect(sig?.returnTypes).toEqual(["R"]);
  });

  it("compound: full production sequence for samber/lo-style Map + Filter", () => {
    // This exercises the complete production path across parse-fn-signature +
    // type-map + name-normalize, with named func-typed params (#981 target).
    const env = envelopeWith([
      {
        name: "Map",
        receiver: null,
        typeParams: [
          { name: "T", constraint: "any" },
          { name: "R", constraint: "any" },
        ],
        params: [
          { name: "collection", goType: "[]T" },
          { name: "iteratee", goType: "func(item T, index int) R" },
        ],
        results: [{ name: "", goType: "[]R" }],
        bodySource: null,
        body: null,
      },
      {
        name: "Filter",
        receiver: null,
        typeParams: [{ name: "T", constraint: "any" }],
        params: [
          { name: "collection", goType: "[]T" },
          { name: "predicate", goType: "func(item T, index int) bool" },
        ],
        results: [{ name: "", goType: "[]T" }],
        bodySource: null,
        body: null,
      },
    ]);

    const [mapSig, filterSig] = extractFunctionSignatures(env);

    expect(mapSig?.name).toBe("Map");
    expect(mapSig?.params[0]?.tsType).toBe("T[]");
    expect(mapSig?.params[1]?.tsType).toBe("(a0: T, a1: number) => R");
    expect(mapSig?.returnTypes).toEqual(["R[]"]);

    expect(filterSig?.name).toBe("Filter");
    expect(filterSig?.params[1]?.tsType).toBe("(a0: T, a1: number) => boolean");
    expect(filterSig?.returnTypes).toEqual(["T[]"]);
  });
});

describe("extractFunctionSignatures -- compound production sequence", () => {
  it("exercises the full production path: envelope -> signatures -> types -> names", () => {
    // This test mirrors the real production sequence: the go/ast subprocess
    // emits an envelope, parse-fn-signature.ts narrows it, type-map.ts maps
    // each type, and name-normalize.ts validates each name.
    const env = envelopeWith(
      [
        {
          name: "ParseIntList",
          receiver: null,
          typeParams: [],
          params: [
            { name: "input", goType: "string" },
            { name: "sep", goType: "string" },
          ],
          results: [
            { name: "", goType: "[]int" },
            { name: "", goType: "error" },
          ],
          bodySource: "// body elided",
          body: null,
        },
        {
          name: "countWords",
          receiver: null,
          typeParams: [],
          params: [{ name: "s", goType: "string" }],
          results: [{ name: "", goType: "int" }],
          bodySource: "// body elided",
          body: null,
        },
      ],
      "strutil",
    );

    const sigs = extractFunctionSignatures(env);
    expect(sigs).toHaveLength(2);

    const [parseIntList, countWords] = sigs;
    expect(parseIntList?.name).toBe("ParseIntList");
    expect(parseIntList?.params.map((p) => p.tsType)).toEqual(["string", "string"]);
    expect(parseIntList?.returnTypes).toEqual(["number[]", "Error"]);

    expect(countWords?.name).toBe("countWords");
    expect(countWords?.params.map((p) => p.tsType)).toEqual(["string"]);
    expect(countWords?.returnTypes).toEqual(["number"]);
  });
});
