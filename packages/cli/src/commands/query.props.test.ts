// SPDX-License-Identifier: MIT
// Vitest harness for query.props.ts
// Two-file pattern: this file is the thin vitest wrapper; the corpus lives in
// the sibling query.props.ts (vitest-free, hashable as a manifest artifact).

import * as fc from "fast-check";
import { it } from "vitest";
import {
  prop_query_invalid_top_emits_error_mentioning_top,
  prop_query_invalid_top_string_exits_1,
  prop_query_missing_query_emits_error_mentioning_query_requires,
  prop_query_missing_query_text_exits_1,
  prop_query_top_zero_exits_1,
} from "./query.props.js";

it("property: prop_query_invalid_top_string_exits_1", async () => {
  await fc.assert(prop_query_invalid_top_string_exits_1);
});

it("property: prop_query_top_zero_exits_1", async () => {
  await fc.assert(prop_query_top_zero_exits_1);
});

it("property: prop_query_invalid_top_emits_error_mentioning_top", async () => {
  await fc.assert(prop_query_invalid_top_emits_error_mentioning_top);
});

it("property: prop_query_missing_query_text_exits_1", async () => {
  await fc.assert(prop_query_missing_query_text_exits_1);
});

it("property: prop_query_missing_query_emits_error_mentioning_query_requires", async () => {
  await fc.assert(prop_query_missing_query_emits_error_mentioning_query_requires);
});
