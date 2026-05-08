// SPDX-License-Identifier: MIT
// @decision DEC-V2-PROPTEST-PATH-A-001: hand-authored property-test corpus for
// @yakcc/shave corpus/documented-usage.ts atoms. Two-file pattern: this file
// (.props.ts) is vitest-free and holds the corpus; the sibling .props.test.ts
// is the vitest harness.
// Status: accepted (WI-V2-07-PREFLIGHT L3i)
// Rationale: See tmp/wi-v2-07-preflight-layer-plan.md — the corpus file must
// be runtime-independent so L10 can hash it as a manifest artifact.
//
// Atoms covered (named exports from documented-usage.ts):
//   extractFromDocumentedUsage (DU1.1–DU1.19) — synthesizes fast-check from JSDoc examples.
//   extractJsDocExamples (DU1.27) — exercised through extractFromDocumentedUsage.
//   typeHintToArbitrary (DU1.19–DU1.26) — exercised through extractFromDocumentedUsage.
//   inferFunctionName (DU1.6–DU1.7) — exercised through extractFromDocumentedUsage.
//
// Properties covered (27 atoms):
//   1.  return.source === 'documented-usage'
//   2.  return.path === 'property-tests.fast-check.ts'
//   3.  bytes round-trip through UTF-8
//   4.  contentHash is 64-char hex matching BLAKE3
//   5.  determinism: same inputs → byte-identical output
//   6.  describe block uses inferred function name
//   7.  describe falls back to 'atom' when no function/const decl
//   8.  one it() per example plus one signature test
//   9.  empty examples still emits signature test
//   10. example labels are JSON.stringify'd
//   11. example comment lines are prefixed '   * '
//   12. signature test label truncated to 60 chars
//   13. postconditions are rendered as '// Postcondition: <text>'
//   14. input argument names are prefixed with '_'
//   15. arbitrary list joined by ', '
//   16. empty inputs → 'fc.anything()' fallback
//   17. input comment block shows name: typeHint → arbitrary
//   18. empty inputs → '// (no typed inputs found)' comment
//   19. typeHintToArbitrary: 'string' → 'fc.string()'
//   20. typeHintToArbitrary: 'number' → 'fc.float()'
//   21. typeHintToArbitrary: 'integer'/'int' → 'fc.integer()'
//   22. typeHintToArbitrary: 'boolean' → 'fc.boolean()'
//   23. typeHintToArbitrary: 'bigint' → 'fc.bigInt()'
//   24. typeHintToArbitrary: ending '[]' → 'fc.array(fc.anything())'
//   25. typeHintToArbitrary: starting 'array<' → 'fc.array(fc.anything())'
//   26. typeHintToArbitrary: unknown type → 'fc.anything()'
//   27. extractJsDocExamples: empty source → zero examples → one it() block

// ---------------------------------------------------------------------------
// Property-test corpus for corpus/documented-usage.ts
// ---------------------------------------------------------------------------

import { blake3 } from "@noble/hashes/blake3";
import { bytesToHex } from "@noble/hashes/utils";
import * as fc from "fast-check";
import { extractFromDocumentedUsage } from "./documented-usage.js";
import type { IntentCardInput } from "./types.js";

// ---------------------------------------------------------------------------
// Shared arbitraries
// ---------------------------------------------------------------------------

/** Non-empty string with no leading/trailing whitespace. */
const nonEmptyStr: fc.Arbitrary<string> = fc
  .string({ minLength: 1, maxLength: 40 })
  .filter((s) => s.trim().length > 0);

/** Arbitrary IntentCardInput. */
const intentCardInputArb: fc.Arbitrary<IntentCardInput> = fc.record({
  behavior: nonEmptyStr,
  inputs: fc.array(
    fc.record({
      name: nonEmptyStr,
      typeHint: nonEmptyStr,
      description: fc.string({ minLength: 0, maxLength: 40 }),
    }),
    { minLength: 0, maxLength: 3 },
  ),
  outputs: fc.array(
    fc.record({
      name: nonEmptyStr,
      typeHint: nonEmptyStr,
      description: fc.string({ minLength: 0, maxLength: 40 }),
    }),
    { minLength: 0, maxLength: 3 },
  ),
  preconditions: fc.array(nonEmptyStr, { minLength: 0, maxLength: 3 }),
  postconditions: fc.array(nonEmptyStr, { minLength: 0, maxLength: 3 }),
  notes: fc.array(fc.string(), { minLength: 0, maxLength: 2 }),
  sourceHash: fc
    .array(fc.integer({ min: 0, max: 15 }), { minLength: 64, maxLength: 64 })
    .map((nibbles) => nibbles.map((n) => n.toString(16)).join("")),
  modelVersion: nonEmptyStr,
  promptVersion: nonEmptyStr,
});

/** Source string with a function declaration. */
const sourceFnDeclArb: fc.Arbitrary<string> = fc
  .string({ minLength: 1, maxLength: 20 })
  .filter((s) => /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(s))
  .map((name) => `export function ${name}(x: string): string { return x; }`);

/** Source string with only a const declaration. */
const sourceConstDeclArb: fc.Arbitrary<string> = fc
  .string({ minLength: 1, maxLength: 20 })
  .filter((s) => /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(s))
  .map((name) => `export const ${name} = (x: string): string => x;`);

/** Source string with no function or const declaration. */
const sourceNoDeclArb: fc.Arbitrary<string> = fc
  .string({ minLength: 0, maxLength: 40 })
  .filter((s) => !/(?:^|\s)function\s+[a-zA-Z_$]/.test(s) && !/(?:^|\s)const\s+[a-zA-Z_$]/.test(s));

/** Source string with N @example blocks embedded in a JSDoc comment. */
function sourceWithExamplesArb(n: number): fc.Arbitrary<string> {
  const exampleTexts = Array.from({ length: n }, (_, i) => `example text ${i + 1}`);
  const examples = exampleTexts.map((t) => ` * @example\n * ${t}\n`).join("");
  return fc.constant(`/**\n${examples} */\nexport function fn() {}`);
}

// ---------------------------------------------------------------------------
// DU1.1: return.source === 'documented-usage'
// ---------------------------------------------------------------------------

/**
 * @summary extractFromDocumentedUsage always returns source="documented-usage".
 */
export const prop_extractFromDocumentedUsage_returnsDocumentedUsageSource: fc.IPropertyWithHooks<
  [IntentCardInput, string]
> = fc.property(intentCardInputArb, fc.string(), (card, source) => {
  const result = extractFromDocumentedUsage(card, source);
  return result.source === "documented-usage";
});

// ---------------------------------------------------------------------------
// DU1.2: return.path === canonical artifact path
// ---------------------------------------------------------------------------

/**
 * @summary extractFromDocumentedUsage always returns path="property-tests.fast-check.ts".
 */
export const prop_extractFromDocumentedUsage_returnsCanonicalArtifactPath: fc.IPropertyWithHooks<
  [IntentCardInput, string]
> = fc.property(intentCardInputArb, fc.string(), (card, source) => {
  const result = extractFromDocumentedUsage(card, source);
  return result.path === "property-tests.fast-check.ts";
});

// ---------------------------------------------------------------------------
// DU1.3: bytes round-trip through UTF-8
// ---------------------------------------------------------------------------

/**
 * @summary extractFromDocumentedUsage bytes round-trip through TextEncoder/TextDecoder.
 */
export const prop_extractFromDocumentedUsage_bytesAreUtf8RoundTrip: fc.IPropertyWithHooks<
  [IntentCardInput, string]
> = fc.property(intentCardInputArb, fc.string(), (card, source) => {
  const result = extractFromDocumentedUsage(card, source);
  const encoder = new TextEncoder();
  const decoder = new TextDecoder("utf-8");
  const decoded = decoder.decode(result.bytes);
  const reEncoded = encoder.encode(decoded);
  if (result.bytes.length !== reEncoded.length) return false;
  for (let i = 0; i < result.bytes.length; i++) {
    if (result.bytes[i] !== reEncoded[i]) return false;
  }
  return true;
});

// ---------------------------------------------------------------------------
// DU1.4: contentHash is 64-char hex matching BLAKE3
// ---------------------------------------------------------------------------

/**
 * @summary extractFromDocumentedUsage contentHash is 64-char hex and equals blake3(bytes).
 */
export const prop_extractFromDocumentedUsage_contentHashIsBlake3HexOf64Chars: fc.IPropertyWithHooks<
  [IntentCardInput, string]
> = fc.property(intentCardInputArb, fc.string(), (card, source) => {
  const result = extractFromDocumentedUsage(card, source);
  const expectedHash = bytesToHex(blake3(result.bytes));
  return /^[0-9a-f]{64}$/.test(result.contentHash) && result.contentHash === expectedHash;
});

// ---------------------------------------------------------------------------
// DU1.5: determinism — same inputs → byte-identical output
// ---------------------------------------------------------------------------

/**
 * @summary extractFromDocumentedUsage is deterministic: identical inputs yield identical bytes.
 */
export const prop_extractFromDocumentedUsage_determinismGivenSameInputs: fc.IPropertyWithHooks<
  [IntentCardInput, string]
> = fc.property(intentCardInputArb, fc.string(), (card, source) => {
  const r1 = extractFromDocumentedUsage(card, source);
  const r2 = extractFromDocumentedUsage(card, source);
  if (r1.bytes.length !== r2.bytes.length) return false;
  for (let i = 0; i < r1.bytes.length; i++) {
    if (r1.bytes[i] !== r2.bytes[i]) return false;
  }
  return r1.contentHash === r2.contentHash;
});

// ---------------------------------------------------------------------------
// DU1.6: describe block uses inferred function name
// ---------------------------------------------------------------------------

/**
 * @summary Generated content includes describe(...'<fnName> — documented usage properties'...) when source has function decl.
 */
export const prop_extractFromDocumentedUsage_describeBlockUsesInferredFnName: fc.IPropertyWithHooks<
  [IntentCardInput, string]
> = fc.property(intentCardInputArb, sourceFnDeclArb, (card, source) => {
  const result = extractFromDocumentedUsage(card, source);
  const decoder = new TextDecoder("utf-8");
  const content = decoder.decode(result.bytes);
  const m = source.match(/(?:^|\s)function\s+([a-zA-Z_$][a-zA-Z0-9_$]*)/);
  const fnName = m?.[1];
  if (!fnName) return false;
  return content.includes(`${fnName} — documented usage properties`);
});

// ---------------------------------------------------------------------------
// DU1.7: describe falls back to 'atom' when no function/const decl
// ---------------------------------------------------------------------------

/**
 * @summary Generated content uses 'atom — documented usage properties' when source has no function/const decl.
 */
export const prop_extractFromDocumentedUsage_describeFallsBackToAtom: fc.IPropertyWithHooks<
  [IntentCardInput, string]
> = fc.property(intentCardInputArb, sourceNoDeclArb, (card, source) => {
  const result = extractFromDocumentedUsage(card, source);
  const decoder = new TextDecoder("utf-8");
  const content = decoder.decode(result.bytes);
  return content.includes("atom — documented usage properties");
});

// ---------------------------------------------------------------------------
// DU1.8: one it() per example plus one signature test
// ---------------------------------------------------------------------------

/**
 * @summary it() count equals examples.length + 1 (the signature test).
 */
export const prop_extractFromDocumentedUsage_oneItPerExamplePlusOneSignatureTest: fc.IPropertyWithHooks<
  [IntentCardInput]
> = fc.property(intentCardInputArb, (card) => {
  // Use a source with exactly 2 @example blocks to verify the count
  const source = "/**\n * @example\n * first\n * @example\n * second\n */\nexport function fn() {}";
  const result = extractFromDocumentedUsage(card, source);
  const decoder = new TextDecoder("utf-8");
  const content = decoder.decode(result.bytes);
  const itCount = (content.match(/\bit\(/g) ?? []).length;
  // 2 examples + 1 signature test
  return itCount === 3;
});

// ---------------------------------------------------------------------------
// DU1.9: empty examples still emits signature test
// ---------------------------------------------------------------------------

/**
 * @summary Source with zero @example blocks produces exactly one it() block.
 */
export const prop_extractFromDocumentedUsage_emptyExamplesStillEmitsSignatureTest: fc.IPropertyWithHooks<
  [IntentCardInput, string]
> = fc.property(intentCardInputArb, sourceNoDeclArb, (card, source) => {
  // sourceNoDeclArb produces strings with no function/const and typically no @example
  const result = extractFromDocumentedUsage(card, source);
  const decoder = new TextDecoder("utf-8");
  const content = decoder.decode(result.bytes);
  const itCount = (content.match(/\bit\(/g) ?? []).length;
  // No @example blocks in sourceNoDeclArb → exactly 1 it() (the signature test)
  return itCount === 1;
});

// ---------------------------------------------------------------------------
// DU1.10: example labels are JSON.stringify'd
// ---------------------------------------------------------------------------

/**
 * @summary Each @example uses JSON.stringify(`example ${i+1}`) as the it() label.
 */
export const prop_extractFromDocumentedUsage_exampleLabelsAreJsonStringified: fc.IPropertyWithHooks<
  [IntentCardInput]
> = fc.property(intentCardInputArb, (card) => {
  void sourceWithExamplesArb; // referenced to satisfy linter; fixed string below avoids arbitrary overhead
  const sourceStr =
    "/**\n * @example\n * first example\n * @example\n * second example\n */\nexport function fn() {}";
  const result = extractFromDocumentedUsage(card, sourceStr);
  const decoder = new TextDecoder("utf-8");
  const content = decoder.decode(result.bytes);
  // Labels must be JSON.stringify'd
  return (
    content.includes(JSON.stringify("example 1")) && content.includes(JSON.stringify("example 2"))
  );
});

// ---------------------------------------------------------------------------
// DU1.11: example comment lines are prefixed '   * '
// ---------------------------------------------------------------------------

/**
 * @summary Each line of @example body is prefixed with '   * ' in the generated JSDoc block.
 */
export const prop_extractFromDocumentedUsage_exampleCommentsAreLinePrefixed: fc.IPropertyWithHooks<
  [IntentCardInput]
> = fc.property(intentCardInputArb, (card) => {
  // Place example text inline with @example so the extracted text has no JSDoc '*' prefix.
  // "@example some code here" → ex.text = "some code here" → commentLine = "   * some code here"
  const sourceStr = "/**\n * @example some code here\n */\nexport function fn() {}";
  const result = extractFromDocumentedUsage(card, sourceStr);
  const decoder = new TextDecoder("utf-8");
  const content = decoder.decode(result.bytes);
  return content.includes("   * some code here");
});

// ---------------------------------------------------------------------------
// DU1.12: signature test label truncated to 60 chars
// ---------------------------------------------------------------------------

/**
 * @summary The signature test it() label includes intentCard.behavior.slice(0, 60).
 */
export const prop_extractFromDocumentedUsage_signatureTestLabelTruncatedTo60: fc.IPropertyWithHooks<
  [IntentCardInput, string]
> = fc.property(intentCardInputArb, fc.string(), (card, source) => {
  const result = extractFromDocumentedUsage(card, source);
  const decoder = new TextDecoder("utf-8");
  const content = decoder.decode(result.bytes);
  const truncated = card.behavior.slice(0, 60);
  return content.includes(truncated);
});

// ---------------------------------------------------------------------------
// DU1.13: postconditions are rendered as '// Postcondition: <text>'
// ---------------------------------------------------------------------------

/**
 * @summary Each postcondition is rendered as '// Postcondition: <text>' in the signature test.
 */
export const prop_extractFromDocumentedUsage_postconditionsAreCommentedInSignatureTest: fc.IPropertyWithHooks<
  [IntentCardInput, string]
> = fc.property(
  intentCardInputArb.filter((c) => c.postconditions.length > 0),
  fc.string(),
  (card, source) => {
    const result = extractFromDocumentedUsage(card, source);
    const decoder = new TextDecoder("utf-8");
    const content = decoder.decode(result.bytes);
    return card.postconditions.every((p) => content.includes(`// Postcondition: ${p}`));
  },
);

// ---------------------------------------------------------------------------
// DU1.14: input argument names are prefixed with '_'
// ---------------------------------------------------------------------------

/**
 * @summary Input names render as `_${name}` in the generated arrow-function parameter list.
 */
export const prop_extractFromDocumentedUsage_inputArbitraryPrefixesAreUnderscored: fc.IPropertyWithHooks<
  [IntentCardInput, string]
> = fc.property(
  intentCardInputArb.filter((c) => c.inputs.length > 0),
  fc.string(),
  (card, source) => {
    const result = extractFromDocumentedUsage(card, source);
    const decoder = new TextDecoder("utf-8");
    const content = decoder.decode(result.bytes);
    return card.inputs.every((inp) => content.includes(`_${inp.name}`));
  },
);

// ---------------------------------------------------------------------------
// DU1.15: arbitrary list joined by ', '
// ---------------------------------------------------------------------------

/**
 * @summary Multiple input arbitraries are joined with ', ' in the fc.property arg list.
 */
export const prop_extractFromDocumentedUsage_arbListJoinedByCommaSpace: fc.IPropertyWithHooks<
  [IntentCardInput, string]
> = fc.property(
  intentCardInputArb.filter((c) => c.inputs.length >= 2),
  fc.string(),
  (card, source) => {
    const result = extractFromDocumentedUsage(card, source);
    const decoder = new TextDecoder("utf-8");
    const content = decoder.decode(result.bytes);
    // The arbitraries are joined with ', ' — check for the multi-arg pattern
    return content.includes(", fc.");
  },
);

// ---------------------------------------------------------------------------
// DU1.16: empty inputs → 'fc.anything()' fallback
// ---------------------------------------------------------------------------

/**
 * @summary When inputs.length === 0, generated arbList is 'fc.anything()' and arg is '_input'.
 */
export const prop_extractFromDocumentedUsage_emptyInputsUseAnythingFallback: fc.IPropertyWithHooks<
  [string, string]
> = fc.property(nonEmptyStr, fc.string(), (behavior, source) => {
  const card: IntentCardInput = {
    behavior,
    inputs: [],
    outputs: [],
    preconditions: [],
    postconditions: [],
    notes: [],
    sourceHash: "a".repeat(64),
    modelVersion: "v1",
    promptVersion: "p1",
  };
  const result = extractFromDocumentedUsage(card, source);
  const decoder = new TextDecoder("utf-8");
  const content = decoder.decode(result.bytes);
  return content.includes("fc.anything()") && content.includes("_input");
});

// ---------------------------------------------------------------------------
// DU1.17: input comment block shows 'name: typeHint — description → arbitrary'
// ---------------------------------------------------------------------------

/**
 * @summary Each input renders as '  // <name>: <typeHint> — <description> → <arbitrary>' in comment block.
 */
export const prop_extractFromDocumentedUsage_inputCommentsBlockShowsArbitraryMapping: fc.IPropertyWithHooks<
  [IntentCardInput, string]
> = fc.property(
  intentCardInputArb.filter((c) => c.inputs.length > 0),
  fc.string(),
  (card, source) => {
    const result = extractFromDocumentedUsage(card, source);
    const decoder = new TextDecoder("utf-8");
    const content = decoder.decode(result.bytes);
    return card.inputs.every((inp) => content.includes(`// ${inp.name}: ${inp.typeHint}`));
  },
);

// ---------------------------------------------------------------------------
// DU1.18: empty inputs → '// (no typed inputs found)' comment
// ---------------------------------------------------------------------------

/**
 * @summary When inputs.length === 0, content includes '// (no typed inputs found)'.
 */
export const prop_extractFromDocumentedUsage_emptyInputsRenderNoTypedInputsComment: fc.IPropertyWithHooks<
  [string, string]
> = fc.property(nonEmptyStr, fc.string(), (behavior, source) => {
  const card: IntentCardInput = {
    behavior,
    inputs: [],
    outputs: [],
    preconditions: [],
    postconditions: [],
    notes: [],
    sourceHash: "a".repeat(64),
    modelVersion: "v1",
    promptVersion: "p1",
  };
  const result = extractFromDocumentedUsage(card, source);
  const decoder = new TextDecoder("utf-8");
  const content = decoder.decode(result.bytes);
  return content.includes("// (no typed inputs found)");
});

// ---------------------------------------------------------------------------
// DU1.19: typeHintToArbitrary: 'string' → 'fc.string()'
// ---------------------------------------------------------------------------

/**
 * @summary typeHint='string' (case-insensitive trim) maps to 'fc.string()' in generated content.
 */
export const prop_extractFromDocumentedUsage_typeHintToArbitrary_string: fc.IPropertyWithHooks<
  [string]
> = fc.property(nonEmptyStr, (behavior) => {
  const card: IntentCardInput = {
    behavior,
    inputs: [{ name: "x", typeHint: "string", description: "" }],
    outputs: [],
    preconditions: [],
    postconditions: [],
    notes: [],
    sourceHash: "a".repeat(64),
    modelVersion: "v1",
    promptVersion: "p1",
  };
  const result = extractFromDocumentedUsage(card, "");
  const decoder = new TextDecoder("utf-8");
  const content = decoder.decode(result.bytes);
  return content.includes("fc.string()");
});

// ---------------------------------------------------------------------------
// DU1.20: typeHintToArbitrary: 'number' → 'fc.float()'
// ---------------------------------------------------------------------------

/**
 * @summary typeHint='number' maps to 'fc.float()' in generated content.
 */
export const prop_extractFromDocumentedUsage_typeHintToArbitrary_number: fc.IPropertyWithHooks<
  [string]
> = fc.property(nonEmptyStr, (behavior) => {
  const card: IntentCardInput = {
    behavior,
    inputs: [{ name: "x", typeHint: "number", description: "" }],
    outputs: [],
    preconditions: [],
    postconditions: [],
    notes: [],
    sourceHash: "a".repeat(64),
    modelVersion: "v1",
    promptVersion: "p1",
  };
  const result = extractFromDocumentedUsage(card, "");
  const decoder = new TextDecoder("utf-8");
  const content = decoder.decode(result.bytes);
  return content.includes("fc.float()");
});

// ---------------------------------------------------------------------------
// DU1.21: typeHintToArbitrary: 'integer'/'int' → 'fc.integer()'
// ---------------------------------------------------------------------------

/**
 * @summary typeHint='integer' or 'int' maps to 'fc.integer()' in generated content.
 */
export const prop_extractFromDocumentedUsage_typeHintToArbitrary_integerOrInt: fc.IPropertyWithHooks<
  [string, string]
> = fc.property(nonEmptyStr, fc.constantFrom("integer", "int"), (behavior, typeHint) => {
  const card: IntentCardInput = {
    behavior,
    inputs: [{ name: "n", typeHint, description: "" }],
    outputs: [],
    preconditions: [],
    postconditions: [],
    notes: [],
    sourceHash: "a".repeat(64),
    modelVersion: "v1",
    promptVersion: "p1",
  };
  const result = extractFromDocumentedUsage(card, "");
  const decoder = new TextDecoder("utf-8");
  const content = decoder.decode(result.bytes);
  return content.includes("fc.integer()");
});

// ---------------------------------------------------------------------------
// DU1.22: typeHintToArbitrary: 'boolean' → 'fc.boolean()'
// ---------------------------------------------------------------------------

/**
 * @summary typeHint='boolean' maps to 'fc.boolean()' in generated content.
 */
export const prop_extractFromDocumentedUsage_typeHintToArbitrary_boolean: fc.IPropertyWithHooks<
  [string]
> = fc.property(nonEmptyStr, (behavior) => {
  const card: IntentCardInput = {
    behavior,
    inputs: [{ name: "b", typeHint: "boolean", description: "" }],
    outputs: [],
    preconditions: [],
    postconditions: [],
    notes: [],
    sourceHash: "a".repeat(64),
    modelVersion: "v1",
    promptVersion: "p1",
  };
  const result = extractFromDocumentedUsage(card, "");
  const decoder = new TextDecoder("utf-8");
  const content = decoder.decode(result.bytes);
  return content.includes("fc.boolean()");
});

// ---------------------------------------------------------------------------
// DU1.23: typeHintToArbitrary: 'bigint' → 'fc.bigInt()'
// ---------------------------------------------------------------------------

/**
 * @summary typeHint='bigint' maps to 'fc.bigInt()' in generated content.
 */
export const prop_extractFromDocumentedUsage_typeHintToArbitrary_bigint: fc.IPropertyWithHooks<
  [string]
> = fc.property(nonEmptyStr, (behavior) => {
  const card: IntentCardInput = {
    behavior,
    inputs: [{ name: "bi", typeHint: "bigint", description: "" }],
    outputs: [],
    preconditions: [],
    postconditions: [],
    notes: [],
    sourceHash: "a".repeat(64),
    modelVersion: "v1",
    promptVersion: "p1",
  };
  const result = extractFromDocumentedUsage(card, "");
  const decoder = new TextDecoder("utf-8");
  const content = decoder.decode(result.bytes);
  return content.includes("fc.bigInt()");
});

// ---------------------------------------------------------------------------
// DU1.24: typeHintToArbitrary: ending '[]' → 'fc.array(fc.anything())'
// ---------------------------------------------------------------------------

/**
 * @summary typeHint ending '[]' maps to 'fc.array(fc.anything())' in generated content.
 */
export const prop_extractFromDocumentedUsage_typeHintToArbitrary_arrayBracket: fc.IPropertyWithHooks<
  [string, string]
> = fc.property(nonEmptyStr, fc.constantFrom("any[]", "object[]", "T[]"), (behavior, typeHint) => {
  const card: IntentCardInput = {
    behavior,
    inputs: [{ name: "arr", typeHint, description: "" }],
    outputs: [],
    preconditions: [],
    postconditions: [],
    notes: [],
    sourceHash: "a".repeat(64),
    modelVersion: "v1",
    promptVersion: "p1",
  };
  const result = extractFromDocumentedUsage(card, "");
  const decoder = new TextDecoder("utf-8");
  const content = decoder.decode(result.bytes);
  return content.includes("fc.array(fc.anything())");
});

// ---------------------------------------------------------------------------
// DU1.25: typeHintToArbitrary: starting 'array<' → 'fc.array(fc.anything())'
// ---------------------------------------------------------------------------

/**
 * @summary typeHint starting 'array<' (case-insensitive) maps to 'fc.array(fc.anything())'.
 */
export const prop_extractFromDocumentedUsage_typeHintToArbitrary_arrayAngle: fc.IPropertyWithHooks<
  [string]
> = fc.property(nonEmptyStr, (behavior) => {
  const card: IntentCardInput = {
    behavior,
    inputs: [{ name: "arr", typeHint: "Array<string>", description: "" }],
    outputs: [],
    preconditions: [],
    postconditions: [],
    notes: [],
    sourceHash: "a".repeat(64),
    modelVersion: "v1",
    promptVersion: "p1",
  };
  const result = extractFromDocumentedUsage(card, "");
  const decoder = new TextDecoder("utf-8");
  const content = decoder.decode(result.bytes);
  return content.includes("fc.array(fc.anything())");
});

// ---------------------------------------------------------------------------
// DU1.26: typeHintToArbitrary: unknown type → 'fc.anything()'
// ---------------------------------------------------------------------------

/**
 * @summary Unknown typeHint strings map to 'fc.anything()' in generated content.
 */
export const prop_extractFromDocumentedUsage_typeHintToArbitrary_unknownFallsBackToAnything: fc.IPropertyWithHooks<
  [string, string]
> = fc.property(
  nonEmptyStr,
  // Generate type hints that won't match any known primitive
  fc
    .string({ minLength: 1, maxLength: 20 })
    .filter(
      (s) =>
        s.trim().length > 0 &&
        !["string", "number", "integer", "int", "boolean", "bigint"].includes(
          s.trim().toLowerCase(),
        ) &&
        !s.trim().toLowerCase().endsWith("[]") &&
        !s.trim().toLowerCase().startsWith("array<") &&
        !s.trim().toLowerCase().startsWith("string[") &&
        !s.trim().toLowerCase().startsWith("number["),
    ),
  (behavior, typeHint) => {
    const card: IntentCardInput = {
      behavior,
      inputs: [{ name: "v", typeHint, description: "" }],
      outputs: [],
      preconditions: [],
      postconditions: [],
      notes: [],
      sourceHash: "a".repeat(64),
      modelVersion: "v1",
      promptVersion: "p1",
    };
    const result = extractFromDocumentedUsage(card, "");
    const decoder = new TextDecoder("utf-8");
    const content = decoder.decode(result.bytes);
    return content.includes("fc.anything()");
  },
);

// ---------------------------------------------------------------------------
// DU1.27: extractJsDocExamples: empty source → zero examples → one it() block
// ---------------------------------------------------------------------------

/**
 * @summary Source with no JSDoc blocks yields zero examples, producing exactly one it() block.
 */
export const prop_extractFromDocumentedUsage_extractJsDocExamples_emptySourceReturnsEmptyArray: fc.IPropertyWithHooks<
  [IntentCardInput]
> = fc.property(intentCardInputArb, (card) => {
  // Plain source with no /** ... */ JSDoc blocks
  const result = extractFromDocumentedUsage(card, "export function fn() {}");
  const decoder = new TextDecoder("utf-8");
  const content = decoder.decode(result.bytes);
  const itCount = (content.match(/\bit\(/g) ?? []).length;
  // No @example blocks → zero examples → 0 + 1 = 1 it() (the signature test only)
  return itCount === 1;
});
