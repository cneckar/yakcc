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

// ---------------------------------------------------------------------------
// WI-888: Docstring skip + ImpureStatement throw via renderFunctionDeclaration
// ---------------------------------------------------------------------------

describe("WI-888: renderFunctionDeclaration — Docstring + ImpureStatement handling", () => {
  it("skips a leading Docstring and renders the rest of the body (DEC-WI888-001/008)", () => {
    // A function with a docstring + return: the docstring must be dropped silently.
    // def add(x, y): """Add x and y."""; return x + y
    const s = sig({
      name: "add",
      params: [
        { name: "x", tsType: "number", pythonAnnotation: "int" },
        { name: "y", tsType: "number", pythonAnnotation: "int" },
      ],
      returnType: "number",
    });
    const body: WireStmt[] = [
      { type: "Docstring", value: "Add x and y." },
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
    const out = renderFunctionDeclaration(s, body);
    // Docstring is dropped; body contains only the Return statement
    expect(out).toBe("export function add(x: number, y: number): number {\n  return (x + y);\n}");
    expect(out).not.toContain("Add x and y.");
  });

  it("renders void 0; for a docstring-only body (DEC-WI888-008)", () => {
    // def doc_only(): """Just docs, nothing else."""
    const s = sig({ name: "doc_only", returnType: "void" });
    const body: WireStmt[] = [{ type: "Docstring", value: "Just docs, nothing else." }];
    const out = renderFunctionDeclaration(s, body);
    expect(out).toBe("export function doc_only(): void {\n  void 0;\n}");
  });

  it("throws ImpureFunctionError for a body containing ImpureStatement(bare_call) (DEC-WI888-005)", () => {
    // def log_x(x): print(x) — bare print call is impure
    const s = sig({ name: "log_x", returnType: "void" });
    const body: WireStmt[] = [
      { type: "ImpureStatement", construct: "bare_call", detail: "print(...)" },
    ];
    try {
      renderFunctionDeclaration(s, body);
      expect.unreachable("should throw ImpureFunctionError");
    } catch (err) {
      expect(err).toBeInstanceOf(ImpureFunctionError);
      expect((err as ImpureFunctionError).kind).toBe("forbidden_construct");
      expect((err as ImpureFunctionError).functionName).toBe("log_x");
      expect((err as ImpureFunctionError).detail).toContain("print(...)");
    }
  });
});

// ---------------------------------------------------------------------------
// WI-888: e2e compound-interaction test — docstring then return, bare print throws
// ---------------------------------------------------------------------------

describe("WI-888: raiseFunctionWithPurityAndNormalization — e2e compound interaction", () => {
  it("docstring-only body raises OK (no ImpureFunctionError, emits void 0;)", () => {
    // Production sequence: checkModuleImports → checkFunctionPurity → normalize → renderFunctionDeclaration
    // def greet(): """Greeting function."""
    const envelope = makeEnvelope({
      functions: [
        {
          name: "greet",
          params: [],
          return_annotation: "None",
          body_source: '    """Greeting function."""',
          body: [{ type: "Docstring", value: "Greeting function." }],
        },
      ],
    });
    const signature: FunctionSignature = {
      name: "greet",
      params: [],
      returnType: "null",
      pythonReturnAnnotation: "None",
      bodyPythonSource: '    """Greeting function."""',
    };
    const body: WireStmt[] = [{ type: "Docstring", value: "Greeting function." }];
    const out = raiseFunctionWithPurityAndNormalization(envelope, signature, body);
    // Docstring-only body → void 0;
    expect(out).toBe("export function greet(): null {\n  void 0;\n}");
  });

  it("bare print(x) in body throws ImpureFunctionError(forbidden_construct) via render path", () => {
    // Production sequence: purity check passes (print is detected by checkFunctionPurity
    // via forbidden_call body walk)... but here we test the render path: even if purity
    // check misses it (no envelope impurities, checking wire-AST), ImpureStatement at
    // render time throws forbidden_construct.
    //
    // This exercises the real sequence: checkModuleImports → normalize → renderFunctionDeclaration
    // with an ImpureStatement wire node in the body.
    const envelope = makeEnvelope({
      functions: [
        {
          name: "print_x",
          params: [{ name: "x", annotation: "int" }],
          return_annotation: "None",
          body_source: "    print(x)",
          body: [{ type: "ImpureStatement", construct: "bare_call", detail: "print(...)" }],
        },
      ],
    });
    const signature: FunctionSignature = {
      name: "print_x",
      params: [{ name: "x", tsType: "number", pythonAnnotation: "int" }],
      returnType: "null",
      pythonReturnAnnotation: "None",
      bodyPythonSource: "    print(x)",
    };
    // Build wire body with ImpureStatement so render throws
    const body: WireStmt[] = [
      { type: "ImpureStatement", construct: "bare_call", detail: "print(...)" },
    ];
    try {
      raiseFunctionWithPurityAndNormalization(envelope, signature, body);
      expect.unreachable("should throw ImpureFunctionError");
    } catch (err) {
      expect(err).toBeInstanceOf(ImpureFunctionError);
      expect((err as ImpureFunctionError).kind).toBe("forbidden_construct");
      // The fnName is the NORMALIZED (camelCase) name "printX" because raiseFunctionWithPurityAndNormalization
      // normalizes the signature before calling renderFunctionDeclaration. The normalized name is what
      // gets threaded through renderFunctionDeclaration → renderBody → renderStmt → ImpureFunctionError.
      expect((err as ImpureFunctionError).functionName).toBe("printX");
    }
  });
});

// ---------------------------------------------------------------------------
// WI-903: If statement — compound-interaction tests through the full pipeline
// ---------------------------------------------------------------------------

describe("WI-903: raiseFunctionWithPurityAndNormalization — If statement compound interaction", () => {
  // Production sequence: checkModuleImports → checkFunctionPurity → normalize names →
  // renderFunctionDeclaration → renderBody → renderStmt(If) → TS output.

  it("lowers if/else to TS if/else in a function body (compound production sequence)", () => {
    // def clamp(x: int) -> int:
    //     if x > 100: return 100
    //     else: return x
    const envelope = makeEnvelope();
    const signature: FunctionSignature = {
      name: "clamp",
      params: [{ name: "x", tsType: "number", pythonAnnotation: "int" }],
      returnType: "number",
      pythonReturnAnnotation: "int",
      bodyPythonSource: "    if x > 100:\n        return 100\n    else:\n        return x",
    };
    const body: WireStmt[] = [
      {
        type: "If",
        test: {
          type: "BinaryOp",
          op: ">",
          left: { type: "Name", name: "x" },
          right: { type: "Integer", value: "100" },
        },
        body: [{ type: "Return", value: { type: "Integer", value: "100" } }],
        orelse: [{ type: "Return", value: { type: "Name", name: "x" } }],
      },
    ];
    const out = raiseFunctionWithPurityAndNormalization(envelope, signature, body);
    expect(out).toBe(
      "export function clamp(x: number): number {\n  if ((x > 100)) {\n    return 100;\n  } else {\n    return x;\n  }\n}",
    );
  });

  it("lowers if/elif/else chain (3-way) in the pipeline with snake_case normalization", () => {
    // def classify_score(raw_score: int) -> int:
    //     if raw_score > 90: return 3
    //     elif raw_score > 50: return 2
    //     else: return 1
    const envelope = makeEnvelope();
    const signature: FunctionSignature = {
      name: "classify_score",
      params: [{ name: "raw_score", tsType: "number", pythonAnnotation: "int" }],
      returnType: "number",
      pythonReturnAnnotation: "int",
      bodyPythonSource:
        "    if raw_score > 90:\n        return 3\n    elif raw_score > 50:\n        return 2\n    else:\n        return 1",
    };
    const body: WireStmt[] = [
      {
        type: "If",
        test: {
          type: "BinaryOp",
          op: ">",
          left: { type: "Name", name: "raw_score" },
          right: { type: "Integer", value: "90" },
        },
        body: [{ type: "Return", value: { type: "Integer", value: "3" } }],
        orelse: [
          {
            type: "If",
            test: {
              type: "BinaryOp",
              op: ">",
              left: { type: "Name", name: "raw_score" },
              right: { type: "Integer", value: "50" },
            },
            body: [{ type: "Return", value: { type: "Integer", value: "2" } }],
            orelse: [{ type: "Return", value: { type: "Integer", value: "1" } }],
          },
        ],
      },
    ];
    const out = raiseFunctionWithPurityAndNormalization(envelope, signature, body);
    // Function name normalized: classify_score → classifyScore
    // Param name normalized: raw_score → rawScore
    expect(out).toContain("function classifyScore(rawScore: number)");
    // elif chain collapses to `else if`
    expect(out).toContain("} else if (");
    // All three return paths present
    expect(out).toContain("return 3;");
    expect(out).toContain("return 2;");
    expect(out).toContain("return 1;");
  });

  it("lowers if-only (no else) to TS if block followed by a bare return", () => {
    // def early_exit(n: int) -> int:
    //     if n < 0: return 0
    //     return n
    const envelope = makeEnvelope();
    const signature: FunctionSignature = {
      name: "early_exit",
      params: [{ name: "n", tsType: "number", pythonAnnotation: "int" }],
      returnType: "number",
      pythonReturnAnnotation: "int",
      bodyPythonSource: "    if n < 0:\n        return 0\n    return n",
    };
    const body: WireStmt[] = [
      {
        type: "If",
        test: {
          type: "BinaryOp",
          op: "<",
          left: { type: "Name", name: "n" },
          right: { type: "Integer", value: "0" },
        },
        body: [{ type: "Return", value: { type: "Integer", value: "0" } }],
        orelse: [],
      },
      { type: "Return", value: { type: "Name", name: "n" } },
    ];
    const out = raiseFunctionWithPurityAndNormalization(envelope, signature, body);
    expect(out).toContain("if ((n < 0))");
    expect(out).not.toContain("else");
    expect(out).toContain("return 0;");
    expect(out).toContain("return n;");
  });
});

// ---------------------------------------------------------------------------
// WI-904: Comprehension — compound-interaction tests through the full pipeline
// ---------------------------------------------------------------------------

describe("WI-904: raiseFunctionWithPurityAndNormalization — comprehension compound interaction", () => {
  // Production sequence: checkModuleImports → checkFunctionPurity → normalize names →
  // renderFunctionDeclaration → renderBody → renderStmt / renderExpr → TS output.

  it("lowers ListComp map pattern in a function body (compound production sequence)", () => {
    // def double_all(items: list) -> list:
    //     return [x * 2 for x in items]
    const envelope = makeEnvelope();
    const signature: FunctionSignature = {
      name: "double_all",
      params: [{ name: "items", tsType: "number[]", pythonAnnotation: "list" }],
      returnType: "number[]",
      pythonReturnAnnotation: "list",
      bodyPythonSource: "    return [x * 2 for x in items]",
    };
    const body: WireStmt[] = [
      {
        type: "Return",
        value: {
          type: "ListComp",
          kind: "map",
          iter: { type: "Name", name: "items" },
          param: "x",
          elt: {
            type: "BinaryOp",
            op: "*",
            left: { type: "Name", name: "x" },
            right: { type: "Integer", value: "2" },
          },
        },
      },
    ];
    const out = raiseFunctionWithPurityAndNormalization(envelope, signature, body);
    expect(out).toBe(
      "export function doubleAll(items: number[]): number[] {\n  return (items).map((x) => (x * 2));\n}",
    );
  });

  it("lowers ListComp filter pattern to .filter() call in the pipeline", () => {
    // def keep_positive(xs: list) -> list:
    //     return [x for x in xs if x > 0]
    const envelope = makeEnvelope();
    const signature: FunctionSignature = {
      name: "keep_positive",
      params: [{ name: "xs", tsType: "number[]", pythonAnnotation: "list" }],
      returnType: "number[]",
      pythonReturnAnnotation: "list",
      bodyPythonSource: "    return [x for x in xs if x > 0]",
    };
    const body: WireStmt[] = [
      {
        type: "Return",
        value: {
          type: "ListComp",
          kind: "filter",
          iter: { type: "Name", name: "xs" },
          param: "x",
          cond: {
            type: "BinaryOp",
            op: ">",
            left: { type: "Name", name: "x" },
            right: { type: "Integer", value: "0" },
          },
        },
      },
    ];
    const out = raiseFunctionWithPurityAndNormalization(envelope, signature, body);
    expect(out).toContain("(xs).filter((x) => (x > 0))");
  });

  it("lowers DictComp to Object.fromEntries() in a function body with normalization", () => {
    // def build_map(keys: list) -> dict:
    //     return {k: 1 for k in keys}
    const envelope = makeEnvelope();
    const signature: FunctionSignature = {
      name: "build_map",
      params: [{ name: "keys", tsType: "string[]", pythonAnnotation: "list" }],
      returnType: "Record<string, number>",
      pythonReturnAnnotation: "dict",
      bodyPythonSource: "    return {k: 1 for k in keys}",
    };
    const body: WireStmt[] = [
      {
        type: "Return",
        value: {
          type: "DictComp",
          iter: { type: "Name", name: "keys" },
          param: "k",
          keyElt: { type: "Name", name: "k" },
          valElt: { type: "Integer", value: "1" },
          cond: null,
        },
      },
    ];
    const out = raiseFunctionWithPurityAndNormalization(envelope, signature, body);
    expect(out).toContain("Object.fromEntries(");
    expect(out).toContain("(keys).map((k) => [k, 1])");
  });

  it("lowers SetComp map pattern to new Set(.map()) in the pipeline", () => {
    // def unique_vals(xs: list) -> set:
    //     return {x * 2 for x in xs}
    const envelope = makeEnvelope();
    const signature: FunctionSignature = {
      name: "unique_vals",
      params: [{ name: "xs", tsType: "number[]", pythonAnnotation: "list" }],
      returnType: "Set<number>",
      pythonReturnAnnotation: "set",
      bodyPythonSource: "    return {x * 2 for x in xs}",
    };
    const body: WireStmt[] = [
      {
        type: "Return",
        value: {
          type: "SetComp",
          kind: "map",
          iter: { type: "Name", name: "xs" },
          param: "x",
          elt: {
            type: "BinaryOp",
            op: "*",
            left: { type: "Name", name: "x" },
            right: { type: "Integer", value: "2" },
          },
        },
      },
    ];
    const out = raiseFunctionWithPurityAndNormalization(envelope, signature, body);
    expect(out).toContain("new Set((xs).map((x) => (x * 2)))");
  });

  it("lowers GeneratorExp filter_map pattern in the pipeline", () => {
    // def gen_positives(xs: list) -> list:
    //     return list(x for x in xs if x > 0)
    // Wrapped in a list() call that contains the GeneratorExp
    const envelope = makeEnvelope();
    const signature: FunctionSignature = {
      name: "gen_positives",
      params: [{ name: "xs", tsType: "number[]", pythonAnnotation: "list" }],
      returnType: "number[]",
      pythonReturnAnnotation: "list",
      bodyPythonSource: "    return list(x for x in xs if x > 0)",
    };
    const body: WireStmt[] = [
      {
        type: "Return",
        value: {
          type: "Call",
          func: "list",
          args: [
            {
              type: "GeneratorExp",
              kind: "filter_map",
              iter: { type: "Name", name: "xs" },
              param: "x",
              cond: {
                type: "BinaryOp",
                op: ">",
                left: { type: "Name", name: "x" },
                right: { type: "Integer", value: "0" },
              },
              elt: { type: "Name", name: "x" },
            },
          ],
        },
      },
    ];
    const out = raiseFunctionWithPurityAndNormalization(envelope, signature, body);
    expect(out).toContain("(xs).filter((x) => (x > 0)).map((x) => x)");
  });
});
