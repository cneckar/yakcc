// SPDX-License-Identifier: MIT
//
// Tests for the go/ast subprocess wrapper (WI-870 slice 1+2).
//
// All tests inject a mock spawn implementation so the suite does not require
// Go (or any Go toolchain) to be installed.  The mock honors the same
// lifecycle as node:child_process.ChildProcess: emits 'data' on stdout/stderr,
// then 'close' with an exit code, then the promise resolves or rejects.
//
// Slice 2 bumped the schema version from 1 to 2.  The envelope validator is
// updated accordingly and tests below reflect the new version.

import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AdapterSubprocessError,
  type GoAstParseOptions,
  type SpawnImpl,
  parseGoSource,
} from "./go-ast-parser.js";

interface MockStream extends EventEmitter {
  end?: (chunk?: string, encoding?: BufferEncoding) => void;
}

interface MockProcess extends EventEmitter {
  readonly stdin: MockStream | null;
  readonly stdout: MockStream | null;
  readonly stderr: MockStream | null;
}

interface MockScript {
  readonly stdout?: string;
  readonly stderr?: string;
  readonly exitCode: number | null;
  readonly spawnThrows?: string;
  readonly emitErrorBeforeClose?: string;
}

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

function makeOpts(spawnImpl: SpawnImpl): GoAstParseOptions {
  return {
    goExecutable: "go-fake",
    scriptPath: "/fake/scripts/go-ast-parse.go",
    spawnImpl,
  };
}

/** Minimal valid envelope (version=2) for a Go file with no functions. */
const EMPTY_ENVELOPE = JSON.stringify({
  version: 2,
  packageName: "main",
  functions: [],
});

/** Version-2 envelope with one simple function including body AST. */
const ONE_FN_ENVELOPE = JSON.stringify({
  version: 2,
  packageName: "math",
  functions: [
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
      body: {
        stmts: [
          {
            type: "ReturnStmt",
            line: 1,
            col: 2,
            results: [
              {
                type: "BinaryExpr",
                line: 1,
                col: 9,
                op: "+",
                x: { type: "Ident", line: 1, col: 9, name: "a" },
                y: { type: "Ident", line: 1, col: 13, name: "b" },
              },
            ],
          },
        ],
      },
    },
  ],
});

describe("parseGoSource (#870 slice 1+2)", () => {
  let savedYakccGo: string | undefined;

  beforeEach(() => {
    savedYakccGo = process.env.YAKCC_GO;
    // biome-ignore lint/performance/noDelete: process.env requires delete to truly unset
    delete process.env.YAKCC_GO;
  });

  afterEach(() => {
    if (savedYakccGo === undefined) {
      // biome-ignore lint/performance/noDelete: process.env requires delete to truly unset
      delete process.env.YAKCC_GO;
    } else {
      process.env.YAKCC_GO = savedYakccGo;
    }
  });

  it("returns the parsed envelope on a successful subprocess run (empty functions)", async () => {
    const spawnFn = mockSpawn({ stdout: EMPTY_ENVELOPE, exitCode: 0 });
    const result = await parseGoSource("package main", makeOpts(spawnFn));
    expect(result.version).toBe(2);
    expect(result.packageName).toBe("main");
    expect(result.functions).toEqual([]);
    expect(spawnFn.callCount()).toBe(1);
    expect(spawnFn.stdinChunks).toEqual(["package main"]);
  });

  it("returns parsed envelope with one function declaration including body AST", async () => {
    const spawnFn = mockSpawn({ stdout: ONE_FN_ENVELOPE, exitCode: 0 });
    const result = await parseGoSource(
      "package math\nfunc Add(a, b int) int { return a+b }",
      makeOpts(spawnFn),
    );
    expect(result.packageName).toBe("math");
    expect(result.functions).toHaveLength(1);
    const fn = result.functions[0];
    expect(fn?.name).toBe("Add");
    expect(fn?.params).toEqual([
      { name: "a", goType: "int" },
      { name: "b", goType: "int" },
    ]);
    expect(fn?.results).toEqual([{ name: "", goType: "int" }]);
    // Slice-2: body field is present with structured AST
    expect(fn?.body).toBeDefined();
    expect(fn?.body?.stmts).toHaveLength(1);
    expect(fn?.body?.stmts[0]?.type).toBe("ReturnStmt");
  });

  it("rejects with AdapterSubprocessError when exit code is non-zero", async () => {
    const spawnFn = mockSpawn({
      stderr: "go: go.mod not found",
      exitCode: 1,
    });
    await expect(parseGoSource("package main", makeOpts(spawnFn))).rejects.toMatchObject({
      name: "AdapterSubprocessError",
      exitCode: 1,
    });
  });

  it("includes the remediation hint when go is missing", async () => {
    const spawnFn = mockSpawn({
      stderr: "exec: go: executable file not found in $PATH",
      exitCode: 1,
    });
    try {
      await parseGoSource("package main", makeOpts(spawnFn));
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(AdapterSubprocessError);
      expect((err as Error).message).toContain("https://go.dev/dl/");
    }
  });

  it("rejects when stdout is not valid JSON", async () => {
    const spawnFn = mockSpawn({ stdout: "this is not json", exitCode: 0 });
    await expect(parseGoSource("package main", makeOpts(spawnFn))).rejects.toMatchObject({
      name: "AdapterSubprocessError",
    });
  });

  it("rejects when the JSON envelope has the wrong schema version", async () => {
    const spawnFn = mockSpawn({
      stdout: JSON.stringify({ version: 1, packageName: "x", functions: [] }),
      exitCode: 0,
    });
    await expect(parseGoSource("package main", makeOpts(spawnFn))).rejects.toThrow(
      /schema version must be 2/,
    );
  });

  it("rejects when the JSON envelope is missing packageName", async () => {
    const spawnFn = mockSpawn({
      stdout: JSON.stringify({ version: 2, functions: [] }),
      exitCode: 0,
    });
    await expect(parseGoSource("package main", makeOpts(spawnFn))).rejects.toThrow(
      /"packageName" must be a string/,
    );
  });

  it("rejects when the JSON envelope is missing functions array", async () => {
    const spawnFn = mockSpawn({
      stdout: JSON.stringify({ version: 2, packageName: "main" }),
      exitCode: 0,
    });
    await expect(parseGoSource("package main", makeOpts(spawnFn))).rejects.toThrow(
      /"functions" must be an array/,
    );
  });

  it("rejects when spawn itself throws (go not on PATH)", async () => {
    const spawnFn = mockSpawn({ spawnThrows: "ENOENT: go not found", exitCode: 0 });
    await expect(parseGoSource("package main", makeOpts(spawnFn))).rejects.toMatchObject({
      name: "AdapterSubprocessError",
    });
  });

  it("rejects when the child emits an error event before close", async () => {
    const spawnFn = mockSpawn({
      emitErrorBeforeClose: "EPIPE: broken pipe",
      exitCode: 0,
    });
    await expect(parseGoSource("package main", makeOpts(spawnFn))).rejects.toMatchObject({
      name: "AdapterSubprocessError",
    });
  });

  it("respects YAKCC_GO env var as the go executable override", async () => {
    process.env.YAKCC_GO = "/custom/go";
    let capturedCmd = "";
    const spawnFn: SpawnImpl = (command, _args) => {
      capturedCmd = command;
      const child = mockSpawn({
        stdout: EMPTY_ENVELOPE,
        exitCode: 0,
      })(command, _args);
      return child;
    };
    await parseGoSource("package main", { spawnImpl: spawnFn, scriptPath: "/fake/x.go" });
    expect(capturedCmd).toBe("/custom/go");
  });

  it("passes spawn args including 'run' and the script path", async () => {
    let capturedArgs: readonly string[] = [];
    const spawnFn: SpawnImpl = (_command, args) => {
      capturedArgs = args;
      return mockSpawn({ stdout: EMPTY_ENVELOPE, exitCode: 0 })(_command, args);
    };
    await parseGoSource("package main", makeOpts(spawnFn));
    expect(capturedArgs).toEqual(["run", "/fake/scripts/go-ast-parse.go"]);
  });

  // --- #966: default scriptPath resolves to the real file on disk ---------------
  //
  // This test validates that defaultScriptPath() (invoked when no scriptPath
  // option is supplied) walks up to repo root correctly from dist/.  We use a
  // mock spawn so Go toolchain presence is not required; the test only cares
  // that the resolved path points at an existing file.
  it("#966 default scriptPath resolves to an existing file without explicit option", async () => {
    let capturedScript = "";
    const spawnFn: SpawnImpl = (_command, args) => {
      // args[1] is the script path supplied to `go run`
      capturedScript = args[1] ?? "";
      return mockSpawn({ stdout: EMPTY_ENVELOPE, exitCode: 0 })(_command, args);
    };
    // No scriptPath option — exercises defaultScriptPath()
    await parseGoSource("package main", { goExecutable: "go-fake", spawnImpl: spawnFn });
    // The path must point to the real go-ast-parse.go that ships in this repo
    expect(capturedScript).toMatch(/scripts[\\/]go-ast-parse\.go$/);
    expect(existsSync(capturedScript)).toBe(true);
  });

  // --- #967: stdin EPIPE does not crash the host process ------------------------
  //
  // Simulates the subprocess emitting EPIPE on its stdin stream (which happens
  // when the Go process exits before consuming all input).  The mock emits
  // 'error' with code=EPIPE on the stdin stream, then closes with exit code 1.
  // The expected outcome: parseGoSource rejects with AdapterSubprocessError
  // (surfaced via the 'close' handler), and the host process is NOT crashed
  // by an unhandled 'error' event.
  it("#967 stdin EPIPE rejects with AdapterSubprocessError and does not crash host", async () => {
    const spawnFn: SpawnImpl = (_command, _args, _options) => {
      const stdin: MockStream = new EventEmitter();
      let stdinErrorHandler: ((err: Error) => void) | undefined;
      stdin.on = function (event: string, listener: (...args: unknown[]) => void) {
        if (event === "error") {
          stdinErrorHandler = listener as (err: Error) => void;
        }
        return EventEmitter.prototype.on.call(this, event, listener);
      };
      stdin.end = (_chunk?: string, _encoding?: BufferEncoding) => {
        // After end() is called, simulate EPIPE: subprocess exited early
        queueMicrotask(() => {
          const epipeErr = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
          if (stdinErrorHandler) {
            stdinErrorHandler(epipeErr);
          } else {
            // If no handler registered, emit on the stream — this would crash
            // without the fix.  With the fix the handler is always registered.
            stdin.emit("error", epipeErr);
          }
        });
      };
      const stdout: MockStream = new EventEmitter();
      const stderr: MockStream = new EventEmitter();
      const child: MockProcess = Object.assign(new EventEmitter(), { stdin, stdout, stderr });

      queueMicrotask(() => {
        stderr.emit("data", Buffer.from("syntax error near token '='", "utf-8"));
        child.emit("close", 1);
      });

      return child as unknown as ReturnType<typeof import("node:child_process").spawn>;
    };

    await expect(
      parseGoSource("func =( {INVALID GO}", { goExecutable: "go-fake", spawnImpl: spawnFn }),
    ).rejects.toMatchObject({ name: "AdapterSubprocessError", exitCode: 1 });
  });
});
