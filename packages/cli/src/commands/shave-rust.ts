// SPDX-License-Identifier: MIT
//
// shave-rust.ts — CLI helper that drives the @yakcc/shave-rust public API
// to shave a Rust source file into TS-subset IR atoms.
//
// @decision DEC-POLYGLOT-RUST-CLI-001
// @title yakcc shave arg shape + extension-driven Rust dispatch via @yakcc/shave-rust
// @status accepted (WI-868 slice 4)
// @rationale
//   This helper is called by shave.ts when the target language is "rust".
//   It composes the shave-rust pipeline primitives (parseRustSource,
//   extractFunctionSignatures, renderFunctionDeclaration) because
//   @yakcc/shave-rust does not export a single "shave this file" function.
//   The composition lives here so the CLI boundary is thin — mirrors exactly
//   the shave-python.ts pattern (DEC-WI877-001).
//
//   Injectable spawnImpl threads through as RustAstParseOptions.spawnImpl so
//   tests can exercise the full CLI path with a mock subprocess and no Rust
//   toolchain installed (same mock pattern as acceptance.test.ts in shave-rust).
//
//   The compile/lower path (emit Rust source from IR) is tracked by #869 and
//   remains stubbed.  This module only owns the shave/raise direction.
//
//   Exit semantics (mirrors shave-python.ts):
//     0 — ≥1 function raised successfully.
//     1 — zero functions succeeded (all skipped or no fns found), or I/O error.
//     2 — parse-level failure (cargo absent, non-zero exit, JSON schema error).
//
//   Output semantics (mirrors DEC-WI877-006 for Python):
//     Default: stdout.  --out <file>: write all functions concatenated.
//     --out <dir>: write one file per function (<dir>/<fn>.ir.ts).
//     --out <file> with multiple functions + no --function: error.
//
//   Cross-reference: PLAN.md §4 / #868 / DEC-POLYGLOT-RUST-001

import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ParseArgsOptionsConfig } from "node:util";
import {
  AdapterSubprocessError,
  type RustAstParseOptions,
  type SpawnImpl,
  extractFunctionSignatures,
  parseRustSource,
  renderFunctionDeclaration,
} from "@yakcc/shave-rust";
import type { Logger } from "../index.js";

/** @internal — exported for testing via injection. */
export const SHAVE_RUST_PARSE_OPTIONS = {
  function: { type: "string" },
  out: { type: "string", short: "o" },
  // recognized but intentionally ignored for rust target (DEC-POLYGLOT-RUST-CLI-001)
  registry: { type: "string" },
  offline: { type: "boolean", default: false },
  "foreign-policy": { type: "string" },
  target: { type: "string" },
  help: { type: "boolean", short: "h", default: false },
} as const satisfies ParseArgsOptionsConfig;

/** Parsed options shape for runShaveRust. */
export interface ShaveRustArgs {
  filePath: string;
  functionFilter: string | undefined;
  out: string | undefined;
  /** Ignored-flags that were passed — warn to stderr. */
  ignoredForeignPolicy: boolean;
}

/**
 * Injectable options for the Rust subprocess.  In tests, callers pass a mock
 * `spawnImpl` that emits a JSON envelope without invoking cargo.
 */
export interface ShaveRustOpts {
  spawnImpl?: SpawnImpl;
  cargoExecutable?: string;
  manifestPath?: string;
}

/**
 * Run the Rust shave pipeline for a single file.
 *
 * Called from shave.ts when the inferred/explicit target is "rust".
 *
 * @param args   Parsed shave-rust argument shape.
 * @param logger Output sink.
 * @param opts   Optional injectable subprocess options (for testing).
 * @returns 0 on success (≥1 function shaved), 1 on total failure, 2 on parse failure.
 */
export async function runShaveRust(
  { filePath, functionFilter, out, ignoredForeignPolicy }: ShaveRustArgs,
  logger: Logger,
  opts?: ShaveRustOpts,
): Promise<number> {
  // Warn about ignored flags so the operator is not confused.
  if (ignoredForeignPolicy) {
    logger.error("warning: --foreign-policy ignored for --target rust");
  }

  // 1. Read the Rust source file.
  let content: string;
  try {
    content = readFileSync(filePath, "utf-8");
  } catch (err) {
    logger.error(`error: cannot read file ${filePath}: ${(err as Error).message}`);
    return 1;
  }

  // 2. Parse via syn subprocess (cargo-backed; injectable for tests).
  //    Construct opts object at once — RustAstParseOptions properties are readonly.
  const parseOpts: RustAstParseOptions = {
    ...(opts?.spawnImpl !== undefined && { spawnImpl: opts.spawnImpl }),
    ...(opts?.cargoExecutable !== undefined && { cargoExecutable: opts.cargoExecutable }),
    ...(opts?.manifestPath !== undefined && { manifestPath: opts.manifestPath }),
  };

  let envelope: Awaited<ReturnType<typeof parseRustSource>>;
  try {
    envelope = await parseRustSource(content, parseOpts);
  } catch (err) {
    if (err instanceof AdapterSubprocessError) {
      // Cargo absent or non-zero exit — actionable remediation hint is in the message.
      logger.error(`error: parse failed for ${filePath}: ${err.message}`);
    } else {
      logger.error(`error: parse failed for ${filePath}: ${(err as Error).message}`);
    }
    return 2;
  }

  // 3. Extract function signatures.
  let signatures: ReturnType<typeof extractFunctionSignatures>;
  try {
    signatures = extractFunctionSignatures(envelope);
  } catch (err) {
    logger.error(`error: signature extraction failed: ${(err as Error).message}`);
    return 2;
  }

  // 4. Apply --function filter.
  if (functionFilter !== undefined) {
    signatures = signatures.filter((s) => s.name === functionFilter);
    if (signatures.length === 0) {
      logger.error(`error: function '${functionFilter}' not found in ${filePath}`);
      return 1;
    }
  }

  if (signatures.length === 0) {
    logger.error(`error: no functions found in ${filePath}`);
    return 1;
  }

  // 5. Validate --out semantics: file path + multiple functions + no --function → error.
  if (
    out !== undefined &&
    !isDirectoryTarget(out) &&
    signatures.length > 1 &&
    functionFilter === undefined
  ) {
    logger.error(
      `error: --out must be a directory when input has multiple functions; got file path "${out}"`,
    );
    return 1;
  }

  // 6. Raise each function to TS-subset IR (per-function, continue on error).
  const results: Array<{ name: string; ir: string }> = [];
  for (const sig of signatures) {
    try {
      const ir = renderFunctionDeclaration(sig);
      results.push({ name: sig.name, ir });
    } catch (err) {
      logger.error(`shave-error: ${sig.name}: [raise-error] ${(err as Error).message}`);
    }
  }

  if (results.length === 0) {
    return 1;
  }

  // 7. Write output.
  if (out === undefined) {
    // stdout — concatenate with banners when multiple functions.
    if (results.length === 1) {
      // biome-ignore lint/style/noNonNullAssertion: length === 1 ensures index 0 exists
      logger.log(results[0]!.ir);
    } else {
      for (const { name, ir } of results) {
        logger.log(`// ---- function: ${name} ----`);
        logger.log(ir);
      }
    }
    return 0;
  }

  if (isDirectoryTarget(out)) {
    // Write one file per function.
    mkdirSync(out, { recursive: true });
    for (const { name, ir } of results) {
      const outFile = join(out, `${name}.ir.ts`);
      writeFileSync(outFile, ir, "utf-8");
    }
  } else {
    // Write all functions concatenated to a single file.
    const combined = results
      .map(({ name, ir }) => (results.length > 1 ? `// ---- function: ${name} ----\n${ir}` : ir))
      .join("\n\n");
    writeFileSync(out, combined, "utf-8");
  }

  return 0;
}

/**
 * Returns true when `outPath` should be treated as a directory target.
 * Heuristic: ends with "/" OR is an existing directory.
 */
function isDirectoryTarget(outPath: string): boolean {
  if (outPath.endsWith("/") || outPath.endsWith("\\")) {
    return true;
  }
  try {
    return statSync(outPath).isDirectory();
  } catch {
    return false;
  }
}
