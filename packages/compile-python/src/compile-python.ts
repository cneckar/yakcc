// SPDX-License-Identifier: MIT
/**
 * compileToPython — main entry point for the Python lower adapter.
 *
 * Takes a BlockTripletRow (implSource + proof/properties.json artifact if
 * present) and returns a PythonCompileResult with the lowered .py source and
 * an optional hypothesis test file.
 */

import { emitHypothesisTests, validatePropertySpec } from "@yakcc/contracts";
import type { BlockTripletRow } from "@yakcc/registry";
import { lowerSource } from "./lower.js";
import { toSnakeCase } from "./names.js";
import type { LowerWarning, PythonCompileResult } from "./types.js";

export interface CompilePythonOptions {
  /** Function name override for the Python module. Defaults to the function found in implSource. */
  readonly fnName?: string | undefined;
}

/**
 * Lower a TS-subset IR atom to Python.
 *
 * Pipeline (per ADR Q3):
 *   implSource (TS-subset IR)
 *   → parse IR AST (ts-morph)
 *   → lower pass: IR AST → Python
 *   → camelCase → snake_case de-normalization
 *   → type re-expression (number→float, etc.)
 *   → stdlib re-mapping (Array.map → list comprehension, etc.)
 *   → emit Python source string
 *   → emit hypothesis test file (if proof/properties.json present)
 */
export function compileToPython(
  atom: BlockTripletRow,
  opts?: CompilePythonOptions,
): PythonCompileResult {
  const { pyLines, needsFunctools, needsOptional, warnings } = lowerSource(atom.implSource);

  // Build import block
  const importLines: string[] = [];
  if (needsOptional) {
    importLines.push("from typing import Optional");
  }
  if (needsFunctools) {
    importLines.push("import functools");
  }

  // Assemble the .py source
  const allLines = importLines.length > 0 ? [...importLines, "", ...pyLines] : pyLines;

  const source = allLines.join("\n");

  // Emit hypothesis test if proof/properties.json exists
  const testSource = buildTestSource(atom, warnings, opts);

  return { source, testSource, warnings };
}

function buildTestSource(
  atom: BlockTripletRow,
  warnings: LowerWarning[],
  opts?: CompilePythonOptions,
): string {
  // Look for proof/properties.json in the artifact map
  const propertiesBytes =
    atom.artifacts.get("proof/properties.json") ?? atom.artifacts.get("properties.json");
  if (!propertiesBytes) return "";

  let spec: ReturnType<typeof validatePropertySpec> | undefined;
  try {
    const json = new TextDecoder().decode(propertiesBytes);
    spec = validatePropertySpec(JSON.parse(json));
  } catch {
    warnings.push({
      kind: "proof-properties-parse-error",
      message: "Failed to parse proof/properties.json — hypothesis test not emitted",
    });
    return "";
  }

  // Derive the Python function name from the spec or the atom's implSource
  const fnName = opts?.fnName ?? deriveFnName(atom.implSource);
  const pyFnName = toSnakeCase(fnName);

  return emitHypothesisTests(spec, fnName, pyFnName);
}

// ---------------------------------------------------------------------------
// Helper: derive function name from implSource
// ---------------------------------------------------------------------------

const EXPORT_FN_RE = /export\s+function\s+([A-Za-z_$][A-Za-z0-9_$]*)/;

function deriveFnName(implSource: string): string {
  const m = EXPORT_FN_RE.exec(implSource);
  return m?.[1] ?? "fn";
}
