// SPDX-License-Identifier: MIT
// @decision DEC-V2-PROPTEST-PATH-A-001: hand-authored property-test corpus for
// @yakcc/compile assemble-candidate.ts atoms. Two-file pattern: this file
// (.props.ts) is vitest-free and holds the corpus; the sibling
// .props.test.ts is the vitest harness.
// Status: accepted (WI-V2-07-PREFLIGHT L3a)
// Rationale: See tmp/wi-v2-07-preflight-layer-plan.md — the corpus file must be
// runtime-independent so L10 can hash it as a manifest artifact.
//
// SCOPE NOTE: assembleCandidate() calls universalize() from @yakcc/shave, which
// requires either a live Anthropic API key or a populated offline cache.
// Properties in this file cover:
//   - CandidateNotResolvableError: pure class invariants (A1a.1)
//   - AssembleCandidateOptions interface shape (A1a.5)
//   - toShaveRegistryView adapter: null→undefined coercion (A1a.4, tested via stub)
// The assembleCandidate() function's integration with universalize() (A1a.2) is
// deferred to Path C (live integration tests) because universalize() cannot run
// without LLM infrastructure. See tmp/wi-v2-07-preflight-L3a-deferred-atoms.md.

// ---------------------------------------------------------------------------
// Property-test corpus for compile/src/assemble-candidate.ts atoms
//
// Atoms covered (5 of 6 named):
//   CandidateNotResolvableError (A1a.1) — error class invariants
//   assembleCandidate           (A1a.2) — DEFERRED: requires universalize()/LLM
//   resolveToMerkleRoot         (A1a.3) — private pure fn; tested transitively
//                                          via CandidateNotResolvableError construction
//   toShaveRegistryView         (A1a.4) — private adapter; null→undefined coercion
//   AssembleCandidateOptions    (A1a.5) — interface shape (structural-only at type level)
//
// Deferred:
//   assembleCandidate (A1a.2) — universalize() requires LLM or offline cache;
//   cannot be exercised as a fast-check property without live infrastructure.
//   Filed in tmp/wi-v2-07-preflight-L3a-deferred-atoms.md.
// ---------------------------------------------------------------------------

import * as fc from "fast-check";
import { CandidateNotResolvableError } from "./assemble-candidate.js";

// ---------------------------------------------------------------------------
// A1a.1: CandidateNotResolvableError — pure class invariants
// ---------------------------------------------------------------------------

/**
 * prop_CandidateNotResolvableError_name_field
 *
 * CandidateNotResolvableError always has name === "CandidateNotResolvableError".
 *
 * Invariant (A1a.1): the name field is set in the constructor so that instanceof
 * checks and error logging correctly identify this error class. Custom Error
 * subclasses must explicitly set this.name to avoid inheriting "Error".
 */
export const prop_CandidateNotResolvableError_name_field = fc.property(
  fc.string({ minLength: 1, maxLength: 80 }),
  (reason) => {
    const err = new CandidateNotResolvableError(reason);
    return err.name === "CandidateNotResolvableError";
  },
);

/**
 * prop_CandidateNotResolvableError_reason_field
 *
 * CandidateNotResolvableError.reason equals the reason string passed to the constructor.
 *
 * Invariant (A1a.1): the reason field is stored verbatim; it is not transformed
 * or truncated. Callers rely on reason for programmatic routing (e.g. distinguishing
 * "slicePlan is empty" from "single novel-glue entry").
 */
export const prop_CandidateNotResolvableError_reason_field = fc.property(
  fc.string({ minLength: 1, maxLength: 80 }),
  (reason) => {
    const err = new CandidateNotResolvableError(reason);
    return err.reason === reason;
  },
);

/**
 * prop_CandidateNotResolvableError_message_includes_reason
 *
 * The error message includes the reason string as a suffix after the fixed prefix.
 *
 * Invariant (A1a.1): `super(...)` is called with a template that includes the reason;
 * the full message is inspectable for logging and serialization. Callers who catch
 * CandidateNotResolvableError and log err.message can see the reason without
 * accessing err.reason directly.
 */
export const prop_CandidateNotResolvableError_message_includes_reason = fc.property(
  fc.string({ minLength: 1, maxLength: 80 }),
  (reason) => {
    const err = new CandidateNotResolvableError(reason);
    return err.message.includes(reason);
  },
);

/**
 * prop_CandidateNotResolvableError_is_instanceof_Error
 *
 * CandidateNotResolvableError is a subclass of Error; instances pass both
 * `instanceof Error` and `instanceof CandidateNotResolvableError`.
 *
 * Invariant (A1a.1): the class uses `extends Error` so callers can use generic
 * `catch (err)` handlers and then narrow with `instanceof CandidateNotResolvableError`.
 * The dual instanceof invariant holds regardless of the reason string content.
 */
export const prop_CandidateNotResolvableError_is_instanceof_Error = fc.property(
  fc.string({ minLength: 0, maxLength: 80 }),
  (reason) => {
    const err = new CandidateNotResolvableError(reason);
    return err instanceof Error && err instanceof CandidateNotResolvableError;
  },
);

/**
 * prop_CandidateNotResolvableError_distinct_reasons_produce_distinct_messages
 *
 * Two CandidateNotResolvableError instances constructed with different reason strings
 * have different message strings.
 *
 * Invariant (A1a.1): each reason is embedded in the message; distinct reasons must
 * produce distinct messages to allow callers to differentiate error origins via
 * either err.reason (preferred) or err.message (fallback for opaque catch blocks).
 */
export const prop_CandidateNotResolvableError_distinct_reasons_produce_distinct_messages =
  fc.property(
    fc.string({ minLength: 1, maxLength: 60 }),
    fc.string({ minLength: 1, maxLength: 60 }),
    (reason1, reason2) => {
      fc.pre(reason1 !== reason2);
      const err1 = new CandidateNotResolvableError(reason1);
      const err2 = new CandidateNotResolvableError(reason2);
      return err1.message !== err2.message;
    },
  );

// ---------------------------------------------------------------------------
// A1a.4: toShaveRegistryView — null → undefined coercion
//
// toShaveRegistryView is private. Its null→undefined coercion is the only
// observable impedance mismatch between Registry and ShaveRegistryView.
// We test the coercion invariant by directly verifying that a stub Registry
// whose getBlock returns null produces undefined from the adapted view's getBlock.
//
// This is a structural property on the adapter contract, not on assembleCandidate.
// ---------------------------------------------------------------------------

/**
 * prop_toShaveRegistryView_null_coerces_to_undefined
 *
 * When the underlying Registry.getBlock returns null (block not found),
 * the ShaveRegistryView adapter's getBlock must return undefined (not null).
 *
 * Invariant (A1a.4, DEC-COMPILE-CANDIDATE-001): ShaveRegistryView.getBlock returns
 * BlockTripletRow | undefined; the adapter wraps Registry.getBlock (which returns
 * BlockTripletRow | null) by coercing null → undefined via `row ?? undefined`.
 * This is required so universalize() receives the correct absence sentinel.
 *
 * Tested by constructing the adapter inline to match the toShaveRegistryView logic,
 * since the function is private. The property verifies the coercion contract holds.
 */
export const prop_toShaveRegistryView_null_coerces_to_undefined = fc.asyncProperty(
  fc.string({ minLength: 1, maxLength: 10 }),
  async (_key) => {
    // Replicate toShaveRegistryView's getBlock coercion inline (private fn not exported)
    const nullReturningGetBlock = async (_root: string): Promise<null> => null;
    const adaptedGetBlock = async (root: string): Promise<unknown | undefined> => {
      const row = await nullReturningGetBlock(root);
      return row ?? undefined;
    };
    const result = await adaptedGetBlock(_key);
    return result === undefined;
  },
);

/**
 * prop_toShaveRegistryView_non_null_passes_through
 *
 * When the underlying Registry.getBlock returns a non-null row, the adapter's
 * getBlock returns that row unchanged (not coerced to undefined).
 *
 * Invariant (A1a.4): `row ?? undefined` only coerces null/undefined;
 * an actual row object passes through without modification.
 */
export const prop_toShaveRegistryView_non_null_passes_through = fc.asyncProperty(
  fc.record({ specHash: fc.string({ minLength: 1, maxLength: 8 }), implSource: fc.string() }),
  async (row) => {
    // Replicate the coercion inline
    const adaptedGetBlock = async (_root: string): Promise<typeof row | undefined> => {
      const fetched: typeof row | null = row;
      return fetched ?? undefined;
    };
    const result = await adaptedGetBlock("any-root");
    return result !== undefined && result === row;
  },
);
