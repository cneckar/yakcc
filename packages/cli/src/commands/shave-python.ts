// SPDX-License-Identifier: MIT
//
// shave-python.ts — CLI helper that drives the @yakcc/shave-python public API
// to shave a Python source file into TS-subset IR atoms.
//
// @decision DEC-WI877-001
// @title yakcc shave arg shape + extension-driven Python dispatch + TS-path preserved verbatim
// @status accepted (WI-877)
// @rationale
//   This helper is called by shave.ts when the target language is "python".
//   It composes the shave-python pipeline primitives (parsePythonSource,
//   extractFunctionSignatures, raiseFunctionWithPurityAndNormalization) because
//   @yakcc/shave-python does not export a single "shave this file" function.
//   The composition lives here so the CLI boundary is thin.
//   Cross-reference: PLAN.md §3.1 §3.3 / #877
//
// @decision DEC-WI877-004
// @title Per-function continuation + exit-code semantics
// @status accepted (WI-877)
// @rationale
//   Per-function failures do not abort the whole file.  Exit 0 if ≥1 function
//   succeeded, exit 1 if zero succeeded, exit 2 if parse-level failure.
//   Cross-reference: PLAN.md §4 / #877
//
// @decision DEC-WI877-006
// @title stdout / --out semantics for shave
// @status accepted (WI-877)
// @rationale
//   Default: stdout.  --out <file>: write all functions concatenated.
//   --out <dir>: write one file per function (<dir>/<fn>.ir.ts).
//   --out <file> with multiple functions + no --function: error.
//   Cross-reference: PLAN.md §4 / #877
//
// @decision DEC-WI877-008 §B
// @title Python shave writes to stdout/--out; does NOT write to the registry
// @status accepted (WI-877)
// @rationale
//   Python pipeline produces IR text only (no spec, no proof, no merkle root).
//   Wedging it into storeBlock would require fabricating triplet fields and
//   misrepresent the data.  The asymmetry with TS shave (registry-write) is
//   documented here and in the help text.
//   Cross-reference: PLAN.md §4 / #877
//
// @decision DEC-WI877-008 §C
// @title Body-reach for shave-python is mirrored, not fixed
// @status accepted (WI-877)
// @rationale
//   @yakcc/shave-python does not expose a typed body-extractor function in its
//   public API.  The reach pattern below (`envelope.module.functions[].body`)
//   mirrors the pattern used in the integration tests of @yakcc/shave-python.
//   TODO(#follow-up): file a tracking issue to publish a typed body extractor
//   in @yakcc/shave-python so CLI no longer reaches into the untyped envelope.
//   Cross-reference: PLAN.md §3.3 / #877

import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ParseArgsOptionsConfig } from "node:util";
import {
  ImpureFunctionError,
  MissingTypeAnnotationError,
  UnsupportedAstError,
  UnsupportedTypeError,
  extractFunctionSignatures,
  parsePythonSource,
  raiseFunctionWithPurityAndNormalization,
} from "@yakcc/shave-python";
import type { WireStmt } from "@yakcc/shave-python";
import type { Logger } from "../index.js";

/** @internal — exported for testing via vi.mock injection. */
export const SHAVE_PYTHON_PARSE_OPTIONS = {
  function: { type: "string" },
  out: { type: "string", short: "o" },
  // recognized but intentionally ignored for python target (DEC-WI877-001)
  registry: { type: "string" },
  offline: { type: "boolean", default: false },
  "foreign-policy": { type: "string" },
  target: { type: "string" },
  help: { type: "boolean", short: "h", default: false },
} as const satisfies ParseArgsOptionsConfig;

/** Parsed options shape for runShavePython. */
export interface ShavePythonArgs {
  filePath: string;
  functionFilter: string | undefined;
  out: string | undefined;
  /** Ignored-flags that were passed — warn to stderr. */
  ignoredForeignPolicy: boolean;
}

/**
 * Run the Python shave pipeline for a single file.
 *
 * Called from shave.ts when the inferred/explicit target is "python".
 *
 * @param filePath       Absolute or relative path to the Python source file.
 * @param functionFilter If set, only this function name is processed.
 * @param out            --out value (file or directory path), or undefined for stdout.
 * @param logger         Output sink.
 * @returns 0 on success (≥1 function shaved), 1 on total failure, 2 on parse failure.
 */
export async function runShavePython(
  { filePath, functionFilter, out, ignoredForeignPolicy }: ShavePythonArgs,
  logger: Logger,
): Promise<number> {
  // Warn about ignored flags so the operator is not confused.
  if (ignoredForeignPolicy) {
    logger.error("warning: --foreign-policy ignored for --target python");
  }

  // 1. Read the Python source file.
  let content: string;
  try {
    content = readFileSync(filePath, "utf-8");
  } catch (err) {
    logger.error(`error: cannot read file ${filePath}: ${(err as Error).message}`);
    return 1;
  }

  // 2. Parse via libcst subprocess.
  let envelope: Awaited<ReturnType<typeof parsePythonSource>>;
  try {
    envelope = await parsePythonSource(content);
  } catch (err) {
    logger.error(`error: parse failed for ${filePath}: ${(err as Error).message}`);
    return 2;
  }

  // 3. Extract function signatures.
  let signatures: ReturnType<typeof extractFunctionSignatures>;
  try {
    signatures = extractFunctionSignatures(envelope);
  } catch (err) {
    // extractFunctionSignatures throws per-function — treat as parse-level failure.
    logger.error(`error: signature extraction failed: ${(err as Error).message}`);
    return 2;
  }

  // 4. Apply --function filter.
  if (functionFilter !== undefined) {
    signatures = signatures.filter((s: { name: string }) => s.name === functionFilter);
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

  // 6. Raise each function with purity + normalization (per-function, continue on error).
  const results: Array<{ name: string; ir: string }> = [];
  for (const sig of signatures) {
    // Body-reach helper (DEC-WI877-008 §C):
    // TODO(#follow-up): file a tracking issue to publish a typed body extractor
    // in @yakcc/shave-python so CLI no longer reaches into the untyped envelope.
    const moduleNode = envelope.module as {
      functions?: Array<{ name: string; body: WireStmt[] }>;
    };
    const fns = moduleNode.functions ?? [];
    const fnRecord = fns.find((f) => f.name === sig.name);
    const body: WireStmt[] = fnRecord?.body ?? [];

    try {
      const ir = raiseFunctionWithPurityAndNormalization(envelope, sig, body);
      results.push({ name: sig.name, ir });
    } catch (err) {
      if (
        err instanceof ImpureFunctionError ||
        err instanceof UnsupportedAstError ||
        err instanceof UnsupportedTypeError ||
        err instanceof MissingTypeAnnotationError
      ) {
        const kind =
          err instanceof ImpureFunctionError
            ? "impure"
            : err instanceof UnsupportedAstError
              ? "unsupported-ast"
              : err instanceof UnsupportedTypeError
                ? "unsupported-type"
                : "missing-annotation";
        logger.error(`shave-error: ${sig.name}: [${kind}] ${(err as Error).message}`);
        continue;
      }
      logger.error(`shave-error: ${sig.name}: [unexpected] ${(err as Error).message}`);
    }
  }

  if (results.length === 0) {
    return 1;
  }

  // 7. Write output.
  if (out === undefined) {
    // stdout — concatenate with banners when multiple functions.
    if (results.length === 1) {
      // results[0] is guaranteed by the length === 1 check above.
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
      .map(({ name, ir }) =>
        results.length > 1 ? `// ---- function: ${name} ----\n${ir}` : ir,
      )
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
