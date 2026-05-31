// SPDX-License-Identifier: MIT
/**
 * compileToGo -- main entry point for the Go lower adapter.
 *
 * Takes a BlockTripletRow (implSource) and returns a GoCompileResult
 * with the lowered .go source and warnings.
 *
 * @decision DEC-WI973-005
 * @title compileToGo is the public IR->Go emitter, mirroring compileToPython (#783)
 * @status accepted (WI-973)
 * @rationale
 *   Mirrors compileToPython from @yakcc/compile-python to keep the polyglot
 *   adapter surface consistent. Package declaration is prepended automatically
 *   with a sensible default ("yakcc") — callers can override via options.
 *   Go files always need a package statement; providing a default keeps the
 *   output immediately valid Go.
 */

import type { BlockTripletRow } from "@yakcc/registry";
import { lowerSource } from "./lower.js";
import type { GoLowerWarning } from "./lower.js";

export interface CompileGoOptions {
  /** Go package name for the output file. Defaults to "yakcc". */
  readonly packageName?: string | undefined;
}

export interface GoCompileResult {
  /** Emitted .go file content (the lowered implementation). */
  readonly source: string;
  /** Warnings collected during lowering. */
  readonly warnings: readonly GoLowerWarning[];
}

/**
 * Lower a TS-subset IR atom to Go.
 *
 * Pipeline:
 *   implSource (TS-subset IR)
 *   -> parse IR AST (ts-morph)
 *   -> lower pass: IR AST -> Go
 *   -> identifier transforms (camelCase -> PascalCase for exported functions)
 *   -> type re-expression (number->int, string->string, T[]->[]{T}, etc.)
 *   -> emit Go source string with package declaration
 *
 * Throws CannotLowerToGoError for any IR construct without a Go equivalent
 * (DEC-WI973-003). Callers should either:
 *   - Use canLowerTo(atom, "go") first as a screening gate, or
 *   - Wrap in try/catch and handle CannotLowerToGoError
 */
export function compileToGo(atom: BlockTripletRow, opts?: CompileGoOptions): GoCompileResult {
  const packageName = opts?.packageName ?? "yakcc";
  const { goLines, warnings, importPaths } = lowerSource(atom.implSource);

  // Synthesize import block (WI-977, DEC-WI977-001):
  //   - 0 imports: no import block
  //   - 1 import:  import "path"
  //   - 2+ imports: import (\n\t"path1"\n\t"path2"\n)
  // The block is inserted between the package declaration and the function lines.
  const importLines: string[] = [];
  if (importPaths.size === 1) {
    const [single] = importPaths;
    importLines.push(`import "${single}"`);
    importLines.push("");
  } else if (importPaths.size > 1) {
    // Sort for deterministic output
    const sorted = [...importPaths].sort();
    importLines.push("import (");
    for (const p of sorted) {
      importLines.push(`\t"${p}"`);
    }
    importLines.push(")");
    importLines.push("");
  }

  const allLines = [`package ${packageName}`, "", ...importLines, ...goLines];
  const source = `${allLines.join("\n").trimEnd()}\n`;

  return { source, warnings };
}
