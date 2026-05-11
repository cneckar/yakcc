// SPDX-License-Identifier: MIT
// Vitest harness for shave.props.ts
// Two-file pattern: this file is the thin vitest wrapper; the corpus lives in
// the sibling shave.props.ts (vitest-free, hashable as a manifest artifact).

import * as fc from "fast-check";
import { it } from "vitest";
import {
  prop_shave_help_flag_exits_0,
  prop_shave_invalid_foreign_policy_emits_error_mentioning_flag,
  prop_shave_invalid_foreign_policy_error_mentions_valid_choices,
  prop_shave_invalid_foreign_policy_exits_1,
  prop_shave_missing_source_path_emits_error_mentioning_missing_source_path,
  prop_shave_missing_source_path_exits_1,
} from "./shave.props.js";

it("property: prop_shave_invalid_foreign_policy_exits_1", async () => {
  await fc.assert(prop_shave_invalid_foreign_policy_exits_1);
});

it("property: prop_shave_invalid_foreign_policy_emits_error_mentioning_flag", async () => {
  await fc.assert(prop_shave_invalid_foreign_policy_emits_error_mentioning_flag);
});

it("property: prop_shave_invalid_foreign_policy_error_mentions_valid_choices", async () => {
  await fc.assert(prop_shave_invalid_foreign_policy_error_mentions_valid_choices);
});

it("property: prop_shave_missing_source_path_exits_1", async () => {
  await fc.assert(prop_shave_missing_source_path_exits_1);
});

it("property: prop_shave_missing_source_path_emits_error_mentioning_missing_source_path", async () => {
  await fc.assert(prop_shave_missing_source_path_emits_error_mentioning_missing_source_path);
});

it("property: prop_shave_help_flag_exits_0", async () => {
  await fc.assert(prop_shave_help_flag_exits_0);
});
