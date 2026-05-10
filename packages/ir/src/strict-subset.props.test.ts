// SPDX-License-Identifier: MIT
// Vitest harness for strict-subset.props.ts
// Two-file pattern: this file is the thin vitest wrapper; the corpus lives in
// the sibling strict-subset.props.ts (vitest-free, hashable as a manifest artifact).

import * as fc from "fast-check";
import { it } from "vitest";
import {
  prop_checkNoWith_detects_with_statements,
  prop_isAnyTypeNode_absent_in_clean_sources,
  prop_isAnyTypeNode_detects_any_violations,
  prop_makeProject_consistent_project_state,
  prop_runAllRules_errors_have_required_fields,
  prop_runAllRules_exhaustive_multiple_violations,
  prop_validateStrictSubset_deterministic,
  prop_validateStrictSubset_fails_for_any,
  prop_validateStrictSubset_mutable_globals_rejected,
  prop_validateStrictSubset_ok_for_clean_sources,
  prop_validateStrictSubset_result_shape,
} from "./strict-subset.props.js";

// ts-morph invokes the TypeScript compiler per call (~100-500ms each).
// numRuns: 10 exercises the full finite constantFrom corpus without blowing
// the timeout. The invariants are structural; 10 runs saturates all variants.
const tsMorphOpts = { numRuns: 10 };
const tsMorphTimeout = 120_000;

it(
  "property: prop_makeProject_consistent_project_state",
  () => {
    fc.assert(prop_makeProject_consistent_project_state, tsMorphOpts);
  },
  tsMorphTimeout,
);

it(
  "property: prop_isAnyTypeNode_detects_any_violations",
  () => {
    fc.assert(prop_isAnyTypeNode_detects_any_violations, tsMorphOpts);
  },
  tsMorphTimeout,
);

it(
  "property: prop_isAnyTypeNode_absent_in_clean_sources",
  () => {
    fc.assert(prop_isAnyTypeNode_absent_in_clean_sources, tsMorphOpts);
  },
  tsMorphTimeout,
);

it(
  "property: prop_checkNoWith_detects_with_statements",
  () => {
    fc.assert(prop_checkNoWith_detects_with_statements, tsMorphOpts);
  },
  tsMorphTimeout,
);

it(
  "property: prop_runAllRules_exhaustive_multiple_violations",
  () => {
    fc.assert(prop_runAllRules_exhaustive_multiple_violations, tsMorphOpts);
  },
  tsMorphTimeout,
);

it(
  "property: prop_runAllRules_errors_have_required_fields",
  () => {
    fc.assert(prop_runAllRules_errors_have_required_fields, tsMorphOpts);
  },
  tsMorphTimeout,
);

it(
  "property: prop_validateStrictSubset_ok_for_clean_sources",
  () => {
    fc.assert(prop_validateStrictSubset_ok_for_clean_sources, tsMorphOpts);
  },
  tsMorphTimeout,
);

it(
  "property: prop_validateStrictSubset_fails_for_any",
  () => {
    fc.assert(prop_validateStrictSubset_fails_for_any, tsMorphOpts);
  },
  tsMorphTimeout,
);

it(
  "property: prop_validateStrictSubset_deterministic",
  () => {
    fc.assert(prop_validateStrictSubset_deterministic, tsMorphOpts);
  },
  tsMorphTimeout,
);

it(
  "property: prop_validateStrictSubset_result_shape",
  () => {
    fc.assert(prop_validateStrictSubset_result_shape, tsMorphOpts);
  },
  tsMorphTimeout,
);

it(
  "property: prop_validateStrictSubset_mutable_globals_rejected",
  () => {
    fc.assert(prop_validateStrictSubset_mutable_globals_rejected, tsMorphOpts);
  },
  tsMorphTimeout,
);
