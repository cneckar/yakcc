// SPDX-License-Identifier: MIT
//
// Tests for extractFunctionSignatures (WI-782 slice 2) and
// extractClassEnvelopes (WI-934).
//
// Tests build the libcst envelope directly (no subprocess) — the envelope
// shape is the wire contract that the Python script also produces.

import { describe, expect, it } from "vitest";
import type { LibcstParseResult } from "./libcst-parser.js";
import {
  MissingTypeAnnotationError,
  extractClassEnvelopes,
  extractFunctionSignatures,
  extractFunctionSignaturesAll,
} from "./parse-fn-signature.js";
import { ImpureFunctionError } from "./purity-check.js";
import { UnsupportedTypeError } from "./type-map.js";

interface EnvelopeFunction {
  name: string;
  params: Array<{ name: string; annotation: string | null }>;
  return_annotation: string | null;
  body_source: string;
  methodKind?: "static" | "class" | "instance";
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

// ---------------------------------------------------------------------------
// #923 — cls exemption for classmethods
// ---------------------------------------------------------------------------
// When methodKind === "class", the first parameter named "cls" is Python
// call-convention metadata only.  It does not translate to TS; it should be
// silently dropped from FunctionSignature.params so the shaved TS arrow has
// no cls argument and the missing-annotation check does not fire on it.
//
// Production scenario: bs4 classmethods that read class-level constants
// (e.g. `@classmethod def from_defaults(cls, ...) -> "Tag"`) were previously
// unextractable because libcst emits cls without an annotation.
//
// These tests cover the five cases specified in the dispatch:
//   1. Classmethod with un-annotated cls — succeeds, cls absent from params
//   2. Classmethod with annotated cls — succeeds, cls dropped (annotation ignored)
//   3. Classmethod with un-annotated regular param — still raises MissingTypeAnnotationError
//   4. Instance method (methodKind="instance") — still rejects via ImpureFunctionError
//   5. Module-level fn with first param named "cls" — NOT exempt; annotation required
// ---------------------------------------------------------------------------

describe("#923 — cls exemption for @classmethod", () => {
  it("classmethod with un-annotated cls extracts successfully; cls absent from params", () => {
    // Production sequence: @classmethod where libcst emits cls without annotation.
    // Before #923 this raised MissingTypeAnnotationError("from_defaults", "cls").
    const env = envelopeWith([
      {
        name: "MyTag.from_defaults",
        params: [
          { name: "cls", annotation: null },
          { name: "tag", annotation: "str" },
          { name: "count", annotation: "int" },
        ],
        return_annotation: "str",
        body_source: "    return cls.PREFIX + tag",
        methodKind: "class",
      },
    ]);
    const result = extractFunctionSignaturesAll(env);
    expect(result.failed).toHaveLength(0);
    expect(result.ok).toHaveLength(1);
    const sig = result.ok[0];
    expect(sig?.methodKind).toBe("class");
    // cls must not appear in params
    expect(sig?.params.map((p) => p.name)).not.toContain("cls");
    // remaining params are present
    expect(sig?.params.map((p) => p.name)).toEqual(["tag", "count"]);
  });

  it("classmethod with annotated cls extracts successfully; cls still dropped", () => {
    // Some codebases annotate cls explicitly (e.g. cls: type["MyTag"]).
    // The annotation is valid but cls is still Python call-convention metadata
    // and must be dropped from the TS-facing params.
    const env = envelopeWith([
      {
        name: "MyTag.create",
        params: [
          { name: "cls", annotation: 'type["MyTag"]' },
          { name: "name", annotation: "str" },
        ],
        return_annotation: "str",
        body_source: "    return name",
        methodKind: "class",
      },
    ]);
    const result = extractFunctionSignaturesAll(env);
    expect(result.failed).toHaveLength(0);
    expect(result.ok).toHaveLength(1);
    const sig = result.ok[0];
    expect(sig?.params.map((p) => p.name)).not.toContain("cls");
    expect(sig?.params.map((p) => p.name)).toEqual(["name"]);
  });

  it("classmethod with un-annotated regular param still raises MissingTypeAnnotationError", () => {
    // cls is exempt; other un-annotated params are NOT exempt.
    const env = envelopeWith([
      {
        name: "MyTag.build",
        params: [
          { name: "cls", annotation: null },
          { name: "raw", annotation: null }, // missing — should still fail
        ],
        return_annotation: "str",
        body_source: "    return raw",
        methodKind: "class",
      },
    ]);
    const result = extractFunctionSignaturesAll(env);
    expect(result.ok).toHaveLength(0);
    expect(result.failed).toHaveLength(1);
    const failure = result.failed[0];
    expect(failure?.error).toBeInstanceOf(MissingTypeAnnotationError);
    expect((failure?.error as MissingTypeAnnotationError).paramName).toBe("raw");
  });

  it("instance method (methodKind=instance) still rejects via ImpureFunctionError (unchanged)", () => {
    // #923 must not regress #890: instance methods are rejected before annotation
    // checks fire.  self has no annotation in practice — the rejection must come
    // from ImpureFunctionError("instance_method"), not MissingTypeAnnotationError.
    const env = envelopeWith([
      {
        name: "MyTag.render",
        params: [
          { name: "self", annotation: null },
          { name: "indent", annotation: "int" },
        ],
        return_annotation: "str",
        body_source: '    return ""',
        methodKind: "instance",
      },
    ]);
    const result = extractFunctionSignaturesAll(env);
    expect(result.ok).toHaveLength(0);
    expect(result.failed).toHaveLength(1);
    const failure = result.failed[0];
    expect(failure?.error).toBeInstanceOf(ImpureFunctionError);
    // Must NOT be a MissingTypeAnnotationError about self
    expect(failure?.error).not.toBeInstanceOf(MissingTypeAnnotationError);
  });

  it("module-level fn with first param named cls is NOT exempt — annotation required", () => {
    // cls is just a name at module level; no special treatment applies.
    // The exemption is keyed on methodKind === "class", not on param name alone.
    const env = envelopeWith([
      {
        name: "standalone_fn",
        params: [
          { name: "cls", annotation: null }, // no methodKind — not a classmethod
          { name: "x", annotation: "int" },
        ],
        return_annotation: "int",
        body_source: "    return x",
        // no methodKind field — undefined → module-level function
      },
    ]);
    const result = extractFunctionSignaturesAll(env);
    expect(result.ok).toHaveLength(0);
    expect(result.failed).toHaveLength(1);
    const failure = result.failed[0];
    expect(failure?.error).toBeInstanceOf(MissingTypeAnnotationError);
    // The failure must be about 'cls' itself — it is not exempt
    expect((failure?.error as MissingTypeAnnotationError).paramName).toBe("cls");
  });

  it("compound production sequence: mixed module with classmethod + module-level fn (end-to-end)", () => {
    // Real-world bs4 scenario: a module that has both a classmethod (cls un-annotated)
    // and a normal helper function.  Both should succeed after #923.
    // This crosses extractFunctionSignaturesAll + extractOne + cls-drop path.
    const env = envelopeWith([
      {
        name: "Tag.from_markup",
        params: [
          { name: "cls", annotation: null },
          { name: "markup", annotation: "str" },
        ],
        return_annotation: "str",
        body_source: "    return markup",
        methodKind: "class",
      },
      {
        name: "normalize_tag",
        params: [{ name: "s", annotation: "str" }],
        return_annotation: "str",
        body_source: "    return s.lower()",
        // no methodKind
      },
    ]);
    const result = extractFunctionSignaturesAll(env);
    expect(result.failed).toHaveLength(0);
    expect(result.ok).toHaveLength(2);
    // Classmethod: cls dropped
    const classSig = result.ok.find((s) => s.name === "Tag.from_markup");
    expect(classSig?.params.map((p) => p.name)).toEqual(["markup"]);
    expect(classSig?.methodKind).toBe("class");
    // Module-level fn: unchanged
    const helperSig = result.ok.find((s) => s.name === "normalize_tag");
    expect(helperSig?.params.map((p) => p.name)).toEqual(["s"]);
    expect(helperSig?.methodKind).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// WI-934: extractClassEnvelopes — module.classes[] path
// ---------------------------------------------------------------------------
//
// extractClassEnvelopes reads the module.classes[] array emitted by WI-934's
// libcst-parse.py extension and returns a typed EnvelopeClass[].  These tests
// cover:
//   1. Happy path: envelope with one class returns typed EnvelopeClass[]
//   2. Module with no classes returns []
//   3. WI-890 regression: module.functions[] instance-method path unaffected
//   4. Compound: module with both classes and functions — each path independent
//
// Tests build the LibcstParseResult directly (no subprocess).
// ---------------------------------------------------------------------------

describe("WI-934: extractClassEnvelopes — module.classes[] path", () => {
  it("returns typed EnvelopeClass[] for a module with one class", () => {
    // Envelope mirrors what libcst-parse.py emits for a simple class.
    const env: LibcstParseResult = {
      version: 1,
      module: {
        type: "Module",
        stmt_count: 1,
        functions: [],
        classes: [
          {
            name: "Counter",
            bases: [],
            decorators: [],
            metaclass: null,
            init_params: [{ name: "start", annotation: "int" }],
            init_assignments: [{ target: "start", value: { type: "Name", name: "start" } }],
            methods: [
              {
                name: "increment",
                params: [
                  { name: "self", annotation: null },
                  { name: "n", annotation: "int" },
                ],
                return_annotation: "int",
                body_source: "        return self.start + n",
                body: [
                  {
                    type: "Return",
                    value: {
                      type: "BinaryOp",
                      op: "+",
                      left: {
                        type: "AttributeRef",
                        obj: { type: "Name", name: "self" },
                        attr: "start",
                      },
                      right: { type: "Name", name: "n" },
                    },
                  },
                ],
                methodKind: "instance",
              },
            ],
            class_vars: [],
            raise_blockers: [],
          },
        ],
      } as unknown as LibcstParseResult["module"],
    };

    const classes = extractClassEnvelopes(env);
    expect(classes).toHaveLength(1);
    const cls = classes[0];
    expect(cls).toBeDefined();
    if (!cls) throw new Error("cls undefined");
    expect(cls.name).toBe("Counter");
    expect(cls.bases).toEqual([]);
    expect(cls.metaclass).toBeNull();
    expect(cls.raise_blockers).toHaveLength(0);
    expect(cls.init_params).toHaveLength(1);
    expect(cls.init_params[0]?.name).toBe("start");
    expect(cls.init_assignments).toHaveLength(1);
    expect(cls.init_assignments[0]?.target).toBe("start");
    expect(cls.methods).toHaveLength(1);
    expect(cls.methods[0]?.name).toBe("increment");
    expect(cls.methods[0]?.methodKind).toBe("instance");
  });

  it("returns [] when module has no classes (module.classes absent)", () => {
    // Module with only functions — no classes key at all.
    const env: LibcstParseResult = {
      version: 1,
      module: {
        type: "Module",
        stmt_count: 1,
        functions: [
          { name: "standalone", params: [], return_annotation: "None", body_source: "    pass" },
        ],
      } as unknown as LibcstParseResult["module"],
    };
    expect(extractClassEnvelopes(env)).toEqual([]);
  });

  it("returns [] when module.classes is an empty array", () => {
    const env: LibcstParseResult = {
      version: 1,
      module: {
        type: "Module",
        stmt_count: 0,
        functions: [],
        classes: [],
      } as unknown as LibcstParseResult["module"],
    };
    expect(extractClassEnvelopes(env)).toEqual([]);
  });

  it("WI-890 regression: module.functions[] extractFunctionSignatures still works when classes are present", () => {
    // Verifies that the new module.classes[] path does NOT affect the WI-890
    // module.functions[] short-circuit (instance-method rejection path).
    // Both extractFunctionSignatures and extractClassEnvelopes operate independently.
    const env: LibcstParseResult = {
      version: 1,
      module: {
        type: "Module",
        stmt_count: 2,
        functions: [
          {
            name: "plain_fn",
            params: [{ name: "x", annotation: "int" }],
            return_annotation: "int",
            body_source: "    return x",
          },
          {
            name: "MyClass.instance_method",
            params: [
              { name: "self", annotation: null },
              { name: "y", annotation: "int" },
            ],
            return_annotation: "int",
            body_source: "    return y",
            methodKind: "instance",
          },
        ],
        classes: [
          {
            name: "MyClass",
            bases: [],
            decorators: [],
            metaclass: null,
            init_params: [],
            init_assignments: [],
            methods: [],
            class_vars: [],
            raise_blockers: [],
          },
        ],
      } as unknown as LibcstParseResult["module"],
    };

    // functions[] path: plain_fn succeeds; instance method rejects
    const fnResult = extractFunctionSignaturesAll(env);
    expect(fnResult.ok.map((s) => s.name)).toEqual(["plain_fn"]);
    expect(fnResult.failed).toHaveLength(1);
    expect(fnResult.failed[0]?.error).toBeInstanceOf(ImpureFunctionError);

    // classes[] path: MyClass extracted independently
    const classes = extractClassEnvelopes(env);
    expect(classes).toHaveLength(1);
    expect(classes[0]?.name).toBe("MyClass");
  });

  it("compound: module with two classes returns both in order", () => {
    // Production sequence: module with EmailValidator and UrlValidator.
    // Both classes present → extractClassEnvelopes returns both in declaration order.
    const env: LibcstParseResult = {
      version: 1,
      module: {
        type: "Module",
        stmt_count: 2,
        functions: [],
        classes: [
          {
            name: "EmailValidator",
            bases: [],
            decorators: [],
            metaclass: null,
            init_params: [{ name: "max_length", annotation: "int" }],
            init_assignments: [
              { target: "max_length", value: { type: "Name", name: "max_length" } },
            ],
            methods: [
              {
                name: "validate",
                params: [
                  { name: "self", annotation: null },
                  { name: "email", annotation: "str" },
                ],
                return_annotation: "bool",
                body_source: "        return True",
                body: [{ type: "Return", value: { type: "Bool", value: true } }],
                methodKind: "instance",
              },
            ],
            class_vars: [],
            raise_blockers: [],
          },
          {
            name: "UrlValidator",
            bases: [],
            decorators: [],
            metaclass: null,
            init_params: [],
            init_assignments: [],
            methods: [],
            class_vars: [],
            raise_blockers: ["non_trivial_base"],
          },
        ],
      } as unknown as LibcstParseResult["module"],
    };

    const classes = extractClassEnvelopes(env);
    expect(classes).toHaveLength(2);
    expect(classes[0]?.name).toBe("EmailValidator");
    expect(classes[0]?.raise_blockers).toHaveLength(0);
    expect(classes[1]?.name).toBe("UrlValidator");
    expect(classes[1]?.raise_blockers).toHaveLength(1);
    expect(classes[1]?.raise_blockers[0]).toBe("non_trivial_base");
  });
});
