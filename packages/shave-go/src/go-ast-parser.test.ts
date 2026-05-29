// SPDX-License-Identifier: MIT
//
// Tests for the go/ast subprocess wrapper (WI-870 slice 1).
//
// All tests inject a mock spawn implementation so the suite does not require
// Go (or any Go toolchain) to be installed.  The mock honors the same
// lifecycle as node:child_process.ChildProcess: emits 'data' on stdout/stderr,
// then 'close' with an exit code, then the promise resolves or rejects.
//
// A future slice will add an opt-in integration test gated on
// `process.env.YAKCC_GO` that exercises a real Go subprocess.

import { EventEmitter } from "node:events";
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

function makeOpts(spawnImpl: SpawnImpl): GoAstParseOptions {
  return {
    goExecutable: "go-fake",
    scriptPath: "/fake/scripts/go-ast-parse.go",
    spawnImpl,
  };
}

/** Minimal valid envelope for a Go file with no functions. */
const EMPTY_ENVELOPE = JSON.stringify({
  version: 1,
  packageName: "main",
  functions: [],
});

/** Envelope with one simple function. */
const ONE_FN_ENVELOPE = JSON.stringify({
  version: 1,
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
    },
  ],
});

describe("parseGoSource (#870 slice 1)", () => {
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
    expect(result.version).toBe(1);
    expect(result.packageName).toBe("main");
    expect(result.functions).toEqual([]);
    expect(spawnFn.callCount()).toBe(1);
    expect(spawnFn.stdinChunks).toEqual(["package main"]);
  });

  it("returns parsed envelope with one function declaration", async () => {
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
      stdout: JSON.stringify({ version: 2, packageName: "x", functions: [] }),
      exitCode: 0,
    });
    await expect(parseGoSource("package main", makeOpts(spawnFn))).rejects.toThrow(
      /schema version must be 1/,
    );
  });

  it("rejects when the JSON envelope is missing packageName", async () => {
    const spawnFn = mockSpawn({
      stdout: JSON.stringify({ version: 1, functions: [] }),
      exitCode: 0,
    });
    await expect(parseGoSource("package main", makeOpts(spawnFn))).rejects.toThrow(
      /"packageName" must be a string/,
    );
  });

  it("rejects when the JSON envelope is missing functions array", async () => {
    const spawnFn = mockSpawn({
      stdout: JSON.stringify({ version: 1, packageName: "main" }),
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
    // Note: not passing goExecutable in opts -- should fall through to YAKCC_GO.
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
});
