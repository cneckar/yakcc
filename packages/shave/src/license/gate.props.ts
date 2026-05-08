// SPDX-License-Identifier: MIT
// @decision DEC-V2-PROPTEST-PATH-A-001: hand-authored property-test corpus for
// @yakcc/shave license/gate.ts atoms. Two-file pattern: this file
// (.props.ts) is vitest-free and holds the corpus; the sibling .props.test.ts
// is the vitest harness.
// Status: accepted (WI-V2-07-PREFLIGHT L3-license)
// Rationale: See tmp/wi-v2-07-preflight-layer-plan.md — the corpus file must
// be runtime-independent so L10 can hash it as a manifest artifact.
//
// Atoms covered (from gate.ts):
//   licenseGate                (G1.1) — pure function: LicenseDetection → LicenseGateResult.
//   normalize (internal)       (G1.2) — exercised indirectly through licenseGate.
//
// Properties covered:
//   G1.1  licenseGate always returns a LicenseGateResult-shaped object.
//   G1.2  identifier="unknown" always yields accepted=false with a reason string.
//   G1.3  Copyleft/proprietary prefix identifiers always yield accepted=false.
//   G1.4  Exact rejected identifiers (PROPRIETARY, COMMERCIAL) yield accepted=false.
//   G1.5  Canonical accepted identifiers yield accepted=true with the correct canonical form.
//   G1.6  Normalization: whitespace-separated variants of accepted IDs are accepted.
//   G1.7  Normalization: parenthesis-wrapped variants of accepted IDs are accepted.
//   G1.8  Unrecognized (non-copyleft, non-canonical) identifiers yield accepted=false.
//   G1.9  Rejected result always carries the original detection reference.
//   G1.10 licenseGate is total: LicenseDetection inputs with arbitrary identifiers never throw.

// ---------------------------------------------------------------------------
// Property-test corpus for license/gate.ts
// ---------------------------------------------------------------------------

import * as fc from "fast-check";
import { licenseGate } from "./gate.js";
import type { LicenseDetection, LicenseGateResult } from "./types.js";

// ---------------------------------------------------------------------------
// Shared arbitraries
// ---------------------------------------------------------------------------

/** Arbitrary LicenseDetection with a controlled identifier. */
function makeDetection(identifier: string, source = "spdx-comment"): LicenseDetection {
  return { identifier, source } as LicenseDetection;
}

/** Arbitrary LicenseDetection with an arbitrary identifier. */
const arbitraryDetectionArb: fc.Arbitrary<LicenseDetection> = fc
  .tuple(
    fc.string({ minLength: 0, maxLength: 40 }),
    fc.constantFrom("spdx-comment", "header-text", "dedication", "no-signal"),
  )
  .map(([id, src]) => ({ identifier: id, source: src }) as LicenseDetection);

/** Copyleft/proprietary prefix identifiers as per gate.ts REJECTED_PREFIXES. */
const copyleftPrefixArb: fc.Arbitrary<string> = fc
  .tuple(
    fc.constantFrom("GPL-", "AGPL-", "LGPL-", "BUSL-"),
    fc.string({ minLength: 1, maxLength: 20 }),
  )
  .map(([prefix, suffix]) => `${prefix}${suffix}`);

/** Exact rejected identifiers (case-insensitive via normalize). */
const exactRejectedArb: fc.Arbitrary<string> = fc.constantFrom(
  "PROPRIETARY",
  "COMMERCIAL",
  "proprietary",
  "commercial",
  "Proprietary",
  "Commercial",
);

/** Canonical accepted identifiers (raw input forms recognized by gate.ts). */
const canonicalAcceptedRawArb: fc.Arbitrary<string> = fc.constantFrom(
  "Unlicense",
  "MIT",
  "BSD-2-Clause",
  "BSD-2",
  "BSD-3-Clause",
  "BSD-3",
  "Apache-2.0",
  "Apache-2",
  "ISC",
  "0BSD",
  "public-domain",
);

/** Canonical accepted identifiers with known expected output from gate.ts CANONICAL_MAP. */
const canonicalAcceptedPairsArb: fc.Arbitrary<[string, string]> = fc.constantFrom(
  ["Unlicense", "Unlicense"] as [string, string],
  ["MIT", "MIT"] as [string, string],
  ["BSD-2-Clause", "BSD-2-Clause"] as [string, string],
  ["BSD-2", "BSD-2-Clause"] as [string, string],
  ["BSD-3-Clause", "BSD-3-Clause"] as [string, string],
  ["BSD-3", "BSD-3-Clause"] as [string, string],
  ["Apache-2.0", "Apache-2.0"] as [string, string],
  ["Apache-2", "Apache-2.0"] as [string, string],
  ["ISC", "ISC"] as [string, string],
  ["0BSD", "0BSD"] as [string, string],
  ["public-domain", "public-domain"] as [string, string],
);

// ---------------------------------------------------------------------------
// Helper type guard
// ---------------------------------------------------------------------------

function isLicenseGateResultShaped(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.accepted !== "boolean") return false;
  if (typeof v.detection !== "object" || v.detection === null) return false;
  return true;
}

// ---------------------------------------------------------------------------
// G1.1: licenseGate always returns a LicenseGateResult-shaped object
// ---------------------------------------------------------------------------

/**
 * prop_gate_licenseGate_alwaysReturnsGateResultShape
 *
 * licenseGate(d) always returns an object with accepted: boolean and
 * detection: LicenseDetection for any LicenseDetection input.
 *
 * Invariant (G1.1): licenseGate is a total function — it must never throw
 * or return a malformed shape. The pipeline reads accepted unconditionally.
 */
export const prop_gate_licenseGate_alwaysReturnsGateResultShape: fc.IPropertyWithHooks<
  [LicenseDetection]
> = fc.property(arbitraryDetectionArb, (detection) => {
  const result = licenseGate(detection);
  return isLicenseGateResultShaped(result);
});

// ---------------------------------------------------------------------------
// G1.2: identifier="unknown" always yields accepted=false
// ---------------------------------------------------------------------------

/**
 * prop_gate_unknown_alwaysRejected
 *
 * A detection with identifier="unknown" always yields accepted=false and a
 * non-empty reason string, regardless of source.
 *
 * Invariant (G1.2): the gate's first branch short-circuits on unknown. The
 * pipeline uses identifier==="unknown" as the no-signal sentinel; a false
 * accept here would let unlicensed files through.
 */
export const prop_gate_unknown_alwaysRejected: fc.IPropertyWithHooks<[string]> = fc.property(
  fc.constantFrom("spdx-comment", "header-text", "dedication", "no-signal"),
  (source) => {
    const detection = makeDetection("unknown", source);
    const result = licenseGate(detection);
    return (
      result.accepted === false &&
      "reason" in result &&
      typeof (result as { reason: unknown }).reason === "string" &&
      (result as { reason: string }).reason.length > 0
    );
  },
);

// ---------------------------------------------------------------------------
// G1.3: Copyleft/proprietary prefix identifiers always yield accepted=false
// ---------------------------------------------------------------------------

/**
 * prop_gate_copyleftPrefix_alwaysRejected
 *
 * Any identifier starting with GPL-, AGPL-, LGPL-, or BUSL- yields
 * accepted=false with a reason mentioning "copyleft/proprietary".
 *
 * Invariant (G1.3): the rejected-prefix check runs before canonical matching.
 * Any regression that lets a copyleft identifier through is a policy failure.
 */
export const prop_gate_copyleftPrefix_alwaysRejected: fc.IPropertyWithHooks<[string]> = fc.property(
  copyleftPrefixArb,
  (identifier) => {
    const detection = makeDetection(identifier);
    const result = licenseGate(detection);
    return (
      result.accepted === false &&
      "reason" in result &&
      (result as { reason: string }).reason.includes("copyleft/proprietary")
    );
  },
);

// ---------------------------------------------------------------------------
// G1.4: Exact rejected identifiers yield accepted=false
// ---------------------------------------------------------------------------

/**
 * prop_gate_exactRejected_alwaysRejected
 *
 * PROPRIETARY and COMMERCIAL (in any case) yield accepted=false.
 *
 * Invariant (G1.4): REJECTED_EXACT handles proprietary/commercial identifiers
 * that don't share a copyleft prefix. Case normalization must apply so
 * "proprietary" and "Proprietary" are caught.
 */
export const prop_gate_exactRejected_alwaysRejected: fc.IPropertyWithHooks<[string]> = fc.property(
  exactRejectedArb,
  (identifier) => {
    const detection = makeDetection(identifier);
    const result = licenseGate(detection);
    return result.accepted === false;
  },
);

// ---------------------------------------------------------------------------
// G1.5: Canonical accepted identifiers yield accepted=true with correct form
// ---------------------------------------------------------------------------

/**
 * prop_gate_canonicalAccepted_yieldsTrueWithCanonicalLicense
 *
 * Each entry in the CANONICAL_MAP yields accepted=true with the correct
 * canonical license string.
 *
 * Invariant (G1.5): canonical accepted identifiers must round-trip to the
 * exact AcceptedLicense string expected by downstream consumers. A mismatch
 * here would produce a wrong license label in the registry.
 */
export const prop_gate_canonicalAccepted_yieldsTrueWithCanonicalLicense: fc.IPropertyWithHooks<
  [[string, string]]
> = fc.property(canonicalAcceptedPairsArb, ([rawId, expectedCanonical]) => {
  const detection = makeDetection(rawId);
  const result = licenseGate(detection);
  return (
    result.accepted === true &&
    "license" in result &&
    (result as { license: unknown }).license === expectedCanonical
  );
});

// ---------------------------------------------------------------------------
// G1.6: Normalization — whitespace-separated variants are accepted
// ---------------------------------------------------------------------------

/**
 * prop_gate_normalization_whitespaceSeparatedVariants_accepted
 *
 * Whitespace-separated forms like "Apache 2.0" and "BSD 3 Clause" are
 * normalized to hyphens and accepted when they map to a canonical form.
 *
 * Invariant (G1.6): normalize() replaces internal spaces with hyphens before
 * CANONICAL_MAP lookup. This ensures common variant spellings are accepted
 * without a full SPDX expression parser.
 */
export const prop_gate_normalization_whitespaceSeparatedVariants_accepted: fc.IPropertyWithHooks<
  [string]
> = fc.property(
  fc.constantFrom(
    "Apache 2.0", // → APACHE-2.0 → "Apache-2.0"
    "Apache 2", // → APACHE-2   → "Apache-2.0"
    "BSD 2 Clause", // → BSD-2-CLAUSE → "BSD-2-Clause"
    "BSD 3 Clause", // → BSD-3-CLAUSE → "BSD-3-Clause"
  ),
  (rawId) => {
    const detection = makeDetection(rawId);
    const result = licenseGate(detection);
    return result.accepted === true;
  },
);

// ---------------------------------------------------------------------------
// G1.7: Normalization — parenthesis-wrapped variants are accepted
// ---------------------------------------------------------------------------

/**
 * prop_gate_normalization_parenthesisWrappedVariants_accepted
 *
 * A single pair of enclosing parentheses is stripped before normalization,
 * so "(MIT)" and "(ISC)" yield accepted=true.
 *
 * Invariant (G1.7): normalize() strips one enclosing paren pair as step 2.
 * This handles SPDX expressions like "(MIT OR Apache-2.0)" reduced to a
 * single identifier after upstream processing.
 */
export const prop_gate_normalization_parenthesisWrappedVariants_accepted: fc.IPropertyWithHooks<
  [string]
> = fc.property(fc.constantFrom("(MIT)", "(ISC)", "(Unlicense)", "(0BSD)"), (rawId) => {
  const detection = makeDetection(rawId);
  const result = licenseGate(detection);
  return result.accepted === true;
});

// ---------------------------------------------------------------------------
// G1.8: Unrecognized identifiers yield accepted=false
// ---------------------------------------------------------------------------

/**
 * prop_gate_unrecognized_alwaysRejected
 *
 * An identifier that is not "unknown", not a copyleft/proprietary prefix,
 * not an exact rejection, and not in CANONICAL_MAP yields accepted=false with
 * a reason mentioning "unrecognized".
 *
 * Invariant (G1.8): the gate's final branch is the unrecognized fallback.
 * Anything that falls through all prior checks must be rejected — the gate
 * must be closed-world by default.
 */
export const prop_gate_unrecognized_alwaysRejected: fc.IPropertyWithHooks<[string]> = fc.property(
  fc.constantFrom(
    "EUPL-1.2",
    "MPL-2.0",
    "CDDL-1.0",
    "EPL-2.0",
    "CC-BY-4.0",
    "WTFPL",
    "Artistic-2.0",
    "ZPL-2.1",
  ),
  (identifier) => {
    const detection = makeDetection(identifier);
    const result = licenseGate(detection);
    return (
      result.accepted === false &&
      "reason" in result &&
      (result as { reason: string }).reason.includes("unrecognized")
    );
  },
);

// ---------------------------------------------------------------------------
// G1.9: Rejected result always carries the original detection reference
// ---------------------------------------------------------------------------

/**
 * prop_gate_rejected_alwaysCarriesOriginalDetection
 *
 * When licenseGate returns accepted=false, the detection field in the result
 * is reference-equal to the input LicenseDetection (or structurally equal,
 * as gate.ts spreads it directly).
 *
 * Invariant (G1.9): downstream error reporting reads result.detection to
 * surface context. A missing or mutated detection field breaks diagnostics.
 */
export const prop_gate_rejected_alwaysCarriesOriginalDetection: fc.IPropertyWithHooks<
  [LicenseDetection]
> = fc.property(arbitraryDetectionArb, (detection) => {
  const result = licenseGate(detection);
  if (result.accepted === true) return true; // accepted path — not under test here
  return (
    result.detection === detection &&
    result.detection.identifier === detection.identifier &&
    result.detection.source === detection.source
  );
});

// ---------------------------------------------------------------------------
// G1.10: licenseGate is total — arbitrary inputs never throw (compound)
// ---------------------------------------------------------------------------

/**
 * prop_gate_licenseGate_isTotalFunction
 *
 * licenseGate(d) never throws for any LicenseDetection-shaped input. This
 * is the compound end-to-end property: it exercises the full gate pipeline
 * (unknown → copyleft prefix → exact rejected → canonical → unrecognized)
 * across arbitrary identifiers and asserts non-throwing + correct shape.
 *
 * Invariant (G1.10): licenseGate must be unconditionally safe to call from
 * the pipeline. A throw on any input would halt corpus scanning.
 */
export const prop_gate_licenseGate_isTotalFunction: fc.IPropertyWithHooks<[LicenseDetection]> =
  fc.property(arbitraryDetectionArb, (detection) => {
    let result: LicenseGateResult | undefined;
    try {
      result = licenseGate(detection);
    } catch {
      return false;
    }
    return isLicenseGateResultShaped(result);
  });
