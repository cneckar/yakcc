// SPDX-License-Identifier: MIT
// Vitest harness for ast-binding.props.ts
// Two-file pattern: this file is the thin vitest wrapper; the corpus lives in
// the sibling ast-binding.props.ts (vitest-free, hashable as a manifest artifact).

import * as fc from "fast-check";
import { describe, it } from "vitest";
import {
  prop_extractBindingShape_args_count_matches_call,
  prop_extractBindingShape_captures_return_type,
  prop_extractBindingShape_deterministic,
  prop_extractBindingShape_extracts_name_and_atom,
  prop_extractBindingShape_null_for_destructuring,
  prop_extractBindingShape_null_for_empty_snippets,
  prop_extractBindingShape_null_for_multiple_statements,
  prop_extractBindingShape_null_for_non_binding_snippets,
  prop_extractBindingShape_null_for_non_call_initializers,
  prop_extractBindingShape_result_shape_invariant,
} from "./ast-binding.props.js";

// ts-morph invokes the TypeScript compiler per call (~100-500ms each).
// numRuns: 10 exercises the full finite constantFrom corpus without blowing
// the vitest timeout. Invariants are structural; 10 runs saturates the corpus.
const tsMorphOpts = { numRuns: 10 };
const tsMorphTimeout = 120_000;

describe("ast-binding properties", () => {
  it(
    "property: prop_extractBindingShape_null_for_empty_snippets",
    () => {
      fc.assert(prop_extractBindingShape_null_for_empty_snippets, tsMorphOpts);
    },
    tsMorphTimeout,
  );

  it(
    "property: prop_extractBindingShape_null_for_non_binding_snippets",
    () => {
      fc.assert(prop_extractBindingShape_null_for_non_binding_snippets, tsMorphOpts);
    },
    tsMorphTimeout,
  );

  it(
    "property: prop_extractBindingShape_null_for_multiple_statements",
    () => {
      fc.assert(prop_extractBindingShape_null_for_multiple_statements, tsMorphOpts);
    },
    tsMorphTimeout,
  );

  it(
    "property: prop_extractBindingShape_null_for_destructuring",
    () => {
      fc.assert(prop_extractBindingShape_null_for_destructuring, tsMorphOpts);
    },
    tsMorphTimeout,
  );

  it(
    "property: prop_extractBindingShape_null_for_non_call_initializers",
    () => {
      fc.assert(prop_extractBindingShape_null_for_non_call_initializers, tsMorphOpts);
    },
    tsMorphTimeout,
  );

  it(
    "property: prop_extractBindingShape_extracts_name_and_atom",
    () => {
      fc.assert(prop_extractBindingShape_extracts_name_and_atom, tsMorphOpts);
    },
    tsMorphTimeout,
  );

  it(
    "property: prop_extractBindingShape_args_count_matches_call",
    () => {
      fc.assert(prop_extractBindingShape_args_count_matches_call, tsMorphOpts);
    },
    tsMorphTimeout,
  );

  it(
    "property: prop_extractBindingShape_captures_return_type",
    () => {
      fc.assert(prop_extractBindingShape_captures_return_type, tsMorphOpts);
    },
    tsMorphTimeout,
  );

  it(
    "property: prop_extractBindingShape_deterministic",
    () => {
      fc.assert(prop_extractBindingShape_deterministic, tsMorphOpts);
    },
    tsMorphTimeout,
  );

  it(
    "property: prop_extractBindingShape_result_shape_invariant",
    () => {
      fc.assert(prop_extractBindingShape_result_shape_invariant, tsMorphOpts);
    },
    tsMorphTimeout,
  );
});
