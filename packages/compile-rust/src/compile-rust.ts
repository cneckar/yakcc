// SPDX-License-Identifier: Apache-2.0
/**
 * compileToRust -- main entry point for the Rust lower adapter.
 *
 * Takes a BlockTripletRow (implSource) and returns a RustCompileResult
 * with the lowered .rs source and warnings.
 *
 * @decision DEC-POLYGLOT-RUST-COMPILE-001
 * @title compileToRust is the public IR->Rust emitter, mirroring compileToPython (#783)
 * @status decided (Slice 1)
 * @rationale
 *   Mirrors compileToPython from @yakcc/compile-python and compileToGo from
 *   @yakcc/compile-go to keep the polyglot adapter surface consistent.
 *   The pipeline is: IR (TS-subset text) -> ts-morph AST -> Rust lines -> rustfmt.
 *   rustfmt is injected via SpawnImpl (identityRustfmtSpawn for tests, real spawn
 *   in production) so pure-Node CI needs no Rust toolchain installed.
 */

import type { BlockTripletRow } from "@yakcc/registry";
import type { RustLowerWarning } from "./lower.js";
import { lowerSource } from "./lower.js";
import { type RustfmtOptions, formatWithRustfmt } from "./rustfmt.js";

export interface CompileRustOptions {
  /**
   * rustfmt options (edition, spawnImpl).
   * Pass { spawnImpl: identityRustfmtSpawn() } in tests to skip real rustfmt.
   */
  readonly rustfmt?: RustfmtOptions | undefined;
  /**
   * If true, skip rustfmt formatting (returns raw emitter output).
   * Useful for unit tests that want to inspect raw lines without a mock.
   * Default: false.
   */
  readonly skipRustfmt?: boolean | undefined;
}

export interface RustCompileResult {
  /** Emitted .rs file content (the lowered implementation). */
  readonly source: string;
  /** Warnings collected during lowering. */
  readonly warnings: readonly RustLowerWarning[];
}

/**
 * Lower a TS-subset IR atom to Rust.
 *
 * Pipeline:
 *   implSource (TS-subset IR)
 *   -> parse IR AST (ts-morph)
 *   -> lower pass: IR AST -> Rust lines
 *   -> identifier transforms (camelCase -> snake_case for functions/params/locals)
 *   -> type re-expression (number->i32, string->String, T[]->Vec<T>, etc.)
 *   -> rustfmt pretty-print (injectable spawn; identity mock in tests)
 *   -> emit Rust source string
 *
 * Throws CannotLowerToRustError for any IR construct without a Rust equivalent.
 * Callers should either:
 *   - Use canLowerTo(atom, "rs") first as a screening gate, or
 *   - Wrap in try/catch and handle CannotLowerToRustError
 */
export async function compileToRust(
  atom: BlockTripletRow,
  opts?: CompileRustOptions,
): Promise<RustCompileResult> {
  const { rustLines, warnings } = lowerSource(atom.implSource);

  const allLines = [...rustLines];
  const rawSource = `${allLines.join("\n").trimEnd()}\n`;

  if (opts?.skipRustfmt === true) {
    return { source: rawSource, warnings };
  }

  const formatted = await formatWithRustfmt(rawSource, opts?.rustfmt);
  return { source: formatted, warnings };
}
