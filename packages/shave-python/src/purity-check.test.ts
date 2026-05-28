// SPDX-License-Identifier: MIT
//
// Tests for purity-check.ts — static reject-list purity inference (WI-782 slice 3).
//
// All tests build the libcst envelope directly (no subprocess) following the
// pattern established by parse-fn-signature.test.ts.  The envelope shape
// is the wire contract produced by scripts/libcst-parse.py.
//
// @decision DEC-POLYGLOT-SHAVE-PY-PURITY-TEST-001 (WI-782 slice 3)
// @title purity-check tests use envelope-injection, not real subprocess
// @status accepted (WI-782 slice 3)
// @rationale
//   Consistent with the pattern from libcst-parser.test.ts: all envelope-level
//   tests build the wire JSON directly.  The reject-list is purely static
//   (no Python subprocess) so envelope injection is the correct test boundary.

import { describe, expect, it } from "vitest";
import type { LibcstParseResult, PythonAstNode } from "./libcst-parser.js";
import { ImpureFunctionError, checkFunctionPurity, checkPurity } from "./purity-check.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEnvelope(
  moduleExtras: Record<string, unknown> = {},
  ...functions: Record<string, unknown>[]
): LibcstParseResult {
  return {
    version: 1,
    module: {
      type: "Module",
      stmt_count: functions.length,
      functions,
      ...moduleExtras,
    } as unknown as PythonAstNode,
  };
}

function pureFn(name = "calc", body: unknown[] = []): Record<string, unknown> {
  return { name, params: [], return_annotation: "int", body_source: "    return 1", body };
}

// ---------------------------------------------------------------------------
// Happy path: pure functions should not throw
// ---------------------------------------------------------------------------

describe("checkPurity — pure functions pass", () => {
  it("accepts an empty-body function with no body nodes", () => {
    const env = makeEnvelope({}, pureFn("pure_fn", []));
    expect(() => checkPurity(env)).not.toThrow();
  });

  it("accepts a function with a simple return-literal body", () => {
    const env = makeEnvelope(
      {},
      pureFn("add", [
        {
          type: "Return",
          value: {
            type: "BinaryOp",
            op: "+",
            left: { type: "Name", name: "x" },
            right: { type: "Name", name: "y" },
          },
        },
      ]),
    );
    expect(() => checkPurity(env)).not.toThrow();
  });

  it("accepts a module with no functions", () => {
    const env = makeEnvelope();
    expect(() => checkPurity(env)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Reject case 1: forbidden_import — via module.imports[]
// ---------------------------------------------------------------------------

describe("checkPurity — forbidden_import via module.imports[]", () => {
  it("rejects a function when module imports os", () => {
    const env = makeEnvelope(
      { imports: [{ kind: "import", module: "os", name: "os" }] },
      pureFn("impure_fn"),
    );
    expect(() => checkPurity(env)).toThrow(ImpureFunctionError);
  });

  it("rejects when module imports sys", () => {
    const env = makeEnvelope(
      { imports: [{ kind: "from", module: "sys", name: "argv" }] },
      pureFn("read_args"),
    );
    try {
      checkPurity(env);
      expect.unreachable("should throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ImpureFunctionError);
      expect((err as ImpureFunctionError).kind).toBe("forbidden_import");
      expect((err as ImpureFunctionError).detail).toContain("sys");
    }
  });

  it("rejects when module imports requests", () => {
    const env = makeEnvelope(
      { imports: [{ kind: "import", module: "requests", name: "requests" }] },
      pureFn("http_fn"),
    );
    expect(() => checkPurity(env)).toThrow(ImpureFunctionError);
  });

  it("rejects when module imports random", () => {
    const env = makeEnvelope(
      { imports: [{ kind: "import", module: "random", name: "random" }] },
      pureFn("roll_dice"),
    );
    expect(() => checkPurity(env)).toThrow(ImpureFunctionError);
  });

  it("rejects when module imports subprocess", () => {
    const env = makeEnvelope(
      { imports: [{ kind: "import", module: "subprocess", name: "subprocess" }] },
      pureFn("run_cmd"),
    );
    const caught = (() => {
      try {
        checkPurity(env);
        return null;
      } catch (e) {
        return e;
      }
    })();
    expect(caught).toBeInstanceOf(ImpureFunctionError);
    expect((caught as ImpureFunctionError).kind).toBe("forbidden_import");
  });

  it("rejects all modules in the full forbidden list", () => {
    const forbiddenModules = [
      "os",
      "sys",
      "random",
      "datetime",
      "time",
      "subprocess",
      "pathlib",
      "socket",
      "requests",
      "urllib",
      "urllib2",
      "urllib3",
      "http",
      "httpx",
      "aiohttp",
    ];
    for (const mod of forbiddenModules) {
      const env = makeEnvelope(
        { imports: [{ kind: "import", module: mod, name: mod }] },
        pureFn("fn"),
      );
      expect(() => checkPurity(env), `${mod} should be rejected`).toThrow(ImpureFunctionError);
    }
  });
});

// ---------------------------------------------------------------------------
// Reject case 2: forbidden_call — via wire-AST body walk
// ---------------------------------------------------------------------------

describe("checkPurity — forbidden_call via body AST", () => {
  it("rejects a function that calls print()", () => {
    const env = makeEnvelope(
      {},
      {
        ...pureFn("log_it"),
        body: [
          {
            type: "Expr",
            value: {
              type: "Call",
              func: { type: "Name", name: "print" },
              args: [{ type: "String", value: "hello" }],
            },
          },
        ],
      },
    );
    try {
      checkPurity(env);
      expect.unreachable("should throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ImpureFunctionError);
      expect((err as ImpureFunctionError).kind).toBe("forbidden_call");
      expect((err as ImpureFunctionError).detail).toContain("print");
      expect((err as ImpureFunctionError).functionName).toBe("log_it");
    }
  });

  it("rejects a function that calls open()", () => {
    const env = makeEnvelope(
      {},
      {
        ...pureFn("read_file"),
        body: [
          {
            type: "Return",
            value: {
              type: "Call",
              func: { type: "Name", name: "open" },
              args: [{ type: "String", value: "data.txt" }],
            },
          },
        ],
      },
    );
    expect(() => checkPurity(env)).toThrow(ImpureFunctionError);
  });

  it("rejects a function that calls input()", () => {
    const env = makeEnvelope(
      {},
      {
        ...pureFn("ask_user"),
        body: [
          {
            type: "Return",
            value: {
              type: "Call",
              func: { type: "Name", name: "input" },
              args: [{ type: "String", value: "Enter:" }],
            },
          },
        ],
      },
    );
    expect(() => checkPurity(env)).toThrow(ImpureFunctionError);
  });

  it("rejects a function that calls eval()", () => {
    const env = makeEnvelope(
      {},
      {
        ...pureFn("dangerous"),
        body: [
          {
            type: "Return",
            value: {
              type: "Call",
              func: { type: "Name", name: "eval" },
              args: [{ type: "Name", name: "code" }],
            },
          },
        ],
      },
    );
    expect(() => checkPurity(env)).toThrow(ImpureFunctionError);
  });

  it("rejects exec() calls", () => {
    const env = makeEnvelope(
      {},
      {
        ...pureFn("exec_fn"),
        body: [
          {
            type: "Expr",
            value: {
              type: "Call",
              func: { type: "Name", name: "exec" },
              args: [{ type: "Name", name: "script" }],
            },
          },
        ],
      },
    );
    expect(() => checkPurity(env)).toThrow(ImpureFunctionError);
  });
});

// ---------------------------------------------------------------------------
// Reject case 3: forbidden_attr — via wire-AST attribute nodes
// ---------------------------------------------------------------------------

describe("checkPurity — forbidden_attr via body AST", () => {
  it("rejects access to os.environ", () => {
    const env = makeEnvelope(
      {},
      {
        ...pureFn("get_env"),
        body: [
          {
            type: "Return",
            value: {
              type: "Attribute",
              obj: { type: "Name", name: "os" },
              attr: "environ",
            },
          },
        ],
      },
    );
    try {
      checkPurity(env);
      expect.unreachable("should throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ImpureFunctionError);
      expect((err as ImpureFunctionError).kind).toBe("forbidden_attr");
      expect((err as ImpureFunctionError).detail).toContain("os.environ");
    }
  });

  it("rejects access to sys.argv", () => {
    const env = makeEnvelope(
      {},
      {
        ...pureFn("get_args"),
        body: [
          {
            type: "Return",
            value: {
              type: "Attribute",
              obj: { type: "Name", name: "sys" },
              attr: "argv",
            },
          },
        ],
      },
    );
    expect(() => checkPurity(env)).toThrow(ImpureFunctionError);
  });

  it("rejects any attribute access on a forbidden module (general)", () => {
    const env = makeEnvelope(
      {},
      {
        ...pureFn("rand_fn"),
        body: [
          {
            type: "Return",
            value: {
              type: "Attribute",
              obj: { type: "Name", name: "random" },
              attr: "random",
            },
          },
        ],
      },
    );
    expect(() => checkPurity(env)).toThrow(ImpureFunctionError);
  });
});

// ---------------------------------------------------------------------------
// Reject case 4: global_decl — via wire-AST Global nodes
// ---------------------------------------------------------------------------

describe("checkPurity — global_decl via body AST", () => {
  it("rejects a function that declares a global variable", () => {
    const env = makeEnvelope(
      {},
      {
        ...pureFn("mutate_global"),
        body: [
          { type: "Global", names: ["counter"] },
          {
            type: "Assign",
            value: {
              type: "BinaryOp",
              op: "+",
              left: { type: "Name", name: "counter" },
              right: { type: "Integer", value: "1" },
            },
          },
        ],
      },
    );
    try {
      checkPurity(env);
      expect.unreachable("should throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ImpureFunctionError);
      expect((err as ImpureFunctionError).kind).toBe("global_decl");
      expect((err as ImpureFunctionError).detail).toContain("counter");
    }
  });

  it("rejects multiple global declarations", () => {
    const env = makeEnvelope(
      {},
      { ...pureFn("multi_global"), body: [{ type: "Global", names: ["x", "y"] }] },
    );
    const caught = (() => {
      try {
        checkPurity(env);
        return null;
      } catch (e) {
        return e;
      }
    })();
    expect(caught).toBeInstanceOf(ImpureFunctionError);
    expect((caught as ImpureFunctionError).kind).toBe("global_decl");
    expect((caught as ImpureFunctionError).detail).toContain("x");
  });
});

// ---------------------------------------------------------------------------
// Reject case 5: envelope-level impurities[] (Python script extension)
// ---------------------------------------------------------------------------

describe("checkPurity — envelope impurities[] from Python script", () => {
  it("rejects a function whose envelope impurities[] lists a forbidden call", () => {
    const env = makeEnvelope(
      {},
      {
        ...pureFn("env_impure"),
        impurities: [{ kind: "forbidden_call", detail: "calls print()", line: 5, col: 4 }],
      },
    );
    try {
      checkPurity(env);
      expect.unreachable("should throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ImpureFunctionError);
      expect((err as ImpureFunctionError).kind).toBe("forbidden_call");
      expect((err as ImpureFunctionError).line).toBe(5);
      expect((err as ImpureFunctionError).col).toBe(4);
    }
  });

  it("carries line/col from envelope impurity record", () => {
    const env = makeEnvelope(
      {},
      {
        ...pureFn("located"),
        impurities: [{ kind: "forbidden_import", detail: "imports os", line: 1, col: 0 }],
      },
    );
    try {
      checkPurity(env);
      expect.unreachable("should throw");
    } catch (err) {
      expect((err as ImpureFunctionError).line).toBe(1);
      expect((err as ImpureFunctionError).col).toBe(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Error shape and message
// ---------------------------------------------------------------------------

describe("ImpureFunctionError", () => {
  it("constructs with all fields", () => {
    const err = new ImpureFunctionError("my_fn", "forbidden_call", "calls print()", 10, 4);
    expect(err.name).toBe("ImpureFunctionError");
    expect(err.functionName).toBe("my_fn");
    expect(err.kind).toBe("forbidden_call");
    expect(err.detail).toBe("calls print()");
    expect(err.line).toBe(10);
    expect(err.col).toBe(4);
    expect(err.message).toContain("my_fn");
    expect(err.message).toContain("calls print()");
    expect(err.message).toContain("line 10:4");
  });

  it("constructs without location", () => {
    const err = new ImpureFunctionError("f", "global_decl", "declares global x");
    expect(err.line).toBeNull();
    expect(err.col).toBeNull();
    expect(err.message).not.toContain("line");
  });

  it("is instanceof Error and ImpureFunctionError", () => {
    const err = new ImpureFunctionError("f", "forbidden_import", "imports os");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(ImpureFunctionError);
  });
});

// ---------------------------------------------------------------------------
// checkFunctionPurity direct API
// ---------------------------------------------------------------------------

describe("checkFunctionPurity", () => {
  it("accepts a clean function record", () => {
    const fn = pureFn("ok") as unknown as PythonAstNode;
    const module = { type: "Module" } as unknown as PythonAstNode;
    expect(() => checkFunctionPurity(fn, module, "ok")).not.toThrow();
  });

  it("rejects a function record with a forbidden call in body", () => {
    const fn = {
      ...pureFn("bad"),
      body: [
        {
          type: "Expr",
          value: { type: "Call", func: { type: "Name", name: "print" }, args: [] },
        },
      ],
    } as unknown as PythonAstNode;
    const module = { type: "Module" } as unknown as PythonAstNode;
    expect(() => checkFunctionPurity(fn, module, "bad")).toThrow(ImpureFunctionError);
  });
});
