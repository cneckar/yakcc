// SPDX-License-Identifier: MIT
// Vitest harness for assemble-candidate.props.ts
// Two-file pattern: this file is the thin vitest wrapper; the corpus lives in
// the sibling assemble-candidate.props.ts (vitest-free, hashable as a manifest artifact).

import * as fc from "fast-check";
import { it } from "vitest";
import {
  prop_CandidateNotResolvableError_distinct_reasons_produce_distinct_messages,
  prop_CandidateNotResolvableError_is_instanceof_Error,
  prop_CandidateNotResolvableError_message_includes_reason,
  prop_CandidateNotResolvableError_name_field,
  prop_CandidateNotResolvableError_reason_field,
  prop_toShaveRegistryView_non_null_passes_through,
  prop_toShaveRegistryView_null_coerces_to_undefined,
} from "./assemble-candidate.props.js";

// All properties are pure (CandidateNotResolvableError is a class, adapter logic
// is a coercion) — no disk IO, no ts-morph, no LLM.
// numRuns: 100 gives thorough coverage at negligible cost.
const opts = { numRuns: 100 };

it("property: prop_CandidateNotResolvableError_name_field", () => {
  fc.assert(prop_CandidateNotResolvableError_name_field, opts);
});

it("property: prop_CandidateNotResolvableError_reason_field", () => {
  fc.assert(prop_CandidateNotResolvableError_reason_field, opts);
});

it("property: prop_CandidateNotResolvableError_message_includes_reason", () => {
  fc.assert(prop_CandidateNotResolvableError_message_includes_reason, opts);
});

it("property: prop_CandidateNotResolvableError_is_instanceof_Error", () => {
  fc.assert(prop_CandidateNotResolvableError_is_instanceof_Error, opts);
});

it(
  "property: prop_CandidateNotResolvableError_distinct_reasons_produce_distinct_messages",
  () => {
    fc.assert(
      prop_CandidateNotResolvableError_distinct_reasons_produce_distinct_messages,
      opts,
    );
  },
);

it("property: prop_toShaveRegistryView_null_coerces_to_undefined", async () => {
  await fc.assert(prop_toShaveRegistryView_null_coerces_to_undefined, opts);
});

it("property: prop_toShaveRegistryView_non_null_passes_through", async () => {
  await fc.assert(prop_toShaveRegistryView_non_null_passes_through, opts);
});
