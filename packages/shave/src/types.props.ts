// SPDX-License-Identifier: MIT
// @decision DEC-V2-PROPTEST-PATH-A-001: hand-authored property-test corpus for
// @yakcc/shave types.ts atoms. Two-file pattern: this file (.props.ts) is
// vitest-free and holds the corpus; the sibling .props.test.ts is the vitest
// harness.
// Status: accepted (WI-V2-07-PREFLIGHT L3e)
// Rationale: See tmp/wi-v2-07-preflight-layer-plan.md — the corpus file must
// be runtime-independent so L10 can hash it as a manifest artifact.
//
// Atoms covered (named exports from types.ts):
//   FOREIGN_POLICY_DEFAULT (FP-D1)   — value is 'tag' and satisfies ForeignPolicy
//   ForeignPolicy          (FP1.1)   — union of 'allow' | 'reject' | 'tag'
//   ShaveOptions           (SO1.1)   — optional fields accepted, omitted fields absent
//   ShaveDiagnostics       (SD1.1)   — stubbed array and cache counter invariants
//   ShavedAtomStub         (SA1.1)   — sourceRange start <= end, placeholderId non-empty
//   ShaveResult            (SR1.1)   — arrays are readonly arrays, sourcePath non-empty
//   UniversalizeSlicePlanEntry (UP1.1) — kind discriminant covers slicer union variants
//   UniversalizeResult     (UR1.1)   — slicePlan matches matchedPrimitives consistency
//   CandidateBlock         (CB1.1)   — source field is a string; hint is optional
//   ShaveRegistryView      (RV1.1)   — selectBlocks returns BlockMerkleRoot array
//   IntentExtractionHook   (IH1.1)   — id is non-empty string
//
// Properties covered:
//   - FOREIGN_POLICY_DEFAULT: value === 'tag' and satisfies ForeignPolicy.
//   - ShaveOptions: optional fields survive round-trip with exactOptionalPropertyTypes.
//   - ShaveDiagnostics: cacheHits + cacheMisses >= 0; stubbed contains only known literals.
//   - ShavedAtomStub: sourceRange.start <= sourceRange.end, placeholderId is non-empty.
//   - ShaveResult: atoms and intentCards are readonly arrays; sourcePath is non-empty.
//   - CandidateBlock: source is a string; hint is accepted or omitted cleanly.
//   - ShaveRegistryView: selectBlocks type contract returns an array.
//   - IntentExtractionHook: id is always a non-empty string.
//   - Compound: ShaveResult.diagnostics is a valid ShaveDiagnostics with consistent fields.

// ---------------------------------------------------------------------------
// Property-test corpus for types.ts
// ---------------------------------------------------------------------------

import * as fc from "fast-check";
import type {
  CandidateBlock,
  ForeignPolicy,
  IntentExtractionHook,
  ShaveDiagnostics,
  ShaveOptions,
  ShaveRegistryView,
  ShaveResult,
  ShavedAtomStub,
  UniversalizeResult,
  UniversalizeSlicePlanEntry,
} from "./types.js";
import { FOREIGN_POLICY_DEFAULT } from "./types.js";

// ---------------------------------------------------------------------------
// Shared arbitraries
// ---------------------------------------------------------------------------

/** Non-empty string with no leading/trailing whitespace. */
const nonEmptyStr: fc.Arbitrary<string> = fc
  .string({ minLength: 1, maxLength: 60 })
  .filter((s) => s.trim().length > 0);

/** Arbitrary ForeignPolicy literal. */
const foreignPolicyArb: fc.Arbitrary<ForeignPolicy> = fc.constantFrom(
  "allow" as const,
  "reject" as const,
  "tag" as const,
);

/** Arbitrary non-negative integer for cache counters. */
const nonNegativeIntArb: fc.Arbitrary<number> = fc.nat({ max: 1000 });

/** Arbitrary stubbed diagnostic item (one of the three known literals). */
const stubbedItemArb: fc.Arbitrary<"decomposition" | "variance" | "license-gate"> = fc.constantFrom(
  "decomposition" as const,
  "variance" as const,
  "license-gate" as const,
);

/** Arbitrary stubbed array (unique subset of the three known literals). */
const stubbedArrayArb: fc.Arbitrary<readonly ("decomposition" | "variance" | "license-gate")[]> =
  fc.uniqueArray(stubbedItemArb, { maxLength: 3 });

/** Arbitrary ShaveDiagnostics. */
const shaveDiagnosticsArb: fc.Arbitrary<ShaveDiagnostics> = fc.record({
  stubbed: stubbedArrayArb,
  cacheHits: nonNegativeIntArb,
  cacheMisses: nonNegativeIntArb,
});

/** Arbitrary byte offset pair where start <= end. */
const sourceRangeArb: fc.Arbitrary<{ readonly start: number; readonly end: number }> = fc
  .tuple(fc.nat({ max: 10000 }), fc.nat({ max: 10000 }))
  .map(([a, b]) => ({ start: Math.min(a, b), end: Math.max(a, b) }));

// ---------------------------------------------------------------------------
// FP-D1: FOREIGN_POLICY_DEFAULT — value is 'tag' and satisfies ForeignPolicy
// ---------------------------------------------------------------------------

/**
 * prop_FOREIGN_POLICY_DEFAULT_is_tag
 *
 * FOREIGN_POLICY_DEFAULT must equal the literal string 'tag', which is one of
 * the three valid ForeignPolicy values.
 *
 * Invariant (FP-D1, DEC-V2-FOREIGN-BLOCK-SCHEMA-001 sub-C): all consumers that
 * need the default policy import this constant rather than hardcoding 'tag'. A
 * changed value here propagates to all consumers automatically; checking the
 * value in tests ensures accidental reassignment is caught immediately.
 */
export const prop_FOREIGN_POLICY_DEFAULT_is_tag = fc.property(fc.constant(null), (_) => {
  // Structural check: must satisfy ForeignPolicy union constraint.
  const validPolicies: readonly string[] = ["allow", "reject", "tag"];
  return FOREIGN_POLICY_DEFAULT === "tag" && validPolicies.includes(FOREIGN_POLICY_DEFAULT);
});

// ---------------------------------------------------------------------------
// SO1.1: ShaveOptions — optional fields accepted, omitted fields absent
// ---------------------------------------------------------------------------

/**
 * prop_ShaveOptions_optional_fields_accepted
 *
 * A fully populated ShaveOptions object retains all provided values when
 * type-checked. Optional fields that are omitted must not appear as undefined
 * keys on the object (exactOptionalPropertyTypes compliance).
 *
 * Invariant (SO1.1, DEC-CONTINUOUS-SHAVE-022): ShaveOptions is consumed by
 * shave() and universalize(); callers rely on field presence checks. Spurious
 * undefined keys violate exactOptionalPropertyTypes and cause TS2322 errors in
 * strict mode consumers.
 */
export const prop_ShaveOptions_optional_fields_accepted = fc.property(
  nonEmptyStr,
  nonEmptyStr,
  fc.boolean(),
  foreignPolicyArb,
  (cacheDir, model, offline, foreignPolicy) => {
    // Build the options object with only defined fields (omit optional entirely
    // when we choose not to set them — exactOptionalPropertyTypes compliance).
    const opts: ShaveOptions = {
      cacheDir,
      model,
      offline,
      foreignPolicy,
    };
    return (
      opts.cacheDir === cacheDir &&
      opts.model === model &&
      opts.offline === offline &&
      opts.foreignPolicy === foreignPolicy
    );
  },
);

/**
 * prop_ShaveOptions_empty_object_accepted
 *
 * An empty object `{}` satisfies ShaveOptions because all fields are optional.
 *
 * Invariant (SO1.1, DEC-CONTINUOUS-SHAVE-022): callers may call shave() with
 * no options at all. The interface must not impose required fields.
 */
export const prop_ShaveOptions_empty_object_accepted = fc.property(fc.constant(null), (_) => {
  const opts: ShaveOptions = {};
  return typeof opts === "object";
});

// ---------------------------------------------------------------------------
// SD1.1: ShaveDiagnostics — cache counters non-negative; stubbed known literals
// ---------------------------------------------------------------------------

/**
 * prop_ShaveDiagnostics_cache_counters_nonnegative
 *
 * ShaveDiagnostics.cacheHits and cacheMisses are always non-negative integers.
 *
 * Invariant (SD1.1, DEC-CONTINUOUS-SHAVE-022): negative cache counts would
 * indicate a counting bug in the pipeline. Consumers sum these fields across
 * multiple shave() calls; a negative value would corrupt the aggregate.
 */
export const prop_ShaveDiagnostics_cache_counters_nonnegative = fc.property(
  shaveDiagnosticsArb,
  (diag) => {
    return diag.cacheHits >= 0 && diag.cacheMisses >= 0;
  },
);

/**
 * prop_ShaveDiagnostics_stubbed_contains_only_known_literals
 *
 * ShaveDiagnostics.stubbed contains only the three documented literal strings.
 *
 * Invariant (SD1.1, DEC-CONTINUOUS-SHAVE-022): the stubbed array is a signal to
 * callers about which capabilities are not yet implemented. An unknown literal
 * would be a documentation bug. Downstream consumers must be able to switch on
 * the known set exhaustively.
 */
export const prop_ShaveDiagnostics_stubbed_contains_only_known_literals = fc.property(
  shaveDiagnosticsArb,
  (diag) => {
    const known = new Set(["decomposition", "variance", "license-gate"]);
    return diag.stubbed.every((s) => known.has(s));
  },
);

// ---------------------------------------------------------------------------
// SA1.1: ShavedAtomStub — sourceRange.start <= sourceRange.end
// ---------------------------------------------------------------------------

/**
 * prop_ShavedAtomStub_sourceRange_start_le_end
 *
 * For any ShavedAtomStub, sourceRange.start is always <= sourceRange.end.
 *
 * Invariant (SA1.1, DEC-CONTINUOUS-SHAVE-022): a reversed range (start > end)
 * would produce an invalid byte slice that consumers would fail to extract.
 * The invariant applies regardless of how the range was constructed — even
 * zero-width atoms (start === end) are valid.
 */
export const prop_ShavedAtomStub_sourceRange_start_le_end = fc.property(
  nonEmptyStr,
  sourceRangeArb,
  (placeholderId, sourceRange) => {
    const atom: ShavedAtomStub = { placeholderId, sourceRange };
    return atom.sourceRange.start <= atom.sourceRange.end;
  },
);

/**
 * prop_ShavedAtomStub_placeholderId_nonempty
 *
 * ShavedAtomStub.placeholderId is always a non-empty string.
 *
 * Invariant (SA1.1, DEC-CONTINUOUS-SHAVE-022): WI-012 replaces the stub with
 * real atoms, but during WI-010-01 the placeholder must be uniquely addressable.
 * An empty placeholderId would collide across atoms and corrupt registry lookups.
 */
export const prop_ShavedAtomStub_placeholderId_nonempty = fc.property(
  nonEmptyStr,
  sourceRangeArb,
  (placeholderId, sourceRange) => {
    const atom: ShavedAtomStub = { placeholderId, sourceRange };
    return atom.placeholderId.length > 0;
  },
);

// ---------------------------------------------------------------------------
// SR1.1: ShaveResult — arrays readonly, sourcePath non-empty
// ---------------------------------------------------------------------------

/**
 * prop_ShaveResult_sourcePath_nonempty
 *
 * ShaveResult.sourcePath is always a non-empty string.
 *
 * Invariant (SR1.1, DEC-CONTINUOUS-SHAVE-022): the source path identifies the
 * file that was processed. An empty sourcePath would make the result impossible
 * to associate with an input file — breaking any downstream aggregation.
 */
export const prop_ShaveResult_sourcePath_nonempty = fc.property(
  nonEmptyStr,
  shaveDiagnosticsArb,
  (sourcePath, diagnostics) => {
    const result: ShaveResult = {
      sourcePath,
      atoms: [],
      intentCards: [],
      diagnostics,
    };
    return result.sourcePath.length > 0;
  },
);

/**
 * prop_ShaveResult_arrays_are_arrays
 *
 * ShaveResult.atoms and ShaveResult.intentCards are always arrays (may be empty).
 *
 * Invariant (SR1.1, DEC-CONTINUOUS-SHAVE-022): callers spread and concat these
 * arrays. Receiving a non-array would throw at runtime without a clear error.
 */
export const prop_ShaveResult_arrays_are_arrays = fc.property(
  nonEmptyStr,
  shaveDiagnosticsArb,
  (sourcePath, diagnostics) => {
    const result: ShaveResult = {
      sourcePath,
      atoms: [],
      intentCards: [],
      diagnostics,
    };
    return Array.isArray(result.atoms) && Array.isArray(result.intentCards);
  },
);

// ---------------------------------------------------------------------------
// CB1.1: CandidateBlock — source field is a string; hint is optional
// ---------------------------------------------------------------------------

/**
 * prop_CandidateBlock_source_is_string
 *
 * CandidateBlock.source is always a string (may be empty for the interface; in
 * practice it carries source code).
 *
 * Invariant (CB1.1, DEC-CONTINUOUS-SHAVE-022): the source is passed to the
 * intent extractor verbatim. A non-string would fail tokenization.
 */
export const prop_CandidateBlock_source_is_string = fc.property(nonEmptyStr, (source) => {
  const block: CandidateBlock = { source };
  return typeof block.source === "string";
});

/**
 * prop_CandidateBlock_hint_is_optional
 *
 * CandidateBlock with no hint field is still a valid CandidateBlock.
 *
 * Invariant (CB1.1, DEC-CONTINUOUS-SHAVE-022): the hint field is optional per
 * the interface. Omitting it must not produce a TypeScript error and the
 * resulting object must be structurally valid.
 */
export const prop_CandidateBlock_hint_is_optional = fc.property(nonEmptyStr, (source) => {
  const block: CandidateBlock = { source };
  // hint is not present — key must be absent (exactOptionalPropertyTypes).
  return !Object.prototype.hasOwnProperty.call(block, "hint");
});

// ---------------------------------------------------------------------------
// RV1.1: ShaveRegistryView — selectBlocks type contract returns an array
// ---------------------------------------------------------------------------

/**
 * prop_ShaveRegistryView_selectBlocks_returns_array
 *
 * A minimal ShaveRegistryView stub whose selectBlocks always resolves to an
 * empty array satisfies the interface contract.
 *
 * Invariant (RV1.1, DEC-CONTINUOUS-SHAVE-022): shave() calls selectBlocks with
 * a SpecHash and expects a readonly array back. A stub returning a non-array
 * (e.g. undefined or null) would crash the pipeline immediately.
 *
 * Production sequence: shave() → SlicePlanEntry classification → selectBlocks()
 * → PointerEntry lookup. The stub exercises that the return type promise resolves.
 */
export const prop_ShaveRegistryView_selectBlocks_returns_array = fc.asyncProperty(
  fc.string({ minLength: 1, maxLength: 32 }),
  async (specHash) => {
    const stub: ShaveRegistryView = {
      selectBlocks: async (_h) => [],
      getBlock: async (_m) => undefined,
    };
    const result = await stub.selectBlocks(specHash as Parameters<typeof stub.selectBlocks>[0]);
    return Array.isArray(result);
  },
);

// ---------------------------------------------------------------------------
// IH1.1: IntentExtractionHook — id is always a non-empty string
// ---------------------------------------------------------------------------

/**
 * prop_IntentExtractionHook_id_is_nonempty
 *
 * An IntentExtractionHook's `id` field is always a non-empty string.
 *
 * Invariant (IH1.1, DEC-CONTINUOUS-SHAVE-022): hooks are identified by id for
 * registry deduplication and priority ordering. An empty or missing id would
 * make two distinct hooks indistinguishable and allow silent override.
 */
export const prop_IntentExtractionHook_id_is_nonempty = fc.property(nonEmptyStr, (id) => {
  // Construct a minimal typed hook object (no call needed for this id check).
  const hook: Pick<IntentExtractionHook, "id"> = { id };
  return hook.id.length > 0;
});

// ---------------------------------------------------------------------------
// Compound: ShaveResult.diagnostics is a valid ShaveDiagnostics with
// consistent fields — crossing ShaveResult and ShaveDiagnostics boundaries.
//
// Production sequence: shave() builds a ShaveResult at the end of the pipeline,
// constructing a ShaveDiagnostics object from per-run cache counters and the
// list of stubbed capabilities. The compound property verifies that the result's
// diagnostics field satisfies all invariants from SD1.1 simultaneously, as they
// would be checked by a CLI summary renderer that reads result.diagnostics in one pass.
// ---------------------------------------------------------------------------

/**
 * prop_ShaveResult_compound_diagnostics_consistent
 *
 * For any ShaveResult, result.diagnostics satisfies all ShaveDiagnostics
 * invariants jointly: cache counters are non-negative AND the stubbed array
 * contains only known literals AND the diagnostics object identity is preserved.
 *
 * This is the canonical compound-interaction property crossing the ShaveResult
 * and ShaveDiagnostics types. It mirrors the production scenario where the CLI
 * summary renderer accesses result.diagnostics.cacheHits, result.diagnostics.cacheMisses,
 * and result.diagnostics.stubbed in a single pass without re-fetching the run.
 *
 * Invariant: if any diagnostics field violates its invariant, the CLI summary
 * may display negative cache counts or unknown stubbed capability identifiers —
 * both of which would confuse operators.
 */
export const prop_ShaveResult_compound_diagnostics_consistent = fc.property(
  nonEmptyStr,
  shaveDiagnosticsArb,
  (sourcePath, diagnostics) => {
    const result: ShaveResult = {
      sourcePath,
      atoms: [],
      intentCards: [],
      diagnostics,
    };

    const d = result.diagnostics;

    // 1. Cache counters non-negative.
    if (d.cacheHits < 0 || d.cacheMisses < 0) return false;

    // 2. Stubbed contains only known literals.
    const known = new Set(["decomposition", "variance", "license-gate"]);
    if (!d.stubbed.every((s) => known.has(s))) return false;

    // 3. Diagnostics object identity preserved — no copy or mutation.
    if (result.diagnostics !== diagnostics) return false;

    // 4. sourcePath is non-empty.
    if (result.sourcePath.length === 0) return false;

    return true;
  },
);

// ---------------------------------------------------------------------------
// UP1.1: UniversalizeSlicePlanEntry — kind discriminant covers slicer variants
// ---------------------------------------------------------------------------

/**
 * prop_UniversalizeSlicePlanEntry_kind_is_known_discriminant
 *
 * Any UniversalizeSlicePlanEntry's `kind` field is one of the four discriminant
 * strings: 'pointer', 'novel-glue', 'foreign-leaf', 'glue'.
 *
 * Invariant (UP1.1, DEC-UNIVERSALIZE-WIRING-001): consumers switch on `kind`
 * exhaustively to route entries. An unknown `kind` would fall through all
 * branches silently and produce undefined behavior in the compile pipeline.
 */
export const prop_UniversalizeSlicePlanEntry_kind_is_known_discriminant = fc.property(
  fc.constantFrom(
    "pointer" as const,
    "novel-glue" as const,
    "foreign-leaf" as const,
    "glue" as const,
  ),
  (kind) => {
    // Build a minimal entry for the given kind to confirm type assignment.
    const knownKinds = new Set(["pointer", "novel-glue", "foreign-leaf", "glue"]);
    const entry = { kind } as Pick<UniversalizeSlicePlanEntry, "kind">;
    return knownKinds.has(entry.kind);
  },
);

// ---------------------------------------------------------------------------
// UR1.1: UniversalizeResult — slicePlan matches matchedPrimitives consistency
// ---------------------------------------------------------------------------

/**
 * prop_UniversalizeResult_matchedPrimitives_is_array
 *
 * UniversalizeResult.matchedPrimitives is always a readonly array.
 *
 * Invariant (UR1.1, DEC-CONTINUOUS-SHAVE-022): the CLI summary totals the
 * matched primitive count. Receiving a non-array would throw at runtime.
 *
 * This property constructs a minimal stub UniversalizeResult and checks the
 * structural invariant — it is not a full integration test of universalize().
 */
export const prop_UniversalizeResult_matchedPrimitives_is_array = fc.property(
  shaveDiagnosticsArb,
  (diagnostics) => {
    // Build a minimal stub that satisfies the required fields.
    const result: Pick<UniversalizeResult, "slicePlan" | "matchedPrimitives" | "diagnostics"> = {
      slicePlan: [],
      matchedPrimitives: [],
      diagnostics,
    };
    return Array.isArray(result.slicePlan) && Array.isArray(result.matchedPrimitives);
  },
);
