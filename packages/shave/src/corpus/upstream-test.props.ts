// SPDX-License-Identifier: MIT
// @decision DEC-V2-PROPTEST-PATH-A-001: hand-authored property-test corpus for
// @yakcc/shave corpus/upstream-test.ts atoms. Two-file pattern: this file
// (.props.ts) is vitest-free and holds the corpus; the sibling .props.test.ts
// is the vitest harness.
// Status: accepted (WI-V2-07-PREFLIGHT L3i)
// Rationale: See tmp/wi-v2-07-preflight-layer-plan.md — the corpus file must
// be runtime-independent so L10 can hash it as a manifest artifact.
//
// Atoms covered (named exports from upstream-test.ts):
//   extractFromUpstreamTest (UT1.1–UT1.19) — adapts IntentCard spec into fast-check file.
//
// Properties covered (19 atoms):
//   1.  return.source === 'upstream-test'
//   2.  return.path === 'property-tests.fast-check.ts'
//   3.  return.bytes is Uint8Array that round-trips through UTF-8
//   4.  return.contentHash is 64-char hex
//   5.  determinism: same inputs → byte-identical output
//   6.  describe block uses inferred function name
//   7.  describe falls back to 'atom' when no function/const decl
//   8.  one it() per precondition + postcondition + 1 behavior
//   9.  empty preconditions/postconditions still emits behavior it()
//   10. precondition labels are JSON.stringify'd
//   11. postcondition labels are JSON.stringify'd
//   12. behavior label truncated to 80 chars
//   13. '// Inputs:' comment block appears iff inputs.length > 0
//   14. '// Outputs:' comment line appears iff outputs.length > 0
//   15. import header contains fast-check and vitest
//   16. DO NOT EDIT marker present
//   17. inferFunctionName: function decl wins over const
//   18. inferFunctionName: const fallback
//   19. inferFunctionName: undefined → 'atom' fallback

// ---------------------------------------------------------------------------
// Property-test corpus for corpus/upstream-test.ts
// ---------------------------------------------------------------------------

import { blake3 } from "@noble/hashes/blake3";
import { bytesToHex } from "@noble/hashes/utils";
import * as fc from "fast-check";
import type { IntentCardInput } from "./types.js";
import { extractFromUpstreamTest } from "./upstream-test.js";

// ---------------------------------------------------------------------------
// Shared arbitraries
// ---------------------------------------------------------------------------

/** Non-empty string with no leading/trailing whitespace. */
const nonEmptyStr: fc.Arbitrary<string> = fc
  .string({ minLength: 1, maxLength: 40 })
  .filter((s) => s.trim().length > 0);

/** Arbitrary 64-char hex string simulating a BLAKE3 contentHash. */
const hexHash64Arb: fc.Arbitrary<string> = fc
  .array(fc.integer({ min: 0, max: 15 }), { minLength: 64, maxLength: 64 })
  .map((nibbles) => nibbles.map((n) => n.toString(16)).join(""));

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
  sourceHash: hexHash64Arb,
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

// ---------------------------------------------------------------------------
// UT1.1: return.source === 'upstream-test'
// ---------------------------------------------------------------------------

/**
 * @summary extractFromUpstreamTest always returns source="upstream-test".
 */
export const prop_extractFromUpstreamTest_returnsUpstreamTestSource: fc.IPropertyWithHooks<
  [IntentCardInput, string]
> = fc.property(intentCardInputArb, fc.string(), (card, source) => {
  const result = extractFromUpstreamTest(card, source);
  return result.source === "upstream-test";
});

// ---------------------------------------------------------------------------
// UT1.2: return.path === canonical artifact path
// ---------------------------------------------------------------------------

/**
 * @summary extractFromUpstreamTest always returns path="property-tests.fast-check.ts".
 */
export const prop_extractFromUpstreamTest_returnsCanonicalArtifactPath: fc.IPropertyWithHooks<
  [IntentCardInput, string]
> = fc.property(intentCardInputArb, fc.string(), (card, source) => {
  const result = extractFromUpstreamTest(card, source);
  return result.path === "property-tests.fast-check.ts";
});

// ---------------------------------------------------------------------------
// UT1.3: bytes round-trip through UTF-8
// ---------------------------------------------------------------------------

/**
 * @summary extractFromUpstreamTest bytes round-trip through TextEncoder/TextDecoder.
 */
export const prop_extractFromUpstreamTest_bytesIsUtf8EncodedContent: fc.IPropertyWithHooks<
  [IntentCardInput, string]
> = fc.property(intentCardInputArb, fc.string(), (card, source) => {
  const result = extractFromUpstreamTest(card, source);
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
// UT1.4: contentHash is 64-char hex matching BLAKE3
// ---------------------------------------------------------------------------

/**
 * @summary extractFromUpstreamTest contentHash is 64-char hex and equals blake3(bytes).
 */
export const prop_extractFromUpstreamTest_contentHashIsBlake3HexOf64Chars: fc.IPropertyWithHooks<
  [IntentCardInput, string]
> = fc.property(intentCardInputArb, fc.string(), (card, source) => {
  const result = extractFromUpstreamTest(card, source);
  const expectedHash = bytesToHex(blake3(result.bytes));
  return /^[0-9a-f]{64}$/.test(result.contentHash) && result.contentHash === expectedHash;
});

// ---------------------------------------------------------------------------
// UT1.5: determinism — same inputs → byte-identical output
// ---------------------------------------------------------------------------

/**
 * @summary extractFromUpstreamTest is deterministic: identical inputs yield identical bytes.
 */
export const prop_extractFromUpstreamTest_determinismGivenSameInputs: fc.IPropertyWithHooks<
  [IntentCardInput, string]
> = fc.property(intentCardInputArb, fc.string(), (card, source) => {
  const r1 = extractFromUpstreamTest(card, source);
  const r2 = extractFromUpstreamTest(card, source);
  if (r1.bytes.length !== r2.bytes.length) return false;
  for (let i = 0; i < r1.bytes.length; i++) {
    if (r1.bytes[i] !== r2.bytes[i]) return false;
  }
  return r1.contentHash === r2.contentHash;
});

// ---------------------------------------------------------------------------
// UT1.6: describe block uses inferred function name
// ---------------------------------------------------------------------------

/**
 * @summary Generated content includes describe(...'<fnName> — property tests'...) when source has a function decl.
 */
export const prop_extractFromUpstreamTest_describeBlockUsesInferredFnName: fc.IPropertyWithHooks<
  [IntentCardInput, string]
> = fc.property(intentCardInputArb, sourceFnDeclArb, (card, source) => {
  const result = extractFromUpstreamTest(card, source);
  const decoder = new TextDecoder("utf-8");
  const content = decoder.decode(result.bytes);
  // Extract function name from source
  const m = source.match(/(?:^|\s)function\s+([a-zA-Z_$][a-zA-Z0-9_$]*)/);
  const fnName = m?.[1];
  if (!fnName) return false;
  return content.includes(`${fnName} — property tests`);
});

// ---------------------------------------------------------------------------
// UT1.7: describe falls back to 'atom' when no function/const decl
// ---------------------------------------------------------------------------

/**
 * @summary Generated content uses 'atom — property tests' when source has no function/const decl.
 */
export const prop_extractFromUpstreamTest_describeFallsBackToAtom: fc.IPropertyWithHooks<
  [IntentCardInput, string]
> = fc.property(intentCardInputArb, sourceNoDeclArb, (card, source) => {
  const result = extractFromUpstreamTest(card, source);
  const decoder = new TextDecoder("utf-8");
  const content = decoder.decode(result.bytes);
  return content.includes("atom — property tests");
});

// ---------------------------------------------------------------------------
// UT1.8: one it() per precondition + postcondition + 1 behavior
// ---------------------------------------------------------------------------

/**
 * @summary it() count equals preconditions.length + postconditions.length + 1.
 */
export const prop_extractFromUpstreamTest_oneItPerPrecondition: fc.IPropertyWithHooks<
  [IntentCardInput, string]
> = fc.property(intentCardInputArb, fc.string(), (card, source) => {
  const result = extractFromUpstreamTest(card, source);
  const decoder = new TextDecoder("utf-8");
  const content = decoder.decode(result.bytes);
  const itCount = (content.match(/\bit\(/g) ?? []).length;
  const expected = card.preconditions.length + card.postconditions.length + 1;
  return itCount === expected;
});

// ---------------------------------------------------------------------------
// UT1.9: empty preconditions/postconditions still emits behavior it()
// ---------------------------------------------------------------------------

/**
 * @summary With empty preconditions and postconditions, exactly one it() is emitted.
 */
export const prop_extractFromUpstreamTest_emptyPreconditionsStillEmitsBehavior: fc.IPropertyWithHooks<
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
  const result = extractFromUpstreamTest(card, source);
  const decoder = new TextDecoder("utf-8");
  const content = decoder.decode(result.bytes);
  const itCount = (content.match(/\bit\(/g) ?? []).length;
  return itCount === 1;
});

// ---------------------------------------------------------------------------
// UT1.10: precondition labels are JSON.stringify'd
// ---------------------------------------------------------------------------

/**
 * @summary Each precondition string is embedded via JSON.stringify in the it() label.
 */
export const prop_extractFromUpstreamTest_preconditionLabelsAreJsonStringified: fc.IPropertyWithHooks<
  [IntentCardInput, string]
> = fc.property(
  intentCardInputArb.filter((c) => c.preconditions.length > 0),
  fc.string(),
  (card, source) => {
    const result = extractFromUpstreamTest(card, source);
    const decoder = new TextDecoder("utf-8");
    const content = decoder.decode(result.bytes);
    return card.preconditions.every((pre, i) => {
      const label = JSON.stringify(`precondition ${i + 1}: ${pre}`);
      return content.includes(label);
    });
  },
);

// ---------------------------------------------------------------------------
// UT1.11: postcondition labels are JSON.stringify'd
// ---------------------------------------------------------------------------

/**
 * @summary Each postcondition string is embedded via JSON.stringify in the it() label.
 */
export const prop_extractFromUpstreamTest_postconditionLabelsAreJsonStringified: fc.IPropertyWithHooks<
  [IntentCardInput, string]
> = fc.property(
  intentCardInputArb.filter((c) => c.postconditions.length > 0),
  fc.string(),
  (card, source) => {
    const result = extractFromUpstreamTest(card, source);
    const decoder = new TextDecoder("utf-8");
    const content = decoder.decode(result.bytes);
    return card.postconditions.every((post, i) => {
      const label = JSON.stringify(`postcondition ${i + 1}: ${post}`);
      return content.includes(label);
    });
  },
);

// ---------------------------------------------------------------------------
// UT1.12: behavior label truncated to 80 chars
// ---------------------------------------------------------------------------

/**
 * @summary The behavior it() label uses intentCard.behavior.slice(0, 80).
 */
export const prop_extractFromUpstreamTest_behaviorLabelTruncatedTo80: fc.IPropertyWithHooks<
  [IntentCardInput, string]
> = fc.property(
  // Narrow behavior to strings where JSON.stringify does not introduce escape
  // sequences. This ensures behavior.slice(0,80) appears verbatim inside the
  // it() label in the generated content. (Issue #162: behavior='"' caused
  // JSON.stringify expansion so the raw truncated string was not present.)
  intentCardInputArb.filter((c) => JSON.stringify(c.behavior) === `"${c.behavior}"`),
  fc.string(),
  (card, source) => {
    const result = extractFromUpstreamTest(card, source);
    const decoder = new TextDecoder("utf-8");
    const content = decoder.decode(result.bytes);
    const truncated = card.behavior.slice(0, 80);
    return content.includes(`behavior: ${truncated}`);
  },
);

// ---------------------------------------------------------------------------
// UT1.13: '// Inputs:' block appears iff inputs.length > 0
// ---------------------------------------------------------------------------

/**
 * @summary '// Inputs:' comment block appears iff intentCard.inputs.length > 0.
 */
export const prop_extractFromUpstreamTest_inputCommentsRenderedWhenInputsPresent: fc.IPropertyWithHooks<
  [IntentCardInput, string]
> = fc.property(intentCardInputArb, fc.string(), (card, source) => {
  const result = extractFromUpstreamTest(card, source);
  const decoder = new TextDecoder("utf-8");
  const content = decoder.decode(result.bytes);
  const hasInputsComment = content.includes("// Inputs:");
  return card.inputs.length > 0 ? hasInputsComment : !hasInputsComment;
});

// ---------------------------------------------------------------------------
// UT1.14: '// Outputs:' line appears iff outputs.length > 0
// ---------------------------------------------------------------------------

/**
 * @summary '// Outputs:' comment appears iff intentCard.outputs.length > 0.
 */
export const prop_extractFromUpstreamTest_outputCommentsRenderedWhenOutputsPresent: fc.IPropertyWithHooks<
  [IntentCardInput, string]
> = fc.property(intentCardInputArb, fc.string(), (card, source) => {
  const result = extractFromUpstreamTest(card, source);
  const decoder = new TextDecoder("utf-8");
  const content = decoder.decode(result.bytes);
  const hasOutputsComment = content.includes("// Outputs:");
  return card.outputs.length > 0 ? hasOutputsComment : !hasOutputsComment;
});

// ---------------------------------------------------------------------------
// UT1.15: import header contains fast-check and vitest
// ---------------------------------------------------------------------------

/**
 * @summary Generated content starts with canonical fast-check + vitest import block.
 */
export const prop_extractFromUpstreamTest_importsFastCheckAndVitest: fc.IPropertyWithHooks<
  [IntentCardInput, string]
> = fc.property(intentCardInputArb, fc.string(), (card, source) => {
  const result = extractFromUpstreamTest(card, source);
  const decoder = new TextDecoder("utf-8");
  const content = decoder.decode(result.bytes);
  return (
    content.includes('import * as fc from "fast-check"') &&
    content.includes('import { describe, it } from "vitest"')
  );
});

// ---------------------------------------------------------------------------
// UT1.16: DO NOT EDIT marker present
// ---------------------------------------------------------------------------

/**
 * @summary Generated content includes 'DO NOT EDIT' string.
 */
export const prop_extractFromUpstreamTest_doNotEditMarkerPresent: fc.IPropertyWithHooks<
  [IntentCardInput, string]
> = fc.property(intentCardInputArb, fc.string(), (card, source) => {
  const result = extractFromUpstreamTest(card, source);
  const decoder = new TextDecoder("utf-8");
  const content = decoder.decode(result.bytes);
  return content.includes("DO NOT EDIT");
});

// ---------------------------------------------------------------------------
// UT1.17: inferFunctionName — function declaration wins over const
// ---------------------------------------------------------------------------

/**
 * @summary When source has both 'function foo' and 'const bar =', function name is foo.
 */
export const prop_extractFromUpstreamTest_inferFunctionName_functionDeclWins: fc.IPropertyWithHooks<
  [IntentCardInput, string, string]
> = fc.property(
  intentCardInputArb,
  fc.string({ minLength: 1, maxLength: 20 }).filter((s) => /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(s)),
  fc.string({ minLength: 1, maxLength: 20 }).filter((s) => /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(s)),
  (card, fnName, constName) => {
    // function decl appears first
    const source = `function ${fnName}() {}\nconst ${constName} = () => {};`;
    const result = extractFromUpstreamTest(card, source);
    const decoder = new TextDecoder("utf-8");
    const content = decoder.decode(result.bytes);
    return content.includes(`${fnName} — property tests`);
  },
);

// ---------------------------------------------------------------------------
// UT1.18: inferFunctionName — const fallback
// ---------------------------------------------------------------------------

/**
 * @summary When source has only 'const bar =', function name is bar.
 */
export const prop_extractFromUpstreamTest_inferFunctionName_constMatchFallback: fc.IPropertyWithHooks<
  [IntentCardInput, string]
> = fc.property(
  intentCardInputArb,
  fc.string({ minLength: 1, maxLength: 20 }).filter((s) => /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(s)),
  (card, constName) => {
    const source = `const ${constName} = (x: string) => x;`;
    const result = extractFromUpstreamTest(card, source);
    const decoder = new TextDecoder("utf-8");
    const content = decoder.decode(result.bytes);
    return content.includes(`${constName} — property tests`);
  },
);

// ---------------------------------------------------------------------------
// UT1.19: inferFunctionName — undefined falls back to 'atom'
// ---------------------------------------------------------------------------

/**
 * @summary When source has neither function nor const decl, describe uses 'atom'.
 */
export const prop_extractFromUpstreamTest_inferFunctionName_undefinedFallsBackToAtom: fc.IPropertyWithHooks<
  [IntentCardInput, string]
> = fc.property(intentCardInputArb, sourceNoDeclArb, (card, source) => {
  const result = extractFromUpstreamTest(card, source);
  const decoder = new TextDecoder("utf-8");
  const content = decoder.decode(result.bytes);
  return content.includes("atom — property tests");
});
