// SPDX-License-Identifier: MIT
//
// Tests for extractFunctionSignatures (WI-782 slice 2).
//
// Tests build the libcst envelope directly (no subprocess) — the envelope
// shape is the wire contract that the Python script also produces.

import { describe, expect, it } from "vitest";
import type { LibcstParseResult } from "./libcst-parser.js";
import {
  MissingTypeAnnotationError,
  extractFunctionSignatures,
  extractFunctionSignaturesAll,
} from "./parse-fn-signature.js";
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
      { name: "x", tsType: "number", pythonAnnotation: "int", warnings: [] },
      { name: "y", tsType: "number", pythonAnnotation: "int", warnings: [] },
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

describe("extractFunctionSignatures — rejections (via extractFunctionSignaturesAll)", () => {
  // Since #899, extractFunctionSignatures no longer throws — it silently skips failures.
  // Use extractFunctionSignaturesAll to observe per-function failure details.

  it("records failure for function with un-annotated parameter", () => {
    const env = envelopeWith([
      {
        name: "bad",
        params: [{ name: "x", annotation: null }],
        return_annotation: "int",
        body_source: "    return x",
      },
    ]);
    const result = extractFunctionSignaturesAll(env);
    expect(result.ok).toHaveLength(0);
    expect(result.failed).toHaveLength(1);
    const failure = result.failed[0];
    expect(failure?.name).toBe("bad");
    expect(failure?.error).toBeInstanceOf(MissingTypeAnnotationError);
    expect((failure?.error as MissingTypeAnnotationError).paramName).toBe("x");
    expect((failure?.error as MissingTypeAnnotationError).functionName).toBe("bad");
  });

  it("records failure for function with no return annotation", () => {
    const env = envelopeWith([
      {
        name: "noreturn",
        params: [{ name: "x", annotation: "int" }],
        return_annotation: null,
        body_source: "    return x",
      },
    ]);
    const result = extractFunctionSignaturesAll(env);
    expect(result.ok).toHaveLength(0);
    expect(result.failed).toHaveLength(1);
    const failure = result.failed[0];
    expect(failure?.name).toBe("noreturn");
    expect(failure?.error).toBeInstanceOf(MissingTypeAnnotationError);
    expect((failure?.error as MissingTypeAnnotationError).paramName).toBeNull();
  });

  it("records failure with wrapped UnsupportedTypeError context on params", () => {
    // Note: with #901, plain identifiers like 'Decimal' now pass through with a warning.
    // Use 'Set[int]' (a subscript form) which still throws as an unsupported container.
    const env = envelopeWith([
      {
        name: "bigwrap",
        params: [{ name: "n", annotation: "Set[int]" }],
        return_annotation: "int",
        body_source: "    return 0",
      },
    ]);
    const result = extractFunctionSignaturesAll(env);
    expect(result.ok).toHaveLength(0);
    expect(result.failed).toHaveLength(1);
    const failure = result.failed[0];
    expect(failure?.name).toBe("bigwrap");
    expect(failure?.error).toBeInstanceOf(UnsupportedTypeError);
    expect(failure?.error.message).toContain("Function 'bigwrap'");
    expect(failure?.error.message).toContain("parameter 'n'");
  });

  it("records failure with wrapped UnsupportedTypeError context on return", () => {
    // Use 'Set[int]' for the same reason — subscript form still throws.
    const env = envelopeWith([
      {
        name: "badret",
        params: [{ name: "x", annotation: "int" }],
        return_annotation: "Set[int]",
        body_source: "    return x",
      },
    ]);
    const result = extractFunctionSignaturesAll(env);
    expect(result.ok).toHaveLength(0);
    expect(result.failed).toHaveLength(1);
    const failure = result.failed[0];
    expect(failure?.name).toBe("badret");
    expect(failure?.error).toBeInstanceOf(UnsupportedTypeError);
    expect(failure?.error.message).toContain("Function 'badret'");
    expect(failure?.error.message).toContain("return type");
  });

  it("handles envelope missing the functions field gracefully", () => {
    const env = {
      version: 1 as const,
      module: { type: "Module", stmt_count: 0 } as unknown as LibcstParseResult["module"],
    };
    expect(extractFunctionSignatures(env)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// WI-889: LowerWarning threading through extractFunctionSignatures
// ---------------------------------------------------------------------------
// These tests verify the end-to-end path:
//   envelope → extractFunctionSignatures → mapPythonType → RaisedParam.warnings
//                                                         → FunctionSignature.returnWarnings
//
// Each test exercises the real production sequence (no mocks of mapPythonType).
// ---------------------------------------------------------------------------

describe("extractFunctionSignatures — WI-889 warning threading", () => {
  it("threads any-widened warning onto param when annotation is 'Any'", () => {
    const env = envelopeWith([
      {
        name: "accept_any",
        params: [{ name: "val", annotation: "Any" }],
        return_annotation: "str",
        body_source: "    return str(val)",
      },
    ]);
    const sigs = extractFunctionSignatures(env);
    expect(sigs).toHaveLength(1);
    const param = sigs[0]?.params[0];
    expect(param?.tsType).toBe("unknown");
    expect(param?.warnings).toHaveLength(1);
    expect(param?.warnings?.[0]?.code).toBe("any-widened");
    expect(param?.warnings?.[0]?.pythonFragment).toBe("Any");
    // Return should be lossless — no warnings
    expect(sigs[0]?.returnWarnings).toHaveLength(0);
  });

  it("threads any-widened warning onto returnWarnings when return is 'Any'", () => {
    const env = envelopeWith([
      {
        name: "returns_any",
        params: [{ name: "x", annotation: "int" }],
        return_annotation: "Any",
        body_source: "    return x",
      },
    ]);
    const sigs = extractFunctionSignatures(env);
    expect(sigs).toHaveLength(1);
    expect(sigs[0]?.returnType).toBe("unknown");
    expect(sigs[0]?.returnWarnings).toHaveLength(1);
    expect(sigs[0]?.returnWarnings?.[0]?.code).toBe("any-widened");
    expect(sigs[0]?.returnWarnings?.[0]?.pythonFragment).toBe("Any");
    // Params should be lossless — no warnings
    expect(sigs[0]?.params[0]?.warnings).toHaveLength(0);
  });

  it("threads module-type-widened warning onto param when annotation is 'types.ModuleType'", () => {
    const env = envelopeWith([
      {
        name: "load_module",
        params: [{ name: "mod", annotation: "types.ModuleType" }],
        return_annotation: "str",
        body_source: "    return mod.__name__",
      },
    ]);
    const sigs = extractFunctionSignatures(env);
    expect(sigs).toHaveLength(1);
    const param = sigs[0]?.params[0];
    expect(param?.tsType).toBe("unknown");
    expect(param?.warnings).toHaveLength(1);
    expect(param?.warnings?.[0]?.code).toBe("module-type-widened");
    expect(param?.warnings?.[0]?.pythonFragment).toBe("types.ModuleType");
  });

  it("threads callable-widened warning onto returnWarnings when return is 'Callable[..., str]'", () => {
    const env = envelopeWith([
      {
        name: "make_formatter",
        params: [{ name: "prefix", annotation: "str" }],
        return_annotation: "Callable[..., str]",
        body_source: "    return lambda x: prefix + x",
      },
    ]);
    const sigs = extractFunctionSignatures(env);
    expect(sigs).toHaveLength(1);
    expect(sigs[0]?.returnType).toBe("(...args: unknown[]) => string");
    expect(sigs[0]?.returnWarnings).toHaveLength(1);
    expect(sigs[0]?.returnWarnings?.[0]?.code).toBe("callable-widened");
    // Params should be lossless
    expect(sigs[0]?.params[0]?.warnings).toHaveLength(0);
  });

  it("compound: both param and return carry warnings (typing.Any param + bare Callable return)", () => {
    // Production sequence: a real bs4-style function that takes Any and returns a bare Callable.
    const env = envelopeWith([
      {
        name: "bind_handler",
        params: [{ name: "tag", annotation: "typing.Any" }],
        return_annotation: "Callable",
        body_source: "    return lambda: tag",
      },
    ]);
    const sigs = extractFunctionSignatures(env);
    expect(sigs).toHaveLength(1);
    // Param warning
    const param = sigs[0]?.params[0];
    expect(param?.tsType).toBe("unknown");
    expect(param?.warnings).toHaveLength(1);
    expect(param?.warnings?.[0]?.code).toBe("any-widened");
    // Return warning
    expect(sigs[0]?.returnType).toBe("(...args: unknown[]) => unknown");
    expect(sigs[0]?.returnWarnings).toHaveLength(1);
    expect(sigs[0]?.returnWarnings?.[0]?.code).toBe("callable-widened");
  });
});

// ---------------------------------------------------------------------------
// #899: per-function extraction continuation
// ---------------------------------------------------------------------------
// Before #899, extractFunctionSignatures used .map() which threw on the first
// failure, aborting extraction of ALL remaining functions in the module.
// After #899, each function is extracted independently; failures accumulate
// in failed[] and successes continue to accumulate in ok[].
//
// These tests exercise the compound-interaction production sequence:
//   envelope (N functions) → extractFunctionSignaturesAll → { ok, failed }
// demonstrating that a single failure mid-module does not abort the rest.
// ---------------------------------------------------------------------------

describe("#899 — per-function extraction continuation", () => {
  it("extracts successes even when the first function fails (unannotated param)", () => {
    // Module with 3 functions: first fails (unannotated param), second and third succeed.
    // Production scenario: bs4 module where some helpers lack annotations.
    const env = envelopeWith([
      {
        name: "bad_first",
        params: [{ name: "x", annotation: null }],
        return_annotation: "int",
        body_source: "    return x",
      },
      {
        name: "good_second",
        params: [{ name: "a", annotation: "int" }],
        return_annotation: "str",
        body_source: "    return str(a)",
      },
      {
        name: "good_third",
        params: [],
        return_annotation: "None",
        body_source: "    pass",
      },
    ]);
    const result = extractFunctionSignaturesAll(env);
    expect(result.ok).toHaveLength(2);
    expect(result.failed).toHaveLength(1);
    expect(result.ok.map((s) => s.name)).toEqual(["good_second", "good_third"]);
    expect(result.failed[0]?.name).toBe("bad_first");
  });

  it("extracts successes even when a middle function fails (missing return annotation)", () => {
    // Module where only the middle function lacks its return annotation.
    const env = envelopeWith([
      {
        name: "first_ok",
        params: [{ name: "x", annotation: "int" }],
        return_annotation: "int",
        body_source: "    return x",
      },
      {
        name: "middle_bad",
        params: [{ name: "x", annotation: "int" }],
        return_annotation: null,
        body_source: "    return x",
      },
      {
        name: "last_ok",
        params: [{ name: "s", annotation: "str" }],
        return_annotation: "bool",
        body_source: "    return bool(s)",
      },
    ]);
    const result = extractFunctionSignaturesAll(env);
    expect(result.ok).toHaveLength(2);
    expect(result.failed).toHaveLength(1);
    expect(result.ok[0]?.name).toBe("first_ok");
    expect(result.ok[1]?.name).toBe("last_ok");
    expect(result.failed[0]?.name).toBe("middle_bad");
  });

  it("accumulates multiple failures without aborting — all successes still returned", () => {
    // Module with 5 functions: positions 1, 3, 5 succeed; positions 2, 4 fail.
    // Demonstrates that failures at non-adjacent positions all accumulate.
    const env = envelopeWith([
      { name: "ok1", params: [], return_annotation: "None", body_source: "    pass" },
      {
        name: "fail2",
        params: [{ name: "x", annotation: null }], // missing annotation
        return_annotation: "int",
        body_source: "    return x",
      },
      { name: "ok3", params: [], return_annotation: "None", body_source: "    pass" },
      {
        name: "fail4",
        params: [{ name: "x", annotation: "int" }],
        return_annotation: null, // missing return annotation
        body_source: "    return x",
      },
      { name: "ok5", params: [], return_annotation: "None", body_source: "    pass" },
    ]);
    const result = extractFunctionSignaturesAll(env);
    expect(result.ok).toHaveLength(3);
    expect(result.failed).toHaveLength(2);
    expect(result.ok.map((s) => s.name)).toEqual(["ok1", "ok3", "ok5"]);
    expect(result.failed.map((f) => f.name)).toEqual(["fail2", "fail4"]);
  });

  it("extractFunctionSignatures (permissive) silently skips failures, returning only successes", () => {
    // Verifies backward-compatible public API: callers not using extractFunctionSignaturesAll
    // see only the successfully extracted signatures (no throws, no undefined entries).
    const env = envelopeWith([
      {
        name: "bad",
        params: [{ name: "x", annotation: null }],
        return_annotation: "int",
        body_source: "    return x",
      },
      {
        name: "good",
        params: [{ name: "x", annotation: "int" }],
        return_annotation: "int",
        body_source: "    return x",
      },
    ]);
    // Must NOT throw, must return only the succeeded function.
    const sigs = extractFunctionSignatures(env);
    expect(sigs).toHaveLength(1);
    expect(sigs[0]?.name).toBe("good");
  });

  it("extractFunctionSignaturesAll: unsupported type in middle does not abort — compound production sequence", () => {
    // End-to-end production sequence: a bs4-style module where one function uses
    // Set[int] (unsupported subscript container) — a common real-world annotation
    // that used to abort the whole module before #899.
    const env = envelopeWith([
      {
        name: "count_items",
        params: [{ name: "n", annotation: "int" }],
        return_annotation: "str",
        body_source: "    return str(n)",
      },
      {
        name: "set_fn",
        params: [{ name: "items", annotation: "Set[int]" }], // unsupported subscript
        return_annotation: "int",
        body_source: "    return len(items)",
      },
      {
        name: "stringify",
        params: [{ name: "val", annotation: "Any" }],
        return_annotation: "str",
        body_source: "    return str(val)",
      },
    ]);
    const result = extractFunctionSignaturesAll(env);
    // count_items and stringify succeed; set_fn fails
    expect(result.ok).toHaveLength(2);
    expect(result.failed).toHaveLength(1);
    expect(result.ok.map((s) => s.name)).toEqual(["count_items", "stringify"]);
    expect(result.failed[0]?.name).toBe("set_fn");
    // stringify's Any param should carry the any-widened warning end-to-end
    const stringifySig = result.ok.find((s) => s.name === "stringify");
    expect(stringifySig?.params[0]?.warnings?.[0]?.code).toBe("any-widened");
  });
});
