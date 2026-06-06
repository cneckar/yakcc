// SPDX-License-Identifier: MIT
// @mock-exempt: @yakcc/shave-rust wraps a cargo subprocess boundary.
// The spawnImpl injection seam (DEC-POLYGLOT-RUST-CLI-001) lets tests exercise
// the full CLI path with a mock subprocess — no Rust toolchain required.
// The real cargo subprocess integration is gated on YAKCC_RUST_E2E=1
// in polyglot-rust.yml CI.
//
// shave-rust.test.ts — unit tests for runShaveRust.
//
// @decision DEC-POLYGLOT-RUST-CLI-001
// @title runShaveRust test seam: inject mock spawnImpl — no cargo needed
// @status accepted (WI-868 slice 4)
// @rationale
//   runShaveRust accepts an optional ShaveRustOpts.spawnImpl, threading it
//   through to RustAstParseOptions.spawnImpl.  This lets CLI tests exercise the
//   full raise pipeline (parseRustSource -> extractFunctionSignatures ->
//   renderFunctionDeclaration) without invoking cargo.  The mock uses the same
//   EventEmitter pattern as acceptance.test.ts in @yakcc/shave-rust (verified
//   production sequence: spawn child emits JSON on stdout, child emits close 0).
//   Mirrors the shave-python.test.ts injection style for CLI layer consistency.
//   Cross-reference: PLAN.md §4 / #868 / DEC-POLYGLOT-RUST-ACCEPTANCE-001

import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CollectingLogger } from "../index.js";
import type { ShaveRustArgs } from "./shave-rust.js";
import { runShaveRust } from "./shave-rust.js";

// ---------------------------------------------------------------------------
// Infrastructure: mock subprocess factory + inline fixtures
// ---------------------------------------------------------------------------

/**
 * Wire envelope JSON that the mock spawnImpl will emit as subprocess stdout.
 * These inline fixtures mirror the on-disk ones in packages/shave-rust/src/__fixtures__/
 * so shave-rust.test.ts stays self-contained (no cross-package fixture reads).
 */

/** pub fn add(a: i32, b: i32) -> i32  — maps to add(a: number, b: number): number */
const ADD_I32_ENVELOPE = JSON.stringify({
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
            line: 1,
            col: 1,
            x: {
              type: "BinaryExpr",
              line: 1,
              col: 1,
              op: "+",
              x: { type: "Ident", line: 1, col: 1, name: "a" },
              y: { type: "Ident", line: 1, col: 5, name: "b" },
            },
            isTail: true,
          },
        ],
      },
    },
  ],
});

/** pub fn greet(name: String) -> String — maps to greet(name: string): string */
const GREET_STRING_ENVELOPE = JSON.stringify({
  version: 2,
  crateName: "stdin.rs",
  functions: [
    {
      name: "greet",
      isPub: true,
      params: [{ name: "name", rustType: "String" }],
      returnType: "String",
      bodySource: 'format!("Hello, {}", name)',
      body: {
        stmts: [
          {
            type: "ExprStmt",
            line: 1,
            col: 1,
            x: {
              type: "CallExpr",
              line: 1,
              col: 1,
              fun: { type: "Ident", line: 1, col: 1, name: "format" },
              args: [
                { type: "Lit", line: 1, col: 8, kind: "STR", value: "Hello, {}" },
                { type: "Ident", line: 1, col: 22, name: "name" },
              ],
            },
            isTail: true,
          },
        ],
      },
    },
  ],
});

/** Two functions: add(i32) + is_even(i32 -> bool) — for multi-function tests. */
const TWO_FN_ENVELOPE = JSON.stringify({
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
            line: 1,
            col: 1,
            x: {
              type: "BinaryExpr",
              line: 1,
              col: 1,
              op: "+",
              x: { type: "Ident", line: 1, col: 1, name: "a" },
              y: { type: "Ident", line: 1, col: 5, name: "b" },
            },
            isTail: true,
          },
        ],
      },
    },
    {
      name: "is_even",
      isPub: true,
      params: [{ name: "n", rustType: "i32" }],
      returnType: "bool",
      bodySource: "n % 2 == 0",
      body: {
        stmts: [
          {
            type: "ExprStmt",
            line: 1,
            col: 1,
            x: {
              type: "BinaryExpr",
              line: 1,
              col: 1,
              op: "==",
              x: {
                type: "BinaryExpr",
                line: 1,
                col: 1,
                op: "%",
                x: { type: "Ident", line: 1, col: 1, name: "n" },
                y: { type: "Lit", line: 1, col: 5, kind: "INT", value: "2" },
              },
              y: { type: "Lit", line: 1, col: 9, kind: "INT", value: "0" },
            },
            isTail: true,
          },
        ],
      },
    },
  ],
});

/** Empty-function-list envelope — triggers "no functions found" exit 1. */
const NO_FN_ENVELOPE = JSON.stringify({
  version: 2,
  crateName: "stdin.rs",
  functions: [],
});

/**
 * Build a SpawnImpl mock that emits the given JSON string as subprocess stdout
 * and exits with the given code.
 *
 * Production sequence: child process spawned → stdout "data" event → "close" event.
 * This is the exact same mock shape used in acceptance.test.ts (DEC-POLYGLOT-RUST-ACCEPTANCE-001).
 */
function makeSpawnMock(jsonOutput: string, exitCode = 0): import("@yakcc/shave-rust").SpawnImpl {
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
      stdout.emit("data", Buffer.from(jsonOutput, "utf-8"));
      child.emit("close", exitCode);
    });
    return child as ReturnType<typeof import("node:child_process").spawn>;
  };
}

/**
 * Build a SpawnImpl mock that emits non-zero exit and optional stderr message
 * to simulate cargo absent / build failure.
 */
function makeFailingSpawnMock(
  stderrMsg: string,
  exitCode = 1,
): import("@yakcc/shave-rust").SpawnImpl {
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
      stderr.emit("data", Buffer.from(stderrMsg, "utf-8"));
      child.emit("close", exitCode);
    });
    return child as ReturnType<typeof import("node:child_process").spawn>;
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build ShaveRustArgs with sane defaults. */
function args(filePath: string, overrides?: Partial<ShaveRustArgs>): ShaveRustArgs {
  return {
    filePath,
    functionFilter: undefined,
    out: undefined,
    ignoredForeignPolicy: false,
    ...overrides,
  };
}

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "shave-rust-test-"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

/** Write a tiny .rs fixture so readFileSync in runShaveRust succeeds. */
function fixture(name: string, content = "pub fn add(a: i32, b: i32) -> i32 { a + b }\n"): string {
  const p = join(tempDir, name);
  writeFileSync(p, content, "utf-8");
  return p;
}

// ---------------------------------------------------------------------------
// Compound-interaction test (required by implementer protocol)
//
// This test exercises the real production sequence end-to-end:
//   runShaveRust → readFileSync → parseRustSource (mock spawn) →
//   extractFunctionSignatures → renderFunctionDeclaration → logger.log
//
// It crosses all three internal pipeline component boundaries:
//   rust-ast-parser.ts → parse-fn-signature.ts → raise-function.ts
// with only the subprocess spawn replaced by the in-process mock.
// ---------------------------------------------------------------------------

describe("runShaveRust — compound interaction: .rs → TS-subset IR (production sequence)", () => {
  it("end-to-end pipeline: readFileSync → parseRustSource (mock spawn) → " +
    "extractFunctionSignatures → renderFunctionDeclaration → stdout", async () => {
    const file = fixture("add.rs");
    const spawnImpl = makeSpawnMock(ADD_I32_ENVELOPE);
    const logger = new CollectingLogger();

    const code = await runShaveRust(args(file), logger, { spawnImpl });

    expect(code).toBe(0);
    expect(logger.errLines).toHaveLength(0);
    // The full pipeline raises add(a: i32, b: i32) -> i32 to TS-subset IR.
    const out = logger.logLines.join("\n");
    expect(out).toContain("export function add");
    expect(out).toContain("a: number, b: number");
    expect(out).toContain(": number {");
    expect(out).toContain("return");
  });
});

// ---------------------------------------------------------------------------
// Happy-path tests
// ---------------------------------------------------------------------------

describe("runShaveRust — single function: add(i32, i32) -> i32", () => {
  it("raises to TS-subset IR and logs to stdout, returns 0", async () => {
    const file = fixture("add.rs");
    const spawnImpl = makeSpawnMock(ADD_I32_ENVELOPE);
    const logger = new CollectingLogger();

    const code = await runShaveRust(args(file), logger, { spawnImpl });

    expect(code).toBe(0);
    const out = logger.logLines.join("\n");
    expect(out).toContain("export function add(a: number, b: number): number {");
    expect(logger.errLines).toHaveLength(0);
  });
});

describe("runShaveRust — single function: greet(String) -> String", () => {
  it("maps String -> string and produces well-formed IR, returns 0", async () => {
    const file = fixture("greet.rs", 'pub fn greet(name: String) -> String { format!("Hello") }\n');
    const spawnImpl = makeSpawnMock(GREET_STRING_ENVELOPE);
    const logger = new CollectingLogger();

    const code = await runShaveRust(args(file), logger, { spawnImpl });

    expect(code).toBe(0);
    const out = logger.logLines.join("\n");
    expect(out).toContain("export function greet(name: string): string {");
    expect(logger.errLines).toHaveLength(0);
  });
});

describe("runShaveRust — two functions: banners emitted for multi-function stdout", () => {
  it("emits // ---- function: <name> ---- banners and both IR blocks, returns 0", async () => {
    const file = fixture("two.rs");
    const spawnImpl = makeSpawnMock(TWO_FN_ENVELOPE);
    const logger = new CollectingLogger();

    const code = await runShaveRust(args(file), logger, { spawnImpl });

    expect(code).toBe(0);
    const out = logger.logLines.join("\n");
    expect(out).toContain("// ---- function: add ----");
    expect(out).toContain("// ---- function: isEven ----");
    expect(out).toContain("export function add");
    expect(out).toContain("export function isEven");
    expect(logger.errLines).toHaveLength(0);
  });
});

describe("runShaveRust — --function filter: select single function from two-function file", () => {
  it("processes only the named function and returns 0", async () => {
    const file = fixture("two.rs");
    const spawnImpl = makeSpawnMock(TWO_FN_ENVELOPE);
    const logger = new CollectingLogger();

    const code = await runShaveRust(args(file, { functionFilter: "add" }), logger, { spawnImpl });

    expect(code).toBe(0);
    const out = logger.logLines.join("\n");
    expect(out).toContain("export function add");
    // No banner emitted for a single-function result.
    expect(out).not.toContain("// ---- function:");
  });

  it("returns 1 when the named function is not found", async () => {
    const file = fixture("two.rs");
    const spawnImpl = makeSpawnMock(TWO_FN_ENVELOPE);
    const logger = new CollectingLogger();

    const code = await runShaveRust(args(file, { functionFilter: "notexist" }), logger, {
      spawnImpl,
    });

    expect(code).toBe(1);
    expect(logger.errLines.join("\n")).toContain("notexist");
  });
});

// ---------------------------------------------------------------------------
// Error-path tests
// ---------------------------------------------------------------------------

describe("runShaveRust — file read error → exit 1", () => {
  it("returns 1 and emits structured error when file does not exist", async () => {
    const logger = new CollectingLogger();
    const code = await runShaveRust(args("/nonexistent/path/that/does-not-exist.rs"), logger, {
      spawnImpl: makeSpawnMock(ADD_I32_ENVELOPE),
    });
    expect(code).toBe(1);
    expect(logger.errLines.join("\n")).toContain("error:");
    expect(logger.errLines.join("\n")).toContain("cannot read file");
  });
});

describe("runShaveRust — parse failure (non-zero exit) → exit 2", () => {
  it("returns 2 and emits structured error when cargo exits non-zero", async () => {
    const file = fixture("bad.rs", "this is not valid rust syntax\n");
    const spawnImpl = makeFailingSpawnMock("error[E0001]: syntax error", 1);
    const logger = new CollectingLogger();

    const code = await runShaveRust(args(file), logger, { spawnImpl });

    expect(code).toBe(2);
    expect(logger.errLines.join("\n")).toContain("error:");
    expect(logger.errLines.join("\n")).toContain("parse failed");
  });
});

describe("runShaveRust — no functions in file → exit 1", () => {
  it("returns 1 and emits 'no functions found' when envelope has empty functions list", async () => {
    const file = fixture("empty.rs", "// no functions here\n");
    const spawnImpl = makeSpawnMock(NO_FN_ENVELOPE);
    const logger = new CollectingLogger();

    const code = await runShaveRust(args(file), logger, { spawnImpl });

    expect(code).toBe(1);
    expect(logger.errLines.join("\n")).toContain("no functions found");
  });
});

describe("runShaveRust — --foreign-policy ignored warning", () => {
  it("emits warning when ignoredForeignPolicy is true", async () => {
    const file = fixture("warn.rs");
    const spawnImpl = makeSpawnMock(ADD_I32_ENVELOPE);
    const logger = new CollectingLogger();

    const code = await runShaveRust(args(file, { ignoredForeignPolicy: true }), logger, {
      spawnImpl,
    });

    expect(code).toBe(0);
    expect(logger.errLines.join("\n")).toContain("--foreign-policy ignored for --target rust");
  });
});

describe("runShaveRust — --out <file> writes concatenated IR", () => {
  it("writes IR to file and returns 0", async () => {
    const file = fixture("single.rs");
    const outFile = join(tempDir, "out.ir.ts");
    const spawnImpl = makeSpawnMock(ADD_I32_ENVELOPE);
    const logger = new CollectingLogger();

    const code = await runShaveRust(args(file, { out: outFile }), logger, { spawnImpl });

    expect(code).toBe(0);
    const { readFileSync } = await import("node:fs");
    const written = readFileSync(outFile, "utf-8");
    expect(written).toContain("export function add");
    expect(logger.logLines).toHaveLength(0); // written to file, not stdout
  });
});

describe("runShaveRust — --out <dir> writes one file per function", () => {
  it("creates <fn>.ir.ts for each function in the directory, returns 0", async () => {
    const file = fixture("multi.rs");
    const outDir = `${join(tempDir, "out")}/`; // trailing slash → directory target
    const spawnImpl = makeSpawnMock(TWO_FN_ENVELOPE);
    const logger = new CollectingLogger();

    const code = await runShaveRust(args(file, { out: outDir }), logger, { spawnImpl });

    expect(code).toBe(0);
    const { readdirSync } = await import("node:fs");
    const files = readdirSync(outDir.replace(/\/$/, ""));
    expect(files).toContain("add.ir.ts");
    // snake_case is normalized to camelCase in the output filename.
    expect(files).toContain("isEven.ir.ts");
  });
});
