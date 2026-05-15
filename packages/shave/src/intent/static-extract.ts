// SPDX-License-Identifier: MIT
/**
 * Static intent extraction — TypeScript Compiler API + JSDoc parser.
 *
 * @decision DEC-INTENT-STRATEGY-001
 * @title Strategy axis on ExtractIntentContext; "static" as default
 * @status accepted
 * @rationale
 *   The intent-extraction pipeline had exactly one cloud LLM dependency.
 *   Replacing it with a local TypeScript-Compiler-API + JSDoc parser achieves
 *   behavior-equivalent output (same IntentCard shape, same validateIntentCard
 *   runs) for the parts that matter (cache key, schema, validator) while
 *   eliminating the Anthropic round-trip (~1-3s/call) in favor of in-process
 *   AST parsing (~5ms/call). The "static" strategy is the new default because:
 *   (a) Yakcc's identity is "deterministic, content-addressed, local-first";
 *   (b) the LLM was only used to write human-readable documentation fields
 *       (behavior, param descriptions) into the IntentCard, not to influence
 *       slicing, matching, or content-addressing;
 *   (c) WI-016 (AI property-test corpus) may depend on the existing client
 *       surface — preserving the "llm" path behind strategy: "llm" is cheap
 *       insurance. The LLM path is entirely unchanged.
 *
 * @decision DEC-INTENT-STATIC-002
 * @title JSDoc tag vocabulary — Eiffel/JML lineage for preconditions/postconditions
 * @status accepted
 * @rationale
 *   Tag set: @param, @returns/@return, @requires, @ensures, @throws/@throw/
 *   @exception, @remarks, @note, @example.
 *   @requires / @ensures chosen for Eiffel/JML / Code Contracts / SPARK lineage:
 *   unambiguous, not claimed by tsc's type-checking machinery, and directly
 *   maps to the IntentCard's preconditions/postconditions arrays without
 *   any ambiguity. @pre/@post were rejected as they clash with some doc tooling.
 *
 * @decision DEC-INTENT-STATIC-003
 * @title Type extraction depth: source-text only via getTypeNode()?.getText()
 * @status accepted
 * @rationale
 *   We use param.getTypeNode()?.getText() rather than the type-checker's
 *   resolved type. Reasons:
 *   (a) shave's decompose() already parses with useInMemoryFileSystem:true and
 *       no lib loading (recursion.ts:282); a type-checked Program would need
 *       lib.d.ts and introduce TS-version nondeterminism;
 *   (b) parse cost without checker is ~5ms/call vs ~200ms/call with full lib
 *       resolution;
 *   (c) the "unknown" sentinel is the established convention in the LLM prompt
 *       (prompt.ts:33) and is accepted by validateIntentCard.
 *
 * @decision DEC-EMBED-QUERY-ENRICH-HELPER-001 (OD-2 Option A)
 * @title Shared extraction primitives live in @yakcc/contracts/source-extract.
 * @status accepted
 * @rationale
 *   The extraction functions (extractSignatureFromNode, extractJsDoc, and the
 *   primary-declaration picker pickPrimaryDeclaration) have been moved to
 *   packages/contracts/src/source-extract.ts and source-pick.ts. This file
 *   now delegates to those shared primitives and adapts the output to the
 *   IntentCard / IntentParam shape that @yakcc/shave uses.
 *
 *   Behavioral equivalence guarantee: every test in static-extract.test.ts,
 *   static-extract.props.test.ts, and static-extract.integration.test.ts
 *   must continue to pass unchanged — this is the structural proof that the
 *   refactor is behavior-preserving.
 *
 *   Field mapping (shared ExtractedParam → IntentParam):
 *     ExtractedParam.typeAnnotation → IntentParam.typeHint
 *
 *   Field mapping (shared ExtractedJsDoc → IntentCard notes array):
 *     ExtractedJsDoc.throwDescriptions → each becomes "throws: <desc>" in notes[]
 *     ExtractedJsDoc.notes (remarks/example/note) → appended to notes[] as-is
 */

import { Project } from "ts-morph";
import {
  extractJsDoc,
  extractSignatureFromNode,
  pickPrimaryDeclaration,
} from "@yakcc/contracts";
import type { IntentParam } from "./types.js";

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Envelope fields that staticExtract() embeds into the returned card.
 * These match the fields that extractIntent() assembles after the API call.
 */
export interface StaticExtractEnvelope {
  readonly sourceHash: string;
  readonly modelVersion: string;
  readonly promptVersion: string;
  readonly extractedAt: string;
}

/**
 * Extract behavioral intent from a unit of TypeScript/JavaScript source using
 * the TypeScript Compiler API and JSDoc parsing.
 *
 * Returns an `unknown` value that the caller must pass through
 * `validateIntentCard()` — identical to the LLM path's post-processing step,
 * so the same validation invariants apply regardless of which path produced the
 * card.
 *
 * No Anthropic SDK is imported. No network calls are made. This function is
 * always offline-safe.
 *
 * @param unitSource - Raw source text of the candidate block.
 * @param envelope   - Pre-computed envelope fields (hash, version tags, timestamp).
 * @returns Unvalidated card object (call validateIntentCard before using).
 */
export function staticExtract(unitSource: string, envelope: StaticExtractEnvelope): unknown {
  // Parse with ts-morph using an in-memory virtual file system.
  // @decision DEC-INTENT-STATIC-003: no type-checker, no lib loading.
  const project = new Project({
    useInMemoryFileSystem: true,
    compilerOptions: {
      strict: false,
      allowJs: true,
      noLib: true,
    },
  });
  const sourceFile = project.createSourceFile("__static_extract__.ts", unitSource);

  const primary = pickPrimaryDeclaration(sourceFile);

  // No declaration found — "source fragment" fallback
  if (primary === undefined) {
    const stmtCount = sourceFile.getStatements().length;
    const byteCount = unitSource.length;
    const behavior = `source fragment (${stmtCount} statements, ${byteCount} bytes)`;
    return {
      schemaVersion: 1,
      behavior,
      inputs: [],
      outputs: [],
      preconditions: [],
      postconditions: [],
      notes: [],
      ...envelope,
    };
  }

  const jsdoc = extractJsDoc(primary);
  const sig = extractSignatureFromNode(primary);

  // Behavior field: JSDoc summary → signature string → fragment fallback
  const behavior =
    jsdoc.summary ?? sig.signatureString ?? buildFragmentFallback(sourceFile, unitSource);

  // Inputs: one entry per parameter.
  // ExtractedParam.typeAnnotation → IntentParam.typeHint (field rename only).
  const inputs: IntentParam[] = sig.params.map((p) => ({
    name: p.name,
    typeHint: p.typeAnnotation,
    description: jsdoc.params.get(p.name) ?? "",
  }));

  // Outputs: always exactly one entry (matches LLM prompt convention, prompt.ts:33).
  // Exception: no-declaration fragment case already handled above.
  const outputs: IntentParam[] = [
    {
      name: "return",
      typeHint: sig.returnTypeAnnotation,
      description: jsdoc.returns ?? "",
    },
  ];

  // Notes: @throws entries (with "throws: " prefix) + remarks/example/note entries.
  const notes: string[] = [
    ...jsdoc.throwDescriptions.map((d) => `throws: ${d}`),
    ...jsdoc.notes,
  ];

  return {
    schemaVersion: 1,
    behavior,
    inputs,
    outputs,
    preconditions: jsdoc.preconditions,
    postconditions: jsdoc.postconditions,
    notes,
    ...envelope,
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Fragment fallback behavior string when there's no declaration. */
function buildFragmentFallback(
  sourceFile: import("ts-morph").SourceFile,
  src: string,
): string {
  const stmtCount = sourceFile.getStatements().length;
  return `source fragment (${stmtCount} statements, ${src.length} bytes)`;
}
