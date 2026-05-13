// SPDX-License-Identifier: MIT
// @decision DEC-CORPUS-001 (see corpus/types.ts)
// title: Documented-usage synthesis derives fast-check properties from JSDoc examples + type signature
// status: decided (WI-016, revised WI-376)
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
//
// @decision DEC-PROPTEST-DOCUMENTED-USAGE-001
// title: Loud refusal over silent placeholder -- documented-usage corpus extractor
// status: accepted (WI-376)
// rationale:
//   The original extractor emitted `return true; // placeholder` in every generated
//   it() block -- a test that always passes regardless of input. This violates Sacred
//   Practice #5 (fail loudly, never silently): a `proof/manifest.json` entry that
//   records `property_tests` but whose assertions are trivially vacuous is a lie to
//   the operator.
//
//   Decision: extract real assertions via Option A (deterministic @example parsing) when
//   possible. Option A recognises patterns of the form:
//       fn(arg) // => expected
//       fn(arg) // -> expected
//   and emits `expect(fn(arg)).toEqual(expected)` assertions. All other @example
//   forms (multi-line, NLP-required, prose-only) are unstructured -- the extractor
//   REFUSES to emit an it() block for them and logs the skip reason so the caller can
//   surface the gap.
//
//   The type-signature-derived "catch-all" test (which ALWAYS produced a placeholder)
//   is removed entirely. It had no postcondition to assert substantively without
//   actual function invocation or NLP-derived synthesis.
//
//   Consequence: `extractFromDocumentedUsage` now returns `CorpusResult | undefined`.
//   `undefined` means "no real assertions could be derived -- do not record
//   `property_tests` in the proof manifest for this atom via this path."
//   Callers (index.ts) must fall through to the next source (ai-derived) or throw
//   when no source produces a non-placeholder corpus.
//
//   This honors the L0 floor: only atoms with substantive property tests are recorded
//   as having `property_tests` in their proof manifest.

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
 * A parsed assertion derived from a JSDoc @example block.
 *
 * Only produced for deterministic Option-A patterns of the form:
 *   fn(arg) // => expected
 *   fn(arg) // -> expected
 */
interface ParsedAssertion {
  /** The full call expression as written in the @example, e.g. fn("1,2,3"). */
  readonly callExpr: string;
  /** The expected value as written in the @example, e.g. [1, 2, 3]. */
  readonly expectedExpr: string;
  /** Original @example text, preserved for comments in generated output. */
  readonly exampleText: string;
  /** Zero-based index of the originating example. */
  readonly index: number;
}

/**
 * Reason an @example block could not be parsed into a real assertion.
 *
 * Surfaced in stderr logging so operators can see the gap without a hard failure.
 */
export interface ExampleSkipReason {
  /** Zero-based index of the @example block that was skipped. */
  readonly index: number;
  /** The raw @example text that was unstructured. */
  readonly text: string;
  /** Human-readable reason for the skip. */
  readonly reason: string;
}

/**
 * Internal build result: the generated file content plus skip reasons for each
 * @example block that could not be parsed into a real assertion.
 */
interface BuildResult {
  readonly content: string;
  readonly skipped: readonly ExampleSkipReason[];
}

/**
 * Extract @example blocks from a source text JSDoc comments.
 *
 * Scans all block comments and collects @example tagged sections.
 * Returns an empty array if no @example blocks are found.
 */
function extractJsDocExamples(source: string): JsDocExample[] {
  const examples: JsDocExample[] = [];
  // Match JSDoc-style block comments -- use Array.from to avoid assignment-in-expression
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
 * Attempt to parse a JSDoc @example text into a deterministic assertion.
 *
 * Recognises Option-A patterns only:
 *   fn(arg) // => expected
 *   fn(arg) // -> expected
 *
 * The call expression must be on a single line ending with a // comment
 * that uses => or -> as a returns-arrow. Multi-line examples, prose-only
 * examples, and examples that require NLP are rejected.
 *
 * @decision DEC-PROPTEST-DOCUMENTED-USAGE-001 -- only deterministic single-line
 * patterns are accepted; everything else is a loud refusal.
 */
function tryParseExampleAssertion(
  example: JsDocExample,
):
  | { kind: "success"; assertion: ParsedAssertion }
  | { kind: "failure"; skipReason: ExampleSkipReason } {
  // Normalise: strip JSDoc leading-asterisk decoration from lines like ` * fn(x) // => y`
  const stripped = example.text
    .split("\n")
    .map((l) => l.replace(/^\s*\*\s?/, "").trim())
    .filter((l) => l.length > 0);

  // Reject multi-line examples -- they require NLP to interpret.
  if (stripped.length !== 1) {
    return {
      kind: "failure",
      skipReason: {
        index: example.index,
        text: example.text,
        reason: `multi-line @example (${stripped.length} lines) -- too unstructured to derive a deterministic assertion`,
      },
    };
  }

  const [line] = stripped;
  if (line === undefined) {
    return {
      kind: "failure",
      skipReason: {
        index: example.index,
        text: example.text,
        reason: "internal parser invariant violated: expected one normalized @example line",
      },
    };
  }

  // Match: <callExpr> // => <expectedExpr>  OR  <callExpr> // -> <expectedExpr>
  // The call expression must contain parentheses (it is a function call, not prose).
  const m = line.match(/^([^/]+\([^)]*\))\s*\/\/\s*[-=]>\s*(.+)$/);
  if (!m) {
    return {
      kind: "failure",
      skipReason: {
        index: example.index,
        text: example.text,
        reason:
          "@example does not match deterministic pattern fn(args) // => expected -- too unstructured to derive an assertion",
      },
    };
  }

  const rawCallExpr = m[1];
  const rawExpectedExpr = m[2];
  if (rawCallExpr === undefined || rawExpectedExpr === undefined) {
    return {
      kind: "failure",
      skipReason: {
        index: example.index,
        text: example.text,
        reason:
          "internal parser invariant violated: expected call and expected-expression captures",
      },
    };
  }

  const callExpr = rawCallExpr.trim();
  const expectedExpr = rawExpectedExpr.trim();

  return {
    kind: "success",
    assertion: {
      callExpr,
      expectedExpr,
      exampleText: example.text,
      index: example.index,
    },
  };
}

/**
 * Infer a fast-check arbitrary expression from a TypeScript type hint string.
 *
 * This is a best-effort approximation for common primitive types.
 * Complex types fall back to fc.anything().
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
 * Synthesize a fast-check property-test file from JSDoc examples.
 *
 * This is corpus extraction source (b): documented-usage synthesis. It extracts
 * @example blocks from JSDoc comments in the source and attempts to parse each
 * block into a real assertion using Option-A deterministic parsing.
 *
 * @decision DEC-PROPTEST-DOCUMENTED-USAGE-001:
 * Returns undefined (loud refusal) when NO @example block yields a parseable
 * assertion. This prevents hollow placeholder tests from entering the proof manifest.
 * Only atoms with at least one real deterministic assertion are recorded as having
 * property_tests via this extraction path.
 *
 * Callers MUST treat undefined as a "no real tests available" signal and either
 * fall through to the next corpus source (ai-derived) or surface the gap loudly.
 *
 * @param intentCard - The extracted intent card for this atom.
 * @param source     - The raw source text of the atom.
 * @returns A CorpusResult with source="documented-usage", or undefined when
 *          no real assertions could be derived (loud refusal per Sacred Practice #5).
 */
export function extractFromDocumentedUsage(
  intentCard: IntentCardInput,
  source: string,
): CorpusResult | undefined {
  const result = buildDocumentedUsageContent(intentCard, source);
  if (result === undefined) {
    return undefined;
  }

  const { content, skipped } = result;
  // Log skipped examples to stderr so operators can see the gap without a hard failure.
  // This is the "loud" part of loud refusal: each skipped example is named + explained.
  for (const skip of skipped) {
    process.stderr.write(`[documented-usage] skipped @example ${skip.index + 1}: ${skip.reason}\n`);
  }

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
 * Build the fast-check property-test file content from JSDoc examples.
 *
 * Returns undefined when no parseable assertion could be derived from any @example
 * block (i.e., every example was skipped or there were no @example blocks at all).
 *
 * @decision DEC-PROPTEST-DOCUMENTED-USAGE-001 -- the type-signature-derived catch-all
 * test (former signatureTest) is intentionally REMOVED. It produced only a
 * return true placeholder and had no postcondition to assert substantively. Removing
 * it means this extractor now returns undefined when no parseable example exists,
 * letting the caller fall through to ai-derived synthesis instead of recording a hollow
 * test.
 */
function buildDocumentedUsageContent(
  intentCard: IntentCardInput,
  source: string,
): BuildResult | undefined {
  const fnName = inferFunctionName(source) ?? "atom";
  const safeDescribe = JSON.stringify(`${fnName} — documented usage properties`);

  const examples = extractJsDocExamples(source);

  if (examples.length === 0) {
    // No @example blocks -- nothing to derive from -- loud refusal.
    return undefined;
  }

  // Build input arbitraries from the type signature (used only for comment headers).
  const inputArbitraries = intentCard.inputs.map((inp) => ({
    name: inp.name,
    arbitrary: typeHintToArbitrary(inp.typeHint),
    typeHint: inp.typeHint,
    description: inp.description,
  }));

  const skipped: ExampleSkipReason[] = [];
  const assertionTests: string[] = [];

  for (const ex of examples) {
    const parseResult = tryParseExampleAssertion(ex);
    if (parseResult.kind === "failure") {
      skipped.push(parseResult.skipReason);
      continue;
    }

    const { assertion } = parseResult;
    const label = JSON.stringify(`example ${assertion.index + 1}: ${assertion.callExpr}`);
    const commentLines = assertion.exampleText
      .split("\n")
      .map((l) => `   * ${l}`)
      .join("\n");

    assertionTests.push(`
  /**
   * Derived from JSDoc @example:
${commentLines}
   */
  it(${label}, () => {
    expect(${assertion.callExpr}).toEqual(${assertion.expectedExpr});
  });`);
  }

  // Loud refusal: if every example was unstructured, return undefined rather than
  // emitting a test file with no real assertions.
  if (assertionTests.length === 0) {
    return undefined;
  }

  const inputComments = inputArbitraries
    .map((a) => `  // ${a.name}: ${a.typeHint} — ${a.description} → ${a.arbitrary}`)
    .join("\n");

  const content = `// Auto-generated property-test corpus (source: documented-usage synthesis)
// Derived from JSDoc @example blocks (Option-A deterministic parsing).
// DO NOT EDIT -- regenerated by WI-016/WI-376 corpus extraction.
// @decision DEC-PROPTEST-DOCUMENTED-USAGE-001: only @example blocks matching
// fn(args) // => expected produce real assertions; others are refused (no it() emitted).

import { describe, expect, it } from "vitest";

// Inferred input arbitraries (for context):
${inputComments || "// (no typed inputs found)"}

describe(${safeDescribe}, () => {${assertionTests.join("")}
});
`;

  return { content, skipped };
}

/**
 * Attempt to infer the primary function name from a source string.
 *
 * Looks for the first function <name> or const <name> = declaration.
 * Returns undefined if no function name can be determined.
 */
function inferFunctionName(source: string): string | undefined {
  const fnMatch = source.match(/(?:^|\s)function\s+([a-zA-Z_$][a-zA-Z0-9_$]*)/);
  if (fnMatch?.[1]) return fnMatch[1];

  const constMatch = source.match(/(?:^|\s)(?:const|let|var)\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*=/);
  if (constMatch?.[1]) return constMatch[1];

  return undefined;
}
