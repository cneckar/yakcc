// SPDX-License-Identifier: Apache-2.0
//
// acceptance.test.ts -- #868 slice 1 acceptance corpus.
//
// Exercises the REAL raise pipeline end-to-end with the subprocess MOCKED
// (no Rust toolchain required in CI):
//   parseRustSource (spawnImpl mock -> JSON fixture) ->
//   extractFunctionSignatures ->
//   renderFunctionDeclaration
//
// Covers 8 fixtures:
//   Success:  add-i32, greet-string, is-even-bool, multiply-floats,
//             noop-void, sum-vec, internal-add, clamp-i32
//
// The acceptance test demonstrates that:
//   1. The full pipeline produces a well-formed TS-subset IR export declaration.
//   2. snake_case Rust names are normalized to camelCase in the output.
//   3. Rust types are correctly mapped (i32->number, String->string, etc.).
//   4. pub vs non-pub functions both raise successfully (visibility gate is slice 4).
//
// Compound-interaction requirement: each test crosses the three internal
// component boundaries in the real production sequence:
//   rust-ast-parser.ts -> parse-fn-signature.ts -> raise-function.ts
// with only the subprocess spawn replaced by an in-process mock.
//
// @decision DEC-POLYGLOT-RUST-ACCEPTANCE-001 (WI-868 slice 1)
// @title Acceptance corpus drives real pipeline with mocked subprocess
// @status accepted (WI-868 slice 1)
// @rationale
//   Mirrors DEC-POLYGLOT-GO-ACCEPTANCE-001 exactly.  Slice 1 acceptance
//   requires >=5 fixtures exercising the REAL raise logic through all three
//   internal pipeline components.  Tests inject a mock SpawnImpl that returns
//   pre-authored JSON envelopes (under __fixtures__/) instead of invoking
//   cargo.  This gives full pipeline coverage while keeping CI Rust-free.
//   The real cargo subprocess path is exercised in polyglot-rust.yml
//   (YAKCC_RUST_E2E=1 gate).

import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { extractFunctionSignatures } from "./parse-fn-signature.js";
import { renderFunctionDeclaration } from "./raise-function.js";
import {
  type RustAstParseOptions,
  type RustAstParseResult,
  type SpawnImpl,
  parseRustSource,
} from "./rust-ast-parser.js";

// ---------------------------------------------------------------------------
// Infrastructure: mock subprocess + fixture loader
// ---------------------------------------------------------------------------

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), "__fixtures__");

/**
 * Load a fixture JSON envelope by filename (without extension).
 * These files are the authoritative acceptance corpus for #868 slice 1.
 */
function loadFixture(name: string): RustAstParseResult {
  const raw = readFileSync(join(FIXTURES_DIR, `${name}.json`), "utf-8");
  return JSON.parse(raw) as RustAstParseResult;
}

/**
 * Build a SpawnImpl mock that emits the given JSON string as stdout and
 * exits 0.  Mirrors the pattern in rust-ast-parser.test.ts.
 */
function makeSpawnForEnvelope(envelope: RustAstParseResult): SpawnImpl {
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
 *   parseRustSource (mocked spawn) -> extractFunctionSignatures -> renderFunctionDeclaration
 *
 * Returns the TS-subset IR text for the FIRST function in the fixture.
 * Throws whatever the pipeline throws (for rejection-case tests).
 */
async function runPipeline(fixtureName: string): Promise<string> {
  const envelope = loadFixture(fixtureName);
  const spawnImpl = makeSpawnForEnvelope(envelope);
  const opts: RustAstParseOptions = {
    cargoExecutable: "cargo-fake",
    manifestPath: "/fake/Cargo.toml",
    spawnImpl,
  };
  // Step 1: subprocess seam (rust-ast-parser.ts) -- returns the wire envelope
  const parsed = await parseRustSource("// placeholder", opts);
  // Step 2: signature extraction (parse-fn-signature.ts)
  const sigs = extractFunctionSignatures(parsed);
  const sig = sigs[0];
  if (sig === undefined) throw new Error(`Fixture '${fixtureName}' has no functions`);
  // Step 3: render TS-subset IR (raise-function.ts)
  return renderFunctionDeclaration(sig);
}

// ---------------------------------------------------------------------------
// Suite: Success fixtures -- functions that must raise to TS-subset IR
// ---------------------------------------------------------------------------

describe("acceptance: successful Rust -> TS-subset IR raises (#868 slice 1)", () => {
  it("add-i32: pub fn, two i32 params, i32 return -> camelCase name + number types", async () => {
    const out = await runPipeline("add-i32");
    // Function name is already lowercase 'add' (no underscore to convert).
    expect(out).toMatch(/^export function add\(a: number, b: number\): number \{/);
    expect(out).toContain("a: number, b: number");
    expect(out).toContain(": number {");
    expect(out).toContain("// TODO: body raise (slice 2)");
  });

  it("greet-string: pub fn, String param, String return -> string types", async () => {
    const out = await runPipeline("greet-string");
    expect(out).toMatch(/^export function greet\(name: string\): string \{/);
    expect(out).toContain("name: string");
    expect(out).toContain(": string {");
  });

  it("is-even-bool: pub fn, i32 param, bool return -> number+boolean", async () => {
    const out = await runPipeline("is-even-bool");
    expect(out).toMatch(/^export function isEven\(n: number\): boolean \{/);
    expect(out).toContain("n: number");
    expect(out).toContain(": boolean {");
  });

  it("multiply-floats: pub fn, f64 params, f64 return -> snake_case->camelCase", async () => {
    const out = await runPipeline("multiply-floats");
    // multiply_floats -> multiplyFloats
    expect(out).toMatch(/^export function multiplyFloats\(x: number, y: number\): number \{/);
    expect(out).toContain("x: number, y: number");
  });

  it("noop-void: pub fn, no params, no return -> void return annotation", async () => {
    const out = await runPipeline("noop-void");
    expect(out).toMatch(/^export function noop\(\): void \{/);
    expect(out).toContain(": void {");
  });

  it("sum-vec: pub fn, Vec<i32> param, i32 return -> number[] param type", async () => {
    const out = await runPipeline("sum-vec");
    // sum_vec -> sumVec
    expect(out).toMatch(/^export function sumVec\(xs: number\[\]\): number \{/);
    expect(out).toContain("xs: number[]");
  });

  it("internal-add: non-pub fn, i32 params -> still raises (visibility gate is slice 4)", async () => {
    const out = await runPipeline("internal-add");
    // internal_add -> internalAdd
    expect(out).toMatch(/^export function internalAdd\(a: number, b: number\): number \{/);
    expect(out).toContain("a: number, b: number");
  });

  it("clamp-i32: three params, snake_case multi-word -> camelCase, value+minVal+maxVal", async () => {
    const out = await runPipeline("clamp-i32");
    // clamp -> clamp (no underscores; min_val -> minVal, max_val -> maxVal)
    expect(out).toMatch(/^export function clamp\(/);
    expect(out).toContain("value: number");
    expect(out).toContain("minVal: number");
    expect(out).toContain("maxVal: number");
    expect(out).toContain(": number {");
  });
});

// ---------------------------------------------------------------------------
// Suite: Real IR proof — show a complete end-to-end raised IR output
//
// This test documents the exact TS-subset IR produced for `pub fn add(a: i32, b: i32) -> i32`
// and serves as the "raised IR proof" required by the dispatch instructions.
// ---------------------------------------------------------------------------

describe("raised IR proof: pub fn add(a: i32, b: i32) -> i32", () => {
  it("produces correct TS-subset IR export declaration", async () => {
    const out = await runPipeline("add-i32");
    // Full expected output (slice 1 — body is a stub comment):
    const expected =
      "export function add(a: number, b: number): number {\n  // TODO: body raise (slice 2)\n}";
    expect(out).toBe(expected);
  });
});
