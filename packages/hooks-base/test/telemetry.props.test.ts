// SPDX-License-Identifier: MIT
// Vitest harness for telemetry.props.ts
// Two-file pattern: this file is the thin vitest wrapper; the corpus lives in
// the sibling telemetry.props.ts (vitest-free, hashable as a manifest artifact).

import { it } from "vitest";
import {
  prop_hashIntent_deterministic,
  prop_hashIntent_format_64_lowercase_hex,
  prop_hashIntent_injectivity_sampled,
  prop_hashIntent_no_plaintext_in_output,
  prop_hashIntent_total,
  prop_hashIntent_unicode_does_not_throw,
  prop_outcomeFromResponse_bijective,
  prop_outcomeFromResponse_deterministic,
  prop_outcomeFromResponse_passthrough,
  prop_outcomeFromResponse_registry_hit,
  prop_outcomeFromResponse_synthesis_required,
  prop_outcomeFromResponse_total,
} from "../src/telemetry.props.js";

// hashIntent properties — BLAKE3 intent hashing
it("property: prop_hashIntent_total", () => {
  if (!prop_hashIntent_total()) throw new Error("property failed");
});

it("property: prop_hashIntent_deterministic", () => {
  if (!prop_hashIntent_deterministic()) throw new Error("property failed");
});

it("property: prop_hashIntent_format_64_lowercase_hex", () => {
  if (!prop_hashIntent_format_64_lowercase_hex()) throw new Error("property failed");
});

it("property: prop_hashIntent_injectivity_sampled", () => {
  if (!prop_hashIntent_injectivity_sampled()) throw new Error("property failed");
});

it("property: prop_hashIntent_no_plaintext_in_output", () => {
  if (!prop_hashIntent_no_plaintext_in_output()) throw new Error("property failed");
});

it("property: prop_hashIntent_unicode_does_not_throw", () => {
  if (!prop_hashIntent_unicode_does_not_throw()) throw new Error("property failed");
});

// outcomeFromResponse properties — HookResponse.kind mapping
it("property: prop_outcomeFromResponse_total", () => {
  if (!prop_outcomeFromResponse_total()) throw new Error("property failed");
});

it("property: prop_outcomeFromResponse_deterministic", () => {
  if (!prop_outcomeFromResponse_deterministic()) throw new Error("property failed");
});

it("property: prop_outcomeFromResponse_registry_hit", () => {
  if (!prop_outcomeFromResponse_registry_hit()) throw new Error("property failed");
});

it("property: prop_outcomeFromResponse_synthesis_required", () => {
  if (!prop_outcomeFromResponse_synthesis_required()) throw new Error("property failed");
});

it("property: prop_outcomeFromResponse_passthrough", () => {
  if (!prop_outcomeFromResponse_passthrough()) throw new Error("property failed");
});

it("property: prop_outcomeFromResponse_bijective", () => {
  if (!prop_outcomeFromResponse_bijective()) throw new Error("property failed");
});
