// SPDX-License-Identifier: MIT
// Vitest harness for index.props.ts
// Two-file pattern: this file is the thin vitest wrapper; the corpus lives in
// the sibling index.props.ts (vitest-free, hashable as a manifest artifact).

import { it } from "vitest";
import {
  prop_commandMarkerFilename_contains_codex,
  prop_commandMarkerFilename_ends_with_json,
  prop_commandMarkerFilename_exact_value,
  prop_commandMarkerFilename_starts_with_yakcc,
  prop_createHook_custom_markerDir_accepted,
  prop_createHook_custom_threshold_accepted,
  prop_createHook_has_onCodeEmissionIntent,
  prop_createHook_has_registerCommand,
  prop_createHook_no_options_returns_valid_hook,
  prop_createHook_total,
  prop_reexported_threshold_in_valid_range,
  prop_reexported_threshold_is_0_30,
  prop_reexported_threshold_is_a_number,
} from "./index.props.js";

// COMMAND_MARKER_FILENAME constant invariants
it("property: prop_commandMarkerFilename_exact_value", () => {
  if (!prop_commandMarkerFilename_exact_value()) throw new Error("property failed");
});

it("property: prop_commandMarkerFilename_ends_with_json", () => {
  if (!prop_commandMarkerFilename_ends_with_json()) throw new Error("property failed");
});

it("property: prop_commandMarkerFilename_starts_with_yakcc", () => {
  if (!prop_commandMarkerFilename_starts_with_yakcc()) throw new Error("property failed");
});

it("property: prop_commandMarkerFilename_contains_codex", () => {
  if (!prop_commandMarkerFilename_contains_codex()) throw new Error("property failed");
});

// DEFAULT_REGISTRY_HIT_THRESHOLD re-export invariants
it("property: prop_reexported_threshold_is_0_30", () => {
  if (!prop_reexported_threshold_is_0_30()) throw new Error("property failed");
});

it("property: prop_reexported_threshold_in_valid_range", () => {
  if (!prop_reexported_threshold_in_valid_range()) throw new Error("property failed");
});

it("property: prop_reexported_threshold_is_a_number", () => {
  if (!prop_reexported_threshold_is_a_number()) throw new Error("property failed");
});

// createHook factory properties
it("property: prop_createHook_total", () => {
  if (!prop_createHook_total()) throw new Error("property failed");
});

it("property: prop_createHook_has_registerCommand", () => {
  if (!prop_createHook_has_registerCommand()) throw new Error("property failed");
});

it("property: prop_createHook_has_onCodeEmissionIntent", () => {
  if (!prop_createHook_has_onCodeEmissionIntent()) throw new Error("property failed");
});

it("property: prop_createHook_no_options_returns_valid_hook", () => {
  if (!prop_createHook_no_options_returns_valid_hook()) throw new Error("property failed");
});

it("property: prop_createHook_custom_threshold_accepted", () => {
  if (!prop_createHook_custom_threshold_accepted()) throw new Error("property failed");
});

it("property: prop_createHook_custom_markerDir_accepted", () => {
  if (!prop_createHook_custom_markerDir_accepted()) throw new Error("property failed");
});
