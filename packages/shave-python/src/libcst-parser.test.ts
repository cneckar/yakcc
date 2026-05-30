// SPDX-License-Identifier: MIT
//
// Tests for the libcst subprocess wrapper.
//
// All tests inject a mock spawn implementation so the suite does not require
// Python (or libcst) to be installed.  The mock honors the same lifecycle as
// node:child_process.ChildProcess: emits 'data' on stdout/stderr, then
// 'close' with an exit code, then the promise resolves or rejects.
//
// A future slice (likely slice 4) will add an opt-in integration test gated
// on `process.env.YAKCC_PY` that exercises the real Python interpreter.

import { execSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AdapterSubprocessError,
  type LibcstParseOptions,
  type PythonAstNode,
  type SpawnImpl,
  parsePythonSource,
} from "./libcst-parser.js";

interface MockStream extends EventEmitter {
  end?: (chunk?: string, encoding?: BufferEncoding) => void;
}

interface MockProcess extends EventEmitter {
  readonly stdin: MockStream | null;
  readonly stdout: MockStream | null;
  readonly stderr: MockStream | null;
}

interface MockScript {
  /** Optional bytes to emit on the child's stdout before close. */
  readonly stdout?: string;
  /** Optional bytes to emit on the child's stderr before close. */
  readonly stderr?: string;
  /** Exit code passed to the 'close' event. */
  readonly exitCode: number | null;
  /** When set, the spawn call itself throws synchronously (e.g. ENOENT). */
  readonly spawnThrows?: string;
  /** When set, the child emits 'error' before 'close' (e.g. ENOENT-on-stdin). */
  readonly emitErrorBeforeClose?: string;
}

/** Build a mock spawn that scripts the child's lifecycle. */
function mockSpawn(script: MockScript): SpawnImpl & {
  readonly stdinChunks: string[];
  readonly callCount: () => number;
} {
  const stdinChunks: string[] = [];
  let calls = 0;

  const fn: SpawnImpl = (_command, _args, _options) => {
    calls += 1;
    if (script.spawnThrows !== undefined) {
      throw new Error(script.spawnThrows);
    }
    const stdin: MockStream = new EventEmitter();
    stdin.end = (chunk?: string, _encoding?: BufferEncoding) => {
      if (chunk !== undefined) stdinChunks.push(chunk);
    };
    const stdout: MockStream = new EventEmitter();
    const stderr: MockStream = new EventEmitter();
    const child: MockProcess = Object.assign(new EventEmitter(), {
      stdin,
      stdout,
      stderr,
    });

    // Schedule the lifecycle on the next microtask so the caller has time to
    // attach 'data'/'close' listeners before they fire.
    queueMicrotask(() => {
      if (script.stdout !== undefined) {
        stdout.emit("data", Buffer.from(script.stdout, "utf-8"));
      }
      if (script.stderr !== undefined) {
        stderr.emit("data", Buffer.from(script.stderr, "utf-8"));
      }
      if (script.emitErrorBeforeClose !== undefined) {
        child.emit("error", new Error(script.emitErrorBeforeClose));
        return;
      }
      child.emit("close", script.exitCode);
    });

    return child as unknown as ReturnType<typeof import("node:child_process").spawn>;
  };

  return Object.assign(fn, {
    stdinChunks,
    callCount: () => calls,
  });
}

function makeOpts(spawnImpl: SpawnImpl): LibcstParseOptions {
  return {
    pythonExecutable: "python3-fake",
    scriptPath: "/fake/scripts/libcst-parse.py",
    spawnImpl,
  };
}

describe("parsePythonSource (#782 slice 1)", () => {
  let savedYakccPy: string | undefined;

  beforeEach(() => {
    savedYakccPy = process.env.YAKCC_PY;
    // biome-ignore lint/performance/noDelete: process.env requires delete to truly unset
    delete process.env.YAKCC_PY;
  });

  afterEach(() => {
    if (savedYakccPy === undefined) {
      // biome-ignore lint/performance/noDelete: process.env requires delete to truly unset
      delete process.env.YAKCC_PY;
    } else {
      process.env.YAKCC_PY = savedYakccPy;
    }
  });

  it("returns the parsed envelope on a successful subprocess run", async () => {
    const envelope = { version: 1, module: { type: "Module", stmt_count: 2 } };
    const spawnFn = mockSpawn({ stdout: JSON.stringify(envelope), exitCode: 0 });
    const result = await parsePythonSource("def f(): pass", makeOpts(spawnFn));
    expect(result.version).toBe(1);
    expect(result.module.type).toBe("Module");
    expect((result.module as { stmt_count?: number }).stmt_count).toBe(2);
    expect(spawnFn.callCount()).toBe(1);
    expect(spawnFn.stdinChunks).toEqual(["def f(): pass"]);
  });

  it("rejects with AdapterSubprocessError when exit code is non-zero", async () => {
    const spawnFn = mockSpawn({
      stderr: "libcst is not installed: No module named 'libcst'",
      exitCode: 1,
    });
    await expect(parsePythonSource("def f(): pass", makeOpts(spawnFn))).rejects.toMatchObject({
      name: "AdapterSubprocessError",
      exitCode: 1,
    });
  });

  it("includes the remediation hint when libcst is missing", async () => {
    const spawnFn = mockSpawn({ stderr: "ImportError: No module named 'libcst'", exitCode: 1 });
    try {
      await parsePythonSource("def f(): pass", makeOpts(spawnFn));
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(AdapterSubprocessError);
      expect((err as Error).message).toContain("pip install libcst");
    }
  });

  it("rejects when stdout is not valid JSON", async () => {
    const spawnFn = mockSpawn({ stdout: "this is not json", exitCode: 0 });
    await expect(parsePythonSource("def f(): pass", makeOpts(spawnFn))).rejects.toMatchObject({
      name: "AdapterSubprocessError",
    });
  });

  it("rejects when the JSON envelope has the wrong schema version", async () => {
    const spawnFn = mockSpawn({ stdout: JSON.stringify({ version: 2 }), exitCode: 0 });
    await expect(parsePythonSource("def f(): pass", makeOpts(spawnFn))).rejects.toThrow(
      /schema version must be 1/,
    );
  });

  it("rejects when the JSON envelope is missing the module field", async () => {
    const spawnFn = mockSpawn({ stdout: JSON.stringify({ version: 1 }), exitCode: 0 });
    await expect(parsePythonSource("def f(): pass", makeOpts(spawnFn))).rejects.toThrow(
      /"module" must be a non-null object/,
    );
  });

  it("rejects when spawn itself throws (python not on PATH)", async () => {
    const spawnFn = mockSpawn({ spawnThrows: "ENOENT: python3 not found", exitCode: 0 });
    await expect(parsePythonSource("def f(): pass", makeOpts(spawnFn))).rejects.toMatchObject({
      name: "AdapterSubprocessError",
    });
  });

  it("rejects when the child emits an error event before close", async () => {
    const spawnFn = mockSpawn({
      emitErrorBeforeClose: "EPIPE: broken pipe",
      exitCode: 0,
    });
    await expect(parsePythonSource("def f(): pass", makeOpts(spawnFn))).rejects.toMatchObject({
      name: "AdapterSubprocessError",
    });
  });

  it("respects YAKCC_PY env var as the python executable override", async () => {
    process.env.YAKCC_PY = "/custom/python";
    let capturedCmd = "";
    const spawnFn: SpawnImpl = (command, _args) => {
      capturedCmd = command;
      const child = mockSpawn({
        stdout: JSON.stringify({ version: 1, module: { type: "Module" } }),
        exitCode: 0,
      })(command, _args);
      return child;
    };
    // Note: not passing pythonExecutable in opts — should fall through to YAKCC_PY.
    await parsePythonSource("pass", { spawnImpl: spawnFn, scriptPath: "/fake/x.py" });
    expect(capturedCmd).toBe("/custom/python");
  });
});

// ---------------------------------------------------------------------------
// WI-875: floor-divide // emission (REGRESSION — real Python subprocess)
// ---------------------------------------------------------------------------

describe("WI-875: floor-divide // emission (REGRESSION — real Python subprocess)", () => {
  const pythonAvailable = (() => {
    try {
      execSync("python3 -c 'import libcst'", { stdio: "pipe" });
      return true;
    } catch {
      return false;
    }
  })();

  if (!pythonAvailable) {
    it.skip("requires python3 with libcst installed (skipped)", () => {});
  } else {
    it("emits FloorDivide as a // BinaryOp wire node", async () => {
      const source = "def divmod_int(a: int, b: int) -> int:\n    return a // b\n";
      const result = await parsePythonSource(source);
      const fn = (result.module.functions as PythonAstNode[])[0] as PythonAstNode;
      const ret = (fn.body as PythonAstNode[])[0] as PythonAstNode;
      expect(ret.type).toBe("Return");
      expect((ret.value as PythonAstNode).type).toBe("BinaryOp");
      expect((ret.value as PythonAstNode).op).toBe("//");
    });
  }
});

// ---------------------------------------------------------------------------
// WI-888: Docstring + ImpureStatement emission (real Python subprocess)
// ---------------------------------------------------------------------------

describe("WI-888: Docstring + ImpureStatement emission (real Python subprocess)", () => {
  const pythonAvailable = (() => {
    try {
      execSync("python3 -c 'import libcst'", { stdio: "pipe" });
      return true;
    } catch {
      return false;
    }
  })();

  if (!pythonAvailable) {
    it.skip("requires python3 with libcst installed (skipped)", () => {});
  } else {
    it("emits Docstring wire node for a PEP-257 docstring as first body stmt", async () => {
      const source =
        'def greeter(name: str) -> str:\n    """Return a greeting string."""\n    return f"Hello, {name}"\n';
      const result = await parsePythonSource(source);
      const fn = (result.module.functions as PythonAstNode[])[0] as PythonAstNode;
      const body = fn.body as PythonAstNode[];
      // First statement should be Docstring
      expect(body.length).toBeGreaterThanOrEqual(1);
      expect(body[0]?.type).toBe("Docstring");
      expect(typeof (body[0] as { value?: unknown }).value).toBe("string");
      expect((body[0] as { value?: string }).value).toContain("greeting");
    });

    it("emits ImpureStatement(bare_call) for a bare print() call in a function body", async () => {
      // def log_it(x: int) -> None:
      //     print(x)
      const source = "def log_it(x: int) -> None:\n    print(x)\n";
      const result = await parsePythonSource(source);
      const fn = (result.module.functions as PythonAstNode[])[0] as PythonAstNode;
      const body = fn.body as PythonAstNode[];
      expect(body.length).toBeGreaterThanOrEqual(1);
      const stmt = body[0] as PythonAstNode;
      expect(stmt.type).toBe("ImpureStatement");
      expect((stmt as { construct?: string }).construct).toBe("bare_call");
      expect((stmt as { detail?: string }).detail).toContain("print");
    });

    it("does NOT emit Docstring for a string in non-first position (bare_expression instead)", async () => {
      // def mixed(x: int) -> int:
      //     x + 1     # bare expression at position 0 -> ImpureStatement
      //     "not a docstring"  # string at non-first position -> ImpureStatement
      //     return x
      const source = "def mixed(x: int) -> int:\n    x + 1\n    return x\n";
      const result = await parsePythonSource(source);
      const fn = (result.module.functions as PythonAstNode[])[0] as PythonAstNode;
      const body = fn.body as PythonAstNode[];
      // First stmt is x + 1 — not a string-literal, so ImpureStatement(bare_expression)
      expect(body[0]?.type).toBe("ImpureStatement");
      expect((body[0] as { construct?: string }).construct).toBe("bare_expression");
    });

    it("emits Docstring wire node for a triple-quoted docstring", async () => {
      const source =
        'def triple(x: int) -> int:\n    """Triple-quoted doc.\n    Multiline.\n    """\n    return x\n';
      const result = await parsePythonSource(source);
      const fn = (result.module.functions as PythonAstNode[])[0] as PythonAstNode;
      const body = fn.body as PythonAstNode[];
      expect(body[0]?.type).toBe("Docstring");
    });
  }
});

// ---------------------------------------------------------------------------
// WI-903: If statement emission (real Python subprocess)
// ---------------------------------------------------------------------------

describe("WI-903: If statement emission (real Python subprocess)", () => {
  const pythonAvailable = (() => {
    try {
      execSync("python3 -c 'import libcst'", { stdio: "pipe" });
      return true;
    } catch {
      return false;
    }
  })();

  if (!pythonAvailable) {
    it.skip("requires python3 with libcst installed (skipped)", () => {});
  } else {
    it("emits If wire node for a simple if-only statement", async () => {
      const source = "def check(x: int) -> int:\n    if x > 0:\n        return x\n    return 0\n";
      const result = await parsePythonSource(source);
      const fn = (result.module.functions as PythonAstNode[])[0] as PythonAstNode;
      const body = fn.body as PythonAstNode[];
      // First statement is the if
      expect(body[0]?.type).toBe("If");
      const ifStmt = body[0] as PythonAstNode;
      // test is a BinaryOp (x > 0)
      expect((ifStmt.test as PythonAstNode).type).toBe("BinaryOp");
      expect((ifStmt.test as PythonAstNode).op).toBe(">");
      // body contains a Return
      expect(Array.isArray(ifStmt.body)).toBe(true);
      expect((ifStmt.body as PythonAstNode[])[0]?.type).toBe("Return");
      // orelse is empty
      expect(Array.isArray(ifStmt.orelse)).toBe(true);
      expect((ifStmt.orelse as PythonAstNode[]).length).toBe(0);
    });

    it("emits If with orelse for if/else", async () => {
      const source =
        "def sign(x: int) -> int:\n    if x >= 0:\n        return 1\n    else:\n        return -1\n";
      const result = await parsePythonSource(source);
      const fn = (result.module.functions as PythonAstNode[])[0] as PythonAstNode;
      const body = fn.body as PythonAstNode[];
      expect(body[0]?.type).toBe("If");
      const ifStmt = body[0] as PythonAstNode;
      // orelse is a flat list with a Return
      expect(Array.isArray(ifStmt.orelse)).toBe(true);
      expect((ifStmt.orelse as PythonAstNode[]).length).toBe(1);
      expect((ifStmt.orelse as PythonAstNode[])[0]?.type).toBe("Return");
    });

    it("emits nested If in orelse for if/elif/else (Python AST convention)", async () => {
      const source =
        "def classify(x: int) -> int:\n    if x > 0:\n        return 1\n    elif x < 0:\n        return -1\n    else:\n        return 0\n";
      const result = await parsePythonSource(source);
      const fn = (result.module.functions as PythonAstNode[])[0] as PythonAstNode;
      const body = fn.body as PythonAstNode[];
      const ifStmt = body[0] as PythonAstNode;
      expect(ifStmt.type).toBe("If");
      // elif: orelse is a single-element list containing an If node
      expect((ifStmt.orelse as PythonAstNode[]).length).toBe(1);
      const elifNode = (ifStmt.orelse as PythonAstNode[])[0] as PythonAstNode;
      expect(elifNode.type).toBe("If");
      // The elif's orelse is a flat list (the else block)
      expect((elifNode.orelse as PythonAstNode[]).length).toBe(1);
      expect((elifNode.orelse as PythonAstNode[])[0]?.type).toBe("Return");
    });
  }
});

// ---------------------------------------------------------------------------
// WI-904: Comprehension emission (real Python subprocess)
// ---------------------------------------------------------------------------

describe("WI-904: Comprehension emission (real Python subprocess)", () => {
  const pythonAvailable = (() => {
    try {
      execSync("python3 -c 'import libcst'", { stdio: "pipe" });
      return true;
    } catch {
      return false;
    }
  })();

  if (!pythonAvailable) {
    it.skip("requires python3 with libcst installed (skipped)", () => {});
  } else {
    it("emits ListComp map node for [f(x) for x in xs]", async () => {
      const source = "def double_all(xs: list) -> list:\n    return [x * 2 for x in xs]\n";
      const result = await parsePythonSource(source);
      const fn = (result.module.functions as PythonAstNode[])[0] as PythonAstNode;
      const ret = (fn.body as PythonAstNode[])[0] as PythonAstNode;
      expect(ret.type).toBe("Return");
      const comp = ret.value as PythonAstNode;
      expect(comp.type).toBe("ListComp");
      expect(comp.kind).toBe("map");
      expect(comp.param).toBe("x");
    });

    it("emits ListComp filter node for [x for x in xs if cond]", async () => {
      const source = "def keep_positive(xs: list) -> list:\n    return [x for x in xs if x > 0]\n";
      const result = await parsePythonSource(source);
      const fn = (result.module.functions as PythonAstNode[])[0] as PythonAstNode;
      const ret = (fn.body as PythonAstNode[])[0] as PythonAstNode;
      const comp = ret.value as PythonAstNode;
      expect(comp.type).toBe("ListComp");
      expect(comp.kind).toBe("filter");
      expect(comp.param).toBe("x");
      // cond is a BinaryOp (x > 0)
      expect((comp.cond as PythonAstNode).type).toBe("BinaryOp");
    });

    it("emits GeneratorExp map node for (f(x) for x in xs)", async () => {
      const source = "def gen_doubled(xs: list) -> list:\n    return list(x * 2 for x in xs)\n";
      const result = await parsePythonSource(source);
      const fn = (result.module.functions as PythonAstNode[])[0] as PythonAstNode;
      const ret = (fn.body as PythonAstNode[])[0] as PythonAstNode;
      // Return value is a Call (list(...))
      expect(ret.type).toBe("Return");
      const callNode = ret.value as PythonAstNode;
      expect(callNode.type).toBe("Call");
      // The single arg is the GeneratorExp
      const genArg = (callNode.args as PythonAstNode[])[0] as PythonAstNode;
      expect(genArg.type).toBe("GeneratorExp");
      expect(genArg.kind).toBe("map");
    });

    it("emits DictComp wire node for {k: v for k in keys}", async () => {
      const source = "def invert(keys: list) -> dict:\n    return {k: 1 for k in keys}\n";
      const result = await parsePythonSource(source);
      const fn = (result.module.functions as PythonAstNode[])[0] as PythonAstNode;
      const ret = (fn.body as PythonAstNode[])[0] as PythonAstNode;
      const comp = ret.value as PythonAstNode;
      expect(comp.type).toBe("DictComp");
      expect(comp.param).toBe("k");
      expect(comp.cond).toBeNull();
    });

    it("emits SetComp map node for {f(x) for x in xs}", async () => {
      const source = "def unique_doubled(xs: list) -> set:\n    return {x * 2 for x in xs}\n";
      const result = await parsePythonSource(source);
      const fn = (result.module.functions as PythonAstNode[])[0] as PythonAstNode;
      const ret = (fn.body as PythonAstNode[])[0] as PythonAstNode;
      const comp = ret.value as PythonAstNode;
      expect(comp.type).toBe("SetComp");
      expect(comp.kind).toBe("map");
      expect(comp.param).toBe("x");
    });
  }
});

// ---------------------------------------------------------------------------
// WI-907: Assign statement emission (real Python subprocess)
// ---------------------------------------------------------------------------

describe("WI-907: Assign emission (real Python subprocess)", () => {
  const pythonAvailable = (() => {
    try {
      execSync("python3 -c 'import libcst'", { stdio: "pipe" });
      return true;
    } catch {
      return false;
    }
  })();

  if (!pythonAvailable) {
    it.skip("requires python3 with libcst installed (skipped)", () => {});
  } else {
    it("emits Assign wire node for `y = x + 1` in function body", async () => {
      // def add_one(x: int) -> int:
      //     y = x + 1
      //     return y
      const source = "def add_one(x: int) -> int:\n    y = x + 1\n    return y\n";
      const result = await parsePythonSource(source);
      const fn = (result.module.functions as PythonAstNode[])[0] as PythonAstNode;
      const body = fn.body as PythonAstNode[];
      expect(body.length).toBeGreaterThanOrEqual(2);
      // First stmt is Assign
      const assignStmt = body[0] as PythonAstNode;
      expect(assignStmt.type).toBe("Assign");
      expect((assignStmt as { target?: string }).target).toBe("y");
      // value is a BinaryOp (x + 1)
      const val = (assignStmt as { value?: PythonAstNode }).value as PythonAstNode;
      expect(val.type).toBe("BinaryOp");
      expect((val as { op?: string }).op).toBe("+");
      // Second stmt is Return
      expect(body[1]?.type).toBe("Return");
    });

    it("emits Assign wire node for string assignment `rewritten = name.replace(...)`", async () => {
      // def get_attr(name: str) -> str:
      //     rewritten = name.replace("Name", "OtherName")
      //     return rewritten
      const source =
        'def get_attr(name: str) -> str:\n    rewritten = name.replace("Name", "OtherName")\n    return rewritten\n';
      const result = await parsePythonSource(source);
      const fn = (result.module.functions as PythonAstNode[])[0] as PythonAstNode;
      const body = fn.body as PythonAstNode[];
      const assignStmt = body[0] as PythonAstNode;
      expect(assignStmt.type).toBe("Assign");
      expect((assignStmt as { target?: string }).target).toBe("rewritten");
      // value is a Call node
      const val = (assignStmt as { value?: PythonAstNode }).value as PythonAstNode;
      expect(val.type).toBe("Call");
      // Second stmt is Return
      expect(body[1]?.type).toBe("Return");
    });
  }
});

// ---------------------------------------------------------------------------
// WI-908: BoolOp emission (real Python subprocess)
// ---------------------------------------------------------------------------

describe("WI-908: BoolOp emission (real Python subprocess)", () => {
  const pythonAvailable = (() => {
    try {
      execSync("python3 -c 'import libcst'", { stdio: "pipe" });
      return true;
    } catch {
      return false;
    }
  })();

  if (!pythonAvailable) {
    it.skip("requires python3 with libcst installed (skipped)", () => {});
  } else {
    it("emits BoolOp(and) for `x and y` in a return statement", async () => {
      const source = "def both(x: bool, y: bool) -> bool:\n    return x and y\n";
      const result = await parsePythonSource(source);
      const fn = (result.module.functions as PythonAstNode[])[0] as PythonAstNode;
      const ret = (fn.body as PythonAstNode[])[0] as PythonAstNode;
      expect(ret.type).toBe("Return");
      const val = ret.value as PythonAstNode;
      expect(val.type).toBe("BoolOp");
      expect((val as { op?: string }).op).toBe("and");
      expect(((val as { left?: PythonAstNode }).left as PythonAstNode).type).toBe("Name");
      expect(((val as { right?: PythonAstNode }).right as PythonAstNode).type).toBe("Name");
    });

    it("emits BoolOp(or) for `a or b` in a return statement", async () => {
      const source = "def either(a: bool, b: bool) -> bool:\n    return a or b\n";
      const result = await parsePythonSource(source);
      const fn = (result.module.functions as PythonAstNode[])[0] as PythonAstNode;
      const ret = (fn.body as PythonAstNode[])[0] as PythonAstNode;
      expect(ret.type).toBe("Return");
      const val = ret.value as PythonAstNode;
      expect(val.type).toBe("BoolOp");
      expect((val as { op?: string }).op).toBe("or");
    });

    it("emits nested BoolOp for chained `a and b and c`", async () => {
      // Python AST / libcst represents `a and b and c` as BoolOp(BoolOp(a, and, b), and, c)
      const source =
        "def all_three(a: bool, b: bool, c: bool) -> bool:\n    return a and b and c\n";
      const result = await parsePythonSource(source);
      const fn = (result.module.functions as PythonAstNode[])[0] as PythonAstNode;
      const ret = (fn.body as PythonAstNode[])[0] as PythonAstNode;
      expect(ret.type).toBe("Return");
      const outer = ret.value as PythonAstNode;
      expect(outer.type).toBe("BoolOp");
      expect((outer as { op?: string }).op).toBe("and");
      // The left operand is itself a BoolOp (a and b)
      const inner = (outer as { left?: PythonAstNode }).left as PythonAstNode;
      expect(inner.type).toBe("BoolOp");
      expect((inner as { op?: string }).op).toBe("and");
    });
  }
});

// ---------------------------------------------------------------------------
// WI-909: Comprehension tuple-target emission (real Python subprocess)
// ---------------------------------------------------------------------------

describe("WI-909: Comprehension tuple-target emission (real Python subprocess)", () => {
  const pythonAvailable = (() => {
    try {
      execSync("python3 -c 'import libcst'", { stdio: "pipe" });
      return true;
    } catch {
      return false;
    }
  })();

  if (!pythonAvailable) {
    it.skip("requires python3 with libcst installed (skipped)", () => {});
  } else {
    it("emits ListComp with target_kind:tuple and target_names for `[k for k, v in items]`", async () => {
      const source = "def get_keys(items: list) -> list:\n    return [k for k, v in items]\n";
      const result = await parsePythonSource(source);
      const fn = (result.module.functions as PythonAstNode[])[0] as PythonAstNode;
      const ret = (fn.body as PythonAstNode[])[0] as PythonAstNode;
      expect(ret.type).toBe("Return");
      const comp = ret.value as PythonAstNode;
      expect(comp.type).toBe("ListComp");
      expect((comp as { target_kind?: string }).target_kind).toBe("tuple");
      expect((comp as { target_names?: string[] }).target_names).toEqual(["k", "v"]);
      // param is set to joined names for backward compat
      expect((comp as { param?: string }).param).toBe("k, v");
    });

    it("emits DictComp with target_kind:tuple for `{v: k for k, v in items}`", async () => {
      const source = "def invert_dict(items: list) -> dict:\n    return {v: k for k, v in items}\n";
      const result = await parsePythonSource(source);
      const fn = (result.module.functions as PythonAstNode[])[0] as PythonAstNode;
      const ret = (fn.body as PythonAstNode[])[0] as PythonAstNode;
      expect(ret.type).toBe("Return");
      const comp = ret.value as PythonAstNode;
      expect(comp.type).toBe("DictComp");
      expect((comp as { target_kind?: string }).target_kind).toBe("tuple");
      expect((comp as { target_names?: string[] }).target_names).toEqual(["k", "v"]);
      expect((comp as { param?: string }).param).toBe("k, v");
      // cond is null — no if-clause
      expect((comp as { cond?: unknown }).cond).toBeNull();
    });

    it("emits GeneratorExp with target_kind:tuple for `(v, k) for k, v in items`", async () => {
      // dict((v, k) for k, v in items) — the _invert pattern from bs4
      const source =
        "def invert(d: dict) -> dict:\n    return dict((v, k) for k, v in list(d.items()))\n";
      const result = await parsePythonSource(source);
      const fn = (result.module.functions as PythonAstNode[])[0] as PythonAstNode;
      const ret = (fn.body as PythonAstNode[])[0] as PythonAstNode;
      expect(ret.type).toBe("Return");
      // Return value is Call(dict, [GeneratorExp])
      const callNode = ret.value as PythonAstNode;
      expect(callNode.type).toBe("Call");
      const genArg = (
        (callNode as { args?: PythonAstNode[] }).args as PythonAstNode[]
      )[0] as PythonAstNode;
      expect(genArg.type).toBe("GeneratorExp");
      expect((genArg as { target_kind?: string }).target_kind).toBe("tuple");
      expect((genArg as { target_names?: string[] }).target_names).toEqual(["k", "v"]);
      expect((genArg as { kind?: string }).kind).toBe("map");
    });
  }
});

// ---------------------------------------------------------------------------
// WI-905: Nested FunctionDef → ImpureStatement(nested_function) emission
// (real Python subprocess)
// ---------------------------------------------------------------------------

describe("WI-905: nested FunctionDef emission (real Python subprocess)", () => {
  const pythonAvailable = (() => {
    try {
      execSync("python3 -c 'import libcst'", { stdio: "pipe" });
      return true;
    } catch {
      return false;
    }
  })();

  if (!pythonAvailable) {
    it.skip("requires python3 with libcst installed (skipped)", () => {});
  } else {
    it("emits ImpureStatement(nested_function) for a nested def inside a function body", async () => {
      // def outer(x: int) -> int:
      //     def inner(y: int) -> int:
      //         return y + 1
      //     return inner(x)
      const source = [
        "def outer(x: int) -> int:",
        "    def inner(y: int) -> int:",
        "        return y + 1",
        "    return inner(x)",
        "",
      ].join("\n");
      const result = await parsePythonSource(source);
      const fn = (result.module.functions as PythonAstNode[])[0] as PythonAstNode;
      const body = fn.body as PythonAstNode[];
      // First statement is ImpureStatement(nested_function), not Unsupported
      expect(body.length).toBeGreaterThanOrEqual(1);
      const stmt = body[0] as PythonAstNode;
      expect(stmt.type).toBe("ImpureStatement");
      expect((stmt as { construct?: string }).construct).toBe("nested_function");
      // detail mentions the inner function name and the clear closure message
      const detail = (stmt as { detail?: string }).detail ?? "";
      expect(detail).toContain("inner");
      expect(detail).toContain("nested function definition (closure)");
      expect(detail).toContain("refactor to module-level");
    });

    it("emits ImpureStatement(nested_function) — NOT Unsupported — for nested def", async () => {
      // Regression: before WI-905 this emitted {"type":"Unsupported","reason":"FunctionDef"}.
      // After WI-905 it must be ImpureStatement so raise-body throws ImpureFunctionError,
      // not the opaque UnsupportedAstError.
      const source = [
        "def wrapper(n: int) -> int:",
        "    def helper(x: int) -> int:",
        "        return x * 2",
        "    return helper(n)",
        "",
      ].join("\n");
      const result = await parsePythonSource(source);
      const fn = (result.module.functions as PythonAstNode[])[0] as PythonAstNode;
      const body = fn.body as PythonAstNode[];
      const stmt = body[0] as PythonAstNode;
      // Must not be Unsupported
      expect(stmt.type).not.toBe("Unsupported");
      expect(stmt.type).toBe("ImpureStatement");
      expect((stmt as { construct?: string }).construct).toBe("nested_function");
    });
  }
});

// ---------------------------------------------------------------------------
// WI-890: Class method extraction (real Python subprocess)
// ---------------------------------------------------------------------------

describe("WI-890: class method extraction (real Python subprocess)", () => {
  const pythonAvailable = (() => {
    try {
      execSync("python3 -c 'import libcst'", { stdio: "pipe" });
      return true;
    } catch {
      return false;
    }
  })();

  if (!pythonAvailable) {
    it.skip("requires python3 with libcst installed (skipped)", () => {});
  } else {
    // Production sequence: python subprocess → wire envelope → module.functions[]
    // Class body methods emitted with dotted names and methodKind field.

    it("emits @staticmethod with methodKind='static' and dotted name", async () => {
      const source = [
        "class Calc:",
        "    @staticmethod",
        "    def add(a: int, b: int) -> int:",
        "        return a + b",
        "",
      ].join("\n");
      const result = await parsePythonSource(source);
      const fns = result.module.functions as PythonAstNode[];
      expect(fns).toHaveLength(1);
      const fn = fns[0] as PythonAstNode;
      expect((fn as { name?: string }).name).toBe("Calc.add");
      expect((fn as { methodKind?: string }).methodKind).toBe("static");
    });

    it("emits @classmethod with methodKind='class' and dotted name", async () => {
      const source = [
        "class Factory:",
        "    @classmethod",
        "    def create(cls, value: int) -> int:",
        "        return value",
        "",
      ].join("\n");
      const result = await parsePythonSource(source);
      const fns = result.module.functions as PythonAstNode[];
      expect(fns).toHaveLength(1);
      const fn = fns[0] as PythonAstNode;
      expect((fn as { name?: string }).name).toBe("Factory.create");
      expect((fn as { methodKind?: string }).methodKind).toBe("class");
    });

    it("emits regular def(self,...) with methodKind='instance' and dotted name", async () => {
      const source = [
        "class Counter:",
        "    def increment(self, n: int) -> int:",
        "        return n + 1",
        "",
      ].join("\n");
      const result = await parsePythonSource(source);
      const fns = result.module.functions as PythonAstNode[];
      expect(fns).toHaveLength(1);
      const fn = fns[0] as PythonAstNode;
      expect((fn as { name?: string }).name).toBe("Counter.increment");
      expect((fn as { methodKind?: string }).methodKind).toBe("instance");
    });

    it("module-level functions have NO methodKind field (byte-equivalence preserved)", async () => {
      const source = "def plain(x: int) -> int:\n    return x\n";
      const result = await parsePythonSource(source);
      const fns = result.module.functions as PythonAstNode[];
      expect(fns).toHaveLength(1);
      const fn = fns[0] as PythonAstNode;
      expect((fn as { name?: string }).name).toBe("plain");
      // methodKind must be absent (undefined) for module-level fns
      expect((fn as { methodKind?: unknown }).methodKind).toBeUndefined();
    });

    it("class with all three method kinds emits three envelope entries in body order", async () => {
      // Compound production sequence: one class with @staticmethod, @classmethod, regular def.
      // Verifies all three are emitted with correct names and kinds in a single call.
      const source = [
        "class Trio:",
        "    @staticmethod",
        "    def s_method(x: int) -> int:",
        "        return x",
        "    @classmethod",
        "    def c_method(cls, x: int) -> int:",
        "        return x",
        "    def i_method(self, x: int) -> int:",
        "        return x",
        "",
      ].join("\n");
      const result = await parsePythonSource(source);
      const fns = result.module.functions as PythonAstNode[];
      expect(fns).toHaveLength(3);
      const names = fns.map((f) => (f as { name?: string }).name);
      const kinds = fns.map((f) => (f as { methodKind?: string }).methodKind);
      expect(names).toEqual(["Trio.s_method", "Trio.c_method", "Trio.i_method"]);
      expect(kinds).toEqual(["static", "class", "instance"]);
    });

    it("module-level fns and class methods coexist in module.functions[]", async () => {
      // Verifies that module-level functions appear before class methods in the
      // functions array (module-level first, then class bodies in order).
      const source = [
        "def top_level(x: int) -> int:",
        "    return x",
        "",
        "class MyClass:",
        "    @staticmethod",
        "    def my_method(y: int) -> int:",
        "        return y",
        "",
      ].join("\n");
      const result = await parsePythonSource(source);
      const fns = result.module.functions as PythonAstNode[];
      expect(fns).toHaveLength(2);
      expect((fns[0] as { name?: string }).name).toBe("top_level");
      expect((fns[0] as { methodKind?: unknown }).methodKind).toBeUndefined();
      expect((fns[1] as { name?: string }).name).toBe("MyClass.my_method");
      expect((fns[1] as { methodKind?: string }).methodKind).toBe("static");
    });
  }
});

// ---------------------------------------------------------------------------
// WI-934: module.classes[] structural envelope (real Python subprocess)
// ---------------------------------------------------------------------------

describe("WI-934: module.classes[] structural envelope (real Python subprocess)", () => {
  const pythonAvailable = (() => {
    try {
      execSync("python3 -c 'import libcst'", { stdio: "pipe" });
      return true;
    } catch {
      return false;
    }
  })();

  if (!pythonAvailable) {
    it.skip("requires python3 with libcst installed (skipped)", () => {});
  } else {
    it("emits module.classes[] with name, init_params, init_assignments, methods for a class fixture", async () => {
      // Canonical EmailValidator class from the WI-934 issue body.
      // Verifies that libcst-parse.py emits the module.classes[] structural array.
      const source = [
        "class EmailValidator:",
        "    def __init__(self, max_length: int):",
        "        self.max_length = max_length",
        "",
        "    def validate(self, email: str) -> bool:",
        "        if len(email) > self.max_length:",
        "            return False",
        "        return True",
        "",
      ].join("\n");
      const result = await parsePythonSource(source);
      const classes = (result.module as unknown as { classes?: PythonAstNode[] }).classes ?? [];
      expect(classes).toHaveLength(1);
      const cls = classes[0] as PythonAstNode;
      expect((cls as { name?: string }).name).toBe("EmailValidator");
      // init_params: max_length: int
      const initParams = (cls as { init_params?: PythonAstNode[] }).init_params ?? [];
      expect(initParams).toHaveLength(1);
      expect((initParams[0] as { name?: string }).name).toBe("max_length");
      expect((initParams[0] as { annotation?: string }).annotation).toBe("int");
      // init_assignments: self.max_length = max_length
      const initAssignments =
        (cls as { init_assignments?: PythonAstNode[] }).init_assignments ?? [];
      expect(initAssignments).toHaveLength(1);
      expect((initAssignments[0] as { target?: string }).target).toBe("max_length");
      // methods: validate
      const methods = (cls as { methods?: PythonAstNode[] }).methods ?? [];
      expect(methods).toHaveLength(1);
      expect((methods[0] as { name?: string }).name).toBe("validate");
      expect((methods[0] as { methodKind?: string }).methodKind).toBe("instance");
      expect((methods[0] as { return_annotation?: string }).return_annotation).toBe("bool");
      // raise_blockers: none for this simple class
      const raiseblockers = (cls as { raise_blockers?: unknown[] }).raise_blockers ?? [];
      expect(raiseblockers).toHaveLength(0);
    });

    it("emits module.classes:[] (empty) for a module-only fixture — module.functions[] unchanged", async () => {
      // Verifies WI-934 additive contract: module.functions[] is byte-equivalent for
      // existing callers when no classes are present.
      const source = "def plain(x: int) -> int:\n    return x\n";
      const result = await parsePythonSource(source);
      // module.classes[] must be present and empty
      const classes = (result.module as unknown as { classes?: unknown[] }).classes;
      expect(Array.isArray(classes)).toBe(true);
      expect(classes).toHaveLength(0);
      // module.functions[] must still contain the function (unchanged)
      const fns = result.module.functions as PythonAstNode[];
      expect(fns).toHaveLength(1);
      expect((fns[0] as { name?: string }).name).toBe("plain");
      expect((fns[0] as { methodKind?: unknown }).methodKind).toBeUndefined();
    });

    it("compound: class with raise_blockers emits them in module.classes[]", async () => {
      // A class with a metaclass — Python-side detection emits raise_blockers.
      const source = [
        "class Meta(type):",
        "    pass",
        "",
        "class MyModel(metaclass=Meta):",
        "    def __init__(self, x: int):",
        "        self.x = x",
        "",
      ].join("\n");
      const result = await parsePythonSource(source);
      const classes = (result.module as unknown as { classes?: PythonAstNode[] }).classes ?? [];
      // Two classes emitted: Meta and MyModel
      expect(classes.length).toBeGreaterThanOrEqual(1);
      // Find MyModel
      const myModel = classes.find((c) => (c as { name?: string }).name === "MyModel");
      expect(myModel).toBeDefined();
      // raise_blockers is string[] (e.g. "metaclass", "non_trivial_base")
      const blockers = (myModel as { raise_blockers?: string[] }).raise_blockers ?? [];
      expect(blockers.length).toBeGreaterThanOrEqual(1);
      // At least one blocker should be "metaclass"
      expect(blockers).toContain("metaclass");
    });
  }
});
