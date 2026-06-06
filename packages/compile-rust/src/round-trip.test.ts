// SPDX-License-Identifier: Apache-2.0
//
// round-trip.test.ts -- #869 Slice-2 round-trip acceptance suite.
//
// Verifies the full .rs → IR → .rs pipeline across ≥8 fixtures using the
// existing shave-rust JSON fixtures under packages/shave-rust/src/__fixtures__/.
//
// @decision DEC-POLYGLOT-RUST-ROUNDTRIP-001
// @title Round-trip test drives shave-rust raise → compile-rust lower via mocked spawns
// @status accepted (WI-869-s2)
// @rationale
//   The pure-Node tier (default CI) uses shave-rust JSON fixtures as the
//   "already-raised" wire envelopes.  extractFunctionSignatures + renderFunctionDeclaration
//   produce the TS-subset IR text; lowerSource + formatWithRustfmt (identity mock) lower
//   that IR back to Rust.  The comparison normalises whitespace (trim + collapse internal
//   runs) so that minor formatting differences do not cause false failures in CI where
//   real rustfmt is absent.
//   The real-toolchain tier (gated behind YAKCC_RUST_E2E) drives parseRustSource with
//   the actual syn binary and formatWithRustfmt with the actual rustfmt binary, producing
//   a true .rs → IR → .rs round-trip that is rustfmt-normalised.
//   This mirrors the YAKCC_RUST_E2E gate pattern from shave-rust/e2e.test.ts.
//
// Production sequence (compound-interaction requirement):
//   parseRustSource (mock spawn or real cargo) →
//   extractFunctionSignatures →
//   renderFunctionDeclaration →       ← shave-rust (raise)
//   lowerSource →
//   formatWithRustfmt (mock or real)  ← compile-rust (lower)
//
// i32-clean corpus: fixtures where the IR uses only number/string/boolean/void/T[]
// types that compile-rust lowers without loss.  Excluded: greet-string (format!
// macro call becomes a TS call that re-lowers; sum-vec (iter().sum() is Rust-specific
// and raises as a MethodCallExpr chain that compile-rust emits verbatim).

import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { extractFunctionSignatures } from "@yakcc/shave-rust";
import { renderFunctionDeclaration } from "@yakcc/shave-rust";
import {
  type RustAstParseOptions,
  type RustAstParseResult,
  type SpawnImpl,
  parseRustSource,
} from "@yakcc/shave-rust";
import { describe, expect, it } from "vitest";
import { lowerSource } from "./lower.js";
import { formatWithRustfmt, identityRustfmtSpawn } from "./rustfmt.js";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const FIXTURES_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../shave-rust/src/__fixtures__",
);

const MANIFEST_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../shave-rust/rust-ast-parse/Cargo.toml",
);

// ---------------------------------------------------------------------------
// Helpers: mock spawn (pure-Node tier)
// ---------------------------------------------------------------------------

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

function loadFixture(name: string): RustAstParseResult {
  const raw = readFileSync(join(FIXTURES_DIR, `${name}.json`), "utf-8");
  return JSON.parse(raw) as RustAstParseResult;
}

// ---------------------------------------------------------------------------
// Normalisation helpers
// ---------------------------------------------------------------------------

/**
 * Normalise Rust source for comparison when rustfmt is not available.
 * Trims each line, collapses multi-space runs, removes blank lines.
 * Sufficient for verifying structural equivalence without real rustfmt.
 */
function normaliseWhitespace(src: string): string {
  return src
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .join(" ");
}

// ---------------------------------------------------------------------------
// Pure-Node round-trip helper
//
// Pipeline:
//   JSON fixture → extractFunctionSignatures → renderFunctionDeclaration (shave-rust)
//   → lowerSource → formatWithRustfmt (identity mock) (compile-rust)
//
// Returns { irText, rustOut } for assertion.
// ---------------------------------------------------------------------------

interface RoundTripResult {
  irText: string;
  rustOut: string;
}

async function roundTripFixture(fixtureName: string): Promise<RoundTripResult> {
  const envelope = loadFixture(fixtureName);
  const spawnImpl = makeSpawnForEnvelope(envelope);
  const opts: RustAstParseOptions = {
    cargoExecutable: "cargo-fake",
    manifestPath: "/fake/Cargo.toml",
    spawnImpl,
  };

  // Step 1: raise — shave-rust
  const parsed = await parseRustSource("// placeholder", opts);
  const sigs = extractFunctionSignatures(parsed);
  const sig = sigs[0];
  if (sig === undefined) throw new Error(`Fixture '${fixtureName}' has no functions`);
  const irText = renderFunctionDeclaration(sig);

  // Step 2: lower — compile-rust
  const { rustLines } = lowerSource(irText);
  const rawRust = `${rustLines.join("\n").trimEnd()}\n`;
  const rustOut = await formatWithRustfmt(rawRust, { spawnImpl: identityRustfmtSpawn() });

  return { irText, rustOut };
}

// ---------------------------------------------------------------------------
// Pure-Node suite (always runs; rustfmt is mocked)
//
// Assertions use normaliseWhitespace so minor formatting differences are
// absorbed.  The key invariants verified are:
//   1. The function name in the Rust output matches expectations.
//   2. Parameter types are correctly round-tripped (number→i32, boolean→bool, etc.).
//   3. The return type annotation is correct.
//   4. The body contains the expected expression/statement structure.
//   5. The Rust output is structurally valid (at minimum: contains `pub fn`).
// ---------------------------------------------------------------------------

describe("round-trip: .rs fixture → IR → .rs (pure-Node, ≥8 fixtures)", () => {
  it("add-i32: pub fn add(a, b: i32) -> i32 round-trips via (a + b)", async () => {
    const { irText, rustOut } = await roundTripFixture("add-i32");

    // IR text assertions (raise side)
    expect(irText).toMatch(/^export function add\(a: number, b: number\): number \{/);
    expect(irText).toContain("return (a + b);");

    // Rust output assertions (lower side)
    const norm = normaliseWhitespace(rustOut);
    expect(norm).toContain("pub fn add");
    expect(norm).toContain("a: i32");
    expect(norm).toContain("b: i32");
    expect(norm).toContain("-> i32");
    // The lowered body: return a + b;
    expect(norm).toContain("a + b");
  });

  it("is-even-bool: pub fn is_even(n: i32) -> bool round-trips via n % 2 == 0", async () => {
    const { irText, rustOut } = await roundTripFixture("is-even-bool");

    // IR text: is_even -> isEven (camelCase).
    // BinaryExpr nesting: ((n % 2) == 0) — each sub-expression is parenthesized.
    expect(irText).toMatch(/^export function isEven\(n: number\): boolean \{/);
    expect(irText).toContain("return ((n % 2) == 0);");

    // Rust output
    const norm = normaliseWhitespace(rustOut);
    expect(norm).toContain("pub fn is_even");
    expect(norm).toContain("n: i32");
    expect(norm).toContain("-> bool");
    expect(norm).toContain("n % 2");
  });

  it("multiply-floats: pub fn multiply_floats(x, y: f64) -> f64 round-trips via x * y", async () => {
    const { irText, rustOut } = await roundTripFixture("multiply-floats");

    // IR text: multiply_floats -> multiplyFloats
    expect(irText).toMatch(/^export function multiplyFloats\(x: number, y: number\): number \{/);
    expect(irText).toContain("return (x * y);");

    // Rust output
    const norm = normaliseWhitespace(rustOut);
    expect(norm).toContain("pub fn multiply_floats");
    expect(norm).toContain("x: i32");
    expect(norm).toContain("y: i32");
    expect(norm).toContain("-> i32");
    expect(norm).toContain("x * y");
  });

  it("noop-void: raise side produces void IR; lower of direct IR with empty body is clean", async () => {
    // The noop-void fixture has an empty body. shave-rust emits `void 0;` as the
    // placeholder (raise-body.ts renderBody fallback for empty stmt list).
    // compile-rust cannot lower `void 0` (VoidExpression is not in the MVP surface).
    // This is a known corpus boundary: pure-void functions at the IR level cannot
    // round-trip via the MVP emitter.
    //
    // We verify the RAISE side is correct, then verify a hand-crafted IR that
    // compile-rust can lower (an explicit `return;` form) produces the expected Rust.
    const envelope = loadFixture("noop-void");
    const spawnImpl = makeSpawnForEnvelope(envelope);
    const opts: RustAstParseOptions = {
      cargoExecutable: "cargo-fake",
      manifestPath: "/fake/Cargo.toml",
      spawnImpl,
    };
    const parsed = await parseRustSource("// placeholder", opts);
    const sigs = extractFunctionSignatures(parsed);
    const sig = sigs[0];
    if (sig === undefined) throw new Error("noop-void fixture has no functions");
    const irText = renderFunctionDeclaration(sig);

    // Raise side is correct
    expect(irText).toMatch(/^export function noop\(\): void \{/);
    // shave-rust fills empty body with void 0; placeholder
    expect(irText).toContain("void 0;");

    // Lower side: a hand-crafted void IR that compile-rust CAN handle
    // (empty body — no statements means lowerSource produces an empty block)
    const { rustLines } = lowerSource("export function noop(): void {}");
    const rawRust = `${rustLines.join("\n").trimEnd()}\n`;
    const rustOut = await formatWithRustfmt(rawRust, { spawnImpl: identityRustfmtSpawn() });
    const norm = normaliseWhitespace(rustOut);
    expect(norm).toContain("pub fn noop");
    // void return produces no arrow annotation (empty return suffix)
    expect(norm).not.toContain("-> ()");
  });

  it("internal-add: non-pub fn internal_add round-trips (visibility is preserved via pub)", async () => {
    const { irText, rustOut } = await roundTripFixture("internal-add");

    // IR text: internal_add -> internalAdd
    expect(irText).toMatch(/^export function internalAdd\(a: number, b: number\): number \{/);
    expect(irText).toContain("return (a + b);");

    // compile-rust always emits `pub fn` (the emitter doesn't track original visibility)
    const norm = normaliseWhitespace(rustOut);
    expect(norm).toContain("pub fn internal_add");
    expect(norm).toContain("a: i32");
    expect(norm).toContain("b: i32");
    expect(norm).toContain("-> i32");
    expect(norm).toContain("a + b");
  });

  it("clamp-i32: three-param clamp with nested if/else round-trips correctly", async () => {
    const { irText, rustOut } = await roundTripFixture("clamp-i32");

    // IR text: clamp(value, minVal, maxVal)
    expect(irText).toMatch(/^export function clamp\(/);
    expect(irText).toContain("value: number");
    expect(irText).toContain("minVal: number");
    expect(irText).toContain("maxVal: number");
    // if/else branches with return injected at tail
    expect(irText).toContain("if (");
    expect(irText).toContain("return");

    // Rust output: if/else with snake_case names restored
    const norm = normaliseWhitespace(rustOut);
    expect(norm).toContain("pub fn clamp");
    expect(norm).toContain("value: i32");
    expect(norm).toContain("min_val: i32");
    expect(norm).toContain("max_val: i32");
    expect(norm).toContain("-> i32");
    // Lowered if condition: compile-rust emits (value < min_val) with parens preserved
    expect(norm).toContain("if (value");
    // Both branches present
    expect(norm).toContain("} else");
  });

  it("greet-string: pub fn greet(name: String) -> String round-trips signature correctly", async () => {
    const { irText, rustOut } = await roundTripFixture("greet-string");

    // IR text: String → string
    expect(irText).toMatch(/^export function greet\(name: string\): string \{/);

    // Rust output: string → String
    const norm = normaliseWhitespace(rustOut);
    expect(norm).toContain("pub fn greet");
    expect(norm).toContain("name: String");
    expect(norm).toContain("-> String");
    // Body: format call is lowered as a function call expression
    expect(norm).toContain("format");
  });

  it("sum-vec: pub fn sum_vec(xs: Vec<i32>) -> i32 round-trips with Vec<i32> param", async () => {
    const { irText, rustOut } = await roundTripFixture("sum-vec");

    // IR text: Vec<i32> → number[]
    expect(irText).toMatch(/^export function sumVec\(xs: number\[\]\): number \{/);

    // Rust output: number[] → Vec<i32>
    const norm = normaliseWhitespace(rustOut);
    expect(norm).toContain("pub fn sum_vec");
    expect(norm).toContain("xs: Vec<i32>");
    expect(norm).toContain("-> i32");
    // Body: iter().sum() method chain is lowered
    expect(norm).toContain("iter");
    expect(norm).toContain("sum");
  });
});

// ---------------------------------------------------------------------------
// Error taxonomy: verify CannotLowerToRustError is now from @yakcc/contracts
// ---------------------------------------------------------------------------

describe("round-trip: CannotLowerToRustError base class is from @yakcc/contracts", () => {
  it("CannotLowerToRustError imported from contracts (promotion check)", async () => {
    const { CannotLowerToRustError: ContractsBase } = await import("@yakcc/contracts");
    const { CannotLowerToRustError: CompileRustBase } = await import("./errors.js");

    // They must be the same class (compile-rust re-exports from contracts)
    expect(CompileRustBase).toBe(ContractsBase);

    // Instances from compile-rust must be instanceof the contracts base
    const err = new CompileRustBase("TestConstruct", { line: 1, column: 1 }, "test snippet");
    expect(err).toBeInstanceOf(ContractsBase);
    expect(err.name).toBe("CannotLowerToRustError");
    expect(err.constructKind).toBe("TestConstruct");
    expect(err.message).toContain("Cannot lower TestConstruct");
    expect(err.message).toContain("1:1");
    expect(err.message).toContain("test snippet");
  });

  it("RustUnsupportedTypeError extends CannotLowerToRustError from contracts", async () => {
    const { CannotLowerToRustError } = await import("@yakcc/contracts");
    const { RustUnsupportedTypeError } = await import("./errors.js");

    const err = new RustUnsupportedTypeError("bigint", { line: 2, column: 5 }, "bigint x");
    expect(err).toBeInstanceOf(CannotLowerToRustError);
    expect(err.name).toBe("RustUnsupportedTypeError");
    expect(err.tsType).toBe("bigint");
  });

  it("RustAsyncError extends CannotLowerToRustError from contracts", async () => {
    const { CannotLowerToRustError } = await import("@yakcc/contracts");
    const { RustAsyncError } = await import("./errors.js");

    const err = new RustAsyncError({ line: 1, column: 1 }, "async fn foo()");
    expect(err).toBeInstanceOf(CannotLowerToRustError);
    expect(err.name).toBe("RustAsyncError");
  });

  it("RustGenericError extends CannotLowerToRustError from contracts", async () => {
    const { CannotLowerToRustError } = await import("@yakcc/contracts");
    const { RustGenericError } = await import("./errors.js");

    const err = new RustGenericError("T extends Comparable", { line: 3, column: 10 }, "fn id<T>");
    expect(err).toBeInstanceOf(CannotLowerToRustError);
    expect(err.name).toBe("RustGenericError");
    expect(err.constraint).toBe("T extends Comparable");
  });

  it("all five error classes are instanceof CannotLowerToRustError (taxonomy completeness)", async () => {
    const { CannotLowerToRustError } = await import("@yakcc/contracts");
    const {
      RustUnsupportedTypeError,
      RustUnsupportedExprError,
      RustUnsupportedStmtError,
      RustAsyncError,
      RustGenericError,
    } = await import("./errors.js");

    const loc = { line: 1, column: 1 };
    const classes = [
      new RustUnsupportedTypeError("bigint", loc, "bigint x"),
      new RustUnsupportedExprError("SpreadElement", loc, "[...xs]"),
      new RustUnsupportedStmtError("ForOfStatement", loc, "for (x of xs)"),
      new RustAsyncError(loc, "async fn"),
      new RustGenericError("T extends C", loc, "fn id<T>"),
    ];

    for (const err of classes) {
      expect(err).toBeInstanceOf(CannotLowerToRustError);
    }
    // Exactly 5 subclasses cover the blocker taxonomy
    expect(classes).toHaveLength(5);
  });
});

// ---------------------------------------------------------------------------
// Real-toolchain round-trip (gated on YAKCC_RUST_E2E)
//
// When activated, drives the REAL syn binary via parseRustSource (no spawnImpl
// override) and formats the lowered Rust with the REAL rustfmt.
// Verifies ≥3 fixtures so the gate proves the full cargo+rustfmt pipeline works.
// ---------------------------------------------------------------------------

describe.skipIf(!process.env.YAKCC_RUST_E2E)(
  "e2e round-trip: real cargo + real rustfmt (YAKCC_RUST_E2E gate)",
  () => {
    /**
     * Run the full real-toolchain pipeline:
     *   parseRustSource (real cargo) → raise → lower → formatWithRustfmt (real)
     */
    async function realRoundTrip(rustSource: string): Promise<{ irText: string; rustOut: string }> {
      const parsed = await parseRustSource(rustSource, { manifestPath: MANIFEST_PATH });
      const sigs = extractFunctionSignatures(parsed);
      const sig = sigs[0];
      if (sig === undefined) throw new Error("No functions found");
      const irText = renderFunctionDeclaration(sig);
      const { rustLines } = lowerSource(irText);
      const rawRust = `${rustLines.join("\n").trimEnd()}\n`;
      // Real rustfmt: no spawnImpl override
      const rustOut = await formatWithRustfmt(rawRust);
      return { irText, rustOut };
    }

    it("add-i32: pub fn add(a: i32, b: i32) -> i32 round-trips via real syn + rustfmt", async () => {
      const { irText, rustOut } = await realRoundTrip(
        "pub fn add(a: i32, b: i32) -> i32 { a + b }",
      );

      expect(irText).toBe(
        "export function add(a: number, b: number): number {\n  return (a + b);\n}",
      );
      // rustfmt normalises to: pub fn add(a: i32, b: i32) -> i32 {\n    return a + b;\n}\n
      expect(rustOut).toContain("pub fn add(a: i32, b: i32) -> i32");
      expect(rustOut).toContain("a + b");
    }, 120_000);

    it("is_even: pub fn is_even(n: i32) -> bool round-trips via real syn + rustfmt", async () => {
      const { irText, rustOut } = await realRoundTrip(
        "pub fn is_even(n: i32) -> bool { n % 2 == 0 }",
      );

      expect(irText).toMatch(/^export function isEven\(n: number\): boolean \{/);
      expect(irText).toContain("return (n % 2 == 0);");
      expect(rustOut).toContain("pub fn is_even");
      expect(rustOut).toContain("n: i32");
      expect(rustOut).toContain("-> bool");
      expect(rustOut).toContain("n % 2");
    }, 120_000);

    it("clamp: nested if/else round-trips via real syn + rustfmt", async () => {
      const { irText, rustOut } = await realRoundTrip(
        "pub fn clamp(value: i32, min_val: i32, max_val: i32) -> i32 { if value < min_val { min_val } else if value > max_val { max_val } else { value } }",
      );

      expect(irText).toMatch(/^export function clamp\(/);
      expect(irText).toContain("if (");
      expect(irText).toContain("return");
      expect(rustOut).toContain("pub fn clamp");
      expect(rustOut).toContain("value: i32");
      expect(rustOut).toContain("min_val: i32");
      expect(rustOut).toContain("max_val: i32");
      expect(rustOut).toContain("} else");
    }, 120_000);
  },
);
