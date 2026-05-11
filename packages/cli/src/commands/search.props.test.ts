// SPDX-License-Identifier: MIT
// Vitest harness for search.props.ts
// Two-file pattern: this file is the thin vitest wrapper; the corpus lives in
// the sibling search.props.ts (vitest-free, hashable as a manifest artifact).

import * as fc from "fast-check";
import { it } from "vitest";
import {
  prop_search_invalid_top_emits_error_mentioning_top,
  prop_search_invalid_top_string_exits_1,
  prop_search_missing_query_emits_error_mentioning_search_requires,
  prop_search_missing_query_exits_1,
  prop_search_top_zero_exits_1,
} from "./search.props.js";

it("property: prop_search_missing_query_exits_1", async () => {
  await fc.assert(prop_search_missing_query_exits_1);
});

it("property: prop_search_missing_query_emits_error_mentioning_search_requires", async () => {
  await fc.assert(prop_search_missing_query_emits_error_mentioning_search_requires);
});

it("property: prop_search_invalid_top_string_exits_1", async () => {
  await fc.assert(prop_search_invalid_top_string_exits_1);
});

it("property: prop_search_top_zero_exits_1", async () => {
  await fc.assert(prop_search_top_zero_exits_1);
});

it("property: prop_search_invalid_top_emits_error_mentioning_top", async () => {
  await fc.assert(prop_search_invalid_top_emits_error_mentioning_top);
});
