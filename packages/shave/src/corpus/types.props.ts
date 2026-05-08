// SPDX-License-Identifier: MIT
// @decision DEC-V2-PROPTEST-PATH-A-001: hand-authored property-test corpus for
// @yakcc/shave corpus/types.ts atoms. Two-file pattern: this file
// (.props.ts) is vitest-free and holds the corpus; the sibling .props.test.ts
// is the vitest harness.
// Status: accepted (WI-V2-07-PREFLIGHT L3i)
// Rationale: See tmp/wi-v2-07-preflight-layer-plan.md — the corpus file must
// be runtime-independent so L10 can hash it as a manifest artifact.
//
// Atoms covered (type-level declarations from types.ts):
//   CorpusSource        (T1.1) — literal union type shape.
//   CorpusResult        (T1.2) — readonly interface field presence + type shapes.
//   CorpusAtomSpec      (T1.3) — optional fields omitted rather than undefined.
//   IntentCardInput     (T1.4) — readonly array field type shape.
//   CorpusExtractionOptions (T1.5) — all-optional boolean flags.
//
// Properties covered:
//   - CorpusSource accepts exactly the four allowed literal strings.
//   - CorpusResult has all four fields present with correct type-shapes.
//   - CorpusAtomSpec optional cacheDir/propsFilePath fields are omittable.
//   - IntentCardInput readonly array fields satisfy runtime structural check.
//   - CorpusExtractionOptions all fields are optional booleans.

// ---------------------------------------------------------------------------
// Property-test corpus for corpus/types.ts
// ---------------------------------------------------------------------------

import * as fc from "fast-check";
import type {
  CorpusAtomSpec,
  CorpusExtractionOptions,
  CorpusResult,
  CorpusSource,
  IntentCardInput,
} from "./types.js";

// ---------------------------------------------------------------------------
// Shared arbitraries
// ---------------------------------------------------------------------------

/** Non-empty string with no leading/trailing whitespace. */
const nonEmptyStr: fc.Arbitrary<string> = fc
  .string({ minLength: 1, maxLength: 40 })
  .filter((s) => s.trim().length > 0);

/** Arbitrary CorpusSource — the four allowed literals. */
const corpusSourceArb: fc.Arbitrary<CorpusSource> = fc.constantFrom(
  "props-file" as const,
  "upstream-test" as const,
  "documented-usage" as const,
  "ai-derived" as const,
);

/** Arbitrary 64-char hex string simulating a BLAKE3 contentHash. */
const hexHash64Arb: fc.Arbitrary<string> = fc
  .array(fc.integer({ min: 0, max: 15 }), { minLength: 64, maxLength: 64 })
  .map((nibbles) => nibbles.map((n) => n.toString(16)).join(""));

/** Arbitrary Uint8Array for bytes fields. */
const uint8Arb: fc.Arbitrary<Uint8Array> = fc.uint8Array({ minLength: 1, maxLength: 64 });

/** Arbitrary IntentCardInput. */
const intentCardInputArb: fc.Arbitrary<IntentCardInput> = fc.record({
  behavior: nonEmptyStr,
  inputs: fc.array(
    fc.record({
      name: nonEmptyStr,
      typeHint: nonEmptyStr,
      description: fc.string({ minLength: 0, maxLength: 40 }),
    }),
    { minLength: 0, maxLength: 2 },
  ),
  outputs: fc.array(
    fc.record({
      name: nonEmptyStr,
      typeHint: nonEmptyStr,
      description: fc.string({ minLength: 0, maxLength: 40 }),
    }),
    { minLength: 0, maxLength: 2 },
  ),
  preconditions: fc.array(nonEmptyStr, { minLength: 0, maxLength: 2 }),
  postconditions: fc.array(nonEmptyStr, { minLength: 0, maxLength: 2 }),
  notes: fc.array(fc.string(), { minLength: 0, maxLength: 2 }),
  sourceHash: hexHash64Arb,
  modelVersion: nonEmptyStr,
  promptVersion: nonEmptyStr,
});

// ---------------------------------------------------------------------------
// T1.1: CorpusSource — literal union shape
// ---------------------------------------------------------------------------

/**
 * @summary CorpusSource accepts exactly the four allowed literal string values.
 *
 * Asserts that fc.constantFrom over the four literals compiles and assigns to
 * CorpusSource without type errors (structural assignment check at runtime).
 */
export const prop_types_corpusSource_literalUnionShape: fc.IPropertyWithHooks<[CorpusSource]> =
  fc.property(corpusSourceArb, (source) => {
    // Compile-time: CorpusSource is a literal union type.
    // Runtime: structural assignment to const satisfies the union.
    const value: CorpusSource = source;
    return (
      value === "props-file" ||
      value === "upstream-test" ||
      value === "documented-usage" ||
      value === "ai-derived"
    );
  });

// ---------------------------------------------------------------------------
// T1.2: CorpusResult — readonly field presence + type shapes
// ---------------------------------------------------------------------------

/**
 * @summary CorpusResult has all four required fields with correct type shapes.
 *
 * Builds a CorpusResult via fc.record and asserts field presence and types.
 */
export const prop_types_corpusResult_readonlyFieldsPresent: fc.IPropertyWithHooks<[CorpusResult]> =
  fc.property(
    fc.record<CorpusResult>({
      source: corpusSourceArb,
      bytes: uint8Arb,
      path: nonEmptyStr,
      contentHash: hexHash64Arb,
    }),
    (result) => {
      return (
        typeof result.source === "string" &&
        result.bytes instanceof Uint8Array &&
        typeof result.path === "string" &&
        result.path.length > 0 &&
        typeof result.contentHash === "string" &&
        /^[0-9a-f]{64}$/.test(result.contentHash)
      );
    },
  );

// ---------------------------------------------------------------------------
// T1.3: CorpusAtomSpec — optional fields omitted rather than undefined
// ---------------------------------------------------------------------------

/**
 * @summary CorpusAtomSpec optional cacheDir/propsFilePath may be omitted entirely.
 *
 * Under exactOptionalPropertyTypes, fields should be omitted rather than set
 * to undefined. Asserts structural equality before and after assignment.
 */
export const prop_types_corpusAtomSpec_optionalCacheDirOmittedNotUndefined: fc.IPropertyWithHooks<
  [string, IntentCardInput]
> = fc.property(nonEmptyStr, intentCardInputArb, (source, intentCard) => {
  // Omit optional fields — do not assign undefined
  const specWithout: CorpusAtomSpec = { source, intentCard };
  const specWithCache: CorpusAtomSpec = { source, intentCard, cacheDir: "/tmp/test" };
  const specWithProps: CorpusAtomSpec = {
    source,
    intentCard,
    propsFilePath: "/tmp/test.props.ts",
  };

  // All three variants are structurally valid CorpusAtomSpec objects
  return (
    specWithout.source === source &&
    specWithCache.cacheDir === "/tmp/test" &&
    specWithProps.propsFilePath === "/tmp/test.props.ts" &&
    !("cacheDir" in specWithout) &&
    !("propsFilePath" in specWithout)
  );
});

// ---------------------------------------------------------------------------
// T1.4: IntentCardInput — readonly array fields satisfy structural check
// ---------------------------------------------------------------------------

/**
 * @summary IntentCardInput readonly array fields are arrays at runtime.
 *
 * Builds IntentCardInput via fc.record and asserts that all array fields
 * remain arrays after shallow freezing (immutable structural assertion).
 */
export const prop_types_intentCardInput_arrayFieldsAreReadonlyArrays: fc.IPropertyWithHooks<
  [IntentCardInput]
> = fc.property(intentCardInputArb, (card) => {
  // Shallow freeze to simulate readonly enforcement
  const frozen = Object.freeze({ ...card });
  return (
    Array.isArray(frozen.inputs) &&
    Array.isArray(frozen.outputs) &&
    Array.isArray(frozen.preconditions) &&
    Array.isArray(frozen.postconditions) &&
    Array.isArray(frozen.notes)
  );
});

// ---------------------------------------------------------------------------
// T1.5: CorpusExtractionOptions — all fields optional booleans
// ---------------------------------------------------------------------------

/**
 * @summary CorpusExtractionOptions allows arbitrary subsets of the four boolean flags.
 *
 * Builds option objects with arbitrary subsets of fields omitted, asserts each
 * present field is a boolean or absent.
 */
export const prop_types_corpusExtractionOptions_allFieldsOptionalBoolean: fc.IPropertyWithHooks<
  [boolean, boolean, boolean, boolean]
> = fc.property(
  fc.boolean(),
  fc.boolean(),
  fc.boolean(),
  fc.boolean(),
  (enablePropsFile, enableUpstreamTest, enableDocumentedUsage, enableAiDerived) => {
    // Build options with all four flags
    const opts: CorpusExtractionOptions = {
      enablePropsFile,
      enableUpstreamTest,
      enableDocumentedUsage,
      enableAiDerived,
    };
    // Empty options (all omitted) is also valid
    const emptyOpts: CorpusExtractionOptions = {};

    return (
      typeof opts.enablePropsFile === "boolean" &&
      typeof opts.enableUpstreamTest === "boolean" &&
      typeof opts.enableDocumentedUsage === "boolean" &&
      typeof opts.enableAiDerived === "boolean" &&
      emptyOpts.enablePropsFile === undefined &&
      emptyOpts.enableUpstreamTest === undefined
    );
  },
);
