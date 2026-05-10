// SPDX-License-Identifier: MIT
/**
 * Thin vitest harness for gate.props.ts.
 *
 * Each it() callback is async and awaits fc.assert() so that
 * IAsyncPropertyWithHooks properties run correctly and do not produce
 * vacuous 0ms passes.
 *
 * All properties are IPropertyWithHooks (sync) — we still use async/await
 * uniformly to ensure correct fc.assert() behaviour and to future-proof
 * against async property upgrades.
 */

import * as fc from "fast-check";
import { describe, it } from "vitest";

import {
  prop_gate_canonicalAccepted_yieldsTrueWithCanonicalLicense,
  prop_gate_copyleftPrefix_alwaysRejected,
  prop_gate_exactRejected_alwaysRejected,
  prop_gate_licenseGate_alwaysReturnsGateResultShape,
  prop_gate_licenseGate_isTotalFunction,
  prop_gate_normalization_parenthesisWrappedVariants_accepted,
  prop_gate_normalization_whitespaceSeparatedVariants_accepted,
  prop_gate_rejected_alwaysCarriesOriginalDetection,
  prop_gate_unknown_alwaysRejected,
  prop_gate_unrecognized_alwaysRejected,
} from "./gate.props.js";

const opts: fc.Parameters<unknown> = { numRuns: 200, verbose: false };

describe("license/gate.props", () => {
  it("G1.1 licenseGate always returns a LicenseGateResult-shaped object", async () => {
    await fc.assert(prop_gate_licenseGate_alwaysReturnsGateResultShape, opts);
  });

  it("G1.2 identifier='unknown' always yields accepted=false with reason", async () => {
    await fc.assert(prop_gate_unknown_alwaysRejected, opts);
  });

  it("G1.3 copyleft/proprietary prefix identifiers always yield accepted=false", async () => {
    await fc.assert(prop_gate_copyleftPrefix_alwaysRejected, opts);
  });

  it("G1.4 exact rejected identifiers (PROPRIETARY, COMMERCIAL) yield accepted=false", async () => {
    await fc.assert(prop_gate_exactRejected_alwaysRejected, opts);
  });

  it("G1.5 canonical accepted identifiers yield accepted=true with correct canonical form", async () => {
    await fc.assert(prop_gate_canonicalAccepted_yieldsTrueWithCanonicalLicense, opts);
  });

  it("G1.6 normalization: whitespace-separated variants of accepted IDs are accepted", async () => {
    await fc.assert(prop_gate_normalization_whitespaceSeparatedVariants_accepted, opts);
  });

  it("G1.7 normalization: parenthesis-wrapped variants of accepted IDs are accepted", async () => {
    await fc.assert(prop_gate_normalization_parenthesisWrappedVariants_accepted, opts);
  });

  it("G1.8 unrecognized identifiers yield accepted=false with 'unrecognized' reason", async () => {
    await fc.assert(prop_gate_unrecognized_alwaysRejected, opts);
  });

  it("G1.9 rejected result always carries the original detection reference", async () => {
    await fc.assert(prop_gate_rejected_alwaysCarriesOriginalDetection, opts);
  });

  it("G1.10 licenseGate is total — arbitrary inputs never throw (compound)", async () => {
    await fc.assert(prop_gate_licenseGate_isTotalFunction, opts);
  });
});
