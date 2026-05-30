// SPDX-License-Identifier: MIT
//
// acceptance.test.ts — #870 slice 3 acceptance corpus.
//
// Exercises the REAL raise pipeline end-to-end with the subprocess MOCKED
// (no Go toolchain required in CI):
//   parseGoSource (spawnImpl mock → JSON fixture) →
//   extractFunctionSignatures →
//   renderFunctionDeclaration
//
// Covers ≥10 fixtures:
//   Success:  add-int, multiply-float, greet-string, is-even-bool,
//             max-multi-param, const-literal, noop-void, internal-camel,
//             divide-two-returns, assign-and-return
//   Rejection (≥1 per banned-construct class):
//             reject-goroutine (GoGoroutineError),
//             reject-chan-send  (GoChanSendError),
//             reject-chan-recv  (GoChanRecvError),
//             reject-select     (GoSelectError),
//             reject-defer      (GoDeferError)
//
// All rejection errors are asserted to be instanceof CannotRaiseToIRError
// from @yakcc/contracts, conforming to the cross-adapter error taxonomy
// (DEC-POLYGLOT-GO-ERROR-TAXONOMY-001 / WI-870 slice 2).
//
// Compound-interaction requirement: each success test crosses the three
// internal component boundaries in the real production sequence:
// go-ast-parser.ts -> parse-fn-signature.ts -> raise-function.ts -- with only
// the subprocess spawn replaced by an in-process mock.
//
// @decision DEC-POLYGLOT-GO-ACCEPTANCE-001 (WI-870 slice 3)
// @title Acceptance corpus drives real pipeline with mocked subprocess
// @status accepted (WI-870 slice 3)
// @rationale
//   Slice 3 acceptance requires >=10 fixtures exercising the REAL raise logic.
//   Tests inject a mock SpawnImpl that returns pre-authored JSON envelopes
//   (under __fixtures__/) instead of invoking a Go toolchain.  This gives full
//   pipeline coverage (all three internal components) while keeping CI
//   Go-toolchain-free.

import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CannotRaiseToIRError } from "@yakcc/contracts";
import { describe, expect, it } from "vitest";
import {
  GoChanRecvError,
  GoChanSendError,
  GoDeferError,
  GoGoroutineError,
  GoSelectError,
} from "./errors.js";
import {
  type GoAstParseOptions,
  type GoAstParseResult,
  type SpawnImpl,
  parseGoSource,
} from "./go-ast-parser.js";
import { extractFunctionSignatures } from "./parse-fn-signature.js";
import { renderFunctionDeclaration } from "./raise-function.js";

// ---------------------------------------------------------------------------
// Infrastructure: mock subprocess + fixture loader
// ---------------------------------------------------------------------------

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), "__fixtures__");

/**
 * Load a fixture JSON envelope by filename (without extension).
 * These files are the authoritative acceptance corpus for #870 slice 3.
 */
function loadFixture(name: string): GoAstParseResult {
  const raw = readFileSync(join(FIXTURES_DIR, `${name}.json`), "utf-8");
  return JSON.parse(raw) as GoAstParseResult;
}

/**
 * Build a SpawnImpl mock that emits the given JSON string as stdout and
 * exits 0.  Mirrors the pattern in go-ast-parser.test.ts.
 */
function makeSpawnForEnvelope(envelope: GoAstParseResult): SpawnImpl {
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

/**
 * Run the full production pipeline for a given fixture:
 *   parseGoSource (mocked spawn) -> extractFunctionSignatures -> renderFunctionDeclaration
 *
 * Returns the TS-subset IR text for the FIRST function in the fixture.
 * Throws whatever the pipeline throws (for rejection-case tests).
 */
async function runPipeline(fixtureName: string): Promise<string> {
  const envelope = loadFixture(fixtureName);
  const spawnImpl = makeSpawnForEnvelope(envelope);
  const opts: GoAstParseOptions = {
    goExecutable: "go-fake",
    scriptPath: "/fake/go-ast-parse.go",
    spawnImpl,
  };
  // Step 1: subprocess seam (go-ast-parser.ts) -- returns the wire envelope
  const parsed = await parseGoSource("package placeholder", opts);
  // Step 2: signature extraction (parse-fn-signature.ts)
  const sigs = extractFunctionSignatures(parsed);
  const sig = sigs[0];
  if (sig === undefined) throw new Error(`Fixture '${fixtureName}' has no functions`);
  // Step 3: body raise (raise-function.ts -> raise-body.ts)
  const fn = parsed.functions[0];
  if (fn?.body === undefined || fn.body === null) {
    throw new Error(`Fixture '${fixtureName}' function has no body`);
  }
  return renderFunctionDeclaration(sig, fn.body);
}

// ---------------------------------------------------------------------------
// Suite: Success fixtures -- pure functions that must raise to TS-subset IR
// ---------------------------------------------------------------------------

describe("acceptance: successful Go to TS-subset IR raises (#870 slice 3)", () => {
  it("add-int: exported CamelCase, int params, binop + return", async () => {
    const out = await runPipeline("add-int");
    expect(out).toBe("export function Add(a: number, b: number): number {\n  return (a + b);\n}");
    expect(out).toMatch(/^export function Add/);
    expect(out).toContain("a: number, b: number");
    expect(out).toContain("return (a + b);");
  });

  it("multiply-float: float64 params, multiplication binop", async () => {
    const out = await runPipeline("multiply-float");
    expect(out).toBe(
      "export function Multiply(x: number, y: number): number {\n  return (x * y);\n}",
    );
    expect(out).toMatch(/^export function Multiply/);
    expect(out).toContain("x: number, y: number");
  });

  it("greet-string: string param, string-concat binop + return", async () => {
    const out = await runPipeline("greet-string");
    expect(out).toMatch(/^export function Greet/);
    expect(out).toContain("name: string");
    expect(out).toContain(": string {");
    expect(out).toContain("return");
  });

  it("is-even-bool: bool return, nested binop (% then ==)", async () => {
    const out = await runPipeline("is-even-bool");
    expect(out).toMatch(/^export function IsEven/);
    expect(out).toContain("n: number");
    expect(out).toContain(": boolean {");
    expect(out).toMatch(/return \(\(n % 2\) == 0\)/);
  });

  it("max-multi-param: three int params, assign-then-return", async () => {
    const out = await runPipeline("max-multi-param");
    expect(out).toMatch(/^export function Max/);
    expect(out).toContain("a: number, b: number, c: number");
    expect(out).toContain(": number {");
    expect(out).toContain("const x = a;");
    expect(out).toContain("return x;");
  });

  it("const-literal: no params, float literal return", async () => {
    const out = await runPipeline("const-literal");
    expect(out).toBe("export function Pi(): number {\n  return 3.14159;\n}");
    expect(out).toMatch(/^export function Pi\(\)/);
    expect(out).toContain("3.14159");
  });

  it("noop-void: empty body renders as void 0", async () => {
    const out = await runPipeline("noop-void");
    expect(out).toMatch(/^export function Noop\(\)/);
    expect(out).toContain(": void {");
    expect(out).toContain("void 0;");
  });

  it("internal-camel: internal camelCase function name (not exported CamelCase)", async () => {
    const out = await runPipeline("internal-camel");
    expect(out).toMatch(/^export function computeScore/);
    expect(out).toContain("base: number, bonus: number");
    expect(out).toContain(": number {");
    expect(out).toContain("return (base + bonus);");
  });

  it("divide-two-returns: two return types (float64, error) to tuple annotation", async () => {
    const out = await runPipeline("divide-two-returns");
    expect(out).toMatch(/^export function Divide/);
    expect(out).toContain("num: number, den: number");
    expect(out).toContain(": [number, Error] {");
    expect(out).toContain("return [(num / den), nil];");
  });

  it("assign-and-return: short-variable-decl (:=) then return", async () => {
    const out = await runPipeline("assign-and-return");
    expect(out).toMatch(/^export function Double/);
    expect(out).toContain("n: number");
    expect(out).toContain(": number {");
    expect(out).toContain("const result = (n * 2);");
    expect(out).toContain("return result;");
  });
});

// ---------------------------------------------------------------------------
// Suite: Rejection fixtures -- each banned-construct class must throw
// CannotRaiseToIRError (and the specific named subclass).
// ---------------------------------------------------------------------------

describe("acceptance: banned-construct rejections (#870 slice 3)", () => {
  // Each rejection fixture exercises the same full pipeline as success tests.
  // The error propagates from raise-body.ts -> raise-function.ts -> runPipeline,
  // verifying the entire chain carries the error correctly without swallowing it.

  it("reject-goroutine: GoStmt throws GoGoroutineError instanceof CannotRaiseToIRError", async () => {
    await expect(runPipeline("reject-goroutine")).rejects.toThrow(GoGoroutineError);
    try {
      await runPipeline("reject-goroutine");
    } catch (err) {
      expect(err).toBeInstanceOf(CannotRaiseToIRError);
      expect(err).toBeInstanceOf(GoGoroutineError);
      expect((err as CannotRaiseToIRError).construct).toContain("goroutine");
      expect((err as CannotRaiseToIRError).location.line).toBe(2);
      expect((err as CannotRaiseToIRError).location.col).toBe(3);
    }
  });

  it("reject-chan-send: SendStmt throws GoChanSendError instanceof CannotRaiseToIRError", async () => {
    await expect(runPipeline("reject-chan-send")).rejects.toThrow(GoChanSendError);
    try {
      await runPipeline("reject-chan-send");
    } catch (err) {
      expect(err).toBeInstanceOf(CannotRaiseToIRError);
      expect(err).toBeInstanceOf(GoChanSendError);
      expect((err as CannotRaiseToIRError).construct).toContain("chan send");
      expect((err as CannotRaiseToIRError).location.line).toBe(3);
    }
  });

  it("reject-chan-recv: ChanRecv expr throws GoChanRecvError instanceof CannotRaiseToIRError", async () => {
    await expect(runPipeline("reject-chan-recv")).rejects.toThrow(GoChanRecvError);
    try {
      await runPipeline("reject-chan-recv");
    } catch (err) {
      expect(err).toBeInstanceOf(CannotRaiseToIRError);
      expect(err).toBeInstanceOf(GoChanRecvError);
      expect((err as CannotRaiseToIRError).construct).toContain("chan recv");
      expect((err as CannotRaiseToIRError).location.line).toBe(1);
    }
  });

  it("reject-select: SelectStmt throws GoSelectError instanceof CannotRaiseToIRError", async () => {
    await expect(runPipeline("reject-select")).rejects.toThrow(GoSelectError);
    try {
      await runPipeline("reject-select");
    } catch (err) {
      expect(err).toBeInstanceOf(CannotRaiseToIRError);
      expect(err).toBeInstanceOf(GoSelectError);
      expect((err as CannotRaiseToIRError).construct).toBe("select");
      expect((err as CannotRaiseToIRError).location.line).toBe(4);
    }
  });

  it("reject-defer: DeferStmt throws GoDeferError instanceof CannotRaiseToIRError", async () => {
    await expect(runPipeline("reject-defer")).rejects.toThrow(GoDeferError);
    try {
      await runPipeline("reject-defer");
    } catch (err) {
      expect(err).toBeInstanceOf(CannotRaiseToIRError);
      expect(err).toBeInstanceOf(GoDeferError);
      expect((err as CannotRaiseToIRError).construct).toBe("defer");
      expect((err as CannotRaiseToIRError).location.line).toBe(5);
    }
  });
});
