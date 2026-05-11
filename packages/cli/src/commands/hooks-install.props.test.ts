// SPDX-License-Identifier: MIT
// Vitest harness for hooks-install.props.ts
// Two-file pattern: this file is the thin vitest wrapper; the corpus lives in
// the sibling hooks-install.props.ts (vitest-free, hashable as a manifest artifact).

import * as fc from "fast-check";
import { it } from "vitest";
import {
  prop_install_is_idempotent_exit_codes,
  prop_install_on_empty_dir_exits_0_and_creates_settings,
  prop_install_settings_contains_yakcc_marker,
  prop_install_then_uninstall_marker_absent_from_settings,
  prop_install_then_uninstall_removes_entry,
  prop_install_twice_produces_exactly_one_yakcc_entry,
  prop_uninstall_when_not_installed_exits_0,
} from "./hooks-install.props.js";

// Filesystem I/O per run: keep numRuns low to avoid excessive tmp churn.
const fsOpts = { numRuns: 5 };

it("property: prop_install_on_empty_dir_exits_0_and_creates_settings", async () => {
  await fc.assert(prop_install_on_empty_dir_exits_0_and_creates_settings, fsOpts);
});

it("property: prop_install_settings_contains_yakcc_marker", async () => {
  await fc.assert(prop_install_settings_contains_yakcc_marker, fsOpts);
});

it("property: prop_install_is_idempotent_exit_codes", async () => {
  await fc.assert(prop_install_is_idempotent_exit_codes, fsOpts);
});

it("property: prop_install_twice_produces_exactly_one_yakcc_entry", async () => {
  await fc.assert(prop_install_twice_produces_exactly_one_yakcc_entry, fsOpts);
});

it("property: prop_uninstall_when_not_installed_exits_0", async () => {
  await fc.assert(prop_uninstall_when_not_installed_exits_0, fsOpts);
});

it("property: prop_install_then_uninstall_removes_entry", async () => {
  await fc.assert(prop_install_then_uninstall_removes_entry, fsOpts);
});

it("property: prop_install_then_uninstall_marker_absent_from_settings", async () => {
  await fc.assert(prop_install_then_uninstall_marker_absent_from_settings, fsOpts);
});
