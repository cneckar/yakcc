// SPDX-License-Identifier: MIT
//
// Tests for extractFunctionSignatures (WI-782 slice 2).
//
// Tests build the libcst envelope directly (no subprocess) — the envelope
// shape is the wire contract that the Python script also produces.

import { describe, expect, it } from "vitest";
import type { LibcstParseResult } from "./libcst-parser.js";
import { MissingTypeAnnotationError, extractFunctionSignatures } from "./parse-fn-signature.js";
import { UnsupportedTypeError } from "./type-map.js";

interface EnvelopeFunction {
  name: string;
  params: Array<{ name: string; annotation: string | null }>;
  return_annotation: string | null;
  body_source: string;
}

function envelopeWith(functions: EnvelopeFunction[]): LibcstParseResult {
  return {
    version: 1,
    module: {
      type: "Module",
      stmt_count: functions.length,
      functions,
    } as unknown as LibcstParseResult["module"],
  };
}

describe("extractFunctionSignatures — happy paths", () => {
  it("extracts a simple typed function", () => {
    const env = envelopeWith([
      {
        name: "add",
        params: [
          { name: "x", annotation: "int" },
          { name: "y", annotation: "int" },
        ],
        return_annotation: "int",
        body_source: "    return x + y",
      },
    ]);
    const sigs = extractFunctionSignatures(env);
    expect(sigs).toHaveLength(1);
    expect(sigs[0]?.name).toBe("add");
    expect(sigs[0]?.params).toEqual([
      { name: "x", tsType: "number", pythonAnnotation: "int" },
      { name: "y", tsType: "number", pythonAnnotation: "int" },
    ]);
    expect(sigs[0]?.returnType).toBe("number");
    expect(sigs[0]?.pythonReturnAnnotation).toBe("int");
    expect(sigs[0]?.bodyPythonSource).toBe("    return x + y");
  });

  it("handles every primitive type and a container", () => {
    const env = envelopeWith([
      {
        name: "fancy",
        params: [
          { name: "a", annotation: "str" },
          { name: "b", annotation: "bool" },
          { name: "c", annotation: "list[int]" },
          { name: "d", annotation: "Optional[float]" },
        ],
        return_annotation: "dict[str, int]",
        body_source: "    return {}",
      },
    ]);
    const sig = extractFunctionSignatures(env)[0];
    expect(sig).toBeDefined();
    expect(sig?.params.map((p) => p.tsType)).toEqual([
      "string",
      "boolean",
      "number[]",
      "number | null",
    ]);
    expect(sig?.returnType).toBe("Record<string, number>");
  });

  it("returns [] when the module has no top-level functions", () => {
    expect(extractFunctionSignatures(envelopeWith([]))).toEqual([]);
  });

  it("returns one entry per function in declaration order", () => {
    const env = envelopeWith([
      { name: "first", params: [], return_annotation: "None", body_source: "    pass" },
      { name: "second", params: [], return_annotation: "None", body_source: "    pass" },
    ]);
    const sigs = extractFunctionSignatures(env);
    expect(sigs.map((s) => s.name)).toEqual(["first", "second"]);
  });
});

describe("extractFunctionSignatures — rejections", () => {
  it("rejects function with un-annotated parameter", () => {
    const env = envelopeWith([
      {
        name: "bad",
        params: [{ name: "x", annotation: null }],
        return_annotation: "int",
        body_source: "    return x",
      },
    ]);
    try {
      extractFunctionSignatures(env);
      expect.unreachable("should throw");
    } catch (err) {
      expect(err).toBeInstanceOf(MissingTypeAnnotationError);
      expect((err as MissingTypeAnnotationError).paramName).toBe("x");
      expect((err as MissingTypeAnnotationError).functionName).toBe("bad");
    }
  });

  it("rejects function with no return annotation", () => {
    const env = envelopeWith([
      {
        name: "noreturn",
        params: [{ name: "x", annotation: "int" }],
        return_annotation: null,
        body_source: "    return x",
      },
    ]);
    try {
      extractFunctionSignatures(env);
      expect.unreachable("should throw");
    } catch (err) {
      expect(err).toBeInstanceOf(MissingTypeAnnotationError);
      expect((err as MissingTypeAnnotationError).paramName).toBeNull();
    }
  });

  it("wraps UnsupportedTypeError with function/param context on params", () => {
    const env = envelopeWith([
      {
        name: "bigwrap",
        params: [{ name: "n", annotation: "Decimal" }],
        return_annotation: "int",
        body_source: "    return 0",
      },
    ]);
    try {
      extractFunctionSignatures(env);
      expect.unreachable("should throw");
    } catch (err) {
      expect(err).toBeInstanceOf(UnsupportedTypeError);
      expect((err as Error).message).toContain("Function 'bigwrap'");
      expect((err as Error).message).toContain("parameter 'n'");
    }
  });

  it("wraps UnsupportedTypeError with function context on return", () => {
    const env = envelopeWith([
      {
        name: "badret",
        params: [{ name: "x", annotation: "int" }],
        return_annotation: "Decimal",
        body_source: "    return x",
      },
    ]);
    try {
      extractFunctionSignatures(env);
      expect.unreachable("should throw");
    } catch (err) {
      expect(err).toBeInstanceOf(UnsupportedTypeError);
      expect((err as Error).message).toContain("Function 'badret'");
      expect((err as Error).message).toContain("return type");
    }
  });

  it("handles envelope missing the functions field gracefully", () => {
    const env = {
      version: 1 as const,
      module: { type: "Module", stmt_count: 0 } as unknown as LibcstParseResult["module"],
    };
    expect(extractFunctionSignatures(env)).toEqual([]);
  });
});
