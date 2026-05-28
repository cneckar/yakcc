// SPDX-License-Identifier: MIT
//
// Tests for raise-function.ts — full TS function declaration rendering
// (WI-782 slices 2b and 3).
//
// Slice 3 additions: end-to-end tests for the full raise pipeline including
// purity checking and snake_case → camelCase normalization.

import { describe, expect, it } from "vitest";
import type { LibcstParseResult, PythonAstNode } from "./libcst-parser.js";
import type { FunctionSignature } from "./parse-fn-signature.js";
import type { WireStmt } from "./raise-body.js";
import {
  ImpureFunctionError,
  raiseFunctionWithPurityAndNormalization,
  renderFunctionDeclaration,
} from "./raise-function.js";

function sig(over: Partial<FunctionSignature> = {}): FunctionSignature {
  return {
    name: "fn",
    params: [],
    returnType: "void",
    pythonReturnAnnotation: "None",
    bodyPythonSource: "",
    ...over,
  };
}

describe("renderFunctionDeclaration", () => {
  it("renders zero-param function", () => {
    const out = renderFunctionDeclaration(sig({ name: "noop", returnType: "void" }), [
      { type: "Pass" },
    ]);
    expect(out).toBe("export function noop(): void {\n  void 0;\n}");
  });

  it("renders typed add function with return binop", () => {
    const s = sig({
      name: "add",
      params: [
        { name: "x", tsType: "number", pythonAnnotation: "int" },
        { name: "y", tsType: "number", pythonAnnotation: "int" },
      ],
      returnType: "number",
      pythonReturnAnnotation: "int",
    });
    const body: WireStmt[] = [
      {
        type: "Return",
        value: {
          type: "BinaryOp",
          op: "+",
          left: { type: "Name", name: "x" },
          right: { type: "Name", name: "y" },
        },
      },
    ];
    expect(renderFunctionDeclaration(s, body)).toBe(
      "export function add(x: number, y: number): number {\n  return (x + y);\n}",
    );
  });

  it("renders empty body as void 0;", () => {
    const out = renderFunctionDeclaration(sig({ name: "stub", returnType: "void" }), []);
    expect(out).toContain("void 0;");
  });

  it("renders complex param + return types verbatim from signature", () => {
    const s = sig({
      name: "lookup",
      params: [{ name: "key", tsType: "string", pythonAnnotation: "str" }],
      returnType: "number | null",
    });
    const out = renderFunctionDeclaration(s, [{ type: "Return", value: { type: "None" } }]);
    expect(out).toBe("export function lookup(key: string): number | null {\n  return null;\n}");
  });
});

// ---------------------------------------------------------------------------
// Slice 3: raiseFunctionWithPurityAndNormalization — end-to-end pipeline
// ---------------------------------------------------------------------------

function makeEnvelope(moduleExtras: Record<string, unknown> = {}): LibcstParseResult {
  return {
    version: 1,
    module: {
      type: "Module",
      stmt_count: 1,
      functions: [],
      ...moduleExtras,
    } as unknown as PythonAstNode,
  };
}

describe("raiseFunctionWithPurityAndNormalization — snake_case in → camelCase out", () => {
  it("converts snake_case function name and param to camelCase (compound production sequence)", () => {
    // This is the required real-path compound-interaction test:
    // Python: def calc_total(my_value: int) -> int: return my_value + 1
    // Expected TS: export function calcTotal(myValue: number): number { return (myValue + 1); }
    const envelope = makeEnvelope();
    const signature: FunctionSignature = {
      name: "calc_total",
      params: [{ name: "my_value", tsType: "number", pythonAnnotation: "int" }],
      returnType: "number",
      pythonReturnAnnotation: "int",
      bodyPythonSource: "    return my_value + 1",
    };
    const body: WireStmt[] = [
      {
        type: "Return",
        value: {
          type: "BinaryOp",
          op: "+",
          left: { type: "Name", name: "my_value" },
          right: { type: "Integer", value: "1" },
        },
      },
    ];
    const out = raiseFunctionWithPurityAndNormalization(envelope, signature, body);
    expect(out).toBe(
      "export function calcTotal(myValue: number): number {\n  return (myValue + 1);\n}",
    );
  });

  it("preserves _private parameter name unchanged", () => {
    const envelope = makeEnvelope();
    const signature: FunctionSignature = {
      name: "use_private",
      params: [{ name: "_private", tsType: "number", pythonAnnotation: "int" }],
      returnType: "number",
      pythonReturnAnnotation: "int",
      bodyPythonSource: "    return _private",
    };
    const body: WireStmt[] = [{ type: "Return", value: { type: "Name", name: "_private" } }];
    const out = raiseFunctionWithPurityAndNormalization(envelope, signature, body);
    expect(out).toContain("_private: number");
    expect(out).toContain("return _private");
  });

  it("preserves MAX_SIZE parameter name (ALL_CAPS constant)", () => {
    const envelope = makeEnvelope();
    const signature: FunctionSignature = {
      name: "check_limit",
      params: [{ name: "MAX_SIZE", tsType: "number", pythonAnnotation: "int" }],
      returnType: "boolean",
      pythonReturnAnnotation: "bool",
      bodyPythonSource: "    return MAX_SIZE > 0",
    };
    const body: WireStmt[] = [
      {
        type: "Return",
        value: {
          type: "BinaryOp",
          op: ">",
          left: { type: "Name", name: "MAX_SIZE" },
          right: { type: "Integer", value: "0" },
        },
      },
    ];
    const out = raiseFunctionWithPurityAndNormalization(envelope, signature, body);
    expect(out).toContain("MAX_SIZE: number");
    expect(out).toContain("MAX_SIZE > 0");
  });

  it("preserves __dunder__ function name unchanged", () => {
    const envelope = makeEnvelope();
    const signature: FunctionSignature = {
      name: "__init__",
      params: [],
      returnType: "null",
      pythonReturnAnnotation: "None",
      bodyPythonSource: "    pass",
    };
    const out = raiseFunctionWithPurityAndNormalization(envelope, signature, [{ type: "Pass" }]);
    expect(out).toContain("function __init__()");
  });

  it("rejects impure function with ImpureFunctionError (print call in envelope)", () => {
    const envelope = makeEnvelope({
      functions: [
        {
          name: "log_it",
          params: [],
          return_annotation: "None",
          body_source: "    print('hi')",
          impurities: [{ kind: "forbidden_call", detail: "calls print()", line: 1, col: 4 }],
        },
      ],
    });
    const signature: FunctionSignature = {
      name: "log_it",
      params: [],
      returnType: "null",
      pythonReturnAnnotation: "None",
      bodyPythonSource: "    print('hi')",
    };
    expect(() =>
      raiseFunctionWithPurityAndNormalization(envelope, signature, [{ type: "Pass" }]),
    ).toThrow(ImpureFunctionError);
  });

  it("rejects impure function when module imports os", () => {
    const envelope = makeEnvelope({
      imports: [{ kind: "import", module: "os", name: "os" }],
    });
    const signature: FunctionSignature = {
      name: "get_cwd",
      params: [],
      returnType: "string",
      pythonReturnAnnotation: "str",
      bodyPythonSource: "    return os.getcwd()",
    };
    expect(() =>
      raiseFunctionWithPurityAndNormalization(envelope, signature, [{ type: "Pass" }]),
    ).toThrow(ImpureFunctionError);
  });
});
