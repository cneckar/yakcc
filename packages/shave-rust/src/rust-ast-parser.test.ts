// SPDX-License-Identifier: Apache-2.0
//
// rust-ast-parser.test.ts -- unit tests for the subprocess wrapper (WI-868 slice 1).
//
// Tests inject a mock SpawnImpl so no Rust toolchain is required in CI.
// The real cargo subprocess path is exercised in polyglot-rust.yml (YAKCC_RUST_E2E=1).

import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import {
  AdapterSubprocessError,
  type RustAstParseResult,
  type SpawnImpl,
  parseRustSource,
} from "./rust-ast-parser.js";

// ---------------------------------------------------------------------------
// Mock spawn factory
// ---------------------------------------------------------------------------

function makeSpawnSuccess(envelope: RustAstParseResult): SpawnImpl {
  const json = JSON.stringify(envelope);
  return (_command, _args, _options) => {
    const stdin: EventEmitter & { end?: (...a: unknown[]) => void } = new EventEmitter();
    stdin.end = () => {};
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    const child: EventEmitter & {
      stdin: typeof stdin;
      stdout: typeof stdout;
      stderr: typeof stderr;
    } = Object.assign(new EventEmitter(), { stdin, stdout, stderr });
    queueMicrotask(() => {
      stdout.emit("data", Buffer.from(json, "utf-8"));
      child.emit("close", 0);
    });
    return child as ReturnType<typeof import("node:child_process").spawn>;
  };
}

function makeSpawnFailure(exitCode: number, stderrText: string): SpawnImpl {
  return (_command, _args, _options) => {
    const stdin: EventEmitter & { end?: (...a: unknown[]) => void } = new EventEmitter();
    stdin.end = () => {};
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    const child: EventEmitter & {
      stdin: typeof stdin;
      stdout: typeof stdout;
      stderr: typeof stderr;
    } = Object.assign(new EventEmitter(), { stdin, stdout, stderr });
    queueMicrotask(() => {
      stderr.emit("data", Buffer.from(stderrText, "utf-8"));
      child.emit("close", exitCode);
    });
    return child as ReturnType<typeof import("node:child_process").spawn>;
  };
}

function makeSpawnBadJson(): SpawnImpl {
  return (_command, _args, _options) => {
    const stdin: EventEmitter & { end?: (...a: unknown[]) => void } = new EventEmitter();
    stdin.end = () => {};
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    const child: EventEmitter & {
      stdin: typeof stdin;
      stdout: typeof stdout;
      stderr: typeof stderr;
    } = Object.assign(new EventEmitter(), { stdin, stdout, stderr });
    queueMicrotask(() => {
      stdout.emit("data", Buffer.from("not-valid-json", "utf-8"));
      child.emit("close", 0);
    });
    return child as ReturnType<typeof import("node:child_process").spawn>;
  };
}

function makeSpawnError(message: string): SpawnImpl {
  return (_command, _args, _options) => {
    const stdin: EventEmitter & { end?: (...a: unknown[]) => void } = new EventEmitter();
    stdin.end = () => {};
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    const child: EventEmitter & {
      stdin: typeof stdin;
      stdout: typeof stdout;
      stderr: typeof stderr;
    } = Object.assign(new EventEmitter(), { stdin, stdout, stderr });
    queueMicrotask(() => {
      child.emit("error", new Error(message));
    });
    return child as ReturnType<typeof import("node:child_process").spawn>;
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

// WI-868-2B: mock envelopes updated to v2 (version: 2, body required on functions).
// body: null is the valid sentinel for functions that have no parsed body AST
// (e.g. extern/trait stubs, or test fixtures that don't exercise body logic).
const MINIMAL_ENVELOPE: RustAstParseResult = {
  version: 2,
  crateName: "stdin.rs",
  functions: [],
};

const ADD_ENVELOPE: RustAstParseResult = {
  version: 2,
  crateName: "stdin.rs",
  functions: [
    {
      name: "add",
      isPub: true,
      params: [
        { name: "a", rustType: "i32" },
        { name: "b", rustType: "i32" },
      ],
      returnType: "i32",
      bodySource: "a + b",
      body: null,
    },
  ],
};

describe("parseRustSource", () => {
  it("returns a parsed envelope on success", async () => {
    const result = await parseRustSource("pub fn add(a: i32, b: i32) -> i32 { a + b }", {
      cargoExecutable: "cargo-fake",
      manifestPath: "/fake/Cargo.toml",
      spawnImpl: makeSpawnSuccess(ADD_ENVELOPE),
    });
    expect(result.version).toBe(2);
    expect(result.crateName).toBe("stdin.rs");
    expect(result.functions).toHaveLength(1);
    expect(result.functions[0]?.name).toBe("add");
    expect(result.functions[0]?.isPub).toBe(true);
    expect(result.functions[0]?.params).toHaveLength(2);
    expect(result.functions[0]?.params[0]).toEqual({ name: "a", rustType: "i32" });
    expect(result.functions[0]?.returnType).toBe("i32");
  });

  it("returns empty functions array for source with no functions", async () => {
    const result = await parseRustSource("struct Foo;", {
      cargoExecutable: "cargo-fake",
      manifestPath: "/fake/Cargo.toml",
      spawnImpl: makeSpawnSuccess(MINIMAL_ENVELOPE),
    });
    expect(result.functions).toHaveLength(0);
  });

  it("throws AdapterSubprocessError on non-zero exit code", async () => {
    await expect(
      parseRustSource("invalid source", {
        cargoExecutable: "cargo-fake",
        manifestPath: "/fake/Cargo.toml",
        spawnImpl: makeSpawnFailure(1, "syntax error: unexpected token"),
      }),
    ).rejects.toThrow(AdapterSubprocessError);

    try {
      await parseRustSource("invalid source", {
        cargoExecutable: "cargo-fake",
        manifestPath: "/fake/Cargo.toml",
        spawnImpl: makeSpawnFailure(1, "syntax error"),
      });
    } catch (err) {
      expect(err).toBeInstanceOf(AdapterSubprocessError);
      expect((err as AdapterSubprocessError).exitCode).toBe(1);
      expect((err as AdapterSubprocessError).message).toContain("cargo-fake");
    }
  });

  it("throws AdapterSubprocessError with rustup hint when cargo not found", async () => {
    await expect(
      parseRustSource("fn foo() {}", {
        cargoExecutable: "cargo-missing",
        manifestPath: "/fake/Cargo.toml",
        spawnImpl: makeSpawnError("ENOENT"),
      }),
    ).rejects.toThrow(AdapterSubprocessError);

    try {
      await parseRustSource("fn foo() {}", {
        cargoExecutable: "cargo-missing",
        manifestPath: "/fake/Cargo.toml",
        spawnImpl: makeSpawnError("ENOENT"),
      });
    } catch (err) {
      expect(err).toBeInstanceOf(AdapterSubprocessError);
      expect((err as AdapterSubprocessError).message).toContain("rustup.rs");
    }
  });

  it("throws AdapterSubprocessError on invalid JSON stdout", async () => {
    await expect(
      parseRustSource("fn foo() {}", {
        cargoExecutable: "cargo-fake",
        manifestPath: "/fake/Cargo.toml",
        spawnImpl: makeSpawnBadJson(),
      }),
    ).rejects.toThrow(AdapterSubprocessError);
  });

  it("throws AdapterSubprocessError when version field is wrong", async () => {
    const wrongVersion = { version: 99, crateName: "stdin.rs", functions: [] };
    const spawnFn: SpawnImpl = (_command, _args, _options) => {
      const stdin: EventEmitter & { end?: (...a: unknown[]) => void } = new EventEmitter();
      stdin.end = () => {};
      const stdout = new EventEmitter();
      const stderr = new EventEmitter();
      const child: EventEmitter & {
        stdin: typeof stdin;
        stdout: typeof stdout;
        stderr: typeof stderr;
      } = Object.assign(new EventEmitter(), { stdin, stdout, stderr });
      queueMicrotask(() => {
        stdout.emit("data", Buffer.from(JSON.stringify(wrongVersion), "utf-8"));
        child.emit("close", 0);
      });
      return child as ReturnType<typeof import("node:child_process").spawn>;
    };

    await expect(
      parseRustSource("fn foo() {}", {
        cargoExecutable: "cargo-fake",
        manifestPath: "/fake/Cargo.toml",
        spawnImpl: spawnFn,
      }),
    ).rejects.toThrow(AdapterSubprocessError);
  });

  // WI-868-2B: single-version guard — v1 envelopes must be rejected too
  // (DEC-POLYGLOT-RUST-BODY-AST-V2-001 — no dual v1/v2 acceptance).
  it("throws AdapterSubprocessError when version is 1 (old v1 envelope)", async () => {
    const v1Envelope = { version: 1, crateName: "stdin.rs", functions: [] };
    const spawnFn: SpawnImpl = (_command, _args, _options) => {
      const stdin: EventEmitter & { end?: (...a: unknown[]) => void } = new EventEmitter();
      stdin.end = () => {};
      const stdout = new EventEmitter();
      const stderr = new EventEmitter();
      const child: EventEmitter & {
        stdin: typeof stdin;
        stdout: typeof stdout;
        stderr: typeof stderr;
      } = Object.assign(new EventEmitter(), { stdin, stdout, stderr });
      queueMicrotask(() => {
        stdout.emit("data", Buffer.from(JSON.stringify(v1Envelope), "utf-8"));
        child.emit("close", 0);
      });
      return child as ReturnType<typeof import("node:child_process").spawn>;
    };

    const err = await parseRustSource("fn foo() {}", {
      cargoExecutable: "cargo-fake",
      manifestPath: "/fake/Cargo.toml",
      spawnImpl: spawnFn,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AdapterSubprocessError);
    expect((err as AdapterSubprocessError).message).toContain("schema version must be 2");
  });

  // WI-868-2B: a v2 envelope with a body-bearing function round-trips through the type.
  it("accepts a v2 envelope with a body-bearing function", async () => {
    const bodyEnvelope: RustAstParseResult = {
      version: 2,
      crateName: "stdin.rs",
      functions: [
        {
          name: "add",
          isPub: true,
          params: [
            { name: "a", rustType: "i32" },
            { name: "b", rustType: "i32" },
          ],
          returnType: "i32",
          bodySource: "a + b",
          body: {
            stmts: [
              {
                type: "ExprStmt",
                x: {
                  type: "BinaryExpr",
                  op: "+",
                  x: { type: "Ident", name: "a", line: 1, col: 25 },
                  y: { type: "Ident", name: "b", line: 1, col: 29 },
                  line: 1,
                  col: 25,
                },
                isTail: true,
                line: 1,
                col: 25,
              },
            ],
          },
        },
      ],
    };

    const result = await parseRustSource("pub fn add(a: i32, b: i32) -> i32 { a + b }", {
      cargoExecutable: "cargo-fake",
      manifestPath: "/fake/Cargo.toml",
      spawnImpl: makeSpawnSuccess(bodyEnvelope),
    });
    expect(result.version).toBe(2);
    expect(result.functions[0]?.body).not.toBeNull();
    expect(result.functions[0]?.body?.stmts).toHaveLength(1);
    const stmt = result.functions[0]?.body?.stmts[0];
    expect(stmt?.type).toBe("ExprStmt");
    if (stmt?.type === "ExprStmt") {
      expect(stmt.isTail).toBe(true);
      expect(stmt.x.type).toBe("BinaryExpr");
    }
  });
});
