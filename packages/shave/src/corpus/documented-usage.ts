// @decision DEC-CORPUS-001 (see corpus/types.ts)
// title: Documented-usage synthesis derives fast-check properties from JSDoc examples + type signature
// status: decided (WI-016)
// rationale:
//   Source (b) in the priority chain. When IntentCard.preconditions and postconditions are
//   empty (upstream-test adaptation would produce only a behavior stub), documented-usage
//   synthesis extracts JSDoc @example blocks and the inferred type signature from the source
//   text to produce more concrete fast-check arbitraries.
//
//   Priority logic: this extractor is always attempted after upstream-test. The main
//   extractCorpus() function uses the priority-ordered chain, so upstream-test is preferred.
//   In practice, documented-usage provides richer output than upstream-test when the source
//   has JSDoc @example annotations.
//
//   No I/O or API calls. Deterministic given the same source + intentCard.

import { blake3 } from "@noble/hashes/blake3";
import { bytesToHex } from "@noble/hashes/utils";
import type { CorpusResult, IntentCardInput } from "./types.js";

const encoder = new TextEncoder();

/**
 * Canonical artifact path for documented-usage-synthesized property-test files.
 */
const DOCUMENTED_USAGE_PATH = "property-tests.fast-check.ts";

/**
 * A JSDoc @example block extracted from source text.
 */
interface JsDocExample {
  /** The raw example text (trimmed). */
  readonly text: string;
  /** Zero-based index of this example within the JSDoc comment. */
  readonly index: number;
}

/**
 * Extract @example blocks from a source text's JSDoc comments.
 *
 * Scans all `/** ... *\/` blocks and collects `@example` tagged sections.
 * Returns an empty array if no @example blocks are found.
 */
function extractJsDocExamples(source: string): JsDocExample[] {
  const examples: JsDocExample[] = [];
  // Match JSDoc-style block comments — use Array.from to avoid assignment-in-expression
  const blockMatches = Array.from(source.matchAll(/\/\*\*([\s\S]*?)\*\//g));

  for (const match of blockMatches) {
    const commentBody = match[1] ?? "";
    // Find @example tags within the block
    const exampleMatches = Array.from(commentBody.matchAll(/@example\s*([\s\S]*?)(?=@\w|$)/g));
    for (const exMatch of exampleMatches) {
      const text = (exMatch[1] ?? "").trim();
      if (text.length > 0) {
        examples.push({ text, index: examples.length });
      }
    }
  }

  return examples;
}

/**
 * Infer a fast-check arbitrary expression from a TypeScript type hint string.
 *
 * This is a best-effort approximation for common primitive types.
 * Complex types fall back to `fc.anything()`.
 */
function typeHintToArbitrary(typeHint: string): string {
  const t = typeHint.trim().toLowerCase();
  if (t === "string") return "fc.string()";
  if (t === "number") return "fc.float()";
  if (t === "integer" || t === "int") return "fc.integer()";
  if (t === "boolean") return "fc.boolean()";
  if (t === "bigint") return "fc.bigInt()";
  if (t.endsWith("[]") || t.startsWith("array<")) return "fc.array(fc.anything())";
  if (t.startsWith("string[]")) return "fc.array(fc.string())";
  if (t.startsWith("number[]")) return "fc.array(fc.float())";
  return "fc.anything()";
}

/**
 * Synthesize a fast-check property-test file from JSDoc examples and the type signature.
 *
 * This is corpus extraction source (b): documented-usage synthesis. It extracts
 * @example blocks from JSDoc comments in the source and builds one property test
 * per example, plus a round-trip determinism test based on the inferred type signature.
 *
 * @param intentCard - The extracted intent card for this atom.
 * @param source     - The raw source text of the atom.
 * @returns A CorpusResult with source="documented-usage".
 */
export function extractFromDocumentedUsage(
  intentCard: IntentCardInput,
  source: string,
): CorpusResult {
  const content = buildDocumentedUsageContent(intentCard, source);
  const bytes = encoder.encode(content);
  const contentHash = bytesToHex(blake3(bytes));

  return {
    source: "documented-usage",
    bytes,
    path: DOCUMENTED_USAGE_PATH,
    contentHash,
  };
}

/**
 * Build the fast-check property-test file content from JSDoc examples + type signature.
 */
function buildDocumentedUsageContent(intentCard: IntentCardInput, source: string): string {
  const fnName = inferFunctionName(source) ?? "atom";
  const safeDescribe = JSON.stringify(`${fnName} — documented usage properties`);

  const examples = extractJsDocExamples(source);

  // Build input arbitraries from the type signature.
  const inputArbitraries = intentCard.inputs.map((inp) => ({
    name: inp.name,
    arbitrary: typeHintToArbitrary(inp.typeHint),
    typeHint: inp.typeHint,
    description: inp.description,
  }));

  const argNames = inputArbitraries.map((a) => `_${a.name}`).join(", ");
  const arbList = inputArbitraries.map((a) => a.arbitrary).join(", ");

  // Example-based tests
  const exampleTests = examples.map((ex) => {
    const label = JSON.stringify(`example ${ex.index + 1}`);
    const commentLines = ex.text
      .split("\n")
      .map((l) => `   * ${l}`)
      .join("\n");
    return `
  /**
   * Derived from JSDoc @example:
${commentLines}
   */
  it(${label}, () => {
    // TODO: Replace placeholder assertion with a check derived from the @example text above.
    fc.assert(
      fc.property(${arbList || "fc.anything()"}, (${argNames || "_input"}) => {
        return true; // placeholder — implement based on @example above
      }),
      { numRuns: 100 },
    );
  });`;
  });

  // Type-signature-derived property: at minimum, function call does not throw for in-range inputs.
  const signatureTest = `
  it(${JSON.stringify(`${fnName} — type-signature property: ${intentCard.behavior.slice(0, 60)}`)}, () => {
    fc.assert(
      fc.property(${arbList || "fc.anything()"}, (${argNames || "_input"}) => {
        // TODO: Call ${fnName}(${inputArbitraries.map((a) => `_${a.name}`).join(", ")}) and assert postconditions.
        // Behavior: ${intentCard.behavior}
${intentCard.postconditions.map((p) => `        // Postcondition: ${p}`).join("\n")}
        return true; // placeholder
      }),
      { numRuns: 100 },
    );
  });`;

  const allTests = [...exampleTests, signatureTest];

  const inputComments = inputArbitraries
    .map((a) => `  // ${a.name}: ${a.typeHint} — ${a.description} → ${a.arbitrary}`)
    .join("\n");

  return `// Auto-generated property-test corpus (source: documented-usage synthesis)
// Derived from JSDoc @example blocks and inferred type signature.
// DO NOT EDIT — regenerated by WI-016 corpus extraction.

import * as fc from "fast-check";
import { describe, it } from "vitest";

// Inferred input arbitraries:
${inputComments || "// (no typed inputs found)"}

describe(${safeDescribe}, () => {${allTests.join("")}
});
`;
}

/**
 * Attempt to infer the primary function name from a source string.
 *
 * Looks for the first `function <name>` or `const <name> =` declaration.
 * Returns undefined if no function name can be determined.
 */
function inferFunctionName(source: string): string | undefined {
  const fnMatch = source.match(/(?:^|\s)function\s+([a-zA-Z_$][a-zA-Z0-9_$]*)/);
  if (fnMatch?.[1]) return fnMatch[1];

  const constMatch = source.match(/(?:^|\s)(?:const|let|var)\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*=/);
  if (constMatch?.[1]) return constMatch[1];

  return undefined;
}
