// SPDX-License-Identifier: MIT
// @decision DEC-V2-PROPTEST-PATH-A-001: hand-authored property-test corpus for
// @yakcc/shave errors.ts atoms. Two-file pattern: this file (.props.ts) is
// vitest-free and holds the corpus; the sibling .props.test.ts is the vitest
// harness.
// Status: accepted (WI-V2-07-PREFLIGHT L3e)
// Rationale: See tmp/wi-v2-07-preflight-layer-plan.md — the corpus file must
// be runtime-independent so L10 can hash it as a manifest artifact.
//
// Atoms covered (named exports from errors.ts):
//   AnthropicApiKeyMissingError (AK1.1) — message, name, instanceof invariants.
//   OfflineCacheMissError       (OC1.1) — message contains cacheKey, name, instanceof.
//   IntentCardSchemaError       (IS1.1) — message contains detail, name, instanceof.
//   LicenseRefusedError         (LR1.1) — message contains reason, detection stored, name, instanceof.
//   ForeignPolicyRejectError    (FP1.1) — message contains pkg#export pairs, foreignRefs array, name, instanceof.
//
// Properties covered:
//   - AnthropicApiKeyMissingError: message includes key guidance text; name is correct class name.
//   - OfflineCacheMissError: message always contains the cacheKey string; name is correct class name.
//   - IntentCardSchemaError: message always contains the detail string; name is correct class name.
//   - LicenseRefusedError: message contains reason; detection field matches constructor arg; name correct.
//   - ForeignPolicyRejectError: message includes every pkg#export pair; foreignRefs array matches input.
//   - Compound: ForeignPolicyRejectError message and foreignRefs are jointly consistent for multi-ref inputs.

// ---------------------------------------------------------------------------
// Property-test corpus for errors.ts
// ---------------------------------------------------------------------------

import * as fc from "fast-check";
import {
  AnthropicApiKeyMissingError,
  ForeignPolicyRejectError,
  IntentCardSchemaError,
  LicenseRefusedError,
  OfflineCacheMissError,
} from "./errors.js";
import type { LicenseDetection } from "./license/types.js";

// ---------------------------------------------------------------------------
// Shared arbitraries
// ---------------------------------------------------------------------------

/** Non-empty string with no leading/trailing whitespace. */
const nonEmptyStr: fc.Arbitrary<string> = fc
  .string({ minLength: 1, maxLength: 60 })
  .filter((s) => s.trim().length > 0);

/** Arbitrary LicenseDetection source values. */
const licenseSourceArb: fc.Arbitrary<LicenseDetection["source"]> = fc.constantFrom(
  "spdx-comment",
  "package-json",
  "header-text",
  "dedication",
  "no-signal",
);

/** Arbitrary LicenseDetection (all fields; no optional evidence to avoid exactOptionalPropertyTypes issues). */
const licenseDetectionArb: fc.Arbitrary<LicenseDetection> = fc.record({
  identifier: nonEmptyStr,
  source: licenseSourceArb,
});

/** One foreign ref: { pkg, export }. */
const foreignRefArb: fc.Arbitrary<{ pkg: string; export: string }> = fc.record({
  pkg: nonEmptyStr,
  export: nonEmptyStr,
});

/** Non-empty array of foreign refs. */
const foreignRefsArb: fc.Arbitrary<readonly { pkg: string; export: string }[]> = fc.array(
  foreignRefArb,
  { minLength: 1, maxLength: 5 },
);

// ---------------------------------------------------------------------------
// AK1.1: AnthropicApiKeyMissingError — message includes key guidance text
// ---------------------------------------------------------------------------

/**
 * prop_AnthropicApiKeyMissingError_message_contains_guidance
 *
 * AnthropicApiKeyMissingError always produces a message that references the
 * ANTHROPIC_API_KEY environment variable, guiding the caller toward resolution.
 *
 * Invariant (AK1.1, DEC-CONTINUOUS-SHAVE-022): the error message is fixed and
 * self-describing — it must mention ANTHROPIC_API_KEY so operators reading logs
 * can immediately identify the required action.
 */
export const prop_AnthropicApiKeyMissingError_message_contains_guidance = fc.property(
  fc.constant(null),
  (_) => {
    const err = new AnthropicApiKeyMissingError();
    return err.message.includes("ANTHROPIC_API_KEY") && err.message.length > 0;
  },
);

// ---------------------------------------------------------------------------
// AK1.1: AnthropicApiKeyMissingError — name and instanceof invariants
// ---------------------------------------------------------------------------

/**
 * prop_AnthropicApiKeyMissingError_name_and_instanceof
 *
 * AnthropicApiKeyMissingError has the correct .name property and passes
 * instanceof checks for both AnthropicApiKeyMissingError and Error.
 *
 * Invariant (AK1.1, DEC-CONTINUOUS-SHAVE-022): callers rely on instanceof for
 * control flow (catching specific error types). A wrong .name or broken
 * prototype chain silently defeats that catch.
 */
export const prop_AnthropicApiKeyMissingError_name_and_instanceof = fc.property(
  fc.constant(null),
  (_) => {
    const err = new AnthropicApiKeyMissingError();
    return (
      err.name === "AnthropicApiKeyMissingError" &&
      err instanceof AnthropicApiKeyMissingError &&
      err instanceof Error
    );
  },
);

// ---------------------------------------------------------------------------
// OC1.1: OfflineCacheMissError — message contains the cacheKey
// ---------------------------------------------------------------------------

/**
 * prop_OfflineCacheMissError_message_contains_cache_key
 *
 * For any cacheKey string, OfflineCacheMissError's message always contains
 * the cacheKey so callers can identify which key caused the miss.
 *
 * Invariant (OC1.1, DEC-CONTINUOUS-SHAVE-022): the key is embedded in the
 * message verbatim. Log consumers depend on this to correlate cache misses
 * with specific request signatures without needing structured error fields.
 */
export const prop_OfflineCacheMissError_message_contains_cache_key = fc.property(
  nonEmptyStr,
  (cacheKey) => {
    const err = new OfflineCacheMissError(cacheKey);
    return err.message.includes(cacheKey);
  },
);

// ---------------------------------------------------------------------------
// OC1.1: OfflineCacheMissError — name and instanceof invariants
// ---------------------------------------------------------------------------

/**
 * prop_OfflineCacheMissError_name_and_instanceof
 *
 * OfflineCacheMissError has the correct .name and passes instanceof checks.
 *
 * Invariant (OC1.1, DEC-CONTINUOUS-SHAVE-022): named error classes enable
 * catch-by-type without importing string constants.
 */
export const prop_OfflineCacheMissError_name_and_instanceof = fc.property(
  nonEmptyStr,
  (cacheKey) => {
    const err = new OfflineCacheMissError(cacheKey);
    return (
      err.name === "OfflineCacheMissError" &&
      err instanceof OfflineCacheMissError &&
      err instanceof Error
    );
  },
);

// ---------------------------------------------------------------------------
// IS1.1: IntentCardSchemaError — message contains the detail
// ---------------------------------------------------------------------------

/**
 * prop_IntentCardSchemaError_message_contains_detail
 *
 * For any detail string, IntentCardSchemaError's message always contains the
 * detail so callers can identify the specific schema violation.
 *
 * Invariant (IS1.1, DEC-CONTINUOUS-SHAVE-022): schema error details are
 * essential for diagnosing malformed API responses. The detail must appear in
 * the message so logging pipelines do not need to restructure the error.
 */
export const prop_IntentCardSchemaError_message_contains_detail = fc.property(
  nonEmptyStr,
  (detail) => {
    const err = new IntentCardSchemaError(detail);
    return err.message.includes(detail);
  },
);

// ---------------------------------------------------------------------------
// IS1.1: IntentCardSchemaError — name and instanceof invariants
// ---------------------------------------------------------------------------

/**
 * prop_IntentCardSchemaError_name_and_instanceof
 *
 * IntentCardSchemaError has the correct .name and passes instanceof checks.
 *
 * Invariant (IS1.1, DEC-CONTINUOUS-SHAVE-022): named error classes enable
 * catch-by-type without importing string constants.
 */
export const prop_IntentCardSchemaError_name_and_instanceof = fc.property(nonEmptyStr, (detail) => {
  const err = new IntentCardSchemaError(detail);
  return (
    err.name === "IntentCardSchemaError" &&
    err instanceof IntentCardSchemaError &&
    err instanceof Error
  );
});

// ---------------------------------------------------------------------------
// LR1.1: LicenseRefusedError — message contains reason; detection stored
// ---------------------------------------------------------------------------

/**
 * prop_LicenseRefusedError_message_contains_reason
 *
 * For any reason string and LicenseDetection, LicenseRefusedError's message
 * always contains the reason so callers can identify the refusal cause.
 *
 * Invariant (LR1.1, DEC-CONTINUOUS-SHAVE-022): the reason is embedded verbatim.
 * CLI output reads this message; the detection is stored separately for
 * programmatic introspection.
 */
export const prop_LicenseRefusedError_message_contains_reason = fc.property(
  nonEmptyStr,
  licenseDetectionArb,
  (reason, detection) => {
    const err = new LicenseRefusedError(reason, detection);
    return err.message.includes(reason);
  },
);

// ---------------------------------------------------------------------------
// LR1.1: LicenseRefusedError — detection field matches constructor arg
// ---------------------------------------------------------------------------

/**
 * prop_LicenseRefusedError_detection_field_matches_arg
 *
 * The `detection` field on LicenseRefusedError is strictly equal to the
 * LicenseDetection object passed to the constructor.
 *
 * Invariant (LR1.1, DEC-CONTINUOUS-SHAVE-022): callers introspect the
 * detection to understand what signal was found and how to present it.
 * A mutation or substitution would silently produce incorrect diagnostics.
 */
export const prop_LicenseRefusedError_detection_field_matches_arg = fc.property(
  nonEmptyStr,
  licenseDetectionArb,
  (reason, detection) => {
    const err = new LicenseRefusedError(reason, detection);
    return (
      err.detection === detection &&
      err.detection.identifier === detection.identifier &&
      err.detection.source === detection.source
    );
  },
);

// ---------------------------------------------------------------------------
// LR1.1: LicenseRefusedError — name and instanceof invariants
// ---------------------------------------------------------------------------

/**
 * prop_LicenseRefusedError_name_and_instanceof
 *
 * LicenseRefusedError has the correct .name and passes instanceof checks.
 *
 * Invariant (LR1.1, DEC-CONTINUOUS-SHAVE-022): named error classes enable
 * catch-by-type without importing string constants.
 */
export const prop_LicenseRefusedError_name_and_instanceof = fc.property(
  nonEmptyStr,
  licenseDetectionArb,
  (reason, detection) => {
    const err = new LicenseRefusedError(reason, detection);
    return (
      err.name === "LicenseRefusedError" &&
      err instanceof LicenseRefusedError &&
      err instanceof Error
    );
  },
);

// ---------------------------------------------------------------------------
// FP1.1: ForeignPolicyRejectError — message includes all pkg#export pairs
// ---------------------------------------------------------------------------

/**
 * prop_ForeignPolicyRejectError_message_includes_all_refs
 *
 * For any non-empty list of foreign refs, ForeignPolicyRejectError's message
 * includes every `pkg#export` pair so the CLI can surface all offenders in one
 * message without iterating the structured field.
 *
 * Invariant (FP1.1, DEC-V2-FOREIGN-BLOCK-SCHEMA-001): the message format is
 * "foreign-policy reject: <pkg>#<export>[, ...]". All refs must appear so the
 * error is self-describing in log output.
 */
export const prop_ForeignPolicyRejectError_message_includes_all_refs = fc.property(
  foreignRefsArb,
  (refs) => {
    const err = new ForeignPolicyRejectError(refs);
    return refs.every((r) => err.message.includes(`${r.pkg}#${r.export}`));
  },
);

// ---------------------------------------------------------------------------
// FP1.1: ForeignPolicyRejectError — foreignRefs array matches constructor arg
// ---------------------------------------------------------------------------

/**
 * prop_ForeignPolicyRejectError_foreignRefs_matches_arg
 *
 * The `foreignRefs` field on ForeignPolicyRejectError is the same readonly
 * array passed to the constructor, with the same length and entries.
 *
 * Invariant (FP1.1, DEC-V2-FOREIGN-BLOCK-SCHEMA-001): the structured refs are
 * available for programmatic inspection (e.g. CLI formatting, test assertions).
 * Mutation or reordering would silently break downstream consumers.
 */
export const prop_ForeignPolicyRejectError_foreignRefs_matches_arg = fc.property(
  foreignRefsArb,
  (refs) => {
    const err = new ForeignPolicyRejectError(refs);
    return (
      err.foreignRefs.length === refs.length &&
      refs.every((r, i) => {
        const ref = err.foreignRefs[i];
        return ref !== undefined && ref.pkg === r.pkg && ref.export === r.export;
      })
    );
  },
);

// ---------------------------------------------------------------------------
// FP1.1: ForeignPolicyRejectError — name and instanceof invariants
// ---------------------------------------------------------------------------

/**
 * prop_ForeignPolicyRejectError_name_and_instanceof
 *
 * ForeignPolicyRejectError has the correct .name and passes instanceof checks.
 *
 * Invariant (FP1.1, DEC-V2-FOREIGN-BLOCK-SCHEMA-001): named error classes enable
 * catch-by-type without importing string constants.
 */
export const prop_ForeignPolicyRejectError_name_and_instanceof = fc.property(
  foreignRefsArb,
  (refs) => {
    const err = new ForeignPolicyRejectError(refs);
    return (
      err.name === "ForeignPolicyRejectError" &&
      err instanceof ForeignPolicyRejectError &&
      err instanceof Error
    );
  },
);

// ---------------------------------------------------------------------------
// Compound interaction: ForeignPolicyRejectError message and foreignRefs
// are jointly consistent for multi-ref inputs.
//
// Production sequence: shave() collects foreign refs from the slice plan →
// throws ForeignPolicyRejectError(foreignRefs) → CLI catches and formats
// err.message (for stderr) and err.foreignRefs (for structured output).
// This compound property verifies that both surfaces are consistent so
// neither CLI display path produces contradictory output.
// ---------------------------------------------------------------------------

/**
 * prop_ForeignPolicyRejectError_compound_message_and_refs_consistent
 *
 * For any list of foreign refs, ForeignPolicyRejectError's .message and
 * .foreignRefs are jointly consistent: every ref in foreignRefs appears as
 * a `pkg#export` token in the message, and the message starts with the
 * canonical prefix "foreign-policy reject:".
 *
 * This is the canonical compound-interaction property crossing the message
 * string and the structured foreignRefs array, mirroring the production
 * sequence where shave() throws and the CLI reads both surfaces.
 *
 * Invariant (FP1.1, DEC-V2-FOREIGN-BLOCK-SCHEMA-001): if the two surfaces
 * diverge (e.g. message truncated, refs reordered), the CLI would emit
 * inconsistent error output — some refs visible in structured data but not
 * in the display string, or vice versa.
 */
export const prop_ForeignPolicyRejectError_compound_message_and_refs_consistent = fc.property(
  foreignRefsArb,
  (refs) => {
    const err = new ForeignPolicyRejectError(refs);

    // 1. Message has the canonical prefix.
    if (!err.message.startsWith("foreign-policy reject:")) return false;

    // 2. Every ref in foreignRefs appears in the message.
    const allRefsInMessage = err.foreignRefs.every((r) =>
      err.message.includes(`${r.pkg}#${r.export}`),
    );
    if (!allRefsInMessage) return false;

    // 3. foreignRefs length matches the input.
    if (err.foreignRefs.length !== refs.length) return false;

    // 4. The entries are in source order (same as input).
    return refs.every((r, i) => {
      const ref = err.foreignRefs[i];
      return ref !== undefined && ref.pkg === r.pkg && ref.export === r.export;
    });
  },
);
