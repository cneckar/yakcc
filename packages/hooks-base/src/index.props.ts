// SPDX-License-Identifier: MIT
// @decision DEC-HOOKS-BASE-PROPTEST-INDEX-001: hand-authored property-test corpus
// for @yakcc/hooks-base index.ts pure-function atoms. Two-file pattern: this file
// (.props.ts) is vitest-free and holds the corpus; the sibling .props.test.ts is the
// vitest harness.
// Status: accepted (issue-87-fill-hooks-base)
// Rationale: buildIntentCardQuery and buildSkeletonSpec are the two pure (no-FS,
// no-async, no-env) functions in index.ts. Property tests exercise invariants that
// example-based tests cannot enumerate exhaustively: totality, determinism, output
// shape constraints, and the behavioral contract between input fields and output fields.
// DEFAULT_REGISTRY_HIT_THRESHOLD is also a stable constant whose value is an invariant.
//
// NOT covered here (impure / async / require real registry):
//   writeMarkerCommand (FS side-effect — covered in index.test.ts)
//   executeRegistryQuery / executeRegistryQueryWithTelemetry / executeRegistryQueryWithSubstitution
//   (async + Registry dependency — covered in index.test.ts and telemetry.test.ts)

// ---------------------------------------------------------------------------
// Property-test corpus for index.ts
//
// Functions/constants covered (3):
//   DEFAULT_REGISTRY_HIT_THRESHOLD — constant invariant
//   buildIntentCardQuery            — pure EmissionContext → IntentCardQuery conversion
//   buildSkeletonSpec               — pure string → ContractSpec construction
//
// Behaviors exercised:
//   T1 — DEFAULT_REGISTRY_HIT_THRESHOLD is exactly 0.30
//   T2 — DEFAULT_REGISTRY_HIT_THRESHOLD is in range (0, 1) — valid cosine distance cutoff
//   I1 — buildIntentCardQuery totality: never throws for any EmissionContext
//   I2 — buildIntentCardQuery determinism: same input → same output
//   I3 — buildIntentCardQuery no-context: behavior = intent when sourceContext absent
//   I4 — buildIntentCardQuery with-context: behavior = intent + " " + sourceContext
//   I5 — buildIntentCardQuery always returns empty inputs and outputs arrays
//   I6 — buildIntentCardQuery inputs/outputs are always empty arrays (not undefined/null)
//   I7 — buildIntentCardQuery: sourceContext present but empty string → behavior contains extra space
//   S1 — buildSkeletonSpec totality: never throws for any string input
//   S2 — buildSkeletonSpec determinism: same input → same output (structurally equal)
//   S3 — buildSkeletonSpec behavior: equals the intent argument exactly
//   S4 — buildSkeletonSpec collection fields: inputs/outputs/guarantees/errorConditions/propertyTests all empty
//   S5 — buildSkeletonSpec nonFunctional defaults: purity=pure, threadSafety=safe
//   S6 — buildSkeletonSpec: empty string intent produces behavior=""
//   S7 — buildSkeletonSpec: long/special-character intent is preserved verbatim
// ---------------------------------------------------------------------------

import {
  DEFAULT_REGISTRY_HIT_THRESHOLD,
  buildIntentCardQuery,
  buildSkeletonSpec,
  type EmissionContext,
} from "./index.js";

// ---------------------------------------------------------------------------
// Representative input sets
// ---------------------------------------------------------------------------

/** EmissionContext values with no sourceContext. */
const INTENTS_NO_CTX: EmissionContext[] = [
  { intent: "" },
  { intent: "Parse an integer" },
  { intent: "Reverse a string in place" },
  { intent: "Sort an array of numbers in ascending order" },
  { intent: "x".repeat(256) },
  { intent: "intent with Unicode: élève 中文 🚀" },
  { intent: "  leading and trailing spaces  " },
];

/** EmissionContext values with sourceContext. */
const INTENTS_WITH_CTX: EmissionContext[] = [
  { intent: "filter the list", sourceContext: "by removing nulls" },
  { intent: "compute hash", sourceContext: "from input bytes" },
  { intent: "a", sourceContext: "b" },
  { intent: "Parse an integer", sourceContext: "from a string representation" },
  { intent: "intent with spaces", sourceContext: "context with spaces" },
];

/** Raw intent strings for buildSkeletonSpec. */
const SKELETON_INTENTS = [
  "",
  "Parse an integer",
  "Reverse a string",
  "  spaces  ",
  "x".repeat(512),
  "intent with Unicode: 中文 🎉",
  "!@#$%^&*() special chars",
];

// ---------------------------------------------------------------------------
// T1 — DEFAULT_REGISTRY_HIT_THRESHOLD: exact value
// ---------------------------------------------------------------------------

/**
 * prop_defaultThreshold_is_0_30
 *
 * DEFAULT_REGISTRY_HIT_THRESHOLD is exactly 0.30.
 *
 * Invariant: the constant is the canonical cross-IDE threshold value defined
 * in DEC-HOOK-BASE-001(b). Any change here is a cross-package breaking change.
 */
export function prop_defaultThreshold_is_0_30(): boolean {
  return DEFAULT_REGISTRY_HIT_THRESHOLD === 0.3;
}

// ---------------------------------------------------------------------------
// T2 — DEFAULT_REGISTRY_HIT_THRESHOLD: valid cosine-distance range
// ---------------------------------------------------------------------------

/**
 * prop_defaultThreshold_in_valid_range
 *
 * DEFAULT_REGISTRY_HIT_THRESHOLD is strictly between 0 and 2 (the [0, 2]
 * range of sqlite-vec cosine distances for unit-norm vectors).
 *
 * Invariant: a threshold of 0 would reject all candidates; a threshold of ≥ 2
 * would accept all candidates. The default must be in (0, 2).
 */
export function prop_defaultThreshold_in_valid_range(): boolean {
  return DEFAULT_REGISTRY_HIT_THRESHOLD > 0 && DEFAULT_REGISTRY_HIT_THRESHOLD < 2;
}

// ---------------------------------------------------------------------------
// I1 — buildIntentCardQuery: totality
// ---------------------------------------------------------------------------

/**
 * prop_buildIntentCardQuery_total
 *
 * buildIntentCardQuery never throws for any EmissionContext (with or without
 * sourceContext, including empty strings and Unicode).
 *
 * Invariant: the function performs only string concatenation and object
 * construction — it is total for all valid EmissionContext inputs.
 */
export function prop_buildIntentCardQuery_total(): boolean {
  for (const ctx of [...INTENTS_NO_CTX, ...INTENTS_WITH_CTX]) {
    try {
      buildIntentCardQuery(ctx);
    } catch {
      return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// I2 — buildIntentCardQuery: determinism
// ---------------------------------------------------------------------------

/**
 * prop_buildIntentCardQuery_deterministic
 *
 * Two calls with the same EmissionContext produce structurally identical results.
 *
 * Invariant: buildIntentCardQuery is a pure function — no side effects, no
 * random or time-dependent output.
 */
export function prop_buildIntentCardQuery_deterministic(): boolean {
  for (const ctx of [...INTENTS_NO_CTX, ...INTENTS_WITH_CTX]) {
    const q1 = buildIntentCardQuery(ctx);
    const q2 = buildIntentCardQuery(ctx);
    if (q1.behavior !== q2.behavior) return false;
    if (q1.inputs.length !== q2.inputs.length) return false;
    if (q1.outputs.length !== q2.outputs.length) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// I3 — buildIntentCardQuery: no sourceContext → behavior = intent
// ---------------------------------------------------------------------------

/**
 * prop_buildIntentCardQuery_no_ctx_behavior_equals_intent
 *
 * When EmissionContext has no sourceContext, behavior is exactly the intent string.
 *
 * Invariant: the ternary `ctx.sourceContext ? ... : ctx.intent` falls through
 * to `ctx.intent` when sourceContext is undefined. No transformation applied.
 */
export function prop_buildIntentCardQuery_no_ctx_behavior_equals_intent(): boolean {
  for (const ctx of INTENTS_NO_CTX) {
    const q = buildIntentCardQuery(ctx);
    if (q.behavior !== ctx.intent) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// I4 — buildIntentCardQuery: with sourceContext → behavior = intent + " " + sourceContext
// ---------------------------------------------------------------------------

/**
 * prop_buildIntentCardQuery_with_ctx_concatenates
 *
 * When EmissionContext has a sourceContext, behavior is
 * `${ctx.intent} ${ctx.sourceContext}`.
 *
 * Invariant: query construction matches the concatenation formula in all three
 * consumer hooks that previously inlined this logic (DEC-HOOK-BASE-001-a).
 */
export function prop_buildIntentCardQuery_with_ctx_concatenates(): boolean {
  for (const ctx of INTENTS_WITH_CTX) {
    const q = buildIntentCardQuery(ctx);
    const expected = `${ctx.intent} ${ctx.sourceContext}`;
    if (q.behavior !== expected) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// I5 — buildIntentCardQuery: inputs and outputs are always empty arrays
// ---------------------------------------------------------------------------

/**
 * prop_buildIntentCardQuery_empty_inputs_outputs
 *
 * For every EmissionContext, inputs and outputs are always empty arrays (length 0).
 *
 * Invariant: the current query shape passes no input/output type hints to
 * findCandidatesByIntent — vector similarity is computed from behavior text only.
 * A non-empty inputs or outputs array would change the query semantics unexpectedly.
 */
export function prop_buildIntentCardQuery_empty_inputs_outputs(): boolean {
  for (const ctx of [...INTENTS_NO_CTX, ...INTENTS_WITH_CTX]) {
    const q = buildIntentCardQuery(ctx);
    if (!Array.isArray(q.inputs) || q.inputs.length !== 0) return false;
    if (!Array.isArray(q.outputs) || q.outputs.length !== 0) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// I6 — buildIntentCardQuery: arrays are not null or undefined
// ---------------------------------------------------------------------------

/**
 * prop_buildIntentCardQuery_arrays_not_null
 *
 * inputs and outputs are always real Array instances (never null or undefined).
 *
 * Invariant: callers may call .length or spread inputs/outputs without a null
 * guard — the contract guarantees they are always valid arrays.
 */
export function prop_buildIntentCardQuery_arrays_not_null(): boolean {
  for (const ctx of [...INTENTS_NO_CTX, ...INTENTS_WITH_CTX]) {
    const q = buildIntentCardQuery(ctx);
    if (q.inputs == null) return false;
    if (q.outputs == null) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// I7 — buildIntentCardQuery: empty sourceContext string → behavior has trailing space
// ---------------------------------------------------------------------------

/**
 * prop_buildIntentCardQuery_empty_source_context_appends_space
 *
 * When sourceContext is an empty string (truthy check: "" is falsy in JS),
 * behavior equals ctx.intent (no concatenation). This verifies the truthiness
 * branch, not a length check.
 *
 * Invariant: `""` is falsy in JavaScript, so `ctx.sourceContext ? ... : ctx.intent`
 * evaluates to ctx.intent when sourceContext is "". This is a deliberate behavior:
 * an empty sourceContext provides no additional context.
 */
export function prop_buildIntentCardQuery_empty_string_sourceContext_is_falsy(): boolean {
  const ctx: EmissionContext = { intent: "test intent", sourceContext: "" };
  const q = buildIntentCardQuery(ctx);
  // "" is falsy → behavior should be just the intent
  return q.behavior === "test intent";
}

// ---------------------------------------------------------------------------
// S1 — buildSkeletonSpec: totality
// ---------------------------------------------------------------------------

/**
 * prop_buildSkeletonSpec_total
 *
 * buildSkeletonSpec never throws for any string input (including empty,
 * long, Unicode, and special characters).
 *
 * Invariant: the function only constructs an object literal — no parsing,
 * no I/O, no dynamic dispatch. It is total for all string inputs.
 */
export function prop_buildSkeletonSpec_total(): boolean {
  for (const intent of SKELETON_INTENTS) {
    try {
      buildSkeletonSpec(intent);
    } catch {
      return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// S2 — buildSkeletonSpec: determinism
// ---------------------------------------------------------------------------

/**
 * prop_buildSkeletonSpec_deterministic
 *
 * Two calls with the same intent string produce structurally identical ContractSpecs.
 *
 * Invariant: buildSkeletonSpec is a pure function — no side effects, no random
 * or time-dependent output.
 */
export function prop_buildSkeletonSpec_deterministic(): boolean {
  for (const intent of SKELETON_INTENTS) {
    const s1 = buildSkeletonSpec(intent);
    const s2 = buildSkeletonSpec(intent);
    if (s1.behavior !== s2.behavior) return false;
    if (s1.inputs.length !== s2.inputs.length) return false;
    if (s1.outputs.length !== s2.outputs.length) return false;
    if (s1.nonFunctional.purity !== s2.nonFunctional.purity) return false;
    if (s1.nonFunctional.threadSafety !== s2.nonFunctional.threadSafety) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// S3 — buildSkeletonSpec: behavior equals intent
// ---------------------------------------------------------------------------

/**
 * prop_buildSkeletonSpec_behavior_equals_intent
 *
 * The behavior field of the returned ContractSpec is exactly the intent string.
 *
 * Invariant: the skeleton is built from prose intent — the synthesis engine
 * refines the skeleton, and the behavior field is its main input. No
 * transformation or truncation is applied.
 */
export function prop_buildSkeletonSpec_behavior_equals_intent(): boolean {
  for (const intent of SKELETON_INTENTS) {
    const s = buildSkeletonSpec(intent);
    if (s.behavior !== intent) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// S4 — buildSkeletonSpec: all collection fields are empty
// ---------------------------------------------------------------------------

/**
 * prop_buildSkeletonSpec_collections_all_empty
 *
 * inputs, outputs, guarantees, errorConditions, and propertyTests are all
 * empty arrays in the skeleton.
 *
 * Invariant: the synthesiser fills in these fields; the skeleton is intentionally
 * minimal. Non-empty defaults would pollute the synthesis prompt.
 */
export function prop_buildSkeletonSpec_collections_all_empty(): boolean {
  for (const intent of SKELETON_INTENTS) {
    const s = buildSkeletonSpec(intent);
    if (!Array.isArray(s.inputs) || s.inputs.length !== 0) return false;
    if (!Array.isArray(s.outputs) || s.outputs.length !== 0) return false;
    if (!Array.isArray(s.guarantees) || s.guarantees.length !== 0) return false;
    if (!Array.isArray(s.errorConditions) || s.errorConditions.length !== 0) return false;
    if (!Array.isArray(s.propertyTests) || s.propertyTests.length !== 0) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// S5 — buildSkeletonSpec: nonFunctional defaults to pure + safe
// ---------------------------------------------------------------------------

/**
 * prop_buildSkeletonSpec_nonFunctional_defaults
 *
 * The nonFunctional field always has purity="pure" and threadSafety="safe".
 *
 * Invariant: conservative defaults per DEC-HOOK-BASE-001-b. The synthesiser
 * refines these; the skeleton starts from the safest assumption.
 */
export function prop_buildSkeletonSpec_nonFunctional_defaults(): boolean {
  for (const intent of SKELETON_INTENTS) {
    const s = buildSkeletonSpec(intent);
    if (s.nonFunctional.purity !== "pure") return false;
    if (s.nonFunctional.threadSafety !== "safe") return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// S6 — buildSkeletonSpec: empty string intent
// ---------------------------------------------------------------------------

/**
 * prop_buildSkeletonSpec_empty_intent_produces_empty_behavior
 *
 * buildSkeletonSpec("") produces a ContractSpec with behavior="" and no error.
 *
 * Invariant: the synthesis engine may receive an empty-string intent from
 * a hook that was triggered before the user typed any description. The skeleton
 * must still be constructable.
 */
export function prop_buildSkeletonSpec_empty_intent_produces_empty_behavior(): boolean {
  const s = buildSkeletonSpec("");
  return s.behavior === "";
}

// ---------------------------------------------------------------------------
// S7 — buildSkeletonSpec: long/special-character intent preserved verbatim
// ---------------------------------------------------------------------------

/**
 * prop_buildSkeletonSpec_long_and_special_intent_preserved
 *
 * Long and special-character intent strings are stored verbatim in behavior —
 * no truncation, escaping, or sanitisation occurs inside buildSkeletonSpec.
 *
 * Invariant: sanitisation is the synthesiser's concern. The skeleton must
 * faithfully carry whatever the hook layer received.
 */
export function prop_buildSkeletonSpec_long_and_special_intent_preserved(): boolean {
  const longIntent = "x".repeat(512);
  const specialIntent = "!@#$%^&*() special chars";
  const unicodeIntent = "intent with Unicode: 中文 🎉";

  for (const intent of [longIntent, specialIntent, unicodeIntent]) {
    const s = buildSkeletonSpec(intent);
    if (s.behavior !== intent) return false;
  }
  return true;
}
