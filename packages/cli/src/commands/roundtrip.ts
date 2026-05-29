// SPDX-License-Identifier: MIT
//
// roundtrip.ts — `yakcc roundtrip <file>` verb.
//
// Chains shave-python → compileToPython → diff; emits a per-function status table.
// Python-only MVP.  TS branch errors with a follow-up pointer.
//
// @decision DEC-WI877-003
// @title yakcc roundtrip arg shape; Python-only MVP, TS branch stubbed
// @status accepted (WI-877)
// @rationale
//   roundtrip is a new verb that chains shave-python (in-memory) and compileToPython
//   to produce a per-function status table.  TS roundtrip is out of scope for this
//   MVP (exits 1 with #877 follow-up note).  The dispatcher case exists so the verb
//   is registered and --help lists it.
//   Cross-reference: PLAN.md §3.1 §4 / #877
//
// @decision DEC-WI877-004
// @title Per-function continuation + exit-code semantics
// @status accepted (WI-877)
// @rationale
//   exit 0 if any function reached round-trip stage; exit 1 if all failed;
//   exit 2 if file unparseable or target unsupported.
//   Cross-reference: PLAN.md §4 / #877
//
// @decision DEC-WI877-008 §B (roundtrip synthetic atom)
// @title Synthetic BlockTripletRow cast for compileToPython in roundtrip
// @status accepted (WI-877)
// @rationale
//   compileToPython reads only implSource and artifacts.get(...) from the row.
//   Verified by source inspection of packages/compile-python/src/compile-python.ts.
//   The cast is localized in synthesizePartialAtom() so a future widening of
//   compileToPython's read shape produces a visible diff at this call site.
//   Cross-reference: PLAN.md §3.1 / #877

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { compileToPython } from "@yakcc/compile-python";
import type { BlockTripletRow } from "@yakcc/registry";
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
import { TARGETS_TRACKED, inferTarget } from "./lang-target.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ShaveStatus =
  | "pass"
  | "impure"
  | "unsupported-ast"
  | "unsupported-type"
  | "missing-annotation"
  | "error";

type CompileStatus = "pass" | `${number}-warnings` | "skipped" | "error";

type RoundtripStatus = "pass" | "clean-but-renamed" | `diff (${number} lines)` | "skipped";

interface FunctionRow {
  fn: string;
  shave: ShaveStatus;
  compile: CompileStatus;
  roundtrip: RoundtripStatus;
  notes: string;
}

// ---------------------------------------------------------------------------
// Synthetic atom helper (DEC-WI877-008 §B)
// ---------------------------------------------------------------------------

/**
 * Synthesize a minimal BlockTripletRow from a raised IR string.
 *
 * compileToPython reads ONLY implSource and artifacts.get("proof/properties.json").
 * No spec or proof fields are populated — this is intentional (DEC-WI877-008 §B).
 */
function synthesizePartialAtom(ir: string): BlockTripletRow {
  return {
    implSource: ir,
    artifacts: new Map<string, Uint8Array>(),
  } as unknown as BlockTripletRow;
}

// ---------------------------------------------------------------------------
// Status table renderer
// ---------------------------------------------------------------------------

function renderTable(rows: FunctionRow[]): string {
  const headers = ["function", "shave", "compile", "round-trip", "notes"];
  const colWidths = headers.map((h) => h.length);
  for (const row of rows) {
    const cells = [row.fn, row.shave, row.compile, row.roundtrip, row.notes];
    for (let i = 0; i < cells.length; i++) {
      // i is bounded by cells.length === headers.length === colWidths.length (always 5).
      // biome-ignore lint/style/noNonNullAssertion: i is always in range; both arrays have length 5
      colWidths[i] = Math.max(colWidths[i]!, (cells[i] as string).length);
    }
  }

  const separator = colWidths.map((w) => "-".repeat(w + 2)).join("+");
  const header = headers
    .map((h, i) => ` ${h.padEnd(colWidths[i] ?? 0)} `)
    .join("|");

  const lines: string[] = [header, separator];
  for (const row of rows) {
    const cells = [row.fn, row.shave, row.compile, row.roundtrip, row.notes];
    lines.push(cells.map((c, i) => ` ${c.padEnd(colWidths[i] ?? 0)} `).join("|"));
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Python roundtrip implementation
// ---------------------------------------------------------------------------

async function runRoundtripPython(
  filePath: string,
  outDir: string | undefined,
  logger: Logger,
): Promise<number> {
  // Read source
  let content: string;
  try {
    content = readFileSync(filePath, "utf-8");
  } catch (err) {
    logger.error(`error: cannot read file ${filePath}: ${(err as Error).message}`);
    return 1;
  }

  // Parse via libcst
  let envelope: Awaited<ReturnType<typeof parsePythonSource>>;
  try {
    envelope = await parsePythonSource(content);
  } catch (err) {
    logger.error(`error: parse failed for ${filePath}: ${(err as Error).message}`);
    return 2;
  }

  // Extract signatures — per-function errors handled below
  let signatures: ReturnType<typeof extractFunctionSignatures>;
  try {
    signatures = extractFunctionSignatures(envelope);
  } catch (err) {
    logger.error(`error: signature extraction failed: ${(err as Error).message}`);
    return 2;
  }

  if (signatures.length === 0) {
    logger.error(`error: no functions found in ${filePath}`);
    return 1;
  }

  // Prepare --out directory if set
  if (outDir !== undefined) {
    mkdirSync(outDir, { recursive: true });
  }

  const rows: FunctionRow[] = [];
  let anyReachedRoundtrip = false;

  for (const sig of signatures) {
    // Body-reach (DEC-WI877-008 §C)
    const moduleNode = envelope.module as {
      functions?: Array<{ name: string; body: WireStmt[] }>;
    };
    const fns = moduleNode.functions ?? [];
    const fnRecord = fns.find((f) => f.name === sig.name);
    const body: WireStmt[] = fnRecord?.body ?? [];

    const row: FunctionRow = {
      fn: sig.name,
      shave: "pass",
      compile: "skipped",
      roundtrip: "skipped",
      notes: "",
    };

    // Step 1: Shave
    let ir: string;
    try {
      ir = raiseFunctionWithPurityAndNormalization(envelope, sig, body);
    } catch (err) {
      if (err instanceof ImpureFunctionError) {
        row.shave = "impure";
      } else if (err instanceof UnsupportedAstError) {
        row.shave = "unsupported-ast";
      } else if (err instanceof UnsupportedTypeError) {
        row.shave = "unsupported-type";
      } else if (err instanceof MissingTypeAnnotationError) {
        row.shave = "missing-annotation";
      } else {
        row.shave = "error";
      }
      row.notes = (err as Error).message.slice(0, 60);
      rows.push(row);
      continue;
    }

    // Step 2: Compile to Python
    let compiledSource: string;
    let warningCount = 0;
    try {
      const atom = synthesizePartialAtom(ir);
      const result = compileToPython(atom);
      warningCount = result.warnings.length;
      compiledSource = result.source;
      row.compile = warningCount === 0 ? "pass" : (`${warningCount}-warnings` as const);
    } catch (err) {
      row.compile = "error";
      row.notes = (err as Error).message.slice(0, 60);
      rows.push(row);
      continue;
    }

    // Step 3: Diff compiled Python vs original function source
    const originalSource = sig.bodyPythonSource.trim();
    const compiledTrimmed = compiledSource.trim();

    if (compiledTrimmed === originalSource) {
      row.roundtrip = "pass";
    } else {
      // Count differing lines as a heuristic
      const origLines = originalSource.split("\n");
      const compLines = compiledTrimmed.split("\n");
      const maxLen = Math.max(origLines.length, compLines.length);
      let diffLines = 0;
      for (let i = 0; i < maxLen; i++) {
        if ((origLines[i] ?? "") !== (compLines[i] ?? "")) diffLines++;
      }
      // snake_case ↔ camelCase renaming always differs; treat as clean-but-renamed
      // if line counts match and only identifiers changed
      if (
        origLines.length === compLines.length &&
        compiledTrimmed.replace(/[_a-z][a-z0-9_]*/g, "X") ===
          originalSource.replace(/[_a-z][a-z0-9_]*/g, "X")
      ) {
        row.roundtrip = "clean-but-renamed";
      } else {
        row.roundtrip = `diff (${diffLines} lines)`;
      }
    }
    anyReachedRoundtrip = true;

    // Write --out artifacts if requested
    if (outDir !== undefined) {
      writeFileSync(join(outDir, `${sig.name}.ir.ts`), ir, "utf-8");
      writeFileSync(join(outDir, `${sig.name}.module.py`), compiledSource, "utf-8");
      const diffText = `--- original\n+++ compiled\n${originalSource}\n---\n${compiledTrimmed}`;
      writeFileSync(join(outDir, `${sig.name}.diff.txt`), diffText, "utf-8");
    }

    rows.push(row);
  }

  logger.log(renderTable(rows));

  return anyReachedRoundtrip ? 0 : 1;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Handler for `yakcc roundtrip <file> [--target <lang>] [--out <dir>]`.
 *
 * @param argv   - Remaining argv after "roundtrip" has been consumed.
 * @param logger - Output sink.
 * @returns Promise<number> — 0 if any function round-tripped, 1 all failed, 2 parse/target error.
 */
export async function roundtrip(argv: ReadonlyArray<string>, logger: Logger): Promise<number> {
  // Use the null-return pattern (same as shave.ts) so TypeScript can narrow
  // `values` to the typed result rather than a union with `{}`.
  const parsed = (() => {
    try {
      return parseArgs({
        args: [...argv],
        options: {
          target: { type: "string" },
          out: { type: "string", short: "o" },
          help: { type: "boolean", short: "h", default: false },
        },
        allowPositionals: true,
        strict: true,
      });
    } catch (err) {
      logger.error(`error: ${(err as Error).message}`);
      return null;
    }
  })();
  if (parsed === null) return 1;
  const { values, positionals } = parsed;

  if (values.help) {
    logger.log(
      `Usage: yakcc roundtrip <file> [--target <ts|python|rust|go>] [--out <dir>]\n` +
        `  Chain shave → compile → diff for every function in <file>.\n` +
        `  Outputs a per-function status table (shave | compile | round-trip | notes).\n` +
        `  .py files use the Python pipeline (default). TS round-trip is not yet wired.\n` +
        `  --target: override extension inference.\n` +
        `  --out <dir>: persist per-function artifacts (<fn>.ir.ts, <fn>.module.py, <fn>.diff.txt).\n` +
        `  Exit 0 if any function round-tripped; 1 if all failed; 2 if file unparseable.`,
    );
    return 0;
  }

  const filePath = positionals[0];
  if (filePath === undefined) {
    logger.error("error: missing file argument. Usage: yakcc roundtrip <file>");
    logger.log(
      `Usage: yakcc roundtrip <file> [--target <ts|python|rust|go>] [--out <dir>]`,
    );
    return 1;
  }

  const target = inferTarget(filePath, values.target as string | undefined);

  if (target === "python") {
    return runRoundtripPython(filePath, values.out as string | undefined, logger);
  }

  if (target === "ts") {
    logger.error(
      "error: roundtrip --target ts is not wired in this MVP; tracked as #877 follow-up",
    );
    return 1;
  }

  if (target === "rust" || target === "go") {
    const issue = TARGETS_TRACKED[target];
    logger.error(`error: --target ${target} is not yet wired; tracked at #${issue}`);
    return 2;
  }

  // unknown extension + no --target
  if (values.target !== undefined) {
    logger.error(
      `error: unknown --target value: ${String(values.target)}. Must be one of: ts, python, rust, go`,
    );
  } else {
    logger.error(
      `error: cannot infer language from file extension. Use --target to specify: ts, python, rust, or go`,
    );
  }
  return 2;
}
