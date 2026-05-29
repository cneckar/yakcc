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
  return { version: 1, packageName, functions };
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
      },
      {
        name: "Second",
        receiver: null,
        typeParams: [],
        params: [],
        results: [],
        bodySource: "",
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
        },
        {
          name: "countWords",
          receiver: null,
          typeParams: [],
          params: [{ name: "s", goType: "string" }],
          results: [{ name: "", goType: "int" }],
          bodySource: "// body elided",
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
