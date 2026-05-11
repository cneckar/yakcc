// SPDX-License-Identifier: MIT
// Vitest harness for strict-subset-project.props.ts
// Two-file pattern: this file is the thin vitest wrapper; the corpus lives in
// the sibling strict-subset-project.props.ts (vitest-free, hashable as a manifest artifact).

import * as fc from "fast-check";
import { describe, it } from "vitest";
import {
  prop_validateStrictSubsetProject_deterministic,
  prop_validateStrictSubsetProject_result_shape,
  prop_validateStrictSubsetProject_tsconfigPath_roundtrip,
  prop_validateStrictSubsetProject_validates_nonzero_files,
  prop_validateStrictSubsetProject_violation_shape,
  prop_validateStrictSubsetProject_violations_count_stable,
  prop_validateStrictSubsetProject_violations_is_array,
} from "./strict-subset-project.props.js";

// validateStrictSubsetProject loads a real tsconfig and resolves all source file
// dependencies (~500ms-2s per call). numRuns: 1 is sufficient because the
// tsconfigArb is fc.constant (single fixture); each run exercises the full
// invariant against the real project. The determinism property runs two calls
// concurrently via Promise.all, doubling coverage within a single run.
const opts = { numRuns: 1 };
const timeout = 120_000;

describe("strict-subset-project properties", () => {
  it(
    "property: prop_validateStrictSubsetProject_result_shape",
    async () => {
      await fc.assert(prop_validateStrictSubsetProject_result_shape, opts);
    },
    timeout,
  );

  it(
    "property: prop_validateStrictSubsetProject_tsconfigPath_roundtrip",
    async () => {
      await fc.assert(prop_validateStrictSubsetProject_tsconfigPath_roundtrip, opts);
    },
    timeout,
  );

  it(
    "property: prop_validateStrictSubsetProject_validates_nonzero_files",
    async () => {
      await fc.assert(prop_validateStrictSubsetProject_validates_nonzero_files, opts);
    },
    timeout,
  );

  it(
    "property: prop_validateStrictSubsetProject_violations_is_array",
    async () => {
      await fc.assert(prop_validateStrictSubsetProject_violations_is_array, opts);
    },
    timeout,
  );

  it(
    "property: prop_validateStrictSubsetProject_violation_shape",
    async () => {
      await fc.assert(prop_validateStrictSubsetProject_violation_shape, opts);
    },
    timeout,
  );

  it(
    "property: prop_validateStrictSubsetProject_deterministic",
    async () => {
      await fc.assert(prop_validateStrictSubsetProject_deterministic, opts);
    },
    timeout,
  );

  it(
    "property: prop_validateStrictSubsetProject_violations_count_stable",
    async () => {
      await fc.assert(prop_validateStrictSubsetProject_violations_count_stable, opts);
    },
    timeout,
  );
});
