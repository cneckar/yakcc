// SPDX-License-Identifier: MIT
// @decision DEC-V2-PROPTEST-PATH-A-001: hand-authored property-test corpus for
// @yakcc/shave license/types.ts atoms. Two-file pattern: this file
// (.props.ts) is vitest-free and holds the corpus; the sibling .props.test.ts
// is the vitest harness.
// Status: accepted (WI-V2-07-PREFLIGHT L3-license)
// Rationale: See tmp/wi-v2-07-preflight-layer-plan.md — the corpus file must
// be runtime-independent so L10 can hash it as a manifest artifact.
//
// Atoms covered (type-level declarations from types.ts):
//   AcceptedLicense      (T1.1) — literal union of 8 permissive license strings.
//   LicenseDetection     (T1.2) — readonly interface with identifier/source/evidence.
//   LicenseGateResult    (T1.3) — discriminated union on accepted: true|false.
//
// Properties covered:
//   - AcceptedLicense accepts exactly the 8 allowed literal strings.
//   - LicenseDetection has required fields identifier and source with correct types.
//   - LicenseDetection optional evidence field is omittable (exactOptionalPropertyTypes).
//   - LicenseDetection source is one of the 5 allowed literal strings.
//   - LicenseGateResult accepted:true branch has license and detection fields.
//   - LicenseGateResult accepted:false branch has reason and detection fields.
//   - LicenseGateResult discriminated union: accepted field drives branch shape.

// ---------------------------------------------------------------------------
// Property-test corpus for license/types.ts
// ---------------------------------------------------------------------------

import * as fc from "fast-check";
import type { AcceptedLicense, LicenseDetection, LicenseGateResult } from "./types.js";

// ---------------------------------------------------------------------------
// Shared arbitraries
// ---------------------------------------------------------------------------

/** Non-empty string with no leading/trailing whitespace. */
const nonEmptyStr: fc.Arbitrary<string> = fc
  .string({ minLength: 1, maxLength: 40 })
  .filter((s) => s.trim().length > 0);

/** Arbitrary AcceptedLicense — the 8 allowed literals. */
const acceptedLicenseArb: fc.Arbitrary<AcceptedLicense> = fc.constantFrom(
  "Unlicense" as const,
  "MIT" as const,
  "BSD-2-Clause" as const,
  "BSD-3-Clause" as const,
  "Apache-2.0" as const,
  "ISC" as const,
  "0BSD" as const,
  "public-domain" as const,
);

/** Arbitrary LicenseDetection source literal. */
const detectionSourceArb: fc.Arbitrary<LicenseDetection["source"]> = fc.constantFrom(
  "spdx-comment" as const,
  "package-json" as const,
  "header-text" as const,
  "dedication" as const,
  "no-signal" as const,
);

/** Arbitrary LicenseDetection without optional evidence. */
const licenseDetectionNoEvidenceArb: fc.Arbitrary<LicenseDetection> = fc.record({
  identifier: nonEmptyStr,
  source: detectionSourceArb,
});

/** Arbitrary LicenseDetection with optional evidence present. */
const licenseDetectionWithEvidenceArb: fc.Arbitrary<LicenseDetection> = fc.record({
  identifier: nonEmptyStr,
  source: detectionSourceArb,
  evidence: nonEmptyStr,
});

/** Arbitrary LicenseDetection (either with or without evidence). */
const licenseDetectionArb: fc.Arbitrary<LicenseDetection> = fc.oneof(
  licenseDetectionNoEvidenceArb,
  licenseDetectionWithEvidenceArb,
);

// ---------------------------------------------------------------------------
// T1.1: AcceptedLicense — literal union shape (8 members)
// ---------------------------------------------------------------------------

/**
 * prop_types_acceptedLicense_literalUnionShape
 *
 * AcceptedLicense accepts exactly the 8 allowed permissive license strings.
 * Any value sampled from acceptedLicenseArb is structurally one of the union
 * members, verified at runtime by exhaustive enumeration.
 *
 * Invariant (T1.1): the accepted-license set is locked to MASTER_PLAN.md v0.7
 * stage spec. A change to the union type must be reflected here.
 */
export const prop_types_acceptedLicense_literalUnionShape: fc.IPropertyWithHooks<
  [AcceptedLicense]
> = fc.property(acceptedLicenseArb, (license) => {
  const allowed: ReadonlyArray<string> = [
    "Unlicense",
    "MIT",
    "BSD-2-Clause",
    "BSD-3-Clause",
    "Apache-2.0",
    "ISC",
    "0BSD",
    "public-domain",
  ];
  return allowed.includes(license);
});

// ---------------------------------------------------------------------------
// T1.2: LicenseDetection — required fields with correct types
// ---------------------------------------------------------------------------

/**
 * prop_types_licenseDetection_requiredFieldsPresent
 *
 * Every LicenseDetection has identifier (string) and source (string) fields.
 * The evidence field is optional and may be absent entirely.
 *
 * Invariant (T1.2): LicenseDetection is the output of detectLicense(); all
 * downstream consumers (licenseGate) read identifier and source. A regression
 * where either field is absent or wrong-typed would break the gate.
 */
export const prop_types_licenseDetection_requiredFieldsPresent: fc.IPropertyWithHooks<
  [LicenseDetection]
> = fc.property(licenseDetectionArb, (det) => {
  return typeof det.identifier === "string" && typeof det.source === "string";
});

// ---------------------------------------------------------------------------
// T1.2: LicenseDetection — evidence field is omittable (exactOptionalPropertyTypes)
// ---------------------------------------------------------------------------

/**
 * prop_types_licenseDetection_evidenceFieldOmittable
 *
 * A LicenseDetection without the evidence field is structurally valid.
 * Under exactOptionalPropertyTypes, the field must be absent (not undefined)
 * when the detection produced no evidence substring.
 *
 * Invariant (T1.2): the no-signal path in detectLicense omits evidence
 * entirely. This property asserts the omission compiles and executes correctly.
 */
export const prop_types_licenseDetection_evidenceFieldOmittable: fc.IPropertyWithHooks<
  [string, LicenseDetection["source"]]
> = fc.property(nonEmptyStr, detectionSourceArb, (identifier, source) => {
  // Omit evidence — do not assign undefined
  const det: LicenseDetection = { identifier, source };
  return !("evidence" in det) && det.identifier === identifier && det.source === source;
});

// ---------------------------------------------------------------------------
// T1.2: LicenseDetection — source is one of the 5 allowed literals
// ---------------------------------------------------------------------------

/**
 * prop_types_licenseDetection_sourceIsAllowedLiteral
 *
 * The source field of any LicenseDetection is one of the 5 allowed literal
 * strings: spdx-comment, package-json, header-text, dedication, no-signal.
 *
 * Invariant (T1.2): the source field documents provenance for diagnostics.
 * Consumers may switch on it; unrecognized values would be a silent bug.
 */
export const prop_types_licenseDetection_sourceIsAllowedLiteral: fc.IPropertyWithHooks<
  [LicenseDetection]
> = fc.property(licenseDetectionArb, (det) => {
  const allowed: ReadonlyArray<string> = [
    "spdx-comment",
    "package-json",
    "header-text",
    "dedication",
    "no-signal",
  ];
  return allowed.includes(det.source);
});

// ---------------------------------------------------------------------------
// T1.3: LicenseGateResult — accepted:true branch shape
// ---------------------------------------------------------------------------

/**
 * prop_types_licenseGateResult_acceptedTrueBranchShape
 *
 * When accepted is true, the LicenseGateResult has license (AcceptedLicense)
 * and detection (LicenseDetection) fields, and no reason field.
 *
 * Invariant (T1.3): the discriminated union is the gate's public output shape.
 * Downstream consumers check accepted first, then access license or reason.
 * A regression where license is absent on the true branch would break callers.
 */
export const prop_types_licenseGateResult_acceptedTrueBranchShape: fc.IPropertyWithHooks<
  [AcceptedLicense, LicenseDetection]
> = fc.property(acceptedLicenseArb, licenseDetectionArb, (license, detection) => {
  const result: LicenseGateResult = { accepted: true, license, detection };
  return (
    result.accepted === true &&
    result.license === license &&
    result.detection === detection &&
    !("reason" in result)
  );
});

// ---------------------------------------------------------------------------
// T1.3: LicenseGateResult — accepted:false branch shape
// ---------------------------------------------------------------------------

/**
 * prop_types_licenseGateResult_acceptedFalseBranchShape
 *
 * When accepted is false, the LicenseGateResult has reason (string) and
 * detection (LicenseDetection) fields, and no license field.
 *
 * Invariant (T1.3): the rejected branch must carry a human-readable reason.
 * A regression where reason is absent on the false branch would silence errors.
 */
export const prop_types_licenseGateResult_acceptedFalseBranchShape: fc.IPropertyWithHooks<
  [string, LicenseDetection]
> = fc.property(nonEmptyStr, licenseDetectionArb, (reason, detection) => {
  const result: LicenseGateResult = { accepted: false, reason, detection };
  return (
    result.accepted === false &&
    result.reason === reason &&
    result.detection === detection &&
    !("license" in result)
  );
});

// ---------------------------------------------------------------------------
// T1.3: LicenseGateResult — discriminant drives branch (compound type invariant)
// ---------------------------------------------------------------------------

/**
 * prop_types_licenseGateResult_discriminantDrivesBranch
 *
 * A LicenseGateResult with accepted:true never has a reason field, and one
 * with accepted:false never has a license field. This compound property
 * exercises both branches and their mutual exclusion from one arbitrary.
 *
 * Invariant (T1.3): the discriminated union must be exhaustive and exclusive.
 * This is the cross-branch compound-interaction property.
 */
export const prop_types_licenseGateResult_discriminantDrivesBranch: fc.IPropertyWithHooks<
  [boolean, AcceptedLicense, string, LicenseDetection]
> = fc.property(
  fc.boolean(),
  acceptedLicenseArb,
  nonEmptyStr,
  licenseDetectionArb,
  (accepted, license, reason, detection) => {
    if (accepted) {
      const result: LicenseGateResult = { accepted: true, license, detection };
      return result.accepted && !("reason" in result);
    }
    const result: LicenseGateResult = { accepted: false, reason, detection };
    return !result.accepted && !("license" in result);
  },
);
