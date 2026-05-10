// SPDX-License-Identifier: MIT
// Vitest harness for pull.props.ts
// Two-file pattern: this file is the thin vitest wrapper; the corpus lives in
// the sibling pull.props.ts (vitest-free, hashable as a manifest artifact).

import * as fc from "fast-check";
import { it } from "vitest";
import {
  prop_pullBlock_propagates_transport_error_unchanged,
  prop_pullBlock_rejects_corrupt_wire_via_integrity_gate,
  prop_pullSpec_not_found_normalizes_to_empty_array,
  prop_pullSpec_returns_roots_from_transport,
  prop_resolveTransport_uses_injected_transport_on_block_error,
  prop_resolveTransport_uses_injected_transport_on_spec_error,
} from "./pull.props.js";

// pullBlock/pullSpec use injected stub transports (no network, no SQLite).
// numRuns: 50 balances coverage with async overhead on constant arbitraries.
const opts = { numRuns: 50 };

it("property: prop_resolveTransport_uses_injected_transport_on_block_error", async () => {
  await fc.assert(prop_resolveTransport_uses_injected_transport_on_block_error, opts);
});

it("property: prop_resolveTransport_uses_injected_transport_on_spec_error", async () => {
  await fc.assert(prop_resolveTransport_uses_injected_transport_on_spec_error, opts);
});

it("property: prop_pullBlock_rejects_corrupt_wire_via_integrity_gate", async () => {
  await fc.assert(prop_pullBlock_rejects_corrupt_wire_via_integrity_gate, opts);
});

it("property: prop_pullBlock_propagates_transport_error_unchanged", async () => {
  await fc.assert(prop_pullBlock_propagates_transport_error_unchanged, opts);
});

it("property: prop_pullSpec_not_found_normalizes_to_empty_array", async () => {
  await fc.assert(prop_pullSpec_not_found_normalizes_to_empty_array, opts);
});

it("property: prop_pullSpec_returns_roots_from_transport", async () => {
  await fc.assert(prop_pullSpec_returns_roots_from_transport, opts);
});
