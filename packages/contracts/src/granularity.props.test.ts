// SPDX-License-Identifier: MIT
// Vitest harness for granularity.props.ts
// Two-file pattern: this file is the thin vitest wrapper; the corpus lives in
// the sibling granularity.props.ts (vitest-free, hashable as a manifest artifact).

import { it } from "vitest";
import {
  prop_DEFAULT_GRANULARITY_is_3,
  prop_DEFAULT_within_range,
  prop_MAX_GRANULARITY_is_5,
  prop_MIN_GRANULARITY_is_1,
  prop_parseGranularity_above_range,
  prop_parseGranularity_below_range,
  prop_parseGranularity_default,
  prop_parseGranularity_determinism,
  prop_parseGranularity_empty_string,
  prop_parseGranularity_float,
  prop_parseGranularity_interior_2,
  prop_parseGranularity_interior_4,
  prop_parseGranularity_lower_bound,
  prop_parseGranularity_nan_string,
  prop_parseGranularity_negative,
  prop_parseGranularity_non_numeric,
  prop_parseGranularity_total,
  prop_parseGranularity_upper_bound,
  prop_parseGranularity_whitespace_padded,
} from "./granularity.props.js";

it("property: prop_DEFAULT_GRANULARITY_is_3", () => {
  if (!prop_DEFAULT_GRANULARITY_is_3()) throw new Error("property failed");
});

it("property: prop_MIN_GRANULARITY_is_1", () => {
  if (!prop_MIN_GRANULARITY_is_1()) throw new Error("property failed");
});

it("property: prop_MAX_GRANULARITY_is_5", () => {
  if (!prop_MAX_GRANULARITY_is_5()) throw new Error("property failed");
});

it("property: prop_DEFAULT_within_range", () => {
  if (!prop_DEFAULT_within_range()) throw new Error("property failed");
});

it("property: prop_parseGranularity_total", () => {
  if (!prop_parseGranularity_total()) throw new Error("property failed");
});

it("property: prop_parseGranularity_lower_bound", () => {
  if (!prop_parseGranularity_lower_bound()) throw new Error("property failed");
});

it("property: prop_parseGranularity_upper_bound", () => {
  if (!prop_parseGranularity_upper_bound()) throw new Error("property failed");
});

it("property: prop_parseGranularity_default", () => {
  if (!prop_parseGranularity_default()) throw new Error("property failed");
});

it("property: prop_parseGranularity_below_range", () => {
  if (!prop_parseGranularity_below_range()) throw new Error("property failed");
});

it("property: prop_parseGranularity_above_range", () => {
  if (!prop_parseGranularity_above_range()) throw new Error("property failed");
});

it("property: prop_parseGranularity_empty_string", () => {
  if (!prop_parseGranularity_empty_string()) throw new Error("property failed");
});

it("property: prop_parseGranularity_non_numeric", () => {
  if (!prop_parseGranularity_non_numeric()) throw new Error("property failed");
});

it("property: prop_parseGranularity_float", () => {
  if (!prop_parseGranularity_float()) throw new Error("property failed");
});

it("property: prop_parseGranularity_interior_2", () => {
  if (!prop_parseGranularity_interior_2()) throw new Error("property failed");
});

it("property: prop_parseGranularity_interior_4", () => {
  if (!prop_parseGranularity_interior_4()) throw new Error("property failed");
});

it("property: prop_parseGranularity_determinism", () => {
  if (!prop_parseGranularity_determinism()) throw new Error("property failed");
});

it("property: prop_parseGranularity_nan_string", () => {
  if (!prop_parseGranularity_nan_string()) throw new Error("property failed");
});

it("property: prop_parseGranularity_negative", () => {
  if (!prop_parseGranularity_negative()) throw new Error("property failed");
});

it("property: prop_parseGranularity_whitespace_padded", () => {
  if (!prop_parseGranularity_whitespace_padded()) throw new Error("property failed");
});
