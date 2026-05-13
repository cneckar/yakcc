// SPDX-License-Identifier: MIT
// @decision DEC-V2-PROPTEST-PATH-A-001: hand-authored property-test corpus for
// @yakcc/shave corpus/documented-usage.ts atoms. Two-file pattern: this file
// (.props.ts) is vitest-free and holds the corpus; the sibling .props.test.ts
// is the vitest harness.
// Status: accepted (WI-V2-07-PREFLIGHT L3i, revised WI-376)
// Rationale: See tmp/wi-v2-07-preflight-layer-plan.md -- the corpus file must
// be runtime-independent so L10 can hash it as a manifest artifact.
//
// WI-376 revision: extractFromDocumentedUsage now returns CorpusResult | undefined
// per DEC-PROPTEST-DOCUMENTED-USAGE-001 (loud refusal over silent placeholder).
// The type-signature catch-all test (signatureTest) is removed; fc.property bodies
// are replaced by deterministic expect() assertions derived from Option-A parsing.
//
// Atoms covered (named exports from documented-usage.ts):
//   extractFromDocumentedUsage (DU1.1-DU1.15) -- synthesizes expect() assertions from
//     parseable @example blocks; returns undefined on loud refusal.
//   extractJsDocExamples (DU1.27) -- exercised through extractFromDocumentedUsage.
//   typeHintToArbitrary (DU1.16-DU1.26) -- exercised through extractFromDocumentedUsage
//     (output appears in comment-header section of generated file, not property body).
//   inferFunctionName (DU1.6-DU1.7) -- exercised through extractFromDocumentedUsage.
//
// Properties covered:
//   1.  parseable source returns source="documented-usage"
//   2.  parseable source returns path="property-tests.fast-check.ts"
//   3.  bytes round-trip through UTF-8
//   4.  contentHash is 64-char BLAKE3 hex
//   5.  determinism: same inputs -> byte-identical output
//   6.  describe block uses inferred function name
//   7.  describe falls back to 'atom' when no function/const decl (with parseable @example)
//   8.  parseable @example produces one it() with expect() assertion
//   9.  source with no @example blocks returns undefined (loud refusal)
//   10. source where all @examples are unstructured returns undefined (loud refusal)
//   11. example labels include call expression: "example N: callExpr"
//   12. example comment lines are prefixed '   * '
//   13. expect call uses callExpr and toEqual with expectedExpr
//   14. input comment block shows name: typeHint -> arbitrary
//   15. empty inputs -> '// (no typed inputs found)' comment
//   16. typeHintToArbitrary: 'string' -> 'fc.string()'
//   17. typeHintToArbitrary: 'number' -> 'fc.float()'
//   18. typeHintToArbitrary: 'integer'/'int' -> 'fc.integer()'
//   19. typeHintToArbitrary: 'boolean' -> 'fc.boolean()'
//   20. typeHintToArbitrary: 'bigint' -> 'fc.bigInt()'
//   21. typeHintToArbitrary: ending '[]' -> 'fc.array(fc.anything())'
//   22. typeHintToArbitrary: starting 'array<' -> 'fc.array(fc.anything())'
//   23. typeHintToArbitrary: unknown type -> 'fc.anything()'
//   24. source with only multi-line @examples returns undefined
//   25. source with mixed parseable+unparseable emits only parseable as it() blocks

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

/**
 * Source string with a function declaration AND a parseable @example block.
 * The @example uses Option-A format: fn(arg) // => expected
 */
const sourceFnDeclWithParseableExampleArb: fc.Arbitrary<string> = fc
  .string({ minLength: 1, maxLength: 20 })
  .filter((s) => /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(s))
  .map(
    (name) =>
      `/**\n * @example\n * ${name}("x") // => "x"\n */\nexport function ${name}(x: string): string { return x; }`,
  );

/**
 * Source string with only a const declaration AND a parseable @example block.
 */
const sourceConstDeclWithParseableExampleArb: fc.Arbitrary<string> = fc
  .string({ minLength: 1, maxLength: 20 })
  .filter((s) => /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(s))
  .map(
    (name) =>
      `/**\n * @example\n * ${name}("x") // => "x"\n */\nexport const ${name} = (x: string): string => x;`,
  );

/** Source string with no function or const declaration, but parseable @example. */
const sourceNoDeclWithParseableExampleArb: fc.Arbitrary<string> = fc.constant(
  '/**\n * @example\n * fn("x") // => "x"\n */\n// no function declaration',
);

/** A fixed parseable source: fn("1,2,3") // => [1, 2, 3] */
const PARSEABLE_SOURCE = `/**
 * Parse a comma-separated list.
 *
 * @example
 * parseList("1,2,3") // => [1, 2, 3]
 */
export function parseList(raw: string): number[] { return []; }`;

/** A fixed unstructured source (prose-only @example, no => arrow) */
const UNSTRUCTURED_SOURCE = `/**
 * Parse a comma-separated list.
 *
 * @example
 * parseList takes a string and returns an array
 */
export function parseList(raw: string): number[] { return []; }`;

/** Source with no @example blocks at all. */
const NO_EXAMPLE_SOURCE = "export function parseList(raw: string): number[] { return []; }";

/** Source with multi-line @example (should be refused). */
const MULTILINE_EXAMPLE_SOURCE = `/**
 * @example
 * parseList("1,2,3")
 * // => [1, 2, 3]
 */
export function parseList(raw: string): number[] { return []; }`;

// ---------------------------------------------------------------------------
// DU1.1: parseable source returns source="documented-usage"
// ---------------------------------------------------------------------------

/**
 * @summary extractFromDocumentedUsage returns source="documented-usage" for parseable @example source.
 */
export const prop_extractFromDocumentedUsage_returnsDocumentedUsageSource: fc.IPropertyWithHooks<
  [IntentCardInput, string]
> = fc.property(intentCardInputArb, sourceFnDeclWithParseableExampleArb, (card, source) => {
  const result = extractFromDocumentedUsage(card, source);
  // Parseable source must produce a non-undefined result
  if (result === undefined) return false;
  return result.source === "documented-usage";
});

// ---------------------------------------------------------------------------
// DU1.2: parseable source returns path="property-tests.fast-check.ts"
// ---------------------------------------------------------------------------

/**
 * @summary extractFromDocumentedUsage returns path="property-tests.fast-check.ts" for parseable source.
 */
export const prop_extractFromDocumentedUsage_returnsCanonicalArtifactPath: fc.IPropertyWithHooks<
  [IntentCardInput, string]
> = fc.property(intentCardInputArb, sourceFnDeclWithParseableExampleArb, (card, source) => {
  const result = extractFromDocumentedUsage(card, source);
  if (result === undefined) return false;
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
> = fc.property(intentCardInputArb, sourceFnDeclWithParseableExampleArb, (card, source) => {
  const result = extractFromDocumentedUsage(card, source);
  if (result === undefined) return false;
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
> = fc.property(intentCardInputArb, sourceFnDeclWithParseableExampleArb, (card, source) => {
  const result = extractFromDocumentedUsage(card, source);
  if (result === undefined) return false;
  const expectedHash = bytesToHex(blake3(result.bytes));
  return /^[0-9a-f]{64}$/.test(result.contentHash) && result.contentHash === expectedHash;
});

// ---------------------------------------------------------------------------
// DU1.5: determinism -- same inputs -> byte-identical output
// ---------------------------------------------------------------------------

/**
 * @summary extractFromDocumentedUsage is deterministic: identical inputs yield identical bytes.
 */
export const prop_extractFromDocumentedUsage_determinismGivenSameInputs: fc.IPropertyWithHooks<
  [IntentCardInput, string]
> = fc.property(intentCardInputArb, sourceFnDeclWithParseableExampleArb, (card, source) => {
  const r1 = extractFromDocumentedUsage(card, source);
  const r2 = extractFromDocumentedUsage(card, source);
  if (r1 === undefined && r2 === undefined) return true;
  if (r1 === undefined || r2 === undefined) return false;
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
 * @summary Generated content includes describe('fnName -- documented usage properties'...) when source has function decl.
 */
export const prop_extractFromDocumentedUsage_describeBlockUsesInferredFnName: fc.IPropertyWithHooks<
  [IntentCardInput, string]
> = fc.property(intentCardInputArb, sourceFnDeclWithParseableExampleArb, (card, source) => {
  const result = extractFromDocumentedUsage(card, source);
  if (result === undefined) return false;
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
 * @summary Generated content uses 'atom -- documented usage properties' when source has no function/const decl.
 */
export const prop_extractFromDocumentedUsage_describeFallsBackToAtom: fc.IPropertyWithHooks<
  [IntentCardInput]
> = fc.property(intentCardInputArb, (card) => {
  // Source with a parseable @example but no function/const declaration.
  // Use a constant string (fc.Arbitrary doesn't have .sample()).
  const noFnSource = '/**\n * @example\n * fn("x") // => "x"\n */\n// no named export here';
  const result = extractFromDocumentedUsage(card, noFnSource);
  if (result === undefined) return false;
  const decoder = new TextDecoder("utf-8");
  const content = decoder.decode(result.bytes);
  return content.includes("atom — documented usage properties");
});

// ---------------------------------------------------------------------------
// DU1.8: parseable @example produces one it() with expect() assertion
// ---------------------------------------------------------------------------

/**
 * @summary One parseable @example -> exactly one it() block with expect().toEqual().
 */
export const prop_extractFromDocumentedUsage_parseableExampleProducesExpectAssertion: fc.IPropertyWithHooks<
  [IntentCardInput]
> = fc.property(intentCardInputArb, (card) => {
  const result = extractFromDocumentedUsage(card, PARSEABLE_SOURCE);
  if (result === undefined) return false;
  const decoder = new TextDecoder("utf-8");
  const content = decoder.decode(result.bytes);
  // Count it() calls using line-anchored pattern to avoid matching "it()" in comment text
  const itCount = (content.match(/^ {2}it\(/gm) ?? []).length;
  // Exactly one parseable example -> exactly one it() block
  if (itCount !== 1) return false;
  // Must use expect().toEqual() not fc.property() / return true
  return (
    content.includes("expect(") && content.includes(".toEqual(") && !content.includes("return true")
  );
});

// ---------------------------------------------------------------------------
// DU1.9: source with no @example blocks returns undefined (loud refusal)
// ---------------------------------------------------------------------------

/**
 * @summary Source with zero @example blocks returns undefined (loud refusal per DEC-PROPTEST-DOCUMENTED-USAGE-001).
 */
export const prop_extractFromDocumentedUsage_noExamplesReturnsUndefined: fc.IPropertyWithHooks<
  [IntentCardInput]
> = fc.property(intentCardInputArb, (card) => {
  const result = extractFromDocumentedUsage(card, NO_EXAMPLE_SOURCE);
  return result === undefined;
});

// ---------------------------------------------------------------------------
// DU1.10: source where all @examples are unstructured returns undefined
// ---------------------------------------------------------------------------

/**
 * @summary Source with only unstructured (prose) @example blocks returns undefined.
 */
export const prop_extractFromDocumentedUsage_unstructuredExamplesReturnUndefined: fc.IPropertyWithHooks<
  [IntentCardInput]
> = fc.property(intentCardInputArb, (card) => {
  const result = extractFromDocumentedUsage(card, UNSTRUCTURED_SOURCE);
  return result === undefined;
});

// ---------------------------------------------------------------------------
// DU1.11: example labels include call expression
// ---------------------------------------------------------------------------

/**
 * @summary The it() label is "example N: callExpr" for Option-A parsed examples.
 */
export const prop_extractFromDocumentedUsage_exampleLabelIncludesCallExpr: fc.IPropertyWithHooks<
  [IntentCardInput]
> = fc.property(intentCardInputArb, (card) => {
  const result = extractFromDocumentedUsage(card, PARSEABLE_SOURCE);
  if (result === undefined) return false;
  const decoder = new TextDecoder("utf-8");
  const content = decoder.decode(result.bytes);
  // Label contains "example 1: parseList(..." - check without args since JSON.stringify escapes the quotes
  return content.includes("example 1: parseList(");
});

// ---------------------------------------------------------------------------
// DU1.12: example comment lines are prefixed '   * '
// ---------------------------------------------------------------------------

/**
 * @summary Each line of @example body is prefixed with '   * ' in the generated JSDoc block.
 */
export const prop_extractFromDocumentedUsage_exampleCommentsAreLinePrefixed: fc.IPropertyWithHooks<
  [IntentCardInput]
> = fc.property(intentCardInputArb, (card) => {
  // Use a parseable @example with clear text so the comment line is predictable
  const source = `/**\n * @example\n * myFn("x") // => "x"\n */\nexport function myFn(x: string) { return x; }`;
  const result = extractFromDocumentedUsage(card, source);
  if (result === undefined) return false;
  const decoder = new TextDecoder("utf-8");
  const content = decoder.decode(result.bytes);
  // The @example text appears prefixed with "   * " in the JSDoc comment block.
  // The exampleText is "* myFn(\"x\") // => \"x\"" so the comment line is "   * * myFn(\"x\") // => \"x\""
  // Check for the prefix pattern without the double-quote args (JSON-escaped in content).
  return content.includes("   * * myFn(");
});

// ---------------------------------------------------------------------------
// DU1.13: expect call uses callExpr and toEqual with expectedExpr
// ---------------------------------------------------------------------------

/**
 * @summary Generated assertion is expect(callExpr).toEqual(expectedExpr).
 */
export const prop_extractFromDocumentedUsage_assertionUsesExpectToEqual: fc.IPropertyWithHooks<
  [IntentCardInput]
> = fc.property(intentCardInputArb, (card) => {
  const result = extractFromDocumentedUsage(card, PARSEABLE_SOURCE);
  if (result === undefined) return false;
  const decoder = new TextDecoder("utf-8");
  const content = decoder.decode(result.bytes);
  // Must contain expect(parseList("1,2,3")).toEqual([1, 2, 3])
  return content.includes('expect(parseList("1,2,3")).toEqual([1, 2, 3])');
});

// ---------------------------------------------------------------------------
// DU1.14: input comment block shows name: typeHint -> arbitrary
// ---------------------------------------------------------------------------

/**
 * @summary Each input renders as '  // <name>: <typeHint> ...' in comment block.
 */
export const prop_extractFromDocumentedUsage_inputCommentsBlockShowsArbitraryMapping: fc.IPropertyWithHooks<
  [IntentCardInput, string]
> = fc.property(
  intentCardInputArb.filter((c) => c.inputs.length > 0),
  sourceFnDeclWithParseableExampleArb,
  (card, source) => {
    const result = extractFromDocumentedUsage(card, source);
    if (result === undefined) return false;
    const decoder = new TextDecoder("utf-8");
    const content = decoder.decode(result.bytes);
    return card.inputs.every((inp) => content.includes(`// ${inp.name}: ${inp.typeHint}`));
  },
);

// ---------------------------------------------------------------------------
// DU1.15: empty inputs -> '// (no typed inputs found)' comment
// ---------------------------------------------------------------------------

/**
 * @summary When inputs.length === 0, content includes '// (no typed inputs found)'.
 */
export const prop_extractFromDocumentedUsage_emptyInputsRenderNoTypedInputsComment: fc.IPropertyWithHooks<
  [string]
> = fc.property(nonEmptyStr, (behavior) => {
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
  const result = extractFromDocumentedUsage(card, PARSEABLE_SOURCE);
  if (result === undefined) return false;
  const decoder = new TextDecoder("utf-8");
  const content = decoder.decode(result.bytes);
  return content.includes("// (no typed inputs found)");
});

// ---------------------------------------------------------------------------
// DU1.16: typeHintToArbitrary: 'string' -> 'fc.string()'
// ---------------------------------------------------------------------------

/**
 * @summary typeHint='string' maps to 'fc.string()' in generated content comment block.
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
  const result = extractFromDocumentedUsage(card, PARSEABLE_SOURCE);
  if (result === undefined) return false;
  const decoder = new TextDecoder("utf-8");
  const content = decoder.decode(result.bytes);
  return content.includes("fc.string()");
});

// ---------------------------------------------------------------------------
// DU1.17: typeHintToArbitrary: 'number' -> 'fc.float()'
// ---------------------------------------------------------------------------

/**
 * @summary typeHint='number' maps to 'fc.float()' in generated content comment block.
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
  const result = extractFromDocumentedUsage(card, PARSEABLE_SOURCE);
  if (result === undefined) return false;
  const decoder = new TextDecoder("utf-8");
  const content = decoder.decode(result.bytes);
  return content.includes("fc.float()");
});

// ---------------------------------------------------------------------------
// DU1.18: typeHintToArbitrary: 'integer'/'int' -> 'fc.integer()'
// ---------------------------------------------------------------------------

/**
 * @summary typeHint='integer' or 'int' maps to 'fc.integer()' in generated content comment block.
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
  const result = extractFromDocumentedUsage(card, PARSEABLE_SOURCE);
  if (result === undefined) return false;
  const decoder = new TextDecoder("utf-8");
  const content = decoder.decode(result.bytes);
  return content.includes("fc.integer()");
});

// ---------------------------------------------------------------------------
// DU1.19: typeHintToArbitrary: 'boolean' -> 'fc.boolean()'
// ---------------------------------------------------------------------------

/**
 * @summary typeHint='boolean' maps to 'fc.boolean()' in generated content comment block.
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
  const result = extractFromDocumentedUsage(card, PARSEABLE_SOURCE);
  if (result === undefined) return false;
  const decoder = new TextDecoder("utf-8");
  const content = decoder.decode(result.bytes);
  return content.includes("fc.boolean()");
});

// ---------------------------------------------------------------------------
// DU1.20: typeHintToArbitrary: 'bigint' -> 'fc.bigInt()'
// ---------------------------------------------------------------------------

/**
 * @summary typeHint='bigint' maps to 'fc.bigInt()' in generated content comment block.
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
  const result = extractFromDocumentedUsage(card, PARSEABLE_SOURCE);
  if (result === undefined) return false;
  const decoder = new TextDecoder("utf-8");
  const content = decoder.decode(result.bytes);
  return content.includes("fc.bigInt()");
});

// ---------------------------------------------------------------------------
// DU1.21: typeHintToArbitrary: ending '[]' -> 'fc.array(fc.anything())'
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
  const result = extractFromDocumentedUsage(card, PARSEABLE_SOURCE);
  if (result === undefined) return false;
  const decoder = new TextDecoder("utf-8");
  const content = decoder.decode(result.bytes);
  return content.includes("fc.array(fc.anything())");
});

// ---------------------------------------------------------------------------
// DU1.22: typeHintToArbitrary: starting 'array<' -> 'fc.array(fc.anything())'
// ---------------------------------------------------------------------------

/**
 * @summary typeHint starting 'array<' maps to 'fc.array(fc.anything())' in generated content.
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
  const result = extractFromDocumentedUsage(card, PARSEABLE_SOURCE);
  if (result === undefined) return false;
  const decoder = new TextDecoder("utf-8");
  const content = decoder.decode(result.bytes);
  return content.includes("fc.array(fc.anything())");
});

// ---------------------------------------------------------------------------
// DU1.23: typeHintToArbitrary: unknown type -> 'fc.anything()'
// ---------------------------------------------------------------------------

/**
 * @summary Unknown typeHint strings map to 'fc.anything()' in generated content comment block.
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
    const result = extractFromDocumentedUsage(card, PARSEABLE_SOURCE);
    if (result === undefined) return false;
    const decoder = new TextDecoder("utf-8");
    const content = decoder.decode(result.bytes);
    return content.includes("fc.anything()");
  },
);

// ---------------------------------------------------------------------------
// DU1.24: source with only multi-line @examples returns undefined
// ---------------------------------------------------------------------------

/**
 * @summary Multi-line @example blocks cannot be parsed into assertions -> loud refusal (undefined).
 */
export const prop_extractFromDocumentedUsage_multilineExamplesReturnUndefined: fc.IPropertyWithHooks<
  [IntentCardInput]
> = fc.property(intentCardInputArb, (card) => {
  const result = extractFromDocumentedUsage(card, MULTILINE_EXAMPLE_SOURCE);
  return result === undefined;
});

// ---------------------------------------------------------------------------
// DU1.25: source with mixed parseable+unparseable emits only parseable as it() blocks
// ---------------------------------------------------------------------------

/**
 * @summary When source has one parseable and one prose @example, only the parseable one
 * produces an it() block; the prose one is refused.
 */
export const prop_extractFromDocumentedUsage_mixedExamplesEmitsOnlyParseable: fc.IPropertyWithHooks<
  [IntentCardInput]
> = fc.property(intentCardInputArb, (card) => {
  const mixedSource = `/**
 * @example
 * fn("x") // => "x"
 * @example
 * fn takes a string and returns a string
 */
export function fn(x: string): string { return x; }`;
  const result = extractFromDocumentedUsage(card, mixedSource);
  if (result === undefined) return false;
  const decoder = new TextDecoder("utf-8");
  const content = decoder.decode(result.bytes);
  // Count it() calls using line-anchored pattern to avoid matching "it()" in comment text
  const itCount = (content.match(/^ {2}it\(/gm) ?? []).length;
  // Only the first (parseable) example produces an it() block
  return itCount === 1;
});
