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
      const fn = (result.module as any).functions[0];
      const ret = fn.body[0];
      expect(ret.type).toBe("Return");
      expect(ret.value.type).toBe("BinaryOp");
      expect(ret.value.op).toBe("//");
    });
  }
});
