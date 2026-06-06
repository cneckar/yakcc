// SPDX-License-Identifier: Apache-2.0
//
// e2e.test.ts — real-cargo end-to-end test for @yakcc/shave-rust (WI-868-2F).
//
// This suite is SKIPPED unless `YAKCC_RUST_E2E=1` is set in the environment.
// When skipped, the suite exits cleanly so pr-ci.yml (TS-only, no cargo)
// remains green.
//
// When activated (polyglot-rust.yml after `cargo build`), the suite invokes
// the REAL syn binary via the default spawnImpl (node:child_process.spawn)
// and drives the full production pipeline:
//   parseRustSource (real cargo run) ->
//   extractFunctionSignatures ->
//   renderFunctionDeclaration
//
// Two fixture Rust sources are tested:
//   1. add-i32: `pub fn add(a: i32, b: i32) -> i32 { a + b }` — signature + binop body.
//   2. check-sign: `pub fn check_sign(n: i32) -> bool { if n > 0 { true } else { false } }` —
//      if/else body with implicit return from each branch.
//
// Compound-interaction requirement (CLAUDE.md): each test drives the real
// production sequence across all three internal component boundaries:
//   rust-ast-parser.ts (real cargo spawn) -> parse-fn-signature.ts -> raise-function.ts
// No subprocess mock is used; the binary must be on PATH or reachable via the
// manifest path shipped with this package.
//
// @decision DEC-POLYGLOT-RUST-E2E-GATE-001 (WI-868-2F)
// @title Real-cargo e2e suite gated on YAKCC_RUST_E2E env var (mirrors DEC-POLYGLOT-CI-RUST-001)
// @status accepted (WI-868-2F)
// @rationale
//   The default pnpm test command runs in pure-Node CI with no Rust toolchain.
//   An env-var gate (describe.skipIf) is the standard pattern in this repo
//   (mirrors polyglot-py.yml and shave-go acceptance gating) for toolchain-
//   dependent tests.  The gate is activated by polyglot-rust.yml after
//   `cargo build` succeeds, ensuring the binary is already compiled and the
//   cold-start penalty applies only to that CI workflow.
//   The manifestPath is resolved from src/ at test-time (import.meta.url
//   points to the source file; vitest uses tsx/esbuild, so the path is
//   packages/shave-rust/src -> ../rust-ast-parse/Cargo.toml).
//   This matches DEC-SHAVE-RUST-MANIFEST-PATH-001 in rust-ast-parser.ts which
//   handles the dist/ layout for production callers; the source-file layout
//   resolves identically because src/ and dist/ are siblings of rust-ast-parse/.

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { RustMutableBorrowError } from "./errors.js";
import { extractFunctionSignatures } from "./parse-fn-signature.js";
import { renderFunctionDeclaration } from "./raise-function.js";
import { parseRustSource } from "./rust-ast-parser.js";

// ---------------------------------------------------------------------------
// Manifest path (resolved from this source file at test-time)
//
// When vitest runs src/e2e.test.ts, import.meta.url resolves to
//   file:///.../packages/shave-rust/src/e2e.test.ts
// dirname -> packages/shave-rust/src
// resolve(.., "rust-ast-parse", "Cargo.toml") -> packages/shave-rust/rust-ast-parse/Cargo.toml
// This is the same binary path used by the default manifest resolver in
// rust-ast-parser.ts (DEC-SHAVE-RUST-MANIFEST-PATH-001), which walks from
// dist/ the same number of levels up.
// ---------------------------------------------------------------------------

const MANIFEST_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "rust-ast-parse",
  "Cargo.toml",
);

// ---------------------------------------------------------------------------
// Full-pipeline helper (no spawnImpl override — uses real cargo)
// ---------------------------------------------------------------------------

/**
 * Run the full production pipeline against the real cargo binary.
 *
 * parseRustSource is called WITHOUT spawnImpl so the default node:child_process.spawn
 * is used. YAKCC_RUST_E2E tests must NOT be run without cargo on PATH.
 *
 * Returns the rendered TS-subset IR text for the FIRST function in the source.
 * Throws AdapterSubprocessError if cargo is not on PATH or parse fails.
 */
async function runRealPipeline(rustSource: string): Promise<string> {
  // No spawnImpl override: the real cargo binary is invoked.
  const parsed = await parseRustSource(rustSource, { manifestPath: MANIFEST_PATH });
  const sigs = extractFunctionSignatures(parsed);
  const sig = sigs[0];
  if (sig === undefined) {
    throw new Error("No functions found in parsed result");
  }
  // Pass file label for error reporting; matches the test source label.
  return renderFunctionDeclaration(sig, "e2e.test.ts");
}

// ---------------------------------------------------------------------------
// Rust source strings for the two e2e fixtures
// ---------------------------------------------------------------------------

// Fixture 1: simple binop body — used to verify signature raise + body binop.
const ADD_SOURCE = "pub fn add(a: i32, b: i32) -> i32 { a + b }";

// Fixture 2: if/else body — used to verify the v2 IfExpr wire type and tail
// return injection from renderIfExprAsTailStmt in raise-body.ts.
const CHECK_SIGN_SOURCE = "pub fn check_sign(n: i32) -> bool { if n > 0 { true } else { false } }";

// Fixture 3: impure fn with &mut T param — used to verify the purity gate fires
// against the REAL syn binary (RustMutableBorrowError thrown end-to-end).
//
// `pub fn bump(x: &mut i32) -> i32 { *x }` is the minimal raiseable source:
//   - syn can parse it without panicking
//   - the param type "&mut i32" is detected by hasMutableBorrow in purity-check.ts
//   - renderFunctionDeclaration calls checkPurity BEFORE body raise, so the error
//     is thrown inside runRealPipeline (async) and propagates as a rejected Promise
const BUMP_IMPURE_SOURCE = "pub fn bump(x: &mut i32) -> i32 { *x }";

// ---------------------------------------------------------------------------
// Suite: real-cargo end-to-end (skipped without YAKCC_RUST_E2E)
// ---------------------------------------------------------------------------

describe.skipIf(!process.env.YAKCC_RUST_E2E)(
  "e2e: real cargo binary — full pipeline (WI-868-2F)",
  () => {
    // Generous timeout: cargo run includes a cold-start compile on first run.
    // Vitest 4 API: timeout is the second argument to it(), not a third options object.
    it("add: simple binop body raises to return (a + b) via real syn binary", async () => {
      const out = await runRealPipeline(ADD_SOURCE);

      // Function signature assertions
      expect(out).toMatch(/^export function add\(a: number, b: number\): number \{/);
      expect(out).toContain("a: number, b: number");
      expect(out).toContain(": number {");

      // Body assertions: binop tail expression -> return statement
      expect(out).toContain("return (a + b);");

      // Full IR proof — exact expected text (end-to-end canonical form):
      const expected = "export function add(a: number, b: number): number {\n  return (a + b);\n}";
      expect(out).toBe(expected);
    }, 120_000);

    it("bump: purity gate rejects &mut i32 param via real syn binary (RustMutableBorrowError e2e)", async () => {
      // Production sequence (compound-interaction):
      //   parseRustSource (REAL cargo spawn) ->
      //   extractFunctionSignatures ->
      //   renderFunctionDeclaration ->
      //   checkPurity (throws RustMutableBorrowError for &mut T param)
      //
      // This proves the purity gate fires against the real syn binary, not a mock.
      await expect(runRealPipeline(BUMP_IMPURE_SOURCE)).rejects.toThrow(RustMutableBorrowError);
    }, 120_000);

    it("check_sign: if/else body raises to branching returns via real syn binary (v2 IfExpr envelope)", async () => {
      const out = await runRealPipeline(CHECK_SIGN_SOURCE);

      // Function signature assertions (snake_case -> camelCase normalization)
      expect(out).toMatch(/^export function checkSign\(n: number\): boolean \{/);
      expect(out).toContain("n: number");
      expect(out).toContain(": boolean {");

      // Body assertions: if/else tail expression with return injected in each branch
      expect(out).toContain("if ((n > 0))");
      expect(out).toContain("return true;");
      expect(out).toContain("return false;");
      expect(out).toContain("} else {");

      // Full IR proof — exact expected text:
      const expected = [
        "export function checkSign(n: number): boolean {",
        "  if ((n > 0)) {",
        "    return true;",
        "  } else {",
        "    return false;",
        "  }",
        "}",
      ].join("\n");
      expect(out).toBe(expected);
    }, 120_000);
  },
);
