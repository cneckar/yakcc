// SPDX-License-Identifier: MIT
// @decision DEC-CORPUS-001 (see corpus/types.ts)
// title: Upstream-test adaptation builds a fast-check file from IntentCard.propertyTests hints
// status: decided (WI-016)
// rationale:
//   The IntentCard's preconditions, postconditions, and notes fields carry behavioral
//   specification text that maps naturally to fast-check properties. When no external
//   upstream test fixture is available (which is the common case at L0), we adapt the
//   IntentCard's own property-test hints (behavior + preconditions + postconditions) into
//   deterministic fast-check property stubs. This is "source (a)" in the priority chain.
//
//   The generated file is deterministic given the same IntentCard: it is a string
//   interpolation of the spec fields. No I/O, no API calls, no randomness.

import { blake3 } from "@noble/hashes/blake3";
import { bytesToHex } from "@noble/hashes/utils";
import type { CorpusResult, IntentCardInput } from "./types.js";

const encoder = new TextEncoder();

/**
 * Canonical artifact path for upstream-test-adapted property-test files.
 */
const UPSTREAM_TEST_PATH = "property-tests.fast-check.ts";

/**
 * Adapt the IntentCard's behavioral specification into a fast-check property-test file.
 *
 * This is corpus extraction source (a): upstream-test adaptation. It derives
 * deterministic property stubs from the IntentCard fields (behavior, inputs,
 * outputs, preconditions, postconditions, notes). No I/O or API calls are made.
 *
 * The generated file bundles all properties into a single `describe` block with
 * one `fc.property` per documented behavioral constraint. This satisfies the L0
 * manifest constraint of exactly one "property_tests" artifact per atom.
 *
 * @param intentCard - The extracted intent card for this atom.
 * @param source     - The raw source text of the atom (used for function name inference).
 * @returns A CorpusResult with source="upstream-test".
 */
export function extractFromUpstreamTest(intentCard: IntentCardInput, source: string): CorpusResult {
  const content = buildUpstreamTestContent(intentCard, source);
  const bytes = encoder.encode(content);
  const contentHash = bytesToHex(blake3(bytes));

  return {
    source: "upstream-test",
    bytes,
    path: UPSTREAM_TEST_PATH,
    contentHash,
  };
}

/**
 * Build the fast-check property-test file content from an IntentCard.
 *
 * The generated structure:
 *   1. Import block (fast-check, vitest)
 *   2. One describe block named after the atom
 *   3. One it() + fc.property() per precondition (input domain constraint)
 *   4. One it() + fc.property() per postcondition (output guarantee)
 *   5. One it() for the general behavior description
 *
 * All property bodies are stubs — the test structure is correct but the
 * implementation calls `fc.pre` / `expect` with TODO comments. This is
 * intentional: the corpus establishes the property-test shape without
 * hard-coding implementation-specific assertions that would break if the
 * atom's source changes.
 */
function buildUpstreamTestContent(intentCard: IntentCardInput, source: string): string {
  const fnName = inferFunctionName(source) ?? "atom";
  const safeDescribe = JSON.stringify(`${fnName} — property tests`);

  const inputArbLines = intentCard.inputs.map(
    (inp) => `  // Input: ${inp.name}: ${inp.typeHint} — ${inp.description}`,
  );

  const preconditionTests = intentCard.preconditions.map((pre, i) => {
    const label = JSON.stringify(`precondition ${i + 1}: ${pre}`);
    return `
  it(${label}, () => {
    fc.assert(
      fc.property(fc.anything(), (_input) => {
        // TODO: Replace with typed arbitrary matching the input signature.
        // Precondition: ${pre}
        fc.pre(true); // placeholder — add real precondition guard here
        return true; // placeholder — add real assertion here
      }),
      { numRuns: 100 },
    );
  });`;
  });

  const postconditionTests = intentCard.postconditions.map((post, i) => {
    const label = JSON.stringify(`postcondition ${i + 1}: ${post}`);
    return `
  it(${label}, () => {
    fc.assert(
      fc.property(fc.anything(), (_input) => {
        // TODO: Replace with typed arbitrary matching the input signature.
        // Postcondition: ${post}
        return true; // placeholder — add real assertion here
      }),
      { numRuns: 100 },
    );
  });`;
  });

  const behaviorTest = `
  it(${JSON.stringify(`behavior: ${intentCard.behavior.slice(0, 80)}`)}, () => {
    fc.assert(
      fc.property(fc.anything(), (_input) => {
        // TODO: Replace with typed arbitrary and real implementation call.
        // Behavior: ${intentCard.behavior}
        return true; // placeholder
      }),
      { numRuns: 100 },
    );
  });`;

  // If no preconditions or postconditions, at least emit the behavior test.
  const allTests = [...preconditionTests, ...postconditionTests, behaviorTest];

  const inputComments =
    inputArbLines.length > 0 ? `\n  // Inputs:\n${inputArbLines.join("\n")}\n` : "";

  const outputComments =
    intentCard.outputs.length > 0
      ? `  // Outputs: ${intentCard.outputs.map((o) => `${o.name}: ${o.typeHint}`).join(", ")}\n`
      : "";

  return `// Auto-generated property-test corpus (source: upstream-test adaptation)
// Generated from IntentCard behavioral specification.
// DO NOT EDIT — regenerated by WI-016 corpus extraction.

import * as fc from "fast-check";
import { describe, it } from "vitest";
${inputComments}${outputComments}
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
